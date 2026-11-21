# Menu Studio — content correctness + pagination

## Goal

An imported, reference-driven menu must (a) read the copy correctly — wine and
cocktail lists, inline descriptions, prices on their own line — and (b) paginate
when the content genuinely cannot fit the reference's grid on one sheet.

## Current state (measured, not assumed)

- `src/planner.js`: Pastis resolves to **4 columns**, 66 items, 11 sections,
  type scaled to 0.75x, `overflowIn: 1.91` — it does **not** fit, and there is
  no page 2.
- `src/import.js` misreads three real patterns seen in the Pastis OCR text:
  1. **Price-only lines** (`verre 17/bottle80`) become an item called "verre"
     (they match the bare-price path) or a warning.
  2. **All-caps dish names** (`CRÉMANT DE BOURGOGNE NV`) become *sections*,
     because all-caps scores as a heading.
  3. **Inline descriptions** (`Homemade Granola yogurt, fresh strawberries ... 12`)
     stay glued to the name, so `inferPattern` reports `hasDesc:false` and food
     renders like a wine list.

## Approach

### Phase A — content correctness (`src/import.js`)

- **A1. Price-only line → previous item's price.** Detect before `splitPrice`
  (a line of numbers + known unit words: verre, bottle, bouteille, glass, btl,
  carafe, pichet, each, for, half, cup, bowl). Attach to `lastItem.price`
  (concatenating multi-prices); warn if there is no previous item.
- **A2. Caps name with its price on the next line → item, not section.**
  One-line lookahead in the section branch: if the next non-empty line is
  price-only, emit the caps line as an unpriced item so A1 fills it.
  This is what makes `SPARKLING ROSÉ` a *section* (next line is a wine name)
  while `CRÉMANT DE BOURGOGNE NV` becomes an *item* (next line is the price).
- **A3. Inline name/description split.** Name boundary first (first lowercase
  word preceded by >= 2 capitalised words, skipping particles de/du/la/le/au/
  of/the/with/on/in), comma boundary second. Require a >= 2-word head, so
  `Salt cod fritters` and `Steak Frites` survive, while
  `Homemade Granola yogurt, ...` splits.
- **A4. Tests.** New `test/parse-inline.js` with hermetic lines copied from the
  real Pastis read (not `out/`, which is gitignored). `test/parse.js` must stay
  green at 44 checks — the regression gate for A3.

### Phase B — pagination

- **B1. Planner pages.** When a single page cannot fit even at the type floor,
  pack sections into pages (`plan.pages = [{sections:[...]}]`), never
  reordering and never splitting a section.
- **B2. Model.** `buildMenuFromParsed` returns one menu per page.
- **B3. Export.** `src/pdf.js` gains multi-page output: one `addPage` per sheet,
  crop marks and trim per page.
- **B4. UI.** Page indicator + prev/next in `index.html`; export writes all pages.
- **B5. Test.** `test/pagination.js`: a dense menu yields >= 2 pages, every page
  reports `fits`, and reading order is identical across the page boundary.

## Files

`src/import.js`, `src/planner.js`, `src/menu-model.js`, `src/pdf.js`,
`index.html`, `test/parse-inline.js`, `test/pagination.js`, `test/planner.js`,
`README.md`

## Verification

- `node test/parse.js` — 44 checks unchanged (no regression from A3).
- `node test/parse-inline.js` — the four real-world patterns above.
- `node test/planner.js` — 15 checks still green.
- `node test/pagination.js` — page count, per-page fit, order.
- `python3 test/syntax.py` — inline script parses, ids and assets resolve.
- `node test/fidelity.js` + `test/verify.py` — PDF glyph check still passes.

## Risks

- **Inline split eating real names.** Mitigated by the >= 2-capitalised-words
  rule, the particle stop-list, and the unchanged corpus test.
- **Pagination is the largest change**: it touches the model, the exporter and
  the UI. Ordered PDF-first so a wrong page count shows up in a test, not in a
  browser nobody can launch here.
- **Estimator vs render drift** (already bit us once: 1.0in predicted vs 2.6in
  real). Any new fit assertion must compare plan and render, not just one.
