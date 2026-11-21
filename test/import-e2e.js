/* End-to-end: pasted menu text -> parser -> blocks -> layout -> PDF.
   Proves an imported menu actually prints, not just that the parser returns an
   object. Writes out/imported.pdf + out/import-displaylist.json. */
const fs = require('fs');
const path = require('path');
require('./bootstrap');
const { jsPDF } = require('../vendor/jspdf.node.min.js');
const MenuEngine = require('../src/engine.js');
const MenuModel = require('../src/menu-model.js');
const MenuImport = require('../src/import.js');
const MenuPDF = require('../src/pdf.js');

const ROOT = path.join(__dirname, '..');

const PASTED = `Larder & Vine
Dinner Menu
(555) 213-8890

TO BEGIN
Charred Sourdough ......... 9
Cultured butter, smoked salt, first-press olive oil

Burrata & Grilled Peach (V, GF) .......... 16
Basil oil, aged balsamic, hazelnut dukkah

Beef Tartare .......... 18
Capers, shallot, cured egg yolk, rye crisps

FROM THE FIRE
Dry-Aged Ribeye, 14oz .......... 62
Bone marrow butter, charred allium

Coal-Roasted Hake .......... 34
Fennel, brown butter, preserved lemon

Wood-Fired Celeriac .......... 26
Black garlic, hazelnut, aged pecorino

TO FINISH
Burnt Honey Custard .......... 11
Sea salt, rye crumb, crème fraîche

V vegetarian · GF gluten free — please tell us about any allergies`;

const fonts = MenuModel.FONTS.map(f => ({
  family: f.family, style: f.style, file: f.file,
  b64: fs.readFileSync(path.join(ROOT, 'fonts', f.file)).toString('base64')
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

// ---- 1. parse the pasted text
const parsed = MenuImport.parse(PASTED);

// ---- 2. build a menu from it, on a Letter page
const built = MenuModel.buildMenuFromParsed(engine, parsed, {
  page: { unit: 'in', w: 8.5, h: 11, bleed: 0.125, cropMarks: true }
});
const menu = built.menu;
const lay = engine.layout(menu);

// ---- 3. export
const pdf = MenuPDF.renderPDF(jsPDF, menu, lay, fonts);
const buf = Buffer.from(pdf.output('arraybuffer'));
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out/imported.pdf'), buf);

const glyphs = [];
lay.displayList.filter(e => e.k === 'text').forEach((e, runId) => {
  for (let i = 0; i < e.t.length; i++) {
    const prefix = e.t.slice(0, i);
    const w = engine.wOf(prefix, { font: e.font, style: e.style, size: e.size, tracking: 0 });
    glyphs.push({ runId, ch: e.t[i], x: e.x + w + (e.tracking || 0) * i, y: e.baseline, size: e.size });
  }
});
fs.writeFileSync(path.join(ROOT, 'out/import-displaylist.json'), JSON.stringify({
  page: menu.page, layoutPage: lay.page, extent: lay.extent,
  displayList: lay.displayList, bounds: lay.bounds, expectedGlyphs: glyphs
}, null, 2));

// ---- assertions
let fails = 0;
function eq(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fails++;
    console.log(`  FAIL ${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

eq(parsed.title, 'Larder & Vine', 'title');
eq(parsed.subtitle, 'Dinner Menu', 'subtitle');
eq(parsed.sections.map(s => s.title), ['TO BEGIN', 'FROM THE FIRE', 'TO FINISH'], 'sections');
eq(parsed.stats.items, 7, 'dish count');
eq(parsed.sections[0].items[0].name, 'Charred Sourdough', 'first dish');
eq(parsed.sections[0].items[0].price, '9', 'first price');
eq(parsed.sections[0].items[1].tags, ['V', 'GF'], 'tags survive import');
eq(parsed.assumedPrices.length, 0, 'no prices invented');
if (built.overflowIn > 0.01) { fails++; console.log(`  FAIL content overflows page by ${built.overflowIn.toFixed(2)}in`); }

const textRuns = lay.displayList.filter(e => e.k === 'text').length;
console.log(`parsed ${parsed.stats.items} dishes / ${parsed.sections.length} sections, ` +
            `${parsed.warnings.length} warning(s)`);
parsed.warnings.forEach(w => console.log(`  [${w.level}] ${w.message}`));
console.log(`laid out ${menu.blocks.length} blocks -> ${textRuns} text runs, ` +
            `${glyphs.length} glyphs, content ends ${(lay.extent / 72).toFixed(3)} in`);
console.log(`pdf ${buf.length} bytes -> out/imported.pdf`);
console.log(fails ? `FAIL — ${fails} assertion(s)` : 'PASS — pasted text imported and printed');
process.exit(fails ? 1 : 0);
