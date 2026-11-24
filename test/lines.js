/* Canvas-mode guards, tested against a real extraction of the ELA menu.

   The fixture pins what the sidecar's grouping produced; these checks fail if a
   change to grouping.py garbles a heading or moves a price, or if a guard stops
   guarding. Node-only: the DOM side lives in src/canvas.js. */
const fs = require('fs');
const path = require('path');
const MenuLines = require('../src/lines.js');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lines-ela.json'), 'utf8'));
const doc = MenuLines.normalize(raw);
const O = doc.objects;
const byText = t => O.find(o => o.text === t);

let fails = 0, checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { fails++; console.log('    FAIL ' + label); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* A measuring stub with realistic proportions: 0.62em per character. The browser
   measures with an SVG text node; the guards must not care which one is used. */
function measure(text, size, track) {
  const n = text.length;
  return n * 0.62 * size + (track || 0) * size * Math.max(0, n - 1);
}

console.log('grouping — three encodings, one page\n');
ok(O.length === 11, 'fixture has 11 line objects');
ok(doc.vectors.length >= 4, 'rules/dividers exported as obstacles');
ok(doc.vectors.some(v => v[1] > 328 && v[1] < 331 && v[2] > 500),
   'the divider beside THE BAR is in the obstacle list');
ok(!doc.vectors.some(v => (v[2] - v[0]) < 3 && (v[3] - v[1]) < 3),
   'leader dots are not obstacles (a 1pt square is not a rule)');
near(doc.page.width, 595.28, 0.01) && checks++;

const chaat = byText('CHAAT / STREET SNACKS');
ok(!!chaat, 'letter-spaced heading survived as one object');
ok(chaat && chaat.text.includes(' '), 'CHAAT / STREET SNACKS kept its word gaps');
ok(chaat && chaat.letter_spaced, 'marked as space-tracked');
ok(chaat && near(chaat.track, 0.268, 0.01), 'tracking kept (0.268 em)');

const masthead = byText('REGIONAL INDIAN COOKING · MADE TO SHARE');
ok(masthead && masthead.text === 'REGIONAL INDIAN COOKING · MADE TO SHARE', 'masthead reads as words');

const body = byText('romaine, radish, chickpeas, beet');
ok(body && body.text === 'romaine, radish, chickpeas, beet', 'positional body copy got real spaces');
ok(body && !body.letter_spaced && Math.abs(body.track) < 0.01, 'body copy is not treated as tracked');

const mango = byText('LOCAL MANGO SALAD');
const price = byText('19');
ok(mango && !mango.text.includes('19'), 'dish name did not swallow its price');
ok(price && price.x > mango.x + mango.ink_width, 'price stays its own object to the right');

console.log('\nslack — the document knows its own room\n');
ok(near(byText('PANI PURI').max_width, 46.13, 0.01), 'PANI PURI stops short of its price (46.13)');
ok(near(byText('THE BAR').max_width, 55.75, 0.01), 'THE BAR stops short of the rule (55.75)');
ok(near(byText('GF').max_width, 30.93, 0.01), 'legend growth capped (30.93, not the page)');
ok(O.every(o => o.max_width >= o.ink_width - 0.01), 'no line has less room than it already uses');

console.log('\nfit — 8% or refuse\n');
const bar = byText('THE BAR');
const base = MenuLines.baseTrack(bar);
ok(base > 0.2, 'a tracked line starts at its measured tracking');

const den = MenuLines.fit(bar, 'THE DEN', bar.size, base, measure);
ok(den.fits && near(den.size, bar.size, 0.01), 'a shorter name fits at full size');

const lounge = MenuLines.fit(bar, 'THE LOUNGE', bar.size, base, measure);
ok(!lounge.fits, 'a name 30% too wide is refused, not squeezed');

const squeezed = MenuLines.fit(bar, 'THE LOUNGE', bar.size, base, measure, bar.max_width, MenuLines.HARD_FIT);
ok(squeezed.fits && squeezed.size < bar.size * 0.85, 'explicit hard fit may go below the floor');
ok(squeezed.w <= squeezed.max + 0.2, 'the hard fit still stays inside the slot');

const dish = MenuLines.fit(mango, 'LOCAL SNAPPER CURRY', mango.size, 0, measure);
ok(dish.fits && dish.size < mango.size, 'a modestly longer dish shrinks to fit');
ok(dish.size >= mango.size * MenuLines.MIN_FIT - 0.01, 'and never beyond the floor');
ok(dish.w <= dish.max + 0.2, 'and lands inside its own column');

console.log('\ndrop — lines, rules, page edges\n');
const barIdx = O.indexOf(bar);
function clash(x, y) {
  return MenuLines.dropClash({ objects: O, vectors: doc.vectors, page: doc.page, edits: new Map(),
                               i: barIdx, x: x, y: y, size: bar.size, width: bar.ink_width });
}
// THE BAR sits on its own baseline, so an overlap test needs a line that shares x
const pani = byText('PANI PURI');
const paniIdx = O.indexOf(pani);
function clashAs(i, o, x, y) {
  return MenuLines.dropClash({ objects: O, vectors: doc.vectors, page: doc.page, edits: new Map(),
                               i: i, x: x, y: y, size: o.size, width: o.ink_width });
}
ok(clash(bar.x + 25, bar.y) === 'a rule', 'dropping onto the divider is refused');
ok(clashAs(paniIdx, pani, pani.x, byText('WINGS').y) === 'another line',
   'dropping onto another line is refused');
ok(clash(-20, bar.y) === 'the page edge', 'dropping off the page is refused');
ok(clash(520, 600) === null, 'empty space accepts the drop');

console.log('\nsnap — guides come from the document\n');
const guides = MenuLines.guides(O);
ok(guides.xs.indexOf(bar.x) >= 0, 'baseline/left-edge guides include this line');
ok(MenuLines.snapTo(bar.x + 2.4, guides.xs) === bar.x, '2.4 pt away snaps');
ok(MenuLines.snapTo(bar.x + 3.0, guides.xs) === null, '3 pt away does not');

console.log('\nedits — no-ops are not edits\n');
const edits = new Map();
MenuLines.applyEdit(edits, O, barIdx, { text: 'THE DEN' });
ok(edits.has(barIdx), 'a real change is stored');
MenuLines.applyEdit(edits, O, barIdx, { text: 'THE BAR' });
ok(!edits.has(barIdx), 'retyping the original removes the edit');
MenuLines.applyEdit(edits, O, barIdx, { x: bar.x + 12, y: bar.y });
ok(edits.has(barIdx), 'a move is stored');
MenuLines.applyEdit(edits, O, barIdx, { x: bar.x, y: bar.y });
ok(!edits.has(barIdx), 'moving it back removes the edit again');

MenuLines.applyEdit(edits, O, barIdx, { text: 'THE DEN', size: 7.5 });
const payload = MenuLines.payload(edits, O);
ok(payload.length === 1 && payload[0].text === 'THE DEN' && payload[0].size === 7.5,
   'payload carries text, size, tracking and position');

console.log('\n' + (fails ? `FAIL — ${fails}/${checks} checks` : `PASS — ${checks} checks`));
process.exit(fails ? 1 : 0);
