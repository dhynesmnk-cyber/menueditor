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

## Interface theme

The chrome is white, silver and blue: `--panel #ffffff`, `--chrome #f2f5f9`,
`--line #dbe2ec`, `--text #131a24`, `--dim #667485`, `--accent #2f6fed`. Those six
variables are the whole palette; changing the look means changing them and the few
shades derived from them (button faces, hover states, the paper shadow), not the
layout, which lives outside the design system in `src/design.js`.

The **document's** colours are separate and deliberately untouched: `--paper`,
`--ink` and `--accent` swatches in the left rail are the menu's own palette, and the
sheet on the stage renders in those colours. Retheming the app must never change what
prints.

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

## The workspace — a menu is a folder, not a tab

A menu arrives from a designer and stays in use for months. So a menu is a project
on disk, not state in a browser:

    projects/<slug>/
        original.pdf     what the designer sent — never overwritten
        objects.json     the extracted line objects, cached (re-open is instant)
        edits.json       text edits, deletions, added boxes, image swaps
        fonts/           font files added through the Fonts button
        exports/         the twelve most recent PDFs
        meta.json        name, pages, timestamps

`Keep layout` opens the project list (`GET /projects`); "New from file…" turns a
PDF into a project (`POST /projects`), which extracts the lines once and keeps them.
Every change autosaves to `edits.json` 700 ms later, so closing the tab or reloading
cannot cost work — the failure mode that used to lose an imported menu.

Each project is self-contained: copy the folder to back it up, hand it back to the
designer, or move it to another machine. `MENU_PROJECTS` overrides where they live.

### What a client can do inside a menu

| action | how | what the exporter does |
|---|---|---|
| reword a line | click it, type, Enter | redacts that line's ink, redraws the glyphs at the same origin with tracking preserved |
| move a line | drag it | same rewrite at the new baseline; refused if it would land on other text, a rule or the page edge |
| **add a text box** | `＋ Text`, then type | `insert_font` + `subset_fonts`, drawn glyph-at-a-time so tracking is honest — no slot to fit, but the font must resolve |
| **delete a line** | click it, `Delete` (or the button) | redaction only: the ink goes, everything else on the page is untouched. Click the ghost to bring it back |
| **load a font** | `Fonts`, pick a .ttf/.otf | stored in the project, served back for `@font-face`, and used for export — the client's new line prints in the face the designer shipped |
| restyle a new box | font / size / colour row | values travel with the box and are applied at export |
| swap a photo | click the dashed image slot | old pixels removed from that rect, new file fitted inside |
| export | `Export PDF` | splices only what changed, writes a copy into `exports/` |

Every one of those is one of four exporter operations — `edits`, `deletes`, `adds`,
`images` — applied per page. A page with nothing on it is never rewritten.

### What it is checked against

`npm run test:workspace` exercises the workspace against a real menu: project
creation, cached objects, byte-identical original, font upload and read-back, then an
export with one edit, one delete and one added box. It asserts from the PDF itself —
the added string is in the text layer at the requested coordinates, the deleted string
count dropped by exactly one, and **no pixel outside the touched boxes changed**
(0 px). `npm run test:project` runs the same comparison against a project's newest
export, including its saved work.

## Canvas mode — keep the page, edit its words

`Keep layout` in the header opens a PDF without rebuilding it. This is the opposite
trade to Import: Import produces a menu the engine can lay out (new sections, new
dishes, pagination), Canvas keeps the designer's page and only rewrites what you
touch.

The PDF goes to a local sidecar (`sidecar/lines_server.py`, pymupdf) which returns
one editable object per visual line with the page's own glyph positions, plus the
art plate (the page with its text removed) and the font files. An untouched line is
redrawn glyph-for-glyph where the original put it; only an edited line becomes a
string, and the export splices it into the original content stream.

    npm run canvas        # .lines/bin/python sidecar/lines_server.py  (port 8793)
    npm start             # python3 -m http.server 8791

