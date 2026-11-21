"""Measure real displacement between the screen render and the PDF render.

For each horizontal strip that contains ink, find the (dx, dy) shift that
maximises correlation between the two images. Antialiasing/hinting differences
average out; a systematic layout difference shows up as a non-zero shift.
"""
import numpy as np
import pymupdf
from PIL import Image

screen = np.asarray(Image.open("out/screen.png").convert("L"), dtype=np.float32)
pdf = np.asarray(Image.open("out/pdf.png").convert("L"), dtype=np.float32)

# ink maps: 1 where darker than the paper
def ink(a):
    return np.clip((a.max() - a) / (a.max() - a.min() + 1e-6), 0, 1)

S, P = ink(screen), ink(pdf)
print(f"images: screen {S.shape}, pdf {P.shape}")

rows = (S + P).sum(axis=1)
thresh = rows.max() * 0.06
bands, start = [], None
for y, v in enumerate(rows):
    if v > thresh and start is None:
        start = y
    elif v <= thresh and start is not None:
        if y - start > 6:
            bands.append((start, y))
        start = None

print(f"text bands found: {len(bands)}")

shifts = []
for (y0, y1) in bands:
    # a touch of margin so a shifted copy is still inside the window
    a0, a1 = max(0, y0 - 6), min(S.shape[0], y1 + 6)
    x0, x1 = 30, S.shape[1] - 30
    ref = S[a0:a1, x0:x1]
    if ref.sum() < 1:
        continue
    best, bdx, bdy = -1e9, 0, 0
    for dy in range(-6, 7):
        for dx in range(-4, 5):
            win = P[a0 + dy:a1 + dy, x0 + dx:x1 + dx]
            if win.shape != ref.shape:
                continue
            score = float((ref * win).sum())
            if score > best:
                best, bdx, bdy = score, dx, dy
    shifts.append((bdy, bdx, y0, y1))

dys = np.array([s[0] for s in shifts], dtype=float)
dxs = np.array([s[1] for s in shifts], dtype=float)
print("\nvertical shift (px @2x):   median %.2f  max |%.0f|" % (np.median(dys), np.abs(dys).max()))
print("horizontal shift (px @2x): median %.2f  max |%.0f|" % (np.median(dxs), np.abs(dxs).max()))
print("=> in points: max vertical drift %.2f pt, max horizontal drift %.2f pt"
      % (np.abs(dys).max() / 2, np.abs(dxs).max() / 2))

bad = [(y0, int(dy), int(dx)) for dy, dx, y0, y1 in shifts if abs(dy) > 1 or abs(dx) > 1]
if bad:
    print(f"\nbands with >0.5pt displacement: {len(bad)} of {len(shifts)}")
    for y0, dy, dx in bad[:8]:
        print(f"  band y={y0:5d}  dy={dy:+d}px dx={dx:+d}px")
else:
    print(f"\nall {len(shifts)} bands align within 0.5pt")
