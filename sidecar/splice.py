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
import os
import re
import tempfile

import pymupdf

from grouping import _face, extract, resolve_font_path

MIN_FIT = 0.92

def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _parts(e):
    """An edit or a delete, in either shape.

    An older payload sent {"gi": n, ...}; the canvas sends [gi, patch] for an edit
    and a bare gi for a delete. Reading only the dict shape made every save from the
    canvas a no-op that still returned 200 with a plausible PDF.
    """
    if isinstance(e, dict):
        return _int(e.get("gi")), e
    if isinstance(e, (list, tuple)) and e:
        return _int(e[0]), (e[1] if len(e) > 1 and isinstance(e[1], dict) else {})
    return _int(e), {}


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


# The fourteen faces every PDF reader is required to have. A file that names one of these is
# not asking for a substitute: drawing it by name *is* the original face, with no file needed.
_BASE14 = (
    ("helvetica", {"": "helv", "bold": "hebo", "italic": "heit", "oblique": "heit",
                   "bolditalic": "hebi", "boldoblique": "hebi"}),
    ("arial", {"": "helv", "bold": "hebo", "italic": "heit", "oblique": "heit",
               "bolditalic": "hebi", "boldoblique": "hebi"}),
    ("times", {"": "tiro", "bold": "tibo", "italic": "tiit", "oblique": "tiit",
               "bolditalic": "tibi", "boldoblique": "tibi"}),
    ("courier", {"": "cour", "bold": "cobo", "italic": "coit", "oblique": "coit",
                 "bolditalic": "cobi", "boldoblique": "cobi"}),
    ("symbol", {"": "symb"}),
    ("zapfdingbats", {"": "zadb"}),
)


def _base14(family):
    """pymupdf's alias for a base-14 face, or None when this face needs a real file."""
    key = re.sub(r"[^a-z]", "", (family or "").split("+")[-1].lower())
    for stem, styles in _BASE14:
        if key.startswith(stem):
            rest = key[len(stem):].replace("newroman", "")
            for style in ("bolditalic", "boldoblique", "bold", "italic", "oblique"):
                if rest.startswith(style):
                    return styles.get(style)
            return styles.get("") if rest in ("", "regular", "roman", "mt", "ps") else styles.get("")
    return None


def _face_by_alias(alias):
    try:
        return pymupdf.Font(fontname=alias)
    except Exception:                                              # noqa: BLE001
        return None


def _open_font(path):
    if not path:
        return None
    try:
        return pymupdf.Font(fontfile=path)
    except Exception:                                              # noqa: BLE001
        return None


def _strip_text(page):
    """Take the words off a copied sheet, leave its art (rules, frames, images)."""
    page.add_redact_annot(page.rect, fill=None, cross_out=False)
    try:
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                              graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                              text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    except Exception:                                              # noqa: BLE001
        pass


def _page_map(original_count, page_ops):
    """Client page index -> sheet index in the working document.

    The client numbers pages after the operations it has already made, while the
    working PDF still holds every original sheet until the deletions at the end. Both
    lists are in page_ops, so the mapping is exact rather than assumed.
    """
    gone = set(int(p) for p in (page_ops.get("delete") or []))
    m, k = {}, 0
    for i in range(original_count):
        if i in gone:
            continue
        m[k] = i
        k += 1
    for j in range(len(page_ops.get("new") or [])):
        m[k] = original_count + j
        k += 1
    return m


def _lock_matcher(locks, by_gi):
    """Which lines the designer locked: by id, or by the words on them.

    A studio ships the rules with the file and thinks in names, not glyph ids — so a lock can
    name a line by id or by a substring of its text, and both sides resolve it to the same set.
    """
    locks = locks or {}
    ids = set()
    for v in (locks.get("lines") or []):
        gi = _int(v)
        if gi is not None:
            ids.add(gi)
    needles = [str(t).strip().lower() for t in (locks.get("text") or []) if str(t).strip()]
    if needles:
        for gi, o in by_gi.items():
            low = str(o.get("text") or "").lower()
            if any(n in low for n in needles):
                ids.add(gi)
    return ids