Three text encodings have to be handled, and a real menu mixes them: positional
(word gaps exist only as advances — `NOTCURRIES`), literal (space glyphs), and
letter-spaced headings (one space glyph between *every* letter, `R E G I O N A L`).
`sidecar/grouping.py` decides per line from the token shape — never from gap width,
because a space glyph's own advance makes letter and word gaps measure the same.

The guards live in `src/lines.js` (pure, unit-tested) and `src/canvas.js` (the DOM
layer):

| Rule | Behaviour |
|---|---|
| fit | a longer string shrinks at most 8% to fit its own slot, then refuses |
| squeeze | `Shift+Enter` explicitly allows 60% |
| growth cap | `max_width = min(next text/rule, ink x 3 + 12)` — a `GF` legend cannot become a sentence |
| drop | a dragged line may not land on another line, on a rule, or off the page |
| snap | to other lines' baselines and left edges, within 2.5 pt |
| undo / persist | `⌘Z` (60 deep); the edit set survives a reload via localStorage |
| photo | click a placed image to replace it: the old pixels in that rect are removed, the new file is fitted inside |
| fit / zoom | opens at fit-width (never above 100%, so the raster plate stays sharp), with `− 100% +`; the percentage button cycles fit width → fit page → 100% |

The page is an SVG sized by a single scale factor, so a small window shows the whole
sheet instead of a clipped corner: at 980x620 an A4 page opens at 77%, and fit-page is
31%. Pointer distances are divided by `2 * scale`, so dragging and the inline input stay
exact at any zoom (verified: an 80 px drag at 31% moves the line 95.669 pt, expected
95.67). Scrolling is native — the overlay scrolls on wheel over the page.

Every page of the document is imported and stacked, and edits carry a document-wide
object id, so a change on page 3 lands on page 3 and the other sheets are never
touched. Faces are chosen by measurement, not by name: for each PDF font the
candidate whose advance width best matches the document's own text wins, sampled from
an untracked line (a letter-spaced heading's ink is wider than any natural advance,
which would pick the heaviest cut available), and a name with no weight in it prefers
a Regular file.

Measured on the ELA menu (217 lines, 595x842 pt): every line lands within 1.5 px of
the PDF at 144 dpi (median 0.11 px across, 0.32 px down), and an export of three
edits changes **0 px outside those three lines** — page box, fonts and every other
glyph untouched. On a three-page document an edit on page 2 changed only page 2, with
0 px differing elsewhere on any page; a replaced logo removed the original artwork
with no ghosting. `test/canvas-lines.py` and `test/canvas-export-check.py` are the
gates; `test/lines.js` pins the grouping output the guards rely on.

Raw pixel diff is *not* a gate: a browser and MuPDF disagree about antialiasing, so
half a pixel of rasterizer snapping shows up as a 30% pixel diff on 6 pt type. Judge
placement per line, not per pixel.

### On a phone

The canvas is built for a touch screen of 390 px as much as a 1280 px laptop, and the
layout is not a shrunken desktop:

| At | Studio page | Editor bar | Editing a line |
|---|---|---|---|
| ≤900 px | one column: the sheet, then Blocks and Inspector as scrollable sections under it | five controls at 44 px (undo, redo, More, Export, Close); the other twelve in a sheet on the bottom edge, 48 px each | tap selects, a 44 px grip above the line moves it, two fingers pinch to zoom |
| >900 px | three columns, unchanged | one dense toolbar (two wrapped rows at 1280) | the in-place field, as before |

Editing goes through a bottom drawer on a small screen: a 16 px field (below 16 px iOS
zooms the whole page on focus, and the keyboard would cover an in-place field that is
8 px at fit-width), font/size/colour, and Done at 48 px. It drives the same editing
state and the same 8% fit rule as the desktop field, so there is one commit path.

The drawer carries the verdict the bar's status line is too far away to give: *fits the
slot (160 of 168 pt)*, *fitted 94% to fit the slot*, or *too long by 100 pt — Done will
refuse it* in red, announced with `aria-live`. And because a fixed panel sits on the
layout viewport's bottom edge — behind the keyboard on a phone — the drawer docks to
`visualViewport`, rising by `innerHeight - height - offsetTop` and capping its own height
to the visible area (scrolling inside when the keyboard leaves less room than it needs).

