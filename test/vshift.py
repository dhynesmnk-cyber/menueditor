"""Clean vertical alignment measurement.

Restricts each measurement to an isolated text run (excluding dot leaders by
using the engine's own run width) and finds the sub-pixel vertical shift by
parabola-fitting the cross-correlation of the ink row profiles.
"""
import json
import numpy as np
from PIL import Image

screen = np.asarray(Image.open("out/screen.png").convert("L"), dtype=np.float32)
pdf = np.asarray(Image.open("out/pdf.png").convert("L"), dtype=np.float32)
PX = screen.shape[1] / 630.0
print(f"px per pt {PX:.4f}  ({screen.shape[1]}x{screen.shape[0]})")

dl = json.load(open("out/displaylist.json"))
bleed = dl["page"]["bleed"] * 72
runs = {e["t"]: e for e in dl["displayList"] if e["k"] == "text"}

def profile(img, x0, x1, y0, y1):
    sub = img[int(y0):int(y1), int(x0):int(x1)]
    paper = np.percentile(sub, 95)
    ink = np.clip(paper - sub, 0, None)
    return ink.sum(axis=1)

def shift_of(txt, name_w_guess=None):
    e = runs.get(txt)
    if not e:
        return None
    x_pt = e["x"] + bleed
    y_pt = e["baseline"] + bleed
    w_pt = name_w_guess if name_w_guess else len(txt) * e["size"] * 0.5
    x0, x1 = (x_pt - 3) * PX, (x_pt + w_pt + 3) * PX
    y0, y1 = (y_pt - e["size"] * 2) * PX, (y_pt + e["size"] * 1.3) * PX
    a = profile(screen, x0, x1, y0, y1)
    best, bdy = -1e18, 0
    scores = {}
    for dy in range(-8, 9):
        b = profile(pdf, x0, x1, y0 + dy, y1 + dy)
        if len(b) != len(a):
            continue
        s = float((a * b).sum())
        scores[dy] = s
        if s > best:
            best, bdy = s, dy
    # parabola fit for sub-pixel
    if bdy - 1 in scores and bdy + 1 in scores:
        y0c, y1c, y2c = scores[bdy - 1], scores[bdy], scores[bdy + 1]
        denom = (y0c - 2 * y1c + y2c)
        sub = 0.5 * (y0c - y2c) / denom if denom else 0
    else:
        sub = 0
    return (bdy + sub) / PX  # in pt, positive = pdf lower

print(f"\n{'run':38s} {'size':>5s} {'dy pt':>7s} {'dy/em':>7s}")
for txt, guess in [("Larder & Vine", 250), ("Dinner  ·  Tuesday to Sunday", 200),
                   ("TO BEGIN", 90), ("Charred Sourdough", 100),
                   ("Cultured butter, smoked salt, first-press olive oil", 220),
                   ("Dry-Aged Ribeye, 14oz", 130)]:
    s = shift_of(txt, guess)
    if s is None:
        print(f"{txt[:38]:38s}   (not found)")
        continue
    e = runs[txt]
    print(f"{txt[:38]:38s} {e['size']:5.1f} {s:+7.2f} {s/e['size']:+7.4f}")
