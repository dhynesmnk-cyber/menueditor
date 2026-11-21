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

## Importing a real menu file

`Upload PDF / PNG` in the import dialog. The two file types do different jobs,
because they carry different information:

**PDF → copy.** A born-digital PDF contains the actual text with actual
coordinates, so nothing is guessed. `src/layout.js` rebuilds the reading order
from the word boxes: words into lines, lines split at wide gaps into segments,
segments clustered into columns by x-overlap. It also rejoins what extractors
shatter — letter-spaced headings arrive one character per box (`T O   B E G I N`),
and right-aligned prices land in their own x-cluster where a naive reader treats
them as a second column and detaches every price from its dish. On a test menu
this takes the PDF from 0 recovered dishes to **8 dishes in 3 sections with 8
descriptions**.

**PNG → copy and design.** With the local OCR sidecar running, an image yields
both: the text (through the same column reconstruction the PDF path uses) and the
palette, page shape and margins. The image stays available as a tracing underlay.
Without the sidecar the image still gives you the design read, so the feature
degrades rather than breaks.

### OCR engine choice, measured

The first attempt used tesseract in the browser. Measured on your three menus,
whole-page tesseract reads *across* columns and garbles names:

    SPRITZ ROYALE 18 HORS D'OEUVRES BRUNCH Almond Crotssont 7
    Fish Soup £800 Bestraot Carpaccio £600 Chicken Liars so 0

| pipeline | mean confidence | dishes recovered (Salt Room / Ralph & Finns / Pastis) |
|---|---|---|
| tesseract, whole page | 47–67% | 13 / 1 / 18 — mostly garbage concatenations |
| RapidOCR + layout reconstruction | **94–96%** | **22 / 21 / 66** — readable, with descriptions |

Two changes did it, and they were not the same change:

1. **A better engine.** RapidOCR runs the PaddleOCR detection/recognition models
   on onnxruntime — CPU, no PyTorch, ~100MB installed. Browsers have nothing
   comparable, so it runs as a local sidecar process rather than in the page.
2. **Reading order.** The engine returns line boxes, but it still reports them in
   its own order and prices still sit in their own x-cluster. `src/layout.js`
   rebuilds lines and columns, and a price is attached to the nearest dish line
   *within its own column* — without that last rule, a price from one column
   lands on the dish beside it.

Digits remain the weak spot (`8.50` can come back as `850`), which is why the
review pane asks you to confirm every price before it reaches the canvas.

### Running the OCR sidecar

    python3 -m venv .ocr
    .ocr/bin/pip install rapidocr-onnxruntime pillow
    .ocr/bin/python ocr/server.py          # http://127.0.0.1:8792

The app probes `/health` on upload; if nothing answers it falls back to the
design-only read and says so. Nothing else in the app requires the sidecar.

### What the design read actually extracts

| | |
|---|---|
| paper / ink | exact-colour mode of the page frame, darkest slice for ink |
| accents | saturated pixels binned by hue (exact-colour modes miss thin red rules) |
| page | nearest standard sheet by aspect, else the exact aspect at 11in long side |
| margins | 0.4-percentile ink edges, so a stray photo pixel cannot claim the trim |
| artwork border | edge-band variance vs the page interior (full-bleed florals) |

Verified on your three references: Ralph & Finns reads cream `#F6F3EC`, rust
`#A04D3F`, ochre, A5 portrait, artwork border yes; The Salt Room reads slate
`#596D7B`; Pastis reads `11 × 7.4in` custom landscape with navy `#416077` and
pink `#D691A3`. Column *count* is deliberately not guessed from pixels — rules,
boxes and watermarks fake gutters — it comes from word boxes instead.

## Verify it

    npm install                    # fflate, needed by jsPDF's node build
    npm test                       # parser corpus, design reads, e2e import, PDF

Individually:

    node test/parse.js             # 44 assertions over 9 real menu shapes
    node test/design.js            # palette/page/margins on the 3 reference menus
    node test/layout-test.js       # word boxes -> columns -> copy (PDF; OCR with a worker)
    node test/import-e2e.js        # paste -> blocks -> layout -> out/imported.pdf
    node test/fidelity.js          # demo menu -> out/menu.pdf
    python3 test/syntax.py         # inline script parses, ids and assets resolve
    .../python -I test/verify.py [pdf] [displaylist.json]   # glyph-level PDF check
    .../python -I test/dump-fixtures.py <menu.png ...>      # regenerate design fixtures

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

- **Section groups that reflow internally** when items are added, while the
  group's box stays where it was dropped. Today blocks are individually placed.
- Multi-page flow when a menu outgrows one sheet (the importer reports overflow
  but does not paginate).
- Font library + upload-your-own, web-link export, project file save/load.
- The OCR sidecar is a local process, not a hosted service; a deployed version
  needs the engine moved somewhere it can run (or a vision API).
- The file-upload UI is wired and statically checked, but was not clicked through
  in a browser: Chromium would not start on the build machine.

## Files

    index.html            editor UI, import review, screen renderer, fidelity readout
    ocr/server.py         local OCR sidecar (RapidOCR) — POST /ocr -> word boxes
    src/engine.js         layout engine (node + browser, UMD)
    src/import.js         menu-text parser (node + browser, UMD)
    src/layout.js         word boxes -> lines -> columns -> text
    src/design.js         palette / page / margins read from an image
    src/menu-model.js     document model, demo menu, parsed -> blocks builder
    src/pdf.js            PDF exporter — dumb consumer of the display list
    fonts/                Crimson Text + Lato, both SIL OFL 1.1 (see fonts/OFL-*.txt)
    vendor/               jsPDF 2.5.2, pdf.js 3.11 (umd + node + worker)
    test/                 parse corpus, design reads, layout, OCR bench, e2e, fidelity, fixtures
