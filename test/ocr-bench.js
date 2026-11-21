/* Compare OCR engines through the same pipeline: word boxes -> layout
   reconstruction -> parser. Reads out/ocr/*.json (RapidOCR) and, when present,
   out/ocr-tesseract/*.json for the baseline. */
const fs = require('fs');
const path = require('path');
const MenuLayout = require('../src/layout.js');
const MenuImport = require('../src/import.js');

function run(file) {
  const words = JSON.parse(fs.readFileSync(file, 'utf8'));
  const laid = MenuLayout.reconstruct(words);
  const parsed = MenuImport.parse(laid.text);
  const items = [];
  parsed.sections.forEach(s => s.items.forEach(i => items.push({ section: s.title, ...i })));
  const confs = words.map(w => w.conf).filter(c => typeof c === 'number');
  return {
    file: path.basename(file),
    words: words.length,
    meanConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    columns: laid.stats.columns,
    items,
    sections: parsed.sections.length,
    parsed,
    text: laid.text
  };
}

const dir = process.argv[2] || 'out/ocr';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();

for (const f of files) {
  const r = run(path.join(dir, f));
  console.log('\n=== ' + r.file);
  console.log(`  ${r.words} boxes · mean conf ${(r.meanConf * 100).toFixed(0)}% · ` +
              `${r.columns} column(s) · ${r.items.length} dishes · ${r.sections} sections · ` +
              `${r.items.filter(i => i.desc).length} with desc`);
  r.items.slice(0, 10).forEach(i =>
    console.log(`    ${(i.section || '—').slice(0, 16).padEnd(16)} ${i.name} = ${i.price}` +
                (i.desc ? '  — ' + i.desc.slice(0, 40) : '')));
  if (process.env.DUMP) {
    console.log('  --- text');
    r.text.split('\n').slice(0, 30).forEach(l => console.log('   | ' + l));
  }
}
