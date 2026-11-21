/* ============================================================================
   Design reading from a menu image.
   ----------------------------------------------------------------------------
   Takes raw pixels and reports the decisions a designer already made: paper and
   ink colour, accents, page aspect, content margins, whether artwork runs to the
   edge, and how dense the page is. Enough to build a theme that matches a
   reference, and to know where to put the column.

   Deliberately does NOT guess column count from pixels: rules, boxes and
   watermark flourishes fake gutters, and right-aligned prices look like a
   column. Columns come from word boxes instead (src/layout.js).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuDesign = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STANDARD = [
    { name: 'Letter', w: 8.5, h: 11 },
    { name: 'A4', w: 8.27, h: 11.69 },
    { name: 'Half letter', w: 5.5, h: 8.5 },
    { name: 'A5', w: 5.83, h: 8.27 },
    { name: 'DL / slim', w: 3.7, h: 8.5 },
    { name: 'A4 landscape', w: 11.69, h: 8.27 },
    { name: 'Letter landscape', w: 11, h: 8.5 },
    { name: 'Square', w: 8.5, h: 8.5 }
  ];

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

  function luminance(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function saturation(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  }

  function hex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      var s = clamp255(v).toString(16);
      return s.length < 2 ? '0' + s : s;
    }).join('').toUpperCase();
  }

  /**
   * @param width,height  pixel dimensions
   * @param data          RGBA (4 bytes/px) or RGB (3 bytes/px)
   */
  function analyse(width, height, data, opts) {
    opts = opts || {};
    var ch = opts.channels || 4;
    var n = width * height;
    if (!n || !data || data.length < n * ch) {
      return null;
    }

    // ---- exact-colour histogram. Menus are flat artwork, so the paper and the
    // ink each occupy one near-exact colour; averaging or quantising blurs a
    // cream page into grey.
    var hist = new Map();
    var step = 1;
    for (var i = 0; i < n; i += step) {
      var o = i * ch;
      var key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      hist.set(key, (hist.get(key) || 0) + 1);
    }
    var sorted = [...hist.entries()].sort(function (a, b) { return b[1] - a[1]; });

    function unhex(k) { return [(k >> 16) & 255, (k >> 8) & 255, k & 255]; }

    // paper: the most common light colour
    var paper = null;
    for (var s = 0; s < sorted.length && s < 2000; s++) {
      var c = unhex(sorted[s][0]);
      if (luminance(c[0], c[1], c[2]) > 0.62) { paper = { rgb: c, share: sorted[s][1] / n }; break; }
    }
    if (!paper) {
      var c0 = unhex(sorted[0][0]);
      paper = { rgb: c0, share: sorted[0][1] / n };
    }

    // ink: darkest slice of pixels, averaged (thin text is mostly edge pixels)
    var dark = [];
    for (var j = 0; j < n; j += 3) {
      var oj = j * ch;
      var l = luminance(data[oj], data[oj + 1], data[oj + 2]);
      if (l < 0.45) dark.push([l, data[oj], data[oj + 1], data[oj + 2]]);
    }
    dark.sort(function (a, b) { return a[0] - b[0]; });
    var take = Math.max(1, Math.floor(dark.length * 0.004));
    var inkRGB = [0, 0, 0];
    if (dark.length) {
      for (var d = 0; d < take; d++) {
        inkRGB[0] += dark[d][1]; inkRGB[1] += dark[d][2]; inkRGB[2] += dark[d][3];
      }
      inkRGB = inkRGB.map(function (v) { return v / take; });
    }

    // accents: bin the *saturated* pixels by hue. Exact-colour modes miss a
    // menu's red rules and navy caps — they are thin strokes, and any resampling
    // smears them into hundreds of near-identical colours.
    var hueBins = {};
    for (var hi = 0; hi < n; hi += 2) {
      var ho = hi * ch;
      var hr = data[ho], hg = data[ho + 1], hb = data[ho + 2];
      var sat = saturation(hr, hg, hb);
      if (sat < 0.25) continue;
      if (luminance(hr, hg, hb) > 0.85) continue;
      var mx = Math.max(hr, hg, hb), mn = Math.min(hr, hg, hb), hu;
      if (mx === mn) continue;
      if (mx === hr) hu = ((hg - hb) / (mx - mn) + 6) % 6;
      else if (mx === hg) hu = (hb - hr) / (mx - mn) + 2;
      else hu = (hr - hg) / (mx - mn) + 4;
      var bin = Math.floor(hu * 60 / 30);           // 12 bins of 30°
      var b = hueBins[bin] || (hueBins[bin] = { n: 0, r: 0, g: 0, b: 0, s: 0 });
      b.n++; b.r += hr; b.g += hg; b.b += hb; b.s += sat;
    }
    var accents = Object.keys(hueBins)
      .map(function (k) { return hueBins[k]; })
      .filter(function (b) { return b.n / n > 0.0008; })
      .sort(function (a, b) { return (b.n * (0.4 + b.s / b.n)) - (a.n * (0.4 + a.s / a.n)); })
      .slice(0, 3)
      .map(function (b) {
        return hex(b.r / b.n, b.g / b.n, b.b / b.n);
      });

    // ---- content bbox against the paper colour, using percentiles so that a
    // stray photo pixel or a border rule touching the trim cannot claim the
    // whole page as content
    var pr = paper.rgb[0], pg = paper.rgb[1], pb = paper.rgb[2];
    var inset = hasArtworkBorder ? 0.08 : 0;
    var xa = Math.floor(width * inset), xb = Math.ceil(width * (1 - inset));
    var ya = Math.floor(height * inset), yb = Math.ceil(height * (1 - inset));
    var colHits = new Int32Array(width), rowHits = new Int32Array(height), inkCount = 0;
    for (var y = ya; y < yb; y++) {
      for (var x = xa; x < xb; x++) {
        var p = (y * width + x) * ch;
        var diff = Math.abs(data[p] - pr) + Math.abs(data[p + 1] - pg) + Math.abs(data[p + 2] - pb);
        if (diff > 55) { colHits[x]++; rowHits[y]++; inkCount++; }
      }
    }
    function percentileEdge(hits, from, to, total, frac) {
      var target = total * frac, acc = 0;
      if (from <= to) {
        for (var i = from; i <= to; i++) { acc += hits[i]; if (acc >= target) return i; }
      } else {
        for (var j = from; j >= to; j--) { acc += hits[j]; if (acc >= target) return j; }
      }
      return from;
    }
    var minX = width, maxX = -1, minY = height, maxY = -1;
    if (inkCount) {
      minX = percentileEdge(colHits, 0, width - 1, inkCount, 0.004);
      maxX = percentileEdge(colHits, width - 1, 0, inkCount, 0.004);
      minY = percentileEdge(rowHits, 0, height - 1, inkCount, 0.004);
      maxY = percentileEdge(rowHits, height - 1, 0, inkCount, 0.004);
    }
    var margins = maxX < 0 ? { left: 0, right: 0, top: 0, bottom: 0 } : {
      left: minX / width, right: 1 - (maxX + 1) / width,
      top: minY / height, bottom: 1 - (maxY + 1) / height
    };

    // ---- artwork to the edge? sample the border band vs the middle
    function bandStats(pred) {
      var rs = 0, cnt = 0, sq = 0;
      for (var yy = 0; yy < height; yy++) {
        for (var xx = 0; xx < width; xx++) {
          if (!pred(xx, yy)) continue;
          var q = (yy * width + xx) * ch;
          rs += data[q]; cnt++;
          sq += data[q] * data[q];
        }
      }
      if (!cnt) return 0;
      var mean = rs / cnt;
      return Math.sqrt(Math.max(0, sq / cnt - mean * mean));
    }
    function borderPred(x, y) {
      return x < width * 0.02 || x > width * 0.98 || y < height * 0.02 || y > height * 0.98;
    }
    function corePred(x, y) {
      return x > width * 0.2 && x < width * 0.8 && y > height * 0.2 && y < height * 0.8;
    }
    var border = bandStats(borderPred);
    var core = bandStats(corePred);
    var hasArtworkBorder = border > core * 1.6 && border > 18;

    // The page colour is whatever the frame is painted with — photographers and
    // florists aside, a menu's outer edge is its paper, and reading it there is
    // far steadier than taking the global mode of a scanned, resampled image.
    if (!hasArtworkBorder) {
      var frameHist = new Map();
      var fx0 = width * 0.02, fx1 = width * 0.98, fy0 = height * 0.02, fy1 = height * 0.98;
      for (var fy = 0; fy < height; fy++) {
        for (var fx = 0; fx < width; fx++) {
          var inFrame = (fx >= fx0 && fx <= fx1 && fy >= fy0 && fy <= fy1) &&
                        !(fx > width * 0.10 && fx < width * 0.90 && fy > height * 0.10 && fy < height * 0.90);
          if (!inFrame) continue;
          var fo = (fy * width + fx) * ch;
          var fk = (data[fo] << 16) | (data[fo + 1] << 8) | data[fo + 2];
          frameHist.set(fk, (frameHist.get(fk) || 0) + 1);
        }
      }
      var frameTop = [...frameHist.entries()].sort(function (a, b) { return b[1] - a[1]; })[0];
      if (frameTop) {
        var fc = unhex(frameTop[0]);
        if (luminance(fc[0], fc[1], fc[2]) > 0.55) paper = { rgb: fc, share: frameTop[1] / n };
      }
    }

    var aspect = width / height;
    var page = pageForAspect(aspect);

    return {
      paper: hex(paper.rgb[0], paper.rgb[1], paper.rgb[2]),
      paperShare: +paper.share.toFixed(3),
      ink: hex(inkRGB[0], inkRGB[1], inkRGB[2]),
      accents: accents,
      aspect: +aspect.toFixed(3),
      page: page,
      margins: {
        left: +margins.left.toFixed(3), right: +margins.right.toFixed(3),
        top: +margins.top.toFixed(3), bottom: +margins.bottom.toFixed(3)
      },
      hasArtworkBorder: border > core * 1.6 && border > 18,
      inkCoverage: +(inkCount / n).toFixed(4),
      px: { w: width, h: height }
    };
  }

  /** Nearest standard sheet, or the exact aspect scaled to an 11in long side. */
  function pageForAspect(aspect) {
    var best = null, bestErr = 1e9;
    STANDARD.forEach(function (p) {
      var err = Math.abs((p.w / p.h) - aspect);
      if (err < bestErr) { bestErr = err; best = p; }
    });
    if (bestErr < 0.035) {
      return { w: best.w, h: best.h, name: best.name, standard: true };
    }
    var long = 11;
    return aspect >= 1
      ? { w: long, h: +(long / aspect).toFixed(2), name: 'Custom ' + long + '×' + (long / aspect).toFixed(1), standard: false }
      : { w: +(long * aspect).toFixed(2), h: long, name: 'Custom ' + (long * aspect).toFixed(1) + '×' + long, standard: false };
  }

  /**
   * Design read -> a theme + page + column geometry the builder can use.
   */
  function toTheme(read, opts) {
    opts = opts || {};
    var page = read.page;
    var accent = read.accents && read.accents.length ? read.accents[0] : '#A3542C';
    var margins = read.margins;
    // ink that is nearly black reads as a default; keep it, but nudge very
    // light inks darker so the menu stays legible in print
    var ink = read.ink;
    var colW = Math.max(2.2, page.w * (1 - margins.left - margins.right));
    var colX = page.w * margins.left;
    return {
      palette: { paper: read.paper, ink: ink, accent: accent, muted: opts.muted || mix(read.ink, read.paper, 0.45) },
      page: { unit: 'in', w: page.w, h: page.h, bleed: 0.125, cropMarks: true },
      column: { x: +colX.toFixed(3), w: +colW.toFixed(3) },
      reference: {
        aspect: read.aspect, hasArtworkBorder: read.hasArtworkBorder,
        inkCoverage: read.inkCoverage
      }
    };
  }

  /** simple RGB mix, t towards b */
  function mix(a, b, t) {
    function parse(h) {
      h = h.replace('#', '');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    var A = parse(a), B = parse(b);
    return hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }

  return { analyse: analyse, toTheme: toTheme, pageForAspect: pageForAspect, mix: mix, STANDARD: STANDARD };
});
