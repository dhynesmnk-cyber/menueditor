"""The export must accept the payload shape the canvas actually saves.

An older payload nested each edit (`{"gi": 12, "text": ...}`) and each delete
(`{"gi": 12}`). The canvas saves `[gi, patch]` pairs and bare gi numbers, and the
sidecar used to read only the nested shape: saves from the editor exported a
plausible PDF with none of the client's text changes and none of their deletions.
Nothing failed — the request returned 200 — so this test asserts the applied
counts, not just the file.

    .lines/bin/python test/export-shapes.py        (KEEP=1 to inspect the project)
"""
import base64
import json
import os
import shutil
import sys
import urllib.request

import pymupdf

BASE = os.environ.get("LINES_URL", "http://127.0.0.1:8793")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
SRC = os.environ.get("ELA_PDF", "/home/dhynesmnk/ela-menu/ela-a4-final-A.pdf")

checks = []


def ok(cond, label, detail=""):
    checks.append(bool(cond))
    print(("  ok   " if cond else "  FAIL ") + label + ((" — " + str(detail)) if detail else ""))


def post(path, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=body,
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read(), {k.lower(): v for k, v in r.headers.items()}


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=300) as r:
        return json.loads(r.read() or b"{}")


def main():
    if not os.path.exists(SRC):
        print("no source PDF at", SRC, "- set ELA_PDF")
        return 2
    pdf = open(SRC, "rb").read()
    created = post("/projects", {"name": "Payload Shapes", "pdf": base64.b64encode(pdf).decode()})
    slug = json.loads(created[0])["meta"]["slug"]
    print("project:", slug)

    objs = get("/projects/" + slug)["lines"]["pages"][0]["objects"]
    by_text = {o["text"].strip(): o for o in objs}
    victim = by_text.get("TATER TOT CHA-AT") or next(o for o in objs if len(o["text"]) > 8)
    gone = by_text.get("BROCCOLI") or next(o for o in objs if o is not victim and " " not in o["text"])
    before = pymupdf.open(SRC)[0].get_text()
    print("edit %r -> %r · delete %r" % (victim["text"], "TATER TOT CHAAT", gone["text"]))

    # ---- exactly what src/canvas.js saves: [gi, patch] pairs and bare gi numbers
    payload = {
        "edits": [[victim["gi"], {"text": "TATER TOT CHAAT"}]],
        "deletes": [gone["gi"]],
        "adds": [],
        "images": [],
    }
    out, heads = post("/projects/" + slug + "/export", payload)
    ok(len(out) > 10000, "export returned a PDF", "%d bytes" % len(out))
    ok(heads.get("x-edits-applied") == "1", "the [gi, patch] edit was applied",
       heads.get("x-edits-applied"))
    ok(heads.get("x-deletes-applied") == "1", "the bare-gi delete was applied",
       heads.get("x-deletes-applied"))
    ok(heads.get("x-edits-refused") == "0", "nothing was silently refused",
       heads.get("x-edits-refused"))

    text = pymupdf.open(stream=out, filetype="pdf")[0].get_text()
    ok("TATER TOT CHAAT" in text, "edited text is in the PDF's text layer")
    ok(victim["text"] not in text, "the old string is gone",
       victim["text"])
    ok(text.count(gone["text"]) == before.count(gone["text"]) - 1, "deleted line is gone",
       "%d -> %d" % (before.count(gone["text"]), text.count(gone["text"])))

    if not os.environ.get("KEEP"):
        shutil.rmtree(os.path.join(ROOT, "projects", slug), ignore_errors=True)
        print("(removed the test project — KEEP=1 to inspect it)")
    else:
        print("kept at projects/" + slug)

    passed = sum(1 for c in checks if c)
    print("\n%s — %d/%d checks" % ("PASS" if passed == len(checks) else "FAIL",
                                   passed, len(checks)))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
