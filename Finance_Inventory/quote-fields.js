/* quote-fields.js — the shared "what do you need?" part of a quote request (online shop and POS counter).
     Amount required   number + unit dropdown
     Needed within     months from today (dropdown) — no calendar, so a past or far-away date can never be typed
     Sizes and details dropdowns: material, size, thickness, finish, cutting / bending (size and thickness also accept a typed value)
     Extra notes       optional
   The choices come from the server (GET /api/shop/quote-options or /api/pos/quote-options), so the page and the
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
  var state = {};                                           // prefix -> { options }

  var monthLabel = function (m) { return m + (m === 1 ? ' month' : ' months'); };
  var opts = function (list, first) { return '<option value="">' + esc(first) + '</option>' + list.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join(''); };

  function mount(host, cfg) {
    var p = cfg.prefix, o = cfg.options || {};
    state[p] = { options: o };
    var months = (o.months || []).map(function (m) { return '<option value="' + m + '">Within ' + monthLabel(m) + '</option>'; }).join('');
    var h = '<div class="q-grid">' +
      '<div class="q-field"><label for="' + p + 'Qty">Amount required</label>' +
        '<div class="qx-row"><input id="' + p + 'Qty" type="text" inputmode="decimal" maxlength="12" autocomplete="off" placeholder="e.g. 200">' +
        '<select id="' + p + 'Unit" aria-label="Unit">' + (o.units || []).map(function (u) { return '<option value="' + esc(u) + '">' + esc(u) + '</option>'; }).join('') + '</select></div>' +
        '<small id="' + p + 'QtyHint" class="q-hint"></small><div class="err-text" id="' + p + 'E_quantity"></div></div>' +
      '<div class="q-field"><label for="' + p + 'Months">Needed within</label>' +
        '<select id="' + p + 'Months"><option value="">Choose how many months</option>' + months + '</select>' +
        '<small class="q-hint">Counted from today, e.g. 3 months.</small><div class="err-text" id="' + p + 'E_neededMonths"></div></div></div>' +
      '<div class="qx-title">Sizes and details</div><div class="q-grid">' +
      FIELDS.map(function (f) {
        var k = f[0], custom = (o.customAllowed || []).indexOf(k) >= 0;
        return '<div class="q-field"><label for="' + p + 'S_' + k + '">' + f[1] + '</label>' +
          '<select id="' + p + 'S_' + k + '">' + opts(o[k] || [], 'Choose ' + f[1].toLowerCase()) + (custom ? '<option value="' + OTHER + '">Other (type it)</option>' : '') + '</select>' +
          (custom ? '<input id="' + p + 'C_' + k + '" type="text" maxlength="40" class="qx-custom" placeholder="' + CUSTOM_HINT[k] + '" hidden>' : '') +
          '<div class="err-text" id="' + p + 'E_' + k + '"></div></div>';
      }).join('') + '</div>' +
      '<div class="q-field"><label for="' + p + 'Notes">Extra notes <span class="q-optional">(optional)</span></label>' +
        '<textarea id="' + p + 'Notes" rows="3" maxlength="1000" placeholder="Anything else we should know, e.g. hole spacing, drawing reference, delivery floor"></textarea>' +
        '<div class="q-meta"><div class="err-text" id="' + p + 'E_notes"></div><span class="q-count" id="' + p + 'NotesCount">0 / 1000</span></div></div>';
    host.innerHTML = h;
    FIELDS.forEach(function (f) {
      var k = f[0], sel = $(p + 'S_' + k), c = $(p + 'C_' + k);
      sel.addEventListener('change', function () { if (c) { c.hidden = sel.value !== OTHER; if (!c.hidden) c.focus(); } check(p, k); });
      if (c) { c.addEventListener('input', function () { if (c.classList.contains('is-bad')) check(p, k); }); c.addEventListener('blur', function () { check(p, k); }); }
    });
    $(p + 'Qty').addEventListener('blur', function () { check(p, 'quantity'); });
    $(p + 'Qty').addEventListener('input', function () { var el = $(p + 'Qty'), d = el.value.replace(/[^\d.,]/g, ''); if (d !== el.value) el.value = d; if (el.classList.contains('is-bad')) check(p, 'quantity'); });
    $(p + 'Months').addEventListener('change', function () { check(p, 'neededMonths'); });
    $(p + 'Notes').addEventListener('input', function () { $(p + 'NotesCount').textContent = $(p + 'Notes').value.length + ' / 1000'; });
  }

  function setErr(p, field, msg) {
    var box = $(p + 'E_' + field); if (box) box.textContent = msg || '';
    var el = field === 'quantity' ? $(p + 'Qty') : field === 'neededMonths' ? $(p + 'Months') : field === 'notes' ? $(p + 'Notes') : $(p + 'S_' + field);
    if (el) el.classList.toggle('is-bad', !!msg);
    var c = $(p + 'C_' + field); if (c) c.classList.toggle('is-bad', !!msg && !c.hidden);
    return !msg;
  }
  function rule(p, field) {
    if (field === 'quantity') {
      var v = $(p + 'Qty').value.replace(/,/g, '').trim(); if (!v) return 'Enter how much you need.';
      var n = Number(v); if (!isFinite(n) || n <= 0) return 'Enter a number greater than 0, e.g. 200.';
      if (n > 1000000) return 'That is too large. Enter up to 1,000,000.';
      if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return 'Use at most 2 decimals.';
      return '';
    }
    if (field === 'neededMonths') return $(p + 'Months').value ? '' : 'Choose how many months from now you need it.';
    if (field === 'notes') return '';
    var label = FIELDS.filter(function (f) { return f[0] === field; })[0][1].toLowerCase(), v2 = $(p + 'S_' + field).value;
    if (!v2) return 'Choose the ' + label + '.';
    if (v2 === OTHER) { var t = $(p + 'C_' + field).value.trim(); return t.length >= 2 && /\d/.test(t) && CUSTOM_RE.test(t) ? '' : 'Type the ' + label + ' with its number, ' + CUSTOM_HINT[field] + '.'; }
    return '';
  }
  function check(p, field) { return setErr(p, field, rule(p, field)); }

  // checks everything; returns { ok, focus } where focus is the id of the first field that needs attention
  function validate(p) {
    var first = null, order = [['quantity', p + 'Qty'], ['neededMonths', p + 'Months']].concat(FIELDS.map(function (f) { return [f[0], p + 'S_' + f[0]]; }));
    order.forEach(function (x) { if (!check(p, x[0]) && !first) first = x[1]; });
    return { ok: !first, focus: first };
  }
  function read(p) {
    var specs = {};
    FIELDS.forEach(function (f) { var v = $(p + 'S_' + f[0]).value; specs[f[0]] = v === OTHER ? $(p + 'C_' + f[0]).value.trim() : v; });
    return { quantity: $(p + 'Qty').value.replace(/,/g, '').trim(), quantityUnit: $(p + 'Unit').value, neededMonths: Number($(p + 'Months').value) || undefined, specs: specs, notes: $(p + 'Notes').value.trim() || undefined };
  }
  function reset(p) {
    $(p + 'Qty').value = ''; $(p + 'Months').value = ''; $(p + 'Notes').value = ''; $(p + 'NotesCount').textContent = '0 / 1000';
    FIELDS.forEach(function (f) { $(p + 'S_' + f[0]).value = ''; var c = $(p + 'C_' + f[0]); if (c) { c.value = ''; c.hidden = true; } });
    ['quantity', 'neededMonths'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { setErr(p, k, ''); });
  }
  // show the server's message under the matching field; returns true if it belonged here
  function showServerError(p, fields) {
    var shown = false; fields = fields || {};
    ['quantity', 'neededMonths', 'notes'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { if (fields[k]) { setErr(p, k, fields[k]); shown = true; } });
    return shown;
  }
  // pick the unit of the chosen catalog product (adds it to the list if the list does not have it)
  function setUnit(p, unit) {
    var sel = $(p + 'Unit'); if (!sel || !unit) return; var u = String(unit).toLowerCase();
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === u; });
    if (!has) { var o = document.createElement('option'); o.value = u; o.textContent = u; sel.appendChild(o); }
    sel.value = u;
  }
  function setHint(p, text) { var h = $(p + 'QtyHint'); if (h) h.textContent = text || ''; }
  function setQuantity(p, n) { $(p + 'Qty').value = n == null ? '' : String(n); }
  function setNotes(p, text) { $(p + 'Notes').value = text || ''; $(p + 'NotesCount').textContent = ($(p + 'Notes').value.length) + ' / 1000'; }

  var st = document.createElement('style');
  st.textContent = '.qx-row{display:flex;gap:8px}.qx-row input{flex:1 1 auto;min-width:0}.qx-row select{flex:0 0 38%;min-width:0}' +
    '.qx-title{margin:6px 0 10px;font-size:13.5px;font-weight:700;color:var(--text-dim)}.qx-custom{margin-top:8px}';
  document.head.appendChild(st);

  window.QuoteFields = { mount: mount, read: read, validate: validate, reset: reset, showServerError: showServerError, setUnit: setUnit, setHint: setHint, setQuantity: setQuantity, setNotes: setNotes };
})();
