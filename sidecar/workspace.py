"""Project workspace for Menu Studio.

A project is a folder on disk, not a tab in a browser:

    projects/<slug>/
        original.pdf     the file the designer shipped — never overwritten
        objects.json     the extracted line objects (cached; re-open is instant)
        edits.json       text edits, image swaps, added boxes, deleted lines
        fonts/           font files added through the loader
        exports/         every PDF this project has produced
        meta.json        name, page count, timestamps

Why a folder: a designer sends a menu once, the client keeps adjusting prices for
months. An editor that loses the document on reload is not a workspace. Everything
here is plain files so a project can be copied, backed up, or handed back.
"""
import hashlib
import json
import os
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, os.pardir))
PROJECTS = os.environ.get("MENU_PROJECTS") or os.path.join(ROOT, "projects")

FONT_EXT = (".ttf", ".otf", ".ttc", ".woff", ".woff2")


# ── helpers ────────────────────────────────────────────────────────────────────
def _slug(name):
    base = re.sub(r"[^a-z0-9]+", "-", (name or "menu").lower()).strip("-") or "menu"
    base = base[:48]
    # a short hash keeps two menus with the same name apart without a counter
    h = hashlib.sha1((name or "").encode("utf-8") + str(time.time()).encode()).hexdigest()[:4]
    return "%s-%s" % (base, h)


def _dir(slug):
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", slug or ""):
        raise ValueError("bad project slug")
    return os.path.join(PROJECTS, slug)


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default if default is not None else {}


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, sort_keys=True)
    os.replace(tmp, path)          # atomic: a crash cannot leave half a file


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _family_of(path):
    """The font's own family name, so the browser and the exporter agree on it."""
    try:
        import pymupdf
        return pymupdf.Font(fontfile=path).name or ""
    except Exception:                                              # noqa: BLE001
        stem = os.path.splitext(os.path.basename(path))[0]
        return re.sub(r"[^A-Za-z0-9]+", "", stem.split("-")[0]) or stem


# ── projects ───────────────────────────────────────────────────────────────────
def _empty_work():
    return {"edits": [], "images": [], "adds": [], "deletes": [],
            "page_ops": {"new": [], "delete": []}}


