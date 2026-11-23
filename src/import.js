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

  // Markers a menu is allowed to put on their own line after a dish.
  var DIET_TOKENS = {
    V: 1, VG: 1, VE: 1, VEG: 1, VGN: 1, VV: 1,
    GF: 1, DF: 1, NF: 1, EF: 1, SF: 1, MF: 1,
    N: 1, NN: 1, S: 1, SP: 1, HOT: 1, SPICY: 1, RAW: 1, CONTAINS: 0
  };

  function isAllCaps(s) {
    return /[A-Z]/.test(s) && !/[a-z]/.test(s);
  }

  // Units that may appear beside a price set on its own line ("verre 15",
  // "bottle 80") — wine lists print prices this way.
  var UNIT_WORDS = /^(verre|bottle|bottles|bouteille|bouteilles|glass|btl|carafe|curafe|pichet|each|for|half|demi|copa|cup|bowl|small|large|reg|pint|can|jar|corbeille|selon|arrivage)$/i;
  var PRICE_TOKEN = /^\$?\d{1,3}(?:[.,]\d{1,2})?$/;

  function isPriceOnlyLine(line) {
    var t = String(line).trim();
    if (!t || t.length > 44) return false;
    var toks = t.split(/[\s·\/|,+]+/).filter(Boolean);
    if (!toks.length) return false;
    var nums = 0;
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i].replace(/[*†‡]/g, '');
      if (!tok) continue;
      if (PRICE_TOKEN.test(tok)) { nums++; continue; }
      if (UNIT_WORDS.test(tok)) continue;
      return false;
    }
    return nums > 0;
  }

  var NAME_PARTICLES = /^(de|du|des|la|le|les|au|aux|a|à|of|the|and|with|on|in|en|sur|sous|d|d'|l'|l)$/i;

  /**
   * "Homemade Granola yogurt, fresh strawberries" -> name + description.
   * The boundary is the first lowercase word following at least two
   * capitalised words; a comma is the fallback. A two-word head is required, so
   * "Salt cod fritters" and "Steak Frites" are left alone.
   */
  function splitInlineDesc(name) {
    var t = String(name).trim();
    if (t.length < 12) return null;
    var words = t.split(/\s+/);
    if (words.length < 3) return null;

    var caps = 0;
    for (var i = 0; i < words.length; i++) {
      var bare = words[i].replace(/^[(&"'“”*]+|[)*"'“”,.;:]+$/g, '');
      if (!bare) continue;
      if (/^[A-Z0-9&'’]/.test(bare)) { caps++; continue; }
      if (/^[a-z]/.test(bare)) {
        if (caps >= 2 && !NAME_PARTICLES.test(bare) && words.length - i >= 2) {
          return { name: words.slice(0, i).join(' '), desc: words.slice(i).join(' ') };
        }
        break;
      }
      break;
    }

    var comma = t.search(/[,;]\s*[a-z(]/);
    if (comma > 0) {
      var head = t.slice(0, comma).trim();
      var tail = t.slice(comma + 1).trim();
      if (head.split(/\s+/).length >= 2 && tail.length >= 4) {
        return { name: head, desc: tail };
      }
    }
    return null;
  }

  function nextNonEmpty(lines, from) {
    for (var i = from + 1; i < lines.length; i++) {
      var t = String(lines[i]).trim();
      if (t) return t;
    }
    return null;
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

  // Items here are set "PANI PURI 14 V" — the price is followed by dietary
  // markers, so a trailing-number rule alone misses every one of them.
  var TAG_TOKEN = 'V|VG|VO|VE|VEG|GF|DF|NF|EF|SF|MF|N|NN|S|SP|HOT|SPICY|RAW';
  var TAG_TAIL_RE = new RegExp(
    '\\s+((?:' + TAG_TOKEN + ')(?:\\s*[\\/&,]\\s*(?:' + TAG_TOKEN + '))*)$', 'i'
  );

  function stripTailTags(line) {
    var m = String(line).match(TAG_TAIL_RE);
    if (!m) return { text: line, tags: [] };
    return {
      text: String(line).slice(0, m.index).replace(/\s+$/, ''),
      tags: m[1].split(/\s*[\/&,]\s*/).filter(Boolean)
    };
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
    var pendingSection = null;
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

      // pull dietary markers off the end before anything else looks at the line
      var tail = stripTailTags(trimmed);
      var tailTags = tail.tags;
      if (tailTags.length && tail.text) trimmed = tail.text;
      else tailTags = [];

      if (/^[-=_*~·—–]{3,}$/.test(trimmed)) { lastItem = null; continue; }

      if (CONTACT_RE.test(trimmed)) {
        notes.push(trimmed);
        continue;
      }

      // A line of prices and units alone belongs to the item above it. This has
      // to run before splitPrice, or "verre 17" becomes a dish called "verre".
      if (isPriceOnlyLine(trimmed)) {
        if (lastItem) {
          lastItem.price = lastItem.price
            ? lastItem.price + ' / ' + trimmed.replace(/\s+/g, ' ')
            : trimmed.replace(/\s+/g, ' ');
          lastItem._conf = 'lookahead';
        } else {
          warn('warn', 'A price on its own line had no dish above it — not imported.', trimmed);
        }
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
        // descriptions are often inline in the source line, before the leader
        var inline = splitInlineDesc(name);
        if (inline) name = cleanName(inline.name);
        if (pendingSection) { ensureSection(pendingSection); pendingSection = null; }
        else if (!cur) ensureSection(opts.defaultSection || 'Menu');
        var price = normPrice(priced.price);
        var prev = cur.items[cur.items.length - 1];
        if (prev && prev.name.toLowerCase() === name.toLowerCase()) {
          warn('warn', 'Duplicate dish name "' + name + '" — pasted twice?', trimmed);
        }
        lastItem = {
          name: name, desc: inline ? inline.desc : '', price: price,
          tags: (tagRes.tags || []).concat(tailTags.map(function (t) { return t.toUpperCase(); })),
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

      // A line of nothing but dietary markers belongs to the dish above it —
      // this is how tags arrive from OCR, where they sit on their own line.
      if (lastItem && trimmed.length <= 14) {
        var toks = trimmed.split(/\s*[·\/,\s]\s*/).filter(Boolean);
        if (toks.length && toks.length <= 4 && toks.every(function (t) { return DIET_TOKENS[t.toUpperCase()]; })) {
          lastItem.tags = (lastItem.tags || []).concat(toks.map(function (t) { return t.toUpperCase(); }));
          continue;
        }
      }

      // Before the first dish, an all-caps line may be a kicker rather than a
      // section — hold it until we see whether a dish actually follows.
      if (!sections.length) {
        if (score >= 3) {
          if (pendingSection) headerLines.push(pendingSection);
          pendingSection = cleanName(trimmed);
        } else {
          headerLines.push(cleanName(trimmed));
        }
        continue;
      }

      if (lastItem && looksLikeDesc(trimmed)) {
        lastItem.desc = lastItem.desc ? lastItem.desc + ' ' + trimmed : trimmed;
        continue;
      }

      if (score >= 3) {
        // An all-caps name whose price sits on the line below is a DISH, not a
        // heading — this is how a wine list sets "CRÉMANT DE BOURGOGNE NV" over
        // "verre 17 / bottle 80", while "SPARKLING ROSÉ" above another wine name
        // stays a heading.
        var nextTxt = nextNonEmpty(lines, i);
        if (nextTxt && isPriceOnlyLine(nextTxt)) {
          if (pendingSection) { ensureSection(pendingSection); pendingSection = null; }
          else if (!cur) ensureSection(opts.defaultSection || 'Menu');
          lastItem = {
            name: cleanName(trimmed), desc: '', price: '', tags: [],
            _conf: 'lookahead', _line: i + 1
          };
          cur.items.push(lastItem);
          continue;
        }
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

    if (pendingSection) headerLines.push(pendingSection);

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

    var capsLines = headerLines.filter(function (l) { return isAllCaps(l); });
    var mixedLines = headerLines.filter(function (l) { return !isAllCaps(l); });
    var titleOut = mixedLines.length ? mixedLines.shift() : (capsLines.shift() || null);
    var subtitleOut = mixedLines.length ? mixedLines.join('  ·  ') : null;
    var kickerOut = capsLines.length ? capsLines.join(' · ') : null;

    return {
      kicker: kickerOut,
      title: titleOut || null,
      subtitle: subtitleOut,
      sections: sections,
      notes: notes,
      warnings: warnings,
      assumedPrices: assumed,
      stats: { lines: lines.length, sections: sections.length, items: itemCount }
    };
  }

  return {
    parse: parse, splitPrice: splitPrice, sectionScore: sectionScore,
    extractTags: extractTags, normPrice: normPrice,
    splitInlineDesc: splitInlineDesc, isPriceOnlyLine: isPriceOnlyLine
  };
});
