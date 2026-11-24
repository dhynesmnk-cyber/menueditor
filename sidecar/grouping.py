"""PDF → editable line objects, at pixel fidelity.

This is the import half of canvas mode. It does not rebuild the page: it reads the
PDF's own glyph positions and groups them into one editable object per visual line,
so an untouched line can be redrawn exactly where the original put it. Every page is
read; each object carries `page` and a document-wide `gi`, so an edit can be
addressed without the client knowing the layout.

Three encodings have to be handled, and a real menu mixes all three:

  A. positional  — no space glyphs at all; word boundaries exist only as wider
                   advances ('NOTCURRIES', and every body-copy line in the ELA menu)
  B. literal     — normal space glyphs ('romaine, radish, chickpeas, beet')
  C. tracked     — one space glyph between *every letter* of a heading
                   ('R E G I O N A L  I N D I A N'); a single space is letter-spacing,
                   a wider gap is a word break

Gaps are measured between consecutive glyphs, then classified by the line's own
token shape — never by gap width alone, because a space glyph's advance absorbs the
gap and makes letter and word spacing measure identically.
"""
import statistics

import pymupdf

SPACE_FRAC = 0.55     # positional gap beyond this * space width -> word break
MERGE_SPACES = 2.2    # same-baseline fragments closer than this merge into one line
LINE_TOL = 0.35       # baseline tolerance, fraction of font size
SIZE_TOL = 0.20       # size difference that means "different line"

_face_cache = {}


def _face(doc, font):
    """A pymupdf.Font for measuring; falls back to None when the face is unusable."""
    key = id(doc), font
    if key not in _face_cache:
        try:
            path = resolve_font_path(font)
            _face_cache[key] = pymupdf.Font(fontfile=path) if path else None
        except Exception:
            _face_cache[key] = None
    return _face_cache[key]


_FONT_MAP = {}


def _candidates(family, style):
    """Every face on this machine that could stand in for a PDF font."""
    import glob
    import os
    import subprocess

    out = []
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for ext in ("ttf", "otf", "TTF", "OTF"):
        out += glob.glob(os.path.join(here, "fonts", f"{family}-{style}.{ext}"))
        out += glob.glob(os.path.join(here, "fonts", f"{family}*.{ext}"))
    for q in (f"{family}:style={style}", f"{family}:style=Bold" if "Bold" in style else family,
              family):
        try:
            r = subprocess.run(["fc-list", "-f", "%{file}\n", q], capture_output=True,
                               text=True, timeout=5).stdout.strip()
            out += [p for p in r.splitlines() if p]
        except Exception:
            pass
    seen, uniq = set(), []
    for p in out:
        if p and p not in seen and os.path.exists(p):
            seen.add(p)
            uniq.append(p)
    if not uniq:
        # the app names its own fonts MCrimson/MLato: match on a shared name stem before
        # giving up, so a PDF exported by Menu Studio reopens in the face it was set in
        import os
        stem = family.lower().lstrip("m")
        for name in sorted(os.listdir(os.path.join(here, "fonts"))):
            low = name.lower()
            if not low.endswith((".ttf", ".otf")):
                continue
            if stem and (stem in low or low.split("text")[0].startswith(stem[:4])):
                uniq.append(os.path.join(here, "fonts", name))
    return uniq


def _choose_face(doc, font, sample, size, target):
    """Pick the candidate whose advance width best matches what the PDF actually used.

    Weight is the thing this catches: a vendor copy of Lato-Bold can be a heavier cut
    than the designer's, which renders 14% more ink and 4% wider at the same point size.
    """
    if font in _FONT_MAP:
        return _FONT_MAP[font]
    base = font.split("+")[-1]
    family, _, style = base.partition("-")
    style = style or "Regular"
    cands = _candidates(family, style)
    if style.lower() in ("regular", ""):
        # a name with no weight in it is a regular cut; a bold file would collide with
        # itself at the regular advance widths
        regulars = [p for p in cands if "regular" in p.lower()]
        if regulars:
            cands = regulars
    best, best_err = None, None
    for path in cands:
        try:
            f = pymupdf.Font(fontfile=path)
            w = f.text_length(sample, fontsize=size)
        except Exception:
            continue
        err = abs(w - target)
        if best is None or err < best_err:
            best, best_err = path, err
    _FONT_MAP[font] = best
    _face_cache.clear()          # measurement must use the face we just chose
    return best