def build(doc_bytes, edits=None, images=None, adds=None, deletes=None, font_paths=None,
          page_ops=None, manifest=None):
    """Apply text edits, deletions, added boxes and image swaps; returns (pdf, info)."""
    edits = edits or []
    images = images or []
    adds = adds or []
    deletes = deletes or []
    font_paths = font_paths or {}
    page_ops = page_ops or {}

    data = extract(doc_bytes)
    by_gi = {}
    for p in data["pages"]:
        for o in p["objects"]:
            by_gi[o["gi"]] = o

    doc = pymupdf.open(stream=doc_bytes, filetype="pdf")
    applied, refused, removed = [], [], []
    cuts = []                                    # (page, rect) to redact
    original_count = doc.page_count

    # ---- the designer's rules, enforced here and not only in the canvas ------
    manifest = manifest or {}
    locks = manifest.get("lock") or {}
    allow = manifest.get("allow") or {}
    locked = _lock_matcher(locks, by_gi)
    locked_pages = set()
    for v in (locks.get("pages") or []):
        p = _int(v)
        if p is not None:
            locked_pages.add(p)
    if allow.get("pageOps") is False:
        page_ops = {}
    else:
        page_ops = {k: list(v or []) for k, v in page_ops.items()}
        page_ops["delete"] = [p for p in page_ops.get("delete") or []
                              if _int(p) not in locked_pages]

    # ---- new sheets first, so the pages the payload addresses all exist -----
    # A copy keeps the art and loses the words: the lines of a duplicated sheet are
    # sent as added boxes, which is what makes the copy editable rather than a picture.
    added_pages = 0
    copy_src = None
    for spec in (page_ops.get("new") or []):
        src = spec.get("from")
        if src is not None and 0 <= int(src) < original_count:
            if copy_src is None:      # pymupdf refuses to copy a document into itself
                copy_src = pymupdf.open(stream=doc_bytes, filetype="pdf")
            at = doc.page_count
            doc.insert_pdf(copy_src, from_page=int(src), to_page=int(src), start_at=at)
            _strip_text(doc[at])
        else:
            base = doc[0].rect if doc.page_count else pymupdf.Rect(0, 0, 595, 842)
            w = float(spec.get("width") or base.width)
            h = float(spec.get("height") or base.height)
            doc.new_page(doc.page_count, width=w, height=h)
        added_pages += 1

    # ---- existing lines -----------------------------------------------------
    for e in edits:
        gi, patch = _parts(e)
        if gi is None:
            refused.append({"payload": "unreadable edit", "value": repr(e)[:60]})
            continue
        o = by_gi.get(gi)
        if o is None:
            refused.append({"gi": gi, "reason": "no such line"})
            continue
        if gi in locked:
            refused.append({"gi": gi, "reason": "locked by the designer",
                            "text": o["text"][:40]})
            continue
        if allow.get("restyle") is False:
            patch = {k: v for k, v in patch.items() if k not in ("font", "color")}
        text = patch.get("text", o["text"])
        x = float(patch.get("x", o["x"]))
        y = float(patch.get("y", o["y"]))
        size = float(patch.get("size", o["size"]))
        track = float(patch.get("track", o["track_em"] if o["letter_spaced"] else 0.0))
        # a style change travels with the text: same slot, another face or ink
        family = patch.get("font") or o["font"]
        color = patch.get("color") or o["color"]
        moved = abs(x - o["x"]) > 0.05 or abs(y - o["y"]) > 0.05
        retracked = abs(track - (o["track_em"] if o["letter_spaced"] else 0.0)) > 0.002
        resized = abs(size - o["size"]) > 0.01
        restyled = family != o["font"] or str(color).lower() != str(o["color"]).lower()
        if text == o["text"] and not moved and not retracked and not resized and not restyled:
            continue

        face_path = font_paths.get(family) or resolve_font_path(family)
        alias = _base14(family) if not face_path else None
        if not face_path and not alias:
            refused.append({"gi": o["gi"], "reason": "font not installed: %s" % family,
                            "text": o["text"][:40]})
            continue

        font = _open_font(face_path) or _face_by_alias(alias) or _face(doc, family)
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
        applied.append({"o": o, "text": text, "x": x, "y": y, "size": size, "track": track,
                        "font": family, "color": color})

    # ---- deleted lines: the ink goes, nothing is drawn back ------------------
    for d in deletes:
        gi = _parts(d)[0]
        if gi is None:
            refused.append({"payload": "unreadable delete", "value": repr(d)[:60]})
            continue
        o = by_gi.get(gi)
        if o is None:
            refused.append({"gi": gi, "reason": "no such line"})
            continue
        if gi in locked:
            refused.append({"gi": gi, "reason": "locked by the designer",
                            "text": o["text"][:40]})
            continue
        if allow.get("deleteLines") is False:
            refused.append({"gi": gi, "reason": "deleting lines is not allowed here"})
            continue
        cuts.append((o["page"], _box(o, pad=0.9)))
        removed.append(o)

    # ---- image swaps: the old pixels in the rect, not the line art ----------
    pmap = _page_map(original_count, page_ops)
    placed = []
    for im in images:
        try:
            pno = pmap.get(int(im.get("page", 0)), int(im.get("page", 0)))
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
        alias = _base14(family) if not path else None
        if alias:
            # a base-14 name is the face itself, not a stand-in, and needs no file
            names[key] = (alias, _face_by_alias(alias))
            return names[key]
        if not path:
            # Unreachable for edits (they are refused above) and for adds (likewise). Kept as an
            # exception rather than a substitution so no future path can quietly draw Helvetica.
            raise RuntimeError("font not installed: %s" % family)
        doc[pno].insert_font(fontname=name, fontfile=path)
        names[key] = (name, _open_font(path))
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
             a.get("font") or o["font"], _rgb(a.get("color") or o["color"]))

    added = 0
    for a in adds:
        try:
            if allow.get("addText") is False:
                refused.append({"add": a.get("id"), "reason": "adding text is not allowed here"})
                continue
            pno = pmap.get(int(a.get("page", 0)), int(a.get("page", 0)))
            if pno < 0 or pno >= doc.page_count:
                continue
            text = str(a.get("text") or "")
            if not text.strip():
                continue
            family = a.get("font") or "helv"
            if not (font_paths.get(family) or resolve_font_path(family) or _base14(family)):
                refused.append({"add": a.get("id"), "reason": "font not found: %s" % family})
                continue
            draw(pno, text, float(a["x"]), float(a["y"]), float(a.get("size") or 12),
                 float(a.get("track") or 0.0), family, _rgb(a.get("color") or "#000000"))
            added += 1
        except Exception as exc:                                   # noqa: BLE001
            refused.append({"add": a.get("id"), "reason": str(exc)})

    # ---- deleted sheets last, so every id above still meant what it said ----
    gone = []
    for p in (page_ops.get("delete") or []):
        try:
            gone.append(int(p))
        except (TypeError, ValueError):
            continue
    gone = [p for p in gone if 0 <= p < original_count]
    for pno in sorted(set(gone), reverse=True):
        doc.delete_page(pno)

    doc.subset_fonts()
    out = doc.tobytes(garbage=4, deflate=True)
    return out, {
        "applied": len(applied),
        "added": added,
        "deleted": len(removed),
        "refused": refused,
        "images": len(placed),
        "pages_added": added_pages,
        "pages_deleted": len(set(gone)),
    }
