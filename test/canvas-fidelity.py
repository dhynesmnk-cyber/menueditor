"""Compare the canvas-mode render against the source PDF at the same scale.

    .lines/bin/python test/canvas-fidelity.py out/canvas-shot.png ~/ela-menu/ela-a4-final-A.pdf

The canvas is supposed to be the page, not a re-creation of it, so this measures the
things that would betray a re-creation: a global offset, a width mismatch, or ink
that is lighter/heavier than the original.
"""
import sys

import numpy as np
import pymupdf
from PIL import Image

DPI = 144
# Pixel diff between a browser and MuPDF is dominated by antialiasing: half a pixel of
# rasterizer snapping on a 6pt glyph turns into a 30% pixel diff at 144 dpi. So the gates
# are alignment and ink mass (both stable), and the raw diff is reported, not gated.
LIMITS = {"offset_px": 1, "ink_ratio": (0.90, 1.10), "diff_pct_sanity": 40.0}


def render_pdf(path, dpi=DPI):
    doc = pymupdf.open(path)
    pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"))


def ink(arr):
    g = arr.mean(axis=2)
    return (g < 200)


def main(shot_path, pdf_path):
    ref = render_pdf(pdf_path)
    got = load_png(shot_path)
    h = min(ref.shape[0], got.shape[0])
    w = min(ref.shape[1], got.shape[1])
    ref, got = ref[:h, :w], got[:h, :w]

    best = None
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            a = ref[max(0, dy):h + min(0, dy), max(0, dx):w + min(0, dx)]
            b = got[max(0, -dy):h + min(0, -dy), max(0, -dx):w + min(0, -dx)]
            d = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)
            score = float((d > 32).mean())
            if best is None or score < best[0]:
                best = (score, dx, dy)
    score, dx, dy = best

    a = ref[max(0, dy):h + min(0, dy), max(0, dx):w + min(0, dx)]
    b = got[max(0, -dy):h + min(0, -dy), max(0, -dx):w + min(0, -dx)]
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)

    ia, ib = ink(a), ink(b)
    ink_a, ink_b = int(ia.sum()), int(ib.sum())
    ratio = ink_b / max(1, ink_a)

    # text zone: pixels where either render has ink, dilated a little by row/col density
    zone = ia | ib
    diff_pct = float((d[zone] > 32).mean() * 100) if zone.any() else 0.0

    print(f"canvas {got.shape[1]}x{got.shape[0]}px  vs  pdf {ref.shape[1]}x{ref.shape[0]}px at {DPI} dpi")
    print(f"best alignment       dx={dx} dy={dy}")
    print(f"pixels >32 in ink zone {diff_pct:.3f}%   mean|d|={float(d[zone].mean()):.2f}")
    print(f"ink mass             ref {ink_a}  canvas {ink_b}  ratio {ratio:.3f}")
    print(f"whole image >32      {score * 100:.3f}%")

    ok = True
    if abs(dx) > LIMITS["offset_px"] or abs(dy) > LIMITS["offset_px"]:
        print("FAIL alignment"); ok = False
    lo, hi = LIMITS["ink_ratio"]
    if not (lo <= ratio <= hi):
        print(f"FAIL ink ratio outside {lo}-{hi}"); ok = False
    if diff_pct > LIMITS["diff_pct_sanity"]:
        print(f"FAIL diff beyond sanity bound {LIMITS['diff_pct_sanity']}%"); ok = False
    print("PASS — aligned and the right amount of ink" if ok else "FAIL")
    print("(per-line placement is gated by test/canvas-lines.py; raw pixel diff here is")
    print(" dominated by browser-vs-MuPDF antialiasing and is informational)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "out/canvas-shot.png",
                  sys.argv[2] if len(sys.argv) > 2 else
                  "/home/dhynesmnk/ela-menu/ela-a4-final-A.pdf"))
