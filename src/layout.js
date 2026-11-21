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

    function segText(seg) {
      var parts = seg.words.map(function (w) { return w.text.trim(); });
      if (seg.leaderAt != null) {
        return parts.slice(0, seg.leaderAt).join(' ') + ' …… ' +
               parts.slice(seg.leaderAt).join(' ');
      }
      return parts.join(' ');
    }

    // ---- 3. columns are established by TEXT segments only. A right-aligned
    // price must never found a column of its own, or every price in the menu
    // detaches from its dish and lands on a stranger.
    var textSegs = segments.filter(function (s) { return !s.isPrice; });
    var priceSegs = segments.filter(function (s) { return s.isPrice; });

    textSegs.sort(function (a, b) { return a.left - b.left; });
    var columns = [];
    textSegs.forEach(function (seg) {
      var target = null;
      for (var i = 0; i < columns.length; i++) {
        var c = columns[i];
        var overlap = Math.min(c.right, seg.right) - Math.max(c.left, seg.left);
        var narrower = Math.min(c.right - c.left, seg.right - seg.left) || 1;
        if (overlap > narrower * 0.5) { target = c; break; }
      }
      if (!target) {
        target = { left: seg.left, right: seg.right, segments: [] };
        columns.push(target);
      }
      target.segments.push(seg);
      target.left = Math.min(target.left, seg.left);
      target.right = Math.max(target.right, seg.right);
    });
    columns.sort(function (a, b) { return a.left - b.left; });

    // ---- 3b. every price goes to the nearest dish line *in its own column*
    priceSegs.forEach(function (p) {
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
      } else {
        hostCol.segments.push(p);
        hostCol.right = Math.max(hostCol.right, p.right);
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
