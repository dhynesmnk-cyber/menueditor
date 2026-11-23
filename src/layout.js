/* ============================================================================
   Layout reconstruction from word boxes.
   ----------------------------------------------------------------------------
   Whole-page OCR reads across columns ("SPRITZ ROYALE 18 HORS D'OEUVRES BRUNCH
   Almond Crotssont 7"), which destroys a menu's structure. But both OCR engines
   and PDF text extractors hand back words with coordinates, so the fix is to
   ignore their reading order entirely and rebuild it:

       words[{text,x,y,w,h}] -> lines -> segments (split at wide gaps)
                             -> columns (segment x-clusters) -> text per column

   The same function serves a scanned PNG and a born-digital PDF: only the
   source of the boxes differs.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function median(nums) {
    if (!nums.length) return 0;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /**
   * @param words  [{ text, x, y, w, h }] — y is the TOP of the word box
   * @param opts   { minConfidence, pageWidth }
   */
  function reconstruct(words, opts) {
    opts = opts || {};
    var src = (words || []).filter(function (w) {
      if (!w || typeof w.text !== 'string' || !w.text.trim().length || !(w.w > 0) || !(w.h > 0)) return false;
      if (w.conf == null) return true;
      // engines disagree: tesseract reports 0-100, RapidOCR/Paddle 0-1
      var conf = w.conf <= 1 ? w.conf * 100 : w.conf;
      return conf >= (opts.minConfidence == null ? 35 : opts.minConfidence);
    });
    if (!src.length) return { text: '', columns: [], stats: { words: 0, lines: 0, columns: 0 } };

    var medH = median(src.map(function (w) { return w.h; }));
    var pageW = opts.pageWidth || (Math.max.apply(null, src.map(function (w) { return w.x + w.w; })));

    // ---- 1. group words into visual lines by their vertical centre
    var byY = src.slice().sort(function (a, b) { return (a.y + a.h / 2) - (b.y + b.h / 2); });
    var lines = [];
    byY.forEach(function (w) {
      var cy = w.y + w.h / 2;
      var line = null;
      for (var i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
        if (Math.abs(lines[i].cy - cy) <= medH * 0.55) { line = lines[i]; break; }
      }
      if (!line) {
        line = { cy: cy, words: [], top: w.y, bottom: w.y + w.h };
        lines.push(line);
      }
      line.words.push(w);
      line.cy = (line.cy * (line.words.length - 1) + cy) / line.words.length;
      line.top = Math.min(line.top, w.y);
      line.bottom = Math.max(line.bottom, w.y + w.h);
    });
    lines.sort(function (a, b) { return a.cy - b.cy; });

    // ---- 1b. rejoin letter-spaced text
    // Tracked headings ("T O   B E G I N") arrive as one box per character from
    // both OCR and PDF text extractors. Left alone they destroy section
    // detection, so runs of single characters are knitted back together, with a
    // space wherever the gap is clearly wider than the tracking.
    lines.forEach(function (line) {
      line.words.sort(function (a, b) { return a.x - b.x; });
      var out = [];
      var i = 0;
      while (i < line.words.length) {
        var w = line.words[i];
        if (w.text.trim().length !== 1) { out.push(w); i++; continue; }
        var run = [w];
        var j = i + 1;
        while (j < line.words.length &&
               line.words[j].text.trim().length === 1 &&
               line.words[j].x - (line.words[j - 1].x + line.words[j - 1].w) < w.w * 2.2) {
          run.push(line.words[j]);
          j++;
        }
        if (run.length < 2) { out.push(w); i = j; continue; }
        var gaps = [];
        for (var k = 1; k < run.length; k++) {
          gaps.push(run[k].x - (run[k - 1].x + run[k - 1].w));
        }
        var medGap = median(gaps);
        var text = run[0].text.trim();
        for (var g = 0; g < gaps.length; g++) {
          text += (gaps[g] > medGap * 1.7 ? ' ' : '') + run[g + 1].text.trim();
        }
        out.push({
          text: text,
          x: run[0].x, y: run[0].y,
          w: (run[run.length - 1].x + run[run.length - 1].w) - run[0].x,
          h: Math.max.apply(null, run.map(function (r) { return r.h; })),
        });
        i = j;
      }
      line.words = out;
    });

    // ---- 2. split each line into segments at gaps much wider than a space
    var advances = [];
    src.forEach(function (w) {
      var chars = w.text.trim().length || 1;
      advances.push(w.w / chars);
    });
    var medAdvance = median(advances) || medH * 0.5;
    var bigGap = Math.max(medAdvance * 3.2, medH * 0.9);

    var segments = [];
    var PRICEISH = /^[£$€]?\d[\d.,/ ]*$/;
    var LEADER_GAP = opts.leaderGap == null ? bigGap * 3 : opts.leaderGap;

    lines.forEach(function (line) {
      line.words.sort(function (a, b) { return a.x - b.x; });
      var raw = [];
      var cur = null;
      line.words.forEach(function (w) {
        var prev = cur && cur.words[cur.words.length - 1];
        if (!cur || (prev && w.x - (prev.x + prev.w) > bigGap)) {
          cur = { words: [w], left: w.x, right: w.x + w.w, cy: line.cy,
                  top: line.top, bottom: line.bottom };
          raw.push(cur);
        } else {
          cur.words.push(w);
          cur.right = Math.max(cur.right, w.x + w.w);
        }
      });

      // A right-aligned price lands in its own x-cluster, which would otherwise
      // be mistaken for a second column and detach every price from its dish.
      // Price-like tails are folded back into the line they belong to, joined
      // with a leader the parser already understands.
      var merged = [];
      raw.forEach(function (seg) {
        var joined = seg.words.map(function (w) { return w.text.trim(); }).join(' ');
        var isPrice = seg.words.length <= 3 && PRICEISH.test(joined);
        var target = merged[merged.length - 1];
        if (isPrice && target && target.leaderAt == null && !target.isPrice) {
          target.words = target.words.concat(seg.words);
          target.leaderAt = target.words.length - seg.words.length;
          target.right = Math.max(target.right, seg.right);
          return;
        }
        seg.isPrice = isPrice;
        merged.push(seg);
      });
      merged.forEach(function (s) { segments.push(s); });
    });

    // A letter-spaced heading arrives as ONE run whose text has spaces between
    // the letters ("C H A A T / S T R E E T S N A C K S"), so the words cannot
    // be rejoined by their box gaps — collapse the letters inside the run.
    function deLetterSpace(s) {
      var toks = String(s).split(/\s+/).filter(Boolean);
      if (toks.length < 3) return s;
      var singles = toks.filter(function (t) { return t.length === 1; }).length;
      if (singles < toks.length * 0.6) return s;
      return toks.join('').replace(/([\/·—–])/g, ' $1 ').replace(/\s{2,}/g, ' ').trim();
    }

    function segText(seg) {
      var ws = seg.words;
      var parts = ws.map(function (w) { return deLetterSpace(w.text.trim()); });
      if (seg.leaderAt != null) {
        return parts.slice(0, seg.leaderAt).join(' ') + ' …… ' +
               parts.slice(seg.leaderAt).join(' ');
      }

      // A letter-spaced heading arrives one character per box ("C H A A T").
      // Join the letters, and put a space back only where the gap is clearly
      // wider than the letter spacing.
      var singles = ws.filter(function (w) { return w.text.trim().length === 1; }).length;
      if (ws.length >= 4 && singles >= ws.length * 0.6) {
        var gaps = [];
        for (var i = 1; i < ws.length; i++) gaps.push(ws[i].x - (ws[i - 1].x + ws[i - 1].w));
        var sorted = gaps.slice().sort(function (a, b) { return a - b; });
        var medGap = sorted[Math.floor(sorted.length / 2)] || 1;
        var out = parts[0];
        for (var j = 1; j < ws.length; j++) {
          var tok = parts[j];
          var wide = gaps[j - 1] > medGap * 1.9 || /^[\/·—–]$/.test(tok) || /[\/·—–]$/.test(parts[j - 1]);
          out += wide ? ' ' + tok : tok;
        }
        return out.replace(/\s{2,}/g, ' ').trim();
      }
      return parts.join(' ');
    }

    // ---- 3. columns come from where text STARTS.
    // A whitespace projection works on a clean grid and fails on a real menu:
    // section rules, boxed panels and centred headings all bridge the gutter, so
    // no x-band is ever empty (measured: a four-zone A4 menu produced zero empty
    // bins and was read as one column). But a column is a place text starts, and
    // the items in it share a left edge.
    var pageW = Math.max.apply(null, segments.map(function (s) { return s.right; })) || 1;
    var yMin = Math.min.apply(null, segments.map(function (s) { return s.cy; }));
    var yMax = Math.max.apply(null, segments.map(function (s) { return s.cy; }));
    var bodyTop = yMin + (yMax - yMin) * 0.12;

    // mastheads and full-width rules are not column evidence
    var candidates = segments.filter(function (s) {
      return (s.right - s.left) < pageW * 0.42 && s.cy >= bodyTop;
    });
    if (candidates.length < 2) candidates = segments.slice();

    var BIN = 4;
    var hist = {};
    candidates.forEach(function (s) {
      var k = Math.round(s.left / BIN);
      hist[k] = (hist[k] || 0) + 1;
    });

    // smooth over +/-2 bins: right-aligned text scatters across a few points
    var peaks = [];
    Object.keys(hist).forEach(function (k) {
      var n = 0;
      for (var d = -2; d <= 2; d++) n += hist[+k + d] || 0;
      peaks.push({ left: +k * BIN, n: n });
    });
    peaks.sort(function (a, b) { return a.left - b.left; });

    // 6% of segments is enough to be a column, and still too many for a centred
    // heading (which appears once) to qualify
    var minCount = Math.max(3, Math.round(candidates.length * 0.06));
    var minSep = pageW * 0.08;
    var anchors = [];
    peaks.forEach(function (p) {
      if (p.n < minCount) return;
      var last = anchors[anchors.length - 1];
      if (last && p.left - last.left < minSep) {
        if (p.n > last.n) { last.left = p.left; last.n = p.n; }
      } else {
        anchors.push({ left: p.left, n: p.n });
      }
    });
    if (!anchors.length) anchors = [{ left: pageW * 0.06, n: candidates.length }];

    var columns = anchors.map(function (a) {
      return { left: a.left, right: a.left + pageW * 0.12, segments: [] };
    });
    segments.forEach(function (seg) {
      var best = 0;
      for (var i = 0; i < columns.length; i++) {
        if (columns[i].left <= seg.left + minSep * 0.5) best = i;
      }
      columns[best].segments.push(seg);
      columns[best].right = Math.max(columns[best].right, seg.right);
    });
    columns = columns.filter(function (c) { return c.segments.length; });
    columns.sort(function (a, b) { return a.left - b.left; });

    // ---- 3b. every price goes to the nearest dish line *in its own column*
    segments.filter(function (s) { return s.isPrice; }).forEach(function (p) {
      var cx = (p.left + p.right) / 2, hostCol = null, colD = Infinity;
      columns.forEach(function (c) {
        var d = cx < c.left ? c.left - cx : cx > c.right ? cx - c.right : 0;
        if (d < colD) { colD = d; hostCol = c; }
      });
      if (!hostCol) return;

      var host = null, hostD = Infinity;
      hostCol.segments.forEach(function (s) {
        if (s.leaderAt != null || s.isPrice) return;
        if (p.left < s.right - 1) return;              // price sits to the right
        var d = Math.abs(s.cy - p.cy);
        if (d < hostD) { hostD = d; host = s; }
      });

      if (host && hostD <= medH * 1.4) {
        host.words = host.words.concat(p.words);
        host.leaderAt = host.words.length - p.words.length;
        host.right = Math.max(host.right, p.right);
        if (hostCol.right < p.right) hostCol.right = p.right;
      }
    });

    // ---- 4. read out: column by column, top to bottom, blank line at big breaks
    var lineStep = median(lines.map(function (l, i) {
      return i ? l.cy - lines[i - 1].cy : 0;
    }).filter(function (v) { return v > 0; })) || medH * 1.6;
    var bigBreak = lineStep * 1.75;

    var out = [];
    columns.forEach(function (c, ci) {
      c.segments.sort(function (a, b) { return a.cy - b.cy; });
      var prevCy = null;
      var textLines = [];
      c.segments.forEach(function (seg) {
        if (prevCy !== null && seg.cy - prevCy > bigBreak) textLines.push('');
        textLines.push(segText(seg));
        prevCy = seg.cy;
      });
      c.text = textLines.join('\n');
      if (ci > 0) out.push('');
      out.push(c.text);
    });

    return {
      text: out.join('\n'),
      columns: columns.map(function (c, i) {
        return { index: i, left: c.left, right: c.right, segments: c.segments.length, text: c.text };
      }),
      stats: {
        words: src.length, lines: lines.length, segments: segments.length,
        columns: columns.length, pageW: pageW, medianHeight: medH
      }
    };
  }

  return { reconstruct: reconstruct, median: median };
});
