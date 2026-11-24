"""Check an exported canvas PDF: only the edited lines may differ, page by page.

    .lines/bin/python test/canvas-export-check.py out/menu-canvas.pdf [original.pdf]

For every page it reports the box, how many lines changed, and the pixel difference
outside those lines. Exits non-zero if anything outside an edited line moved on any
page, or if the page count or a page box changed.
"""
import os
import sys

import numpy as np
import pymupdf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sidecar"))
import grouping  # noqa: E402

Z = 2.0
ORIGINAL = "/home/dhynesmnk/ela-menu/ela-a4-final-A.pdf"


def page_rgb(path, pno):
    doc = pymupdf.open(path)
    pix = doc[pno].get_pixmap(matrix=pymupdf.Matrix(Z, Z), alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    return arr[:, :, :3].astype(np.int16), doc[pno].rect


def mask_line(mask, o):
    left = o.get("ink_left", o["x"])
    x0, x1 = int((left - 3) * Z), int((left + o["ink_width"] * 2.2 + 3) * Z)
    y0, y1 = int((o["y"] - o["size"] * 1.3) * Z), int((o["y"] + o["size"] * 0.6) * Z)
    mask[max(0, y0):y1, max(0, x0):x1] = False


def main(exported, original=ORIGINAL):
    a_doc = pymupdf.open(original)
    b_doc = pymupdf.open(exported)
    print(f"pages {a_doc.page_count} -> {b_doc.page_count}, "
          f"{os.path.getsize(exported)//1024}K (original {os.path.getsize(original)//1024}K)")
    if a_doc.page_count != b_doc.page_count:
        print("FAIL page count changed")
        return 1

    pages = grouping.extract(open(original, "rb").read())["pages"]
    bad = 0
    for pno in range(a_doc.page_count):
        a, ra = page_rgb(original, pno)
        b, rb = page_rgb(exported, pno)
        if abs(ra.width - rb.width) > 0.01 or abs(ra.height - rb.height) > 0.01:
            print(f"page {pno + 1}: FAIL box {rb.width:.2f}x{rb.height:.2f} "
                  f"(was {ra.width:.2f}x{ra.height:.2f})")
            bad += 1
            continue

        h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
        d = np.abs(a[:h, :w] - b[:h, :w]).max(axis=2)

        changed = []
        for o in pages[pno]["objects"]:
            left = o.get("ink_left", o["x"])
            x0, x1 = int((left - 2) * Z), int((left + o["ink_width"] + 2) * Z)
            y0, y1 = int((o["y"] - o["size"] * 1.1) * Z), int((o["y"] + o["size"] * 0.5) * Z)
            band = d[max(0, y0):y1, max(0, x0):x1]
            if band.size and (band > 32).mean() > 0.02:
                changed.append(o)

        mask = np.ones((h, w), dtype=bool)
        for o in changed:
            mask_line(mask, o)
        # a replaced photo is a legal change: mask its rect too
        for r in pages[pno]["images"]:
            mask[max(0, int(r["y0"] * Z)):int(r["y1"] * Z),
                 max(0, int(r["x0"] * Z)):int(r["x1"] * Z)] = False
        outside = (d[mask] > 32).mean() * 100
        print(f"page {pno + 1}: {len(changed)} line(s) changed, {outside:.6f}% differs outside "
              f"them ({int((d[mask] > 32).sum())} px), {len(pages[pno]['images'])} image rect(s)")
        for o in changed[:6]:
            print(f"    changed: {o['text'][:40]!r}")
        if outside >= 0.01:
            bad += 1

    print("PASS — nothing moved outside the edited lines" if not bad else "FAIL")
    return 0 if not bad else 1


if __name__ == "__main__":
    args = sys.argv[1:]
    sys.exit(main(args[0] if args else "out/menu-canvas.pdf", args[1] if len(args) > 1 else ORIGINAL))
