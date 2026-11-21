/* ============================================================================
   MenuPDF — dumb consumer of the display list.
   Draws each primitive with the embedded font at the exact coordinates the
   engine produced. No text wrapping, no reflow, no layout decisions happen
   here. If the screen and the PDF ever differ, the bug is in the engine,
   not in this file.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuPDF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PT = 72;

  function hexToRgb(hex) {
    var h = String(hex || '#000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  var COLOR_CACHE = {};
  function rgb(hex) {
    if (!COLOR_CACHE[hex]) COLOR_CACHE[hex] = hexToRgb(hex);
    return COLOR_CACHE[hex];
  }

  function cropMarks(pdf, pageW, pageH, bleed) {
    if (!(bleed > 0)) return;
    var len = 14, gap = 4;
    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.25);
    var t = [bleed, bleed, pageW - bleed, pageH - bleed]; // trim box
    // horizontal marks
    [[t[0], t[1], -1], [t[2], t[1], 1], [t[0], t[3], -1], [t[2], t[3], 1]].forEach(function (c) {
      var x = c[0], y = c[1], dir = c[2];
      pdf.line(x + dir * gap, y, x + dir * (gap + len), y);
    });
    // vertical marks
    [[t[0], t[1], -1], [t[0], t[3], 1], [t[2], t[1], -1], [t[2], t[3], 1]].forEach(function (c) {
      var x = c[0], y = c[1], dir = c[2];
      pdf.line(x, y + dir * gap, x, y + dir * (gap + len));
    });
  }

  /**
   * @param jsPDFCtor  the jsPDF constructor
   * @param menu       the menu model (page, theme, blocks)
   * @param lay        output of MenuEngine.layout(menu)
   * @param fonts      [{family, style, file, b64}]
   * @returns jsPDF document
   */
  function newDocument(jsPDFCtor, menu, lay, fonts, W, H) {
    var pdf = new jsPDFCtor({ unit: 'pt', format: [W, H], compress: true });
    pdf.setProperties({
      title: (menu.meta && menu.meta.name) || 'Menu',
      creator: 'Menu Studio (spike)',
      subject: 'Print menu'
    });
    (fonts || []).forEach(function (f) {
      var vfsName = f.family + '-' + f.style + '.ttf';
      pdf.addFileToVFS(vfsName, f.b64);
      pdf.addFont(vfsName, f.family, f.style);
    });
    return pdf;
  }

  function drawPage(pdf, menu, lay, W, H) {
    var bleed = (menu.page.bleed || 0) * PT;

    // paper
    var paper = rgb(menu.theme.paper || '#FFFFFF');
    pdf.setFillColor(paper[0], paper[1], paper[2]);
    pdf.rect(0, 0, W, H, 'F');

    var ox = bleed, oy = bleed;
    lay.displayList.forEach(function (e) {
      if (e.k === 'text') {
        var c = rgb(e.color);
        pdf.setFont(e.font, e.style);
        pdf.setFontSize(e.size);
        pdf.setTextColor(c[0], c[1], c[2]);
        pdf.text(e.t, e.x + ox, e.baseline + oy, { charSpace: e.tracking || 0 });
      } else if (e.k === 'dots') {
        var dc = rgb(e.color);
        pdf.setFillColor(dc[0], dc[1], dc[2]);
        for (var x = e.x1; x <= e.x2; x += e.gap) {
          pdf.circle(x + ox, e.y + oy, e.r, 'F');
        }
      } else if (e.k === 'rule') {
        var rc = rgb(e.color);
        pdf.setDrawColor(rc[0], rc[1], rc[2]);
        pdf.setLineWidth(e.w || 0.6);
        pdf.line(e.x1 + ox, e.y + oy, e.x2 + ox, e.y + oy);
      }
    });

    if (menu.page.cropMarks) cropMarks(pdf, W, H, bleed);
  }

  function renderPDF(jsPDFCtor, menu, lay, fonts) {
    var bleed = (menu.page.bleed || 0) * PT;
    var W = lay.page.w + bleed * 2;
    var H = lay.page.h + bleed * 2;
    var pdf = newDocument(jsPDFCtor, menu, lay, fonts, W, H);
    drawPage(pdf, menu, lay, W, H);
    return pdf;
  }

  /**
   * Multi-page export: one sheet per page, same trim and crop marks.
   * @param menus  array of menu models, one per page
   * @param lays   array of engine.layout() results, index-matched
   */
  function renderPDFPages(jsPDFCtor, menus, lays, fonts) {
    if (!menus || !menus.length) throw new Error('renderPDFPages needs at least one menu');
    if (menus.length !== lays.length) throw new Error('menus and lays must match');
    var first = menus[0];
    var bleed = (first.page.bleed || 0) * PT;
    var W = lays[0].page.w + bleed * 2;
    var H = lays[0].page.h + bleed * 2;

    var pdf = newDocument(jsPDFCtor, first, lays[0], fonts, W, H);
    menus.forEach(function (menu, i) {
      if (i > 0) pdf.addPage([W, H]);
      drawPage(pdf, menu, lays[i], W, H);
    });
    return pdf;
  }

  return { renderPDF: renderPDF, renderPDFPages: renderPDFPages, hexToRgb: hexToRgb };
});
