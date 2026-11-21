/* Does column-aware OCR beat whole-page OCR on the same image?
   Reads out/gutters.json (from test/columns-ref.py) and OCRs each column crop
   separately via tesseract.js's rectangle option, then compares what the parser
   can recover from each. */
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const MenuImport = require('../src/import.js');

const gutters = JSON.parse(fs.readFileSync('out/gutters.json', 'utf8'));

function score(parsed) {
  const items = [];
  parsed.sections.forEach(s => s.items.forEach(i => items.push(i)));
  return {
    items: items.length,
    withDesc: items.filter(i => (i.desc || '').length > 3).length,
    withTags: items.filter(i => (i.tags || []).length).length,
    sections: parsed.sections.length,
    sample: items.slice(0, 3).map(i => `${i.name} = ${i.price}`)
  };
}

(async () => {
  const worker = await createWorker('eng');

  for (const doc of gutters) {
    const name = path.basename(doc.file);

    // --- whole page, one pass
    const whole = await worker.recognize(doc.file);
    const pWhole = MenuImport.parse(whole.data.text);
    const sWhole = score(pWhole);

    // --- one pass per column
    let mergedText = '';
    const perCol = [];
    for (const r of doc.rects) {
      const res = await worker.recognize(doc.file, {
        rectangle: { left: r.left, top: r.top, width: r.width, height: r.height }
      });
      mergedText += '\n\n' + res.data.text;
      perCol.push(res.data.confidence);
    }
    const pCol = MenuImport.parse(mergedText);
    const sCol = score(pCol);

    console.log('\n=== ' + name + '  (' + doc.columns + ' columns)');
    console.log('  whole page : ' + sWhole.items + ' dishes, ' + sWhole.withDesc + ' with desc, ' +
                sWhole.sections + ' sections  -> ' + JSON.stringify(sWhole.sample));
    console.log('  per column : ' + sCol.items + ' dishes, ' + sCol.withDesc + ' with desc, ' +
                sCol.sections + ' sections  -> ' + JSON.stringify(sCol.sample));
    console.log('  OCR confidence per column: ' + perCol.map(c => Math.round(c) + '%').join(', '));
    if (process.env.DUMP) console.log(mergedText);
  }

  await worker.terminate();
})();
