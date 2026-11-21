/* Does layout reconstruction from word boxes fix the OCR mess — and does the
   same code path read a born-digital PDF?

   Sources of boxes:
     PNG -> tesseract.js TSV (what the browser will use)
     PDF -> pymupdf words (stand-in for pdf.js text items, same shape) */
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const MenuLayout = require('../src/layout.js');
const MenuImport = require('../src/import.js');

const IMAGES = [
  '/home/dhynesmnk/ela-menu/menu example 3 (1).png',
  '/home/dhynesmnk/ela-menu/pastis menu.png',
  '/home/dhynesmnk/ela-menu/menu example 2 (1).png',
];

function parseTsv(tsv) {
  const out = [];
  for (const line of String(tsv || '').split('\n')) {
    const f = line.split('\t');
    if (f.length < 12 || f[0] !== '5') continue;          // level 5 = word
    const text = f.slice(11).join('\t').trim();
    if (!text) continue;
    out.push({
      text,
      x: +f[6], y: +f[7], w: +f[8], h: +f[9],
      conf: +f[10],
    });
  }
  return out;
}

function summarise(label, parsed) {
  const items = [];
  parsed.sections.forEach(s => s.items.forEach(i => items.push({ s: s.title, ...i })));
  console.log(`  ${label.padEnd(18)} ${String(items.length).padStart(3)} dishes · ` +
              `${parsed.sections.length} sections · ${items.filter(i => i.desc).length} with desc`);
  items.slice(0, 4).forEach(i => console.log(`      ${i.s} | ${i.name} = ${i.price}`));
  return items.length;
}

(async () => {
  if (process.env.SKIP_OCR) {
    console.log('(skipping OCR passes — SKIP_OCR set)');
  } else {
    const worker = await createWorker('eng');

    for (const img of IMAGES) {
      console.log('\n=== ' + path.basename(img));
      const res = await worker.recognize(img, {}, { tsv: true });
      const words = parseTsv(res.data.tsv);
      const whole = res.data.text;

      const naive = MenuImport.parse(whole);
      const laid = MenuLayout.reconstruct(words);
      const rebuilt = MenuImport.parse(laid.text);

      console.log(`  ${words.length} OCR words · ${laid.stats.columns} columns detected · ` +
                  `${laid.stats.lines} lines`);
      const a = summarise('whole-page OCR', naive);
      const b = summarise('reconstructed', rebuilt);

      if (process.env.DUMP) {
        console.log('--- reconstructed text (first 40 lines)');
        laid.text.split('\n').slice(0, 40).forEach(l => console.log('   ' + l));
      }
      console.log(`  => ${b - a >= 0 ? '+' : ''}${b - a} dishes recovered`);
    }
    await worker.terminate();
  }

  // ---- the same reconstructor on a born-digital PDF
  if (fs.existsSync('out/pdf-words.json')) {
    console.log('\n=== out/menu.pdf (born-digital, pymupdf word boxes)');
    const words = JSON.parse(fs.readFileSync('out/pdf-words.json', 'utf8'));
    const laid = MenuLayout.reconstruct(words);
    const parsed = MenuImport.parse(laid.text);
    console.log(`  ${words.length} words · ${laid.stats.columns} columns · ${laid.stats.lines} lines`);
    summarise('pdf', parsed);
    if (process.env.DUMP) {
      console.log('--- reconstructed pdf text (first 30 lines)');
      laid.text.split('\n').slice(0, 30).forEach(l => console.log('   ' + l));
    }
  }
})();
