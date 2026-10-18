/* quote-fields.js — the shared "what do you need?" part of a Reserve / Pre-order request (online shop and POS counter).
   Order on the form (below the product):
     Sizes and details   dropdowns, in this order: item type -> material -> size -> thickness -> finish -> cutting / bending
                         ITEM TYPE comes first because it decides what the rest can be: a sheet is offered sheet sizes (and needs a thickness),
                         a pipe is offered pipe sizes, a fitting has no sheet thickness and is not bent. Size and thickness stay locked
                         ("Choose the item type first") until the type is chosen. The MATERIAL then decides which finishes, thicknesses and
                         cutting fit it. Size and thickness may also be typed as a measurement with its unit ("Other").
     Quantity            number + unit. A catalog product is counted in its own unit (the unit is locked); a custom item picks a unit.
                         Under the quantity the form says whether this will be a RESERVATION (the whole quantity is in stock) or a PRE-ORDER.
     Needed by           date picker: tomorrow at the earliest, up to 6 months from today
     Extra notes         optional
   The choices and rules come from the server (GET /api/shop/quote-options or /api/pos/quote-options), so the page and the server always
   agree. The server checks every rule again and decides Reservation / Pre-order itself; the checks here only give faster feedback.
   Usage:  QuoteFields.mount(hostElement, { prefix: 'q', options })   then   QuoteFields.read('q') / validate('q') / reset('q') */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var OTHER = '__other__';
  var FIELDS = [['itemType', 'Item type'], ['material', 'Material'], ['size', 'Size'], ['thickness', 'Thickness'], ['finish', 'Finish'], ['service', 'Cutting / bending']];
  var DEP = ['size', 'thickness', 'service'];                // these wait for the item type
  var CUSTOM_HINT = { size: 'e.g. 600 x 900 mm', thickness: 'e.g. 1.8 mm' };
  var NUM = '\\d+(?:\\.\\d+)?(?:-\\d+\\/\\d+|\\/\\d+)?';
  var CUSTOM_RE = { size: new RegExp('^' + NUM + '(?:\\s*[x\\u00D7]\\s*' + NUM + '){0,2}\\s*(?:mm|cm|m|in|ft|"|\')$', 'i'), thickness: /^\d+(?:\.\d+)?\s*mm$/i };   // same patterns as the server
  var state = {};                                           // prefix -> { options, picked, typePicked, typeSuggested, hint, offKey, timer, stock }

  var opts = function (list, first) { return '<option value="">' + esc(first) + '</option>' + list.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join(''); };
  var escRe = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var hasWord = function (text, w) { return new RegExp('(^|[^a-z0-9])' + escRe(w), 'i').test(text); };   // word start, so "steel" never matches "tee"
  var isCustom = function (o, k) { return (o.customAllowed || []).indexOf(k) >= 0; };
  var labelOf = function (k) { return FIELDS.filter(function (f) { return f[0] === k; })[0][1]; };
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var dayText = function (s) { return new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }); };
  var num = function (v) { return Number(String(v || '').replace(/,/g, '').trim()); };
  function customOk(k, v) { return v.length >= 2 && v.length <= 40 && CUSTOM_RE[k].test(v) && /[1-9]/.test(v) && (k !== 'thickness' || (parseFloat(v) >= 0.1 && parseFloat(v) <= 50)); }

  // earliest / latest date: the server tells us (Philippine time); this is only the fallback
  function limits(o) {
    if (o.neededMin && o.neededMax) return { min: o.neededMin, max: o.neededMax };
    var today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })), min = new Date(today), max = new Date(today);
    min.setDate(min.getDate() + 1); max.setMonth(max.getMonth() + (o.neededMaxMonths || 6));
    return { min: ymd(min), max: ymd(max) };
  }
  var UNIT_CANON = { pcs: 'pc', pc: 'pc', piece: 'pc', pieces: 'pc', sheet: 'sheet', sheets: 'sheet', length: 'length', lengths: 'length', box: 'box', boxes: 'box', set: 'set', sets: 'set', roll: 'roll', rolls: 'roll', bundle: 'bundle', bundles: 'bundle', kg: 'kg', kgs: 'kg' };
  var canon = function (u) { u = String(u || '').toLowerCase().trim(); return UNIT_CANON[u] || u; };
  var wholeUnit = function (p) { var o = state[p].options, u = canon($(p + 'Unit').value); return (o.decimalUnits || []).map(canon).indexOf(u) < 0; };

  function mount(host, cfg) {
    var p = cfg.prefix, o = cfg.options || {}, lim = limits(o);
    state[p] = { options: o, picked: false, typePicked: false, typeSuggested: null, hint: null, offKey: null, timer: null, stock: null };
    var typeNames = (o.itemTypes || []).map(function (t) { return t.value; });
    var h = '<div class="qx-title">Sizes and details</div>' +
      '<div class="qx-narrow" id="' + p + 'Narrow" hidden></div>' +
      '<div class="q-grid">' +
      FIELDS.map(function (f) {
        var k = f[0], custom = isCustom(o, k);
        var list = k === 'itemType' ? typeNames : (o[k] || []);
        return '<div class="q-field"><label for="' + p + 'S_' + k + '">' + f[1] + '</label>' +
          '<select id="' + p + 'S_' + k + '">' + opts(list, 'Choose ' + f[1].toLowerCase()) + (custom ? '<option value="' + OTHER + '">Other (type it)</option>' : '') + '</select>' +
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
      '<div class="qx-type" id="' + p + 'Type" role="status" aria-live="polite"></div>' +
      '<div class="q-field"><label for="' + p + 'Notes">Extra notes <span class="q-optional">(optional)</span></label>' +
        '<textarea id="' + p + 'Notes" rows="3" maxlength="1000" placeholder="Anything else we should know, e.g. hole spacing, drawing reference, delivery floor"></textarea>' +
        '<div class="q-meta"><div class="err-text" id="' + p + 'E_notes"></div><span class="q-count" id="' + p + 'NotesCount">0 / 1000</span></div></div>';
    host.innerHTML = h;
    FIELDS.forEach(function (f) {
      var k = f[0], sel = $(p + 'S_' + k), c = $(p + 'C_' + k);
      sel.addEventListener('change', function () {
        if (c) { c.hidden = sel.value !== OTHER; if (!c.hidden) c.focus(); }
        if (k === 'itemType') { state[p].typePicked = true; rebuildAll(p); }              // the type decides the sizes, thickness and cutting that fit
        if (k === 'material') { state[p].picked = true; rebuildAll(p); }                  // the material decides which finishes / thicknesses fit
        check(p, k);
      });
      if (c) { c.addEventListener('input', function () { if (c.classList.contains('is-bad')) check(p, k); }); c.addEventListener('blur', function () { check(p, k); }); }
    });
    $(p + 'Qty').addEventListener('blur', function () { check(p, 'quantity'); });
    $(p + 'Qty').addEventListener('input', function () { var el = $(p + 'Qty'), d = el.value.replace(/[^\d.,]/g, ''); if (d !== el.value) el.value = d; if (el.classList.contains('is-bad')) check(p, 'quantity'); updateType(p); });   // letters are dropped, but a decimal is kept and explained (2.5 pcs is an error, never silently 25)
    $(p + 'Unit').addEventListener('change', function () { if ($(p + 'Qty').value) check(p, 'quantity'); updateType(p); });   // the number is kept; the message says if the new unit needs a whole number
    $(p + 'Needed').addEventListener('change', function () { check(p, 'neededBy'); neededNote(p); });
    $(p + 'Notes').addEventListener('input', function () { $(p + 'NotesCount').textContent = $(p + 'Notes').value.length + ' / 1000'; });
    $(p + 'Narrow').addEventListener('click', function (e) { if (e.target.getAttribute('data-showall')) { state[p].offKey = state[p].hintKey; refresh(p); } });
    var item = itemInput(p); if (item) item.addEventListener('input', function () { clearTimeout(state[p].timer); state[p].timer = setTimeout(function () { refresh(p); }, 250); });
    refresh(p); updateType(p);
  }

  // ---- the options follow the item --------------------------------------------------------------------------------------
  // The ITEM TYPE is a dropdown and is the only thing that decides sizes / thickness / cutting. "Describe the item" is free text, so it is only
  // used to SUGGEST a type and to narrow the material list (stainless sheet -> Sheet / Plate + stainless materials). Nothing is forced:
  // the person can change the suggestion, "Show all materials" puts every material back, and the server checks the final combination again.
  var itemInput = function (p) { return $(p + 'ProductName') || $(p + 'Item'); };
  function itemText(p) {
    var sel = $(p + 'Product');
    if (sel && sel.value) return sel.options[sel.selectedIndex].text.toLowerCase();       // a catalog product: use its name
    var it = itemInput(p); return it ? it.value.toLowerCase() : '';
  }
  function typeFromText(o, text) {
    var found = null; text = String(text || '').toLowerCase();
    (o.itemTypes || []).some(function (t) { if ((t.words || []).some(function (w) { return hasWord(text, w); })) { found = t; return true; } });   // first match wins (same order as the server)
    return found;
  }
  function typeOf(p) { var v = $(p + 'S_itemType').value, l = state[p].options.itemTypes || [], i; for (i = 0; i < l.length; i++) if (l[i].value === v) return l[i]; return null; }
  function detect(p) {
    var o = state[p].options, text = itemText(p), fam = null, type = typeFromText(o, text);
    (o.families || []).some(function (f) { if (f.words.some(function (w) { return hasWord(text, w); })) { fam = f; return true; } });
    if (!fam && !type) return null;
    var mats = fam ? fam.materials : null, pick = null;
    if (fam && fam.grades) Object.keys(fam.grades).forEach(function (g) { if (!pick && text.indexOf(g) >= 0) pick = fam.grades[g]; });   // "SS 316" -> Stainless Steel 316
    if (!pick && mats && mats.length === 1) pick = mats[0];
    return { key: (fam ? fam.label : '') + '|' + (type ? type.value : ''), famLabel: fam && fam.label, typeValue: type && type.value, materials: mats, pick: pick };
  }
  function matValue(p) { var v = $(p + 'S_material').value, r = state[p].options.rules || {}; return v && v !== OTHER && r[v] ? v : ''; }
  // what is offered for one dropdown right now (same rules as allowedFor() on the server)
  function listFor(p, k) {
    var s = state[p], o = s.options, h = s.hint || {}, type = typeOf(p);
    if (k === 'material') return h.materials || o.material;
    var m = matValue(p), mats = m ? [m] : (h.materials || null), list = o[k];
    if (k !== 'size' && mats) list = o[k].filter(function (v) { return mats.some(function (x) { var r = o.rules[x]; return !r || r[k].indexOf(v) >= 0; }); });
    if (!type) return list;
    if (k === 'size') return (type.sizes || []).concat(type.na ? ['Not applicable'] : []);
    if (k === 'thickness') return type.thickness === 'none' ? ['Not applicable'] : type.thickness === 'required' ? list.filter(function (v) { return v !== 'Not applicable'; }) : list;
    if (k === 'service') return list.filter(function (v) { return (type.service || []).indexOf(v) >= 0; });
    return list;
  }
  function canType(p, k) { var type = typeOf(p); return isCustom(state[p].options, k) && !(k === 'thickness' && type && type.thickness === 'none'); }
  function rebuild(p, k) {
    var sel = $(p + 'S_' + k), c = $(p + 'C_' + k); if (!sel || sel.getAttribute('data-auto')) return;   // locked from the product record
    var cur = sel.value, type = typeOf(p), label = labelOf(k).toLowerCase();
    if (DEP.indexOf(k) >= 0 && !type) {                                                  // size / thickness / cutting wait for the item type
      sel.innerHTML = opts([], 'Choose the item type first'); sel.disabled = true; if (c) { c.hidden = true; c.value = ''; }
      if (cur) setErr(p, k, ''); return;
    }
    var list = listFor(p, k), custom = canType(p, k);
    sel.disabled = false;
    sel.innerHTML = opts(list, 'Choose ' + label) + (custom ? '<option value="' + OTHER + '">Other (type it)</option>' : '');
    sel.value = (cur === OTHER && custom) || list.indexOf(cur) >= 0 ? cur : '';
    if (!sel.value && list.length === 1 && !custom) sel.value = list[0];                  // only one choice (e.g. a fitting has no thickness): choose it
    if (c) { c.hidden = sel.value !== OTHER; if (c.hidden) c.value = ''; }
    if (cur && sel.value !== cur) setErr(p, k, '');
  }
  function rebuildAll(p) { ['size', 'thickness', 'finish', 'service'].forEach(function (k) { rebuild(p, k); }); }
  function refresh(p) {
    var s = state[p]; if (!s) return;
    var h = detect(p); s.hintKey = h && h.key;
    if (h && h.key === s.offKey) h = null; else if (!h || h.key !== s.offKey) s.offKey = null;
    var changed = (s.hint && s.hint.key) !== (h && h.key); s.hint = h;
    var msel = $(p + 'S_material'), tsel = $(p + 'S_itemType'), tLocked = !!tsel.getAttribute('data-auto');
    if (changed) { s.picked = false; s.typePicked = false; }                              // a new description starts afresh
    rebuild(p, 'material');
    if (h && h.pick && !s.picked && !msel.getAttribute('data-auto')) msel.value = h.pick;      // only until the person picks a material themselves
    if (h && h.typeValue && !s.typePicked && !tLocked) { tsel.value = h.typeValue; s.typeSuggested = h.typeValue; }
    else if (!h && !s.offKey && !s.typePicked && !tLocked && s.typeSuggested && tsel.value === s.typeSuggested) { tsel.value = ''; s.typeSuggested = null; }   // the description changed: drop the old suggestion
    rebuildAll(p);
    var note = $(p + 'Narrow');
    if (h) { note.innerHTML = 'Options narrowed for <b>' + esc([h.famLabel, h.typeValue].filter(Boolean).join(' \u00B7 ')) + '</b>. <button type="button" class="qx-link" data-showall="1">Show all materials</button>'; note.hidden = false; }
    else { note.innerHTML = ''; note.hidden = true; }
  }

  // ---- Reservation or Pre-order ---------------------------------------------------------------------------------------
  // Same rule as the server: a catalog product whose whole quantity is in stock is a RESERVATION; anything else is a PRE-ORDER.
  function requestKind(p) { var s = state[p].stock, n = num($(p + 'Qty').value); if (!s) return 'Pre-order'; return n > 0 && n <= s.available ? 'Reservation' : 'Pre-order'; }
  function updateType(p) {
    var box = $(p + 'Type'); if (!box) return;
    var s = state[p].stock, n = num($(p + 'Qty').value), kind = requestKind(p), has = $(p + 'Qty').value.trim() !== '' && n > 0, at = s ? s.available + (s.unit ? ' ' + s.unit : '') : '';
    var msg;
    if (!s) msg = '<b>Pre-order.</b> We will make or order this item for the date you need it. We reply with a price first.';
    else if (!has) msg = s.available > 0 ? '<b>In stock: ' + esc(at) + '.</b> Ask for up to that and we reserve it for you. Ask for more and it becomes a pre-order.' : '<b>Out of stock.</b> This will be a pre-order: we order or make it for the date you need it.';
    else if (kind === 'Reservation') msg = '<b>Reservation.</b> We have ' + esc(at) + ' in stock. Once you accept our price, we set your quantity aside.';
    else msg = '<b>Pre-order.</b> We have ' + (s.available > 0 ? 'only ' + esc(at) + ' in stock' : 'none in stock') + '. We will make or order the quantity you asked for by your date.';
    box.className = 'qx-type ' + (!has && s && s.available > 0 ? '' : kind === 'Reservation' ? 'is-res' : 'is-pre');
    box.innerHTML = msg;
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
    var label = labelOf(field).toLowerCase(), v2 = $(p + 'S_' + field).value;
    if (!v2) return DEP.indexOf(field) >= 0 && !typeOf(p) ? 'Choose the item type first.' : 'Choose the ' + label + '.';
    if (v2 === OTHER) return customOk(field, $(p + 'C_' + field).value.trim()) ? '' : 'Type the ' + label + ' with its unit, ' + CUSTOM_HINT[field] + '.';
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
    autofill(p, null, null);
    FIELDS.forEach(function (f) { $(p + 'S_' + f[0]).value = ''; var c = $(p + 'C_' + f[0]); if (c) { c.value = ''; c.hidden = true; } });
    s.picked = false; s.typePicked = false; s.typeSuggested = null; s.offKey = null; s.stock = null; refresh(p); updateType(p);
    ['quantity', 'neededBy'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { setErr(p, k, ''); });
  }
  // show the server's message under the matching field; returns true if it belonged here
  function showServerError(p, fields) {
    var shown = false; fields = fields || {};
    ['quantity', 'neededBy', 'notes'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { if (fields[k]) { setErr(p, k, fields[k]); shown = true; } });
    return shown;
  }
  // pick the unit of the chosen catalog product and LOCK it (a catalog product is only counted in its own unit; the server enforces this too).
  // autofill(p, null, null) for a custom item unlocks it again.
  function setUnit(p, unit) {
    var sel = $(p + 'Unit'); if (!sel || !unit) return; var u = String(unit).toLowerCase();
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === u; });
    if (!has) { var o = document.createElement('option'); o.value = u; o.textContent = u; o.setAttribute('data-added', '1'); sel.appendChild(o); }
    sel.value = u; sel.disabled = true; sel.title = 'This item is counted in ' + u;
    if ($(p + 'Qty').value) check(p, 'quantity');
    updateType(p);
  }
  function unlockUnit(p) {
    var sel = $(p + 'Unit'); if (!sel) return;
    sel.disabled = false; sel.title = '';
    Array.prototype.slice.call(sel.options).forEach(function (o) { if (o.getAttribute('data-added') && o.value !== sel.value) o.remove(); });
  }
  // Fill Item type / Material / Size / Thickness / Finish from the chosen product (its name and its online specifications) and lock them,
  // so the customer or cashier does not retype what the database already knows. Anything the record does not state stays a dropdown
  // (narrowed to the product, e.g. a brass valve shows brass finishes). Call with the product's specs and name, or with nothing
  // (custom item) to unlock everything. Same mapping as productSpecs() / typeFromText() in shop-extras.js.
  var ALIAS = { material: ['material'], size: ['size', 'dimensions'], thickness: ['thickness'], finish: ['finish'] };
  function note(p, k, sel) {
    var n = $(p + 'A_' + k);
    if (!n) { n = document.createElement('small'); n.id = p + 'A_' + k; n.className = 'q-hint'; sel.parentNode.insertBefore(n, sel.nextSibling); }
    return n;
  }
  function autofill(p, specs, name) {
    var lower = {}; Object.keys(specs || {}).forEach(function (k) { lower[k.trim().toLowerCase()] = String(specs[k] == null ? '' : specs[k]).trim(); });
    if (!name) unlockUnit(p);
    var tsel = $(p + 'S_itemType'), tn = note(p, 'itemType', tsel), t = name && state[p] ? typeFromText(state[p].options, name) : null;
    if (t) { tsel.value = t.value; tsel.disabled = true; tsel.setAttribute('data-auto', '1'); tn.textContent = 'Taken from the product.'; tn.hidden = false; }
    else { if (tsel.getAttribute('data-auto')) { tsel.value = ''; tsel.removeAttribute('data-auto'); } tsel.disabled = false; tn.textContent = ''; tn.hidden = true; }
    setErr(p, 'itemType', '');
    Object.keys(ALIAS).forEach(function (k) {
      var sel = $(p + 'S_' + k), c = $(p + 'C_' + k); if (!sel) return;
      var v = ALIAS[k].map(function (a) { return lower[a]; }).filter(Boolean)[0];
      var n = note(p, k, sel);
      if (v) {
        if (!Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) { var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); sel.setAttribute('data-added', v); }
        sel.value = v; sel.disabled = true; if (c) { c.hidden = true; c.value = ''; }
        n.textContent = 'Taken from the product details.'; n.hidden = false; sel.setAttribute('data-auto', '1');
      } else {
        if (sel.getAttribute('data-auto')) { sel.value = ''; sel.removeAttribute('data-auto'); }
        sel.disabled = false; n.textContent = ''; n.hidden = true;
        var added = sel.getAttribute('data-added'); if (added && sel.value !== added) { Array.prototype.forEach.call(sel.options, function (o) { if (o.value === added) o.remove(); }); sel.removeAttribute('data-added'); }
      }
      setErr(p, k, '');
    });
    if (state[p]) { state[p].picked = false; state[p].typePicked = false; state[p].typeSuggested = null; refresh(p); }
  }
  // what the shelf holds for the chosen catalog product ({ available, unit }), or null for a custom item: drives the Reservation / Pre-order note
  function setStock(p, info) { if (!state[p]) return; state[p].stock = info && isFinite(Number(info.available)) ? { available: Math.max(0, Number(info.available)), unit: info.unit || '' } : null; updateType(p); }
  function setHint(p, text) { var h = $(p + 'QtyHint'); if (h) h.textContent = text || ''; }
  function setQuantity(p, n) { $(p + 'Qty').value = n == null ? '' : String(n); updateType(p); }
  function setNotes(p, text) { $(p + 'Notes').value = text || ''; $(p + 'NotesCount').textContent = ($(p + 'Notes').value.length) + ' / 1000'; }

  var st = document.createElement('style');
  st.textContent = '.qx-row{display:flex;gap:8px}.qx-row input{flex:1 1 auto;min-width:0}.qx-row select{flex:0 0 38%;min-width:0}' +
    '.qx-title{margin:6px 0 10px;font-size:13.5px;font-weight:700;color:var(--text-dim)}.qx-custom{margin-top:8px}' +
    '.qx-narrow{margin:-4px 0 12px;font-size:12.5px;color:var(--text-faint)}.qx-narrow b{color:var(--text-dim);font-weight:600}' +
    '.qx-link{background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}' +
    '.qx-type{margin:2px 0 14px;padding:10px 12px;border-radius:8px;border:1px solid var(--border,#2a3b4a);border-left-width:3px;font-size:13px;line-height:1.5;color:var(--text-dim)}.qx-type b{color:inherit;font-weight:700}' +
    '.qx-type.is-res{border-left-color:var(--green,#43c47a)}.qx-type.is-pre{border-left-color:var(--amber,#d9a441)}' +
    '.q-field select:disabled{opacity:.75;cursor:not-allowed}';
  document.head.appendChild(st);

  window.QuoteFields = { mount: mount, read: read, validate: validate, reset: reset, showServerError: showServerError, setUnit: setUnit, autofill: autofill, setStock: setStock, requestKind: requestKind, setHint: setHint, setQuantity: setQuantity, setNotes: setNotes };
})();
