/* The drag path moves a block's DOM nodes by index, so it depends on two
   invariants: every primitive carries the id of the block that drew it, and a
   block's primitives are contiguous. If either breaks, a drag moves the wrong
   pixels — so they are asserted here rather than discovered by a user. */
const MenuEngine = require('../src/engine.js');
const MenuModel = require('../src/menu-model.js');
const MenuImport = require('../src/import.js');
const MenuPlanner = require('../src/planner.js');

let fails = 0, checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) { fails++; console.log('    FAIL ' + label + (detail ? '  [' + detail + ']' : '')); }
}

const engine = MenuEngine.createEngine({ width: (t, st) => t.length * st.size * 0.5 });

function audit(name, menu) {
  const lay = engine.layout(menu);
  const ids = new Set((menu.blocks || []).map(b => b.id));
  const missing = lay.displayList.filter(e => e.id == null);
  const unknown = lay.displayList.filter(e => e.id != null && !ids.has(e.id));

  ok(missing.length === 0, `${name}: every primitive carries a block id`,
     missing.length + ' without id');
  ok(unknown.length === 0, `${name}: every id belongs to a real block`,
     unknown.length + ' unknown');

  // contiguity: a block's primitives must sit next to each other in the list
  const seen = [];
  let last = null, runs = 0;
  lay.displayList.forEach(e => {
    if (e.id !== last) { seen.push(e.id); last = e.id; runs++; }
  });
  const duplicated = seen.filter((id, i) => seen.indexOf(id) !== i);
  ok(duplicated.length === 0, `${name}: each block's primitives are contiguous`,
     duplicated.length + ' interleaved');

  // the canvas builds one DOM node per primitive, so the index is only valid if
  // the counts match exactly
  const perBlock = new Map();
  lay.displayList.forEach(e => perBlock.set(e.id, (perBlock.get(e.id) || 0) + 1));
  const summed = [...perBlock.values()].reduce((a, b) => a + b, 0);
  ok(summed === lay.displayList.length, `${name}: per-block counts sum to the display list`,
     `${summed} vs ${lay.displayList.length}`);
  ok(perBlock.size === (menu.blocks || []).filter(b => perBlock.has(b.id)).length,
     `${name}: every block with primitives is in the index`);

  console.log(`  ${name}: ${menu.blocks.length} blocks, ${lay.displayList.length} primitives, ` +
              `${runs} runs, ${perBlock.size} blocks indexed`);
  return lay;
}

const demo = MenuModel.buildMenu(engine);
audit('demo menu', demo);

// a built-from-plan menu exercises the same path the importer uses
const parsed = MenuImport.parse([
  'LARDER & VINE', 'TO BEGIN',
  'Charred Sourdough ....... 9', 'Cultured butter, smoked salt',
  'Burrata & Grilled Peach ....... 16', 'Basil oil, aged balsamic',
  'Beef Tartare ....... 18', 'Capers, shallot, cured egg yolk',
  'FROM THE FIRE',
  'Dry-Aged Ribeye ....... 62', 'Bone marrow, watercress'
].join('\n'));

const page = { unit: 'in', w: 8.5, h: 11, bleed: 0.125, cropMarks: true };
const plan = MenuPlanner.plan({
  parsed, page, columns: 2, top: 1.05, bottom: page.h - 0.8, paginate: false
});
const built = MenuModel.buildMenuFromParsed(engine, parsed, {
  page, theme: MenuModel.THEME, plan, top: 1.05, bottom: page.h - 0.8
}).menu;
audit('plan-built menu', built);

// the per-page builder must hand back menus on both paths — a single-page
// document once returned the {menu, overflowIn} wrapper, which broke every
// one-page import
const single = MenuModel.buildPagesFromParsed(engine, parsed, {
  page, theme: MenuModel.THEME, plan, top: 1.05, bottom: page.h - 0.8
});
ok(Array.isArray(single) && single.length === 1, 'single-page build returns one entry');
ok(single[0] && single[0].page && Array.isArray(single[0].blocks),
   'single-page entry is a menu, not a wrapper object',
   single[0] ? Object.keys(single[0]).join(',') : 'undefined');

// the properties must survive a block being moved, since that is what a drag does
const before = engine.layout(built).displayList.length;
const moved = JSON.parse(JSON.stringify(built));
moved.blocks[2].x += 1.5;
moved.blocks[2].y += 0.75;
const after = audit('after a move', moved);
ok(after.displayList.length === before, 'moving a block does not change the primitive count',
   `${after.displayList.length} vs ${before}`);

console.log(fails ? `\nFAIL — ${fails}/${checks} checks` : `\nPASS — ${checks} checks`);
process.exit(fails ? 1 : 0);
