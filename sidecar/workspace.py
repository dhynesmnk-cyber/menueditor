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
    _write_json(os.path.join(d, "edits.json"),
                {"edits": [], "images": [], "adds": [], "deletes": []})
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
        "work": _read_json(os.path.join(d, "edits.json"),
                           {"edits": [], "images": [], "adds": [], "deletes": []}),
        "fonts": fonts(slug),
    }


def original(slug):
    with open(os.path.join(_dir(slug), "original.pdf"), "rb") as fh:
        return fh.read()


def save_work(slug, work):
    d = _dir(slug)
    clean = {
        "edits": work.get("edits") or [],
        "images": work.get("images") or [],
        "adds": work.get("adds") or [],
        "deletes": work.get("deletes") or [],
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