A finger never drags a line directly — that gesture is scroll, and the browser cancels
the pointer mid-move. It scrolls; a tap selects; the grip moves. `pointercancel` throws
the in-flight move away instead of half-committing it.

The page opens on **your menus**, not on the studio: a list of projects, each with the name
you gave it and a `⋯` menu to rename or delete it. Rename only touches the label; delete removes
the project's folder (the original PDF, the work and the exports together), and it arms on the
first tap and acts on the second. `New from file…` adds another menu. Closing the list leaves you
in the studio, which is where a menu is designed from scratch.

Serving it to a phone that is not this machine:

    LINES_HOST=0.0.0.0 npm run canvas     # sidecar answers on the network
    npm run serve:lan                     # static files too
    http://<this-machine's-ip>:8791/      # open on the phone

The page calls the sidecar on whatever host served it (`location.hostname`, port 8793),
so nothing is hardcoded to localhost; `window.LINES_SERVICE` overrides it. The sidecar
has **no authentication** — while it is bound to the network, anything that can route to
the port can read and edit every project. Use it on a network you trust and bind it back
to loopback afterwards. On ChromeOS the container's address is not on the Wi-Fi: forward
ports 8791 and 8793 to Linux (Settings → Developers → Linux → Port forwarding) and use
the Chromebook's own address.

When the phone is not on the same network there is one host to reach, not two:

    npm run serve:proxy                   # :8795 = files + /projects,/splice,/health,/reimport
    ngrok http 8795                       # one tunnel, one origin
    https://<that-host>/index.html?svc=same

Exports are set in the face the PDF itself names. A family found on this machine or in `fonts/`
is used from that file; a base-14 name (Helvetica, Times, Courier, Symbol, ZapfDingbats) is drawn
by name, which is the same face and needs no file. Any other face that is not installed is a
**refusal** — `font not installed: <face>` — never a substitute, because the words would be right
and the typeface wrong.

`?svc=same` tells the page the sidecar is its own origin, which is how a single tunnel can
carry both; `?svc=https://elsewhere:8793` points it somewhere else instead, and the default
is still the host it was served from. Free ngrok shows a one-tap "Visit Site" notice — a
page header of `ngrok-skip-browser-warning` skips it for scripts.

**A tunnel is a public door.** The sidecar has no authentication and the proxy adds none:
anyone with the URL can list, edit and export every project, and the tunnel is up until
the process is killed. Use it for a preview, then stop it.

Verified at 390x844, 360x740, 768x1024, 1280x800 and 1920x1080 with `npm run test:mobile`
(136 checks: no sideways scroll, one row of controls with the status on its own line, 44 px
targets, no clipped labels, every button named, the sheet on the bottom edge, a 16 px
focused drawer field that says when the text is too long, a drawer that rides above a
stubbed keyboard and comes back down, a nudge that moves a line a point and is one undo,
an arrow key that does the same, a duplicate page whose armed delete needs a second tap and
two undos to unwind, an edit that reaches the server, a grip that moves a line, a pinch that
changes the zoom, and the desktop toolbar one row at 1920 with More below 1760).

Measured rather than assumed: mounting the 217-line page costs 104–193 ms on a desktop
CPU, and a 40-frame grip drag runs at 16.7 ms median / 18.1 ms max — one frame each, no
long frames — so the per-glyph renderer stays. A plate-raster mode is the fallback if a
real phone measures worse.

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

## The reasoning layer

The template is not a fixed stack. `src/planner.js` decides, per import, where
each section goes and what an item looks like inside it.

**The grid comes from the reference.** `src/layout.js` finds the reference's
columns by projecting every text box onto the x-axis and keeping the bands
between the gutters — the method that survives centred headings (which defeat
left-edge clustering) and full-width rules. Those bands become the template's
columns, normalised to the page. A Pastis reference genuinely resolves to four
zones (`62–285`, `314–661`, `697–1038`, `1083–1287` pt), so a restaurant dropping
that image in gets four columns, not one.

