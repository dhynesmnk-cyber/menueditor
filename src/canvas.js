/* ============================================================================
   Canvas mode — keep the page, edit its words.

   The model editor (engine.js) rebuilds a menu and re-lays it out. This is the
   other mode: a PDF goes through the local sidecar, comes back as line objects with
   their original glyph positions, and every untouched line is redrawn exactly where
   the designer put it. Only lines the user actually changes are rewritten on export
   (sidecar/splice.py), so the page cannot drift.

   Every page of the document is rendered, stacked. Objects are addressed by a
   document-wide `gi`, so an edit does not need to know which sheet it is on.

   Interaction:
     click a line     — one editable field for the whole line, all text selected
     drag             — move, snapping to other lines, refusing rules and edges
     [ ]              — tracking, per line, in em
     ⌘Z / Ctrl+Z      — undo
     Shift+Enter      — explicit consent to squeeze a line that will not fit
     click an image   — replace it (the new file is drawn into the same rect)
   ========================================================================== */
(function (root) {
  'use strict';

  var SERVICE = root.LINES_SERVICE || 'http://127.0.0.1:8793';
  var Z = 2;                 // px per pt
  var STORE = 'menucanvas:';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i += 97) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + str.length;
  }

  function styles() {
    if (document.getElementById('cv-styles')) return;
    var css = [
      '.cv-overlay{position:fixed;inset:0;z-index:80;background:#f2f5f9;overflow:auto;display:none}',
      '.cv-overlay.on{display:block}',
      '.cv-bar{position:sticky;top:0;left:0;right:0;z-index:3;display:flex;gap:10px;align-items:center;',
      '  flex-wrap:wrap;padding:8px 12px;background:#fff;border-bottom:1px solid #dbe2ec;',
      '  font:13px/1.35 system-ui,sans-serif;color:#131a24}',
      '.cv-bar strong{font-weight:600;white-space:nowrap}',
      '.cv-bar .sp{flex:1 1 auto}',
      '.cv-bar .hint{color:#667485;font-size:12px;flex:0 1 auto;min-width:0;overflow:hidden;',
      '  text-overflow:ellipsis;white-space:nowrap}',
      '.cv-btn{font:inherit;padding:5px 11px;border:1px solid #c9d2e0;background:#ffffff;border-radius:6px;cursor:pointer}',
      '.cv-btn.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}',
      '.cv-btn:disabled{opacity:.5;cursor:default}',
      '.cv-stage{position:relative;margin:0;box-shadow:0 2px 18px rgba(0,0,0,.14);background:#fff}',
      '.cv-stage svg{display:block;width:100%;height:100%}',
      '.cv-pages{display:flex;flex-direction:column;align-items:center;gap:18px;',
      '  padding:14px 18px 34px;min-width:max-content}',
      '.cv-zoom{display:flex;gap:4px;align-items:center}',
      '.cv-zoom .cv-btn{padding:4px 8px;min-width:30px}',
      '.cv-pgctl{display:flex;gap:4px;align-items:center;padding-left:6px;border-left:1px solid rgba(255,255,255,.16)}',
      '.cv-pgctl .cv-btn{padding:4px 8px}',
      '.cv-pnum{position:absolute;left:0;top:-16px;font:11px/1 ui-monospace,monospace;color:#667485}',
      '.cv-line rect.hit{fill:transparent;cursor:move}',
      '.cv-line.locked rect.hit{stroke:rgba(19,26,36,.38);stroke-width:.5;stroke-dasharray:2 2;cursor:not-allowed}',
      '.cv-line.locked .ink{opacity:.92}',
      '.cv-line.sel rect.hit{stroke:#2f6fed;stroke-width:.6;fill:rgba(47,111,237,.06)}',
      '.cv-line.edited rect.hit{stroke:rgba(47,111,237,.60);stroke-width:.6}',
      '.cv-boxes .cv-line rect.hit{stroke:rgba(47,111,237,.35);stroke-width:.4;stroke-dasharray:2 2}',
      '.cv-img rect{border:none}',
      '.cv-img{opacity:0;cursor:pointer}',
      '.cv-img:hover{opacity:1}',
      '.cv-img.show{opacity:1}',
      '.cv-input{position:fixed;z-index:90;border:1px solid #2f6fed;background:#fff;padding:0 3px;margin:0;',
      '  line-height:1.05;outline:2px solid rgba(47,111,237,.22);font-family:inherit}',
      '.cv-input.toowide{border-color:#b42318;outline-color:rgba(180,35,24,.22)}',
      '.cv-guide{stroke:#2f6fed;stroke-width:.4;stroke-dasharray:3 2;opacity:.8;display:none}',
      '.cv-trk{position:sticky;bottom:0;z-index:3;display:none;gap:10px;align-items:center;padding:7px 12px;',
      '  background:#fff;border-top:1px solid #dbe2ec;font:12px/1.3 ui-monospace,monospace;color:#131a24}',
      '.cv-trk.on{display:flex}',
      '.cv-trk input[type=range]{width:170px}',
      '.cv-status{font:12px/1.3 ui-monospace,monospace;color:#3f4a58}',
      '.cv-warn{background:#eef3fb;border-bottom:1px solid #c3d4f2;color:#17427f;padding:6px 12px;font-size:12px}',
      // added boxes and deleted lines
      '.cv-add text{fill:#131a24}',
      '.cv-add rect.hit{fill:transparent;cursor:move}',
      '.cv-add.sel rect.hit{stroke:#2f6fed;stroke-width:.6;fill:rgba(47,111,237,.06)}',
      '.cv-add rect.hit{stroke:rgba(47,111,237,.35);stroke-width:.4;stroke-dasharray:3 2}',
      '.cv-line.del .ink,.cv-line.del .live{opacity:.12}',
      '.cv-line.del rect.hit{stroke:#b42318;stroke-width:.5;stroke-dasharray:2 2;fill:rgba(180,35,24,.04)}',
      // style row for a selected added box
      '.cv-style{display:none;gap:8px;align-items:center;padding:7px 12px;background:#fff;',
      '  border-bottom:1px solid #dbe2ec;font:12px/1.3 system-ui,sans-serif;color:#131a24;flex-wrap:wrap}',
      '.cv-style.on{display:flex}',
      '.cv-style select,.cv-style input[type=number]{font:inherit;padding:3px 5px;border:1px solid #c9d2e0;border-radius:5px;background:#fff}',
      '.cv-style input[type=number]{width:64px}',
      '.cv-style input[type=color]{width:28px;height:24px;padding:0;border:1px solid #c9d2e0;border-radius:5px;background:none}',
      '.cv-style label{color:#667485}',
      // project chooser
      '.cv-panel{position:fixed;inset:0;z-index:95;background:rgba(13,21,34,.45);display:none;align-items:center;justify-content:center}',
      '.cv-panel.on{display:flex}',
      '.cv-panel .box{background:#fff;border:1px solid #dbe2ec;border-radius:10px;width:min(560px,92vw);',
      '  max-height:80vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(16,32,64,.22)}',
      '.cv-panel h3{margin:0;padding:14px 16px 12px;font:600 14px/1.2 system-ui,sans-serif;color:#131a24;border-bottom:1px solid #dbe2ec}',
      '.cv-panel .rows{overflow:auto;padding:8px}',
      '.cv-panel .row{display:flex;gap:10px;align-items:center;padding:9px 10px;border-radius:7px;cursor:pointer}',
      '.cv-panel .row:hover{background:#f1f5fb}',
      '.cv-panel .row b{font:600 13px/1.3 system-ui,sans-serif;color:#131a24}',
      '.cv-panel .row span{font:11px/1.3 ui-monospace,monospace;color:#667485}',
      '.cv-panel .foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid #dbe2ec}',
      '.cv-panel .empty{padding:16px;color:#667485;font:12px/1.5 system-ui,sans-serif}'
    ].join('\n');
    var el = document.createElement('style');
    el.id = 'cv-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  var api = { open: open, service: SERVICE };

  function open(opts) {
    // opts: {data, pdfBase64?, project?, work?, onClose, onSwitch}
    var data = root.MenuLines.normalize(opts.data);
    var objects = data.objects;
    var project = opts.project || null;         // {slug, name, fonts:[{family,file}]}
    var pdfBase64 = opts.pdfBase64 || null;
    var docKey = project ? 'project:' + project.slug
      : STORE + hash(String(pdfBase64 || '').slice(0, 4096) + String(pdfBase64 || '').length);
    styles();

    var stale = document.querySelector('.cv-overlay');
    if (stale) stale.remove();      // a fresh element each open: no handlers from the last document
    var overlay = document.createElement('div');
    overlay.className = 'cv-overlay';
    overlay.innerHTML =
      '<div class="cv-bar">' +
      '  <strong data-role="pname">Canvas mode</strong>' +
      '  <span class="cv-status" data-role="status">no edits</span>' +
      '  <span class="cv-status" data-role="locknote" style="display:none"></span>' +
      '  <span class="sp"></span>' +
      '  <button class="cv-btn" data-role="addtext" title="add a text box (T)">＋ Text</button>' +
      '  <button class="cv-btn" data-role="delete" title="delete the selected line (Del)">Delete</button>' +
      '  <button class="cv-btn" data-role="fonts" title="load a font file into this project">Fonts</button>' +
      '  <span class="cv-pgctl">' +
      '    <button class="cv-btn" data-role="pgprev" title="show the previous page">‹</button>' +
      '    <button class="cv-btn" data-role="pglabel" title="the page these buttons act on">1 / 1</button>' +
      '    <button class="cv-btn" data-role="pgnext" title="show the next page">›</button>' +
      '    <button class="cv-btn" data-role="pgdup" title="copy this sheet: its art stays, its lines become editable">Duplicate</button>' +
      '    <button class="cv-btn" data-role="pgadd" title="add a blank page">+ Page</button>' +
      '    <button class="cv-btn" data-role="pgdel" title="delete this page">Delete page</button>' +
      '  </span>' +
      '  <span class="cv-zoom">' +
      '    <button class="cv-btn" data-role="zout" title="zoom out">−</button>' +
      '    <button class="cv-btn" data-role="zlabel" title="fit width → fit page → 100%">100%</button>' +
      '    <button class="cv-btn" data-role="zin" title="zoom in">+</button>' +
      '  </span>' +
      '  <button class="cv-btn" data-role="projects">Projects</button>' +
      '  <button class="cv-btn" data-role="clear">Clear</button>' +
      '  <button class="cv-btn primary" data-role="export">Export PDF</button>' +
      '  <button class="cv-btn" data-role="close">Close</button>' +
      '</div>' +
      '<div class="cv-style" data-role="style"></div>' +
      '<div class="cv-warn" data-role="warn" style="display:none"></div>' +
      '<div class="cv-pages" data-role="pages"></div>' +
      '<div class="cv-trk" data-role="trk">' +
      '  <span>tracking</span>' +
      '  <input type="range" min="-0.05" max="0.6" step="0.005" data-role="slider">' +
      '  <span data-role="trkval">0.000 em</span>' +
      '  <button class="cv-btn" data-role="trkreset">reset</button>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.classList.add('on');

    var pagesEl = overlay.querySelector('[data-role=pages]');
    var statusEl = overlay.querySelector('[data-role=status]');
    var warnEl = overlay.querySelector('[data-role=warn]');
    var trkEl = overlay.querySelector('[data-role=trk]');
    var slider = overlay.querySelector('[data-role=slider]');
    var trkval = overlay.querySelector('[data-role=trkval]');
    var pnameEl = overlay.querySelector('[data-role=pname]');
    var styleRow = overlay.querySelector('[data-role=style]');
    if (project) {
      pnameEl.textContent = project.name || 'Menu';
      pnameEl.title = project.slug;
    }
    var selLine = null;

    if (data.warnings && data.warnings.length) {
      warnEl.style.display = '';
      warnEl.textContent = 'Some fonts could not be resolved, so those lines preview in a fallback ' +
        'face (the export still embeds the original): ' + data.warnings.join(', ');
    } else {
      warnEl.style.display = 'none';
    }

    // ---- fonts the sidecar resolved, as data URLs ----
    var fam = {}, faces = [];
    Object.keys(data.fonts || {}).forEach(function (pdfName) {
      var f = data.fonts[pdfName];
      if (!f) return;
      var name = 'CF' + faces.length;
      fam[pdfName] = name;
      faces.push("@font-face{font-family:'" + name + "';src:url(data:font/ttf;base64," + f.data +
                 ") format('" + (f.format || 'truetype') + "');}");
    });

    // ---- fonts the client loaded into this project, served from the project ----
    // A designer ships the .ttf files with the menu; these are the same files, so a
    // new box measures and prints in the face the client picked, not a fallback.
    var projFam = {};
    if (project) {
      (project.fonts || []).forEach(function (f, i) {
        var name = 'PF' + i;
        projFam[f.family] = name;
        var fmt = /\.otf$/i.test(f.file) ? 'opentype'
          : /\.woff2$/i.test(f.file) ? 'woff2'
          : /\.woff$/i.test(f.file) ? 'woff' : 'truetype';
        faces.push("@font-face{font-family:'" + name + "';src:url('" + SERVICE + '/projects/' +
                   encodeURIComponent(project.slug) + '/fonts/' + encodeURIComponent(f.file) +
                   "') format('" + fmt + "');}");
      });
    }
    function cssFor(key) { return projFam[key] || fam[key] || 'serif'; }
    // a line's `font` is the PDF's own face name; once the client restyles it the
    // value is a CSS family, which is already usable as-is
    function cssForFont(key) { return projFam[key] || fam[key] || key || 'serif'; }
    var styleEl = document.createElement('style');
    styleEl.textContent = faces.join('\n');
    document.head.appendChild(styleEl);

    // ---- one stage per page ----
    var views = [];
    var lines = new Map();          // gi -> <g>
    var imageSlots = new Map();     // "page:k" -> <g>

    function buildStages() {
      data.pages.forEach(function (p, pno) {
      var W = p.width, H = p.height;
      var stage = document.createElement('div');
      stage.className = 'cv-stage';
      if (data.pages.length > 1) {
        var tag = document.createElement('div');
        tag.className = 'cv-pnum';
        tag.textContent = 'page ' + (pno + 1) + ' of ' + data.pages.length;
        stage.appendChild(tag);
      }

      var svg = [];
      svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + (W * Z) + '" height="' +
               (H * Z) + '">');
      if (p.plate) svg.push('<image href="' + p.plate + '" x="0" y="0" width="' + W +
                            '" height="' + H + '" preserveAspectRatio="none"/>');
      svg.push('<line class="cv-guide" data-role="gx" x1="0" y1="0" x2="' + W + '" y2="0"/>');
      svg.push('<line class="cv-guide" data-role="gy" x1="0" y1="0" x2="0" y2="' + H + '"/>');

      p.objects.forEach(function (o) {
        var f = fam[o.font] || 'serif';
        var chars = o.text.split('').filter(function (c) { return c !== ' '; });
        var ink = '';
        if (chars.length === o.glyph_x.length) {
          chars.forEach(function (ch, k) {
            ink += '<text x="' + (o.x + o.glyph_x[k]).toFixed(3) + '" y="' + o.y.toFixed(3) +
                   '" font-family="' + f + '" font-size="' + o.size + '" fill="' + o.color +
                   '" xml:space="preserve">' + esc(ch) + '</text>';
          });
        } else {
          ink = '<text x="' + o.x.toFixed(3) + '" y="' + o.y.toFixed(3) + '" font-family="' + f +
                '" font-size="' + o.size + '" fill="' + o.color + '" textLength="' + o.ink_width +
                '" lengthAdjust="spacing" xml:space="preserve">' + esc(o.text) + '</text>';
        }
        svg.push('<g class="cv-line" data-i="' + o.gi + '">' +
                 '<g class="ink">' + ink + '</g>' +
                 '<text class="live" x="' + o.x.toFixed(3) + '" y="' + o.y.toFixed(3) +
                 '" font-family="' + f + '" font-size="' + o.size + '" fill="' + o.color +
                 '" xml:space="preserve"></text>' +
                 '<rect class="hit" x="' + (o.ink_left - 0.6).toFixed(2) + '" y="' +
                 (o.y - o.size * 0.8).toFixed(2) + '" width="' + (o.ink_width + 1.2).toFixed(2) +
                 '" height="' + (o.size * 1.02).toFixed(2) + '"/></g>');
      });

      // image slots: hover shows a target, click replaces
      p.images.forEach(function (r, k) {
        svg.push('<g class="cv-img" data-slot="' + pno + ':' + k + '">' +
                 '<rect x="' + r.x0 + '" y="' + r.y0 + '" width="' + (r.x1 - r.x0) +
                 '" height="' + (r.y1 - r.y0) + '" fill="rgba(47,111,237,.10)" ' +
                 'stroke="#2f6fed" stroke-width="1" stroke-dasharray="4 3"/></g>');
      });
      // added text boxes live above the page's own ink
      svg.push('<g class="cv-adds"></g>');
      svg.push('</svg>');
      stage.insertAdjacentHTML('beforeend', svg.join(''));
      pagesEl.appendChild(stage);

      var svgEl = stage.querySelector('svg');
      p.objects.forEach(function (o) {
        lines.set(o.gi, svgEl.querySelector('.cv-line[data-i="' + o.gi + '"]'));
      });
      p.images.forEach(function (r, k) {
        imageSlots.set(pno + ':' + k, svgEl.querySelector('.cv-img[data-slot="' + pno + ':' + k + '"]'));
      });

      views.push({
        index: pno, stage: stage, svg: svgEl, objects: p.objects, images: p.images,
        vectors: p.vectors, page: { width: W, height: H },
        addsLayer: svgEl.querySelector('.cv-adds'),
        guideX: svgEl.querySelector('[data-role=gx]'),
        guideY: svgEl.querySelector('[data-role=gy]'),
        guides: root.MenuLines.guides(p.objects)
      });
      });
    }
    buildStages();

    // ---- pages ---------------------------------------------------------------
    // A page op is a document-level operation, and the exporter applies it to the PDF:
    // drop a sheet, copy one, or append a blank one. The canvas shows the same model, so
    // a duplicate is a sheet whose lines are *added boxes* — the sidecar copies the art
    // and takes the words off it, and these boxes put them back, editable.
    var pageOps = { delete: [], new: [] };
    var curPage = 0;

    // ---- what the designer allowed -------------------------------------------
    // The rules arrive with the menu (manifest.json in the project). The canvas honours them
    // here, and the exporter enforces them again on the server: a stale tab cannot write over
    // a locked line even if its UI never saw the lock.
    var manifest = opts.manifest || {};
    var allow = Object.assign({ addText: true, pageOps: true, restyle: true, deleteLines: true },
                              manifest.allow || {});
    var locked = new Set();
    (function resolveLocks() {
      var lock = manifest.lock || {};
      var ids = {};
      (lock.lines || []).forEach(function (v) { ids[parseInt(v, 10)] = 1; });
      var needles = (lock.text || []).map(function (t) { return String(t).toLowerCase(); })
        .filter(Boolean);
      data.pages.forEach(function (p) {
        p.objects.forEach(function (o) {
          if (ids[o.gi]) locked.add(o.gi);
          var low = String(o.text || '').toLowerCase();
          if (needles.some(function (n) { return low.indexOf(n) >= 0; })) locked.add(o.gi);
        });
      });
    })();
    function isLocked(gi) { return locked.has(gi); }

    function markLocks() {
      lines.forEach(function (g, gi) {
        if (!g) return;
        if (isLocked(gi)) {
          g.classList.add('locked');
          var hit = g.querySelector('.hit');
          if (hit) hit.setAttribute('title', 'locked by the designer');
        } else {
          g.classList.remove('locked');
        }
      });
      var note = overlay.querySelector('[data-role=locknote]');
      if (note) {
        note.textContent = locked.size ? locked.size + ' line' + (locked.size === 1 ? '' : 's') + ' locked'
          : '';
        note.style.display = locked.size ? '' : 'none';
      }
      // controls the manifest withholds are not shown at all: a button that always refuses
      // reads as a bug, not as a rule
      var hide = [];
      if (allow.pageOps === false) hide.push('pgprev', 'pgnext', 'pgdup', 'pgadd', 'pgdel');
      if (allow.addText === false) hide.push('addtext');
      hide.forEach(function (role) {
        var b = overlay.querySelector('[data-role=' + role + ']');
        if (b) b.style.display = 'none';
      });
      if (allow.restyle === false && styleRow) styleRow.setAttribute('data-restyle', 'off');
    }
    markLocks();

    data.pages.forEach(function (p) {
      p.src = p.index !== undefined ? p.index : p.src;   // which sheet of the source PDF
      p.art = p.src;                                     // which sheet's art a copy takes
    });

    function rebuildStages() {
      views.length = 0;
      lines.clear();
      imageSlots.clear();
      pagesEl.innerHTML = '';
      buildStages();
      views.forEach(bindView);
      attachMeasurer();
      markLocks();
      renderAdds();
      applyScale();
      updatePageBar();
    }

    function updatePageBar() {
      var lab = overlay.querySelector('[data-role=pglabel]');
      if (lab) lab.textContent = (curPage + 1) + ' / ' + data.pages.length;
      var del = overlay.querySelector('[data-role=pgdel]');
      if (del) del.disabled = data.pages.length <= 1;
    }

    function goPage(k) {
      curPage = Math.max(0, Math.min(k, data.pages.length - 1));
      updatePageBar();
      var v = views[curPage];
      if (v) v.stage.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function pageSize() {
      var ref = data.pages[curPage] || data.pages[0];
      return { width: ref ? ref.width : 595, height: ref ? ref.height : 842 };
    }

    function pageGuard() {
      if (allow.pageOps === false) {
        status('this menu does not allow changing pages');
        return false;
      }
      return true;
    }

    function addBlankPage() {
      if (!pageGuard()) return;
      var sz = pageSize();
      data.pages.push({ index: data.pages.length, width: sz.width, height: sz.height,
                        objects: [], vectors: [], images: [], plate: null,
                        src: null, art: null, newIdx: pageOps.new.length });
      pageOps.new.push({ from: null, width: sz.width, height: sz.height });
      curPage = data.pages.length - 1;
      rebuildStages();
      goPage(curPage);
      status('blank page ' + data.pages.length + ' added');
      persist();
    }

    function duplicatePage() {
      if (!pageGuard()) return;
      var pno = curPage, src = data.pages[pno];
      if (!src) return;
      var idx = data.pages.length;
      data.pages.push({ index: idx, width: src.width, height: src.height,
                        objects: [], vectors: src.vectors, images: [], plate: src.plate,
                        src: null, art: src.art, newIdx: pageOps.new.length });
      pageOps.new.push({ from: src.art === undefined ? null : src.art,
                         width: src.width, height: src.height });
      // every line of the copy is new ink, so it travels as a box; the source's own
      // saved boxes come along too, which is what makes a copy of a copy work
      var carry = src.objects.slice();
      adds.filter(function (a) { return a.page === pno; }).forEach(function (a) { carry.push(a); });
      carry.forEach(function (o) {
        var v = o.gi !== undefined ? root.MenuLines.effective(objects, edits, o.gi) : o;
        adds.push({ id: 'd' + (addSeq++), page: idx, text: v.text, x: v.x, y: v.y,
                    size: v.size, track: v.track, font: v.font, color: v.color });
      });
      curPage = idx;
      rebuildStages();
      goPage(curPage);
      status('page ' + (pno + 1) + ' duplicated · ' + carry.length + ' lines carried over');
      persist();
    }

    function deletePage() {
      if (!pageGuard()) return;
      if (data.pages.length <= 1) {
        status('a document needs at least one page');
        return;
      }
      var pno = curPage, pg = data.pages[pno];
      pg.objects.forEach(function (o) { edits.delete(o.gi); deletes.delete(o.gi); });
      adds = adds.filter(function (a) { return a.page !== pno; });
      adds.forEach(function (a) { if (a.page > pno) a.page -= 1; });
      if (pg.newIdx !== undefined && pg.newIdx !== null) {
        // a sheet this session created: drop its request instead of deleting a source page
        pageOps.new.splice(pg.newIdx, 1);
        data.pages.forEach(function (p) {
          if (p.newIdx !== undefined && p.newIdx !== null && p.newIdx > pg.newIdx) p.newIdx -= 1;
        });
      } else if (pg.art !== null && pg.art !== undefined) {
        pageOps.delete.push(pg.art);
      }
      data.pages.splice(pno, 1);
      curPage = Math.min(pno, data.pages.length - 1);
      rebuildStages();
      goPage(curPage);
      status('page ' + (pno + 1) + ' deleted');
      persist();
    }

    // ---- fit to the window, with zoom ----
    // The page renders at Z CSS px per point; the stage is then sized by `scale`, and the
    // SVG is width/height:100%, so the whole page can fit a small window without clipping
    // and can still be zoomed in for detail. Everything that converts pointer distance to
    // points must divide by Z * scale.
    var zoomMode = data.pages.length > 1 ? 'fitw' : 'fitp';
    // one sheet: open showing all of it (review first, zoom in to edit).
    // several sheets: fit the width, or every page becomes postage-stamp sized.
    var zlabel = overlay.querySelector('[data-role=zlabel]');

    function avail() {
      return { w: Math.max(280, overlay.clientWidth - 44),
               h: Math.max(240, overlay.clientHeight - 92) };
    }
    function computeScale() {
      var v = views[0];
      if (!v) return 1;
      var av = avail();
      var fitW = av.w / (v.page.width * Z);
      var fitP = Math.min(fitW, av.h / (v.page.height * Z));
      // never upscale in a fit mode: the page plate is a 2x raster, so enlarging it
      // past 100% only softens the art. Zoom in with + if you want it bigger.
      if (zoomMode === 'fitw') return Math.min(fitW, 1);
      if (zoomMode === 'fitp') return Math.min(fitP, 1);
      if (zoomMode === '1') return 1;
      return parseFloat(zoomMode) || 1;
    }
    function applyScale() {
      var s = computeScale();
      views.forEach(function (v) {
        v.scale = s;
        v.stage.style.width = (v.page.width * Z * s) + 'px';
        v.stage.style.height = (v.page.height * Z * s) + 'px';
      });
      zlabel.textContent = Math.round(s * 100) + '%';
    }
    function setZoom(mode) {
      zoomMode = (mode === undefined || mode === null) ? zoomMode : String(mode);
      applyScale();
    }
    applyScale();

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (zoomMode !== 'fitw' && zoomMode !== 'fitp') return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyScale, 80);
    });
    overlay.querySelector('[data-role=zin]').addEventListener('click', function () {
      setZoom(Math.min(4, computeScale() * 1.2));
    });
    overlay.querySelector('[data-role=zout]').addEventListener('click', function () {
      setZoom(Math.max(0.2, computeScale() / 1.2));
    });
    overlay.querySelector('[data-role=zlabel]').addEventListener('click', function () {
      setZoom(zoomMode === 'fitw' ? 'fitp' : (zoomMode === 'fitp' ? '1' : 'fitw'));
    });

    // ---- page controls ------------------------------------------------------
    overlay.querySelector('[data-role=pgprev]').addEventListener('click', function () {
      goPage(curPage - 1);
    });
    overlay.querySelector('[data-role=pgnext]').addEventListener('click', function () {
      goPage(curPage + 1);
    });
    overlay.querySelector('[data-role=pgdup]').addEventListener('click', duplicatePage);
    overlay.querySelector('[data-role=pgadd]').addEventListener('click', addBlankPage);
    overlay.querySelector('[data-role=pgdel]').addEventListener('click', deletePage);
    overlay.querySelector('[data-role=pages]').addEventListener('click', function (ev) {
      // clicking a sheet on the stage makes it the page the controls act on
      var st = ev.target.closest('.cv-stage');
      if (st) {
        var k = views.findIndex(function (v) { return v.stage === st; });
        if (k >= 0 && k !== curPage) { curPage = k; updatePageBar(); }
      }
    }, true);
    updatePageBar();

    // ---- measuring with the real fonts ----
    var measurer = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    measurer.setAttribute('xml:space', 'preserve');
    measurer.setAttribute('visibility', 'hidden');
    function attachMeasurer() {
      var host = views[0];
      if (host && measurer.parentNode !== host.svg) host.svg.appendChild(measurer);
    }
    attachMeasurer();
    function measure(text, size, track, font) {
      measurer.setAttribute('font-family', font || 'serif');
      measurer.setAttribute('font-size', size);
      measurer.setAttribute('letter-spacing', (track || 0) * size);
      measurer.textContent = text;
      var w = 0;
      try { w = measurer.getComputedTextLength(); } catch (e) { w = 0; }
      return w;
    }

    var edits = new Map();
    var imageEdits = new Map();     // "page:k" -> data URL
    var adds = [];                  // text boxes that did not exist in the PDF
    var deletes = new Set();        // gi of lines the client removed
    var addSeq = 0;
    var undoStack = [];
    var drag = null, wasDrag = false, editing = null, selAdd = null;
    var saveTimer = null, saving = false;

    function status(msg) { statusEl.textContent = msg; }
    function countStatus() {
      var n = edits.size + imageEdits.size + adds.length + deletes.size;
      var bits = [];
      if (edits.size) bits.push(edits.size + ' edited');
      if (adds.length) bits.push(adds.length + ' added');
      if (deletes.size) bits.push(deletes.size + ' deleted');
      if (imageEdits.size) bits.push(imageEdits.size + ' photo' + (imageEdits.size === 1 ? '' : 's'));
      status(n ? bits.join(' · ') : 'no changes');
    }
    function measureFor(i, fontOverride) {
      var v = root.MenuLines.effective(objects, edits, i);
      var f = cssForFont(fontOverride || v.font);
      return function (text, size, track) { return measure(text, size, track, f); };
    }
    function widthOfEdit(i) {
      if (!edits.has(i)) return objects[i].ink_width;
      var v = root.MenuLines.effective(objects, edits, i);
      return measure(v.text, v.size, v.track, cssForFont(v.font)) || objects[i].ink_width;
    }

    // ---- work: everything the client changed, in one object ------------------
    function workPayload() {
      return {
        edits: Array.from(edits), images: Array.from(imageEdits),
        adds: adds.map(function (a) {
          return { id: a.id, page: a.page, text: a.text, x: a.x, y: a.y,
                   size: a.size, track: a.track, font: a.font, color: a.color };
        }),
        // only real glyph ids: a stale payload must not smuggle an object in here
        deletes: Array.from(deletes).filter(function (d) { return typeof d === 'number'; }),
        page_ops: pageOps
      };
    }
    function loadWork(w) {
      if (!w) return 0;
      (w.edits || []).forEach(function (pair) {
        if (objects[pair[0]] !== undefined) edits.set(pair[0], pair[1]);
      });
      (w.images || []).forEach(function (pair) { imageEdits.set(pair[0], pair[1]); });
      (w.adds || []).forEach(function (a) {
        adds.push(Object.assign({}, a));
        addSeq = Math.max(addSeq, (parseInt(String(a.id).replace(/\D+/g, ''), 10) || 0) + 1);
      });
      (w.deletes || []).forEach(function (d) {
        // saved by this client as a gi, or by an older payload as {gi}
        var gi = (d && typeof d === 'object') ? d.gi : d;
        if (gi !== undefined && gi !== null) deletes.add(gi);
      });
      applySavedPageOps(w.page_ops);
      return edits.size + imageEdits.size + adds.length + deletes.size;
    }

    // Replay the sheet operations a saved project carries, so a reload opens the same
    // document the client was working on rather than the original PDF.
    function applySavedPageOps(ops) {
      if (!ops || (!(ops.new || []).length && !(ops.delete || []).length)) return;
      (ops.delete || []).forEach(function (orig) {
        var k = -1;
        data.pages.forEach(function (p, i) {
          if (k < 0 && p.src !== null && p.src !== undefined && p.src === orig) k = i;
        });
        if (k >= 0) {
          data.pages[k].objects.forEach(function (o) { /* its lines are simply gone */ });
          data.pages.splice(k, 1);
        }
      });
      (ops.new || []).forEach(function (spec, k) {
        var ref = null;
        if (spec.from !== null && spec.from !== undefined) {
          data.pages.forEach(function (p) {
            if (!ref && p.src !== null && p.src !== undefined && p.src === spec.from) ref = p;
          });
        }
        data.pages.push({
          index: data.pages.length,
          width: spec.width || (ref ? ref.width : 595),
          height: spec.height || (ref ? ref.height : 842),
          objects: [], vectors: ref ? ref.vectors : [], images: [],
          plate: ref ? ref.plate : null, src: null,
          art: spec.from === undefined ? null : spec.from, newIdx: k
        });
      });
      pageOps = { delete: (ops.delete || []).slice(), new: (ops.new || []).slice() };
      rebuildStages();
      curPage = Math.max(0, Math.min(curPage, data.pages.length - 1));
      goPage(curPage);
    }

    function snapshot() {
      return JSON.stringify({ edits: Array.from(edits), images: Array.from(imageEdits),
                              adds: adds, deletes: Array.from(deletes) });
    }
    function applySnapshot(json) {
      var snap = JSON.parse(json);
      edits.clear();
      (snap.edits || []).forEach(function (p) { edits.set(p[0], p[1]); });
      imageEdits.clear();
      (snap.images || []).forEach(function (p) { imageEdits.set(p[0], p[1]); });
      adds = (snap.adds || []).map(function (a) { return Object.assign({}, a); });
      deletes = new Set(snap.deletes || []);
      objects.forEach(function (o, i) { renderLine(i); });
      renderAdds();
      Array.from(imageSlots.keys()).forEach(renderImage);
    }

    function persist() {
      try { localStorage.setItem(docKey, snapshot()); } catch (e) {}
      scheduleSave();
    }
    // Autosave to the project folder: a reload must never cost work again.
    function scheduleSave() {
      if (!project) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveWork, 700);
    }
    async function saveWork() {
      if (!project || saving) return;
      saving = true;
      try {
        var res = await fetch(SERVICE + '/projects/' + encodeURIComponent(project.slug) + '/work', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(workPayload())
        });
        if (res.ok) {
          var j = await res.json();
          var t = String(j.savedAt || '').slice(11, 19);
          pnameEl.textContent = project.name;
          pnameEl.title = 'saved ' + t + ' · ' + project.slug;
        }
      } catch (e) { /* offline: the localStorage copy still has it */ }
      saving = false;
    }
    function restore() {
      // A project's saved work is the truth; the localStorage copy is the fallback
      // for a document opened without a workspace (sidecar down).
      var n = 0;
      if (opts.work) {
        n = loadWork(opts.work);
      } else {
        try {
          var raw = localStorage.getItem(docKey);
          if (raw) {
            var rec = JSON.parse(raw);
            n = loadWork(Array.isArray(rec) ? { edits: rec } : rec);
          }
        } catch (e) {}
      }
      objects.forEach(function (o, i) { renderLine(i); });
      renderAdds();
      Array.from(imageEdits.keys()).forEach(renderImage);
      return n;
    }
    function pushUndo() {
      undoStack.push(snapshot());
      if (undoStack.length > 60) undoStack.shift();
    }
    function undo() {
      if (!undoStack.length) { status('nothing to undo'); return; }
      applySnapshot(undoStack.pop());
      persist();
      countStatus();
      status(statusEl.textContent + ' (undo)');
    }
    function setLive(g, text, size, track, font, color) {
      var t = g.querySelector('.live');
      g.querySelector('.ink').style.display = 'none';
      t.style.display = '';
      t.textContent = text;
      t.setAttribute('font-size', size);
      t.setAttribute('letter-spacing', (track * size).toFixed(4));
      if (font) t.setAttribute('font-family', cssForFont(font));
      if (color) t.setAttribute('fill', color);
    }
    function renderLine(i) {
      var g = lines.get(i);
      if (!g) return;
      g.classList.toggle('del', deletes.has(i));
      if (!edits.has(i)) {
        g.querySelector('.ink').style.display = '';
        g.querySelector('.live').style.display = 'none';
        g.removeAttribute('transform');
        g.classList.remove('edited');
        return;
      }
      var v = root.MenuLines.effective(objects, edits, i);
      setLive(g, v.text, v.size, v.track, v.font, v.color);
      var dx = v.x - objects[i].x, dy = v.y - objects[i].y;
      g.setAttribute('transform', (dx || dy) ? 'translate(' + dx.toFixed(3) + ' ' + dy.toFixed(3) + ')' : '');
      g.classList.add('edited');
    }
    function renderImage(slot) {
      var g = imageSlots.get(slot);
      if (!g) return;
      var url = imageEdits.get(slot);
      var old = g.querySelector('image');
      if (!url) {
        if (old) old.remove();
        g.classList.remove('show');
        return;
      }
      var r = g.querySelector('rect');
      if (!old) {
        old = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        old.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        g.insertBefore(old, r);
      }
      old.setAttribute('href', url);
      old.setAttribute('x', r.getAttribute('x'));
      old.setAttribute('y', r.getAttribute('y'));
      old.setAttribute('width', r.getAttribute('width'));
      old.setAttribute('height', r.getAttribute('height'));
      g.classList.add('show');
    }
    // ---- added text boxes ---------------------------------------------------
    var NS = 'http://www.w3.org/2000/svg';

    function addWidth(a) {
      return measure(a.text || ' ', a.size, a.track, cssFor(a.font)) ||
             Math.max(24, (a.text || '').length * a.size * 0.5);
    }
    function defaultAddFont() {
      var keys = Object.keys(projFam);
      if (keys.length) return keys[0];
      var doc = Object.keys(fam);
      return doc.length ? doc[0] : 'serif';
    }
    function renderAdd(a) {
      var view = views[a.page];
      if (!view || !view.addsLayer) return null;
      var g = view.addsLayer.querySelector('[data-id="' + a.id + '"]');
      if (!g) {
        g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'cv-add');
        g.setAttribute('data-id', a.id);
        g.innerHTML = '<text xml:space="preserve"></text><rect class="hit"/>';
        view.addsLayer.appendChild(g);
      }
      var t = g.querySelector('text'), r = g.querySelector('rect');
      t.setAttribute('x', a.x.toFixed(3));
      t.setAttribute('y', a.y.toFixed(3));
      t.setAttribute('font-family', cssFor(a.font));
      t.setAttribute('font-size', a.size);
      t.setAttribute('letter-spacing', (a.track * a.size).toFixed(4));
      t.setAttribute('fill', a.color || '#131a24');
      t.textContent = a.text;
      var w = addWidth(a);
      r.setAttribute('x', (a.x - 1).toFixed(2));
      r.setAttribute('y', (a.y - a.size * 0.8).toFixed(2));
      r.setAttribute('width', Math.max(6, w + 2).toFixed(2));
      r.setAttribute('height', (a.size * 1.02).toFixed(2));
      return g;
    }
    function renderAdds() {
      views.forEach(function (v) { if (v.addsLayer) v.addsLayer.textContent = ''; });
      adds.forEach(function (a) { renderAdd(a); });
      if (selAdd) {
        var g = views[selAdd.page] && views[selAdd.page].addsLayer
          .querySelector('[data-id="' + selAdd.id + '"]');
        if (g) g.classList.add('sel');
      }
    }
    function findAdd(id) {
      for (var i = 0; i < adds.length; i++) if (adds[i].id === id) return adds[i];
      return null;
    }
    // A new box may not be dropped on top of existing text: same rule as moving a line.
    function clashForAdd(a) {
      var pad = 1.5;
      var w = addWidth(a);
      var x0 = a.x - pad, x1 = a.x + w + pad, y0 = a.y - a.size * 0.8, y1 = a.y + a.size * 0.25;
      for (var i = 0; i < objects.length; i++) {
        var o = objects[i];
        if (o.page !== a.page || deletes.has(o.gi)) continue;
        var v = edits.has(o.gi) ? root.MenuLines.effective(objects, edits, o.gi) : o;
        var ox0 = (v.ink_left !== undefined ? v.ink_left : v.x) - pad, ox1 = ox0 + (v.ink_width || 0) + pad * 2;
        var oy0 = v.y - v.size * 0.8, oy1 = v.y + v.size * 0.25;
        if (x0 < ox1 && x1 > ox0 && y0 < oy1 && y1 > oy0) return '“' + o.text.slice(0, 22) + '”';
      }
      for (var k = 0; k < adds.length; k++) {
        var b = adds[k];
        if (b.id === a.id || b.page !== a.page) continue;
        var bx1 = b.x + addWidth(b), by0 = b.y - b.size * 0.8, by1 = b.y + b.size * 0.25;
        if (x0 < bx1 && x1 > b.x && y0 < by1 && y1 > by0) return 'another added box';
      }
      return null;
    }
    // A new box should land somewhere empty. Walk down the page from the default
    // spot, then up, and take the first position that collides with nothing.
    function freeSpot(a) {
      var view = views[a.page];
      var H = view.page.height, step = Math.max(10, a.size * 1.6), y0 = a.y;
      for (var y = y0; y < H - 10; y += step) {
        a.y = y;
        if (!clashForAdd(a)) return a;
      }
      for (var up = y0 - step; up > 16; up -= step) {
        a.y = up;
        if (!clashForAdd(a)) return a;
      }
      a.y = y0;                     // nowhere free: put it back and let them drag
      return a;
    }
    function addText(opts) {
      opts = opts || {};
      if (allow.addText === false) {
        status('this menu does not allow adding text');
        return;
      }
      var view = views[opts.page != null ? opts.page : 0];
      var a = {
        id: 'n' + (addSeq++),
        page: view.index,
        text: opts.text || 'New line',
        x: opts.x != null ? opts.x : Math.round(view.page.width * 0.12),
        y: opts.y != null ? opts.y : Math.round(view.page.height * 0.5),
        size: opts.size || 12, track: 0,
        font: opts.font || defaultAddFont(), color: opts.color || '#131a24'
      };
      if (opts.x == null && opts.y == null) freeSpot(a);
      pushUndo();
      adds.push(a);
      var g = renderAdd(a);
      persist();
      countStatus();
      if (g) { selectAdd(a); startEditAdd(g); }
      return a;
    }
    function removeAdd(id) {
      var a = findAdd(id);
      if (!a) return;
      pushUndo();
      adds = adds.filter(function (x) { return x.id !== id; });
      var view = views[a.page];
      var g = view && view.addsLayer.querySelector('[data-id="' + id + '"]');
      if (g) g.remove();
      if (selAdd && selAdd.id === id) { selAdd = null; styleRow.classList.remove('on'); }
      persist();
      countStatus();
      status('text box removed');
    }
    function selectAdd(a) {
      views.forEach(function (v) {
        if (!v.addsLayer) return;
        v.addsLayer.querySelectorAll('.cv-add.sel').forEach(function (x) { x.classList.remove('sel'); });
      });
      selAdd = a || null;
      if (a) {
        var g = views[a.page].addsLayer.querySelector('[data-id="' + a.id + '"]');
        if (g) g.classList.add('sel');
        showStyleRow(a);
      } else {
        styleRow.classList.remove('on');
      }
    }
    function deleteSelection() {
      if (selAdd) { removeAdd(selAdd.id); return; }
      if (selLine === null) { status('click a line first, then Delete'); return; }
      if (isLocked(selLine)) {
        status('that line is locked by the designer — it cannot be deleted');
        return;
      }
      if (allow.deleteLines === false) {
        status('this menu does not allow deleting lines');
        return;
      }
      pushUndo();
      if (deletes.has(selLine)) deletes.delete(selLine); else deletes.add(selLine);
      renderLine(selLine);
      persist();
      countStatus();
      status(deletes.has(selLine)
        ? 'line deleted — click it again (or ⌘Z) to bring it back'
        : 'line restored');
    }

    // ---- style row: for a selected line or an added box ----------------------
    function fontOptions(current) {
      var keys = Object.keys(projFam).map(function (k) { return [k, 'project']; })
        .concat(Object.keys(fam).map(function (k) { return [k, 'document']; }));
      var seen = {}, opts = '', hit = false;
      keys.forEach(function (pair) {
        if (seen[pair[0]]) return;
        seen[pair[0]] = 1;
        if (pair[0] === current) hit = true;
        opts += '<option value="' + esc(pair[0]) + '"' + (pair[0] === current ? ' selected' : '') +
                '>' + esc(pair[0]) + ' · ' + pair[1] + '</option>';
      });
      // a line already restyled to a face that is not in either list keeps it
      if (!hit && current) {
        opts = '<option value="' + esc(current) + '" selected>' + esc(current) + '</option>' + opts;
      }
      return opts;
    }

    function showStyleRow(a) {
      styleRow.innerHTML =
        '<label>font</label><select data-role="fontsel">' + fontOptions(a && a.font) + '</select>' +
        '<label>size</label><input type="number" data-role="addsize" min="4" max="120" step="0.5" value="' +
        (a ? a.size : 12) + '">' +
        '<label>colour</label><input type="color" data-role="addcolor" value="' +
        (a && a.color ? a.color : '#131a24') + '">' +
        '<span class="sp"></span>' +
        '<button class="cv-btn" data-role="adddone">Done</button>' +
        '<button class="cv-btn" data-role="addremove">Remove box</button>';
      styleRow.classList.add('on');
      styleRow.querySelector('[data-role=fontsel]').onchange = function (ev) {
        if (!selAdd) return;
        pushUndo(); selAdd.font = ev.target.value; renderAdd(selAdd); persist();
      };
      styleRow.querySelector('[data-role=addsize]').oninput = function (ev) {
        if (!selAdd) return;
        var v = parseFloat(ev.target.value);
        if (!(v > 2)) return;
        selAdd.size = v; renderAdd(selAdd); persist();
      };
      styleRow.querySelector('[data-role=addcolor]').oninput = function (ev) {
        if (!selAdd) return;
        selAdd.color = ev.target.value; renderAdd(selAdd); persist();
      };
      styleRow.querySelector('[data-role=adddone]').onclick = function () { selectAdd(null); };
      styleRow.querySelector('[data-role=addremove]').onclick = function () {
        if (selAdd) removeAdd(selAdd.id);
      };
    }

    // style for a line that already exists: same row, applied to the selected line
    function showLineStyleRow(i) {
      var v = root.MenuLines.effective(objects, edits, i);
      var hex = /^#[0-9a-f]{6}$/i.test(String(v.color)) ? v.color : '#131a24';
      var restyle = allow.restyle !== false;
      styleRow.innerHTML =
        (restyle ? '<label>font</label><select data-role="lsfont">' + fontOptions(v.font) + '</select>' : '') +
        '<label>size</label><input type="number" data-role="lssize" min="4" max="120" step="0.5" value="' +
        (Math.round(v.size * 10) / 10) + '">' +
        (restyle ? '<label>colour</label><input type="color" data-role="lscolor" value="' + hex + '">' : '') +
        '<span class="sp"></span><span class="hint">' +
        (restyle ? 'applies to this line only · Enter to keep'
                 : 'the designer fixed the face and colour · size only') + '</span>';
      styleRow.classList.add('on');
      var fsel = styleRow.querySelector('[data-role=lsfont]');
      if (fsel) fsel.onchange = function (ev) {
        if (!editing) return;
        editing.font = ev.target.value;
        applyLive();
      };
      styleRow.querySelector('[data-role=lssize]').oninput = function (ev) {
        if (!editing) return;
        var n = parseFloat(ev.target.value);
        if (!(n > 2)) return;
        editing.size = n;
        applyLive();
      };
      var csel = styleRow.querySelector('[data-role=lscolor]');
      if (csel) csel.oninput = function (ev) {
        if (!editing) return;
        editing.color = ev.target.value;
        applyLive();
      };
    }

    // ---- inline editing of an added box ------------------------------------
    function startEditAdd(g) {
      if (editing) commitEdit();
      var a = findAdd(g.dataset.id);
      if (!a) return;
      var r = g.querySelector('.hit').getBoundingClientRect();
      var inp = document.createElement('input');
      inp.className = 'cv-input';
      inp.value = a.text;
      inp.style.left = r.left + 'px';
      inp.style.top = r.top + 'px';
      inp.style.width = Math.max(r.width + 80, 180) + 'px';
      inp.style.height = Math.max(r.height, 14) + 'px';
      inp.style.fontSize = (a.size * Z * (views[a.page] ? views[a.page].scale : 1)).toFixed(2) + 'px';
      inp.style.fontFamily = cssFor(a.font);
      inp.style.color = a.color || '#131a24';
      document.body.appendChild(inp);
      inp.focus();
      inp.select();
      editing = { kind: 'add', g: g, add: a, inp: inp, size: a.size, track: a.track,
                  fits: true, orig: a.text };
      showStyleRow(a);
      inp.addEventListener('input', function () {
        a.text = inp.value;
        var t = g.querySelector('text');
        t.textContent = inp.value;
        var w = addWidth(a);
        var rect = g.querySelector('rect');
        rect.setAttribute('width', Math.max(6, w + 2).toFixed(2));
      });
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
      });
      inp.addEventListener('blur', commitEdit);
    }
    function commitAdd() {
      var e = editing;
      editing = null;
      e.inp.remove();
      var a = e.add;
      if (!a.text.trim()) {
        // an empty box is not a text box
        var g = views[a.page].addsLayer.querySelector('[data-id="' + a.id + '"]');
        if (g) g.remove();
        adds = adds.filter(function (x) { return x.id !== a.id; });
        selectAdd(null);
        persist(); countStatus();
        return;
      }
      a.text = e.inp.value;
      renderAdd(a);
      persist();
      countStatus();
      status('text box updated');
    }

    function setEdit(i, patch) {
      pushUndo();
      root.MenuLines.applyEdit(edits, objects, i, patch);
      renderLine(i);
      persist();
      countStatus();
    }

    // ---- editing ----
    function startEdit(g) {
      if (editing) commitEdit();
      var i = parseInt(g.dataset.i, 10);
      if (isLocked(i)) {
        status('that line is locked by the designer — ask them for a change');
        return;
      }
      var o = objects[i];
      var v = root.MenuLines.effective(objects, edits, i);
      var r = g.querySelector('.hit').getBoundingClientRect();
      var inp = document.createElement('input');
      inp.className = 'cv-input';
      inp.value = v.text;
      inp.style.left = r.left + 'px';
      inp.style.top = r.top + 'px';
      inp.style.width = Math.max(r.width + 80, 160) + 'px';
      inp.style.height = Math.max(r.height, 14) + 'px';
      inp.style.fontSize = (v.size * Z * (views[o.page] ? views[o.page].scale : 1)).toFixed(2) + 'px';
      inp.style.fontFamily = cssForFont(v.font);
      inp.style.color = v.color;
      document.body.appendChild(inp);
      inp.focus();
      inp.select();
      editing = { g: g, i: i, inp: inp, size: v.size, track: v.track,
                  font: v.font, color: v.color,
                  floor: root.MenuLines.MIN_FIT, fits: true };
      trkEl.classList.add('on');
      showLineStyleRow(i);
      slider.value = v.track;
      trkval.textContent = v.track.toFixed(3) + ' em';
      applyLive();
      inp.addEventListener('input', applyLive);
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (ev.shiftKey && !editing.fits) { editing.floor = root.MenuLines.HARD_FIT; applyLive(); }
          commitEdit();
        } else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
        else if (ev.key === '[') { ev.preventDefault(); nudge(-0.01); }
        else if (ev.key === ']') { ev.preventDefault(); nudge(0.01); }
      });
      inp.addEventListener('blur', commitEdit);
    }
    function applyLive() {
      if (!editing) return;
      var i = editing.i, o = objects[i];
      var res = root.MenuLines.fit(o, editing.inp.value, editing.size, editing.track,
                                  measureFor(i, editing.font), o.max_width, editing.floor);
      editing.fits = res.fits;
      editing.sizeUsed = res.size;
      setLive(editing.g, editing.inp.value, res.size, res.track, editing.font, editing.color);
      editing.inp.classList.toggle('toowide', !res.fits);
      if (!res.fits) {
        status('too long — needs ' + res.w.toFixed(0) + 'pt, slot is ' + res.max.toFixed(0) +
               'pt (Shift+Enter to squeeze)');
      } else if (res.size < editing.size - 0.01) {
        status('fitted ' + Math.round(100 * res.size / editing.size) + '% — ' +
               res.w.toFixed(1) + ' / ' + res.max.toFixed(1) + ' pt');
      } else {
        status('fits ' + res.w.toFixed(1) + ' / ' + res.max.toFixed(1) + ' pt slot');
      }
    }
    function nudge(d) {
      if (!editing) return;
      editing.track = Math.round((editing.track + d) * 1000) / 1000;
      slider.value = editing.track;
      trkval.textContent = editing.track.toFixed(3) + ' em';
      applyLive();
    }
    function commitEdit() {
      if (!editing) return;
      if (editing.kind === 'add') { commitAdd(); return; }
      var e = editing;
      editing = null;
      e.inp.remove();
      trkEl.classList.remove('on');
      styleRow.classList.remove('on');
      if (e.g) e.g.classList.remove('sel');       // a leftover outline reads as a bug
      if (!e.fits) {
        status('edit refused — text too long for this slot');
        renderLine(e.i);
        return;
      }
      var v = root.MenuLines.effective(objects, edits, e.i);
      pushUndo();
      root.MenuLines.applyEdit(edits, objects, e.i,
        { text: e.inp.value, size: e.sizeUsed, track: e.track, x: v.x, y: v.y,
          font: e.font, color: e.color });
      renderLine(e.i);
      persist();
      countStatus();
    }
    function cancelEdit() {
      if (!editing) return;
      if (editing.kind === 'add') {
        var ea = editing;
        editing = null;
        ea.inp.remove();
        ea.add.text = ea.orig;
        renderAdd(ea.add);
        selectAdd(ea.add);
        return;
      }
      var e = editing;
      editing = null;
      e.inp.remove();
      trkEl.classList.remove('on');
      styleRow.classList.remove('on');
      if (e.g) e.g.classList.remove('sel');
      renderLine(e.i);
    }

    // ---- drag, per page ----  (lines and added boxes share one gesture path)
    function bindView(view) {
      var svgEl = view.svg;

      function clearSel() {
        views.forEach(function (v) {
          v.svg.querySelectorAll('.cv-line.sel').forEach(function (x) { x.classList.remove('sel'); });
        });
      }

      svgEl.addEventListener('pointerdown', function (ev) {
        var addG = ev.target.closest('.cv-add');
        if (addG) {
          var a = findAdd(addG.dataset.id);
          if (!a) return;
          clearSel();
          selectAdd(a);
          drag = { kind: 'add', view: view, g: addG, add: a, x: a.x, y: a.y,
                   sx: ev.clientX, sy: ev.clientY };
          wasDrag = false;
          return;
        }
        var g = ev.target.closest('.cv-line');
        if (!g) return;
        clearSel();
        selectAdd(null);
        g.classList.add('sel');
        var i = parseInt(g.dataset.i, 10);
        selLine = i;
        if (isLocked(i)) {
          // selectable, not movable: the designer's line stays where they put it
          status('that line is locked by the designer');
          return;
        }
        var v = root.MenuLines.effective(objects, edits, i);
        drag = { kind: 'line', view: view, g: g, i: i, x: v.x, y: v.y,
                 sx: ev.clientX, sy: ev.clientY };
        wasDrag = false;
      });

      svgEl.addEventListener('pointermove', function (ev) {
        if (!drag || drag.view !== view) return;
        var z = Z * (view.scale || 1);
        var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
        if (!wasDrag && Math.abs(dx) + Math.abs(dy) > 3) wasDrag = true;
        if (!wasDrag) return;
        var nx = drag.x + dx / z, ny = drag.y + dy / z;
        var baseX = drag.kind === 'add' ? drag.add.x : objects[drag.i].x;
        var baseY = drag.kind === 'add' ? drag.add.y : objects[drag.i].y;
        var sx = root.MenuLines.snapTo(nx, view.guides.xs.concat([baseX]));
        var sy = root.MenuLines.snapTo(ny, view.guides.ys.concat([baseY]));
        if (sx !== null) {
          nx = sx;
          view.guideY.setAttribute('x1', sx); view.guideY.setAttribute('x2', sx);
          view.guideY.style.display = 'block';
        } else view.guideY.style.display = 'none';
        if (sy !== null) {
          ny = sy;
          view.guideX.setAttribute('y1', sy); view.guideX.setAttribute('y2', sy);
          view.guideX.style.display = 'block';
        } else view.guideX.style.display = 'none';
        drag.g.setAttribute('transform', 'translate(' + (nx - drag.x).toFixed(3) + ' ' +
                            (ny - drag.y).toFixed(3) + ')');
        drag.nx = nx;
        drag.ny = ny;
      });

      svgEl.addEventListener('pointerup', function () {
        if (!drag || drag.view !== view) return;
        view.guideX.style.display = 'none';
        view.guideY.style.display = 'none';
        var d = drag;
        drag = null;
        d.g.removeAttribute('transform');
        if (!wasDrag || d.nx === undefined) return;

        if (d.kind === 'add') {
          // the box is drawn from its own coordinates, so move that and re-render
          var was = { x: d.add.x, y: d.add.y };
          d.add.x = d.nx; d.add.y = d.ny;
          var whyA = clashForAdd(d.add);
          if (whyA) {
            d.add.x = was.x; d.add.y = was.y;
            renderAdd(d.add);
            status('would overlap ' + whyA + ' — box moved back');
          } else {
            renderAdd(d.add);
            persist();
          }
          return;
        }

        var v = root.MenuLines.effective(objects, edits, d.i);
        var why = root.MenuLines.dropClash({
          objects: objects, vectors: view.vectors, page: view.page, edits: edits,
          i: d.i, x: d.nx, y: d.ny, size: v.size, width: widthOfEdit(d.i), widthOf: widthOfEdit
        });
        if (why) {
          d.g.removeAttribute('transform');
          status('would overlap ' + why + ' — moved back');
        } else {
          setEdit(d.i, { x: d.nx, y: d.ny });
        }
      });

      svgEl.addEventListener('click', function (ev) {
        var img = ev.target.closest('.cv-img');
        if (img) {
          pickImage(img.dataset.slot);
          return;
        }
        var addG = ev.target.closest('.cv-add');
        if (addG) {
          if (wasDrag) { wasDrag = false; return; }
          var a = findAdd(addG.dataset.id);
          if (a) { selectAdd(a); startEditAdd(addG); }
          return;
        }
        var g = ev.target.closest('.cv-line');
        var dragged = wasDrag;
        wasDrag = false;
        if (!g || dragged) return;
        var gi = parseInt(g.dataset.i, 10);
        // a deleted line is clickable: clicking it brings it back
        if (deletes.has(gi)) { selLine = gi; deleteSelection(); return; }
        ev.preventDefault();
        setTimeout(function () { startEdit(g); }, 0);
      });
    }
    views.forEach(bindView);

    // ---- image replacement ----
    var filePicker = null;
    function pickImage(slot) {
      if (!filePicker) {
        filePicker = document.createElement('input');
        filePicker.type = 'file';
        filePicker.accept = 'image/png,image/jpeg,image/webp';
        filePicker.style.display = 'none';
        document.body.appendChild(filePicker);
      }
      filePicker.value = '';
      filePicker.onchange = function () {
        var f = filePicker.files && filePicker.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          pushUndo();
          imageEdits.set(slot, String(reader.result));
          renderImage(slot);
          persist();
          countStatus();
          status('photo replaced for slot ' + slot + ' (' + f.name + ')');
        };
        reader.readAsDataURL(f);
      };
      filePicker.click();
    }

    // ---- controls ----
    slider.addEventListener('input', function () {
      if (!editing) return;
      editing.track = parseFloat(slider.value);
      trkval.textContent = editing.track.toFixed(3) + ' em';
      applyLive();
    });
    overlay.querySelector('[data-role=trkreset]').addEventListener('click', function () {
      if (!editing) return;
      editing.track = root.MenuLines.baseTrack(objects[editing.i]);
      slider.value = editing.track;
      trkval.textContent = editing.track.toFixed(3) + ' em';
      applyLive();
    });
    overlay.querySelector('[data-role=clear]').addEventListener('click', function () {
      if (!edits.size && !imageEdits.size && !adds.length && !deletes.size) {
        status('nothing to clear'); return;
      }
      pushUndo();
      edits.clear();
      imageEdits.clear();
      adds = [];
      deletes = new Set();
      selectAdd(null);
      objects.forEach(function (o, i) { renderLine(i); });
      renderAdds();
      Array.from(imageSlots.keys()).forEach(renderImage);
      persist();
      countStatus();
    });
    overlay.querySelector('[data-role=close]').addEventListener('click', function () {
      if (editing) commitEdit();
      if (project) saveWork();          // flush before the overlay goes away
      overlay.classList.remove('on');
      if (opts.onClose) opts.onClose();
    });
    overlay.querySelector('[data-role=export]').addEventListener('click', function () {
      exportPdf();
    });
    overlay.querySelector('[data-role=addtext]').addEventListener('click', function () {
      addText();
    });
    overlay.querySelector('[data-role=delete]').addEventListener('click', function () {
      deleteSelection();
    });

    // ---- font loader --------------------------------------------------------
    var fontPicker = document.createElement('input');
    fontPicker.type = 'file';
    fontPicker.accept = '.ttf,.otf,.woff,.woff2';
    fontPicker.multiple = true;
    fontPicker.style.display = 'none';
    document.body.appendChild(fontPicker);

    function b64Of(buffer) {
      var bytes = new Uint8Array(buffer), out = '', chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(out);
    }

    async function loadFontFiles(files) {
      if (!project) { status('open a project first — fonts are stored with the menu'); return; }
      var added = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        try {
          var buf = await f.arrayBuffer();
          var res = await fetch(SERVICE + '/projects/' + encodeURIComponent(project.slug) + '/fonts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: f.name, data: b64Of(buf) })
          });
          var j = await res.json();
          if (!res.ok) { status('font refused: ' + (j.error || res.status)); continue; }
          // register it now so the new box measures in the real face
          var name = 'PFx' + Object.keys(projFam).length + Math.floor(Math.random() * 1e4);
          projFam[j.family] = name;
          var st = document.createElement('style');
          st.textContent = "@font-face{font-family:'" + name + "';src:url('" + SERVICE + '/projects/' +
            encodeURIComponent(project.slug) + '/fonts/' + encodeURIComponent(j.file) + "');}";
          document.head.appendChild(st);
          try { await document.fonts.load('12px ' + name); } catch (e) {}
          if (project.fonts) project.fonts.push(j);
          added.push(j.family);
        } catch (err) {
          status('font failed: ' + (err && err.message ? err.message : err));
        }
      }
      if (added.length) {
        renderAdds();
        if (selAdd) showStyleRow(selAdd);
        status('font' + (added.length > 1 ? 's' : '') + ' loaded: ' + added.join(', '));
      }
    }
    overlay.querySelector('[data-role=fonts]').addEventListener('click', function () {
      fontPicker.value = '';
      fontPicker.onchange = function () {
        if (fontPicker.files && fontPicker.files.length) loadFontFiles(Array.from(fontPicker.files));
      };
      fontPicker.click();
    });

    // ---- project switcher ---------------------------------------------------
    overlay.querySelector('[data-role=projects]').addEventListener('click', function () {
      openWorkspace({ onClose: opts.onClose });
    });

    if (api._keyHandler) document.removeEventListener('keydown', api._keyHandler);
    api._keyHandler = function (ev) {
      if (!overlay.classList.contains('on')) return;
      var tag = (ev.target && ev.target.tagName) || '';
      var inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !editing) {
        ev.preventDefault();
        undo();
        return;
      }
      if (!editing && !inField && (ev.key === 'Delete' || ev.key === 'Backspace')) {
        ev.preventDefault();
        deleteSelection();
        return;
      }
      if (!editing && !inField && (ev.key === 't' || ev.key === 'T')) {
        ev.preventDefault();
        addText();
        return;
      }
      if (!editing && ev.key === 'b') {
        views.forEach(function (v) { v.stage.classList.toggle('cv-boxes'); });
      }
    };
    document.addEventListener('keydown', api._keyHandler);

    async function exportPdf() {
      if (!edits.size && !imageEdits.size && !adds.length && !deletes.size &&
          !pageOps.new.length && !pageOps.delete.length) {
        status('no changes to export'); return;
      }
      status('exporting…');
      var images = [];
      imageEdits.forEach(function (url, slot) {
        var parts = slot.split(':');
        var view = views[parseInt(parts[0], 10)];
        var r = view.images[parseInt(parts[1], 10)];
        if (r) images.push({ page: view.index, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, data: url });
      });
      var body = {
        edits: root.MenuLines.payload(edits, objects),
        images: images,
        adds: adds.map(function (a) {
          return { id: a.id, page: a.page, text: a.text, x: a.x, y: a.y,
                   size: a.size, track: a.track, font: a.font, color: a.color };
        }),
        deletes: Array.from(deletes).filter(function (d) { return typeof d === 'number'; })
          .map(function (gi) { return { gi: gi }; }),
        page_ops: pageOps
      };
      var url = SERVICE + '/splice';
      if (project) url = SERVICE + '/projects/' + encodeURIComponent(project.slug) + '/export';
      else body.pdf = pdfBase64;
      var res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!res.ok) { status('export failed: ' + (await res.text()).slice(0, 120)); return; }
      var refused = res.headers.get('X-Edits-Refused');
      var applied = res.headers.get('X-Edits-Applied');
      var placed = res.headers.get('X-Images-Placed');
      var addedN = res.headers.get('X-Adds-Applied');
      var deletedN = res.headers.get('X-Deletes-Applied');
      var savedName = res.headers.get('X-Export-Name');
      var blob = await res.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = savedName || (project ? project.slug + '.pdf' : 'menu-canvas.pdf');
      document.body.appendChild(a);
      a.click();
      a.remove();
      var bits = [];
      if (edits.size) bits.push((applied === null ? edits.size : applied) + ' edited');
      if (adds.length) bits.push((addedN === null ? adds.length : addedN) + ' added');
      if (deletes.size) bits.push((deletedN === null ? deletes.size : deletedN) + ' deleted');
      if (imageEdits.size) bits.push((placed === null ? imageEdits.size : placed) + ' image(s)');
      var pa = res.headers.get('X-Pages-Added'), pd = res.headers.get('X-Pages-Deleted');
      if (pageOps.new.length) bits.push((pa === null ? pageOps.new.length : pa) + ' page(s) added');
      if (pageOps.delete.length) bits.push((pd === null ? pageOps.delete.length : pd) + ' page(s) deleted');
      status('exported ' + bits.join(' · ') + ' · ' + Math.round(blob.size / 1024) + 'K' +
             (savedName ? ' · saved in project' : '') +
             (refused && refused !== '0' ? ' · ' + refused + ' refused' : ''));
    }

    var restored = restore();
    countStatus();
    if (restored) status(restored + (restored === 1 ? ' edit' : ' edits') + ' restored');
    api.current = { edits: edits, imageEdits: imageEdits, objects: objects, views: views,
                    renderLine: renderLine, renderImage: renderImage, setEdit: setEdit,
                    undo: undo, measure: measure, fam: fam, docKey: docKey, status: status,
                    pages: data.pages, pickImage: pickImage, setZoom: setZoom,
                    project: project, adds: function () { return adds; },
                    deletes: function () { return Array.from(deletes); },
                    addText: addText, removeAdd: removeAdd, selectAdd: selectAdd,
                    deleteSelection: deleteSelection, renderAdds: renderAdds,
                    saveWork: saveWork, workPayload: workPayload,
                    zoom: function () { return views[0] ? views[0].scale : 1; } };
    return api.current;
  }

  // ---- the workspace chooser ------------------------------------------------
  // Outside open(): the app needs a way in that is not "pick a file" — a client
  // who already has a menu should land on their menu.
  function toB64(buffer) {
    var bytes = new Uint8Array(buffer), out = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function openWorkspace(opts) {
    opts = opts || {};
    styles();
    var panel = document.createElement('div');
    panel.className = 'cv-panel on';
    panel.innerHTML =
      '<div class="box"><h3>Open a menu</h3><div class="rows"><div class="empty">loading…</div></div>' +
      '<div class="foot"><button class="cv-btn" data-role="newfile">New from file…</button>' +
      '<button class="cv-btn" data-role="cancel">Close</button></div></div>';
    document.body.appendChild(panel);
    var rows = panel.querySelector('.rows');
    var close = function () { panel.remove(); };

    var picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/pdf,image/png,image/jpeg,image/webp';
    picker.style.display = 'none';
    document.body.appendChild(picker);

    function openSlug(slug) {
      fetch(SERVICE + '/projects/' + encodeURIComponent(slug))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          close();
          open({
            data: j.lines,
            project: { slug: j.meta.slug, name: j.meta.name, fonts: j.fonts || [] },
            work: j.work,
            manifest: j.manifest,
            onClose: opts.onClose
          });
        })
        .catch(function (e) { rows.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
    }

    fetch(SERVICE + '/projects')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var list = j.projects || [];
        if (!list.length) {
          rows.innerHTML = '<div class="empty">No menus yet. “New from file…” turns the PDF ' +
            'a designer sent into a menu you can keep editing — the original is never altered.</div>';
          return;
        }
        rows.innerHTML = list.map(function (p) {
          return '<div class="row" data-slug="' + esc(p.slug) + '"><div style="flex:1">' +
            '<b>' + esc(p.name) + '</b><br><span>' + p.pages + ' page' + (p.pages === 1 ? '' : 's') +
            ' · updated ' + esc(String(p.updated || '').replace('T', ' ')) +
            (p.hasEdits ? ' · has changes' : '') + '</span></div></div>';
        }).join('');
        rows.querySelectorAll('.row').forEach(function (row) {
          row.onclick = function () { openSlug(row.dataset.slug); };
        });
      })
      .catch(function () {
        rows.innerHTML = '<div class="empty">The sidecar is not answering on ' + SERVICE +
          '. Start it with <code>.lines/bin/python sidecar/lines_server.py</code>.</div>';
      });

    panel.querySelector('[data-role=cancel]').onclick = close;
    panel.querySelector('[data-role=newfile]').onclick = function () {
      picker.value = '';
      picker.onchange = async function () {
        var f = picker.files && picker.files[0];
        if (!f) return;
        rows.innerHTML = '<div class="empty">reading ' + esc(f.name) + '…</div>';
        try {
          var buf = await f.arrayBuffer();
          var head = new Uint8Array(buf.slice(0, 8));
          var isPdf = head[0] === 0x25 && head[1] === 0x50;      // %P
          var isImg = (head[0] === 0x89 && head[1] === 0x50) ||    // PNG
                      (head[0] === 0xFF && head[1] === 0xD8) ||    // JPEG
                      (head[0] === 0x52 && head[1] === 0x49);      // RIFF/WebP
          if (!isPdf && !isImg) {
            rows.innerHTML = '<div class="empty">that is a PDF or an image (PNG, JPEG, WebP)</div>';
            return;
          }
          var body = { name: f.name.replace(/\.[a-z0-9]+$/i, '') };
          if (isPdf) body.pdf = toB64(buf); else { body.image = toB64(buf); body.filename = f.name; }
          var res = await fetch(SERVICE + '/projects', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          var j = await res.json();
          if (!res.ok) { rows.innerHTML = '<div class="empty">' + esc(j.error || res.status) + '</div>'; return; }
          openSlug(j.meta.slug);
        } catch (e) {
          rows.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
        }
      };
      picker.click();
    };
  }
  api.openWorkspace = openWorkspace;

  root.MenuCanvas = api;
})(typeof self !== 'undefined' ? self : this);
