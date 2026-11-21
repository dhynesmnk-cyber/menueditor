/* ============================================================================
   MenuEngine — the single source of pagination truth.
   ----------------------------------------------------------------------------
   The browser never wraps text. Every block is decomposed here into a flat
   "display list" of absolutely positioned drawing primitives in PostScript
   points (1/72 in), with the page origin at the TRIM top-left. The screen
   renderer and the PDF exporter are both dumb consumers of that list, so
   they cannot disagree about a line break: the breaks are already decided.

   Works in node (require) and the browser (window.MenuEngine).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PT_PER_IN = 72;
  var ASC = 0.75;     // baseline sits 0.75em below the top of a line box
  var SAFETY = 0.4;   // pt kept off every wrap boundary so PDF advance
                      // rounding can never push a line past its box

  function pt(inch) { return inch * PT_PER_IN; }

  function trackingWidth(text, st) {
    var ls = st.tracking || 0;
    return (ls && text.length > 1) ? ls * (text.length - 1) : 0;
  }

  function createEngine(metrics) {
    // metrics := { width(text, {font,style,size}) -> pt }
    function wOf(text, st) {
      return metrics.width(text, st) + trackingWidth(text, st);
    }
    function ascPx(st) { return st.size * ASC; }

    function wrap(text, st, maxW) {
      var lim = maxW - SAFETY;
      var paras = String(text == null ? '' : text).split('\n');
      var out = [];
      for (var pi = 0; pi < paras.length; pi++) {
        var words = paras[pi].split(/\s+/).filter(function (s) { return s.length; });
        if (!words.length) { out.push(''); continue; }
        var line = '';
        for (var i = 0; i < words.length; i++) {
          var word = words[i];
          if (!line) {
            if (wOf(word, st) <= lim) { line = word; continue; }
            // a single word wider than the block: hard-break it
            var piece = '';
            for (var c = 0; c < word.length; c++) {
              var cand = piece + word.charAt(c);
              if (piece && wOf(cand, st) > lim) { out.push(piece); piece = word.charAt(c); }
              else piece = cand;
            }
            line = piece;
            continue;
          }
          var joined = line + ' ' + word;
          if (wOf(joined, st) <= lim) line = joined;
          else { out.push(line); line = word; }
        }
        if (line) out.push(line);
      }
      return out;
    }

    function alignedX(x, w, textW, align) {
      if (align === 'center') return x + (w - textW) / 2;
      if (align === 'right') return x + w - textW;
      return x;
    }

    function textEl(t, x, baseline, st, color) {
      return {
        k: 'text', t: t, x: x, baseline: baseline,
        size: st.size, font: st.font, style: st.style || 'normal',
        tracking: st.tracking || 0, color: color
      };
    }

    // ---- block layouts -----------------------------------------------------
    // each returns { els: [primitives], h: height in pt }

    var TYPES = {};

    TYPES.kicker = function (b, th) {
      var st = {
        font: b.font || th.fonts.body.family, style: b.style || 'bold',
        size: b.size || 7.2, tracking: b.tracking != null ? b.tracking : 2.2
      };
      var text = b.upper === false ? String(b.text || '') : String(b.text || '').toUpperCase();
      var x = pt(b.x), y = pt(b.y), w = pt(b.w);
      var lines = wrap(text, st, w), lh = st.size * 1.5, els = [];
      for (var i = 0; i < lines.length; i++) {
        var lw = wOf(lines[i], st);
        els.push(textEl(lines[i], alignedX(x, w, lw, b.align || 'center'),
          y + ascPx(st) + i * lh, st, b.color || th.accent));
      }
      return { els: els, h: lines.length * lh };
    };

    TYPES.title = function (b, th) {
      var st = {
        font: b.font || th.fonts.display.family, style: b.style || 'normal',
        size: b.size || 32, tracking: b.tracking != null ? b.tracking : 1.1
      };
      var x = pt(b.x), y = pt(b.y), w = pt(b.w);
      var lines = wrap(b.text, st, w), lh = st.size * (b.leading || 1.06), els = [];
      for (var i = 0; i < lines.length; i++) {
        var lw = wOf(lines[i], st);
        els.push(textEl(lines[i], alignedX(x, w, lw, b.align || 'center'),
          y + ascPx(st) + i * lh, st, b.color || th.ink));
      }
      return { els: els, h: lines.length * lh };
    };

    TYPES.subtitle = function (b, th) {
      var st = {
        font: b.font || th.fonts.body.family, style: b.style || 'normal',
        size: b.size || 9.6, tracking: b.tracking != null ? b.tracking : 0.9
      };
      var x = pt(b.x), y = pt(b.y), w = pt(b.w);
      var lines = wrap(b.text, st, w), lh = st.size * 1.5, els = [];
      for (var i = 0; i < lines.length; i++) {
        var lw = wOf(lines[i], st);
        els.push(textEl(lines[i], alignedX(x, w, lw, b.align || 'center'),
          y + ascPx(st) + i * lh, st, b.color || th.muted));
      }
      return { els: els, h: lines.length * lh };
    };

    TYPES.section = function (b, th) {
      var st = {
        font: b.font || th.fonts.body.family, style: b.style || 'bold',
        size: b.size || 8.6, tracking: b.tracking != null ? b.tracking : 2.0
      };
      var x = pt(b.x), y = pt(b.y), w = pt(b.w);
      var text = b.upper === false ? String(b.text || '') : String(b.text || '').toUpperCase();
      var lines = wrap(text, st, w), lh = st.size * 1.35, els = [];
      for (var i = 0; i < lines.length; i++) {
        var lw = wOf(lines[i], st);
        els.push(textEl(lines[i], alignedX(x, w, lw, b.align || 'center') + (b.align && b.align !== 'left' ? 0 : 0),
          y + ascPx(st) + i * lh, st, b.color || th.accent));
      }
      var h = lines.length * lh;
      if (b.rule !== false) {
        // rule is inset and centred under the label for a quieter look
        var inset = b.ruleInset != null ? b.ruleInset : 0;
        els.push({
          k: 'rule', x1: x + inset, x2: x + w - inset,
          y: y + h + 3.2, w: b.ruleWidth || 0.6, color: b.ruleColor || th.accent
        });
        h += 3.2 + 5.4;
      }
      return { els: els, h: h };
    };

    TYPES.item = function (b, th) {
      var nameSt = {
        font: b.nameFont || th.fonts.display.family, style: b.nameStyle || 'normal',
        size: b.size || 12.4, tracking: b.tracking != null ? b.tracking : 0.1
      };
      var priceSt = {
        font: b.priceFont || nameSt.font, style: b.priceStyle || nameSt.style,
        size: b.priceSize || nameSt.size, tracking: nameSt.tracking
      };
      var descSt = {
        font: b.descFont || th.fonts.body.family, style: b.descStyle || 'normal',
        size: b.descSize || 8.3, tracking: 0
      };
      var tagSt = {
        font: descSt.font, style: 'bold', size: b.tagSize || 6.6,
        tracking: b.tagTracking != null ? b.tagTracking : 1.1
      };

      var x = pt(b.x), y = pt(b.y), w = pt(b.w);
      var els = [];
      var price = (b.price == null || b.price === '') ? '' : String(b.price);
      var pw = price ? wOf(price, priceSt) : 0;
      var baseline = y + ascPx(nameSt);

      els.push(textEl(b.name || '', x, baseline, nameSt, b.color || th.ink));
      if (price) {
        els.push(textEl(price, x + w - pw, baseline, priceSt, b.priceColor || th.ink));
      }
      if (b.leader !== false && price) {
        var d1 = x + wOf(b.name || '', nameSt) + 4.5;
        var d2 = x + w - pw - 4.5;
        if (d2 - d1 > 8) {
          els.push({
            k: 'dots', x1: d1, x2: d2, y: baseline - nameSt.size * 0.2,
            r: b.dotSize || 0.5, gap: b.dotGap || 3.6,
            color: b.leaderColor || th.muted
          });
        }
      }

      var h = nameSt.size * 1.16;

      if (b.desc) {
        var dlines = wrap(b.desc, descSt, w);
        var dlh = descSt.size * (b.descLeading || 1.4);
        var dTop = y + h + 1.4;
        for (var i = 0; i < dlines.length; i++) {
          els.push(textEl(dlines[i], x, dTop + ascPx(descSt) + i * dlh, descSt, b.descColor || th.muted));
        }
        h = (dTop - y) + dlines.length * dlh;
      }

      if (b.tags && b.tags.length) {
        var tagText = b.tags.join('   ');
        h += 2.2;
        els.push(textEl(tagText, x, y + h + ascPx(tagSt), tagSt, b.tagColor || th.accent));
        h += tagSt.size * 0.9;
      }
      return { els: els, h: h };
    };

    TYPES.note = function (b, th) {
      var st = {
        font: b.font || th.fonts.body.family, style: b.style || 'italic',
        size: b.size || 7.4, tracking: b.tracking != null ? b.tracking : 0.4
      };
      var x = pt(b.x), y = pt(b.y), w = pt(b.w);
      var lines = wrap(b.text, st, w), lh = st.size * 1.55, els = [];
      for (var i = 0; i < lines.length; i++) {
        var lw = wOf(lines[i], st);
        els.push(textEl(lines[i], alignedX(x, w, lw, b.align || 'center'),
          y + ascPx(st) + i * lh, st, b.color || th.muted));
      }
      return { els: els, h: lines.length * lh };
    };

    TYPES.rule = function (b, th) {
      var x = pt(b.x), y = pt(b.y), w = pt(b.w);
      var els = [{
        k: 'rule', x1: x, x2: x + w, y: y + (b.size || 0),
        w: b.weight || 0.8, color: b.color || th.accent
      }];
      return { els: els, h: (b.size || 0) + (b.weight || 0.8) };
    };

    // ---- public ------------------------------------------------------------
    function layoutBlock(b, th) {
      var fn = TYPES[b.type];
      if (!fn) return { els: [], h: 0 };
      return fn(b, th);
    }

    function layout(menu) {
      var th = menu.theme, page = menu.page;
      var W = pt(page.w), H = pt(page.h);
      var dl = [], bounds = [];
      var blocks = menu.blocks || [];
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var r = layoutBlock(b, th);
        for (var k = 0; k < r.els.length; k++) dl.push(r.els[k]);
        bounds.push({
          id: b.id, type: b.type, x: pt(b.x), y: pt(b.y),
          w: pt(b.w), h: Math.max(r.h, 8)
        });
      }
      return {
        displayList: dl, bounds: bounds,
        page: { w: W, h: H },
        // content extent, for "does it fit" checks
        extent: bounds.reduce(function (m, b) { return Math.max(m, b.y + b.h); }, 0)
      };
    }

    return { layout: layout, layoutBlock: layoutBlock, wrap: wrap, wOf: wOf, TYPES: TYPES };
  }

  return {
    createEngine: createEngine,
    pt: pt,
    PT_PER_IN: PT_PER_IN,
    ASC: ASC
  };
});
