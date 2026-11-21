/* The three content patterns that broke the Pastis import, taken from the real
   OCR text. Each line here appeared in that menu, garbled the same way. */
const MenuImport = require('../src/import.js');

let fails = 0, checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) { fails++; console.log('    FAIL ' + label + (detail ? '  [' + detail + ']' : '')); }
}

const DOC = [
  "PASTIS",
  "BRASSERIE",
  "",
  "HORS D'OEUVRES",
  "Homemade Granola yogurt,fresh strawberries …… 12",
  "Tuna Crudo* sauce ravigote. …… 25",
  "Salt cod fritters, smoked cod’soe …… 14",
  "Steak Frites …… 28",
  "Fish & Chips …… 16",
  "Salt baked potatoes, wild garlic butter …… 6",
  "",
  "WINE",
  "SPARKLING ROSE",
  "CREMANT DE BOURGOGNE NV",
  "verre 17/bottle 80",
  "MUSCADET SEVRE-ET-MAINE BLANC",
  "verre 15/carafe 45",
  ""
].join('\n');

const parsed = MenuImport.parse(DOC);
const items = {};
parsed.sections.forEach(s => s.items.forEach(i => { items[i.name] = { ...i, section: s.title }; }));

console.log(`sections: ${parsed.sections.map(s => s.title).join(' | ')}`);
console.log(`items: ${Object.keys(items).length}, warnings: ${parsed.warnings.length}`);
Object.values(items).forEach(i =>
  console.log(`  [${i.section}] ${i.name} = ${i.price}` + (i.desc ? `  — ${i.desc}` : '')));

// ---- A3: inline description split
const g = items['Homemade Granola'];
ok(!!g, 'inline: name split from description');
ok(g && g.desc === 'yogurt,fresh strawberries', 'inline: description captured', g && g.desc);
ok(g && g.price === '12', 'inline: price intact', g && g.price);

const t = items['Tuna Crudo'];
ok(!!t && t.desc === 'sauce ravigote', 'inline: description captured without trailing stop', t && t.desc);

// comma fallback must still keep a multi-word name
const s1 = items['Salt cod fritters'];
ok(!!s1, 'comma: name kept whole', Object.keys(items).join(','));
ok(s1 && s1.desc === "smoked cod’soe", 'comma: tail became the description', s1 && s1.desc);

// ---- names that must NOT be split
ok(!!items['Steak Frites'], 'no split: "Steak Frites" stays a name');
ok(items['Steak Frites'] && items['Steak Frites'].desc === '', 'no split: no invented description');
ok(!!items['Fish & Chips'], 'no split: ampersand name survives');
ok(!!items['Salt baked potatoes'], 'one-capital name not split at the first lowercase word');
ok(items['Salt baked potatoes'] && items['Salt baked potatoes'].desc === 'wild garlic butter',
   'one-capital name still splits at its comma', items['Salt baked potatoes'] && items['Salt baked potatoes'].desc);

// ---- A2: caps name whose price is on the next line is a dish, not a heading
const wine = parsed.sections.find(s => s.title === 'WINE');
ok(!!wine, 'section: WINE recognised');
const spark = parsed.sections.find(s => /SPARKLING/i.test(s.title));
ok(!!spark, 'group heading SPARKLING ROSE is a section');
ok(!!items['CREMANT DE BOURGOGNE NV'], 'caps wine name became an ITEM, not a section');
ok(!parsed.sections.some(s => /CREMANT/i.test(s.title)), 'caps wine name did not become a section title');

// ---- A1: price-only line attaches to the dish above it
const cremant = items['CREMANT DE BOURGOGNE NV'];
ok(cremant && /17/.test(cremant.price) && /80/.test(cremant.price),
   'price-only line (verre/bottle) attached to the wine above', cremant && cremant.price);
const muscadet = items['MUSCADET SEVRE-ET-MAINE BLANC'];
ok(muscadet && /15/.test(muscadet.price), 'second wine got its own price', muscadet && muscadet.price);
ok(!items['verre'], 'the unit word did not become a dish called "verre"');

// ---- units
ok(MenuImport.isPriceOnlyLine('verre 17/bottle 80'), 'unit: verre/bottle recognised');
ok(MenuImport.isPriceOnlyLine('15 / 45'), 'unit: bare pair recognised');
ok(!MenuImport.isPriceOnlyLine('Salt cod fritters'), 'unit: prose rejected');
ok(!MenuImport.isPriceOnlyLine('Salmon 18'), 'unit: a line with a word and a number is not price-only');

// ---- direct splitter cases
ok(MenuImport.splitInlineDesc('Steak Frites') === null, 'splitter: two capitals, no tail -> null');
ok(MenuImport.splitInlineDesc('Poulet au Vin Jaune') === null, 'splitter: particle stops the scan');
const d = MenuImport.splitInlineDesc('Roast chicken, lemon, thyme');
ok(d && d.name === 'Roast chicken' && d.desc === 'lemon, thyme', 'splitter: comma fallback',
   d && d.name + ' / ' + d.desc);

console.log(fails ? `\nFAIL — ${fails}/${checks} checks` : `\nPASS — ${checks} checks`);
process.exit(fails ? 1 : 0);
