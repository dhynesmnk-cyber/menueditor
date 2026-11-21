// Does the TTF ratio parser work on the real font files? (same code as the page)
const fs = require('fs');

function baselineRatioFromTTF(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = dv.getUint16(4);
  let head = 0, hhea = 0, os2 = 0;
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    const off = dv.getUint32(o + 8);
    if (tag === 'head') head = off;
    else if (tag === 'hhea') hhea = off;
    else if (tag === 'OS/2') os2 = off;
  }
  const upem = dv.getUint16(head + 18);
  let A = dv.getInt16(hhea + 4) / upem;
  let D = -dv.getInt16(hhea + 6) / upem;
  if (os2) {
    const fsSelection = dv.getUint16(os2 + 62);
    if (fsSelection & (1 << 7)) {
      A = dv.getInt16(os2 + 68) / upem;
      D = -dv.getInt16(os2 + 70) / upem;
    }
  }
  return { ratio: (1 - (A + D)) / 2 + A, A, D, upem, head, hhea, os2 };
}

for (const f of ['garamond.ttf', 'garamond-bold.ttf', 'garamond-italic.ttf',
                 'Lato-Regular.ttf', 'Lato-Bold.ttf', 'Lato-Italic.ttf']) {
  const b = fs.readFileSync('/home/dhynesmnk/menu-studio/fonts/' + f);
  try {
    const r = baselineRatioFromTTF(b);
    console.log(f.padEnd(22), 'A=' + r.A.toFixed(4), 'D=' + r.D.toFixed(4),
                'ratio=' + r.ratio.toFixed(4), 'tables head/hhea/os2', r.head, r.hhea, r.os2);
  } catch (e) {
    console.log(f.padEnd(22), 'ERROR', e.message);
  }
}
