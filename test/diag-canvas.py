import json

import numpy as np
import pymupdf
from PIL import Image

PDF = "/home/dhynesmnk/ela-menu/ela-a4-final-A.pdf"
doc = pymupdf.open(PDF)
pix = doc[0].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
ref = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
got = np.asarray(Image.open("/home/dhynesmnk/menu-studio/out/canvas-shot.png").convert("RGB"))
h, w = min(ref.shape[0], got.shape[0]), min(ref.shape[1], got.shape[1])
ref, got = ref[:h, :w], got[:h, :w]
d = np.abs(ref.astype(np.int16) - got.astype(np.int16)).max(axis=2)

print("rows with >2% differing:", int(((d > 32).mean(axis=1) > 0.02).sum()), "of", h)
print("cols with >2% differing:", int(((d > 32).mean(axis=0) > 0.02).sum()), "of", w)

# top band (header) crop
def stack(box, scale=2):
    y0, y1, x0, x1 = box
    a = Image.fromarray(ref[y0:y1, x0:x1])
    b = Image.fromarray(got[y0:y1, x0:x1])
    sheet = Image.new("RGB", (a.width, a.height * 2 + 10), "white")
    sheet.paste(a, (0, 0))
    sheet.paste(b, (0, a.height + 10))
    return sheet.resize((sheet.width * scale, sheet.height * scale), Image.LANCZOS)

stack((265, 335, 75, 640)).save("/home/dhynesmnk/menu-studio/out/canvas-compare.png")
print("wrote out/canvas-compare.png")

# where the ink sits: is the canvas shifted by a subpixel, or is it a different face?
print("first differing rows:", np.where((d > 32).mean(axis=1) > 0.02)[0][:12])

payload = json.load(open("/tmp/lines-resp.json"))
print("fonts in payload:", {k: (v["family"] if v else None) for k, v in payload["fonts"].items()})
spans = sorted({s["font"] for b in doc[0].get_text("dict")["blocks"] if b["type"] == 0
                for l in b["lines"] for s in l["spans"]})
print("fonts in pdf:", spans)
print("objects by font:", {f: sum(1 for o in payload["objects"] if o["font"] == f) for f in spans})
