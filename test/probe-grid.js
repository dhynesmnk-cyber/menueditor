/* Dump segments (post line/price folding) with geometry, for grid design. */
const fs = require('fs');
const path = require('path');
const ROOT = '/home/dhynesmnk/menu-studio';
const pdfjsLib = require(path.join(ROOT, 'vendor/pdf.min.js'));
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'vendor/pdf.worker.min.js');
const MenuLayout = require(path.join(ROOT, 'src/layout.js'));

const file = process.argv[2];

(async () => {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const words = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    tc.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const h = it.height || Math.abs(it.transform[3]) || 10;
      const yTop = vp.height - it.transform[5] - h;
      const parts = it.str.split(/\s+/).filter(Boolean);
      const total = it.str.length || 1;
      let cursor = 0;
      parts.forEach(word => {
        const idx = it.str.indexOf(word, cursor);
        const lead = idx < 0 ? cursor : idx;
        const x = it.transform[4] + (lead / total) * (it.width || 0);
        const w = Math.max(1, (word.length / total) * (it.width || h * word.length * 0.5));
        words.push({ text: word, x, y: yTop, w, h });
        cursor = lead + word.length;
      });
    });
  }
  const laid = MenuLayout.reconstruct(words);
  // re-run internal pieces is not exposed; instead print per-column segment text with coords
  laid.columns.forEach(c => {
    console.log(`\n### column ${c.index}  left=${c.left.toFixed(0)} right=${c.right.toFixed(0)} segments=${c.segments}`);
    c.text.split('\n').forEach(l => console.log('   ' + l));
  });
  console.log('\nstats', JSON.stringify(laid.stats));
  // raw single-char runs: gaps for the tagline
  const singles = words.filter(w => w.text.trim().length === 1);
  const rows = {};
  singles.forEach(w => { const k = Math.round((w.y + w.h / 2) / 3); (rows[k] = rows[k] || []).push(w); });
  Object.keys(rows).sort((a, b) => a - b).forEach(k => {
    const r = rows[k].sort((a, b) => a.x - b.x);
    if (r.length < 8) return;
    const gaps = r.slice(1).map((w, i) => +(w.x - (r[i].x + r[i].w)).toFixed(2));
    console.log(`singles y=${(k * 3).toFixed(0)} n=${r.length} charw=${r[0].w.toFixed(2)} gaps=${gaps.join(',')}`);
  });
})().catch(e => { console.error('FAILED', e); process.exit(1); });
