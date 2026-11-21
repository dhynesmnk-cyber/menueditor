# Menu Studio

A browser-only editor for text menus. Two things it does that are worth the
trouble:

1. **The print PDF is drawn from the same layout decisions as the screen** —
   the browser is never allowed to wrap text, so a line cannot break differently
   in the editor and at the printer.
2. **An existing menu gets in by pasting it** — parsed into sections, dishes,
   descriptions, prices and dietary tags, with every price shown for review
   before anything reaches the canvas.

## The architectural rule

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

## Import

`Import` in the header opens a paste box. The parser (`src/import.js`) runs in
node and the browser, so the code under test is the code in the app.

What it understands:

| Input shape | Result |
|---|---|
| `Charred Sourdough ...... 9` | dish + price (leader dots, tabs, 2+ spaces, spaced dashes, `$`) |
| `Burrata (V, GF) .... 16` | brackets become dietary tags, not part of the name |
| `Cultured butter, smoked salt` | line after a dish becomes its description |
| `TO BEGIN` / `Small Plates:` / `Desserts` | section headings (caps, colons, known section words) |
| `Larder & Vine` + `Dinner Menu` | menu title and subtitle, before the first section |
| `(555) 213-8890`, `www.…` | routed to footnotes, never to dishes |
| `V vegetarian · GF gluten free` | section or document note |

**The price rule:** a line with a real separator (`….`, tab, dash, currency) is
high confidence. A bare `Tomato Soup 8` is imported but flagged as *assumed*,
and the warning says exactly which dish it guessed. Measurements are not prices
— `Dry-Aged Ribeye, 14oz .... 62` keeps `14oz` in the name and reads `62`.

The review pane lists every dish with an editable name and price field, colouring
the prices that were assumed, plus warnings for duplicates, sections with no
dishes, unusually high prices and lines that could not be classified. **Apply**
is disabled until something parsed, and it keeps your existing page size and
palette — an import never resets the design.

## Verify it

    npm install                    # fflate, needed by jsPDF's node build
    npm test                       # parser corpus + end-to-end import + PDF

Individually:

    node test/parse.js             # 44 assertions over 9 real menu shapes
    node test/import-e2e.js        # paste -> blocks -> layout -> out/imported.pdf
    node test/fidelity.js          # demo menu -> out/menu.pdf
    python3 test/syntax.py         # inline script parses, ids and assets resolve
    .../python -I test/verify.py [pdf] [displaylist.json]   # glyph-level PDF check

`fidelity.js` / `import-e2e.js` write a display list containing the expected x
position of **every glyph**; `verify.py` reopens the PDF with pymupdf and asserts
each glyph sits where the engine put it. Latest run:

    PASS — 656 glyphs, 37 runs, geometry identical          (demo menu)
    PASS — 558 glyphs, 29 runs, geometry identical          (7 dishes imported from pasted text)
      page size exact: 630.00 x 810.00 pt = 8.5x11 in trim + 0.125 in bleed
      embedded: MCrimson, MLato
      max drift 0.12–0.18 pt

Screen-vs-PDF comparison (needs a browser capture in `out/screen.png`):

    .../python -I test/compare.py "[432.78, 74, 698.44, 898]" 2   # crop + raster + diff
    .../python -I test/vshift.py                                  # per-run sub-pixel shift
    .../python -I test/zoom.py                                    # 1:1 stacked crops

`test/syntax.py` exists because a headless browser is not always available on
this box: it catches a broken inline script or a `getElementById` that points at
an element nobody wrote, which is the class of bug a click-through would find.

## Three fidelity bugs this hit, and their fixes

1. **Kerning and ligatures.** Chrome applies them by default; jsPDF's advance
   model does not. Lines measured up to **1.81 pt wider in the PDF than on
   screen** — the classic "it fit in the editor, it reflowed at the printer"
   failure. Fixed by forcing `font-kerning: none` and
   `font-feature-settings: "kern" 0, "liga" 0, …`. Note: the CSS `font`
   shorthand silently resets both — set longhands only.
2. **The baseline model.** Canvas `fontBoundingBoxAscent` does **not** report
   the metrics Chrome uses for line boxes (0.833 em vs the TTF's 0.7993 em),
   which put a 40 pt title 1.34 pt low. The ratio is now parsed from the font's
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
`index.html` — nothing in the engine, the importer or the exporter is
font-specific, and the baseline ratio is re-derived from whatever TTF loads.

## What is not built yet

- **File import**: `.docx`/`.pdf`/photo. Text extraction needs pdf.js (and
  tesseract for photos) — the paste path proves the parser first.
- **Section groups that reflow internally** when items are added, while the
  group's box stays where it was dropped. Today blocks are individually placed.
- Multi-page flow when a menu outgrows one sheet (the importer reports overflow
  but does not paginate).
- Font library + upload-your-own, web-link export, project file save/load.

## Files

    index.html            editor UI, import review, screen renderer, fidelity readout
    src/engine.js         layout engine (node + browser, UMD)
    src/import.js         menu-text parser (node + browser, UMD)
    src/menu-model.js     document model, demo menu, parsed -> blocks builder
    src/pdf.js            PDF exporter — dumb consumer of the display list
    fonts/                Crimson Text + Lato, both SIL OFL 1.1 (see fonts/OFL-*.txt)
    vendor/               jsPDF 2.5.2 (umd + node)
    test/                 parse corpus, import e2e, fidelity, verify, syntax, visual diffs
