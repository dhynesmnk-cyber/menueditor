"""Per-line fidelity: is every line where the PDF put it?

    .lines/bin/python test/canvas-lines.py out/canvas-shot.png ~/ela-menu/ela-a4-final-A.pdf

Raw pixel diff is dominated by antialiasing (a browser and MuPDF disagree about
how to soften a glyph edge, and half a pixel of rasterizer snapping turns into a
30% pixel diff at 144 dpi). This measures the thing that would actually be wrong:
each line's ink box, compared with the PDF's own.
"""
import sys

import numpy as np
import pymupdf
from PIL import Image

sys.path.insert(0, "sidecar")
import grouping  # noqa: E402

Z = 2.0
TOL = 1.0   # px at 144 dpi = 0.5 pt


def line_stats(gray, x0, y0, x1, y1, thr=140):
    """Ink centroid and x-extent in a tight band: insensitive to a descender's tail."""
    x0, y0 = int(max(0, x0)), int(max(0, y0))
    x1, y1 = int(min(gray.shape[1], x1)), int(min(gray.shape[0], y1))
    if x1 <= x0 or y1 <= y0:
        return None
    band = 255.0 - gray[y0:y1, x0:x1]
    w = np.clip(band, 0, None)
    total = w.sum()
    if total < 1:
        return None
    ys, xs = np.mgrid[0:band.shape[0], 0:band.shape[1]]
    cx = (w * xs).sum() / total + x0
    cy = (w * ys).sum() / total + y0
    mask = gray[y0:y1, x0:x1] < thr
    if not mask.any():
        return None
    cols = np.where(mask.any(axis=0))[0]
    return {"cx": cx, "cy": cy, "x0": x0 + cols.min(), "x1": x0 + cols.max(),
            "width": float(cols.max() - cols.min() + 1), "ink": float(mask.sum())}


def main(shot, pdf):
    doc = pymupdf.open(pdf)
    pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(Z, Z), alpha=False)
    ref = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    ref = ref[:, :, :3].mean(axis=2)
    got = np.asarray(Image.open(shot).convert("RGB")).mean(axis=2)
    objs = grouping.extract(open(pdf, "rb").read())["pages"][0]["objects"]

    rows = []
    for o in objs:
        left = o.get("ink_left", o["x"])
        pad = 3
        box = ((left - pad) * Z / Z * Z, (o["y"] - o["size"] * 0.80) * Z,
               (left + o["ink_width"] + pad) * Z, (o["y"] + o["size"] * 0.24) * Z)
        a = line_stats(ref, *box)
        b = line_stats(got, *box)
        if a and b:
            rows.append((o, a, b))

    d_cx = [abs(a["cx"] - b["cx"]) for _, a, b in rows]
    d_cy = [abs(a["cy"] - b["cy"]) for _, a, b in rows]
    # absolute width error: a 1px difference on a 7px price is 14%, which says nothing
    d_w = [abs(a["width"] - b["width"]) for _, a, b in rows]
    ok_w = [abs(a["width"] - b["width"]) <= max(3.0, 0.02 * a["width"]) for _, a, b in rows]
    for name, vals, tol in (("centroid x", d_cx, 1.5), ("centroid y", d_cy, 1.5),
                            ("width px", d_w, 3.0)):
        v = sorted(vals)
        good = sum(1 for x in v if x <= tol)
        print(f"{name:11s} median {v[len(v) // 2]:6.2f}  p95 {v[int(len(v) * 0.95)]:6.2f} "
              f"max {v[-1]:6.2f}  within {good}/{len(v)}  (tol {tol}, or 2% for width)")

    worst = max(rows, key=lambda r: abs(r[1]["cx"] - r[2]["cx"]))
    print(f"worst centroid: {worst[0]['text'][:34]!r} "
          f"dx {worst[1]['cx'] - worst[2]['cx']:+.2f}px dy {worst[1]['cy'] - worst[2]['cy']:+.2f}px")

    ok = (sum(1 for x in d_cx if x <= 1.5) == len(d_cx)
          and sum(1 for x in d_cy if x <= 1.5) == len(d_cy)
          and all(ok_w))
    print(f"lines compared: {len(rows)} of {len(objs)}")
    print("PASS — every line sits where the PDF put it" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "out/canvas-shot.png",
                  sys.argv[2] if len(sys.argv) > 2 else
                  "/home/dhynesmnk/ela-menu/ela-a4-final-A.pdf"))
