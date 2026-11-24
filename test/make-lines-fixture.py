"""Regenerate test/fixtures/lines-ela.json from a real menu PDF.

    .lines/bin/python test/make-lines-fixture.py ~/ela-menu/ela-a4-final-A.pdf

The fixture is a slice of the sidecar's extraction: the lines that pin the three
encodings (tracked heading, letter-spaced heading, positional body copy), the
price/dish pairs, and every vector rule. Pinning it means a change to the grouping
algorithm shows up as a failing node test rather than a garbled page in a browser.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "sidecar"))

import grouping  # noqa: E402

WANT = [
    "REGIONAL INDIAN COOKING · MADE TO SHARE",
    "CHAAT / STREET SNACKS",
    "THE TASTING MENU",
    "THE BAR",
    "PANI PURI",
    "LOCAL MANGO SALAD",
    "romaine, radish, chickpeas, beet",
    "WINGS",
    "GF",
]


def main(pdf_path):
    data = grouping.extract(open(pdf_path, "rb").read())
    picked = []
    for o in data["pages"][0]["objects"]:
        if o["text"] in WANT and o["text"] not in [p["text"] for p in picked]:
            picked.append(o)
    # the price that sits beside LOCAL MANGO SALAD, and PANI PURI's own price
    for o in data["pages"][0]["objects"]:
        if o["text"] == "19" and abs(o["y"] - 259.58) < 1:
            picked.append(o)
        if o["text"] == "14" and abs(o["y"] - 148.87) < 1:
            picked.append(o)

    objects = []
    for i, o in enumerate(picked):
        q = dict(o)
        q["i"] = i
        objects.append(q)

    fixture = {
        "_note": "Slice of sidecar/grouping.py output; regenerate with test/make-lines-fixture.py",
        "page": {"width": data["pages"][0]["width"],
                 "height": data["pages"][0]["height"]},
        "vectors": data["pages"][0]["vectors"],
        "objects": objects,
    }
    out = os.path.join(HERE, "fixtures", "lines-ela.json")
    json.dump(fixture, open(out, "w"), indent=1)
    print(f"wrote {out}: {len(objects)} objects, {len(fixture['vectors'])} vectors")
    for o in objects:
        print(f"  {o['text'][:40]!r:44} x={o['x']:7.2f} y={o['y']:7.2f} "
              f"max={o['max_width']:7.2f} track={o['track_em']:+.3f}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/ela-menu/ela-a4-final-A.pdf"))
