/* A real client PDF (ELA, A4, four zones). The word boxes were dumped from
   pdf.js once and are stored here, so the whole pipeline is testable in node
   without a browser or a PDF renderer.

   This file exists because loading that PDF into the app broke four things the
   synthetic tests never saw:
     - the whitespace projection found zero empty x-bands and read four zones as
       one column, interleaving the columns;
     - letter-spaced headings stayed as "C H A A T / S T R E E T S N A C K S";
     - items are set "PANI PURI 14 V", so the price is followed by diet markers
       and every dish was classified as a section (37 dishes in 40 sections);
     - the planner threw away its own good paginated layout because it came out
       as a single sheet, leaving the page 2.4in off the trim.
*/
const fs = require('fs');
const path = require('path');
const MenuLayout = require('../src/layout.js');
const MenuImport = require('../src/import.js');
const MenuPlanner = require('../src/planner.js');
const MenuModel = require('../src/menu-model.js');
const MenuEngine = require('../src/engine.js');

let fails = 0, checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) { fails++; console.log('    FAIL ' + label + (detail ? '  [' + detail + ']' : '')); }
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ela-a4-words.json'), 'utf8'));
const laid = MenuLayout.reconstruct(fixture.words);
const parsed = MenuImport.parse(laid.text);

const items = [];
parsed.sections.forEach(s => s.items.forEach(i => items.push({ ...i, section: s.title })));
const byName = {};
items.forEach(i => { byName[i.name] = i; });

console.log(`ELA A4: ${fixture.words.length} boxes -> ${laid.stats.columns} columns, ` +
            `${laid.stats.lines} lines -> ${items.length} dishes in ${parsed.sections.length} sections ` +
            `(${parsed.warnings.length} warnings)`);

// ---- grid
ok(laid.stats.columns === 4, 'four zones detected, not one', laid.stats.columns + ' columns');

// ---- letter-spaced headings collapse
const titles = parsed.sections.map(s => s.title);
ok(titles.some(t => /CHAAT/i.test(t) && !/C H A A T/.test(t)),
   'letter-spaced heading collapsed', titles.slice(0, 3).join(' | '));
ok(!titles.some(t => /^[A-Z] [A-Z] [A-Z] /.test(t)), 'no heading is left spaced out');

// ---- items with a trailing diet marker are dishes, not headings
ok(items.length >= 60, 'most of the menu recovered as dishes', items.length + ' dishes');
ok(parsed.sections.length <= 15, 'section count is sane', parsed.sections.length + ' sections');

const pani = byName['PANI PURI'];
ok(!!pani, 'tag-trailed item parsed', Object.keys(byName).slice(0, 5).join(','));
ok(pani && pani.price === '14', 'tag-trailed price', pani && pani.price);
ok(pani && pani.tags.includes('V'), 'diet marker moved to tags', pani && pani.tags.join(','));
ok(pani && /^beet/.test(pani.desc || ''), 'description followed the item', pani && pani.desc);

const tuna = byName['TUNA BHELPURI'];
ok(tuna && tuna.price === '16/24', 'multi-price kept', tuna && tuna.price);
ok(tuna && tuna.tags.includes('GF'), 'multi-tag kept', tuna && tuna.tags.join(','));

// ---- the plan fits the reference sheet
const engine = MenuEngine.createEngine({ width: (t, st) => t.length * st.size * 0.5 });
const TH = MenuModel.THEME;

// measure a section exactly as the builder renders it, or the plan and the page
// will disagree (this is the drift that produced a 12.3in page earlier)
function blockHeight(section, width, pattern, ts) {
  const box = b => Object.assign({ x: 0, y: 0, w: width }, b);
  let h = engine.layoutBlock(box({ type: 'section', text: section.title, size: 8.2 * ts, tracking: 2.2 }), TH).h / 72 + 0.10 * ts;
  (section.items || []).forEach(it => {
    h += engine.layoutBlock(box({ type: 'item', name: it.name, desc: it.desc || '', price: it.price,
      tags: it.tags || [], size: 12.4 * ts, descSize: 8.2 * ts }), TH).h / 72 + 0.15 * ts;
  });
  return h + 0.16 * ts;
}

const page = { unit: 'in', w: +(fixture.page[0] / 72).toFixed(2), h: +(fixture.page[1] / 72).toFixed(2),
               bleed: 0.125, cropMarks: true };
ok(page.w === 8.27 && page.h === 11.69, 'A4 read from the PDF', page.w + 'x' + page.h);

const plan = MenuPlanner.plan({
  parsed, page, reference: { columns: laid.columns },
  top: 0.55, mastheadIn: parsed.title ? 1.85 : 0,
  bottom: page.h - 0.8, blockHeight
});
console.log(`  plan: ${plan.columns.length} cols, ${plan.pageCount} page(s), ` +
            `type ${plan.typeScale}x, overflow ${plan.overflowIn}in, fits=${plan.fits}`);

ok(plan.columns.length === 4, 'plan uses the reference grid', plan.columns.length + ' cols');
ok(plan.fits === true, 'plan fits the sheet', 'overflow ' + plan.overflowIn);
// pageCount here depends on the synthetic measurer above (0.5em per char), so it
// is reported, not gated: the app measures real font advances and fits one sheet.
ok(plan.pageCount <= 2, 'this menu needs one sheet, or two with a coarse measurer', plan.pageCount);

// The reference's detected column ranges overlap — a long dish name reaches into
// the next column — so the plan must never reuse them as text boxes. This is the
// regression that printed column two on top of column one.
const sortedCols = plan.columns.slice().sort((a, b) => a.x - b.x);
const partitioned = sortedCols.every((c, i) =>
  i === sortedCols.length - 1 || c.x + c.w <= sortedCols[i + 1].x + 0.001);
ok(partitioned, 'columns are a partition, not overlapping boxes',
   sortedCols.map(c => c.x.toFixed(2) + '+' + c.w.toFixed(2)).join(' '));

// ---- and the renderer agrees with the plan
const built = MenuModel.buildPagesFromParsed(engine, parsed, {
  page, theme: MenuModel.THEME, plan, top: 0.55, bottom: page.h - 0.8
});
const xs = [...new Set(built[0].blocks.map(b => +b.x.toFixed(2)))];
const itemsBuilt = built.reduce((n, m) => n + m.blocks.filter(b => b.type === 'item').length, 0);
const maxBottom = Math.max(...built[0].blocks.map(b => b.y + engine.layoutBlock(b, MenuModel.THEME).h / 72));

console.log(`  built: ${built.length} page(s), ${itemsBuilt} item blocks across ${xs.length} columns, ` +
            `bottom ${maxBottom.toFixed(2)}in of ${page.h}`);
ok(itemsBuilt === items.length, 'every dish reached the page', `${itemsBuilt} vs ${items.length}`);
ok(xs.length === 4, 'blocks land in all four columns', xs.length);
ok(maxBottom <= page.h - 0.8 + 0.06, 'nothing runs off the trim', maxBottom.toFixed(2));

console.log(fails ? `\nFAIL — ${fails}/${checks} checks` : `\nPASS — ${checks} checks`);
process.exit(fails ? 1 : 0);
