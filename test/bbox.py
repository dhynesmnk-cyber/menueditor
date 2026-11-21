"""Compare the ink bounding box of specific text runs in the screen render vs
the PDF render. Tells us whether a mismatch is horizontal (advance widths /
kerning) or vertical (baseline metric), and whether it scales with font size.
"""
import json
import numpy as np
from PIL import Image

screen = np.asarray(Image.open("out/screen.png").convert("L"), dtype=np.float32)
pdf = np.asarray(Image.open("out/pdf.png").convert("L"), dtype=np.float32)
SCALE = 2.0 * 72 / 72  # px per pt at 2x capture, zoom was ~2.216 px/pt
# actual px-per-pt derived from the pdf render zoom used in compare.py
PAGE_PT = 630.0
PX_PER_PT = screen.shape[1] / PAGE_PT
print(f"px per pt: {PX_PER_PT:.4f}")

with open("out/displaylist.json") as fh:
    dl = json.load(fh)

bleed = dl["page"]["bleed"] * 72

def bbox(img, x0, x1, y0, y1, name):
    sub = img[y0:y1, x0:x1]
    paper = np.percentile(sub, 95)
    ink = np.clip(paper - sub, 0, None)
    mask = ink > 25
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    w = ink[mask]
    return dict(name=name, top=y0 + ys.min(), bottom=y0 + ys.max(),
                left=x0 + xs.min(), right=x0 + xs.max(),
                cy=float((ys * w).sum() / w.sum()),   # ink centroid, robust to AA
                cx=float((xs * w).sum() / w.sum()),
                extent=float(ys.max() - ys.min()))

runs = [e for e in dl["displayList"] if e["k"] == "text"]
names = ["Larder & Vine", "Charred Sourdough", "from the fire", "First"]
targets = []
for e in runs:
    if e["t"] in ("Larder & Vine", "Charred Sourdough"):
        targets.append(e)
# a lowercase-heavy description line, to test x-height/baseline too
for e in runs:
    if e["t"].startswith("Cultured butter"):
        targets.append(e)
for e in runs:
    if e["t"].startswith("Dry-Aged"):
        targets.append(e)

print(f"\n{'run':34s} {'dx(pt)':>8s} {'dy(pt)':>8s} {'dw(pt)':>8s}  size")
for e in targets:
    # generous window around the engine's own idea of where this run is
    x_pt = e["x"] + bleed
    y_pt = e["baseline"] + bleed
    px = PX_PER_PT
    w_pt = 240
    box = (int(max(0, (x_pt - 6) * px)), int(min(screen.shape[1], (x_pt + w_pt) * px)),
           int(max(0, (y_pt - e["size"] * 1.6) * px)), int(min(screen.shape[0], (y_pt + e["size"] * 1.2) * px)))
    a = bbox(screen, box[0], box[1], box[2], box[3], e["t"])
    b = bbox(pdf, box[0], box[1], box[2], box[3], e["t"])
    if not a or not b:
        print(f"{e['t'][:34]:34s}  (no ink found)")
        continue
    dx = (b["left"] - a["left"]) / px
    dy = (b["top"] - a["top"]) / px
    dw = ((b["right"] - b["left"]) - (a["right"] - a["left"])) / px
    cdy = (b["cy"] - a["cy"]) / px
    cdx = (b["cx"] - a["cx"]) / px
    ext = (b["extent"] - a["extent"]) / px
    print(f"{e['t'][:34]:34s} {dx:+8.2f} {dy:+8.2f} {dw:+8.2f}  {e['size']:.1f}   "
          f"centroid dx {cdx:+6.2f} dy {cdy:+6.2f}  extent {ext:+5.2f}")