def resolve_font_path(name):
    """The face chosen for this PDF font (see _choose_face), else a first guess.

    The guess is deliberately not cached: _analyze runs before the document-wide
    choice, and caching its first candidate would make the choice a no-op.
    """
    if name in _FONT_MAP:
        return _FONT_MAP[name]
    base = name.split("+")[-1]
    family, _, style = base.partition("-")
    cands = _candidates(family, style or "Regular")
    return cands[0] if cands else None


def _space_width(doc, font, size):
    f = _face(doc, font)
    try:
        return f.text_length(" ", fontsize=size) if f else size * 0.25
    except Exception:
        return size * 0.25


def _natural_width(doc, font, text, size):
    f = _face(doc, font)
    try:
        return f.text_length(text, fontsize=size) if f else size * 0.5 * len(text)
    except Exception:
        return size * 0.5 * len(text)


def _analyze(doc, gs):
    """One PyMuPDF line -> one object: text, tracking, per-glyph offsets."""
    gs = sorted(gs, key=lambda g: g["x0"])
    size = statistics.median([g["size"] for g in gs])
    font = statistics.mode([g["font"] for g in gs])
    sw = _space_width(doc, font, size)

    # token shape decides which encoding this line uses
    tokens, cur, run, seq = [], [], 0, []
    for g in gs:
        if g["c"].strip() == "":
            if cur:
                seq.append(("tok", cur))
                tokens.append(cur)
                cur = []
            run += 1
            continue
        if run:
            prev_end = 0.0
            for item in reversed(seq):
                if item[0] == "tok":
                    prev_end = item[1][-1]["x1"]
                    break
            seq.append(("gap", run, g["x0"] - prev_end))
            run = 0
        cur.append(g)
    if cur:
        seq.append(("tok", cur))
        tokens.append(cur)

    lens = [len(t) for t in tokens]
    single_frac = (sum(1 for n in lens if n == 1) / len(lens)) if lens else 0.0
    tracked = len(tokens) >= 3 and single_frac >= 0.5

    gaps = [s for s in seq if s[0] == "gap"]
    med_gap = statistics.median([g[2] for g in gaps]) if gaps else 0.0
    text, out, idx = "", [], []
    for item in seq:
        if item[0] == "gap":
            _, n, width = item
            if tracked:
                is_word = n >= 2 or (width - med_gap) >= 0.55 * sw
            else:
                is_word = True
            if is_word and text and not text.endswith(" "):
                text += " "
        else:
            gl = item[1]
            base = len(text)
            text += "".join(g["c"] for g in gl)
            idx.extend(range(base, base + len(gl)))
            out.extend(gl)

    if not text.strip() or not out:
        return None
    g0, g1 = out[0], out[-1]
    nat = _natural_width(doc, font, text, size)
    ink = g1["x1"] - g0["x0"]
    implied = (ink - nat) / max(1, len(text) - 1)
    return {
        "text": text.strip(),
        # x is the PEN origin: drawing at the ink edge would shift every glyph right by
        # its left side bearing (4% too wide, 14% too much ink on a real line)
        "x": round(g0["xo"], 3), "y": round(g0["y"], 3),
        "ink_left": round(g0["x0"], 3),
        "size": round(size, 3), "font": font, "color": "#%06x" % (g0["color"] or 0),
        "track_em": round(implied / size, 4),
        "space_pt": round(sw, 3),
        "ink_width": round(ink, 2),
        "letter_spaced": tracked,
        "chars": len(text),
        "glyph_x": [round(g["xo"] - g0["xo"], 3) for g in out],
        "glyph_idx": idx,
    }


