/* Where the time goes. Run: node test/perf.js [--big] */
const MenuDesign = require('../src/design.js');
const MenuEngine = require('../src/engine.js');
const MenuModel = require('../src/menu-model.js');
const MenuImport = require('../src/import.js');

function time(fn) {
  const t = process.hrtime.bigint();
  const out = fn();
  return [Number(process.hrtime.bigint() - t) / 1e6, out];
}

// ---- 1. design read: cost is per pixel, and phones take 12MP photos
function synth(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    d[o] = 246; d[o + 1] = 243; d[o + 2] = 236; d[o + 3] = 255;
  }
  for (let y = 0; y < h; y += 7) {
    for (let x = 0; x < w; x += 3) {
      if ((x * 7 + y * 13) % 11 < 3) {
        const o = (y * w + x) * 4;
        d[o] = 40; d[o + 1] = 41; d[o + 2] = 48;
      }
    }
  }
  return d;
}

console.log('design read (palette + page + margins)');
for (const [w, h] of [[595, 842], [1200, 1700], [2000, 2800], [3000, 4200], [4000, 5600]]) {
  const data = synth(w, h);
  const [ms] = time(() => MenuDesign.analyse(w, h, data, { channels: 4 }));
  console.log(`  ${String(w + 'x' + h).padEnd(11)} ${((w * h) / 1e6).toFixed(1)}MP  ${ms.toFixed(0).padStart(6)} ms`);
  data.fill(0);
}

// ---- 2. layout: cost per block, run on every drag frame
const engine = MenuEngine.createEngine({
  width: (text, st) => text.length * st.size * 0.5
});

function menuWith(dishes) {
  const lines = ['DINNER'];
  for (let i = 0; i < dishes; i++) {
    if (i % 20 === 0) lines.push('SECTION ' + (i / 20 + 1));
    lines.push(`Dish number ${i} with a reasonably long name ....... ${10 + (i % 15)}`);
    lines.push('a description that runs on for a while so the block has to wrap at least once');
  }
  const parsed = MenuImport.parse(lines.join('\n'));
  const built = MenuModel.buildMenuFromParsed(engine, parsed, {
    page: { unit: 'in', w: 8.5, h: 11, bleed: 0.125, cropMarks: true },
    theme: BASE.theme,               // fonts live on the theme; reuse the demo's
    colX: 0.75, colW: 7
  });
  return built.menu;
}

const BASE = MenuModel.buildMenu(engine);

console.log('\nlayout (whole document, what one drag frame costs)');
for (const n of [10, 40, 100, 200, 400]) {
  const menu = menuWith(n);
  const [ms, lay] = time(() => engine.layout(menu));
  console.log(`  ${String(n + ' dishes').padEnd(11)} ${String(menu.blocks.length + ' blocks').padEnd(10)} ` +
              `${String(lay.displayList.length + ' prims').padEnd(12)} ${ms.toFixed(1).padStart(7)} ms`);
}

// ---- 3. parse
console.log('\nparse (paste / OCR / PDF text)');
for (const n of [50, 500, 2000]) {
  const lines = ['MENU'];
  for (let i = 0; i < n; i++) {
    if (i % 25 === 0) lines.push('SECTION ' + (i / 25 + 1));
    lines.push(`Dish ${i} ....... ${10 + (i % 15)}`);
  }
  const text = lines.join('\n');
  const [ms] = time(() => MenuImport.parse(text));
  console.log(`  ${String(n + ' lines').padEnd(11)} ${ms.toFixed(1).padStart(7)} ms`);
}

// ---- 4. what the browser adds on top: width measurement per run
console.log('\nwidth measurement (browser only: one canvas call per unique style)');
const menu = menuWith(100);
const lay = engine.layout(menu);
const runs = lay.displayList.filter(e => e.k === 'text').length;
console.log(`  ${runs} text runs in a 100-dish menu -> one measureWidths() pass per relayout`);
