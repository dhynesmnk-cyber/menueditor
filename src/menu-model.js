/* ============================================================================
   The menu document model, the demo menu, and the builder that turns parsed
   import text into canvas blocks.
   Shared verbatim by the browser app and the node tests, so both sides lay out
   byte-identical geometry.

   Positions are inches, origin at the trim top-left. Blocks are stacked with
   the engine's own measured heights, then the leftover space at the bottom is
   distributed into the gaps so the column reaches the bottom margin (the
   freeform blocks can be dragged anywhere afterwards).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Both families are SIL OFL 1.1 — see fonts/OFL-*.txt.
  // (Monotype Garamond from Chrome OS was the original demo face; it is not
  // redistributable, so the demo ships Crimson Text instead.)
  var FONTS = [
    { family: 'MCrimson', style: 'normal', file: 'CrimsonText-Regular.ttf' },
    { family: 'MCrimson', style: 'bold', file: 'CrimsonText-Bold.ttf' },
    { family: 'MCrimson', style: 'italic', file: 'CrimsonText-Italic.ttf' },
    { family: 'MLato', style: 'normal', file: 'Lato-Regular.ttf' },
    { family: 'MLato', style: 'bold', file: 'Lato-Bold.ttf' },
    { family: 'MLato', style: 'italic', file: 'Lato-Italic.ttf' }
  ];

  var THEME = {
    paper: '#FAF4E6',
    ink: '#2C221A',
    muted: '#7B6552',
    accent: '#A3542C',
    fonts: {
      display: { family: 'MCrimson' },
      body: { family: 'MLato' }
    }
  };

  // column geometry (inches)
  var COL_X = 1.45, COL_W = 5.6, TOP = 1.08, BOTTOM = 10.0;

  /**
   * Measure every block with the engine, stack from `top`, then spread the
   * leftover space into the gaps by weight so the column lands on `bottom`.
   */
  function stackBlocks(engine, th, blocks, gaps, top, bottom) {
    var heights = blocks.map(function (b) { return engine.layoutBlock(b, th).h / 72; });
    var used = 0, i;
    for (i = 0; i < blocks.length; i++) used += heights[i] + (gaps[i] ? gaps[i].gap : 0);

    var slack = (bottom - top) - used;
    var totalWeight = 0;
    for (i = 0; i < gaps.length; i++) totalWeight += gaps[i].weight || 1;
    if (!totalWeight) totalWeight = 1;

    var cursor = top;
    for (i = 0; i < blocks.length; i++) {
      blocks[i].y = cursor;
      cursor += heights[i];
      if (i < blocks.length - 1) {
        var g = gaps[i] || { gap: 0, weight: 1 };
        cursor += g.gap + (slack > 0 ? slack * (g.weight || 1) / totalWeight : 0);
      }
    }
    return { overflowIn: Math.max(0, -slack), slackIn: slack };
  }

  function demoItems() {
    return [
      {
        section: 'To Begin',
        dishes: [
          { name: 'Charred Sourdough', desc: 'Cultured butter, smoked salt, first-press olive oil', price: '9', tags: ['V'] },
          { name: 'Burrata & Grilled Peach', desc: 'Basil oil, aged balsamic, hazelnut dukkah', price: '16', tags: ['V', 'GF'] },
          { name: 'Beef Tartare', desc: 'Capers, shallot, cured egg yolk, rye crisps', price: '18', tags: [] }
        ]
      },
      {
        section: 'From the Fire',
        dishes: [
          { name: 'Dry-Aged Ribeye, 14oz', desc: 'Bone marrow butter, charred allium, watercress', price: '62', tags: ['GF'] },
          { name: 'Coal-Roasted Hake', desc: 'Fennel, brown butter, preserved lemon', price: '34', tags: [] },
          { name: 'Wood-Fired Celeriac', desc: 'Black garlic, hazelnut, aged pecorino, thyme', price: '26', tags: ['V'] }
        ]
      },
      {
        section: 'To Finish',
        dishes: [
          { name: 'Burnt Honey Custard', desc: 'Sea salt, rye crumb, crème fraîche', price: '11', tags: ['V'] },
          { name: 'Olive Oil Cake', desc: 'Blood orange, mascarpone, pistachio', price: '10', tags: ['V'] }
        ]
      }
    ];
  }

  /**
   * @param engine  MenuEngine instance (needs .layoutBlock to measure heights)
   * @returns menu document
   */
  function buildMenu(engine) {
    var th = THEME;
    var blocks = [], gaps = [];

    function push(spec, gapAfter, weight) {
      spec.id = 'b' + blocks.length;
      spec.x = spec.x == null ? COL_X : spec.x;
      spec.w = spec.w == null ? COL_W : spec.w;
      spec.y = 0;
      blocks.push(spec);
      gaps.push({ gap: gapAfter || 0, weight: weight || 1 });
    }

    push({ type: 'kicker', text: 'Wood fired  ·  Seasonal', size: 7, tracking: 2.6 }, 0.06, 0.5);
    push({ type: 'title', text: 'Larder & Vine', size: 40, tracking: 1.4 }, 0.02, 0.6);
    push({ type: 'rule', x: (8.5 - 1.15) / 2, w: 1.15, weight: 1.1, color: th.accent }, 0.1, 0.4);
    push({ type: 'subtitle', text: 'Dinner  ·  Tuesday to Sunday', size: 9.2, tracking: 1.4 }, 0.3, 1);

    demoItems().forEach(function (g) {
      push({ type: 'section', text: g.section, size: 8.2, tracking: 2.4 }, 0.2, 1.5);
      g.dishes.forEach(function (dish) {
        push({
          type: 'item', name: dish.name, desc: dish.desc, price: dish.price,
          tags: dish.tags, size: 12.6, descSize: 8.2
        }, 0.17, 1);
      });
    });

    push({ type: 'note', text: 'V vegetarian  ·  GF gluten free  —  please tell us about any allergies', size: 7, tracking: 0.5 }, 0, 2);

    var fit = stackBlocks(engine, th, blocks, gaps, TOP, BOTTOM);

    return {
      meta: { name: 'Larder & Vine — Dinner', version: 1 },
      page: { unit: 'in', w: 8.5, h: 11, bleed: 0.125, cropMarks: true },
      theme: th,
      blocks: blocks,
      overflowIn: fit.overflowIn
    };
  }

  /**
   * Turn a parsed import into blocks, keeping the caller's page and theme so an
   * import never resets the design.
   * @returns { menu, overflowIn }
   */
  function buildMenuFromParsed(engine, parsed, opts) {
    opts = opts || {};
    var th = opts.theme || THEME;
    var page = opts.page || { unit: 'in', w: 8.5, h: 11, bleed: 0.125, cropMarks: true };
    var colW = opts.colW || COL_W;
    var colX = opts.colX != null ? opts.colX : (page.w - colW) / 2;

    var pageOut = {
      unit: page.unit || 'in', w: page.w, h: page.h,
      bleed: page.bleed, cropMarks: page.cropMarks
    };

    var top = opts.top != null ? opts.top : 1.05;
    var bottom = opts.bottom != null ? opts.bottom : page.h - 1.0;

    var blocks = [], gaps = [];
    function push(spec, gapAfter, weight) {
      spec.id = 'b' + blocks.length;
      spec.x = spec.x == null ? colX : spec.x;
      spec.w = spec.w == null ? colW : spec.w;
      if (spec.y == null) spec.y = 0;
      blocks.push(spec);
      gaps.push({ gap: gapAfter || 0, weight: weight || 1 });
    }

    // ---- a plan from src/planner.js means a multi-column page: the reference's
    // grid decides where each section sits. Without a plan this stays the old
    // one-column stack, so nothing regresses for single-column menus.
    if (opts.plan) {
      var plan = opts.plan;
      var ts = plan.typeScale || 1;
      var cols = plan.columns;
      var left = Math.min.apply(null, cols.map(function (c) { return c.x; }));
      var right = Math.max.apply(null, cols.map(function (c) { return c.x + c.w; }));
      var headY = 0.55;

      if (parsed.title) {
        push({ type: 'title', text: parsed.title, size: 40 * ts, tracking: 1.2,
               x: left, w: right - left, y: headY }, 0, 1);
      }
      if (parsed.subtitle) {
        push({ type: 'subtitle', text: parsed.subtitle, size: 9.2 * ts, tracking: 1.2,
               x: left, w: right - left, y: headY + 1.15 * ts }, 0, 1);
      }

      var startY = parsed.title ? headY + 1.85 * ts : (parsed.subtitle ? headY + 0.9 * ts : 1.0);
      var cursor = cols.map(function () { return startY; });
      var groups = [];

      plan.sections.forEach(function (ps) {
        var ci = Math.min(ps.col, cols.length - 1);
        var x = cols[ci].x, w = cols[ci].w;
        var y = cursor[ci];
        var from = blocks.length;

        push({ type: 'section', text: ps.continued ? ps.title + ' (cont.)' : ps.title,
               size: 8.2 * ts, tracking: 2.2, x: x, w: w, y: y }, 0, 1);
        y += engine.layoutBlock(blocks[blocks.length - 1], th).h / 72 + 0.10 * ts;

        ps.items.forEach(function (it) {
          push({
            type: 'item', name: it.name, desc: it.desc || '', price: it.price,
            tags: it.tags || [], size: 12.4 * ts, descSize: 8.2 * ts, x: x, w: w, y: y
          }, 0, 1);
          y += engine.layoutBlock(blocks[blocks.length - 1], th).h / 72 + 0.15 * ts;
        });

        cursor[ci] = y + 0.16 * ts;
        groups.push({ col: ci, from: from, to: blocks.length - 1 });
      });

      // Spread the leftover height between sections, as the single-column path
      // does: a short menu should sit in the room it has, not float at the top
      // of the sheet with a void beneath it.
      cols.forEach(function (c, ci) {
        var mine = groups.filter(function (g) { return g.col === ci; });
        if (!mine.length) return;
        var slack = bottom - cursor[ci];
        if (slack <= 0.01) return;
        var extra = slack / mine.length;
        mine.forEach(function (g, j) {
          if (!j) return;
          for (var k = g.from; k <= g.to; k++) blocks[k].y += extra * j;
        });
        cursor[ci] = bottom;
      });

      var over = Math.max.apply(null, cursor.map(function (y) { return y - bottom; }));
      return {
        menu: {
          meta: { name: (parsed.title || 'Imported menu'), version: 1 },
          page: pageOut,
          theme: th,
          blocks: blocks
        },
        overflowIn: Math.max(0, +over.toFixed(2)),
        plan: plan
      };
    }

    if (parsed.title) {
      push({ type: 'title', text: parsed.title, size: 38, tracking: 1.2 }, 0.02, 0.6);
      push({ type: 'rule', x: colX + (colW - 1.15) / 2, w: 1.15, weight: 1.1, color: th.accent }, 0.08, 0.4);
    }
    if (parsed.subtitle) {
      push({ type: 'subtitle', text: parsed.subtitle, size: 9.2, tracking: 1.2 }, 0.28, 1);
    }

    (parsed.sections || []).forEach(function (s) {
      push({ type: 'section', text: s.title, size: 8.2, tracking: 2.2 }, 0.18, 1.4);
      (s.items || []).forEach(function (it) {
        push({
          type: 'item', name: it.name, desc: it.desc || '', price: it.price,
          tags: it.tags || [], size: 12.4, descSize: 8.2
        }, 0.16, 1);
      });
      if (s.note) push({ type: 'note', text: s.note, size: 7, tracking: 0.4 }, 0.14, 0.8);
    });

    var allNotes = (parsed.notes || []).join('   ·   ');
    if (allNotes) push({ type: 'note', text: allNotes, size: 7, tracking: 0.5 }, 0, 1.5);

    var fit = stackBlocks(engine, th, blocks, gaps, top, bottom);

    return {
      menu: {
        meta: { name: (parsed.title || 'Imported menu'), version: 1 },
        page: pageOut,
        theme: th,
        blocks: blocks
      },
      overflowIn: fit.overflowIn
    };
  }

  /**
   * One menu per sheet. Returns a single-element array when it all fits.
   */
  function buildPagesFromParsed(engine, parsed, opts) {
    opts = opts || {};
    var plan = opts.plan;
    if (!plan || !plan.pages || !(plan.pageCount > 1)) {
      return [buildMenuFromParsed(engine, parsed, opts).menu];
    }
    return plan.pages.map(function (pg, i) {
      var subPlan = Object.assign({}, plan, {
        sections: pg.sections, fills: pg.fills, pageCount: 1, pages: null
      });
      // the masthead belongs to sheet one; later sheets open with content
      var subParsed = i === 0 ? parsed : Object.assign({}, parsed, {
        title: null, subtitle: null, kicker: null
      });
      return buildMenuFromParsed(engine, subParsed, Object.assign({}, opts, { plan: subPlan })).menu;
    });
  }

  return {
    buildMenu: buildMenu,
    buildMenuFromParsed: buildMenuFromParsed,
    buildPagesFromParsed: buildPagesFromParsed,
    stackBlocks: stackBlocks,
    demoItems: demoItems,
    FONTS: FONTS, THEME: THEME,
    COL_X: COL_X, COL_W: COL_W, TOP: TOP, BOTTOM: BOTTOM
  };
});