def _collect_lines(page):
    """Every painted line on the page, as lists of glyph dicts."""
    lines = []
    for block in page.get_text("rawdict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            gs = []
            for span in line["spans"]:
                for ch in span["chars"]:
                    gs.append({"c": ch["c"], "x0": ch["bbox"][0], "x1": ch["bbox"][2],
                               "xo": ch["origin"][0],
                               "y": ch["origin"][1], "size": span["size"],
                               "font": span["font"], "color": span["color"]})
            if gs and any(g["c"].strip() for g in gs):
                lines.append(gs)
    return lines


def _merge_page(doc, objects):
    """Join fragments that clearly continue the same line, forwards in x only."""
    objects.sort(key=lambda o: (round(o["y"], 1), o["x"]))
    merged = []
    for o in objects:
        if merged:
            p = merged[-1]
            gap = o["x"] - (p["x"] + p["ink_width"])
            same = (abs(o["y"] - p["y"]) <= LINE_TOL * max(o["size"], p["size"])
                    and abs(o["size"] - p["size"]) <= SIZE_TOL * max(o["size"], p["size"])
                    and o["font"] == p["font"])
            if same and -1.0 <= gap <= MERGE_SPACES * o["space_pt"]:
                p["text"] += " " + o["text"]
                p["ink_width"] = round((o["x"] + o["ink_width"]) - p["x"], 2)
                p["glyph_x"] += [round(o["x"] - p["x"] + gx, 3) for gx in o["glyph_x"]]
                p["chars"] = len(p["text"])
                p["letter_spaced"] = p["letter_spaced"] or o["letter_spaced"]
                nat = _natural_width(doc, p["font"], p["text"], p["size"])
                implied = (p["ink_width"] - nat) / max(1, len(p["text"]) - 1)
                p["track_em"] = round(implied / p["size"], 4)
                continue
        merged.append(o)
    return merged


def _retrack(doc, o):
    """Re-derive tracking from the chosen face's advance, for space-tracked lines."""
    if not o["letter_spaced"]:
        return
    nat = _natural_width(doc, o["font"], o["text"], o["size"])
    implied = (o["ink_width"] - nat) / max(1, len(o["text"]) - 1)
    o["track_em"] = round(implied / o["size"], 4)


def _thin_rules(page):
    """Only rules and dividers are drag obstacles.

    Leader dots are thin too, and there can be a thousand of them on a menu: treating
    them as obstacles would cap every dish name at its first dot. A real rule is long
    in one direction rather than a small square.
    """
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        long_rule = (r.height <= 2.5 and r.width >= 8) or (r.width <= 2.5 and r.height >= 8)
        if long_rule:
            out.append([round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)])
    return out


def _limits(page, objects):
    """Each object's slack: nearest text to the right, any rule, and a growth cap."""
    drawings = [d["rect"] for d in page.get_drawings()]
    for o in objects:
        ink_left = o.get("ink_left", o["x"])
        limit = page.rect.width - 6
        for r in drawings:
            if r.x0 > ink_left + o["ink_width"] - 1 and r.y0 < o["y"] + o["size"] * 0.24 \
                    and r.y1 > o["y"] - o["size"] * 0.78 and r.x1 > r.x0:
                limit = min(limit, r.x0 - ink_left - 3)
        for p in objects:
            if p is o:
                continue
            p_left = p.get("ink_left", p["x"])
            if abs(p["y"] - o["y"]) <= 1.5 and p_left > ink_left + 1:
                limit = min(limit, p_left - ink_left - 5)
        # a two-letter legend must not become a sentence
        o["max_width"] = round(max(min(limit, o["ink_width"] * 3 + 12), o["ink_width"]), 2)


