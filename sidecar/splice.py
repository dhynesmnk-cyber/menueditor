"""Splice export: rewrite only the lines the user touched.

The original page is never rebuilt. Each edited line has its own ink box redacted
(text only — images, rules and every other glyph survive) and the new string is
drawn one glyph at a time, advancing by the font's own advance plus tracking.
insert_text has no character-spacing parameter, so glyph-at-a-time is what makes
tracking honest.

Four operations, all optional and independent:

    edits    [{gi, text, x, y, size, track}]   rewrite a line that exists
    deletes  [{gi}]                            remove a line (redaction only)
    adds     [{page, text, x, y, size, track, font, color}]
                                               a box that did not exist before
    images   [{page, x0, y0, x1, y1, data}]    replace the pixels in a rect

Multi-page: edits carry the document-wide `gi` from grouping.extract, so they are
grouped by page and applied to the right sheet. A page with no operations is never
touched — it stays byte-identical apart from the file's object stream.

The document's own slack is enforced here as well as in the UI: a string that does
not fit its slot is shrunk by at most 8%, or refused. A payload from a stale client
must not be able to corrupt the file. Added boxes are exempt from the slot check —
there is no slot — but their font must resolve or the box is refused.
"""
import pymupdf

from grouping import _face, extract, resolve_font_path

MIN_FIT = 0.92


def _image_bytes(data):
    """Decode a data: URL (or raw base64) into image bytes."""
    import base64
    import binascii

    if not data:
        return b""
    try:
        if data.startswith("data:"):
            payload = data.split(",", 1)[1] if "," in data else ""
            return base64.b64decode(payload)
        return base64.b64decode(data)
    except (binascii.Error, ValueError):
        return b""


def _rgb(hexcolor):
    h = (hexcolor or "#000000").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return (0.0, 0.0, 0.0)


def _box(o, pad=0.4):
    s = o["size"]
    left = o.get("ink_left", o["x"])
    return pymupdf.Rect(left - pad, o["y"] - s * 0.78,
                        left + o["ink_width"] + pad, o["y"] + s * 0.24)


def _width_of(font, text, size, track_em):
    if not text:
        return 0.0
    adv = sum((font.text_length(ch, fontsize=size) if font else size * 0.5) for ch in text)
    return adv + track_em * size * max(0, len(text) - 1)


def _open_font(path):
    if not path:
        return None
    try:
        return pymupdf.Font(fontfile=path)
    except Exception:                                              # noqa: BLE001
        return None


