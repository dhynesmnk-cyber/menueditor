"""Verify a project's newest export against its original.

    .lines/bin/python test/project-export.py [slug]

Checks the things a client would notice: the text they added is in the file, the
lines they deleted are gone, and nothing else on the sheet moved a pixel.
"""
import glob
import json
import os
import sys
import urllib.request

import pymupdf

BASE = os.environ.get("LINES_URL", "http://127.0.0.1:8793")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
PROJECTS = os.environ.get("MENU_PROJECTS") or os.path.join(ROOT, "projects")

checks = []


def ok(cond, label, detail=""):
    checks.append(bool(cond))
    print(("  ok   " if cond else "  FAIL ") + label + ((" — " + str(detail)) if detail else ""))


def get(path, binary=False):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        data = r.read()
    return data if binary else json.loads(data or b"{}")


def main():
    slug = sys.argv[1] if len(sys.argv) > 1 else None
    if not slug:
        listing = get("/projects")["projects"]
        if not listing:
            print("no projects")
            return 2
        slug = listing[0]["slug"]
    print("project:", slug)

    d = os.path.join(PROJECTS, slug)
    orig_path = os.path.join(d, "original.pdf")
    if not os.path.exists(orig_path):
        print("no original.pdf in", d)
        return 2

    proj = get("/projects/" + slug)
    work, lines = proj["work"], proj["lines"]

    # Export from the project's CURRENT edits on every run. Verifying the newest
    # file already in exports/ checks whatever happened to be exported last — which
    # is how a stale sheet carrying two extra test boxes passed as "the export".
    body = json.dumps({"edits": work.get("edits", []) or [],
                       "adds": work.get("adds", []) or [],
                       "deletes": work.get("deletes", []) or []}).encode()
    req = urllib.request.Request(BASE + "/projects/" + slug + "/export", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        pdf_bytes = r.read()
        heads = {k.lower(): v for k, v in r.headers.items()}
    tmp = os.path.join(ROOT, "out", "project-export-check.pdf")
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    with open(tmp, "wb") as fh:
        fh.write(pdf_bytes)
    print("export: fresh from the sidecar (%d KB)" % (len(pdf_bytes) // 1024))

    orig = pymupdf.open(orig_path)
    out = pymupdf.open(tmp)
    by_gi = {o["gi"]: o for p in lines["pages"] for o in p["objects"]}

    print("\n== the sidecar applied what it was sent ==")
    n_adds = len(work.get("adds", []) or [])
    n_dels = len(work.get("deletes", []) or [])
    ok(int(heads.get("x-adds-applied", -1)) == n_adds, "every add applied",
       "%s of %d" % (heads.get("x-adds-applied"), n_adds))
    ok(int(heads.get("x-deletes-applied", -1)) == n_dels, "every delete applied",
       "%s of %d" % (heads.get("x-deletes-applied"), n_dels))

    print("\n== the client's changes ==")
    ok(out.page_count == orig.page_count, "page count unchanged",
       "%d -> %d" % (orig.page_count, out.page_count))
    added = [a for a in work.get("adds", []) if a.get("text", "").strip()]
    text = "".join(page.get_text() for page in out)
    for a in added:
        ok(a["text"].split("—")[0].strip()[:14] in text, "added text present: %r" % a["text"][:28],
           a["font"])
    removed = [d2 for d2 in work.get("deletes", [])]
    removed = [r.get("gi") if isinstance(r, dict) else r for r in removed]
    before = "".join(page.get_text() for page in orig)
    for gi in removed:
        o = by_gi.get(int(gi))
        if not o:
            continue
        ok(text.count(o["text"]) == before.count(o["text"]) - 1,
           "deleted line gone: %r" % o["text"][:26],
           "%d -> %d" % (before.count(o["text"]), text.count(o["text"])))

    print("\n== nothing else moved ==")
    for pno in range(min(orig.page_count, out.page_count)):
        a = orig[pno].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
        b = out[pno].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
        pa, pb = memoryview(a.samples), memoryview(b.samples)
        touched = []
        for e in work.get("edits", []):
            # this client saves [gi, patch]; an older payload saved {gi, ...}
            gi = e[0] if isinstance(e, (list, tuple)) else (e or {}).get("gi")
            o = by_gi.get(int(gi)) if gi is not None else None
            if not o or o["page"] != pno:
                continue
            left = o.get("ink_left", o["x"])
            touched.append((left - 2, o["y"] - o["size"], left + o["ink_width"] + 12,
                            o["y"] + o["size"] * 0.4))
        for gi in removed:
            o = by_gi.get(int(gi))
            if not o or o["page"] != pno:
                continue
            left = o.get("ink_left", o["x"])
            touched.append((left - 2, o["y"] - o["size"], left + o["ink_width"] + 2,
                            o["y"] + o["size"] * 0.4))
        for ad in added:
            if int(ad.get("page", 0)) != pno:
                continue
            touched.append((ad["x"] - 3, ad["y"] - ad["size"] - 4,
                            ad["x"] + len(ad["text"]) * ad["size"] + 6, ad["y"] + 6))
        outside = 0
        for y in range(a.height):
            row = y * a.width
            for x in range(a.width):
                i = (row + x) * a.n
                if abs(pa[i] - pb[i]) > 40:
                    pt = (x / 2.0, y / 2.0)
                    if not any(r[0] <= pt[0] <= r[2] and r[1] <= pt[1] <= r[3] for r in touched):
                        outside += 1
        ok(outside == 0, "page %d: no pixel changed outside edits/adds/deletes" % (pno + 1),
           "%d px" % outside)

    passed = sum(1 for c in checks if c)
    print("\n%s — %d/%d checks" % ("PASS" if passed == len(checks) else "FAIL", passed, len(checks)))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
