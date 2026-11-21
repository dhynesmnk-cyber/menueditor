/* Corpus test for the text importer. Real pasted-menu shapes, asserted
   structurally so a regression in the price logic fails loudly. */
const MenuImport = require('../src/import.js');

let failures = 0;
let checks = 0;

function eq(actual, expected, label) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`    FAIL ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.log(`    FAIL ${label}`); }
}

function hasWarning(parsed, level, substr) {
  return parsed.warnings.some(w => w.level === level && w.message.includes(substr));
}

const cases = [];

// 1. leader dots, ALL CAPS sections, descriptions on their own lines
cases.push({
  name: 'leaders + caps sections + descriptions',
  text: `TO BEGIN

Charred Sourdough ......... 9
Cultured butter, smoked salt, first-press olive oil

Burrata & Grilled Peach .......... 16
Basil oil, aged balsamic, hazelnut dukkah

FROM THE FIRE

Dry-Aged Ribeye, 14oz .......... 62
Bone marrow butter, charred allium`,
  check(p) {
    eq(p.sections.length, 2, 'section count');
    eq(p.sections[0].title, 'TO BEGIN', 'first section title');
    eq(p.sections[0].items.length, 2, 'first section items');
    eq(p.sections[0].items[0].name, 'Charred Sourdough', 'item name');
    eq(p.sections[0].items[0].price, '9', 'item price');
    ok(/Cultured butter/.test(p.sections[0].items[0].desc), 'description attached');
    eq(p.sections[1].items[0].name, 'Dry-Aged Ribeye, 14oz', 'name keeps 14oz');
    eq(p.sections[1].items[0].price, '62', 'price after leader dots');
    eq(p.stats.items, 3, 'total items');
    ok(!p.assumedPrices.length, 'no assumed prices');
  }
});

// 2. tabs, colon headers, currency
cases.push({
  name: 'tabs + colon headers + $',
  text: `Small Plates:
House Pickles\t6
Marinated Olives\t$7
Warm Bread\t$9

Mains:
Roast Chicken\t24`,
  check(p) {
    eq(p.sections.length, 2, 'section count');
    eq(p.sections[0].title, 'Small Plates', 'colon stripped from title');
    eq(p.sections[0].items.map(i => i.price), ['6', '7', '9'], 'prices');
    eq(p.sections[1].items[0].price, '24', 'mains price');
    ok(!p.assumedPrices.length, 'dollar/tab prices are high confidence');
  }
});

// 3. bare single-space prices -> imported, but flagged
cases.push({
  name: 'bare prices are flagged, not silent',
  text: `Starters
Tomato Soup 8
Caesar 11`,
  check(p) {
    eq(p.stats.items, 2, 'items imported');
    eq(p.sections[0].items.map(i => i.price), ['8', '11'], 'prices');
    eq(p.assumedPrices.length, 2, 'both flagged as assumed');
    ok(hasWarning(p, 'info', 'Assumed'), 'assumed-price warning present');
  }
});

// 4. dietary markers in brackets
cases.push({
  name: 'dietary tags',
  text: `SIDES
Charred Broccoli (V, GF) .... 8
Buttered Peas (V) ..... 7`,
  check(p) {
    eq(p.sections[0].items[0].name, 'Charred Broccoli', 'tags stripped from name');
    eq(p.sections[0].items[0].tags, ['V', 'GF'], 'two tags');
    eq(p.sections[0].items[1].tags, ['V'], 'one tag');
    eq(p.sections[0].items[1].price, '7', 'price survives');
  }
});

// 5. page furniture around the menu
cases.push({
  name: 'header/footer noise does not become dishes',
  text: `Larder & Vine
Dinner Menu
(555) 213-8890
www.lardervine.com

TO BEGIN
Sourdough ....... 9

FROM THE FIRE
Ribeye ....... 62`,
  check(p) {
    eq(p.title, 'Larder & Vine', 'title lifted from first line');
    eq(p.subtitle, 'Dinner Menu', 'subtitle from second line');
    eq(p.stats.items, 2, 'only real dishes imported');
    ok(!p.sections.some(s => /8890|lardervine/.test(s.title)), 'noise is not a section');
    ok(p.notes.some(n => /8890/.test(n)), 'phone routed to notes');
    ok(p.notes.some(n => /lardervine/.test(n)), 'url routed to notes');
    eq(p.warnings.filter(w => w.level === 'warn').length, 0, 'clean menu still produces no warnings');
  }
});

// 6. flat list with no sections at all
cases.push({
  name: 'flat list gets a default section',
  text: `Grilled Octopus ....... 24
Lamb Rack ....... 38`,
  check(p) {
    eq(p.sections.length, 1, 'one synthetic section');
    eq(p.sections[0].title, 'Menu', 'default name');
    eq(p.sections[0].items.length, 2, 'items');
  }
});

// 7. a number that is NOT a price
cases.push({
  name: 'measurements are not prices',
  text: `MAINS
Dry-Aged Ribeye, 14oz ....... 62`,
  check(p) {
    eq(p.sections[0].items[0].name, 'Dry-Aged Ribeye, 14oz', 'name intact');
    eq(p.sections[0].items[0].price, '62', 'correct price');
    ok(!p.assumedPrices.length, 'nothing assumed');
  }
});

// 8. splitPrice edge cases in isolation
cases.push({
  name: 'splitPrice edge cases',
  text: '',
  check() {
    const sp = (t) => MenuImport.splitPrice(t);
    eq(sp('Aged 12 months'), null, '"Aged 12 months" is not a price');
    eq(sp('Ribeye 62').conf, 'low', 'bare number is low confidence');
    eq(sp('Ribeye ...... 62').conf, 'high', 'leaders are high confidence');
    eq(sp('Ribeye $62').price, '$62', 'currency kept');
    eq(sp('Oysters 12 / 18').price, '12 / 18', 'multi price');
    ok(sp('Tasting menu — 85'), 'em dash separator');
  }
});

// 9. empty input is an error, not a crash
cases.push({
  name: 'empty input',
  text: '',
  check(p) {
    eq(p.stats.items, 0, 'no items');
    ok(hasWarning(p, 'error', 'No dishes found'), 'clear error');
  }
});

let total = 0;
for (const c of cases) {
  console.log(`\n${c.name}`);
  const parsed = MenuImport.parse(c.text);
  c.check(parsed);
  total += parsed.stats.items;
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${checks} checks across ${cases.length} cases, ${total} items parsed`);
process.exit(failures ? 1 : 0);
