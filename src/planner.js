/* ============================================================================
   The reasoning layer: content + reference design -> a page plan.
   ----------------------------------------------------------------------------
   src/design.js answers "what does this reference look like" (palette, page,
   margins). src/layout.js answers "what does the reference say, and in what
   columns". Neither answers the question the template actually needs:

       given THESE sections, on THIS page, in THESE columns — where does each
       section start, and what does an item look like inside it?

   That is this file. It measures, packs, and returns positions. The engine then
   renders the plan; the planner never draws anything.

   Two decisions worth calling out:

   1. Columns come from the reference, not from a guess. A 4-zone Pastis menu
      rendered in one column is not a styling problem, it is a wrong plan.
   2. Sections are packed in reading order and never reordered. A menu's section
      order is editorial — "Sandwiches before Desserts" is a decision someone
      made — so the packer balances by moving whole sections to the next column,
      never by sorting them.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuPlanner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PT = 72;

  // ---- type roles. A reference has more than one kind of line; the template
  // has to know which is which or everything gets the same weight.
  var ROLES = {
    kicker:   { size: 8,  tracking: 2.2, case: 'upper', color: 'accent' },
    title:    { size: 46, tracking: 0,   case: 'upper', color: 'accent' },
    subtitle: { size: 9,  tracking: 2.6, case: 'upper', color: 'ink' },
    heading:  { size: 10, tracking: 2.4, case: 'upper', color: 'accent' },
    item:     { size: 10, tracking: 0,   case: 'title', color: 'ink' },
    desc:     { size: 7,  tracking: 0,   case: 'none',  color: 'muted' },
    price:    { size: 10, tracking: 0,   case: 'keep',  color: 'ink' }
  };

  function isCaps(s) {
    return typeof s === 'string' && /[A-Z]/.test(s) && !/[a-z]/.test(s);
  }

  /**
   * What does an item in this section look like? Inferred from the content, not
   * assumed: a wine list has no descriptions, a cocktail list is all caps with a
   * tiny ingredient line, a food menu is Title Case with an inline description.
   */
  function inferPattern(section) {
    var items = section.items || [];
    var n = items.length || 1;
    var descs = items.filter(function (i) { return i.desc && i.desc.trim(); }).length;
    var caps = items.filter(function (i) { return isCaps(i.name); }).length;
    var short = items.filter(function (i) { return (i.name || '').length <= 14; }).length;

    return {
      hasDesc: descs > 0 && descs >= Math.max(1, Math.round(n * 0.25)),
      descRate: +(descs / n).toFixed(2),
      nameCase: caps > n * 0.6 ? 'upper' : 'title',
      nameTracking: caps > n * 0.6 ? 0.9 : 0,
      // a list of very short all-caps names with no descriptions is a drinks
      // group: centre it and let the price sit right, as the references do
      centred: caps > n * 0.6 && short > n * 0.5 && descs === 0,
      priceStyle: descs / n > 0.5 ? 'leader' : 'right'
    };
  }

  /**
   * Height of a section at a given column width, in inches.
   * measure(text, role) is optional — without it this estimates from character
   * counts, which is what the packer needs (it is balancing, not typesetting).
   */
  function sectionHeight(section, width, pattern, opts) {
    var ts = opts.typeScale || 1;
    // When a caller can measure the way the builder will render, use that — an
    // estimate and a render that disagree is how a plan promises a fit the page
    // cannot keep (measured 1.0in predicted vs 2.6in real before this existed).
    if (opts.blockHeight) {
      return opts.blockHeight(section, width, pattern, ts);
    }
    var m = opts.measure;
    var lh = opts.lineHeight || 1.35;

    function lines(text, role) {
      var size = ROLES[role].size * ts;
      if (m) {
        // measurer gets the resolved size so a caller can measure with the real
        // font at the real point size, instead of estimating from characters
        var per = Math.max(1, Math.floor((width * PT) / Math.max(1, m('x', role, size))));
        return Math.max(1, Math.ceil(text.length / per));
      }
      var cpl = Math.max(6, Math.floor(width / ((size / PT) * 0.5)));
      return Math.max(1, Math.ceil(text.length / cpl));
    }

    var h = 0;
    h += lines(section.title || '', 'heading') * ROLES.heading.size * ts * lh / PT;
    h += 0.10 * ts;                               // rule + space under the heading
    h += (opts.sectionGap == null ? 0.16 : opts.sectionGap) * ts;

    (section.items || []).forEach(function (it) {
      var nameLines = lines(it.name || '', 'item');
      h += nameLines * ROLES.item.size * ts * lh / PT;
      if (pattern.hasDesc && it.desc) {
        h += lines(it.desc, 'desc') * ROLES.desc.size * ts * 1.45 / PT;
      }
      h += (opts.itemGap == null ? 0.15 : opts.itemGap) * ts;
    });
    return h;
  }

  /** Normalise a reference's column x-ranges into page-inch columns. */
  function columnsFrom(reference, page, opts) {
    opts = opts || {};
    var inner = opts.inner || { x: 0.55, w: page.w - 1.1 };
    var refs = (reference && reference.columns) || null;

    if (refs && refs.length) {
      // reference columns are in the reference's own pixel/point space
      var minX = Math.min.apply(null, refs.map(function (c) { return c.left; }));
      var maxX = Math.max.apply(null, refs.map(function (c) { return c.right; }));
      var span = Math.max(1, maxX - minX);
      return refs.map(function (c) {
        var x0 = inner.x + ((c.left - minX) / span) * inner.w;
        var x1 = inner.x + ((c.right - minX) / span) * inner.w;
        return { x: +x0.toFixed(3), w: +Math.max(1.2, x1 - x0).toFixed(3) };
      }).sort(function (a, b) { return a.x - b.x; });
    }

    // No reference: a portrait sheet gets two columns and a landscape one three,
    // because a single column of 70 dishes wastes half of every sheet. When a
    // reference exists its own grid governs and this never runs.
    var fallbackCols = page.w / page.h < 0.9 ? 2 : 3;
    var n = Math.max(1, Math.min(5, opts.count || fallbackCols));
    var gutter = opts.gutter == null ? 0.28 : opts.gutter;
    var w = (inner.w - gutter * (n - 1)) / n;
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({ x: +(inner.x + i * (w + gutter)).toFixed(3), w: +w.toFixed(3) });
    }
    return out;
  }

  /**
   * Pack sections into columns in reading order, balancing by measured height.
   * Sections are never split and never reordered.
   */
  function pack(sections, columns, opts) {
    var patterns = sections.map(inferPattern);
    // balance against the NARROWEST column: the worst case is what decides fit
    var narrow = Math.min.apply(null, columns.map(function (c) { return c.w; }));
    var heights = sections.map(function (s, i) {
      return sectionHeight(s, narrow, patterns[i], opts);
    });
    var total = heights.reduce(function (a, b) { return a + b; }, 0);
    var target = total / Math.max(1, columns.length);

    var placed = [], col = 0, used = 0;
    sections.forEach(function (s, i) {
      var h = heights[i];
      // advance only when this section would visibly overshoot the column's
      // share — one rule, no look-ahead, so order can never be disturbed
      if (col < columns.length - 1 && used > 0 && used + h > target * 1.08) {
        col++; used = 0;
      }
      placed.push({ section: s, pattern: patterns[i], height: h, col: col });
      used += h;
    });

    return { placed: placed, heights: heights, patterns: patterns, total: total, target: target };
  }

  /**
   * @param {object} spec
   *   parsed     - output of MenuImport.parse
   *   page       - {w,h,bleed} in inches
   *   reference  - {columns:[{left,right}], aspect} or null
   *   measure    - optional text measurer
   * @returns {object} plan
   */
  /**
   * Split sections over as many sheets as they need. Columns fill left to right
   * with a HARD bottom limit — this is pagination, not balancing, so a section
   * either fits where it lands or starts the next sheet. Order is never touched
   * and a section is never split.
   */
  /** Where content starts: the page's top margin plus the masthead, scaled. */
  function topFor(spec, scale) {
    var base = spec.top == null ? 1.0 : spec.top;
    var ts = scale || spec.typeScale || 1;
    return base + (spec.mastheadIn || 0) * ts;
  }

  function paginate(spec, columns, sections, scale) {
    var top = topFor(spec, scale);
    var bottomLimit = spec.bottom == null ? spec.page.h - 0.9 : spec.bottom;
    var opts = {
      measure: spec.measure, itemGap: spec.itemGap,
      sectionGap: spec.sectionGap, lineHeight: spec.lineHeight,
      blockHeight: spec.blockHeight,
      typeScale: scale
    };

    var pages = [], rest = sections.slice(), guard = 0;
    while (rest.length && guard++ < 60) {
      var yByCol = columns.map(function () { return top; });
      var col = 0, placed = [], i = 0;

      while (i < rest.length) {
        var sec = rest[i];
        var pat = inferPattern(sec);
        var h = sectionHeight(sec, columns[col].w, pat, opts);
        if (yByCol[col] + h <= bottomLimit + 0.01) {
          placed.push({
            title: sec.title, items: sec.items || [], pattern: pat, col: col,
            x: columns[col].x, w: columns[col].w,
            y: +yByCol[col].toFixed(3), h: +h.toFixed(3),
            continued: !!sec.continued
          });
          yByCol[col] += h;
          i++;
        } else if (col < columns.length - 1) {
          col++;
        } else {
          // Last column and the section still does not fit. Cut it at the last
          // item that fits and continue it on the next sheet — the alternative
          // is leaving half a column empty at the bottom of every page.
          var items = sec.items || [];
          var room = bottomLimit - yByCol[col];
          var headOnly = sectionHeight({ title: sec.title, items: [] }, columns[col].w, pat, opts);
          var cut = 0;
          if (items.length > 2 && room > headOnly + 0.8) {
            while (cut < items.length &&
                   sectionHeight({ title: sec.title, items: items.slice(0, cut + 1) },
                                 columns[col].w, pat, opts) <= room + 0.01) cut++;
            // do not strand one or two dishes on a sheet of their own
            if (items.length - cut < 3) cut = Math.max(2, items.length - 3);
          }
          if (cut >= 2) {
            var head = { title: sec.title, items: items.slice(0, cut) };
            placed.push({
              title: sec.title, items: items.slice(0, cut), pattern: pat, col: col,
              x: columns[col].x, w: columns[col].w, y: +yByCol[col].toFixed(3),
              h: +sectionHeight(head, columns[col].w, pat, opts).toFixed(3),
              continued: !!sec.continued
            });
            rest[i] = { title: sec.title, items: items.slice(cut), continued: true };
            yByCol[col] = bottomLimit;
          }
          break;                       // sheet is full either way
        }
      }

      // a single section taller than every column still has to be placed, or we
      // would loop forever dropping it
      if (!placed.length) {
        placed.push({
          title: rest[0].title, items: rest[0].items || [], pattern: inferPattern(rest[0]),
          col: 0, x: columns[0].x, w: columns[0].w, y: top, h: 0
        });
        i = 1;
      }

      pages.push({
        sections: placed,
        fills: yByCol.map(function (y, k) { return { col: k, height: +(y - top).toFixed(2) }; })
      });
      rest = rest.slice(i);
    }
    return pages;
  }

  function plan(spec) {
    // fitting is a search, in the order a designer works: same grid, smaller
    // type first; only add a column when the type would get unreadably small
    var scales = spec.scales || [1, 0.95, 0.9, 0.85, 0.8, 0.75];
    var best = null;
    for (var si = 0; si < scales.length; si++) {
      var cand = planOnce(Object.assign({}, spec, { typeScale: scales[si] }));
      if (!best || cand.overflowIn < best.overflowIn) best = cand;
      if (cand.overflowIn <= 0.02) return cand;
    }
    // Growing a column is only worth it when there is no other way to fit. With
    // pagination available, narrower columns make sections taller and leave each
    // page half-empty — prefer another sheet instead.
    if (spec.grow !== false && spec.paginate === false && best.columns.length < 5) {
      var grown = plan(Object.assign({}, spec, {
        columns: best.columns.length + 1,
        reference: null,
        grow: false
      }));
      if (grown.overflowIn < best.overflowIn) return grown;
    }

    // Still does not fit even at the type floor and with an extra column: lay it
    // out over successive sheets instead of running off the trim.
    if (best.overflowIn > 0.02 && spec.paginate !== false) {
      var secs = (spec.parsed && spec.parsed.sections || []).filter(function (s) {
        return s && (s.items || []).length;
      });
      var pages = paginate(spec, best.columns, secs, best.typeScale);
      if (pages.length) {
        // Take the paginated layout even when it produced a SINGLE sheet: its
        // fill-to-the-bottom packing is what fits, and the balancing pass that
        // overflowed must not be kept just because the page count is one.
        best.pages = pages;
        best.pageCount = pages.length;
        best.sections = pages[0].sections;
        best.fills = pages[0].fills;
        best.paginated = pages.length > 1;
        var topIn = topFor(spec, best.typeScale);
        var bottomIn = spec.bottom == null ? spec.page.h - 0.9 : spec.bottom;
        var overFirst = pages[0].fills.reduce(function (m, f) {
          return Math.max(m, topIn + f.height - bottomIn); }, 0);
        best.overflowIn = Math.max(0, +overFirst.toFixed(2));
        best.fits = best.overflowIn <= 0.02;
      }
    }

    return best;
  }

  function planOnce(spec) {
    var parsed = spec.parsed || { sections: [] };
    var page = spec.page;
    var sections = (parsed.sections || []).filter(function (s) {
      return s && (s.items || []).length;
    });

    var columns = columnsFrom(spec.reference, page, {
      count: spec.columns, gutter: spec.gutter, inner: spec.inner
    });

    var packed = pack(sections, columns, {
      measure: spec.measure,
      itemGap: spec.itemGap,
      sectionGap: spec.sectionGap,
      lineHeight: spec.lineHeight,
      blockHeight: spec.blockHeight,
      typeScale: spec.typeScale
    });

    // place: y accumulates per column from the top margin. `bottom` is an
    // absolute y in inches (the page's safe bottom), not a margin. `mastheadIn`
    // is the room the title and strapline take, so columns start below them.
    var top = topFor(spec);
    var bottomLimit = spec.bottom == null ? page.h - 0.9 : spec.bottom;
    var yByCol = columns.map(function () { return top; });
    var out = [];

    packed.placed.forEach(function (p) {
      var c = columns[p.col];
      var y = yByCol[p.col];
      out.push({
        title: p.section.title,
        items: p.section.items,
        pattern: p.pattern,
        col: p.col,
        x: c.x,
        w: c.w,
        y: +y.toFixed(3),
        h: +p.height.toFixed(3)
      });
      yByCol[p.col] = y + p.height;
    });

    var fills = columns.map(function (c, i) {
      return { col: i, height: +(yByCol[i] - top).toFixed(2), bottom: +yByCol[i].toFixed(2), w: c.w };
    });
    var overflowIn = Math.max.apply(null, fills.map(function (f, i) {
      return Math.max(0, yByCol[i] - bottomLimit);
    }));

    // If the content does not fit the reference's grid, say so by adding a
    // column rather than by letting the last one run off the page.

    return {
      page: page,
      columns: columns,
      sections: out,
      fills: fills,
      roles: ROLES,
      typeScale: spec.typeScale || 1,
      overflowIn: +overflowIn.toFixed(2),
      fits: overflowIn <= 0.02,
      balanced: +(Math.max.apply(null, fills.map(function (f) { return f.height; })) -
                  Math.min.apply(null, fills.map(function (f) { return f.height; }))).toFixed(2),
      sectionCount: out.length,
      itemCount: out.reduce(function (a, s) { return a + s.items.length; }, 0),
      pageCount: 1,
      paginated: false
    };
  }

  return {
    plan: plan,
    paginate: paginate,
    inferPattern: inferPattern,
    columnsFrom: columnsFrom,
    sectionHeight: sectionHeight,
    ROLES: ROLES,
    isCaps: isCaps
  };
});
