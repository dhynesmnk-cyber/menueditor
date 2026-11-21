/* Can OCR recover a real menu well enough to feed the parser?
   This is the make-or-break experiment for PNG import. */
const path = require('path');
const { createWorker } = require('tesseract.js');
const MenuImport = require('../src/import.js');

const IMAGES = [
  '/home/dhynesmnk/ela-menu/menu example 3 (1).png',   // cleanest: small, 2 col
  '/home/dhynesmnk/ela-menu/menu example 2 (1).png',   // boxed panels + photo border
  '/home/dhynesmnk/ela-menu/pastis menu.png',          // landscape, 3 col, dense
];

(async () => {
  const worker = await createWorker('eng');
  for (const img of IMAGES) {
    const t0 = Date.now();
    const { data } = await worker.recognize(img);
    const ms = Date.now() - t0;
    const text = data.text;
    const lines = text.split('\n').filter(l => l.trim());
    const parsed = MenuImport.parse(text);

    console.log('\n=== ' + path.basename(img) + ' (' + ms + 'ms, conf ' +
                Math.round(data.confidence) + '%)');
    console.log('lines:', lines.length, '| parsed:', parsed.stats.items,
                'dishes /', parsed.sections.length, 'sections');
    console.log('--- first 18 OCR lines:');
    lines.slice(0, 18).forEach(l => console.log('   ' + JSON.stringify(l)));
    console.log('--- parsed dishes (first 6):');
    parsed.sections.forEach(s => {
      s.items.slice(0, 6).forEach(i => console.log(`   ${s.title} | ${i.name} | ${i.price}`));
    });
  }
  await worker.terminate();
})();
