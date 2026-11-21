/* Design reading, tested against real menu images (160px raw-RGB fixtures). */
const fs = require('fs');
const path = require('path');
const MenuDesign = require('../src/design.js');

const FIX = path.join(__dirname, 'fixtures');
const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'index.json'), 'utf8'));

let fails = 0, checks = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { fails++; console.log('    FAIL ' + label); }
}

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

console.log('reading the reference menus\n');
for (const m of meta) {
  const buf = fs.readFileSync(path.join(FIX, m.name + '.rgb'));
  const read = MenuDesign.analyse(m.w, m.h, buf, { channels: 3 });
  const theme = MenuDesign.toTheme(read);

  console.log(m.file);
  console.log(`  ${read.px.w}x${read.px.h}  aspect ${read.aspect}`);
  console.log(`  paper ${read.paper} (${(read.paperShare * 100).toFixed(0)}% of pixels)  ` +
              `ink ${read.ink}  accents ${read.accents.join(' ') || '—'}`);
  console.log(`  margins l${(read.margins.left * 100).toFixed(0)}% r${(read.margins.right * 100).toFixed(0)}% ` +
              `t${(read.margins.top * 100).toFixed(0)}% b${(read.margins.bottom * 100).toFixed(0)}%` +
              `  ink coverage ${(read.inkCoverage * 100).toFixed(1)}%` +
              `  artwork border ${read.hasArtworkBorder ? 'yes' : 'no'}`);
  console.log(`  -> ${read.page.name} ${read.page.w}x${read.page.h}in, ` +
              `column x=${theme.column.x} w=${theme.column.w}\n`);

  // ---- invariants that must hold for any menu
  ok(lum(read.paper) > 0.80, 'paper is light');
  // resampled fixtures soften glyph interiors, so a light-grey body face can
  // read mid-tone here; the browser sees full-resolution pixels
  ok(lum(read.ink) < 0.45, 'ink is dark');
  ok(Math.abs(read.aspect - read.px.w / read.px.h) < 0.01, 'aspect matches pixels');
  ok(Math.abs((read.page.w / read.page.h) - read.aspect) < 0.04, 'page shape follows the image');
  ok(read.margins.left >= 0 && read.margins.left < 0.35, 'left margin plausible');
  ok(read.margins.left + read.margins.right < 0.5, 'columns have room');
  ok(theme.column.w > 1 && theme.column.w <= read.page.w, 'column fits the page');
  ok(read.inkCoverage > 0.005 && read.inkCoverage < 0.45, 'ink coverage plausible');
  ok(read.paperShare > 0.08, 'paper is the dominant colour');
}

console.log(fails ? `FAIL — ${fails}/${checks} checks` : `PASS — ${checks} checks over ${meta.length} menus`);
process.exit(fails ? 1 : 0);