def _image_rects(page):
    """Placed images, so the editor can offer to swap one."""
    out = []
    try:
        for info in page.get_image_info():
            r = pymupdf.Rect(info["bbox"])
            if r.width > 12 and r.height > 12:
                out.append({"x0": round(r.x0, 2), "y0": round(r.y0, 2),
                            "x1": round(r.x1, 2), "y1": round(r.y1, 2)})
    except Exception:
        pass
    return out


def _plate(page, zoom=2.0):
    """The page with its text removed — rules, frames and images only."""
    page.add_redact_annot(page.rect, fill=None, cross_out=False)
    try:
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                              graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                              text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    except Exception:
        pass
    return page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False).tobytes("png")


def page_objects(doc, page):
    """Line objects for one page (no face choice — that is a document-level decision)."""
    objects = _merge_page(doc, [o for o in (_analyze(doc, gs) for gs in _collect_lines(page)) if o])
    for o in objects:
        _retrack(doc, o)
    _limits(page, objects)
    return objects


def extract(doc_bytes, pages=None):
    """Return {pages:[{index,width,height,objects,vectors,images,plate}], fonts, warnings}."""
    import base64

    doc = pymupdf.open(stream=doc_bytes, filetype="pdf")
    wanted = list(range(doc.page_count)) if pages is None else \
        [p for p in pages if 0 <= p < doc.page_count]

    per_page = []
    for pno in wanted:
        page = doc[pno]
        objs = [o for o in (_analyze(doc, gs) for gs in _collect_lines(page)) if o]
        per_page.append((pno, page, _merge_page(doc, objs)))

    # a face is a property of the document: choose it from the longest sample anywhere.
    # Only untracked lines are used — a letter-spaced heading's ink is wider than any
    # natural advance, which would make the chooser pick the heaviest cut it can find.
    samples = {}
    for _, _, objs in per_page:
        for o in objs:
            cand = (1 if o["letter_spaced"] else 0, -len(o["text"]))
            cur = samples.get(o["font"])
            if cur is None or cand < cur[0]:
                samples[o["font"]] = (cand, o)
    for fname, (_, sample) in samples.items():
        target = sample["ink_width"]
        if sample["letter_spaced"]:
            target -= sample["track_em"] * sample["size"] * max(0, len(sample["text"]) - 1)
        _choose_face(doc, fname, sample["text"], sample["size"], target)

    out_pages, gi = [], 0
    for pno, page, objs in per_page:
        for o in objs:
            _retrack(doc, o)
            o["page"] = pno
            o["gi"] = gi
            gi += 1
        _limits(page, objs)
        out_pages.append({
            "index": pno,
            "width": round(page.rect.width, 2),
            "height": round(page.rect.height, 2),
            "objects": objs,
            "vectors": _thin_rules(page),
            "images": _image_rects(page),
            "plate": "data:image/png;base64," + base64.b64encode(_plate(page)).decode(),
        })

    # faces the browser can actually use
    import mimetypes
    fonts = {}
    for fname in samples:
        path = resolve_font_path(fname)
        if not path:
            fonts[fname] = None
            continue
        with open(path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode()
        fmt = "opentype" if path.lower().endswith(".otf") else "truetype"
        fonts[fname] = {"family": path.rsplit("/", 1)[-1].rsplit(".", 1)[0],
                        "format": fmt, "data": data,
                        "mime": mimetypes.guess_type(path)[0] or "font/ttf"}

    return {
        "pages": out_pages,
        "fonts": fonts,
        "warnings": [f"no usable font file for {k}" for k, v in fonts.items() if v is None],
    }


def plate_png(doc_bytes, zoom=2.0):
    """Backwards-compatible helper: the plate for page 1 of a PDF."""
    doc = pymupdf.open(stream=doc_bytes, filetype="pdf")
    return _plate(doc[0], zoom)
