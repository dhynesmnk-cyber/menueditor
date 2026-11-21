// Probe: can we load jsPDF in node, embed Garamond TTF, and measure text?
const fs = require('fs');
const path = require('path');
const { jsPDF } = require('../vendor/jspdf.node.min.js');

const doc = new jsPDF({ unit: 'pt', format: [612, 792] });
const b64 = fs.readFileSync(path.join(__dirname, '../fonts/garamond.ttf')).toString('base64');
doc.addFileToVFS('garamond.ttf', b64);
doc.addFont('garamond.ttf', 'MGaramond', 'normal');

doc.setFont('MGaramond', 'normal');
doc.setFontSize(12);
const w1 = doc.getTextWidth('Braised short rib');
doc.setFontSize(24);
const w2 = doc.getTextWidth('Braised short rib');
console.log('width @12pt:', w1.toFixed(3), 'pt');
console.log('width @24pt:', w2.toFixed(3), 'pt');
console.log('ratio (should be 2.0):', (w2 / w1).toFixed(4));
console.log('family registered:', !!doc.getFontList()['MGaramond']);

doc.text('Braised short rib', 72, 200);
const buf = Buffer.from(doc.output('arraybuffer'));
fs.writeFileSync(path.join(__dirname, '../out/probe.pdf'), buf);
console.log('pdf bytes:', buf.length);
