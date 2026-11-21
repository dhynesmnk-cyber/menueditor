/* ============================================================================
   Menu text importer.
   ----------------------------------------------------------------------------
   Turns pasted menu text into { title, subtitle, sections:[{title, items[],
   note}], notes[], warnings[] }. Runs in node and the browser (UMD) so the same
   code that powers the UI is the code under test.

   Design rule: never invent a price. Every price carries a confidence; a bare
   number with nothing separating it from the dish name is imported but
   reported as an assumption the user must see before applying.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MenuImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // optional currency, 1-3 digits, optional cents, optionally a multi-price
  var PRICE = '\\$?\\d{1,3}(?:[.,]\\d{2})?(?:\\s*[\\/|]\\s*\\$?\\d{1,3}(?:[.,]\\d{2})?)*';

  // What may separate a name from its price: leaders, a tab, two spaces, or a
  // spaced dash. A single space is not a separator — that is the low-confidence
  // case handled separately.
  var SEP_RE = new RegExp(
    '^(.*?)(?:\\.{2,}|[…·]{2,}|\\t+|\\s{2,}|\\s+[—–-]\\s+)\\s*(' + PRICE + ')\\s*$'
  );
  var DOLLAR_TAIL_RE = /^(.*?)\s+(\$\d{1,3}(?:[.,]\d{2})?(?:\s*[\/|]\s*\$?\d{1,3}(?:[.,]\d{2})?)*)\s*$/;
  var BARE_TAIL_RE = new RegExp('^(.*?)\\s+(' + PRICE + ')\\s*$');

  var SECTION_WORDS = new RegExp(
    '^(starters?|small plates?|appetiz(?:er|ers)|to begin|first courses?|mains?|' +
    'main courses?|entrees?|entr[ée]es|from the [a-z ]+|grill|pasta|salads?|sides?|' +
    'desserts?|sweets|to finish|drinks?|cocktails?|wine|beer|spirits|coffee|tea|' +
    'brunch|lunch|dinner|breakfast|raw bar|charcuterie|cheese|specials?)', 'i'
  );

  var NOTE_RE = /^[*†‡(\[]|allerg|please note|ask (?:us|your)|consuming raw|vegan option/i;
  var CONTACT_RE = /(?:https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b|\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\+?\d[\d\s().-]{8,}\d)/i;

  function isAllCaps(s) {
    return /[A-Z]/.test(s) && !/[a-z]/.test(s);
  }

  function cleanName(s) {
    return String(s)
      .replace(/^[\s•·*\u2022\-–—]+/, '')
      .replace(/[\s•·*\u2022\-–—.:]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^["'“”]|["'“”]$/g, '')
      .trim();
  }

  function normPrice(p) {
    return String(p)
      .replace(/\s+/g, ' ')
      .replace(/^\$\s*/, '')
      .replace(/[.,]00$/, '')
      .trim();
  }

  // Dietary markers: bracketed next to the name, or trailing the line.
  function extractTags(text) {
    var tags = [];
    var out = String(text).replace(/\(([^)]{1,28})\)/g, function (all, inner) {
      var toks = inner.split(/\s*[,/&·]\s*/).filter(Boolean);
      if (!toks.length) return all;
      var allTags = toks.every(function (t) {
        var s = t.trim();
        return /^[A-Za-z0-9+]{1,5}$/.test(s) && /[A-Za-z]/.test(s) && !/^\d+$/.test(s);
      });
      if (!allTags) return all;
      tags = tags.concat(toks.map(function (t) { return t.trim().toUpperCase(); }));
      return '';
    });
    var trailer = out.match(/\s+([A-Z]{1,3}(?:\s*[·\/]\s*[A-Z]{1,3})+)\s*$/);
    if (trailer) {
      tags = tags.concat(trailer[1].split(/\s*[·\/]\s*/).map(function (t) { return t.trim(); }));
      out = out.slice(0, trailer.index);
    }
    return { text: out, tags: tags };
  }

  /**
   * Split "Name .... 12" into { name, price, conf, why }.
   * Returns null when the line carries no price at all.
   */
  function splitPrice(rawLine) {
    var line = String(rawLine).replace(/\s+$/, '');

    var m = line.match(SEP_RE);
    if (m && cleanName(m[1])) {
      return { name: m[1], price: m[2], conf: 'high', why: 'separator' };
    }
    m = line.match(DOLLAR_TAIL_RE);
    if (m && cleanName(m[1])) {
      return { name: m[1], price: m[2], conf: 'high', why: 'currency' };
    }
    m = line.match(BARE_TAIL_RE);
    if (m) {
      var name = cleanName(m[1]);
      // refuse when the "price" is glued to a unit ("14oz") or the name ends
      // in a digit, which is how measurements and vintages look
      if (name.length >= 2 && !/\d$/.test(name) && !/[$€£]$/.test(name)) {
        return { name: m[1], price: m[2], conf: 'low', why: 'bare' };
      }
    }
    return null;
  }

  function sectionScore(line) {
    var t = String(line).trim();
    if (!t || t.length > 42) return 0;
    if (/^[-=_*~·—–]{3,}$/.test(t)) return 0;
    if (splitPrice(t)) return -5;
    if (/[.!?]$/.test(t)) return -2;
    var score = 0;
    if (/[:：]\s*$/.test(t)) score += 3;
    if (isAllCaps(t) && t.replace(/[^A-Za-z]/g, '').length >= 2) score += 3;
    if (SECTION_WORDS.test(t.replace(/[:：\s]+$/, ''))) score += 2;
    // "Dinner Menu", "Wine Menu" are headings for the whole sheet, not sections
    if (/\bmenu\b/i.test(t)) score -= 3;
    var words = t.split(/\s+/);
    if (words.length <= 3 && words.every(function (w) { return /^[A-Z]/.test(w) || !/[a-z]/.test(w); })) score += 1;
    if (t.length <= 26) score += 1;
    return score;
  }

  function looksLikeDesc(line) {
    var t = String(line).trim();
    if (!t || t.length > 170) return false;
    if (isAllCaps(t)) return false;
    if (splitPrice(t)) return false;
    if (sectionScore(t) >= 4) return false;
    return /^[a-z(]/.test(t) || /[,;]/.test(t) || /[.!]$/.test(t);
  }

  function parse(text, opts) {
    opts = opts || {};
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
      .map(function (l) { return l.replace(/\u00a0/g, ' '); });

    var sections = [];
    var notes = [];
    var warnings = [];
    var headerLines = [];
    var headerOpen = true;
    var cur = null;
    var lastItem = null;

    function warn(level, message, line) {
      warnings.push({ level: level, message: message, line: line == null ? '' : line });
    }
    function ensureSection(name) {
      cur = { title: name, items: [], note: '' };
      sections.push(cur);
      return cur;
    }

    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].replace(/\s+$/, '').trim();
      if (!trimmed) { lastItem = null; continue; }

      if (/^[-=_*~·—–]{3,}$/.test(trimmed)) { lastItem = null; continue; }

      if (CONTACT_RE.test(trimmed)) {
        notes.push(trimmed);
        continue;
      }

      var priced = splitPrice(trimmed);

      if (priced) {
        var tagRes = extractTags(priced.name);
        var name = cleanName(tagRes.text);
        if (!name) {
          warn('error', 'A price with no dish name was ignored.', trimmed);
          continue;
        }
        if (!cur) ensureSection(opts.defaultSection || 'Menu');
        headerOpen = false;
        var price = normPrice(priced.price);
        var prev = cur.items[cur.items.length - 1];
        if (prev && prev.name.toLowerCase() === name.toLowerCase()) {
          warn('warn', 'Duplicate dish name "' + name + '" — pasted twice?', trimmed);
        }
        lastItem = {
          name: name, desc: '', price: price, tags: tagRes.tags,
          _conf: priced.conf, _line: i + 1
        };
        cur.items.push(lastItem);

        if (priced.conf === 'low') {
          warn('info', 'Assumed "' + price + '" is the price of "' + name + '" — no separator or currency on that line.', trimmed);
        }
        if (/^\d+$/.test(price) && Number(price) > 150) {
          warn('warn', '"' + name + '" at ' + price + ' looks high for one dish.', trimmed);
        }
        continue;
      }

      var score = sectionScore(trimmed);

      // everything before the first section/dish is the menu's own header
      if (headerOpen && !sections.length) {
        if (score >= 3) {
          headerOpen = false;
          ensureSection(cleanName(trimmed));
          lastItem = null;
          continue;
        }
        headerLines.push(cleanName(trimmed));
        continue;
      }

      if (lastItem && looksLikeDesc(trimmed)) {
        lastItem.desc = lastItem.desc ? lastItem.desc + ' ' + trimmed : trimmed;
        continue;
      }

      if (score >= 3) {
        ensureSection(cleanName(trimmed));
        lastItem = null;
        continue;
      }

      if (NOTE_RE.test(trimmed)) {
        if (cur && cur.items.length) {
          cur.note = cur.note ? cur.note + ' ' + trimmed : trimmed;
        } else {
          notes.push(trimmed);
        }
        continue;
      }

      if (cur && cur.items.length && trimmed.length <= 120 && /^[a-z(]/.test(trimmed)) {
        cur.note = cur.note ? cur.note + ' ' + trimmed : trimmed;
        continue;
      }

      warn('warn', 'Line did not look like a dish, a section or a note — not imported.', trimmed);
    }

    var assumed = [];
    sections.forEach(function (s) {
      s.items.forEach(function (it) {
        if (it._conf === 'low') assumed.push({ name: it.name, price: it.price });
      });
      if (!s.items.length) {
        warn('warn', 'Section "' + s.title + '" has no priced dishes — did you mean it as a heading?', s.title);
      }
    });

    if (!sections.length) {
      warn('error', 'No dishes found. Every dish needs its price on the same line, e.g. "Burrata .... 16".', '');
    }

    var itemCount = sections.reduce(function (n, s) { return n + s.items.length; }, 0);

    return {
      title: headerLines.length ? headerLines[0] : null,
      subtitle: headerLines.length > 1 ? headerLines.slice(1).join('  ·  ') : null,
      sections: sections,
      notes: notes,
      warnings: warnings,
      assumedPrices: assumed,
      stats: { lines: lines.length, sections: sections.length, items: itemCount }
    };
  }

  return {
    parse: parse, splitPrice: splitPrice, sectionScore: sectionScore,
    extractTags: extractTags, normPrice: normPrice
  };
});