def build(doc_bytes, edits=None, images=None, adds=None, deletes=None, font_paths=None):
    """Apply text edits, deletions, added boxes and image swaps; returns (pdf, info)."""
    edits = edits or []
    images = images or []
    adds = adds or []
    deletes = deletes or []
    font_paths = font_paths or {}

    data = extract(doc_bytes)
    by_gi = {}
    for p in data["pages"]:
        for o in p["objects"]:
            by_gi[o["gi"]] = o

    doc = pymupdf.open(stream=doc_bytes, filetype="pdf")
    applied, refused, removed = [], [], []
    cuts = []                                    # (page, rect) to redact

    # ---- existing lines -----------------------------------------------------
    for e in edits:
        o = by_gi.get(int(e.get("gi", -1)))
        if o is None:
            continue
        text = e.get("text", o["text"])
        x = float(e.get("x", o["x"]))
        y = float(e.get("y", o["y"]))
        size = float(e.get("size", o["size"]))
        track = float(e.get("track", o["track_em"] if o["letter_spaced"] else 0.0))
        moved = abs(x - o["x"]) > 0.05 or abs(y - o["y"]) > 0.05
        retracked = abs(track - (o["track_em"] if o["letter_spaced"] else 0.0)) > 0.002
        resized = abs(size - o["size"]) > 0.01
        if text == o["text"] and not moved and not retracked and not resized:
            continue

        font = _face(doc, o["font"])
        limit = float(o.get("max_width") or o["ink_width"])
        w = _width_of(font, text, size, track)
        if w > limit:
            scale = limit / w
            if scale < MIN_FIT:
                refused.append({"gi": o["gi"], "text": text, "need": round(w, 2),
                                "max": round(limit, 2)})
                continue
            size = round(size * scale, 3)
            w = _width_of(font, text, size, track)
            if w > limit + 0.05:
                track = round(max(0.0, (limit - (w - track * size * max(0, len(text) - 1)))
                                  / (size * max(1, len(text) - 1))), 4)

        cuts.append((o["page"], _box(o)))
        applied.append({"o": o, "text": text, "x": x, "y": y, "size": size, "track": track})

    # ---- deleted lines: the ink goes, nothing is drawn back ------------------
    for d in deletes:
        try:
            gi = int(d.get("gi"))
        except (TypeError, ValueError, AttributeError):
            continue
        o = by_gi.get(gi)
        if o is None:
            continue
        cuts.append((o["page"], _box(o, pad=0.9)))
        removed.append(o)

    # ---- image swaps: the old pixels in the rect, not the line art ----------
    placed = []
    for im in images:
        try:
            pno = int(im.get("page", 0))
            if pno < 0 or pno >= doc.page_count:
                continue
            rect = pymupdf.Rect(float(im["x0"]), float(im["y0"]),
                                float(im["x1"]), float(im["y1"]))
            if rect.is_empty:
                continue
            stream = _image_bytes(im.get("data") or "")
            if not stream:
                continue
            cuts.append((pno, rect, "keep_images"))
            placed.append((pno, rect, stream))
        except Exception:                                          # noqa: BLE001
            continue

    # ---- one redaction pass per page ----------------------------------------
    by_page = {}
    for cut in cuts:
        by_page.setdefault(cut[0], []).append(cut)

    for pno in sorted(by_page):
        keep_images = any(len(c) > 2 and c[2] == "keep_images" for c in by_page[pno])
        for c in by_page[pno]:
            doc[pno].add_redact_annot(c[1], fill=None, cross_out=False)
        doc[pno].apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE if keep_images else pymupdf.PDF_REDACT_IMAGE_REMOVE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE)

    for pno, rect, stream in placed:
        try:
            doc[pno].insert_image(rect, stream=stream, keep_proportion=True, overlay=True)
        except Exception:                                          # noqa: BLE001
            pass

    # ---- text back on the page ---------------------------------------------
    # one embedded font name per (page, font file); subset_fonts() trims the rest
    names = {}

    def font_name(pno, family):
        key = (pno, family)
        if key in names:
            return names[key]
        path = font_paths.get(family) or resolve_font_path(family)
        name = "X%d" % len(names)
        if path:
            doc[pno].insert_font(fontname=name, fontfile=path)
            names[key] = (name, _open_font(path))
        else:
            names[key] = ("helv", _face(doc, family))
        return names[key]

    def draw(pno, text, x, y, size, track, family, color):
        name, f = font_name(pno, family)
        page = doc[pno]
        track_pt = track * size
        for ch in text:
            if ch.strip():
                page.insert_text((x, y), ch, fontname=name, fontsize=size, color=color)
            x += (f.text_length(ch, fontsize=size) if f else size * 0.5) + track_pt

    for a in applied:
        o = a["o"]
        draw(o["page"], a["text"], a["x"], a["y"], a["size"], a["track"],
             o["font"], _rgb(o["color"]))

    added = 0
    for a in adds:
        try:
            pno = int(a.get("page", 0))
            if pno < 0 or pno >= doc.page_count:
                continue
            text = str(a.get("text") or "")
            if not text.strip():
                continue
            family = a.get("font") or "helv"
            if not (font_paths.get(family) or resolve_font_path(family)):
                refused.append({"add": a.get("id"), "reason": "font not found: %s" % family})
                continue
            draw(pno, text, float(a["x"]), float(a["y"]), float(a.get("size") or 12),
                 float(a.get("track") or 0.0), family, _rgb(a.get("color") or "#000000"))
            added += 1
        except Exception as exc:                                   # noqa: BLE001
            refused.append({"add": a.get("id"), "reason": str(exc)})

    doc.subset_fonts()
    out = doc.tobytes(garbage=4, deflate=True)
    return out, {
        "applied": len(applied),
        "added": added,
        "deleted": len(removed),
        "refused": refused,
        "images": len(placed),
    }
