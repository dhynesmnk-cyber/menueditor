"""Crop the artboard out of the browser screenshot and rasterise the PDF at the
same pixel scale, so the two images can be compared side by side and diffed."""
import json
import sys

import pymupdf
from PIL import Image

SHOT = "/home/dhynesmnk/.config/browser-harness/tmp/p-e26fa43a6582/shot.png"
rect = json.loads(sys.argv[1])   # [x, y, w, h] in CSS px
dpr = float(sys.argv[2])

img = Image.open(SHOT).convert("RGB")
print("screenshot:", img.size, "dpr", dpr)
scale = img.size[0] / 1600.0
box = (
    int(round(rect[0] * scale)), int(round(rect[1] * scale)),
    int(round((rect[0] + rect[2]) * scale)), int(round((rect[1] + rect[3]) * scale)),
)
crop = img.crop(box)
crop.save("out/screen.png")
print("artboard crop:", crop.size)

doc = pymupdf.open("out/menu.pdf")
page = doc[0]
zoom = crop.size[0] / page.rect.width
pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
pix.save("out/pdf.png")
pdf_img = Image.open("out/pdf.png").convert("RGB")
print("pdf render:", pdf_img.size, "zoom", round(zoom, 4))

# same size for the diff
if pdf_img.size != crop.size:
    pdf_img = pdf_img.resize(crop.size, Image.LANCZOS)
    pdf_img.save("out/pdf.png")

from PIL import ImageChops
diff = ImageChops.difference(crop, pdf_img)
import numpy as np
d = np.asarray(diff).astype("float32").mean(axis=2)
print(f"mean abs diff: {d.mean():.2f}/255   pixels >40: {(d > 40).mean()*100:.2f}%")

# where are the big differences?
rows = np.where((d > 40).sum(axis=1) > 3)[0]
cols = np.where((d > 40).sum(axis=0) > 3)[0]
if len(rows) and len(cols):
    print(f"diff bbox: x {cols.min()}-{cols.max()}  y {rows.min()}-{rows.max()} (of {crop.size[0]}x{crop.size[1]})")

# side-by-side + amplified diff for eyeballing
w, h = crop.size
combo = Image.new("RGB", (w * 2 + 20, h), (20, 16, 13))
combo.paste(crop, (0, 0))
combo.paste(pdf_img, (w + 20, 0))
combo.save("out/compare.png")
amp = ImageChops.multiply(diff, Image.new("RGB", diff.size, (4, 4, 4)))
amp.save("out/diff.png")
print("wrote out/compare.png, out/diff.png")
