/* The planner, tested against the real Pastis read: does the content land in the
   reference's grid, in order, without stranding a section? */
const fs = require('fs');
const path = require('path');
const MenuLayout = require('../src/layout.js');
const MenuImport = require('../src/import.js');
const MenuPlanner = require('../src/planner.js');
const MenuModel = require('../src/menu-model.js');
const MenuEngine = require('../src/engine.js');

let fails = 0, checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { fails++; console.log('    FAIL ' + label); }
}

function loadOcr(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out/ocr', name), 'utf8'));
}

const words = loadOcr('pastis-menu.json');
const laid = MenuLayout.reconstruct(words);
const parsed = MenuImport.parse(laid.text);

console.log(`reference read: ${laid.stats.columns} column(s), ${parsed.sections.length} sections`);
console.log('reference columns (pt):');
laid.columns.forEach((c, i) =>
  console.log(`  ${i}  left ${c.left.toFixed(0).padStart(4)}  right ${c.right.toFixed(0).padStart(4)}  ` +
              `width ${(c.right - c.left).toFixed(0)}`));

const page = { w: 11, h: 7.4, bleed: 0.125 };

// --- plan against the reference's own grid
const plan = MenuPlanner.plan({
  parsed: parsed,
  page: page,
  reference: { columns: laid.columns },
  top: 1.05,
  bottom: page.h - 0.8
});

console.log(`\nplan: ${plan.columns.length} columns, ${plan.sectionCount} sections, ` +
            `${plan.itemCount} items, type ${plan.typeScale}x, overflow ${plan.overflowIn}in, ` +
            `column spread ${plan.balanced}in`);
plan.columns.forEach(c => console.log(`  col at x=${c.x} w=${c.w}`));

console.log('\ncolumn fill:');
plan.fills.forEach(f => console.log(`  col ${f.col}: ${f.height}in (bottom ${f.bottom})`));

console.log('\nsections, in order:');
plan.sections.forEach(s =>
  console.log(`  col ${s.col}  y ${String(s.y).padStart(5)}  ${s.title || '(untitled)'}`.padEnd(46) +
              `${String(s.items.length).padStart(3)} items` +
              `  ${s.pattern.hasDesc ? 'desc' : 'no-desc'} ${s.pattern.nameCase} ${s.pattern.priceStyle}`));

// ---- invariants
ok(plan.columns.length === 4, 'four columns, matching the reference grid');
ok(plan.sectionCount === parsed.sections.filter(s => (s.items || []).length).length,
   'every section with items is placed');
ok(plan.typeScale >= 0.75 && plan.typeScale <= 1, 'type scale stays in a legible range');
ok(plan.overflowIn >= 0, 'overflow is a number, not a surprise');
ok(plan.sections.every(s => s.col >= 0 && s.col < plan.columns.length), 'every section has a column');

// reading order must survive packing: sorting by (col, y) must equal source order
const byPlacement = plan.sections.slice().sort((a, b) => a.col - b.col || a.y - b.y);
const sourceOrder = parsed.sections.filter(s => (s.items || []).length).map(s => s.title);
const placedOrder = byPlacement.map(s => s.title);
ok(JSON.stringify(sourceOrder) === JSON.stringify(placedOrder),
   'reading order preserved (col, then y)');

// ---- pattern inference sanity
const foodish = parsed.sections.find(s => /HORS|D'OEU|SALADE|SANDWICH/i.test(s.title || ''));
if (foodish) {
  const p = MenuPlanner.inferPattern(foodish);
  console.log(`\npattern for "${foodish.title}": desc=${p.hasDesc} (rate ${p.descRate}) ` +
              `case=${p.nameCase} price=${p.priceStyle}`);
  ok(typeof p.hasDesc === 'boolean' && typeof p.priceStyle === 'string',
     'pattern is inferred for a section');
  if (!p.hasDesc) {
    console.log('    note: descriptions here are inline in the source line ' +
                '("Homemade Granola yogurt, fresh strawberries"), so the parser ' +
                'has nothing to mark as a description yet');
  }
}

// ---- and the same content with no reference: report honestly if it will not fit
const narrow = MenuPlanner.plan({ parsed, page, columns: 1, top: 1.05, bottom: page.h - 0.8, grow: false });
console.log(`\nno-reference fallback: 1 column, fill ${narrow.fills[0].height}in, ` +
            `overflow ${narrow.overflowIn}in, type ${narrow.typeScale}x`);
ok(narrow.columns.length === 1, 'falls back to one column when told not to grow');
ok(narrow.overflowIn > 0, 'reports that one column cannot hold the content');

// ---- the plan must actually drive the renderer, not just sound good
const engine = MenuEngine.createEngine({ width: (t, st) => t.length * st.size * 0.5 });
const built = MenuModel.buildMenuFromParsed(engine, parsed, {
  page, theme: MenuModel.THEME, plan, top: 1.05, bottom: page.h - 0.8
});
const xs = [...new Set(built.menu.blocks.map(b => +b.x.toFixed(2)))];
console.log(`\nrendered from plan: ${built.menu.blocks.length} blocks across ` +
            `${xs.length} column x-positions (${xs.join(', ')})`);
ok(xs.length === plan.columns.length, 'blocks land in every planned column');
ok(built.menu.blocks.every(b => b.x + b.w <= page.w + 0.01), 'no block wider than the page');
ok(built.overflowIn <= Math.max(0.3, plan.overflowIn + 1.5), 'rendered overflow tracks the plan');
ok((built.overflowIn > 0.5) === (plan.overflowIn > 0.5),
   'rendered fit status agrees with the plan');

const lay = engine.layout(built.menu);
console.log(`layout: ${lay.displayList.length} primitives, content ends ` +
            `${(lay.extent / 72).toFixed(2)}in of ${page.h}in`);

// ---- a menu that FITS must actually be fitted at full size. The Pastis read is
// 66 dishes on an 11x7.4in page, which honestly does not fit four columns; this
// case proves fitting works when the content is reasonable.
const small = {
  title: 'Larder & Vine',
  sections: ['TO BEGIN', 'FROM THE FIRE'].map((t, s) => ({
    title: t,
    items: [...Array(5)].map((_, i) => ({
      name: `Dish ${s}-${i}`, desc: 'short description', price: String(10 + i)
    }))
  }))
};
const smallPlan = MenuPlanner.plan({ parsed: small, page, columns: 3, top: 1.05, bottom: page.h - 0.8 });
console.log(`\nsmall menu: ${smallPlan.columns.length} cols, type ${smallPlan.typeScale}x, ` +
            `overflow ${smallPlan.overflowIn}in`);
ok(smallPlan.overflowIn <= 0.02, 'a menu that fits is fitted');
ok(smallPlan.typeScale === 1, 'full-size type when the content allows it');

console.log(fails ? `\nFAIL — ${fails}/${checks} checks` : `\nPASS — ${checks} checks`);
process.exit(fails ? 1 : 0);
