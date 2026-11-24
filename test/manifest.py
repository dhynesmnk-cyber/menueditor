"""The designer's manifest: who may change what, enforced by the exporter.

A studio ships a menu with rules — this heading is the brand's, the client may set prices
and nothing else. The rules are a plain JSON file in the project. The canvas greys out what
it must, but a stale tab (or a hand-made request) still has to be refused by the exporter,
otherwise "locked" is decoration.

  - a lock by id and a lock by the words on the line both resolve to the same set;
  - an edit to a locked line is refused and the page still prints the designer's words;
  - an unlocked line on the same page still exports;
  - deleting a locked line is refused;
  - allow.pageOps=false drops sheet operations, allow.addText=false refuses boxes;
  - allow.restyle=false keeps the face and colour but still allows changing the price.

    .lines/bin/python test/manifest.py       (KEEP=1 to keep the project)
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


def text_of(pdf_bytes):
    return " ".join(pymupdf.open(stream=pdf_bytes, filetype="pdf")[0].get_text().split())


def main():
    if not os.path.exists(ELA):
        print("no source PDF at", ELA, "- set ELA_PDF")
        return 2
    with open(ELA, "rb") as fh:
        pdf = fh.read()

    created, _ = post("/projects", {"name": "Manifest Rules",
                                    "pdf": base64.b64encode(pdf).decode()})
    made = json.loads(created)
    slug = made["meta"]["slug"]
    print("project:", slug)
    objs = made["lines"]["pages"][0]["objects"]
    # one line to lock by its words, one by its id, one left free
    by_text = next(o for o in objs if "PANI PURI" in o["text"])
    by_id = next(o for o in objs if o is not by_text and len(o["text"]) > 6)
    free = next(o for o in objs if o["gi"] not in (by_text["gi"], by_id["gi"]) and len(o["text"]) > 4)
    print("locked by words: %r (gi %d)" % (by_text["text"], by_text["gi"]))
    print("locked by id:    %r (gi %d)" % (by_id["text"], by_id["gi"]))
    print("free:            %r (gi %d)" % (free["text"], free["gi"]))

    saved, _ = post("/projects/" + slug + "/manifest",
                    {"note": "Prices only, please.",
                     "lock": {"lines": [by_id["gi"]], "text": ["PANI PURI"], "pages": []},
                     "allow": {"pageOps": False, "addText": False, "restyle": False,
                               "deleteLines": True}})
    m = json.loads(saved)
    ok(m["lock"]["lines"] == [by_id["gi"]] and m["lock"]["text"] == ["PANI PURI"],
       "the manifest keeps its locks", json.dumps(m["lock"]))
    ok(m["allow"]["pageOps"] is False and m["allow"]["restyle"] is False,
       "and its permissions", json.dumps(m["allow"]))
    ok(get("/projects/" + slug).get("manifest", {}).get("note") == "Prices only, please.",
       "it comes back with the project")

    # ---- a locked line cannot be reworded ---------------------------------
    out, heads = post("/projects/" + slug + "/export",
                      {"edits": [[by_text["gi"], {"text": "LOCKED WAS HERE"}],
                                 [free["gi"], {"text": "FREE EDIT 99"}]],
                       "deletes": [], "adds": [], "images": [],
                       "page_ops": {"new": [], "delete": []}})
    ok(heads.get("x-edits-applied") == "1", "the unlocked edit still applies",
       "%s applied" % heads.get("x-edits-applied"))
    ok(heads.get("x-edits-refused") == "1", "the locked edit is refused, not skipped",
       "%s refused" % heads.get("x-edits-refused"))
    t = text_of(out)
    ok("LOCKED WAS HERE" not in t and "PANI PURI" in t,
       "the designer's words are still on the page")
    ok("FREE EDIT 99" in t and free["text"] not in t,
       "and the client's price change went through")

    # ---- a locked line cannot be deleted ----------------------------------
    out2, heads2 = post("/projects/" + slug + "/export",
                        {"edits": [], "deletes": [{"gi": by_id["gi"]}], "adds": [], "images": [],
                         "page_ops": {"new": [], "delete": []}})
    ok(heads2.get("x-deletes-applied") == "0" and heads2.get("x-edits-refused") == "1",
       "deleting a locked line is refused",
       "applied %s, refused %s" % (heads2.get("x-deletes-applied"),
                                   heads2.get("x-edits-refused")))
    ok(by_id["text"] in text_of(out2), "the line is still printed")

    # ---- allow.pageOps = false -------------------------------------------
    out3, heads3 = post("/projects/" + slug + "/export",
                        {"edits": [], "deletes": [], "adds": [], "images": [],
                         "page_ops": {"new": [{"from": 0}], "delete": []}})
    ok(heads3.get("x-pages-added") == "0", "a sheet operation is refused when pages are locked",
       heads3.get("x-pages-added"))
    ok(pymupdf.open(stream=out3, filetype="pdf").page_count == 1,
       "and the document keeps its page count")

    # ---- allow.addText = false -------------------------------------------
    out4, heads4 = post("/projects/" + slug + "/export",
                        {"edits": [], "deletes": [], "images": [], "page_ops": {"new": [], "delete": []},
                         "adds": [{"id": "x1", "page": 0, "text": "NEW BOX", "x": 60, "y": 300,
                                   "size": 14, "font": "Lato Regular", "track": 0,
                                   "color": "#111111"}]})
    ok(heads4.get("x-adds-applied") == "0", "adding text is refused when the manifest forbids it",
       heads4.get("x-adds-applied"))
    ok("NEW BOX" not in text_of(out4), "the box is not in the PDF")

    # ---- allow.restyle = false: the price may change, the face may not ----
    post("/projects/" + slug + "/manifest",
         {"lock": {"lines": [], "text": [], "pages": []},
          "allow": {"pageOps": True, "addText": True, "restyle": False, "deleteLines": True}})
    out5, heads5 = post("/projects/" + slug + "/export",
                        {"edits": [[free["gi"], {"font": "Lato Regular", "color": "#c81e1e"}]],
                         "deletes": [], "adds": [], "images": [], "page_ops": {"new": [], "delete": []}})
    doc5 = pymupdf.open(stream=out5, filetype="pdf")
    spans = [s for b in doc5[0].get_text("dict")["blocks"] for ln in b.get("lines", [])
             for s in ln["spans"] if s["text"].strip() == free["text"].strip()]
    # the original ink, read from the designer's own file — not "black" by assumption
    src_spans = [s for b in pymupdf.open(ELA)[0].get_text("dict")["blocks"]
                 for ln in b.get("lines", []) for s in ln["spans"]
                 if s["text"].strip() == free["text"].strip()]
    orig = src_spans[0]["color"] if src_spans else None
    ok(bool(spans) and bool(src_spans) and all(s["color"] == orig for s in spans)
       and all(s["color"] != 0xC81E1E for s in spans),
       "a style change is dropped when the manifest says so",
       "printed %s, original %s" % (", ".join("#%06x" % s["color"] for s in spans[:3]),
                                    "#%06x" % orig if orig is not None else "-"))

    if not os.environ.get("KEEP"):
        shutil.rmtree(os.path.join(ROOT, "projects", slug), ignore_errors=True)
        print("(removed the test project — KEEP=1 to inspect it)")

    passed = sum(1 for c in checks if c)
    print("\n%s — %d/%d checks" % ("PASS" if passed == len(checks) else "FAIL",
                                   passed, len(checks)))
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
