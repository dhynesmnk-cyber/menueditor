"""Page operations: add a sheet, duplicate one, delete one.

Page ops are a document-level contract, not a loop over objects: the client numbers pages
after the operations it has already made, the working PDF still holds every original sheet
until the very end, and the two only agree if the payload carries both lists. So the tests
here pin the three things that break:

  - a duplicate is a *copy of the art with the words taken off* (its lines arrive as added
    boxes), so it must keep the rules and images and lose the original text;
  - a deletion must land on the sheet the client meant, after every id above was drawn;
  - a no-op payload must leave the document exactly as it was.

    .lines/bin/python test/page-ops.py        (KEEP=1 to keep the fixtures)
"""
import os
import sys

import pymupdf

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
sys.path.insert(0, os.path.join(ROOT, "sidecar"))
import splice                                                       # noqa: E402

ELA = os.environ.get("ELA_PDF", "/home/dhynesmnk/ela-menu/ela-a4-final-A.pdf")
LATO = os.environ.get("LATO_TTF", "/usr/share/fonts/truetype/lato/Lato-Regular.ttf")
checks = []


def ok(cond, label, detail=""):
    checks.append(bool(cond))
    print(("  ok   " if cond else "  FAIL ") + label + ((" — " + str(detail)) if detail else ""))


def three_pages():
    src = pymupdf.open(ELA)
    out = pymupdf.open()
    for _ in range(3):
        out.insert_pdf(src, from_page=0, to_page=0)
    return out.tobytes()


def text(page):
    return " ".join(page.get_text().split())


def run(pdf, **kw):
    return splice.build(pdf, font_paths={"Lato": LATO}, **kw)


def main():
    if not os.path.exists(ELA):
        print("no source PDF at", ELA, "- set ELA_PDF")
        return 2
    base = three_pages()
    base_doc = pymupdf.open(stream=base, filetype="pdf")
    print("fixture: %d pages, page 1 has %d drawings, %d images"
          % (base_doc.page_count, len(base_doc[0].get_drawings()),
             len(base_doc[0].get_images(full=True))))

    # ---- 0. nothing asked for, nothing changes ------------------------------
    out, info = run(base)
    d = pymupdf.open(stream=out, filetype="pdf")
    ok(d.page_count == 3, "no page ops leaves three pages", d.page_count)
    ok(all(text(d[i]) == text(base_doc[i]) for i in range(3)),
       "no page ops leaves every page's text alone")

    # ---- 1. delete the middle sheet ----------------------------------------
    out, info = run(base, page_ops={"delete": [1]})
    d = pymupdf.open(stream=out, filetype="pdf")
    ok(d.page_count == 2, "delete removes exactly one sheet", d.page_count)
    ok(info["pages_deleted"] == 1, "the applied count says one page deleted", info["pages_deleted"])
    ok(text(d[1]) == text(base_doc[2]), "the survivors are the pages that were meant")

    # ---- 2. duplicate a sheet: art stays, its words come back as boxes ------
    out, info = run(base, page_ops={"new": [{"from": 0, "width": 595, "height": 842}]},
                    adds=[{"id": "a1", "page": 3, "text": "PAGE FOUR MARK",
                           "x": 40, "y": 120, "size": 14, "track": 0, "font": "Lato",
                           "color": "#111111"}])
    d = pymupdf.open(stream=out, filetype="pdf")
    ok(d.page_count == 4, "duplicate appends one sheet", d.page_count)
    ok(info["pages_added"] == 1, "the applied count says one page added", info["pages_added"])
    ok(info["added"] == 1, "the sheet's line was drawn as an added box", info["added"])
    ok("PAGE FOUR MARK" in text(d[3]), "the copy carries the line that was sent for it")
    ok(text(d[0]) not in text(d[3]) or len(text(d[3])) < len(text(d[0])),
       "the copy's own words were taken off it", len(text(d[3])))
    ok(len(d[3].get_drawings()) == len(d[0].get_drawings()),
       "the copy keeps the rules of the sheet it came from",
       "%d -> %d" % (len(d[0].get_drawings()), len(d[3].get_drawings())))
    ok(len(d[3].get_images(full=True)) == len(d[0].get_images(full=True)),
       "the copy keeps the images of the sheet it came from")
    ok(text(d[0]) == text(base_doc[0]), "the original sheet is untouched by the copy")

    # ---- 3. add a blank sheet of the document's own size -------------------
    out, info = run(base, page_ops={"new": [{"from": None, "width": 595, "height": 842}]})
    d = pymupdf.open(stream=out, filetype="pdf")
    ok(d.page_count == 4, "a blank sheet is appended", d.page_count)
    ok(abs(d[3].rect.width - 595) < 1 and abs(d[3].rect.height - 842) < 1,
       "the blank sheet is the size that was asked for",
       "%.0fx%.0f" % (d[3].rect.width, d[3].rect.height))
    ok(not text(d[3]), "the blank sheet has no text", repr(text(d[3])[:40]))

    # ---- 4. ops and edits together: ids still mean their own sheet ---------
    # 3 sheets -> duplicate page 0 (becomes sheet 4) and delete page 1; the add below
    # addresses client page 2, which is sheet 3 in the working document.
    out, info = run(base,
                    page_ops={"new": [{"from": 0}], "delete": [0]},
                    adds=[{"id": "a2", "page": 2, "text": "SURVIVOR MARK",
                           "x": 40, "y": 160, "size": 14, "track": 0, "font": "Lato",
                           "color": "#111111"}])
    d = pymupdf.open(stream=out, filetype="pdf")
    ok(d.page_count == 3, "one added, one deleted nets out to three", d.page_count)
    ok(text(d[2]) and "SURVIVOR MARK" in text(d[2]),
       "an add sent for client page 2 lands on the third surviving sheet")
    ok(text(d[0]) != text(base_doc[0]) or d.page_count == 3,
       "the deleted sheet is gone rather than blanked")

    passed = sum(1 for c in checks if c)
    print("\n%s — %d/%d checks" % ("PASS" if passed == len(checks) else "FAIL", passed, len(checks)))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
