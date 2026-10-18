/* quote-fields.js — the shared "what do you need?" part of a quote request (online shop and POS counter).
   Order on the form (below "Describe the item"):
     Sizes and details   dropdowns: material, size, thickness, finish, cutting / bending (size and thickness also accept a typed value)
                         The choices follow the item: describe "stainless sheet" (or pick a material) and only stainless options are shown.
     Quantity            number + unit dropdown (whole numbers for pcs / sheets / sets..., decimals only for kg and linear m)
     Needed by           date picker: tomorrow at the earliest, up to 6 months from today
     Extra notes         optional
   The choices and rules come from the server (GET /api/shop/quote-options or /api/pos/quote-options), so the page and the
   server always agree.  The server checks every rule again; the checks here only give faster feedback.
   Usage:  QuoteFields.mount(hostElement, { prefix: 'q', options })   then   QuoteFields.read('q') / validate('q') / reset('q') */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var OTHER = '__other__';
  var FIELDS = [['material', 'Material'], ['size', 'Size'], ['thickness', 'Thickness'], ['finish', 'Finish'], ['service', 'Cutting / bending']];
  var CUSTOM_HINT = { size: 'e.g. 600 x 900 mm', thickness: 'e.g. 1.8 mm' };
  var CUSTOM_RE = /^[\p{L}\p{N}\s.,x\u00D7\-"'\/()+*]+$/u;
  var state = {};                                           // prefix -> { options, picked, hint, offKey, timer }

  var opts = function (list, first) { return '<option value="">' + esc(first) + '</option>' + list.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join(''); };
  var escRe = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var hasWord = function (text, w) { return new RegExp('(^|[^a-z0-9])' + escRe(w), 'i').test(text); };   // word start, so "steel" never matches "tee"
  var isCustom = function (o, k) { return (o.customAllowed || []).indexOf(k) >= 0; };
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var dayText = function (s) { return new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }); };

  // earliest / latest date: the server tells us (Philippine time); this is only the fallback
  function limits(o) {
    if (o.neededMin && o.neededMax) return { min: o.neededMin, max: o.neededMax };
    var today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })), min = new Date(today), max = new Date(today);
    min.setDate(min.getDate() + 1); max.setMonth(max.getMonth() + (o.neededMaxMonths || 6));
    return { min: ymd(min), max: ymd(max) };
  }
  var wholeUnit = function (p) { var o = state[p].options, u = $(p + 'Unit').value; return (o.decimalUnits || []).indexOf(u) < 0; };

  function mount(host, cfg) {
    var p = cfg.prefix, o = cfg.options || {}, lim = limits(o);
    state[p] = { options: o, picked: false, hint: null, offKey: null, timer: null };
    var h = '<div class="qx-title">Sizes and details</div>' +
      '<div class="qx-narrow" id="' + p + 'Narrow" hidden></div>' +
      '<div class="q-grid">' +
      FIELDS.map(function (f) {
        var k = f[0], custom = isCustom(o, k);
        return '<div class="q-field"><label for="' + p + 'S_' + k + '">' + f[1] + '</label>' +
          '<select id="' + p + 'S_' + k + '">' + opts(o[k] || [], 'Choose ' + f[1].toLowerCase()) + (custom ? '<option value="' + OTHER + '">Other (type it)</option>' : '') + '</select>' +
          (custom ? '<input id="' + p + 'C_' + k + '" type="text" maxlength="40" class="qx-custom" placeholder="' + CUSTOM_HINT[k] + '" hidden>' : '') +
          '<div class="err-text" id="' + p + 'E_' + k + '"></div></div>';
      }).join('') + '</div>' +
      '<div class="q-grid">' +
      '<div class="q-field"><label for="' + p + 'Qty">Quantity</label>' +
        '<div class="qx-row"><input id="' + p + 'Qty" type="text" inputmode="decimal" maxlength="12" autocomplete="off" placeholder="e.g. 200">' +
        '<select id="' + p + 'Unit" aria-label="Unit">' + (o.units || []).map(function (u) { return '<option value="' + esc(u) + '">' + esc(u) + '</option>'; }).join('') + '</select></div>' +
        '<small id="' + p + 'QtyHint" class="q-hint"></small><div class="err-text" id="' + p + 'E_quantity"></div></div>' +
      '<div class="q-field"><label for="' + p + 'Needed">Needed by</label>' +
        '<input id="' + p + 'Needed" type="date" min="' + lim.min + '" max="' + lim.max + '">' +
        '<small id="' + p + 'NeededHint" class="q-hint">Pick a date from ' + esc(dayText(lim.min)) + ' up to ' + esc(dayText(lim.max)) + '.</small><div class="err-text" id="' + p + 'E_neededBy"></div></div></div>' +
      '<div class="q-field"><label for="' + p + 'Notes">Extra notes <span class="q-optional">(optional)</span></label>' +
        '<textarea id="' + p + 'Notes" rows="3" maxlength="1000" placeholder="Anything else we should know, e.g. hole spacing, drawing reference, delivery floor"></textarea>' +
        '<div class="q-meta"><div class="err-text" id="' + p + 'E_notes"></div><span class="q-count" id="' + p + 'NotesCount">0 / 1000</span></div></div>';
    host.innerHTML = h;
    FIELDS.forEach(function (f) {
      var k = f[0], sel = $(p + 'S_' + k), c = $(p + 'C_' + k);
      sel.addEventListener('change', function () {
        if (c) { c.hidden = sel.value !== OTHER; if (!c.hidden) c.focus(); }
        if (k === 'material') { state[p].picked = true; rebuildAll(p, true); }      // the material decides which finishes / thicknesses fit
        check(p, k);
      });
      if (c) { c.addEventListener('input', function () { if (c.classList.contains('is-bad')) check(p, k); }); c.addEventListener('blur', function () { check(p, k); }); }
    });
    $(p + 'Qty').addEventListener('blur', function () { check(p, 'quantity'); });
    $(p + 'Qty').addEventListener('input', function () { var el = $(p + 'Qty'), d = el.value.replace(wholeUnit(p) ? /[^\d,]/g : /[^\d.,]/g, ''); if (d !== el.value) el.value = d; if (el.classList.contains('is-bad')) check(p, 'quantity'); });
    $(p + 'Unit').addEventListener('change', function () { var el = $(p + 'Qty'); if (wholeUnit(p)) el.value = el.value.replace(/\..*$/, ''); if (el.value) check(p, 'quantity'); });
    $(p + 'Needed').addEventListener('change', function () { check(p, 'neededBy'); neededNote(p); });
    $(p + 'Notes').addEventListener('input', function () { $(p + 'NotesCount').textContent = $(p + 'Notes').value.length + ' / 1000'; });
    $(p + 'Narrow').addEventListener('click', function (e) { if (e.target.getAttribute('data-showall')) { state[p].offKey = state[p].hintKey; refresh(p); } });
    var item = itemInput(p); if (item) item.addEventListener('input', function () { clearTimeout(state[p].timer); state[p].timer = setTimeout(function () { refresh(p); }, 250); });
    refresh(p);
  }

  // ---- the options follow the item --------------------------------------------------------------------------------------
  // "Describe the item" is free text, so it is only used to NARROW the dropdowns (stainless sheet -> stainless materials, sheet sizes,
  // stainless finishes). The chosen material then decides the finish / thickness / cutting that fit it. Nothing is ever forced:
  // "Show all options" puts every choice back, and the server checks the final combination again.
  var itemInput = function (p) { return $(p + 'ProductName') || $(p + 'Item'); };
  function itemText(p) {
    var sel = $(p + 'Product');
    if (sel && sel.value) return sel.options[sel.selectedIndex].text.toLowerCase();       // a catalog product: use its name
    var it = itemInput(p); return it ? it.value.toLowerCase() : '';
  }
  function detect(p) {
    var o = state[p].options, text = itemText(p), fam = null, form = null;
    (o.families || []).some(function (f) { if (f.words.some(function (w) { return hasWord(text, w); })) { fam = f; return true; } });
    (o.forms || []).some(function (f) { if (f.words.some(function (w) { return hasWord(text, w); })) { form = f; return true; } });
    if (!fam && !form) return null;
    var mats = fam ? fam.materials : null, pick = null;
    if (fam && fam.grades) Object.keys(fam.grades).forEach(function (g) { if (!pick && text.indexOf(g) >= 0) pick = fam.grades[g]; });   // "SS 316" -> Stainless Steel 316
    if (!pick && mats && mats.length === 1) pick = mats[0];
    return { key: (fam ? fam.label : '') + '|' + (form ? form.label : ''), famLabel: fam && fam.label, formLabel: form && form.label, materials: mats, sizes: form && form.sizes, pick: pick };
  }
  function matValue(p) { var v = $(p + 'S_material').value, r = state[p].options.rules || {}; return v && v !== OTHER && r[v] ? v : ''; }
  function listFor(p, k) {
    var s = state[p], o = s.options, h = s.hint || {};
    if (k === 'material') return h.materials || o.material;
    if (k === 'size') return h.sizes || o.size;
    var m = matValue(p), mats = m ? [m] : (h.materials || null);
    if (!mats) return o[k];
    return o[k].filter(function (v) { return mats.some(function (x) { var r = o.rules[x]; return !r || r[k].indexOf(v) >= 0; }); });
  }
  function rebuild(p, k) {
    var o = state[p].options, sel = $(p + 'S_' + k), c = $(p + 'C_' + k); if (!sel || sel.getAttribute('data-auto')) return;   // locked from the product record
    var cur = sel.value, list = listFor(p, k), label = FIELDS.filter(function (f) { return f[0] === k; })[0][1];
    sel.innerHTML = opts(list, 'Choose ' + label.toLowerCase()) + (isCustom(o, k) ? '<option value="' + OTHER + '">Other (type it)</option>' : '');
    sel.value = (cur === OTHER && isCustom(o, k)) || list.indexOf(cur) >= 0 ? cur : '';
    if (c) c.hidden = sel.value !== OTHER;
    if (cur && sel.value !== cur) setErr(p, k, '');
  }
  function rebuildAll(p, dependentsOnly) {
    FIELDS.forEach(function (f) { if (!dependentsOnly || ['thickness', 'finish', 'service'].indexOf(f[0]) >= 0) rebuild(p, f[0]); });
  }
  function refresh(p) {
    var s = state[p]; if (!s) return;
    var h = detect(p); s.hintKey = h && h.key;
    if (h && h.key === s.offKey) h = null; else if (!h || h.key !== s.offKey) s.offKey = null;
    var changed = (s.hint && s.hint.key) !== (h && h.key); s.hint = h;
    var msel = $(p + 'S_material');
    if (changed) s.picked = false;                                                            // a new description starts afresh
    rebuild(p, 'material');
    if (h && h.pick && !s.picked && !msel.getAttribute('data-auto')) msel.value = h.pick;      // only until the person picks a material themselves
    rebuildAll(p, false);
    var note = $(p + 'Narrow');
    if (h) { note.innerHTML = 'Options narrowed for <b>' + esc([h.famLabel, h.formLabel].filter(Boolean).join(' \u00B7 ')) + '</b>. <button type="button" class="qx-link" data-showall="1">Show all options</button>'; note.hidden = false; }
    else { note.innerHTML = ''; note.hidden = true; }
  }

  // ---- checks -------------------------------------------------------------------------------------------------------------
  function neededNote(p) {
    var el = $(p + 'Needed'), hint = $(p + 'NeededHint'), lim = limits(state[p].options);
    if (!el.value || el.value < lim.min || el.value > lim.max) { hint.textContent = 'Pick a date from ' + dayText(lim.min) + ' up to ' + dayText(lim.max) + '.'; return; }
    var days = Math.round((new Date(el.value + 'T00:00:00') - new Date(lim.min + 'T00:00:00')) / 864e5) + 1;
    hint.textContent = days < 7 ? 'About ' + days + (days === 1 ? ' day' : ' days') + ' from today.' : 'About ' + Math.round(days / 7) + (Math.round(days / 7) === 1 ? ' week' : ' weeks') + ' from today.';
  }
  function setErr(p, field, msg) {
    var box = $(p + 'E_' + field); if (box) box.textContent = msg || '';
    var el = field === 'quantity' ? $(p + 'Qty') : field === 'neededBy' ? $(p + 'Needed') : field === 'notes' ? $(p + 'Notes') : $(p + 'S_' + field);
    if (el) el.classList.toggle('is-bad', !!msg);
    var c = $(p + 'C_' + field); if (c) c.classList.toggle('is-bad', !!msg && !c.hidden);
    return !msg;
  }
  function rule(p, field) {
    if (field === 'quantity') {
      var v = $(p + 'Qty').value.replace(/,/g, '').trim(); if (!v) return 'Enter the quantity you need.';
      var n = Number(v); if (!isFinite(n) || n <= 0) return 'Enter a number greater than 0, e.g. 200.';
      if (n > 1000000) return 'That is too large. Enter up to 1,000,000.';
      if (wholeUnit(p) && !Number.isInteger(n)) return 'Use a whole number for ' + $(p + 'Unit').value + ', e.g. 200.';
      if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return 'Use at most 2 decimals.';
      return '';
    }
    if (field === 'neededBy') {
      var d = $(p + 'Needed').value, lim = limits(state[p].options);
      if (!d) return 'Choose the date you need it.';
      if (d < lim.min) return 'Choose a date after today (' + dayText(lim.min) + ' or later).';
      if (d > lim.max) return 'Choose a date within the next 6 months (up to ' + dayText(lim.max) + ').';
      return '';
    }
    if (field === 'notes') return '';
    var label = FIELDS.filter(function (f) { return f[0] === field; })[0][1].toLowerCase(), v2 = $(p + 'S_' + field).value;
    if (!v2) return 'Choose the ' + label + '.';
    if (v2 === OTHER) { var t = $(p + 'C_' + field).value.trim(); return t.length >= 2 && /\d/.test(t) && CUSTOM_RE.test(t) ? '' : 'Type the ' + label + ' with its number, ' + CUSTOM_HINT[field] + '.'; }
    return '';
  }
  function check(p, field) { return setErr(p, field, rule(p, field)); }

  // checks everything; returns { ok, focus } where focus is the id of the first field that needs attention (top to bottom)
  function validate(p) {
    var first = null, order = FIELDS.map(function (f) { return [f[0], p + 'S_' + f[0]]; }).concat([['quantity', p + 'Qty'], ['neededBy', p + 'Needed']]);
    order.forEach(function (x) { if (!check(p, x[0]) && !first) first = x[1]; });
    return { ok: !first, focus: first };
  }
  function read(p) {
    var specs = {};
    FIELDS.forEach(function (f) { var v = $(p + 'S_' + f[0]).value; specs[f[0]] = v === OTHER ? $(p + 'C_' + f[0]).value.trim() : v; });
    return { quantity: $(p + 'Qty').value.replace(/,/g, '').trim(), quantityUnit: $(p + 'Unit').value, neededBy: $(p + 'Needed').value || undefined, specs: specs, notes: $(p + 'Notes').value.trim() || undefined };
  }
  function reset(p) {
    var s = state[p], lim = limits(s.options);
    $(p + 'Qty').value = ''; $(p + 'Needed').value = ''; $(p + 'Needed').min = lim.min; $(p + 'Needed').max = lim.max; neededNote(p);
    $(p + 'Notes').value = ''; $(p + 'NotesCount').textContent = '0 / 1000';
    autofill(p, null);
    FIELDS.forEach(function (f) { $(p + 'S_' + f[0]).value = ''; var c = $(p + 'C_' + f[0]); if (c) { c.value = ''; c.hidden = true; } });
    s.picked = false; s.offKey = null; refresh(p);
    ['quantity', 'neededBy'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { setErr(p, k, ''); });
  }
  // show the server's message under the matching field; returns true if it belonged here
  function showServerError(p, fields) {
    var shown = false; fields = fields || {};
    ['quantity', 'neededBy', 'notes'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { if (fields[k]) { setErr(p, k, fields[k]); shown = true; } });
    return shown;
  }
  // pick the unit of the chosen catalog product (adds it to the list if the list does not have it)
  function setUnit(p, unit) {
    var sel = $(p + 'Unit'); if (!sel || !unit) return; var u = String(unit).toLowerCase();
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === u; });
    if (!has) { var o = document.createElement('option'); o.value = u; o.textContent = u; sel.appendChild(o); }
    sel.value = u;
    var q = $(p + 'Qty'); if (q && wholeUnit(p)) q.value = q.value.replace(/\..*$/, '');
  }
  // Fill Material / Size / Thickness / Finish from the chosen product's own record (its online specifications) and lock them,
  // so the customer or cashier does not retype what the database already knows. Anything the record does not state stays a dropdown
  // (narrowed to the product, e.g. a brass valve shows brass finishes). Call with the product's specs object, or with nothing
  // (custom item) to unlock everything. Same mapping as productSpecs() in shop-extras.js.
  var ALIAS = { material: ['material'], size: ['size', 'dimensions'], thickness: ['thickness'], finish: ['finish'] };
  function autofill(p, specs) {
    var lower = {}; Object.keys(specs || {}).forEach(function (k) { lower[k.trim().toLowerCase()] = String(specs[k] == null ? '' : specs[k]).trim(); });
    Object.keys(ALIAS).forEach(function (k) {
      var sel = $(p + 'S_' + k), c = $(p + 'C_' + k); if (!sel) return;
      var v = ALIAS[k].map(function (a) { return lower[a]; }).filter(Boolean)[0];
      var note = $(p + 'A_' + k);
      if (!note) { note = document.createElement('small'); note.id = p + 'A_' + k; note.className = 'q-hint'; sel.parentNode.insertBefore(note, sel.nextSibling); }
      if (v) {
        if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) { var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); sel.setAttribute('data-added', v); }
        sel.value = v; sel.disabled = true; if (c) { c.hidden = true; c.value = ''; }
        note.textContent = 'Taken from the product details.'; note.hidden = false; sel.setAttribute('data-auto', '1');
      } else {
        if (sel.getAttribute('data-auto')) { sel.value = ''; sel.removeAttribute('data-auto'); }
        sel.disabled = false; note.textContent = ''; note.hidden = true;
        var added = sel.getAttribute('data-added'); if (added && sel.value !== added) { Array.prototype.forEach.call(sel.options, function (o) { if (o.value === added) o.remove(); }); sel.removeAttribute('data-added'); }
      }
      setErr(p, k, '');
    });
    if (state[p]) { state[p].picked = false; refresh(p); }
  }
  function setHint(p, text) { var h = $(p + 'QtyHint'); if (h) h.textContent = text || ''; }
  function setQuantity(p, n) { $(p + 'Qty').value = n == null ? '' : String(n); }
  function setNotes(p, text) { $(p + 'Notes').value = text || ''; $(p + 'NotesCount').textContent = ($(p + 'Notes').value.length) + ' / 1000'; }

  var st = document.createElement('style');
  st.textContent = '.qx-row{display:flex;gap:8px}.qx-row input{flex:1 1 auto;min-width:0}.qx-row select{flex:0 0 38%;min-width:0}' +
    '.qx-title{margin:6px 0 10px;font-size:13.5px;font-weight:700;color:var(--text-dim)}.qx-custom{margin-top:8px}' +
    '.qx-narrow{margin:-4px 0 12px;font-size:12.5px;color:var(--text-faint)}.qx-narrow b{color:var(--text-dim);font-weight:600}' +
    '.qx-link{background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}';
  document.head.appendChild(st);

  window.QuoteFields = { mount: mount, read: read, validate: validate, reset: reset, showServerError: showServerError, setUnit: setUnit, autofill: autofill, setHint: setHint, setQuantity: setQuantity, setNotes: setNotes };
})();