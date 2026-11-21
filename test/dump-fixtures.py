"""Dump small raw-RGB fixtures of the reference menus so the JS design analyser
can be tested in node without a canvas or a browser.

160px wide keeps each fixture ~120-180 KB.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

WIDTH = 240
OUT = "test/fixtures"


def dump(path):
    img = Image.open(path).convert("RGB")
    w, h = img.size
    nh = max(1, round(h * WIDTH / w))
    small = img.resize((WIDTH, nh), Image.LANCZOS)
    name = os.path.basename(path).replace(" ", "-").replace("(", "").replace(")", "").replace(".png", "")
    raw = np.asarray(small, dtype=np.uint8).tobytes()
    with open(f"{OUT}/{name}.rgb", "wb") as fh:
        fh.write(raw)
    return {"name": name, "file": os.path.basename(path), "w": WIDTH, "h": nh,
            "source_size": [w, h]}


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    meta = [dump(p) for p in sys.argv[1:]]
    with open(f"{OUT}/index.json", "w") as fh:
        json.dump(meta, fh, indent=1)
    for m in meta:
        print(f"{m['name']:<34} {m['w']}x{m['h']}  from {m['source_size']}")
