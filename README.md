# Menu Studio — fidelity spike

A browser-only editor for text menus, and the one piece of it that decides
whether the product is trustworthy: **the PDF is drawn from the same layout
decisions as the screen.**

## The architectural rule

The browser is never allowed to wrap text.

`src/engine.js` owns every layout decision. It decomposes each block into a flat
**display list** of drawing primitives — text runs, leader dots, rules — in
PostScript points, origin at the trim top-left. Both renderers consume that list
and nothing else:

    menu model ──▶ engine.layout() ──▶ display list ──┬──▶ screen renderer (DOM, index.html)
                                                      └──▶ PDF exporter  (src/pdf.js, jsPDF)

One `<div>` per laid-out line means the screen shows exactly the lines the PDF
will print. Screen and PDF cannot disagree about a line break, because the
breaks are decided before either renderer runs.

## Run it

    cd menu-studio && python3 -m http.server 8791
    # open http://127.0.0.1:8791/index.html

No build step, no backend, no accounts. Fonts and jsPDF are vendored.

## Verify it

    npm install                                        # fflate, needed by jsPDF's node build
    node test/fidelity.js                              # model -> display list -> PDF
    ~/.hermes/cache/scratch/pdfenv/bin/python -I test/verify.py   # glyph-level PDF check

The fidelity test re-renders the menu and writes `out/menu.pdf` plus
`out/displaylist.json`, including the expected x position of **every glyph**.
`verify.py` reopens the PDF with pymupdf and asserts each glyph of that run sits
where the engine put it.

    PASS — 656 glyphs, 37 runs, geometry identical
      page size exact: 630.00 x 810.00 pt = 8.5x11 in trim + 0.125 in bleed
      embedded: MGaramond, MLato
      all 656 glyphs on target (max dx 0.120 pt)
      37 text runs, each a single ordered baseline
      content bottoms out at 9.902 in on a 11 in page (1.098 in bottom margin)

Screen-vs-PDF comparison (needs a browser capture in `out/screen.png`):

    .../python -I test/compare.py "[432.78, 74, 698.44, 898]" 2   # crop + raster + diff
    .../python -I test/vshift.py                                  # per-run sub-pixel shift
    .../python -I test/zoom.py                                    # 1:1 stacked crops

## Three bugs this spike exists to catch

1. **Kerning and ligatures.** Chrome applies them by default; jsPDF's advance
   model does not. Lines measured up to **1.81 pt wider in the PDF than on
   screen** — the classic "it fit in the editor, it reflowed at the printer"
   failure. Fixed by forcing `font-kerning: none` and
   `font-feature-settings: "kern" 0, "liga" 0, …`. Note: the CSS `font`
   shorthand silently resets both — set longhands only.
2. **The baseline model.** Canvas `fontBoundingBoxAscent` does **not** report
   the metrics Chrome uses for line boxes (0.833 em vs the TTF's 0.7993 em),
   which put the 40 pt title 1.34 pt low. The ratio is now parsed from the font's
   own `hhea` / `OS/2` tables, honouring `USE_TYPO_METRICS`.
3. **Measuring at the wrong scale.** A width self-check done at the current
   zoom reports pixel quantization, not fidelity. It now measures once at 1:1 in
   a detached layer.

## Current agreement

| | |
|---|---|
| PDF vs engine geometry | 0.12 pt max over 656 glyphs |
| Screen vs PDF run widths | 0.24 pt max over 37 runs (live, in the Fidelity panel) |
| Screen vs PDF whole page | mean pixel difference 3.05/255 |
| Screen vs PDF baselines | within ±1.3 pt, no size-proportional trend (rasterizer AA) |

Cosmetic residual: screen leader dots are CSS circles and render a shade
squarer than the PDF's vector circles. Same pitch, same start and stop.

## Fonts and licensing

The demo uses **Crimson Text** (display) and **Lato** (body), both SIL OFL 1.1,
so the repo is redistributable. The spike was originally built against the
Monotype Garamond shipped with Chrome OS; it was replaced because that face
cannot be redistributed in a public repo. Swapping faces means editing
`FONTS` in `src/menu-model.js` and the matching `@font-face` block in
`index.html` — nothing in the engine or exporter is font-specific, and the
baseline ratio is re-derived from whatever TTF is loaded.

## What is not built yet

- **Import** (step 2): paste-and-parse, plus PDF/DOCX/photo extraction.
- **Section groups that reflow internally** when items are added, while the
  group's box stays where it was dropped.
- Font library + upload-your-own (needed for the "unlimited fonts" answer).
- Web-link export, multi-page flow, project file save/load.

## Files

    index.html            editor UI, screen renderer, live fidelity readout
    src/engine.js         layout engine (node + browser, UMD)
    src/pdf.js            PDF exporter — dumb consumer of the display list
    src/menu-model.js     document model + demo menu (shared by app and tests)
    fonts/                Crimson Text + Lato, both SIL OFL 1.1 (see fonts/OFL-*.txt)
    vendor/               jsPDF 2.5.2 (umd + node)
    test/                 fidelity, verify, compare, vshift, bbox, zoom, fontmetrics