def _image_kind(data):
    """(extension, mime) for a raster sheet, or None. Magic bytes, never the filename."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg", "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


def _px_of(data, kind):
    """Pixel size without a decoder dependency: read the header."""
    import struct
    if kind == "png":
        return struct.unpack(">II", data[16:24])
    if kind == "jpg":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
        return None
    if kind == "webp":
        if data[12:16] == b"VP8X":
            w = int.from_bytes(data[24:27], "little") + 1
            h = int.from_bytes(data[27:30], "little") + 1
            return w, h
        return struct.unpack("<HH", data[26:30])
    return None


def create_image(name, data, filename=""):
    """A project whose sheet is a picture: the plate is the art, the layer on it is text.

    A designer who only has a PNG of the menu (a screenshot, a photo, an export from
    somewhere else) can still set prices on it: the picture is the page, and every box the
    client adds is drawn on top and exported into a PDF of the same size.
    """
    kind = _image_kind(data)
    if not kind:
        raise ValueError("not a PNG, JPEG or WebP: %s" % (filename or "image"))
    ext, mime = kind
    px = _px_of(data, ext)
    if not px or px[0] < 16 or px[1] < 16:
        raise ValueError("could not read the image size")

    # 150 dpi is print resolution; a phone photo can be far bigger than a sheet, so cap
    # the long side at 20in (1440 pt) and keep the aspect ratio exact.
    w_pt = px[0] * 72.0 / 150.0
    h_pt = px[1] * 72.0 / 150.0
    long_pt = max(w_pt, h_pt)
    if long_pt > 1440:
        k = 1440.0 / long_pt
        w_pt, h_pt = w_pt * k, h_pt * k

    slug = _slug(name)
    d = _dir(slug)
    os.makedirs(os.path.join(d, "fonts"), exist_ok=True)
    os.makedirs(os.path.join(d, "exports"), exist_ok=True)
    with open(os.path.join(d, "original." + ext), "wb") as fh:
        fh.write(data)

    import base64
    lines = {
        "pages": [{
            "index": 0,
            "width": round(w_pt, 2),
            "height": round(h_pt, 2),
            "objects": [],
            "vectors": [],
            "images": [],
            "kind": "raster",
            "plate": "data:%s;base64,%s" % (mime, base64.b64encode(data).decode()),
        }],
        "fonts": [],
        "warnings": [],
    }
    _write_json(os.path.join(d, "objects.json"), lines)
    meta = {
        "slug": slug,
        "name": name or "Untitled menu",
        "created": _now(),
        "updated": _now(),
        "pages": 1,
        "size": len(data),
        "fonts": [],
        "kind": "image",
        "source": "original." + ext,
        "px": [px[0], px[1]],
    }
    _write_json(os.path.join(d, "meta.json"), meta)
    _write_json(os.path.join(d, "edits.json"), _empty_work())

    # a raster sheet has no document fonts, so give the project one to type in
    base_font = os.path.join(ROOT, "fonts", "Lato-Regular.ttf")
    if os.path.isfile(base_font):
        with open(base_font, "rb") as fh:
            add_font(slug, "Lato-Regular.ttf", fh.read())
    return {"meta": meta, "lines": lines}


def create(name, pdf_bytes):
    """Store a new project and its extracted objects."""
    import grouping

    slug = _slug(name)
    d = _dir(slug)
    os.makedirs(os.path.join(d, "fonts"), exist_ok=True)
    os.makedirs(os.path.join(d, "exports"), exist_ok=True)
    with open(os.path.join(d, "original.pdf"), "wb") as fh:
        fh.write(pdf_bytes)

    lines = grouping.extract(pdf_bytes)
    _write_json(os.path.join(d, "objects.json"), lines)
    _write_json(os.path.join(d, "edits.json"), _empty_work())
    meta = {
        "slug": slug,
        "name": name or "Untitled menu",
        "created": _now(),
        "updated": _now(),
        "pages": len(lines.get("pages", [])),
        "size": len(pdf_bytes),
        "fonts": [],
    }
    _write_json(os.path.join(d, "meta.json"), meta)
    return {"meta": meta, "lines": lines}


def listing():
    if not os.path.isdir(PROJECTS):
        return []
    out = []
    for slug in sorted(os.listdir(PROJECTS)):
        meta = _read_json(os.path.join(PROJECTS, slug, "meta.json"))
        if not meta:
            continue
        meta["hasEdits"] = bool(_read_json(os.path.join(PROJECTS, slug, "edits.json"), {})
                                .get("edits") or _read_json(os.path.join(PROJECTS, slug, "edits.json"), {})
                                .get("adds"))
        out.append(meta)
    out.sort(key=lambda m: m.get("updated") or "", reverse=True)
    return out


def open_project(slug):
    """Meta + cached line objects + saved work, ready to render."""
    d = _dir(slug)
    meta = _read_json(os.path.join(d, "meta.json"))
    if not meta:
        raise FileNotFoundError("no such project: %s" % slug)
    lines = _read_json(os.path.join(d, "objects.json"))
    if not lines.get("pages"):
        import grouping
        with open(os.path.join(d, "original.pdf"), "rb") as fh:
            lines = grouping.extract(fh.read())
        _write_json(os.path.join(d, "objects.json"), lines)
    return {
        "meta": meta,
        "lines": lines,
        "work": _read_json(os.path.join(d, "edits.json"), _empty_work()),
        "fonts": fonts(slug),
        "manifest": manifest(slug),
    }


def reimport_pdf(slug, pdf_bytes):
    """Swap the source PDF for a revised one, carrying the client's work across.

    The old import and the new one are matched line by line (see sidecar/reimport.py), the
    work is re-keyed onto the new ids, and only then is anything overwritten — a failure here
    leaves the project as it was.
    """
    import grouping
    import reimport as reim

    d = _dir(slug)
    meta = _read_json(os.path.join(d, "meta.json"))
    if meta.get("kind") == "image":
        raise ValueError("this project is a picture, not a PDF — there is nothing to re-import")
    old = _read_json(os.path.join(d, "objects.json"), {"pages": []})
    work = _read_json(os.path.join(d, "edits.json"), _empty_work())

    fresh = grouping.extract(pdf_bytes)
    if not (fresh.get("pages") or []):
        raise ValueError("the new PDF has no pages")
    new_work, report = reim.remap(old, fresh, work)

    with open(os.path.join(d, "original.pdf"), "wb") as fh:
        fh.write(pdf_bytes)
    _write_json(os.path.join(d, "objects.json"), fresh)
    _write_json(os.path.join(d, "edits.json"), new_work)
    meta.update({"pages": len(fresh["pages"]), "updated": _now(),
                 "size": len(pdf_bytes), "source": "original.pdf"})
    _write_json(os.path.join(d, "meta.json"), meta)
    return {"report": report, "summary": reim.summary(report), "work": new_work, "meta": meta}


def original(slug):
    """The document the export splices: the PDF itself, or a one-page PDF made from the
    picture a raster project was created from (same page box every time, so repeat exports
    are stable)."""
    d = _dir(slug)
    meta = _read_json(os.path.join(d, "meta.json"))
    path = os.path.join(d, "original.pdf")
    if meta.get("kind") != "image" and os.path.isfile(path):
        with open(path, "rb") as fh:
            return fh.read()
    if meta.get("kind") == "image":
        import pymupdf
        src = os.path.join(d, meta.get("source") or "original.png")
        with open(src, "rb") as fh:
            data = fh.read()
        pages = (_read_json(os.path.join(d, "objects.json")) or {}).get("pages") or [{}]
        w = float(pages[0].get("width") or 595)
        h = float(pages[0].get("height") or 842)
        doc = pymupdf.open()
        page = doc.new_page(width=w, height=h)
        page.insert_image(pymupdf.Rect(0, 0, w, h), stream=data, keep_proportion=False)
        out = doc.tobytes(garbage=3, deflate=True)
        with open(path, "wb") as fh:          # cache it: the sheet does not change
            fh.write(out)
        return out
    with open(path, "rb") as fh:
        return fh.read()


def save_work(slug, work):
    d = _dir(slug)
    clean = {
        "edits": work.get("edits") or [],
        "images": work.get("images") or [],
        "adds": work.get("adds") or [],
        "deletes": work.get("deletes") or [],
        # sheet operations are part of the work: a reload must not resurrect a page the
        # client deleted or lose the one they added
        "page_ops": {
            "new": (work.get("page_ops") or {}).get("new") or [],
            "delete": (work.get("page_ops") or {}).get("delete") or [],
        },
    }
    _write_json(os.path.join(d, "edits.json"), clean)
    meta = _read_json(os.path.join(d, "meta.json"))
    meta["updated"] = _now()
    _write_json(os.path.join(d, "meta.json"), meta)
    return {"savedAt": meta["updated"],
            "counts": {"edits": len(clean["edits"]), "images": len(clean["images"]),
                       "adds": len(clean["adds"]), "deletes": len(clean["deletes"])}}


def save_export(slug, pdf_bytes):
    d = os.path.join(_dir(slug), "exports")
    os.makedirs(d, exist_ok=True)
    name = "menu-%s.pdf" % time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(d, name), "wb") as fh:
        fh.write(pdf_bytes)
    # keep the folder honest: the twelve most recent exports
    old = sorted(os.listdir(d), reverse=True)[12:]
    for f in old:
        try:
            os.remove(os.path.join(d, f))
        except OSError:
            pass
    return name


# ── fonts ─────────────────────────────────────────────────────────────────────
DEFAULT_MANIFEST = {
    "version": 1,
    "note": "",
    "lock": {"lines": [], "text": [], "pages": []},
    "allow": {"addText": True, "pageOps": True, "restyle": True, "deleteLines": True},
}


def manifest(slug):
    """What the designer allowed on this menu.

    A menu arrives from a studio with rules attached: this line is the brand's, that page is
    the layout, the client may set prices and nothing else. The rules live in the project as
    plain JSON so they travel with the file, and both the canvas and the exporter read them —
    the exporter enforcing them is what stops a stale tab from writing over a locked line.
    """
    m = _read_json(os.path.join(_dir(slug), "manifest.json"), {})
    if not m:
        return json.loads(json.dumps(DEFAULT_MANIFEST))
    out = json.loads(json.dumps(DEFAULT_MANIFEST))
    out.update({k: v for k, v in m.items() if k not in ("lock", "allow")})
    for group in ("lock", "allow"):
        if isinstance(m.get(group), dict):
            out[group].update(m[group])
    return out


def write_manifest(slug, data):
    d = _dir(slug)
    clean = json.loads(json.dumps(DEFAULT_MANIFEST))
    clean.update({k: v for k, v in (data or {}).items() if k not in ("lock", "allow")})
    for group in ("lock", "allow"):
        if isinstance((data or {}).get(group), dict):
            clean[group].update(data[group])
    for key in ("lines", "text", "pages"):
        clean["lock"][key] = [x for x in (clean["lock"].get(key) or [])
                              if isinstance(x, (int, str)) and str(x).strip()]
    for key in ("addText", "pageOps", "restyle", "deleteLines"):
        clean["allow"][key] = bool(clean["allow"].get(key))
    _write_json(os.path.join(d, "manifest.json"), clean)
    meta = _read_json(os.path.join(d, "meta.json"))
    meta["updated"] = _now()
    _write_json(os.path.join(d, "meta.json"), meta)
    return clean


def fonts(slug):
    """[{family, file}] for every font file in the project."""
    d = os.path.join(_dir(slug), "fonts")
    if not os.path.isdir(d):
        return []
    out = []
    for f in sorted(os.listdir(d)):
        if f.lower().endswith(FONT_EXT):
            out.append({"family": _family_of(os.path.join(d, f)), "file": f})
    return out


def add_font(slug, filename, data):
    """Store a font the client supplied and report the family name it declares."""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in FONT_EXT:
        raise ValueError("not a font file: %s" % filename)
    if not data or len(data) < 64:
        raise ValueError("empty font file")
    d = os.path.join(_dir(slug), "fonts")
    os.makedirs(d, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(filename))
    path = os.path.join(d, safe)
    with open(path, "wb") as fh:
        fh.write(data)
    family = _family_of(path)
    if not family:
        os.remove(path)
        raise ValueError("could not read a font family from that file")
    meta = _read_json(os.path.join(_dir(slug), "meta.json"))
    meta["updated"] = _now()
    _write_json(os.path.join(_dir(slug), "meta.json"), meta)
    return {"family": family, "file": safe}


def font_path(slug, filename):
    d = os.path.join(_dir(slug), "fonts")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.basename(filename))
    path = os.path.join(d, safe)
    if not os.path.isfile(path):
        raise FileNotFoundError(filename)
    return path
