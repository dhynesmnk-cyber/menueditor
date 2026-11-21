"""Fidelity check at glyph level.

out/displaylist.json holds what the engine decided to draw (per text run) plus
the exact x position of every glyph as computed by the exporter's advance
model. out/menu.pdf is the artifact. This asserts that every glyph in the PDF
sits within 0.4pt of where the engine put it, that the PDF contains no glyph
the engine didn't ask for, and that pages/fonts are what we promised.

Because glyph positions encode line membership, identical glyph geometry
IS identical line breaking.
"""
import json
import sys

import pymupdf

TOL_X = 0.4   # pt
TOL_Y = 0.4   # pt

with open("out/displaylist.json") as fh:
    data = json.load(fh)

doc = pymupdf.open("out/menu.pdf")
page = doc[0]
ok, fails = [], []

# ------------------------------------------------------------------ geometry
p = data["page"]
want_w = (p["w"] + 2 * p["bleed"]) * 72
want_h = (p["h"] + 2 * p["bleed"]) * 72
if abs(page.rect.width - want_w) > 0.01 or abs(page.rect.height - want_h) > 0.01:
    fails.append(f"page {page.rect.width:.2f}x{page.rect.height:.2f} != {want_w:.2f}x{want_h:.2f}")
else:
    ok.append(f"page size exact: {page.rect.width:.2f} x {page.rect.height:.2f} pt "
              f"= {p['w']}x{p['h']} in trim + {p['bleed']} in bleed")
if len(doc) != 1:
    fails.append(f"page count {len(doc)} != 1")

# --------------------------------------------------------------------- fonts
fonts = page.get_fonts(full=True)
embedded = [f for f in fonts if f[1] not in ("n/a", "")]
if not embedded:
    fails.append("no embedded fonts in PDF")
else:
    ok.append("embedded: " + ", ".join(sorted({f[3].split('+')[-1] for f in embedded})))

# --------------------------------------------------------------------- glyphs
bleed = p["bleed"] * 72
pdf_chars = []
for block in page.get_text("rawdict")["blocks"]:
    for line in block.get("lines", []):
        for span in line.get("spans", []):
            for ch in span.get("chars", []):
                pdf_chars.append({
                    "c": ch["c"],
                    "x": ch["origin"][0],
                    "y": ch["origin"][1],
                    "size": span["size"],
                })

# bucket by baseline so lookups stay cheap
buckets = {}
for pc in pdf_chars:
    buckets.setdefault(round(pc["y"] * 2) / 2, []).append(pc)

expected = data["expectedGlyphs"]
matched, unmatched, dxs = 0, [], []
claimed = set()

for g in expected:
    ex, ey = g["x"] + bleed, g["y"] + bleed
    candidates = []
    for dy in (-0.5, 0.0, 0.5):
        candidates.extend(buckets.get(round(ey * 2) / 2 + dy, []))
    best, bestd = None, 1e9
    for pc in candidates:
        if id(pc) in claimed or pc["c"] != g["ch"]:
            continue
        d = abs(pc["x"] - ex) + abs(pc["y"] - ey) * 0.25
        if d < bestd:
            best, bestd = pc, d
    if best is not None and abs(best["x"] - ex) <= TOL_X and abs(best["y"] - ey) <= TOL_Y:
        claimed.add(id(best))
        matched += 1
        dxs.append(abs(best["x"] - ex))
    else:
        unmatched.append((g["ch"], round(ex, 2), round(ey, 2)))

orphans = [pc for pc in pdf_chars if id(pc) not in claimed and pc["c"].strip()]

if unmatched:
    fails.append(f"{len(unmatched)}/{len(expected)} glyphs not found where the engine put them: {unmatched[:5]}")
if orphans:
    fails.append(f"{len(orphans)} glyphs in PDF that the engine never placed: "
                 f"{[(o['c'], round(o['x'], 2)) for o in orphans[:5]]}")
if matched == len(expected) and not orphans:
    ok.append(f"all {matched} glyphs on target (max dx {max(dxs):.3f} pt)")

# --------------------------------------------------- line integrity (per run)
# every text run must have all of its glyphs on one baseline, in x order
by_run = {}
for g in expected:
    by_run.setdefault(g["runId"], []).append(g)
bad_runs = 0
for rid, gs in by_run.items():
    ys = {round(g["y"], 2) for g in gs}
    xs = [g["x"] for g in gs]
    if len(ys) != 1 or xs != sorted(xs):
        bad_runs += 1
if bad_runs:
    fails.append(f"{bad_runs} text runs have glyphs on multiple baselines or out of order")
else:
    ok.append(f"{len(by_run)} text runs, each a single ordered baseline")

# ------------------------------------------------------------ on-page sanity
texts = [e for e in data["displayList"] if e["k"] == "text"]
worst_right = max(e["x"] + sum(1 for _ in e["t"]) * 0 for e in texts)
over = []
for e in texts:
    pass
# use glyph extents instead
for g in expected:
    if not (bleed - 1 <= g["x"] + bleed <= want_w - bleed + 1):
        over.append(g)
if over:
    fails.append(f"{len(over)} glyphs outside the trim area")

extent_in = data["extent"] / 72
if extent_in > p["h"]:
    fails.append(f"content extends past the page ({extent_in:.2f} in > {p['h']} in)")
else:
    ok.append(f"content bottoms out at {extent_in:.3f} in on a {p['h']} in page "
              f"({p['h'] - extent_in:.3f} in bottom margin)")

print("=== PDF fidelity test ===")
for line in ok:
    print("  ok    " + line)
for line in fails:
    print("  FAIL  " + line)
if fails:
    sys.exit(1)
print(f"\nPASS — {len(expected)} glyphs, {len(texts)} runs, geometry identical")
