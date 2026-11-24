"""A project whose sheet is a picture: the plate is the art, the layer on it is text.

A client who only has a PNG of their menu still has to be able to set prices on it. The
project stores the picture, the canvas shows it as the page, and the export builds a PDF of
the same size with the picture as the sheet and every added box drawn on top.

  - page size comes from the image's own pixel size at 150 dpi (aspect ratio exact);
  - the JPEG path reads its size from the header, not from a decoder;
  - sheet operations survive a save, or a reload resurrects a deleted page;
  - an untouched raster export is still a valid one-page PDF with the picture in it.

    .lines/bin/python test/image-project.py       (KEEP=1 to keep the projects)
"""
import base64
import json
import os
import shutil
import sys
import urllib.request

import pymupdf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
BASE = os.environ.get("LINES_URL", "http://127.0.0.1:8793")
ELA = os.environ.get("ELA_PDF", "/home/dhynesmnk/ela-menu/ela-a4-final-A.pdf")
checks = []


def ok(cond: bool, label: str, detail: object = "") -> bool:
    checks.append(bool(cond))
    print(("  ok   " if cond else "  FAIL ") + label + ((" — " + str(detail)) if detail else ""))


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read(), {k.lower(): v for k, v in r.headers.items()}


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=300) as r:
        return json.loads(r.read() or b"{}")


def main():
    if not os.path.exists(ELA):
        print("no source PDF at", ELA, "- set ELA_PDF")
        return 2
    # a designer's PNG: the page rendered at 150 dpi, so 1px = 0.48pt
    pix = pymupdf.open(ELA)[0].get_pixmap(matrix=pymupdf.Matrix(150 / 72.0, 150 / 72.0))
    png = pix.tobytes("png")
    px = (pix.width, pix.height)
    print("source image: %dx%d px (%.0f dpi render)" % (px[0], px[1], 150))

    created, _ = post("/projects", {"name": "Raster Sheet",
                                    "image": base64.b64encode(png).decode(),
                                    "filename": "sheet.png"})
    slug = json.loads(created)["meta"]["slug"]
    j = json.loads(created)
    print("project:", slug)
    ok(j["meta"].get("kind") == "image", "the project knows it is a raster sheet",
       j["meta"].get("kind"))
    page = j["lines"]["pages"][0]
    ok(len(j["lines"]["pages"]) == 1, "a picture is one page", len(j["lines"]["pages"]))
    ok(page.get("kind") == "raster", "the page says it is a raster sheet", page.get("kind"))
    ok(bool(page.get("plate", "").startswith("data:image/png")), "the plate is the picture")
    ok(not page.get("objects"), "a picture arrives with no line objects to edit",
       len(page.get("objects") or []))

    want_w = px[0] * 72.0 / 150.0
    want_h = px[1] * 72.0 / 150.0
    ok(abs(page["width"] - want_w) < 0.6 and abs(page["height"] - want_h) < 0.6,
       "the sheet is the picture at 150 dpi", "%.1fx%.1f pt (want %.1fx%.1f)"
       % (page["width"], page["height"], want_w, want_h))
    ok(abs(page["width"] / page["height"] - px[0] / px[1]) < 0.01,
       "the aspect ratio is the picture's own")

    opened = get("/projects/" + slug)
    ok(bool(opened.get("fonts")), "a raster project gets a face to type in",
       [f.get("family") for f in opened.get("fonts") or []])
    family = (opened.get("fonts") or [{}])[0].get("family") or "Lato"

    # ---- an added box lands on the picture --------------------------------
    work = {"edits": [], "images": [], "deletes": [],
            "adds": [{"id": "a1", "page": 0, "text": "RASTER MARK 42",
                      "x": 60, "y": 200, "size": 18, "track": 0,
                      "font": family, "color": "#c81e1e"}],
            "page_ops": {"new": [], "delete": []}}
    out, heads = post("/projects/" + slug + "/export", work)
    ok(heads.get("x-adds-applied") == "1", "the box was drawn",
       "%s applied, %s refused" % (heads.get("x-adds-applied"), heads.get("x-edits-refused")))
    doc = pymupdf.open(stream=out, filetype="pdf")
    ok(doc.page_count == 1, "the export is one page", doc.page_count)
    ok(abs(doc[0].rect.width - page["width"]) < 1 and abs(doc[0].rect.height - page["height"]) < 1,
       "the export keeps the picture's page size",
       "%.0fx%.0f" % (doc[0].rect.width, doc[0].rect.height))
    ok("RASTER MARK 42" in doc[0].get_text(), "the box is in the text layer")
    ok(len(doc[0].get_images(full=True)) >= 1, "the picture is in the export",
       len(doc[0].get_images(full=True)))

    # ---- sheet operations must survive a save -----------------------------
    post("/projects/" + slug + "/work",
         {"adds": work["adds"], "edits": [], "images": [], "deletes": [],
          "page_ops": {"new": [{"from": 0, "width": page["width"], "height": page["height"]}],
                       "delete": []}})
    again = get("/projects/" + slug)
    kept = (again.get("work") or {}).get("page_ops") or {}
    ok(len(kept.get("new") or []) == 1, "a saved sheet operation comes back on reopen",
       json.dumps(kept))

    # ---- an untouched raster export is still a document --------------------
    out2, heads2 = post("/projects/" + slug + "/export",
                        {"edits": [], "images": [], "adds": [], "deletes": [],
                         "page_ops": {"new": [], "delete": []}})
    doc2 = pymupdf.open(stream=out2, filetype="pdf")
    ok(doc2.page_count == 1 and len(doc2[0].get_images(full=True)) >= 1,
       "an untouched export is the picture as a one-page PDF",
       "%d pages, %d images" % (doc2.page_count, len(doc2[0].get_images(full=True))))

    # ---- JPEG: size from the header, not a decoder -------------------------
    jpg = pix.tobytes("jpg")
    res, _ = post("/projects", {"name": "Raster JPEG",
                                "image": base64.b64encode(jpg).decode(),
                                "filename": "sheet.jpg"})
    jj = json.loads(res)
    jpage = jj["lines"]["pages"][0]
    ok(jj["meta"].get("kind") == "image" and bool(jpage["plate"].startswith("data:image/jpeg")),
       "a JPEG sheet is accepted", jj["meta"].get("kind"))
    ok(abs(jpage["width"] - want_w) < 0.6, "its size comes from the JPEG header",
       "%.1f pt (want %.1f)" % (jpage["width"], want_w))

    if not os.environ.get("KEEP"):
        for s in (slug, jj["meta"]["slug"]):
            shutil.rmtree(os.path.join(ROOT, "projects", s), ignore_errors=True)
        print("(removed the test projects — KEEP=1 to inspect them)")

    passed = sum(1 for c in checks if c)
    print("\n%s — %d/%d checks" % ("PASS" if passed == len(checks) else "FAIL",
                                   passed, len(checks)))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