**Sections are packed, never reordered.** Section order is editorial, so the
packer only moves whole sections to the next column, balancing by measured
height. Reading order is asserted in the test: sorting the placed sections by
`(col, y)` must reproduce the source order exactly.

**Fitting is a search, in the order a designer works.** Same grid and smaller
type first (down to 0.75×), and only then an extra column. Every plan reports
`overflowIn` and `fits`, so the app can say "this needs a second page" instead of
quietly running off the sheet.

**Item pattern is inferred from the content**, not assumed: whether a section has
descriptions, whether its names are all-caps, whether prices are leader-dotted or
right-aligned in a column. A wine list and a cocktail list are not the same
template, even on the same page.

**Pagination.** When the content still will not fit at the type floor and with an
extra column, it goes onto a second sheet rather than off the trim. The planner
measures with the engine's own `layoutBlock`, so a planned page and a rendered
page are the same page (measured: page bottoms 6.33in and 6.31in against a 6.6in
limit), and `src/pdf.js` writes one PDF page per sheet.

### Three content patterns that broke the first import

All three came from the real Pastis text, and none of them is exotic — they are
how designed menus are set.

| pattern | before | now |
|---|---|---|
| `verre 17 / bottle 80` on its own line | became a dish called "verre" | attaches to the wine above it |
| `CRÉMANT DE BOURGOGNE NV` (caps, price below) | became a *section heading* | becomes a dish; only `SPARKLING ROSÉ` above another wine name is a heading |
| `Homemade Granola yogurt, fresh strawberries ... 12` | name kept the description | splits at the case boundary: name `Homemade Granola`, desc `yogurt, fresh strawberries` |

The splitter requires a two-word head and stops at particles (`de`, `du`, `au`,
`with`…), so `Salt cod fritters`, `Steak Frites` and `Poulet au Vin Jaune` are
left alone. The 44-check paste corpus is the regression gate for it.

Verified: 126 checks across five suites.

## Dragging

`pointermove` used to call `relayout()`, which lays out the whole document and
rebuilds every DOM node. On a 100-dish menu that is **417 primitives + 106 overlay
divs + 106 sidebar buttons** destroyed and recreated — plus a 311-run width
re-measure — for every mouse event, to move one block a few pixels.

A drag now moves pixels. Each primitive carries the id of the block that drew it
(`engine.layout`), `drawSheet` indexes the created nodes by that id, and pointer
movement sets one `transform` per primitive of the dragged block, coalesced to one
per animation frame. The document is re-laid-out **once, on pointer release**.

Measured on the same 100-dish menu: **4 transforms + 1 overlay per frame**, instead
of 629 nodes rebuilt.

The index is only built when the created nodes are 1:1 with the display list; if
they are not, dragging falls back to a full relayout rather than moving the wrong
pixels. `test/block-index.js` asserts the invariants that index depends on: every
primitive carries its block id, every id belongs to a real block, a block's
primitives stay contiguous, and moving a block does not change the primitive count.
Held arrow keys coalesce through `requestRelayout()` for the same reason.

## Verify it

    npm install                    # fflate, needed by jsPDF's node build
    npm test                       # parser corpus, design reads, e2e import, PDF

Individually:

    node test/parse.js             # 44 assertions over 9 real menu shapes
    node test/parse-inline.js      # price-only lines, caps dishes, inline descriptions
    node test/design.js            # palette/page/margins on the 3 reference menus
    node test/planner.js           # reference grid -> plan -> placed blocks
    node test/pagination.js        # dense menu -> 2 sheets -> 2-page PDF
    node test/block-index.js       # display list -> DOM index invariants (drag path)
    node test/layout-test.js       # word boxes -> columns -> copy (PDF; OCR with a worker)
    node test/import-e2e.js        # paste -> blocks -> layout -> out/imported.pdf
    node test/fidelity.js          # demo menu -> out/menu.pdf
    python3 test/syntax.py         # inline script parses, ids and assets resolve
    node test/mobile.js            # the app at 390x844, 360x740, 768x1024, 1280x800 (needs both servers)
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
