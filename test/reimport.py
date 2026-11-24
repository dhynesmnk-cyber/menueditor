"""Version two of the menu arrives; the client's work has to survive it.

The designer re-sends the PDF. The client has already reworded lines, dropped an item and
added a note. Re-importing must keep every edit that still has a line to sit on, and must
say plainly which ones it could not place — never quietly forget them.

The fixture is a real revision: one price changed in place (same slot, new words), one dish
removed, one dish added, everything else untouched.

    .lines/bin/python test/reimport.py        (KEEP=1 to keep the project)
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


def ok(cond: bool, label: str, detail: object = "") -> None:
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


def blank(page, o):
    """Redact a line's box; the words go, the space stays."""
    pad = 1.0
    page.add_redact_annot(pymupdf.Rect(o["x"] - pad, o["y"] - o["size"] * 1.05,
                                       o["x"] + float(o.get("width") or 60) + pad,
                                       o["y"] + o["size"] * 0.32))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)


def main():
    if not os.path.exists(ELA):
        print("no source PDF at", ELA, "- set ELA_PDF")
        return 2
    with open(ELA, "rb") as fh:
        v1 = fh.read()

    # ---- the project, with the client's work on version one ----------------
    created, _ = post("/projects", {"name": "Revision Test",
                                    "pdf": base64.b64encode(v1).decode()})
    made = json.loads(created)
    slug = made["meta"]["slug"]
    objs = made["lines"]["pages"][0]["objects"]
    print("project:", slug)

    # A: the designer will change this price in place; the client renamed it too
    A = next(o for o in objs if o["text"].strip() == "PANI PURI")
    # B: the designer will delete this dish
    B = next(o for o in objs if o["text"].strip() == "BELL & EVANS CHILI")
    # C: untouched by the designer, edited by the client
    C = next(o for o in objs if o["text"].startswith("beet, chickpeas"))
    # D: deleted by the client, still in version two
    D = next(o for o in objs if o["text"].startswith("CHICKEN") and o["gi"] not in
             (A["gi"], B["gi"], C["gi"]))
    print("A %r  B %r  C %r  D %r" % (A["text"], B["text"], C["text"], D["text"]))

    work = {
        "edits": [[A["gi"], {"text": "PANI PURI 21"}],
                  [B["gi"], {"text": "GONE DISH 99"}],
                  [C["gi"], {"text": "CLIENT HEADLINE 12"}]],
        "deletes": [D["gi"]],
        "adds": [{"id": "n1", "page": 0, "text": "NOTE FROM THE CLIENT", "x": 60, "y": 780,
                  "size": 9, "track": 0, "font": "Lato Regular", "color": "#131a24"}],
        "images": [],
        "page_ops": {"new": [{"from": 0, "width": 595.28, "height": 841.89}], "delete": []},
    }
    post("/projects/" + slug + "/work", work)

    # ---- version two: one price changed in place, one dish gone, one added --
    doc = pymupdf.open(stream=v1, filetype="pdf")
    page = doc[0]
    blank(page, A)
    page.insert_text((A["x"], A["y"]), "PANI PURI 18", fontsize=float(A["size"]),
                     fontname="helv", color=(0, 0, 0))
    blank(page, B)
    page.insert_text((300, 90), "NEW DISH 25", fontsize=10, fontname="helv", color=(0, 0, 0))
    v2 = doc.tobytes(garbage=3, deflate=True)
    with open(os.path.join(ROOT, "out", "ela-v2.pdf"), "wb") as fh:
        fh.write(v2)
    print("version two: %d bytes" % len(v2))

    res, _ = post("/projects/" + slug + "/reimport", {"pdf": base64.b64encode(v2).decode()})
    out = json.loads(res)
    report = out["report"]
    print("summary:", out["summary"])
    print("orphaned:", [(o["gi"], o["text"]) for o in report["orphaned"]])

    ok(report["carried"] == 3, "three of the client's four touched lines were placed",
       "%d carried" % report["carried"])
    ok([o["gi"] for o in report["orphaned"]] == [B["gi"]],
       "the dish the designer removed is reported, not forgotten",
       [(o["gi"], o["text"]) for o in report["orphaned"]])

    fresh = get("/projects/" + slug)
    work2 = fresh["work"]
    texts = [e[1].get("text") for e in work2["edits"]]
    ok("PANI PURI 21" in texts, "the client's own price survives a designer price change", texts)
    ok("CLIENT HEADLINE 12" in texts, "an untouched line keeps its renamed text")
    ok("GONE DISH 99" not in texts, "the orphaned edit is not left pointing at nothing")
    ok(len(work2["deletes"]) == 1, "the client's deletion is still a deletion", work2["deletes"])
    ok(len(work2["adds"]) == 1 and len(work2["page_ops"]["new"]) == 1,
       "the added box and the copied sheet ride along",
       "%d adds, %d page ops" % (len(work2["adds"]), len(work2["page_ops"]["new"])))
    ok(fresh["meta"]["size"] == len(v2), "the project now holds version two",
       fresh["meta"]["size"])

    new_objs = fresh["lines"]["pages"][0]["objects"]
    ok(any("NEW DISH 25" in o["text"] for o in new_objs),
       "the designer's new dish is there to be priced")

    # ---- print it: the client's decisions, on the designer's new layout ----
    out2, heads = post("/projects/" + slug + "/export", work2)
    doc2 = pymupdf.open(stream=out2, filetype="pdf")
    page1 = " ".join(doc2[0].get_text().split())
    ok("PANI PURI 21" in page1, "the printed page carries the client's price",
       "PANI PURI 21" in page1)
    ok("NEW DISH 25" in page1, "and the designer's new dish")
    ok(D["text"].strip() not in page1, "the line the client deleted is gone")
    ok("CLIENT HEADLINE 12" in page1, "and their own heading is printed")
    ok(doc2.page_count == 2, "the copied sheet is still there", doc2.page_count)
    ok("NOTE FROM THE CLIENT" in " ".join(doc2[0].get_text().split()),
       "with the added box on the first sheet")

    if not os.environ.get("KEEP"):
        shutil.rmtree(os.path.join(ROOT, "projects", slug), ignore_errors=True)
        print("(removed the test project — KEEP=1 to inspect it)")

    passed = sum(1 for c in checks if c)
    print("\n%s — %d/%d checks" % ("PASS" if passed == len(checks) else "FAIL",
                                   passed, len(checks)))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
