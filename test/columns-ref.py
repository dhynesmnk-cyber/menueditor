"""Find the column gutters in a menu image and emit per-column crop rects.
These rects are what the OCR pass will be handed, one column at a time.
"""
import json
import sys

import numpy as np
from PIL import Image


def analyze(path):
    img = Image.open(path).convert("RGB")
    W, H = img.size
    scale = min(1.0, 700.0 / max(W, H))
    small = img.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS)
    sw, sh = small.size
    arr = np.asarray(small).astype(np.float32)
    flat = arr.reshape(-1, 3)

    # paper = most common exact light colour
    flat8 = arr.astype(np.uint8).reshape(-1, 3)
    uniq, counts = np.unique(flat8, axis=0, return_counts=True)
    light = uniq.mean(axis=1) > 180
    paper = uniq[np.argmax(np.where(light, counts, 0))]
    paper = paper.astype(np.float32)

    mask = np.abs(arr - paper).sum(axis=2) > 55
    ys, xs = np.where(mask)
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    by0, by1 = int(ys.min()), int(ys.max()) + 1

    prof = mask[by0:by1, bx0:bx1].sum(axis=0).astype(np.float32)
    prof = np.convolve(prof, np.ones(3) / 3, mode="same")
    peak = prof.max() or 1
    empty = prof <= peak * 0.02

    runs, start = [], None
    for i, e in enumerate(empty):
        if e and start is None:
            start = i
        elif not e and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(empty)))

    width = bx1 - bx0
    wide = [(a, b) for a, b in runs if (b - a) > width * 0.035 and a > width * 0.02 and b < width * 0.98]
    wide.sort(key=lambda r: -(r[1] - r[0]))
    gutters = sorted(wide[:3])

    edges = [0] + [int((a + b) / 2) for a, b in gutters] + [width]
    rects = []
    for i in range(len(edges) - 1):
        x0 = bx0 + edges[i] + (3 if i else 0)
        x1 = bx0 + edges[i + 1] - (3 if i < len(edges) - 2 else 0)
        rects.append({
            "left": int(round(x0 / scale)), "top": int(round(by0 / scale)),
            "width": int(round((x1 - x0) / scale)), "height": int(round((by1 - by0) / scale)),
        })

    return {
        "file": path,
        "size": [W, H],
        "paper": "#%02X%02X%02X" % tuple(int(c) for c in paper),
        "content_bbox": [bx0, by0, bx1, by1],
        "gutters_px_small": gutters,
        "columns": len(rects),
        "rects": rects,
    }


if __name__ == "__main__":
    out = [analyze(p) for p in sys.argv[1:]]
    with open("out/gutters.json", "w") as fh:
        json.dump(out, fh, indent=1)
    for d in out:
        print(f"{d['file'].split('/')[-1]:<26} {d['columns']} column(s)  " +
              "  ".join(f"[{r['left']},{r['width']}]" for r in d["rects"]))
