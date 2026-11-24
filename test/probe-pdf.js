/* Reproduce the browser's PDF import path in node, exactly as index.html does it. */
const fs = require('fs');
const path = require('path');
const ROOT = '/home/dhynesmnk/menu-studio';
const pdfjsLib = require(path.join(ROOT, 'vendor/pdf.min.js'));
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'vendor/pdf.worker.min.js');
const MenuLayout = require(path.join(ROOT, 'src/layout.js'));
const MenuImport = require(path.join(ROOT, 'src/import.js'));

const file = process.argv[2];
const mode = process.argv[3] || 'summary';

(async () => {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false }).promise;
  const words = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const offset = (p - 1) * 1e5;
    tc.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const h = it.height || Math.abs(it.transform[3]) || 10;
      const yTop = vp.height - it.transform[5] - h + offset;
      const tracked = MenuLayout.collapseTracked(it.str);
      if (tracked) {
        words.push({ text: tracked, x: it.transform[4], y: yTop,
                     w: Math.max(1, it.width || h * tracked.length * 0.5), h });
        return;
      }
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
  const parsed = MenuImport.parse(laid.text);

  if (mode === 'words') {
    console.log(JSON.stringify(words));
    return;
  }
  if (mode === 'text') {
    console.log(laid.text);
    return;
  }
  if (mode === 'full') {
    parsed.sections.forEach(s => {
      console.log('§ ' + s.title + (s.note ? '  [' + s.note + ']' : ''));
      s.items.forEach(i => console.log('   ' + i.name + '  ' + i.price +
        (i.tags && i.tags.length ? '  {' + i.tags.join(',') + '}' : '') +
        (i.desc ? '  — ' + i.desc : '')));
    });
    console.log('\nWARNINGS');
    parsed.warnings.forEach(w => console.log('  ' + w.level + ': ' + w.message +
      (w.line ? '  ⟨' + w.line + '⟩' : '')));
    return;
  }

  console.log('pages', doc.numPages, '| words', words.length, '| lines', laid.stats.lines,
              '| segments', laid.stats.segments, '| columns', laid.stats.columns,
              '| medianH', laid.stats.medianHeight.toFixed(1), '| pageW', laid.stats.pageW.toFixed(0));
  laid.columns.forEach(c => console.log(`  col ${c.index}: left ${c.left.toFixed(0)} right ${c.right.toFixed(0)} segs ${c.segments}`));
  console.log('parsed:', parsed.stats.items, 'items in', parsed.stats.sections, 'sections;',
              parsed.warnings.length, 'warnings');
  parsed.sections.forEach(s => console.log(`  § "${s.title}" (${s.items.length}) ${s.items.map(i => i.name + ' ' + i.price).join(' | ').slice(0, 160)}`));
  const byLevel = {};
  parsed.warnings.forEach(w => { byLevel[w.level] = (byLevel[w.level] || 0) + 1; });
  console.log('warnings by level:', JSON.stringify(byLevel));
})().catch(e => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
