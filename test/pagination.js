/* Pagination: a menu too dense for one sheet must become two, with the reading
   order intact and nothing running off the trim. */
const fs = require('fs');
const path = require('path');
require('./bootstrap');
const { jsPDF } = require('../vendor/jspdf.node.min.js');

const MenuLayout = require('../src/layout.js');
const MenuImport = require('../src/import.js');
const MenuPlanner = require('../src/planner.js');
const MenuModel = require('../src/menu-model.js');
const MenuEngine = require('../src/engine.js');
const MenuPDF = require('../src/pdf.js');

let fails = 0, checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) { fails++; console.log('    FAIL ' + label + (detail ? '  [' + detail + ']' : '')); }
}

// real font metrics, so the plan is measured the way the builder will render it
const fonts = MenuModel.FONTS.map(f => ({
  family: f.family, style: f.style, file: f.file,
  b64: fs.readFileSync(path.join(__dirname, '..', 'fonts', f.file)).toString('base64')
}));
const metricsDoc = new jsPDF({ unit: 'pt', format: [612, 792] });
fonts.forEach(f => {
  metricsDoc.addFileToVFS(f.family + '-' + f.style + '.ttf', f.b64);
  metricsDoc.addFont(f.family + '-' + f.style + '.ttf', f.family, f.style);
});
const engine = MenuEngine.createEngine({
  width(text, st) {
    metricsDoc.setFont(st.font, st.style || 'normal');
    metricsDoc.setFontSize(st.size);
    return metricsDoc.getTextWidth(text);
  }
});
const measure = (text, role, size) =>
  engine.wOf(text, { font: 'MLato', style: 'normal', size: size || 10, tracking: 0 });

// Height of a section exactly as menu-model will build it — same block types,
// same sizes, same gaps. This is what makes plan and render agree.
const TH = MenuModel.THEME;
function blockHeight(section, width, pattern, ts) {
  const box = (b) => ({ x: 0, y: 0, w: width, ...b });
  let h = engine.layoutBlock(box({
    type: 'section', text: section.title, size: 8.2 * ts, tracking: 2.2
  }), TH).h / 72 + 0.10 * ts;
  (section.items || []).forEach(it => {
    h += engine.layoutBlock(box({
      type: 'item', name: it.name, desc: it.desc || '', price: it.price,
      tags: it.tags || [], size: 12.4 * ts, descSize: 8.2 * ts
    }), TH).h / 72 + 0.15 * ts;
  });
  return h + 0.16 * ts;
}

// the dense real menu
const words = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out/ocr/pastis-menu.json'), 'utf8'));
const laid = MenuLayout.reconstruct(words);
const parsed = MenuImport.parse(laid.text);
const page = { unit: 'in', w: 11, h: 7.4, bleed: 0.125, cropMarks: true };

const plan = MenuPlanner.plan({
  parsed, page, reference: { columns: laid.columns },
  top: 1.05, bottom: page.h - 0.8, measure, blockHeight
});

const sourceOrder = parsed.sections.filter(s => (s.items || []).length).map(s => s.title);

console.log(`dense menu: ${plan.sectionCount} sections, ${plan.itemCount} items, ` +
            `${plan.columns.length} columns, ${plan.pageCount} page(s), ` +
            `type ${plan.typeScale}x, fits=${plan.fits}`);

ok(plan.pageCount >= 2, 'a menu too dense for one sheet gets more sheets', 'pages=' + plan.pageCount);
ok(plan.fits === true, 'a paginated plan fits');
ok(plan.overflowIn === 0, 'no overflow once paginated', 'overflow=' + plan.overflowIn);
ok(Array.isArray(plan.pages) && plan.pages.length === plan.pageCount, 'pages array matches the count');

// every section appears exactly once, in order, across all pages
const placed = [];
plan.pages.forEach((pg, i) => {
  pg.sections.forEach(s => placed.push({ title: s.title, page: i, col: s.col, y: s.y }));
});
ok(placed.length === sourceOrder.length,
   'every section placed exactly once', `${placed.length} placed vs ${sourceOrder.length} source`);
ok(JSON.stringify(placed.map(p => p.title)) === JSON.stringify(sourceOrder),
   'reading order preserved across the page break');

// pages must be filled left-to-right-top-to-bottom in order
const sorted = placed.slice().sort((a, b) => a.page - b.page || a.col - b.col || a.y - b.y);
ok(JSON.stringify(sorted.map(p => p.title)) === JSON.stringify(sourceOrder),
   'sorting by (page, col, y) reproduces the source order');

// per page: nothing below the safe bottom
const bottom = page.h - 0.8;
plan.pages.forEach((pg, i) => {
  const maxBottom = Math.max.apply(null, pg.sections.map(s => s.y + s.h));
  ok(maxBottom <= bottom + 0.05, `page ${i + 1} content ends above the trim`,
     `ends at ${maxBottom.toFixed(2)} vs ${bottom}`);
});

// ---- build one menu per page and export them
const menus = MenuModel.buildPagesFromParsed(engine, parsed, {
  page, theme: MenuModel.THEME, plan, top: 1.05, bottom: page.h - 0.8
});
ok(menus.length === plan.pageCount, 'one menu built per page', menus.length + ' menus');

const lays = menus.map(m => engine.layout(m));
let renderedOver = 0;
menus.forEach((m, i) => {
  const items = m.blocks.filter(b => b.type === 'item').length;
  const bottom = Math.max(...m.blocks.map(b => {
    const h = engine.layoutBlock(b, m.theme).h / 72;
    return b.y + h;
  }));
  renderedOver = Math.max(renderedOver, bottom - (page.h - 0.8));
  console.log(`  page ${i + 1}: ${m.blocks.length} blocks, ${items} item blocks, ` +
              `rendered bottom ${bottom.toFixed(2)}in`);
});
ok(renderedOver <= 0.06,
   'rendered pages fit the trim, not just the plan', `over by ${renderedOver.toFixed(2)}in`);

// total items across pages must equal the source
const itemsBuilt = menus.reduce((n, m) => n + m.blocks.filter(b => b.type === 'item').length, 0);
const itemsSource = plan.pages.reduce((n, pg) => n + pg.sections.reduce((k, s) => k + s.items.length, 0), 0);
ok(itemsBuilt === itemsSource, 'no dish lost or duplicated across pages',
   `${itemsBuilt} built vs ${itemsSource} planned`);

// sheet 2 has no masthead
ok(menus[1].blocks.every(b => b.type !== 'title'), 'second sheet does not repeat the masthead');

// ---- export a real multi-page PDF
const pdf = MenuPDF.renderPDFPages(jsPDF, menus, lays, fonts);
const buf = Buffer.from(pdf.output('arraybuffer'));
fs.mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'out/paginated.pdf'), buf);

const pageCount = pdf.getNumberOfPages();
console.log(`\nPDF: ${pageCount} pages, ${buf.length} bytes -> out/paginated.pdf`);
ok(pageCount === plan.pageCount, 'PDF has one page per planned sheet', pageCount + ' pdf pages');

// the magic bytes and page tree are the only cheap proof from node; verify.py
// does the glyph-level check for single-page exports
ok(buf.slice(0, 4).toString() === '%PDF', 'output is a PDF');

console.log(fails ? `\nFAIL — ${fails}/${checks} checks` : `\nPASS — ${checks} checks`);
process.exit(fails ? 1 : 0);
