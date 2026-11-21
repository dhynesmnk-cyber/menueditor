"""Zoom crops: stack the same region of the screen render over the PDF render
so leader dots, baselines and tracking can be judged at 1:1."""
import numpy as np
import pymupdf
from PIL import Image

screen = Image.open("out/screen.png").convert("RGB")
pdf = Image.open("out/pdf.png").convert("RGB")
W, H = screen.size

regions = {
    "title": (300, 230, 1100, 340),
    "item": (230, 500, 1200, 580),
    "section": (230, 640, 1200, 700),
}

for name, (x0, y0, x1, y1) in regions.items():
    a = screen.crop((x0, y0, x1, y1))
    b = pdf.crop((x0, y0, x1, y1))
    w, h = a.size
    combo = Image.new("RGB", (w, h * 2 + 8), (255, 0, 255))
    combo.paste(a, (0, 0))
    combo.paste(b, (0, h + 8))
    combo = combo.resize((w * 2, (h * 2 + 8) * 2), Image.NEAREST)
    out = f"out/zoom_{name}.png"
    combo.save(out)
    print(out, combo.size, "(top = screen, bottom = pdf)")
