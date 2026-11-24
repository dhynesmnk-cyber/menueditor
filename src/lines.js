/* ============================================================================
   Canvas-mode guards for a PDF page kept exactly as it was designed.

   The line objects themselves come from the sidecar (sidecar/grouping.py), which
   has the glyph positions. This module holds the rules that keep an edit honest,
   with no DOM in sight so they can be tested in node:

     * fit      — a longer string must fit its own slot: shrink at most 8%, then
                  refuse. Beyond that the typographic hierarchy breaks silently.
     * drop     — a dragged line may not land on another line, on a rule/divider,
                  or off the page.
     * snap     — guides are the other lines' baselines and left edges.
     * edits    — patches that match the original are not edits at all.

   `measure(text, size, track)` returns a width in points; the browser passes a
   function backed by an SVG <text>, tests pass a stub.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuLines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_FIT = 0.92;    // 8% is invisible; more than that changes the hierarchy
  var HARD_FIT = 0.60;   // only with explicit consent
  var SNAP_PT = 2.5;     // snapping radius, in points
  var TOL = 0.6;         // overlap tolerance

  function num(v, d) {
    var n = parseFloat(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  /** Coerce a sidecar payload into the shape the editor uses.
   *
   * Accepts both shapes: the multi-page one ({pages:[...]}) and the older flat one
   * ({page, objects, vectors}), which the node fixture still uses.
   */
  function normalize(data) {
    var rawPages = (data && data.pages) || [{ index: 0,
      width: (data && data.page ? data.page.width : 595.28),
      height: (data && data.page ? data.page.height : 841.89),
      objects: (data && data.objects) || [], vectors: (data && data.vectors) || [],
      images: (data && data.images) || [], plate: (data && data.plate) || '' }];

    var pages = [], objects = [], gi = 0;
    rawPages.forEach(function (p, pno) {
      var pageObjects = [];
      (p.objects || []).forEach(function (o) {
        var obj = {
          gi: gi,
          page: pno,
          text: String(o.text || ''),
          x: num(o.x), y: num(o.y),
          ink_left: num(o.ink_left, num(o.x)),
          size: num(o.size, 10),
          font: o.font || '',
          color: o.color || '#000000',
          track: num(o.track_em),
          space_pt: num(o.space_pt, num(o.size, 10) * 0.25),
          ink_width: num(o.ink_width),
          max_width: num(o.max_width, num(o.ink_width)),
          letter_spaced: !!o.letter_spaced,
          glyph_x: (o.glyph_x || []).map(function (g) { return num(g); })
        };
        objects.push(obj);
        pageObjects.push(obj);
        gi += 1;
      });
      pages.push({
        index: pno,
        width: num(p.width, 595.28),
        height: num(p.height, 841.89),
        objects: pageObjects,
        vectors: (p.vectors || []).map(function (v) {
          return [num(v[0]), num(v[1]), num(v[2]), num(v[3])];
        }),
        images: (p.images || []).map(function (r) {
          return { x0: num(r.x0), y0: num(r.y0), x1: num(r.x1), y1: num(r.y1) };
        }),
        plate: p.plate || ''
      });
    });

    return {
      pages: pages,
      objects: objects,
      vectors: pages.length ? pages[0].vectors : [],
      page: { width: pages[0] ? pages[0].width : 595.28,
              height: pages[0] ? pages[0].height : 841.89 },
      fonts: (data && data.fonts) || {},
      plate: pages[0] ? pages[0].plate : '',
      warnings: (data && data.warnings) || []
    };
  }

  /** The starting tracking for a line: design intent only when it is space-tracked. */
  function baseTrack(object) {
    return object.letter_spaced ? object.track : 0;
  }

  function effective(objects, edits, i) {
    var o = objects[i];
    var e = (edits && edits.get ? edits.get(i) : (edits || {})[i]) || {};
    return {
      text: e.text !== undefined ? e.text : o.text,
      size: e.size !== undefined ? e.size : o.size,
      track: e.track !== undefined ? e.track : baseTrack(o),
      x: e.x !== undefined ? e.x : o.x,
      y: e.y !== undefined ? e.y : o.y
    };
  }

  /** What to draw now for line i: original glyphs, or a measured string. */
  function widthOf(objects, edits, i, measure) {
    var o = objects[i];
    var hasEdit = edits && (edits.has ? edits.has(i) : edits[i] !== undefined);
    if (!hasEdit) return o.ink_width;
    var v = effective(objects, edits, i);
    return measure(v.text, v.size, v.track) || o.ink_width;
  }

  function lineBox(x, y, size, width) {
    return { x0: x, y0: y - size * 0.78, x1: x + width, y1: y + size * 0.24 };
  }

  /**
   * Fit text into its slot. Returns the size actually used, the width, and whether
   * it fits. `maxWidth` is the object's own slack (text neighbour + rules).
   */
  function fit(object, text, size, track, measure, maxWidth, floor) {
    var minFit = floor || MIN_FIT;
    var max = maxWidth === undefined ? object.max_width : maxWidth;
    var w = measure(text, size, track);
    if (w <= max) return { size: size, track: track, w: w, max: max, fits: true };
    var scale = max / w;
    if (scale < minFit) return { size: size, track: track, w: w, max: max, fits: false };
    var s = Math.round(size * scale * 1000) / 1000;
    var w2 = measure(text, s, track);
    return { size: s, track: track, w: w2, max: max, fits: w2 <= max + 0.2 };
  }

  /** null when the drop is legal, otherwise the reason, phrased for the status line. */
  function dropClash(opts) {
    var objects = opts.objects, vectors = opts.vectors || [], page = opts.page;
    var i = opts.i, edits = opts.edits;
    var o0 = objects[i];
    var pg = o0.page;
    var b = lineBox(opts.x + (o0.ink_left - o0.x), opts.y, opts.size, opts.width);
    if (b.x0 < 2 || b.y0 < 2 || b.x1 > page.width - 2 || b.y1 > page.height - 2) return 'the page edge';
    for (var j = 0; j < objects.length; j++) {
      var o = objects[j];
      if (j === i || o.page !== pg) continue;
      var v = effective(objects, edits, j);
      var w = opts.widthOf ? opts.widthOf(j) : o.ink_width;
      var bb = lineBox(v.x + (o.ink_left - o.x), v.y, v.size, w);
      if (b.x0 < bb.x1 - TOL && bb.x0 < b.x1 - TOL && b.y0 < bb.y1 - TOL && bb.y0 < b.y1 - TOL) {
        return 'another line';
      }
    }
    for (var k = 0; k < vectors.length; k++) {
      var r = vectors[k];
      if (b.x0 < r[2] - TOL && r[0] < b.x1 - TOL && b.y0 < r[3] - TOL && r[1] < b.y1 - TOL) {
        return 'a rule';
      }
    }
    return null;
  }

  function snapTo(v, guides, radius) {
    var r = radius === undefined ? SNAP_PT : radius, best = null;
    for (var i = 0; i < guides.length; i++) {
      var d = Math.abs(guides[i] - v);
      if (d <= r && (best === null || d < best[1])) best = [guides[i], d];
    }
    return best ? best[0] : null;
  }

  function uniq(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var k = list[i].toFixed(2);
      if (!seen[k]) { seen[k] = 1; out.push(list[i]); }   // keep the exact value, dedupe by 0.01
    }
    return out;
  }

  /** Guides are the baselines and left edges of the document's own lines. */
  function guides(objects) {
    var xs = [], ys = [];
    for (var i = 0; i < objects.length; i++) { xs.push(objects[i].x); ys.push(objects[i].y); }
    return { xs: uniq(xs).sort(function (a, b) { return a - b; }),
             ys: uniq(ys).sort(function (a, b) { return a - b; }) };
  }

  /** Prune a patch that describes the original: that is not an edit. */
  function applyEdit(edits, objects, i, patch) {
    var o = objects[i];
    var cur = edits.get(i) || {};
    var next = {};
    var k;
    for (k in cur) next[k] = cur[k];
    for (k in patch) next[k] = patch[k];
    if (next.text === o.text) delete next.text;
    if (next.size !== undefined && Math.abs(next.size - o.size) < 0.01) delete next.size;
    if (next.track !== undefined && Math.abs(next.track - baseTrack(o)) < 0.002) delete next.track;
    if (next.x !== undefined && Math.abs(next.x - o.x) <= 0.05) delete next.x;
    if (next.y !== undefined && Math.abs(next.y - o.y) <= 0.05) delete next.y;
    if (Object.keys(next).length) edits.set(i, next); else edits.delete(i);
    return edits.get(i) || {};
  }

  /** Payload for the splice endpoint. `gi` is the document-wide object id. */
  function payload(edits, objects) {
    var out = [];
    edits.forEach(function (e, gi) {
      var v = effective(objects, edits, gi);
      var o = objects[gi];
      out.push({ gi: gi, i: gi, page: o ? o.page : 0, text: v.text, size: v.size,
                 track: v.track, x: v.x, y: v.y });
    });
    return out;
  }

  return {
    MIN_FIT: MIN_FIT, HARD_FIT: HARD_FIT, SNAP_PT: SNAP_PT,
    normalize: normalize, baseTrack: baseTrack, effective: effective, widthOf: widthOf,
    lineBox: lineBox, fit: fit, dropClash: dropClash, snapTo: snapTo, guides: guides,
    applyEdit: applyEdit, payload: payload
  };
});
