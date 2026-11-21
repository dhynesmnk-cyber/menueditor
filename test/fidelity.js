/* Node harness: same engine, same model, same exporter as the browser.
   Emits out/menu.pdf + out/displaylist.json so the fidelity test can prove
   the PDF contains exactly the lines the engine decided on.            */
const fs = require('fs');
const path = require('path');
require('./bootstrap');   // shims jsPDF's require('atob')/require('btoa')
const { jsPDF } = require('../vendor/jspdf.node.min.js');
const MenuEngine = require('../src/engine.js');
const MenuModel = require('../src/menu-model.js');
const MenuPDF = require('../src/pdf.js');

const ROOT = path.join(__dirname, '..');

function loadFonts() {
  return MenuModel.FONTS.map(f => ({
    family: f.family,
    style: f.style,
    file: f.file,
    b64: fs.readFileSync(path.join(ROOT, 'fonts', f.file)).toString('base64')
  }));
}

const fonts = loadFonts();

// metrics instance: never printed, only used to measure with the real font
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

const menu = MenuModel.buildMenu(engine);
const lay = engine.layout(menu);

const pdf = MenuPDF.renderPDF(jsPDF, menu, lay, fonts);
const buf = Buffer.from(pdf.output('arraybuffer'));

// Expected glyph positions: the exporter's own advance model, computed here so
// the verifier can assert every single glyph landed where the engine said.
const glyphs = [];
lay.displayList.filter(e => e.k === 'text').forEach((e, runId) => {
  for (let i = 0; i < e.t.length; i++) {
    const prefix = e.t.slice(0, i);
    const w = engine.wOf(prefix, { font: e.font, style: e.style, size: e.size, tracking: 0 });
    glyphs.push({
      runId,
      ch: e.t[i],
      x: e.x + w + (e.tracking || 0) * i,
      y: e.baseline,
      size: e.size
    });
  }
});

fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out/menu.pdf'), buf);
fs.writeFileSync(path.join(ROOT, 'out/displaylist.json'), JSON.stringify({
  page: menu.page,
  layoutPage: lay.page,
  extent: lay.extent,
  displayList: lay.displayList,
  bounds: lay.bounds,
  expectedGlyphs: glyphs
}, null, 2));

const textCount = lay.displayList.filter(e => e.k === 'text').length;
console.log('blocks:      ', menu.blocks.length);
console.log('primitives:  ', lay.displayList.length, `(${textCount} text runs)`);
console.log('content ends:', (lay.extent / 72).toFixed(3), 'in of', menu.page.h, 'in');
console.log('pdf bytes:   ', buf.length);
console.log('-> out/menu.pdf, out/displaylist.json');
