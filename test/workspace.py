"""End-to-end test of the workspace, the font loader and the add/delete ops.

    .lines/bin/python test/workspace.py            # needs the sidecar on :8793

Everything is asserted against the exported PDF, not against the app's own idea
of what it did: the text layer must contain the added string, the deleted string
must be gone, and nothing outside the touched boxes may change a pixel.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

import pymupdf

BASE = os.environ.get("LINES_URL", "http://127.0.0.1:8793")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
SRC = os.path.join(os.path.expanduser("~"), "ela-menu", "ela-a4-final-A.pdf")
FONT = os.path.join(ROOT, "fonts", "Lato-Regular.ttf")

checks = []


def ok(cond, label, detail=""):
    checks.append(bool(cond))
    print(("  ok   " if cond else "  FAIL ") + label + ((" — " + str(detail)) if detail else ""))


def post(path, payload, raw=False, ctype="application/json"):
    body = json.dumps(payload).encode() if not raw else payload
    req = urllib.request.Request(BASE + path, data=body, method="POST",
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
            headers = dict(r.headers)
    except urllib.error.HTTPError as e:      # a refusal is an answer: let the check see it
        return json.loads(e.read() or b"{}"), e.code
    if ctype == "application/pdf" or headers.get("Content-Type", "").startswith("application/pdf"):
        return data, headers
    return json.loads(data or b"{}"), headers


def get(path, binary=False):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        data = r.read()
    return data if binary else json.loads(data or b"{}")


def get_code(path):
    """(body, status) for a URL that may refuse: 404 is an answer worth asserting."""
    try:
        with urllib.request.urlopen(BASE + path, timeout=120) as r:
            return r.read(), r.status
    except urllib.error.HTTPError as e:
        return e.read(), e.code


def main():
    if not os.path.exists(SRC):
        print("missing fixture:", SRC)
        return 2

    print("\n== workspace ==")
    pdf = open(SRC, "rb").read()
    created, _ = post("/projects", {"name": "ELA Menu Test", "pdf": base64.b64encode(pdf).decode()})
    slug = created["meta"]["slug"]
    ok(bool(slug), "project created", slug)
    ok(created["meta"]["pages"] == 1, "page count recorded", created["meta"]["pages"])
    n_objects = len(created["lines"]["pages"][0]["objects"])
    ok(n_objects > 100, "line objects extracted once and cached", "%d objects" % n_objects)

    listing = get("/projects")["projects"]
    ok(any(p["slug"] == slug for p in listing), "project appears in the list", len(listing))

    reopened = get("/projects/" + slug)
    ok(len(reopened["lines"]["pages"][0]["objects"]) == n_objects,
       "re-open reuses the cached objects (no re-extraction)")
    ok(reopened["work"]["edits"] == [], "work starts empty")
    stored = get("/projects/%s/original" % slug, binary=True)
    ok(stored == pdf, "original PDF stored byte-for-byte", "%d bytes" % len(stored))

    print("\n== font loader ==")
    font_bytes = open(FONT, "rb").read()
    got, _ = post("/projects/%s/fonts" % slug,
                  {"name": "Lato-Regular.ttf", "data": base64.b64encode(font_bytes).decode()})
    family = got.get("family")
    ok(bool(family), "font accepted and family read from the file", family)
    served = get("/projects/%s/fonts/%s" % (slug, got["file"]), binary=True)
    ok(served == font_bytes, "font served back byte-for-byte (for @font-face)")
    ok(any(f["family"] == family for f in get("/projects/" + slug)["fonts"]),
       "font listed on the project")

    print("\n== add / delete / edit ==")
    objs = reopened["lines"]["pages"][0]["objects"]
    victim = objs[-1]                       # last line on the sheet
    page_h = reopened["lines"]["pages"][0]["height"]
    before_text = pymupdf.open(SRC)[0].get_text()
    victim_count = before_text.count(victim["text"])

    add_y = page_h - 24                      # clear bottom margin
    payload = {
        "edits": [{"gi": objs[0]["gi"], "text": objs[0]["text"], "x": objs[0]["x"] + 6,
                   "y": objs[0]["y"]}],
        "deletes": [{"gi": victim["gi"]}],
        "adds": [{"id": "n0", "page": 0, "text": "HOUSE SPECIAL — 24",
                  "x": 40, "y": add_y, "size": 14, "track": 0.02,
                  "font": family, "color": "#111111"}],
        "images": [],
    }
    out, headers = post("/projects/%s/export" % slug, payload)
    ok(len(out) > 10000, "export returned a PDF", "%d bytes" % len(out))
    ok(headers.get("X-Adds-Applied") == "1", "added box applied", headers.get("X-Adds-Applied"))
    ok(headers.get("X-Deletes-Applied") == "1", "deletion applied", headers.get("X-Deletes-Applied"))
    ok(headers.get("X-Edits-Applied") == "1", "edit applied", headers.get("X-Edits-Applied"))
    ok(bool(headers.get("X-Export-Name")), "export archived in the project", headers.get("X-Export-Name"))

    doc = pymupdf.open(stream=out, filetype="pdf")
    text = doc[0].get_text()
    ok("HOUSE SPECIAL" in text, "added text is in the PDF's text layer")
    ok(text.count(victim["text"]) == victim_count - 1,
       "deleted line is gone from the text layer",
       "%d -> %d" % (victim_count, text.count(victim["text"])))
    ok(doc.page_count == 1, "still one page", doc.page_count)

    # the added string must sit where it was asked to sit
    hits = doc[0].search_for("HOUSE SPECIAL")
    ok(len(hits) == 1, "added line found once by position")
    if hits:
        r = hits[0]
        ok(abs(r.x0 - 40) < 2.5 and abs(r.y0 - (add_y - 14)) < 4.0,
           "added line lands at the requested spot",
           "x %.1f (want 40) y %.1f (want %.1f)" % (r.x0, r.y0, add_y - 14))

    print("\n== nothing else moved ==")
    a = pymupdf.open(SRC)[0].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    b = doc[0].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    pa = memoryview(a.samples)
    pb = memoryview(b.samples)
    touched = [
        (victim.get("ink_left", victim["x"]) - 2, victim["y"] - victim["size"],
         victim.get("ink_left", victim["x"]) + victim["ink_width"] + 2, victim["y"] + victim["size"] * 0.4),
        (objs[0].get("ink_left", objs[0]["x"]) - 2, objs[0]["y"] - objs[0]["size"],
         objs[0].get("ink_left", objs[0]["x"]) + objs[0]["ink_width"] + 10,
         objs[0]["y"] + objs[0]["size"] * 0.4),
        (30, add_y - 20, 260, add_y + 8),
    ]
    diff_outside = diff_inside = 0
    for y in range(a.height):
        for x in range(a.width):
            i = (y * a.width + x) * a.n
            if abs(pa[i] - pb[i]) > 40:
                pt = (x / 2.0, y / 2.0)
                if any(r[0] <= pt[0] <= r[2] and r[1] <= pt[1] <= r[3] for r in touched):
                    diff_inside += 1
                else:
                    diff_outside += 1
    ok(diff_outside == 0, "no pixel changed outside the touched boxes", "%d px" % diff_outside)
    ok(diff_inside > 50, "the touched boxes did change", "%d px" % diff_inside)

    print("\n== autosave ==")
    saved, _ = post("/projects/%s/work" % slug, payload)
    ok(saved["counts"]["adds"] == 1 and saved["counts"]["deletes"] == 1,
       "work saved to the project folder", saved["counts"])
    again = get("/projects/" + slug)
    ok(len(again["work"]["adds"]) == 1, "work comes back on re-open")
    ok(bool(again["meta"]["updated"]), "project timestamp bumped", again["meta"]["updated"])

    print("\n== the list is a list of documents ==")
    renamed, rcode = post("/projects/%s/rename" % slug, {"name": "  A   Client\n Menu  "})
    ok(isinstance(rcode, dict), "rename answers with the project, not a refusal",
       type(rcode).__name__)
    ok(renamed["name"] == "A Client Menu", "rename tidies the name it is given", repr(renamed["name"]))
    ok(get("/projects")["projects"][0]["name"] == "A Client Menu", "the list shows the new name")
    empty, code = post("/projects/%s/rename" % slug, {"name": "   "})
    ok(code == 400, "an empty name is refused", "%s %s" % (code, empty))
    bad, code = post("/projects/../etc/rename", {"name": "nope"})
    ok(code == 404, "a slug that could climb out of the folder is refused", code)
    alive = get("/projects/" + slug)
    ok(alive["meta"]["name"] == "A Client Menu", "the project survived both refusals")

    kill, _ = post("/projects/%s/delete" % slug, {})
    ok(isinstance(kill, dict) and kill.get("deleted") == slug,
       "delete reports what it removed", kill)
    ok(not os.path.isdir(os.path.join(ROOT, "projects", slug)), "the folder is gone from disk")
    _, code = get_code("/projects/" + slug)
    ok(code == 404, "and it cannot be opened afterwards", code)
    again, code = post("/projects/%s/delete" % slug, {})
    ok(code == 404, "deleting it twice is a 404, not a crash", "%s %s" % (code, again))

    passed = sum(1 for c in checks if c)
    print("\n%s — %d/%d checks" % ("PASS" if passed == len(checks) else "FAIL", passed, len(checks)))
    project_dir = os.path.join(ROOT, "projects", slug)
    print("project at", project_dir)
    # test projects must not clutter the client's workspace; KEEP=1 to inspect one
    if os.environ.get("KEEP") != "1":
        import shutil
        shutil.rmtree(project_dir, ignore_errors=True)
        print("(removed the test project — KEEP=1 to inspect it)")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
