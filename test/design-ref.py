"""Reference implementation of the design analyser, run against real menu
images. src/design.js mirrors these steps; this script is how the JS numbers
get validated on actual menus rather than synthetic fixtures.

Two lessons baked in:
  * full-bleed photography (Ralph & Finns' botanical border) wrecks a naive
    palette and margin read, so the measurement region is inset and the border
    is detected separately;
  * box rules and table borders read as column gaps, so a gap must be wide and
    genuinely empty to count.
"""
import json
import sys
from collections import Counter

import numpy as np
from PIL import Image


def hexc(rgb):
    return "#%02X%02X%02X" % tuple(int(round(c)) for c in rgb)


def lum(rgb):
    r, g, b = [c / 255.0 for c in rgb[:3]]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def saturation(rgb):
    r, g, b = [c / 255.0 for c in rgb[:3]]
    mx, mn = max(r, g, b), min(r, g, b)
    return 0.0 if mx == 0 else (mx - mn) / mx


def merge_colors(px, radius=26, limit=600):
    """Exact-colour frequency, merged in RGB space."""
    counts = Counter(map(tuple, px.astype(np.uint8)))
    total = sum(counts.values())
    merged = []
    for rgb, n in counts.most_common(limit):
        for m in merged:
            if sum(abs(int(a) - int(b)) for a, b in zip(rgb, m["rgb"])) < radius * 3:
                m["n"] += n
                break
        else:
            merged.append({"rgb": tuple(int(c) for c in rgb), "n": n})
    for m in merged:
        m["share"] = m["n"] / total
    merged.sort(key=lambda m: -m["n"])
    return merged


def analyze(path):
    img = Image.open(path).convert("RGB")
    W, H = img.size
    scale = min(1.0, 700.0 / max(W, H))
    small = img.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS)
    sw, sh = small.size
    arr = np.asarray(small).astype(np.float32)

    # ---- does the page run full-bleed artwork at the edges?
    edge = np.concatenate([
        arr[:2].reshape(-1, 3), arr[-2:].reshape(-1, 3),
        arr[:, :2].reshape(-1, 3), arr[:, -2:].reshape(-1, 3),
    ])
    inner = arr[int(sh * .2):int(sh * .8), int(sw * .2):int(sw * .8)].reshape(-1, 3)
    edge_std = float(edge.std(axis=0).mean())
    inner_std = float(inner.std(axis=0).mean())
    has_photo_border = edge_std > inner_std * 1.6 and edge_std > 18

    # ---- measurement region: inset when artwork surrounds the page
    inset = 0.10 if has_photo_border else 0.05
    x0, x1 = int(sw * inset), int(sw * (1 - inset))
    y0, y1 = int(sh * inset), int(sh * (1 - inset))
    region = arr[y0:y1, x0:x1]
    rpx = region.reshape(-1, 3)

    merged = merge_colors(rpx)

    lights = [m for m in merged if lum(m["rgb"]) > 0.60 and m["share"] > 0.02]
    paper = max(lights, key=lambda m: m["share"]) if lights else merged[0]

    # ink: average of the darkest slice — robust against thin text and accents
    L = np.array([lum(p) for p in rpx])
    dark = rpx[L <= np.percentile(L, 0.4)]
    ink_rgb = dark.mean(axis=0) if len(dark) else np.array([20, 20, 20])

    accents = [m for m in merged
               if saturation(m["rgb"]) > 0.26 and m["share"] > 0.0005
               and m is not paper
               and lum(m["rgb"]) < 0.75]
    accents.sort(key=lambda m: -(m["share"] * (0.5 + saturation(m["rgb"]))))

    # ---- content bbox for margins, measured against the paper colour
    p = np.array(paper["rgb"], dtype=np.float32)
    diff = np.abs(arr - p).sum(axis=2)
    mask = diff > 55
    if has_photo_border:
        mask[:, :int(sw * inset)] = False
        mask[:, int(sw * (1 - inset)):] = False
        mask[:int(sh * inset), :] = False
        mask[int(sh * (1 - inset)):, :] = False
    ys, xs = np.where(mask)
    margins = ({"left": xs.min() / sw, "right": 1 - (xs.max() + 1) / sw,
                "top": ys.min() / sh, "bottom": 1 - (ys.max() + 1) / sh}
               if len(xs) else {"left": 0, "right": 0, "top": 0, "bottom": 0})

    # ---- columns from the vertical ink profile inside the region
    rmask = mask[y0:y1, x0:x1]
    prof = rmask.sum(axis=0).astype(np.float32)
    prof = np.convolve(prof, np.ones(3) / 3, mode="same")
    peak = prof.max() or 1
    empty = prof <= peak * 0.02
    gaps, run = [], None
    for i, e in enumerate(empty):
        if e and run is None:
            run = i
        elif not e and run is not None:
            gaps.append((run, i))
            run = None
    if run is not None:
        gaps.append((run, len(empty)))
    wide = [(a, b) for a, b in gaps if (b - a) > (x1 - x0) * 0.035 and a > 0 and b < len(empty)]
    columns = min(4, len(wide) + 1)

    # ---- body type size: most common ink band height, weighted by ink volume
    rowprof = rmask.sum(axis=1)
    bands, inb, start = [], False, 0
    for i, v in enumerate(rowprof):
        if v > rowprof.max() * 0.015 and not inb:
            inb, start = True, i
        elif v <= rowprof.max() * 0.015 and inb:
            bands.append((i - start, rowprof[start:i].sum()))
            inb = False
    maxh = sh * 0.05
    hist = Counter()
    for h, weight in bands:
        if 2 <= h <= maxh:
            hist[h] += weight
    body_px = max(hist.items(), key=lambda kv: kv[1])[0] if hist else 0

    return {
        "file": path.split("/")[-1],
        "size_px": [W, H],
        "aspect": round(W / H, 3),
        "has_photo_border": has_photo_border,
        "paper": hexc(paper["rgb"]),
        "paper_share": round(paper["share"], 3),
        "ink": hexc(ink_rgb),
        "accents": [hexc(m["rgb"]) for m in accents[:3]],
        "margins_pct": {k: round(v * 100, 1) for k, v in margins.items()},
        "columns": columns,
        "body_px": body_px,
        "body_pct": round(body_px / sh * 100, 2),
        "palette_top": [{"hex": hexc(m["rgb"]), "share": round(m["share"], 3)} for m in merged[:4]],
    }


if __name__ == "__main__":
    print(json.dumps([analyze(p) for p in sys.argv[1:]], indent=1))
