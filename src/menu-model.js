/* ============================================================================
   The menu document model + the demo menu.
   Shared verbatim by the browser app and the node fidelity test, so both
   sides lay out byte-identical geometry.

   Positions are inches, origin at the trim top-left. Vertical positions are
   seed-stacked (measured with the engine, then the leftover space at the
   bottom is distributed into the gaps so the column reaches the bottom
   margin — the freeform blocks can be dragged anywhere afterwards).
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

  function items() {
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
    var blocks = [];
    var gaps = [];   // {i: blockIndex, weight} — shareable vertical slack

    function push(spec, gapAfter, weight) {
      spec.id = 'b' + blocks.length;
      spec.x = spec.x == null ? COL_X : spec.x;
      spec.w = spec.w == null ? COL_W : spec.w;
      spec.y = 0;
      blocks.push(spec);
      gaps.push({ i: blocks.length - 1, gap: gapAfter || 0, weight: weight || 1 });
    }

    push({ type: 'kicker', text: 'Wood fired  ·  Seasonal', size: 7, tracking: 2.6 }, 0.06, 0.5);
    push({ type: 'title', text: 'Larder & Vine', size: 40, tracking: 1.4 }, 0.02, 0.6);
    push({ type: 'rule', x: (8.5 - 1.15) / 2, w: 1.15, weight: 1.1, color: th.accent }, 0.1, 0.4);
    push({ type: 'subtitle', text: 'Dinner  ·  Tuesday to Sunday', size: 9.2, tracking: 1.4 }, 0.3, 1);

    var menu = items();
    for (var s = 0; s < menu.length; s++) {
      var g = menu[s];
      push({ type: 'section', text: g.section, size: 8.2, tracking: 2.4 }, 0.2, 1.5);
      for (var d = 0; d < g.dishes.length; d++) {
        var dish = g.dishes[d];
        push({
          type: 'item', name: dish.name, desc: dish.desc, price: dish.price,
          tags: dish.tags, size: 12.6, descSize: 8.2
        }, 0.17, 1);
      }
    }
    push({ type: 'note', text: 'V vegetarian  ·  GF gluten free  —  please tell us about any allergies', size: 7, tracking: 0.5 }, 0, 2);

    // ---- measure, stack, then justify to the bottom margin ----
    var cursor = TOP;
    var heights = blocks.map(function (b) { return engine.layoutBlock(b, th).h / 72; });

    var used = 0;
    for (var i = 0; i < blocks.length; i++) used += heights[i] + gaps[i].gap;

    var slack = (BOTTOM - TOP) - used;
    var totalWeight = gaps.reduce(function (a, g) { return a + g.weight; }, 0);

    cursor = TOP;
    for (var j = 0; j < blocks.length; j++) {
      blocks[j].y = cursor;
      cursor += heights[j];
      if (j < blocks.length - 1) {
        var extra = slack > 0 ? (slack * gaps[j].weight / totalWeight) : 0;
        cursor += gaps[j].gap + extra;
      }
    }

    return {
      meta: { name: 'Larder & Vine — Dinner', version: 1 },
      page: { unit: 'in', w: 8.5, h: 11, bleed: 0.125, cropMarks: true },
      theme: th,
      blocks: blocks
    };
  }

  return { buildMenu: buildMenu, FONTS: FONTS, THEME: THEME, COL_X: COL_X, COL_W: COL_W };
});
