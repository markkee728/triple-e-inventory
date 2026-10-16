/* api-bridge.js — connects the pages in script.js to the Triple E API.
   Loaded AFTER script.js in Finance_Inventory.html:
       <script src="script.js"></script>
       <script src="api-bridge.js"></script>
*/
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => (typeof escapeHTML === 'function' ? escapeHTML(String(v)) : String(v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'));
  const NEEDS_SUPPLIER = ['Raw Materials', 'Finishing Supplies'];
  const DEPARTMENTS = ['Raw Materials', 'Finished Goods', 'Finishing Supplies'];
  const NOTE_REQUIRED = ['other', 'count_correction_up', 'count_correction_down'];

  let REASONS = { in: {}, out: {} };
  const ALL_D = DEPARTMENTS;
  // Which departments each reason applies to. The server sends the same table; this copy is the fallback,
  // so the form still filters correctly (and ignores retired reasons) if an older server is running.
  const DEFAULT_REASON_DEPTS = {
    in: {
      supplier_receipt: ALL_D,
      customer_return: ['Finished Goods'],
      produced_batch: ['Finished Goods'],
      count_correction_up: ALL_D,
      other: ALL_D
    },
    out: {
      rust_corrosion: ['Raw Materials', 'Finished Goods'],
      damaged: ALL_D,
      scrap_cutting_waste: ['Raw Materials'],
      production_use: ['Raw Materials', 'Finishing Supplies'],
      quality_rejection: ['Raw Materials', 'Finished Goods'],
      lost_missing: ALL_D,
      returned_to_supplier: ['Raw Materials', 'Finishing Supplies'],
      count_correction_down: ALL_D,
      other: ALL_D
    }
  };
  let REASON_DEPTS = DEFAULT_REASON_DEPTS;
  let inventoryCache = [];
  let CATEGORIES = [];
  const NEW_CATEGORY = '__new__';
  let movementCache = [];
  let quotesCache = [];     // custom quote requests with their payments (counted in the sales reports once money is received)
  let salesCache = [];      // every POS sale + online order from /api/sales (used by the Sales Transaction Report)
  let currentUser = null;
  let avatarState = { has: false, v: 0 };   // profile photo (stored in the users table)

  /* ---------------- helpers ---------------- */
  async function api(path, options) {
    const res = await fetch('/api' + path, Object.assign(
      { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields, status: res.status });
    return data;
  }
  const replace = (arr, rows) => arr.splice(0, arr.length, ...rows);
  const safe = (fn) => { try { fn(); } catch (e) { console.warn('[api-bridge]', e.message); } };
  // small helper set for production-admin.js (production / material requirements)
  window.TripleEBridge = { api, toast, esc, inventory: () => inventoryCache, reload: () => load(), movementType: () => movementType() };

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'app-toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function clearErrors(root) {
    root.querySelectorAll('.field-msg').forEach((n) => n.remove());
    root.querySelectorAll('.field-invalid').forEach((n) => n.classList.remove('field-invalid'));
  }
  function setError(id, message) {
    const el = $(id);
    if (!el) return;
    el.classList.add('field-invalid');
    const group = el.closest('.form-group') || el.parentNode;
    group.querySelectorAll('.field-msg[data-for="' + id + '"]').forEach((n) => n.remove());
    const msg = document.createElement('div');
    msg.className = 'field-msg';
    msg.dataset.for = id;
    msg.textContent = message;
    group.appendChild(msg);
  }
  // errors: { elementId: message }
  function showErrors(form, banner, errors, fallback) {
    clearErrors(form);
    const ids = Object.keys(errors);
    ids.forEach((id) => setError(id, errors[id]));
    if (banner) {
      banner.textContent = ids.length ? 'Please fix the highlighted fields.' : (fallback || 'Something went wrong.');
      banner.classList.add('show');
    }
    const first = ids.map($).find(Boolean);
    if (first && first.focus && first.tagName !== 'DIV') first.focus();
  }
  function hideBanner(banner) { if (banner) banner.classList.remove('show'); }
  function mapFields(fields, map) {
    const out = {};
    Object.keys(fields || {}).forEach((k) => { if (map[k]) out[map[k]] = fields[k]; });
    return out;
  }

  /* ---------------- client-side validation (mirrors the server rules) ---------------- */
  const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  function vText(errs, id, label, o) {
    o = Object.assign({ min: 1, max: 120, required: true }, o);
    const v = clean($(id) && $(id).value);
    if (!v) { if (o.required) errs[id] = label + ' is required'; return v; }
    if (v.length < o.min) errs[id] = label + ' must be at least ' + o.min + ' characters';
    else if (v.length > o.max) errs[id] = label + ' must be at most ' + o.max + ' characters';
    return v;
  }
  function vNum(errs, id, label, o) {
    o = Object.assign({ min: 0, max: 1e8, dp: 2, required: true, gt: false }, o);
    const raw = $(id) ? $(id).value : '';
    if (raw === '' || raw == null) { if (o.required) errs[id] = label + ' is required'; return null; }
    const n = Number(raw);
    if (!Number.isFinite(n)) { errs[id] = label + ' must be a number'; return null; }
    if (o.gt ? n <= o.min : n < o.min) { errs[id] = o.gt ? label + ' must be greater than ' + o.min : label + ' cannot be negative'; return null; }
    if (n > o.max) { errs[id] = label + ' is too large'; return null; }
    if (Math.round(n * Math.pow(10, o.dp)) / Math.pow(10, o.dp) !== n) { errs[id] = label + ' can have at most ' + o.dp + ' decimal places'; return null; }
    return n;
  }

  /* ---------------- loading data ---------------- */
  // Dashboard "Total Orders" card: online shop orders (and how many still need action) + POS sales
  function updateOrderStats() {
    const shop = salesCache.filter((t) => t.source === 'Shop');
    const done = ['Delivered', 'Picked Up', 'Cancelled', 'Completed'];
    Object.assign(dashboardMockDisplay, {
      orders: shop.length,
      ordersOpen: shop.filter((t) => done.indexOf(t.status) < 0).length,
      posSales: salesCache.filter((t) => t.source === 'POS').length
    });
    safe(renderDashboardStats);
  }

  async function load() {
    const me = await api('/auth/me');
    currentUser = me;
    safe(applyUser);
    const soft = (path, fallback) => api(path).catch((e) => {
      if (e.message === 'Not signed in') throw e;
      console.warn('[api-bridge] ' + path + ' failed: ' + e.message); return fallback;
    });
    const [inventory, products, suppliers, movements, users, audit, reasons, categories, salesRes] = await Promise.all([
      soft('/inventory', inventoryCache), soft('/products', productCatalogData.slice()),
      soft('/suppliers', supplierData.slice()), soft('/movements?limit=1000', movementCache),
      soft('/users', userAccountsData.slice()), soft('/audit', auditLogData.slice()), soft('/reasons', REASONS), soft('/categories', CATEGORIES),
      soft('/sales', { sales: [] })]);
    salesCache = (salesRes && salesRes.sales) || [];
    try { const qr = await api('/finance/quotes'); quotesCache = Array.isArray(qr) ? qr : []; } catch (e) { if (e.message === 'Not signed in') throw e; console.warn('[api-bridge] /finance/quotes failed: ' + e.message); }
    updateOrderStats();
    // dropdown list = categories table + any category already used by a product (so it is never empty if products exist)
    const catSet = new Map();
    (Array.isArray(categories) ? categories : []).concat(
      (Array.isArray(products) ? products : []).map((p) => p && p.category)
    ).forEach((c) => {
      c = clean(c);
      if (c && c !== 'Uncategorized' && !catSet.has(c.toLowerCase())) catSet.set(c.toLowerCase(), c);
    });
    CATEGORIES = Array.from(catSet.values()).sort((a, b) => a.localeCompare(b));
    safe(fillCategories);
    REASONS = reasons;
    REASON_DEPTS = reasons.depts || DEFAULT_REASON_DEPTS;
    inventoryCache = inventory;

    replace(inventoryMonitoringData, inventory);
    replace(productCatalogData, products);
    replace(supplierData, suppliers);
    replace(recentMovementMockData, movements.slice(0, 6));
    movementCache = movements;
    safe(renderMovementLog);
    safe(renderReports);
    replace(userAccountsData, users.filter((u) => u.roleKey !== 'customer'));   // User Management lists staff only; customers live under Customer Profiles
    replace(auditLogData, audit);

    const low = inventory.filter((i) => getStockStatus(i) === 'low');
    replace(lowStockMockData, low.slice(0, 6));
    Object.assign(dashboardMockDisplay, {
      totalSkus: inventory.length,
      departments: new Set(inventory.map((i) => i.department)).size,
      lowStock: low.length,
      movements: movements.length,
      inventoryValue: inventory.reduce((s, i) => s + i.onHand * i.unitCost, 0)
    });
    const colors = { 'Raw Materials': '#4a90d9', 'Finished Goods': '#43c47a', 'Finishing Supplies': '#9b6bd1' };
    replace(dashboardHealthMock, Object.keys(colors).map((name) => {
      const items = inventory.filter((i) => i.department === name);
      return { name, total: items.length, healthy: items.filter((i) => getStockStatus(i) === 'ok').length, color: colors[name] };
    }).filter((d) => d.total > 0));

    safe(loadDashboard);
    safe(() => renderInventoryMonitoringStats(inventoryMonitoringData));
    safe(applyInventoryFilters);
    safe(renderCategoryPills); safe(applyCatalogFilters);
    safe(renderStockAlerts);
    safe(renderWarehousePills); safe(applySupplierFilters);
    safe(renderAccountsTable);
    safe(applyAuditFilters);

    refreshMovementForm();
    return me;
  }

  /* =====================================================
     STOCK IN / STOCK OUT
     Flow: Department -> Product -> Reason.
     - the reason list follows the product's department (taken from the database), so only sensible reasons show
     - reference number is generated by the system
  ===================================================== */
  const movementType = () => {
    const t = $('movementTypeToggle');
    const active = t && t.querySelector('.seg-btn.active');
    return (active && active.dataset.type) || 'in';
  };
  const movementItem = () => inventoryCache.find((i) => i.sku === ($('movementProduct') || {}).value);

  // The department that decides the reasons: the chosen product's department, else the Department dropdown.
  const movementDepartment = () => {
    const item = movementItem();
    return item ? item.department : (($('movementDept') || {}).value || '');
  };
  // only reasons that have a department rule are offered (anything else, e.g. "Produced in-house", is ignored)
  const reasonKeysFor = (type, dept) => Object.keys(REASONS[type] || {}).filter((k) =>
    REASON_DEPTS[type] && REASON_DEPTS[type][k] && REASON_DEPTS[type][k].indexOf(dept) >= 0);

  // One short sentence under the Reason box saying what each choice means
  const REASON_HELP = {
    'in:supplier_receipt': 'New stock delivered by a supplier.',
    'in:customer_return': 'A customer sent finished goods back and they are going back on the shelf.',
    'in:produced_batch': 'Finished goods produced in a new batch and added to stock.',
    'in:count_correction_up': 'The physical count is higher than the system. Note required: what was counted and why.',
    'in:other': 'Anything not listed. Note required: explain what happened.',
    'out:rust_corrosion': 'Stock lost to rust or corrosion.',
    'out:damaged': 'Bent, cracked or broken stock.',
    'out:scrap_cutting_waste': 'Offcuts and cutting waste that cannot be used.',
    'out:production_use': 'Materials used in production that was NOT recorded as Produced Internally. Do not enter materials again if a production record already deducted them.',
    'out:quality_rejection': 'Failed quality inspection.',
    'out:lost_missing': 'Cannot be found.',
    'out:returned_to_supplier': 'Sent back to the supplier.',
    'out:count_correction_down': 'The physical count is lower than the system. Note required: what was counted and why.',
    'out:other': 'Anything not listed. Note required: explain what happened.'
  };

  // product dropdown only lists products of the chosen department
  function fillMovementProducts() {
    const select = $('movementProduct');
    if (!select) return;
    const dept = ($('movementDept') || {}).value || '';
    const list = inventoryCache.filter((i) => !dept || i.department === dept);
    const sig = dept + '§' + list.map((i) => i.sku + '|' + i.name).join(';');
    if (select.dataset.sig === sig) return;
    select.dataset.sig = sig;
    const prev = select.value;
    select.innerHTML = '<option value="">' + (list.length ? 'Select a product…' : 'No products in ' + (dept || 'stock') + ' yet') + '</option>' +
      list.map((i) => '<option value="' + esc(i.sku) + '">' + esc(i.name) + ' (' + esc(i.sku) + ')</option>').join('');
    if (list.some((i) => i.sku === prev)) select.value = prev;
  }

  // Reason dropdown: only the reasons that apply to this department, for Stock In or Stock Out
  function fillReasons() {
    const sel = $('movementReason');
    if (!sel) return;
    const type = movementType();
    const dept = movementDepartment();
    const keys = dept ? reasonKeysFor(type, dept) : [];
    const sig = type + '|' + dept + '|' + keys.join(',');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      const prev = sel.value;
      const ask = type === 'out' ? 'Why is this stock going out?' : 'Why is this stock coming in?';
      sel.innerHTML = '<option value="">' + (dept ? ask : 'Choose a department or product first') + '</option>' +
        keys.map((k) => '<option value="' + k + '">' + esc(REASONS[type][k]) + '</option>').join('');
      if (keys.indexOf(prev) >= 0) sel.value = prev;
    }
    sel.disabled = !dept;
  }

  function syncMovementForm() {
    const form = $('movementForm');
    if (!form) return;
    const type = movementType();
    fillMovementProducts();
    fillReasons();
    if (window.ProductionUI) window.ProductionUI.beforeSync();   // Finished Goods Stock In: source picker sets the reason
    const reason = $('movementReason').value;
    const qty = Number($('movementQuantity').value) || 0;
    const item = movementItem();
    const dept = movementDepartment();

    const deptHint = $('movementDeptHint');
    if (deptHint) deptHint.textContent = ($('movementDept') || {}).value
      ? 'Showing only ' + $('movementDept').value + ' products.'
      : 'Optional — pick a department to narrow down the product list.';

    if ($('movementUnit')) $('movementUnit').value = item ? item.unit : '';
    if ($('recordProductName')) $('recordProductName').textContent = item ? item.name : 'Select a product';
    if ($('movementRef')) $('movementRef').value = '';

    // hint under the reason box: which department the list is for, then what the chosen reason means
    const hint = $('movementReasonHint');
    if (hint) hint.textContent = !dept ? 'The reasons shown depend on the product\u2019s department.'
      : reason ? (REASON_HELP[type + ':' + reason] || '')
      : 'Showing reasons for ' + dept + ' products.';

    // the Note box only appears when the reason needs an explanation (Other, stock count corrections) — and is then required
    const noteGroup = $('movementNoteGroup');
    const needNote = NOTE_REQUIRED.indexOf(reason) >= 0;
    if (noteGroup) {
      noteGroup.style.display = needNote ? '' : 'none';
      if (!needNote) {
        $('movementNote').value = '';
        noteGroup.querySelectorAll('.field-msg').forEach((n) => n.remove());
        $('movementNote').classList.remove('field-invalid');
      }
    }

    // supplier delivery details (only for "Received from supplier")
    const isReceipt = type === 'in' && reason === 'supplier_receipt';
    const rg = $('movementReceiptGroup');
    if (rg) {
      rg.style.display = isReceipt ? '' : 'none';
      if (isReceipt) fillMovementSuppliers(item);
      else {
        ['movementSupplier', 'movementInvoice'].forEach((id) => { const el = $(id); if (el) { el.value = ''; el.classList.remove('field-invalid'); } });
        rg.querySelectorAll('.field-msg').forEach((n) => n.remove());
      }
    }

    // stock summary
    const cur = $('summaryCurrentStock'), aft = $('summaryAfterStock');
    if (window.ProductionUI) setTimeout(() => window.ProductionUI.afterSync(), 0);
    if (cur) cur.textContent = item ? formatNumber(item.onHand) + ' ' + item.unit : '—';
    if (aft) {
      if (!item) aft.textContent = '—';
      else {
        const after = item.onHand + (type === 'in' ? qty : -qty);
        aft.textContent = formatNumber(Math.max(after, 0)) + ' ' + item.unit + (after < 0 ? ' (not enough stock)' : '');
        aft.style.color = after < 0 ? '#ef7a7a' : '';
      }
    }
  }

  // Supplier dropdown: suppliers that already supply this product come first; any other active supplier can still be chosen
  function fillMovementSuppliers(item) {
    const sel = $('movementSupplier');
    if (!sel) return;
    const active = supplierData.filter((s) => s.status !== 'archived');
    const linked = item ? active.filter((s) => (s.products || []).some((p) => p.sku === item.sku)) : [];
    const others = active.filter((s) => linked.indexOf(s) < 0);
    const sig = (item ? item.sku : '') + '|' + active.map((s) => s.id + s.name).join(';');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      const prev = sel.value;
      const opt = (s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
      sel.innerHTML = '<option value="">' + (active.length ? 'Select the supplier\u2026' : 'No active suppliers yet') + '</option>' +
        (linked.length ? '<optgroup label="Supplies this product">' + linked.map(opt).join('') + '</optgroup>' : '') +
        (others.length ? '<optgroup label="' + (linked.length ? 'Other suppliers' : 'All suppliers') + '">' + others.map(opt).join('') + '</optgroup>' : '');
      if (prev && active.some((s) => s.id === prev)) sel.value = prev;
      else if (linked.length === 1) sel.value = linked[0].id;
    }
    const h = $('movementSupplierHint');
    if (h) h.textContent = item && !linked.length ? 'No supplier is linked to this product yet \u2014 pick the one that delivered it.' : '';
  }

  function refreshMovementForm() {
    if (!$('movementProduct')) return;
    syncMovementForm();
  }

  const MOVE_FIELDS = { sku: 'movementProduct', quantity: 'movementQuantity', reason: 'movementReason', note: 'movementNote',
    supplier: 'movementSupplier', invoiceNo: 'movementInvoice' };

  function setupMovementForm() {
    const form = $('movementForm');
    if (!form || form.dataset.bridge) return;
    form.dataset.bridge = '1';
    $('movementProduct').addEventListener('change', syncMovementForm);
    $('movementDept').addEventListener('change', syncMovementForm);
    form.addEventListener('reset', () => { setTimeout(syncMovementForm, 0); });
    $('movementReason').addEventListener('change', () => {
      const wasHidden = $('movementNoteGroup').style.display === 'none';
      syncMovementForm();
      if (wasHidden && NOTE_REQUIRED.indexOf($('movementReason').value) >= 0) $('movementNote').focus();
    });
    $('movementQuantity').addEventListener('input', syncMovementForm);
    ['movementSupplier', 'movementInvoice'].forEach((id) => {       // clear an old error message as soon as the field is changed
      const el = $(id); if (!el) return;
      const clear = () => { el.classList.remove('field-invalid'); const g = el.closest('.form-group'); if (g) g.querySelectorAll('.field-msg').forEach((n) => n.remove()); };
      el.addEventListener('input', clear); el.addEventListener('change', clear);
    });
    const toggle = $('movementTypeToggle');
    if (toggle) toggle.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setTimeout(syncMovementForm, 0)));

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (window.ProductionUI && window.ProductionUI.isProduction()) { window.ProductionUI.submit(); return; }   // Produced Internally has its own confirm step
      const banner = $('movementFormError');
      const type = movementType();
      const reason = $('movementReason').value;
      const errs = {};
      if (!$('movementProduct').value) errs.movementProduct = 'Choose a product';
      if (!reason) errs.movementReason = type === 'out' ? 'Choose why this stock is going out' : 'Choose why this stock is coming in';
      const qty = vNum(errs, 'movementQuantity', 'Quantity', { gt: true });
      const note = vText(errs, 'movementNote', 'Note', { required: false, max: 300 });
      const isReceipt = type === 'in' && reason === 'supplier_receipt';
      let supplier = '', invoiceNo = '';
      if (isReceipt) {
        supplier = $('movementSupplier').value;
        if (!supplier) errs.movementSupplier = 'Choose the supplier this delivery came from';
        invoiceNo = vText(errs, 'movementInvoice', 'Invoice / delivery no.', { required: false, max: 40 });
      }
      if (reason && NOTE_REQUIRED.indexOf(reason) >= 0 && note.length < 3) errs.movementNote = 'Please explain this entry in the note';
      const item = movementItem();
      if (item && reason && !errs.movementReason && reasonKeysFor(type, item.department).indexOf(reason) < 0)
        errs.movementReason = 'That reason does not apply to ' + item.department + ' products';
      if (item && type === 'out' && qty !== null && !errs.movementQuantity && qty > item.onHand)
        errs.movementQuantity = 'Only ' + formatNumber(item.onHand) + ' ' + item.unit + ' on hand — cannot take out ' + formatNumber(qty);
      if (Object.keys(errs).length) return showErrors(form, banner, errs);

      clearErrors(form); hideBanner(banner);
      try {
        const r = await api('/movements', {
          method: 'POST',
          body: JSON.stringify({ sku: $('movementProduct').value, type, reason, quantity: qty, note, supplier: supplier || undefined, invoiceNo: invoiceNo || undefined })
        });
        toast('Saved. Reference no. ' + r.ref);
        form.reset();
        await load();
      } catch (err) {
        showErrors(form, banner, mapFields(err.fields, MOVE_FIELDS), err.message);
      }
    }, true);
  }

  /* =====================================================
     SUPPLIER <-> PRODUCT CHECKLISTS
  ===================================================== */
  function productModalState() {
    return typeof editingProductSku !== 'undefined' && editingProductSku ? editingProductSku : null;
  }

  // Edit Product shows the suppliers read-only. Links are managed in Supplier Management.
  function renderProductSupplierList(product) {
    const box = $('npSource');
    const linked = (product && product.suppliers) || [];
    const needs = product && NEEDS_SUPPLIER.indexOf(product.department) >= 0;
    box.innerHTML = linked.length
      ? linked.map((s) => '<div>' + esc(s.name) +
          (s.primary && linked.length > 1 ? ' <em class="prod-tag">Primary</em>' : '') +
          (s.status === 'archived' ? ' <em class="prod-tag muted">Archived</em>' : '') + '</div>').join('')
      : (needs
        ? '<div class="sup-empty warn">No supplier yet. Link one in Supplier Management.</div>'
        : '<div class="sup-empty">In-house production — made by the company, so no supplier is needed.</div>');
  }

  /* ---------- Storage location dropdown (locations already used by products + a starter list; last option adds a new one) ---------- */
  const NEW_LOCATION = '__new_location__';
  const STARTER_LOCATIONS = ['Warehouse A', 'Warehouse B', 'Warehouse C', 'Storeroom'];
  function locationList() {
    const seen = new Map();
    STARTER_LOCATIONS.concat((productCatalogData || []).map((p) => p && p.location)).forEach((l) => {
      l = clean(l); if (l && !seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
    });
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  function fillLocations(keep) {
    const sel = $('npLocation');
    if (!sel || sel.tagName !== 'SELECT') return;
    sel.innerHTML = '<option value="">Select a location…</option>' +
      locationList().map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('') +
      '<option value="' + NEW_LOCATION + '">+ Add new location…</option>';
    setLocationValue(keep);
  }
  function setLocationValue(name) {
    const sel = $('npLocation'); if (!sel) return;
    name = clean(name);
    if (name && name !== NEW_LOCATION && ![].some.call(sel.options, (o) => o.value.toLowerCase() === name.toLowerCase())) {
      const opt = document.createElement('option');      // an older product whose location is not in the list
      opt.value = name; opt.textContent = name; sel.insertBefore(opt, sel.lastElementChild);
    }
    const hit = [].find.call(sel.options, (o) => name && o.value.toLowerCase() === name.toLowerCase());
    sel.value = hit ? hit.value : '';
    syncLocationNew();
  }
  function syncLocationNew() {
    const wrap = $('npLocationNewWrap'); if (!wrap) return;
    const isNew = $('npLocation').value === NEW_LOCATION;
    wrap.style.display = isNew ? '' : 'none';
    if (!isNew) { $('npLocationNew').value = ''; $('npLocationNew').classList.remove('field-invalid'); wrap.querySelectorAll('.field-msg').forEach((n) => n.remove()); }
  }
  // the location to save: the chosen one, or the typed new name (matched to an existing one ignoring upper/lower case)
  function chosenLocation(errs) {
    const v = $('npLocation').value;
    if (!v) { errs.npLocation = 'Choose the storage location'; return ''; }
    if (v !== NEW_LOCATION) return v;
    const typed = vText(errs, 'npLocationNew', 'Storage location', { min: 2, max: 100 });
    const same = locationList().find((l) => l.toLowerCase() === String(typed).toLowerCase());
    return same || typed;
  }

  /* ---------- Supplier dropdown (new Raw Materials / Finishing Supplies only; Finished Goods are made in-house) ---------- */
  function fillSupplierPick() {
    const sel = $('npSupplier'); if (!sel) return;
    const active = (supplierData || []).filter((s) => s.status !== 'archived');
    sel.innerHTML = '<option value="">Select a supplier…</option>' +
      active.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
    $('npSupplierHint').textContent = active.length ? 'Who you buy this material from. You can link more suppliers later in Supplier Management.'
      : 'No active suppliers yet. Add one in Suppliers first, then come back to create this product.';
  }
  function syncSupplierPick() {
    const wrap = $('npSupplierPickWrap'); if (!wrap) return;
    const show = !productModalState() && NEEDS_SUPPLIER.indexOf($('npDept').value) >= 0;
    wrap.style.display = show ? '' : 'none';
    if (!show) { $('npSupplier').value = ''; $('npSupplier').classList.remove('field-invalid'); wrap.querySelectorAll('.field-msg').forEach((n) => n.remove()); }
  }

  /* ---------- Reorder level: automatic (average daily use x lead + safety days) unless "Set manually" ---------- */
  let REORDER = { leadDays: 7, safetyDays: 3, lookbackDays: 90, minHistoryDays: 14 };
  function syncReorderUI(product) {
    const manual = $('npReorderManual'), box = $('npReorder'), hint = $('npReorderHint');
    if (!manual || !box || !hint) return;
    const auto = !manual.checked;
    box.readOnly = auto;
    if (auto) {
      box.value = product && product.reorderLevel != null ? product.reorderLevel : '';
      box.placeholder = 'Auto';
      hint.textContent = product && product.reorderAuto && product.reorderBasis ? product.reorderBasis
        : 'Automatic: average daily use over the last ' + REORDER.lookbackDays + ' days × (' + REORDER.leadDays + ' lead-time days + ' + REORDER.safetyDays + ' safety days). ' +
          'A new product has no usage history yet, so it starts at 0 and calculates itself after ' + REORDER.minHistoryDays + ' days of use. Tick "Set manually" to enter a starting level now.';
    } else {
      box.placeholder = '0';
      hint.textContent = 'You are setting this yourself. Untick "Set manually" to let the system work it out from usage.';
    }
  }

  /* ---------- Category dropdown (list comes from the database; last option adds a new one) ---------- */
  function fillCategories(keep) {
    const sel = $('npCategory');
    if (!sel || sel.tagName !== 'SELECT') return;
    const cur = keep === undefined ? sel.value : keep;
    sel.innerHTML = '<option value="">Select a category…</option>' +
      CATEGORIES.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('') +
      '<option value="' + NEW_CATEGORY + '">+ Add new category…</option>';
    setCategoryValue(cur);
  }
  function setCategoryValue(name) {
    const sel = $('npCategory');
    if (!sel) return;
    name = clean(name);
    if (name === 'Uncategorized') name = '';            // old records without a category: user must pick one
    if (name && name !== NEW_CATEGORY && ![].some.call(sel.options, (o) => o.value === name)) {
      const opt = document.createElement('option');      // a category that is no longer in the list
      opt.value = name; opt.textContent = name; opt.dataset.legacy = '1';
      sel.insertBefore(opt, sel.lastElementChild);
    }
    sel.value = name || '';
    syncCategoryNew();
  }
  function syncCategoryNew() {
    const wrap = $('npCategoryNewWrap');
    if (!wrap) return;
    const isNew = $('npCategory').value === NEW_CATEGORY;
    wrap.style.display = isNew ? '' : 'none';
    if (!isNew) {
      $('npCategoryNew').value = '';
      wrap.querySelectorAll('.field-msg').forEach((n) => n.remove());
      $('npCategoryNew').classList.remove('field-invalid');
    }
  }
  // the category to save: the chosen one, or the typed new name (matched to an existing one ignoring upper/lower case)
  function chosenCategory(errs) {
    const v = $('npCategory').value;
    if (v !== NEW_CATEGORY) return v;
    const typed = vText(errs, 'npCategoryNew', 'Category name', { min: 2, max: 60 });
    const same = CATEGORIES.find((c) => c.toLowerCase() === String(typed).toLowerCase());
    return same || typed;
  }

  // Only Finished Goods are sold. Raw Materials and Finishing Supplies have no selling price.
  const SELLS_DEPT = ['Finished Goods'];
  const sellsNow = () => SELLS_DEPT.indexOf(($('npDept') || {}).value) >= 0;
  function syncPriceField() {
    const input = $('npListPrice'); if (!input) return;
    const sells = sellsNow();
    const label = document.querySelector('label[for="npListPrice"]');
    if (label) label.innerHTML = 'Selling Price (&#8369;)' + (sells ? ' <span class="required-mark">*</span>' : '');
    input.disabled = !sells;
    input.placeholder = sells ? 'Required for Finished Goods' : 'Not sold';
    if (!sells) { input.value = ''; showLive('npListPrice', ''); }
  }

  // duplicate checks against the loaded product list (the server re-checks on save)
  const sameText = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
  function duplicateProductName(name) {
    const v = clean(name); if (!v) return null;
    const me = productModalState();
    return productCatalogData.find((p) => sameText(p.name, v) && p.sku !== me) || null;
  }
  function duplicateSku(sku) {
    const v = clean(sku).toUpperCase(); if (!v || productModalState()) return null;   // SKU is locked when editing
    return productCatalogData.find((p) => String(p.sku).toUpperCase() === v) || null;
  }
  const dupNameMsg = (p) => 'A product named "' + p.name + '" already exists (SKU ' + p.sku + ')';

  function onProductModalOpen() {
    const form = $('newProductForm');
    clearErrors(form); hideBanner($('newProductFormError'));
    const sku = productModalState();
    const product = sku ? productCatalogData.find((p) => p.sku === sku) : null;
    // suppliers are only shown when editing; a new product gets its suppliers from Supplier Management afterwards
    $('npSupplierSection').style.display = product ? '' : 'none';
    if (product) renderProductSupplierList(product);
    fillCategories(product ? product.category : '');
    fillLocations(product && product.location ? product.location : '');
    fillSupplierPick(); syncSupplierPick();
    $('npReorderManual').checked = product ? !product.reorderAuto : false;   // new products are automatic; old ones stay manual until someone unticks it
    syncReorderUI(product);
    $('npListPrice').value = product && product.listPrice ? product.listPrice : '';
    syncPriceField();
    // SKU and opening stock are fixed once a product exists (stock only changes through Stock In / Out)
    $('npSku').readOnly = !!product;
    $('npOnHand').readOnly = !!product;
    $('npOnHand').title = product ? 'Change stock using Stock In / Stock Out' : '';
    setUnitValue(product ? product.unit : '');
  }

  const PRODUCT_FIELDS = { sku: 'npSku', name: 'npName', department: 'npDept', category: 'npCategory', unit: 'npUnit',
    unitCost: 'npUnitCost', listPrice: 'npListPrice', reorderLevel: 'npReorder', onHand: 'npOnHand', location: 'npLocation', supplier: 'npSupplier' };

  function setupProductModal() {
    const overlay = $('newProductModalOverlay'), form = $('newProductForm');
    if (!overlay || !form || form.dataset.bridge) return;
    form.dataset.bridge = '1';
    $('npDept').addEventListener('change', () => { syncPriceField(); validateField('npListPrice', false); syncSupplierPick(); });
    $('npLocation').addEventListener('change', () => { syncLocationNew(); if ($('npLocation').value === NEW_LOCATION) $('npLocationNew').focus(); });
    $('npReorderManual').addEventListener('change', () => {
      const sku = productModalState(), product = sku ? productCatalogData.find((p) => p.sku === sku) : null;
      if ($('npReorderManual').checked) { if (!product) $('npReorder').value = ''; $('npReorder').focus(); }
      syncReorderUI(product);
    });
    api('/reorder-settings').then((r) => { if (r && r.leadDays != null) { REORDER = r; syncReorderUI(null); } }).catch(() => {});
    $('npCategory').addEventListener('change', () => { syncCategoryNew(); if ($('npCategory').value === NEW_CATEGORY) $('npCategoryNew').focus(); });
    form.addEventListener('reset', () => setTimeout(() => { fillCategories(''); fillLocations(''); syncSupplierPick(); $('npReorderManual').checked = false; syncReorderUI(null); }, 0));
    new MutationObserver(() => { if (overlay.classList.contains('open')) onProductModalOpen(); })
      .observe(overlay, { attributes: true, attributeFilter: ['class'] });

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      const banner = $('newProductFormError');
      const editing = productModalState();
      const errs = {};
      const sku = clean($('npSku').value).toUpperCase();
      if (!sku) errs.npSku = 'SKU is required';
      else if (!/^[A-Z0-9][A-Z0-9._-]{2,39}$/.test(sku)) errs.npSku = 'SKU must be 3–40 characters: letters, numbers, dot, dash or underscore';
      else if (duplicateSku(sku)) errs.npSku = 'That SKU already exists (' + duplicateSku(sku).name + ')';
      const name = vText(errs, 'npName', 'Product name', { min: 2 });
      if (name && !errs.npName && duplicateProductName(name)) errs.npName = dupNameMsg(duplicateProductName(name));
      const department = $('npDept').value;
      if (DEPARTMENTS.indexOf(department) < 0) errs.npDept = 'Choose a valid department';
      let category = '';
      if (!$('npCategory').value) errs.npCategory = 'Choose a category';
      else category = chosenCategory(errs);
      const unit = clean($('npUnit').value);
      if (!unit) errs.npUnit = 'Unit is required';
      else if (!/^[A-Za-z][A-Za-z./ ]{0,19}$/.test(unit)) errs.npUnit = 'Unit must be letters only, e.g. kg or pcs';
      const unitCost = vNum(errs, 'npUnitCost', 'Unit cost', { max: 1e7 });
      const listPrice = sellsNow() ? vNum(errs, 'npListPrice', 'Selling price', { max: 1e7, gt: true }) : 0;
      const reorderManual = $('npReorderManual').checked;
      const reorderLevel = reorderManual ? vNum(errs, 'npReorder', 'Reorder level') : null;
      const onHand = editing ? null : vNum(errs, 'npOnHand', 'On hand');
      const location = chosenLocation(errs);
      let supplierCode = '';
      if (!editing && NEEDS_SUPPLIER.indexOf(department) >= 0) { supplierCode = $('npSupplier').value; if (!supplierCode) errs.npSupplier = 'Choose the supplier for this material'; }
      if (Object.keys(errs).length) return showErrors(form, banner, errs);

      clearErrors(form); hideBanner(banner);
      const payload = { sku, name, department, category, unit, unitCost, listPrice, reorderAuto: !reorderManual, location: location || null };
      if (reorderManual) payload.reorderLevel = reorderLevel;
      if (!editing) { payload.onHand = onHand; if (supplierCode) payload.supplierCode = supplierCode; }
      try {
        if (editing) await api('/products/' + encodeURIComponent(editing), { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/products', { method: 'POST', body: JSON.stringify(payload) });
        let shopMsg = '';
        try { if (window.TripleEShop && await window.TripleEShop.saveWithProduct(sku)) shopMsg = ' · online shop details saved'; }
        catch (shopErr) { toast('Product saved, but the online shop details were NOT saved: ' + shopErr.message, 'error'); await load(); return; }
        toast((editing ? 'Product updated' : 'Product added') + shopMsg);
        closeNewProductModal();
        await load();
      } catch (err) {
        showErrors(form, banner, mapFields(err.fields, PRODUCT_FIELDS), err.message);
      }
    }, true);
  }

  /* ---------------- supplier modal ---------------- */
  function onSupplierModalOpen() {
    const form = $('newSupplierForm');
    clearErrors(form); hideBanner($('newSupplierFormError'));
    const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
    const supplier = id ? supplierData.find((s) => s.id === id) : null;
    const linked = supplier ? (supplier.products || []).map((p) => p.sku) : [];
    const rows = productCatalogData.filter((p) => NEEDS_SUPPLIER.indexOf(p.department) >= 0 || linked.indexOf(p.sku) >= 0).map((p) =>
      '<label class="check-row"><input type="checkbox" class="prod-check" value="' + esc(p.sku) + '"' + (linked.indexOf(p.sku) >= 0 ? ' checked' : '') + '>' +
      '<span class="check-label">' + esc(p.name) + ' <span class="check-sub">· ' + esc(p.sku) + ' · ' + esc(p.department || '') + '</span></span></label>');
    $('newSupplierProducts').innerHTML = rows.length ? rows.join('') : '<div class="check-empty">No Raw Materials or Finishing Supplies products yet.</div>';
    const fill = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
    fill('newSupplierName', supplier ? supplier.name : '');
    fill('newSupplierContactPerson', supplier ? supplier.contactPerson : '');
    fill('newSupplierPhone', supplier ? supplier.phone : '');
    fill('newSupplierEmail', supplier ? supplier.email : '');
    fill('newSupplierAddress', supplier ? supplier.address : '');
    setupAddressFields();
    prefillAddress(supplier);
    setEmailStatus(EMAIL_HINT);
    setupSupplierInputFilters();
    const archive = $('archiveSupplierBtn');
    if (archive) {
      archive.style.display = supplier ? '' : 'none';
      if (supplier) archive.textContent = supplier.status === 'archived' ? 'RESTORE SUPPLIER' : 'ARCHIVE SUPPLIER';
    }
  }

  /* =====================================================
     SUPPLIER FORM HELPERS: Title Case, PH phone, email domain check
  ===================================================== */
  const TITLE_KEEP = { gmbh: 'GmbH', llc: 'LLC', plc: 'PLC', cnc: 'CNC', ph: 'PH', usa: 'USA', uae: 'UAE' };
  function titleCase(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/(^|[\s\-\/(])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase())
      .replace(/\b(gmbh|llc|plc|cnc|ph|usa|uae)\b/gi, (w) => TITLE_KEEP[w.toLowerCase()]);
  }
  // rewrites the box in Title Case while typing, keeping the cursor where it was
  function liveTitleCase(id) {
    const el = $(id);
    if (!el || el.dataset.titleCase) return;
    el.dataset.titleCase = '1';
    el.addEventListener('input', () => {
      const next = titleCase(el.value);
      if (next === el.value) return;
      const a = el.selectionStart, b = el.selectionEnd;
      el.value = next;
      try { el.setSelectionRange(a, b); } catch (e) { /* ignore */ }
    });
    el.addEventListener('blur', () => { el.value = titleCase(clean(el.value)); });
  }

  const OUTSIDE_PH = 'Outside the Philippines';
  const PHONE_MSG = 'Phone number must start with +63 or 09, e.g. +63 917 123 4567 or 0917 123 4567';
  function phoneError(raw) {
    if (/[^\d+\s().-]/.test(raw)) return 'Phone number can only have digits, +, spaces and dashes';
    const p = raw.replace(/[\s().-]/g, '');
    if (p.indexOf('+63') === 0) {
      const r = p.slice(3);
      if (!/^\d+$/.test(r)) return PHONE_MSG;
      if (r[0] === '9') return r.length === 10 ? '' : 'A +63 mobile number needs 10 digits after +63, e.g. +63 917 123 4567';
      return r.length >= 9 && r.length <= 10 ? '' : PHONE_MSG;
    }
    if (p.indexOf('09') === 0) return /^09\d{9}$/.test(p) ? '' : 'A 09 mobile number needs 11 digits, e.g. 0917 123 4567';
    return PHONE_MSG;
  }
  const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function zipError(zip, region) {
    if (region === OUTSIDE_PH) return /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/.test(zip) ? '' : 'ZIP / postal code must be 3-10 letters or numbers';
    return /^\d{4}$/.test(zip) ? '' : 'ZIP code must be 4 digits, e.g. 1000';
  }

  // the supplier being edited (null when adding a new one)
  function editedSupplier() {
    const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
    return id ? supplierData.find((s) => s.id === id) || null : null;
  }
  // an old phone / email that is left exactly as it was does not have to follow the new rules
  const phoneUnchanged = () => { const sup = editedSupplier(); return !!(sup && sup.phone && clean(sup.phone) === clean($('newSupplierPhone').value)); };
  const emailUnchanged = () => { const sup = editedSupplier(); return !!(sup && sup.email && clean(sup.email).toLowerCase() === clean($('newSupplierEmail').value).toLowerCase()); };

  const emailResults = new Map();   // email -> { ok, message }
  async function checkEmail(email) {
    const key = email.toLowerCase();
    if (emailResults.has(key)) return emailResults.get(key);
    let r;
    try { r = await api('/validate-email?email=' + encodeURIComponent(email)); }
    catch (err) { return { ok: false, message: 'Could not check the email right now. Try again.' }; }
    if (!r.unverified && !/right now|Check the internet/.test(r.message || '')) emailResults.set(key, r);   // do not remember "could not check"
    return r;
  }
  function setEmailStatus(text, color) {
    const el = $('newSupplierEmailStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('tick', !!color);
    el.style.color = color || '';
  }
  const EMAIL_HINT = 'Domain is checked automatically';
  let emailTimer = null;
  function scheduleEmailCheck() {
    clearTimeout(emailTimer);
    const el = $('newSupplierEmail');
    if (!el) return;
    const value = clean(el.value);
    if (!value) return setEmailStatus(EMAIL_HINT);
    if (!EMAIL_FORMAT.test(value) || emailUnchanged()) return setEmailStatus(EMAIL_HINT);
    const known = emailResults.get(value.toLowerCase());
    if (known) { setEmailStatus(known.ok ? 'Email domain is valid' : EMAIL_HINT, known.ok ? '#5fbf8a' : ''); validateField('newSupplierEmail', false); return; }
    setEmailStatus('Checking email domain…');
    emailTimer = setTimeout(async () => {
      const r = await checkEmail(value);
      if (clean(el.value) !== value) return;            // the box changed while we were checking
      setEmailStatus(r.ok ? (r.unverified ? 'Email format is OK (domain could not be checked right now)' : 'Email domain is valid') : EMAIL_HINT, r.ok && !r.unverified ? '#5fbf8a' : '');
      validateField('newSupplierEmail', true);
    }, 600);
  }

  // phone: only phone characters; zip: digits only for Philippine addresses
  function setupSupplierInputFilters() {
    const phone = $('newSupplierPhone');
    if (phone && !phone.dataset.filter) {
      phone.dataset.filter = '1';
      phone.addEventListener('input', () => {
        const next = phone.value.replace(/[^\d+\s().-]/g, '');
        if (next !== phone.value) phone.value = next;
      });
    }
    const zip = $('newSupplierZip'), region = $('newSupplierRegion');
    if (zip && region && !zip.dataset.filter) {
      zip.dataset.filter = '1';
      const trim = () => {
        if (region.value && region.value !== OUTSIDE_PH) {
          const next = zip.value.replace(/\D/g, '').slice(0, 4);
          if (next !== zip.value) zip.value = next;
        }
        zip.maxLength = region.value === OUTSIDE_PH ? 10 : 4;
      };
      zip.addEventListener('input', trim);
      region.addEventListener('change', trim);
      trim();
    }
  }


  /* =====================================================
     ADDRESS: Region -> Province -> City / Municipality -> ZIP
     Lists come from the PSGC API (through our server); the ZIP code is checked against the chosen city.
  ===================================================== */
  const GEO = { regions: [], provinces: [], cities: [], barangays: [], zip: null, zipTimer: null, ready: false };
  const geoMemo = new Map();
  async function geoGet(path) {
    if (geoMemo.has(path)) return geoMemo.get(path);
    const data = await api(path);              // failures are not remembered
    geoMemo.set(path, data);
    return data;
  }
  const gnorm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ').replace(/\bcity of\b|\bmunicipality of\b|\bcity\b|\bmunicipality\b/g, ' ')
    .replace(/\bsta\.?\b/g, 'santa').replace(/\bsto\.?\b/g, 'santo').replace(/[^a-z0-9]+/g, ' ').trim();
  const findByName = (list, name) => list.find((x) => x.name === name) || list.find((x) => gnorm(x.name) === gnorm(name));
  const isOutsidePH = () => clean(($('newSupplierRegion') || {}).value) === OUTSIDE_PH;
  const NCR_PROVINCE = 'Metro Manila';

  function injectGeoStyles() {
    if (document.getElementById('geoStyles')) return;
    const st = document.createElement('style');
    st.id = 'geoStyles';
    st.textContent =
      '.geo-combo{position:relative}' +
      '.geo-list{position:absolute;left:0;right:0;top:100%;z-index:60;max-height:220px;overflow-y:auto;margin-top:2px;' +
        'background:var(--bg-card,#0d1f2d);border:1px solid var(--border,#1d3a50);border-radius:6px;box-shadow:0 10px 24px rgba(0,0,0,.45);padding:4px 0}' +
      '.geo-list[hidden]{display:none}' +
      '.geo-opt{padding:8px 12px;font-size:16px;color:var(--text,#e6eef5);cursor:pointer}' +
      '.geo-opt:hover,.geo-opt.active{background:rgba(74,144,217,.18)}' +
      '.geo-empty{padding:8px 12px;font-size:15px;color:var(--text-faint,#8aa0b2)}' +
      '.geo-input:disabled{opacity:.6;cursor:not-allowed}' +
      'html[data-theme="light"] .geo-list{background:#fff;border-color:#c9d6e0;box-shadow:0 10px 24px rgba(20,40,60,.18)}' +
      'html[data-theme="light"] .geo-opt{color:#1c2b39}' +
      'html[data-theme="light"] .geo-opt:hover,html[data-theme="light"] .geo-opt.active{background:#e3eefa}';
    document.head.appendChild(st);
  }

  // type-to-search box: the value must be picked from the list loaded from the API
  function makeCombo(id, getItems, onPick) {
    const input = $(id);
    if (!input || input.dataset.combo) return;
    input.dataset.combo = '1';
    const list = input.parentNode.querySelector('.geo-list');
    let shown = [], active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const paint = () => {
      [].forEach.call(list.children, (n, i) => n.classList.toggle('active', i === active));
      if (list.children[active]) list.children[active].scrollIntoView({ block: 'nearest' });
    };
    const open = () => {
      if (input.disabled || input.dataset.free || (isOutsidePH() && id !== 'newSupplierRegion')) return;   // typed by hand: no list
      const items = getItems() || [];
      const picked = input.dataset.name && input.value === input.dataset.name;
      const q = picked ? '' : gnorm(input.value);
      shown = items.filter((x) => !q || gnorm(x.name).indexOf(q) >= 0 || x.name.toLowerCase().indexOf(input.value.trim().toLowerCase()) >= 0).slice(0, 300);
      list.innerHTML = shown.length ? shown.map((x, i) => '<div class="geo-opt" role="option" data-i="' + i + '">' + esc(x.name) + '</div>').join('')
        : '<div class="geo-empty">' + (items.length ? 'No match — pick from the list' : 'Nothing to show yet') + '</div>';
      list.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1;
    };
    const pick = (item) => {
      input.value = item.name; input.dataset.code = item.code; input.dataset.name = item.name;
      close(); onPick(item);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    list.addEventListener('mousedown', (e) => {
      const n = e.target.closest('.geo-opt'); if (!n) return;
      e.preventDefault(); pick(shown[Number(n.dataset.i)]);
    });
    input.addEventListener('focus', () => { if (input.dataset.retry) input.dispatchEvent(new CustomEvent('geo-retry')); open(); });
    input.addEventListener('input', () => {
      if (input.dataset.code) { delete input.dataset.code; delete input.dataset.name; onPick(null); }
      open();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); active = Math.min(active + 1, shown.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
      else if (e.key === 'Enter' && !list.hidden && shown.length) { e.preventDefault(); e.stopPropagation(); pick(shown[active >= 0 ? active : 0]); }
      else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(); }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        close();
        if (input.dataset.code || !input.value.trim()) return;
        const exact = (getItems() || []).find((x) => x.name.toLowerCase() === input.value.trim().toLowerCase());
        if (exact) pick(exact);
      }, 120);
    });
  }
  function setBox(id, o) {          // o: { value, code, disabled, placeholder }
    const el = $(id); if (!el) return;
    el.value = o.value || '';
    if (o.code) { el.dataset.code = o.code; el.dataset.name = o.value; } else { delete el.dataset.code; delete el.dataset.name; }
    delete el.dataset.free;
    el.disabled = !!o.disabled;
    if (o.placeholder != null) el.placeholder = o.placeholder;
    showLive(id, '');
    const list = el.parentNode.querySelector && el.parentNode.querySelector('.geo-list');
    if (list) list.hidden = true;
  }
  const picked = (id) => { const el = $(id); return !!(el && (el.dataset.code || el.dataset.free || isOutsidePH())); };

  function resetBelowRegion(keepRegion) {
    GEO.provinces = []; GEO.cities = []; GEO.barangays = []; GEO.zip = null;
    clearTimeout(GEO.zipTimer);
    setBox('newSupplierProvince', { value: '', disabled: true, placeholder: 'Choose a region first' });
    setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Choose a province first' });
    setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Choose a city first' });
    const zip = $('newSupplierZip');
    if (zip) { zip.value = ''; zip.disabled = true; zip.placeholder = 'Choose a barangay first'; showLive('newSupplierZip', ''); }
    setZipStatus('Checked against the selected city');
    if (!keepRegion) setBox('newSupplierRegion', { value: '', disabled: false, placeholder: GEO.regions.length ? 'Type to search region…' : 'Loading regions…' });
  }
  function setZipStatus(text, color) {
    const el = $('newSupplierZipStatus'); if (!el) return;
    el.textContent = text; el.classList.toggle('tick', !!color); el.style.color = color || '';
  }

  async function ensureRegions() {
    if (GEO.regions.length) return true;
    const box = $('newSupplierRegion');
    try {
      const rows = await geoGet('/geo/regions');
      GEO.regions = rows.concat([{ code: 'OUT', name: OUTSIDE_PH }]);
      delete box.dataset.retry; delete box.dataset.warned;
      if (!box.value) box.placeholder = 'Type to search region…';
      return true;
    } catch (err) {
      box.dataset.retry = '1';
      box.placeholder = 'Could not load regions — click here to retry';
      console.warn('[api-bridge] regions', err.message);
      if (!box.dataset.warned) { box.dataset.warned = '1'; toast(err.message, 'error'); }
      return false;
    }
  }

  async function onRegionPick(item) {
    resetBelowRegion(true);
    if (!item) return;
    if (item.name === OUTSIDE_PH) {                      // foreign address: typed in by hand
      setBox('newSupplierProvince', { value: '', disabled: false, placeholder: 'State / province' });
      setBox('newSupplierCity', { value: '', disabled: false, placeholder: 'City' });
      setBox('newSupplierBarangay', { value: '', disabled: false, placeholder: 'District / barangay (optional)' });
      const zip = $('newSupplierZip'); zip.disabled = false; zip.placeholder = 'Postal code';
      setZipStatus('Postal code format is checked');
      return;
    }
    setBox('newSupplierProvince', { value: '', disabled: true, placeholder: 'Loading provinces…' });
    try {
      const provs = await geoGet('/geo/regions/' + encodeURIComponent(item.code) + '/provinces');
      if ($('newSupplierRegion').dataset.code !== item.code) return;       // region changed while loading
      if (provs.length) {
        GEO.provinces = provs;
        setBox('newSupplierProvince', { value: '', disabled: false, placeholder: 'Type to search province…' });
      } else {                                           // NCR has no provinces
        setBox('newSupplierProvince', { value: NCR_PROVINCE, code: 'NCR', disabled: true });
        await loadCities('/geo/regions/' + encodeURIComponent(item.code) + '/cities');
      }
    } catch (err) {
      setBox('newSupplierProvince', { value: '', disabled: true, placeholder: 'Could not load — pick the region again' });
      toast(err.message, 'error');
    }
  }
  async function loadCities(path) {
    setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Loading cities…' });
    try {
      GEO.cities = await geoGet(path);
      setBox('newSupplierCity', { value: '', disabled: false, placeholder: 'Type to search city / municipality…' });
    } catch (err) {
      setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Could not load — pick the province again' });
      toast(err.message, 'error');
    }
  }
  async function onProvincePick(item) {
    GEO.cities = []; GEO.barangays = []; GEO.zip = null; clearTimeout(GEO.zipTimer);
    setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Choose a province first' });
    setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Choose a city first' });
    const zip = $('newSupplierZip');
    zip.value = ''; zip.disabled = true; zip.placeholder = 'Choose a barangay first'; showLive('newSupplierZip', '');
    setZipStatus('Checked against the selected city');
    if (item) await loadCities('/geo/provinces/' + encodeURIComponent(item.code) + '/cities');
  }
  async function loadBarangays(city) {                   // -> true when the barangay box is ready
    const box = $('newSupplierBarangay');
    setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Loading barangays…' });
    try {
      GEO.barangays = await geoGet('/geo/cities/' + encodeURIComponent(city.code) + '/barangays');
    } catch (err) { GEO.barangays = []; }
    if ($('newSupplierCity').dataset.code !== city.code) return false;     // city changed while loading
    if (GEO.barangays.length) setBox('newSupplierBarangay', { value: '', disabled: false, placeholder: 'Type to search barangay…' });
    else {                                                // list not available for this city: allow typing it
      setBox('newSupplierBarangay', { value: '', disabled: false, placeholder: 'Type the barangay' });
      box.dataset.free = '1';
    }
    return true;
  }
  function unlockZip(on) {
    const zip = $('newSupplierZip');
    zip.disabled = !on;
    zip.placeholder = on ? 'e.g. 2009' : 'Choose a barangay first';
    setZipStatus(on ? 'Checked against ' + (clean($('newSupplierCity').value) || 'the selected city') : 'Checked against the selected city');
    if (on && clean(zip.value)) scheduleZipCheck(0);
  }
  function onCityPick(item) {
    GEO.zip = null; GEO.barangays = []; clearTimeout(GEO.zipTimer);
    const zip = $('newSupplierZip');
    zip.value = ''; showLive('newSupplierZip', '');
    unlockZip(false);
    if (!item) { setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Choose a city first' }); return; }
    loadBarangays(item);
  }
  function onBarangayPick(item) { unlockZip(!!item); }

  const zipKey = () => [clean($('newSupplierZip').value), clean($('newSupplierBarangay').value), clean($('newSupplierCity').value), clean($('newSupplierProvince').value), clean($('newSupplierRegion').value)].join('|');
  const zipMemo = new Map();
  async function checkZipMatch() {                       // -> { ok, message, unknown? }
    const zip = clean($('newSupplierZip').value), city = clean($('newSupplierCity').value),
      province = clean($('newSupplierProvince').value), region = clean($('newSupplierRegion').value),
      barangay = clean($('newSupplierBarangay').value);
    const key = zipKey();
    if (zipMemo.has(key)) return zipMemo.get(key);
    let r;
    try {
      r = await api('/geo/check-zip?zip=' + encodeURIComponent(zip) + '&city=' + encodeURIComponent(city) +
        '&province=' + encodeURIComponent(province) + '&region=' + encodeURIComponent(region) + '&barangay=' + encodeURIComponent(barangay));
    } catch (err) { return { ok: false, unknown: true, message: 'Could not check the ZIP code right now. Try again.' }; }
    if (!r.unknown) zipMemo.set(key, r);
    return r;
  }
  function scheduleZipCheck(delay) {
    clearTimeout(GEO.zipTimer);
    GEO.zip = null;
    const zip = clean($('newSupplierZip').value);
    if (isOutsidePH() || !/^\d{4}$/.test(zip) || !picked('newSupplierCity') || !picked('newSupplierProvince') || !picked('newSupplierBarangay')) return;
    const key = zipKey();
    setZipStatus('Checking ZIP code…');
    GEO.zipTimer = setTimeout(async () => {
      const r = await checkZipMatch();
      if (zipKey() !== key) return;                      // the boxes changed while we were checking
      GEO.zip = Object.assign({ key }, r);
      setZipStatus(r.ok ? 'ZIP code matches ' + clean($('newSupplierCity').value) : 'Checked against ' + clean($('newSupplierCity').value), r.ok ? '#5fbf8a' : '');
      validateField('newSupplierZip', true);
    }, delay == null ? 450 : delay);
  }

  const ADDRESS_KEYS = [['region', 'newSupplierRegion'], ['province', 'newSupplierProvince'], ['city', 'newSupplierCity'], ['barangay', 'newSupplierBarangay'], ['zip', 'newSupplierZip']];
  // an old address that is left exactly as it was does not have to be re-picked from the lists
  function addressUnchanged() {
    const sup = editedSupplier();
    return !!(sup && sup.region && ADDRESS_KEYS.every(([k, id]) => clean(sup[k]) === clean($(id).value)));
  }

  function setupAddressFields() {
    if (!$('newSupplierRegion')) return;
    injectGeoStyles();
    makeCombo('newSupplierRegion', () => GEO.regions, onRegionPick);
    makeCombo('newSupplierProvince', () => GEO.provinces, onProvincePick);
    makeCombo('newSupplierCity', () => GEO.cities, onCityPick);
    makeCombo('newSupplierBarangay', () => GEO.barangays, onBarangayPick);
    const brgy = $('newSupplierBarangay');
    if (brgy && !brgy.dataset.freeBound) {                // when the list is not available the barangay is typed by hand
      brgy.dataset.freeBound = '1';
      brgy.addEventListener('input', () => { if (brgy.dataset.free || isOutsidePH()) { brgy.value = titleCase(brgy.value); unlockZip(clean(brgy.value).length >= 2); } });
    }
    const zip = $('newSupplierZip');
    if (zip && !zip.dataset.geo) {
      zip.dataset.geo = '1';
      zip.addEventListener('input', () => scheduleZipCheck());
    }
    const region = $('newSupplierRegion');
    if (!region.dataset.retryBound) {
      region.dataset.retryBound = '1';
      region.addEventListener('geo-retry', () => { ensureRegions(); });
    }
  }

  let prefillToken = 0;
  async function prefillAddress(sup) {
    const token = ++prefillToken;
    resetBelowRegion(false);
    if (!(await ensureRegions()) || token !== prefillToken) return;
    if (!sup || !sup.region) return;
    const reg = findByName(GEO.regions, sup.region);
    if (!reg) {                                          // older record with a region name we do not know: show it as it was
      setBox('newSupplierRegion', { value: sup.region, disabled: false });
      setBox('newSupplierProvince', { value: sup.province, disabled: false });
      setBox('newSupplierCity', { value: sup.city, disabled: false });
      setBox('newSupplierBarangay', { value: sup.barangay, disabled: false });
      const z = $('newSupplierZip'); z.value = sup.zip || ''; z.disabled = false;
      return;
    }
    setBox('newSupplierRegion', { value: reg.name, code: reg.code, disabled: false });
    await onRegionPick(reg);
    if (token !== prefillToken) return;
    if (reg.name === OUTSIDE_PH) {
      setBox('newSupplierProvince', { value: sup.province, disabled: false });
      setBox('newSupplierCity', { value: sup.city, disabled: false });
      setBox('newSupplierBarangay', { value: sup.barangay, disabled: false, placeholder: 'District / barangay (optional)' });
    } else {
      if (GEO.provinces.length) {
        const prov = findByName(GEO.provinces, sup.province);
        if (prov) { setBox('newSupplierProvince', { value: prov.name, code: prov.code, disabled: false }); await onProvincePick(prov); }
        else { setBox('newSupplierProvince', { value: sup.province, disabled: false }); GEO.cities = []; }
      }
      if (token !== prefillToken) return;
      const city = findByName(GEO.cities, sup.city);
      if (city) {
        setBox('newSupplierCity', { value: city.name, code: city.code, disabled: false });
        if (await loadBarangays(city) && token === prefillToken) {
          const bg = findByName(GEO.barangays, sup.barangay);
          if (bg) setBox('newSupplierBarangay', { value: bg.name, code: bg.code, disabled: false });
          else if ($('newSupplierBarangay').dataset.free) $('newSupplierBarangay').value = sup.barangay || '';
        }
      } else setBox('newSupplierCity', { value: sup.city, disabled: false });
    }
    if (token !== prefillToken) return;
    const z = $('newSupplierZip');
    z.disabled = false; z.value = sup.zip || ''; z.placeholder = 'e.g. 2009';
    setZipStatus('Checked against ' + (sup.city || 'the selected city'));
  }

  const SUPPLIER_FIELDS = { name: 'newSupplierName', contactPerson: 'newSupplierContactPerson', phone: 'newSupplierPhone', email: 'newSupplierEmail',
    address: 'newSupplierAddress', city: 'newSupplierCity', barangay: 'newSupplierBarangay', province: 'newSupplierProvince', region: 'newSupplierRegion', zip: 'newSupplierZip',
    products: 'newSupplierProducts' };

  // duplicate supplier checks against the loaded list (the server re-checks on save)
  const phoneKey = (p) => String(p || '').replace(/[\s().-]/g, '').replace(/^\+63/, '0');
  const editingSupplier = () => (typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null);
  const otherSuppliers = () => supplierData.filter((x) => x.id !== editingSupplier());
  function supplierDup(field, value) {
    const v = clean(value); if (!v) return '';
    const mine = supplierData.find((x) => x.id === editingSupplier());
    if (field === 'name') {
      const d = otherSuppliers().find((x) => sameText(x.name, v));
      return d && !(mine && sameText(mine.name, v)) ? 'A supplier named "' + d.name + '" already exists' + (d.status === 'archived' ? ' (archived)' : '') : '';
    }
    if (field === 'email') {
      const d = otherSuppliers().find((x) => x.email && sameText(x.email, v));
      return d && !(mine && mine.email && sameText(mine.email, v)) ? 'This email is already used by ' + d.name : '';
    }
    const d = otherSuppliers().find((x) => x.phone && phoneKey(x.phone) === phoneKey(v));
    return d && !(mine && phoneKey(mine.phone) === phoneKey(v)) ? 'This phone number is already used by ' + d.name : '';
  }
  const CONTACT_PERSON_RE = /^[A-Za-z][A-Za-z .,'’-]*$/;

  function setupSupplierModal() {
    const overlay = $('newSupplierModalOverlay'), form = $('newSupplierForm');
    if (!overlay || !form || form.dataset.bridge) return;
    form.dataset.bridge = '1';
    ['newSupplierName', 'newSupplierContactPerson', 'newSupplierAddress'].forEach(liveTitleCase);
    setupSupplierInputFilters();
    setupAddressFields();
    $('newSupplierEmail').addEventListener('input', scheduleEmailCheck);
    $('newSupplierEmail').addEventListener('blur', scheduleEmailCheck);
    form.addEventListener('reset', () => setTimeout(() => { setEmailStatus(EMAIL_HINT); setupSupplierInputFilters(); prefillToken++; resetBelowRegion(false); }, 0));
    new MutationObserver(() => { if (overlay.classList.contains('open')) onSupplierModalOpen(); })
      .observe(overlay, { attributes: true, attributeFilter: ['class'] });

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      const banner = $('newSupplierFormError');
      const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
      const errs = {};
      const T = (id, label, o) => { const v = vText(errs, id, label, o); return v && !errs[id] ? titleCase(v) : v; };
      const name = T('newSupplierName', 'Supplier name', { min: 2 });
      if (name && !errs.newSupplierName) errs.newSupplierName = (!/[A-Za-z]/.test(name) ? 'Supplier name must contain letters' : supplierDup('name', name)) || undefined;
      if (!errs.newSupplierName) delete errs.newSupplierName;
      const contactPerson = T('newSupplierContactPerson', 'Contact person', { min: 2, max: 80, required: false });
      if (contactPerson && !errs.newSupplierContactPerson && !CONTACT_PERSON_RE.test(contactPerson)) errs.newSupplierContactPerson = 'Contact person can only have letters, spaces, . , \' and -';
      const phone = vText(errs, 'newSupplierPhone', 'Phone number', { min: 7, max: 30, required: false });
      if (phone && !errs.newSupplierPhone && !phoneUnchanged()) { const m = phoneError(phone) || supplierDup('phone', phone); if (m) errs.newSupplierPhone = m; }
      const email = vText(errs, 'newSupplierEmail', 'Email', { min: 5, max: 120, required: false }).toLowerCase();
      if (email && !errs.newSupplierEmail && !emailUnchanged() && !EMAIL_FORMAT.test(email)) errs.newSupplierEmail = 'Enter a valid email address, e.g. name@company.com';
      if (email && !errs.newSupplierEmail && supplierDup('email', email)) errs.newSupplierEmail = supplierDup('email', email);
      if (!phone && !email) { errs.newSupplierPhone = errs.newSupplierPhone || 'Enter a phone number or an email address'; errs.newSupplierEmail = errs.newSupplierEmail || 'Enter a phone number or an email address'; }
      const address = T('newSupplierAddress', 'Warehouse address', { min: 5, max: 150 });
      const outside = isOutsidePH();
      const sameAddr = addressUnchanged();
      let city = vText(errs, 'newSupplierCity', 'City / Municipality', { min: 2, max: 60 });
      let province = vText(errs, 'newSupplierProvince', 'Province / State', { min: 2, max: 60 });
      let barangay = vText(errs, 'newSupplierBarangay', 'Barangay', { min: 2, max: 80, required: !outside });
      if (outside) { city = titleCase(city); province = titleCase(province); barangay = titleCase(barangay); }
      const region = clean($('newSupplierRegion').value);
      if (!region) errs.newSupplierRegion = 'Choose a region';
      else if (!sameAddr && !picked('newSupplierRegion')) errs.newSupplierRegion = 'Pick a region from the list';
      if (!errs.newSupplierProvince && !sameAddr && !picked('newSupplierProvince')) errs.newSupplierProvince = 'Pick a province from the list';
      if (!errs.newSupplierCity && !sameAddr && !picked('newSupplierCity')) errs.newSupplierCity = 'Pick a city / municipality from the list';
      if (!errs.newSupplierBarangay && !sameAddr && !outside && !picked('newSupplierBarangay')) errs.newSupplierBarangay = 'Pick a barangay from the list';
      const zip = vText(errs, 'newSupplierZip', 'ZIP code', { min: 1, max: 10 });
      if (zip && !errs.newSupplierZip && region) { const m = zipError(zip, region); if (m) errs.newSupplierZip = m; }
      // the ZIP code must belong to the chosen city (checked with the postal list)
      if (zip && !outside && !sameAddr && !errs.newSupplierZip && !errs.newSupplierCity && !errs.newSupplierBarangay && !errs.newSupplierProvince && !errs.newSupplierRegion) {
        setZipStatus('Checking ZIP code…');
        const z = await checkZipMatch();
        if (z.unknown) setZipStatus('Could not check the ZIP code right now — the server will check it');
        else if (!z.ok) { errs.newSupplierZip = z.message; setZipStatus('Checked against ' + city); }
        else setZipStatus('ZIP code matches ' + city, '#5fbf8a');
      }
      const productSkus = [].map.call($('newSupplierProducts').querySelectorAll('.prod-check:checked'), (c) => c.value);
      if (!productSkus.length) errs.newSupplierProducts = 'Tick at least one product this supplier provides';
      // the email's domain must really exist and be able to receive mail
      if (email && !errs.newSupplierEmail && !emailUnchanged()) {
        setEmailStatus('Checking email domain…');
        const r = await checkEmail(email);
        if (!r.ok) { emailResults.delete(email); errs.newSupplierEmail = r.message; setEmailStatus(EMAIL_HINT); }
        else if (r.unverified) setEmailStatus('Email format is OK (domain could not be checked right now)');
        else setEmailStatus('Email domain is valid', '#5fbf8a');
      }
      if (Object.keys(errs).length) return showErrors(form, banner, errs);

      clearErrors(form); hideBanner(banner);
      const payload = { name, contactPerson, phone, email, address, city, barangay, province, region, zip, productSkus };
      try {
        if (id) await api('/suppliers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/suppliers', { method: 'POST', body: JSON.stringify(payload) });
        toast(id ? 'Supplier updated' : 'Supplier added');
        closeNewSupplierModal();
        await load();
      } catch (err) {
        showErrors(form, banner, mapFields(err.fields, SUPPLIER_FIELDS), err.message);
      }
    }, true);

    const archive = $('archiveSupplierBtn');
    if (archive) archive.addEventListener('click', async () => {
      const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
      const supplier = id && supplierData.find((s) => s.id === id);
      if (!supplier) return;
      const next = supplier.status === 'archived' ? 'active' : 'archived';
      if (!confirm((next === 'archived' ? 'Archive ' : 'Restore ') + supplier.name + '?')) return;
      try {
        await api('/suppliers/' + encodeURIComponent(id) + '/status', { method: 'PATCH', body: JSON.stringify({ status: next }) });
        toast('Supplier ' + (next === 'archived' ? 'archived' : 'restored'));
        closeNewSupplierModal();
        await load();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* =====================================================
     MOVEMENT LOG  (fills the table on Stock In / Out and filters it)
  ===================================================== */
  function renderMovementLog() {
    const body = $('movementLogTableBody');
    if (!body) return;
    const term = (($('logSearch') || {}).value || '').trim().toLowerCase();
    const type = ($('logTypeFilter') || {}).value || 'all';
    const rows = movementCache.filter((m) =>
      (type === 'all' || m.type === type) &&
      (!term || (m.product || '').toLowerCase().indexOf(term) >= 0 || (m.ref || '').toLowerCase().indexOf(term) >= 0 ||
        (m.reason || '').toLowerCase().indexOf(term) >= 0 || (m.productionRef || '').toLowerCase().indexOf(term) >= 0 ||
        (m.relatedProduct || '').toLowerCase().indexOf(term) >= 0));
    const sub = $('logPanelSub');
    if (sub) sub.textContent = 'Showing ' + rows.length + ' of ' + movementCache.length + ' recorded stock in / out entries';
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="dim" style="text-align:center;padding:24px">' +
        (movementCache.length ? 'No movements match your search.' : 'No stock movements recorded yet.') + '</td></tr>';
      return;
    }
    body.innerHTML = rows.map((m) => {
      const isIn = m.type === 'in';
      return '<tr>' +
        '<td class="mono">' + esc(m.ref) + '</td>' +
        '<td>' + esc(m.product) + '</td>' +
        '<td><span class="status-pill ' + (isIn ? 'in' : 'out') + '">' + (isIn ? 'In' : 'Out') + '</span></td>' +
        '<td class="dim">' + esc(m.reason || '') + (m.productionRef ? '<div style="font-size:12.5px">' + esc(m.productionRef) + (m.relatedProduct ? ' \u00B7 for ' + esc(m.relatedProduct) : '') + '</div>' : '') + '</td>' +
        '<td class="dim">' + (isIn ? '+' : '-') + esc(formatNumber(m.qty)) + ' ' + esc(m.unit) + '</td>' +
        '<td class="dim">' + esc(m.department) + '</td>' +
        '<td class="dim">' + (m.supplier || m.invoiceNo
          ? (m.supplier ? esc(m.supplier) : '') + (m.invoiceNo ? '<div style="font-size:12.5px">Inv. ' + esc(m.invoiceNo) + '</div>' : '') : '\u2014') + '</td>' +
        '<td class="dim">' + esc(m.handledBy) + '</td>' +
        '<td class="dim">' + esc(m.dateTime) + '</td></tr>';
    }).join('');
  }

  function setupMovementLog() {
    const s = $('logSearch'), t = $('logTypeFilter');
    if (s) s.addEventListener('input', renderMovementLog);
    if (t) t.addEventListener('change', renderMovementLog);
  }

  /* =====================================================
     STOCK ALERTS - a banner that stays on every page until stock is added.
     Out of stock (0) = critical, at/below reorder level = low.
     It cannot be dismissed: it clears by itself once Stock In lifts the item above its reorder level.
  ===================================================== */
  const ALERT_SOUND_KEY = 'te_alert_sound';
  const ALERT_EVERY = { critical: 45000, low: 180000 };      // how often the sound repeats
  let alertList = [], alertSeen = null, alertCtx = null, alertExpanded = false;
  const alertLast = { critical: 0, low: 0 };
  let alertBaseTitle = '', alertFlip = false;
  const alertSoundOn = () => { try { return localStorage.getItem(ALERT_SOUND_KEY) !== 'off'; } catch (e) { return true; } };

  function alertAction(i) {
    if (NEEDS_SUPPLIER.indexOf(i.department) < 0) return 'Schedule production (made in-house)';
    const sup = (i.suppliers || []).filter((s) => s.status !== 'archived');
    const main = sup.find((s) => s.primary) || sup[0];
    return main ? 'Reorder from ' + main.name : 'No supplier linked: link one in Supplier Management';
  }
  function computeAlerts() {
    return inventoryCache
      .filter((i) => Number(i.onHand) <= Number(i.reorderLevel))
      .map((i) => ({ item: i, critical: Number(i.onHand) <= 0 }))
      .sort((a, b) => (b.critical - a.critical) ||
        (Number(a.item.onHand) / (Number(a.item.reorderLevel) || 1)) - (Number(b.item.onHand) / (Number(b.item.reorderLevel) || 1)));
  }

  function alertBeep(critical) {
    if (!alertSoundOn() || !alertCtx) return;                 // browsers allow sound only after the first click on the page
    try {
      if (alertCtx.state === 'suspended') alertCtx.resume();
      (critical ? [880, 660, 880, 660, 880] : [660, 660]).forEach((freq, n) => {
        const o = alertCtx.createOscillator(), g = alertCtx.createGain();
        o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.05;
        o.connect(g); g.connect(alertCtx.destination);
        const t = alertCtx.currentTime + n * 0.26;
        o.start(t); o.stop(t + 0.18);
      });
    } catch (e) { /* sound is a bonus; the banner is the alert */ }
  }

  function alertBanner() {
    let el = $('stockAlertBanner');
    if (el) return el;
    const bar = document.querySelector('.topbar');
    if (!bar) return null;
    el = document.createElement('div');
    el.id = 'stockAlertBanner'; el.className = 'stock-alert'; el.hidden = true;
    el.setAttribute('role', 'alert'); el.setAttribute('aria-live', 'assertive');
    bar.parentNode.insertBefore(el, bar.nextSibling);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sa]');
      if (!b) return;
      if (b.dataset.sa === 'toggle') { alertExpanded = !alertExpanded; renderStockAlerts(); }
      else if (b.dataset.sa === 'sound') {
        try { localStorage.setItem(ALERT_SOUND_KEY, alertSoundOn() ? 'off' : 'on'); } catch (err) { /* ignore */ }
        renderStockAlerts(); if (alertSoundOn()) alertBeep(false);
      } else if (b.dataset.sa === 'stockin') goStockIn(b.dataset.sku);
    });
    return el;
  }

  function goStockIn(sku) {
    const item = inventoryCache.find((i) => i.sku === sku);
    if (!item) return;
    const nav = document.querySelector('.nav-item[data-page="stockflow"]');
    if (nav) nav.click();
    const seg = document.querySelector('#movementTypeToggle .seg-btn[data-type="in"]');
    if (seg && !seg.classList.contains('active')) seg.click();
    const dept = $('movementDept');
    if (dept) { dept.value = item.department; dept.dispatchEvent(new Event('change', { bubbles: true })); }
    const prod = $('movementProduct');
    if (prod) { prod.value = sku; prod.dispatchEvent(new Event('change', { bubbles: true })); }
    const qty = $('movementQuantity');
    if (qty) qty.focus();
  }

  function renderStockAlerts() {
    alertList = computeAlerts();
    const el = alertBanner();
    if (el) { el.hidden = true; el.className = 'stock-alert'; el.innerHTML = ''; }
    ['inventory', 'stockflow'].forEach((page) => {
      const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
      if (!nav) return;
      const badge = nav.querySelector('.nav-alert');
      if (badge) badge.remove();
    });
  }

  function setupStockAlerts() {
    /* Low-stock banners/sounds moved to the Notification Center. Detection stays on the server. */
  }

  /* ---- keep data live: refresh every 10 s and whenever the tab is shown again ---- */
  let refreshing = false, refreshAgain = false;
  async function liveRefresh(force) {
    if (force === true && refreshing) { refreshAgain = true; return; }   // run once more right after the current one
    if (refreshing || document.hidden) return;
    refreshing = true;
    try { await load(); } catch (e) { console.warn('[api-bridge] refresh', e.message); } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; liveRefresh(true); }
    }
  }
  function setupLiveRefresh() {
    setInterval(() => liveRefresh(), 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) liveRefresh(); });
    window.addEventListener('focus', () => liveRefresh());
  }

  /* =====================================================
     STAY ON THE SAME PAGE AFTER A REFRESH
     (page is kept in the address bar, e.g. #usermgmt, and in localStorage)
  ===================================================== */
  const PAGE_KEY = 'tripleE.currentPage';
  const pageExists = (id) => !!id && /^[A-Za-z][\w-]*$/.test(id) && !!document.querySelector('.page#' + id);

  function setupPagePersistence() {
    const original = window.navigateToPage;
    if (typeof original !== 'function') return;
    window.navigateToPage = function (id) {
      original.apply(this, arguments);
      if (!pageExists(id)) return;
      try { localStorage.setItem(PAGE_KEY, id); } catch (e) { /* storage blocked */ }
      if (location.hash !== '#' + id) history.pushState(null, '', '#' + id);
      window.scrollTo(0, 0);
      liveRefresh(true);
    };
    window.addEventListener('popstate', () => {            // browser Back / Forward
      const id = location.hash.slice(1);
      if (pageExists(id)) original(id);
    });
    let saved = null;
    try { saved = localStorage.getItem(PAGE_KEY); } catch (e) { /* ignore */ }
    const wanted = [location.hash.slice(1), saved].find(pageExists);
    if (wanted && wanted !== 'dashboard') original(wanted);
    if (wanted && location.hash !== '#' + wanted) history.replaceState(null, '', '#' + wanted);
  }

  /* =====================================================
     LIVE VALIDATION — message appears under the box while typing / on leaving it
  ===================================================== */
  const LIVE = {};         // field id -> () => error message ('' when OK)
  const FORM_BANNERS = { movementForm: 'movementFormError', newProductForm: 'newProductFormError',
    newSupplierForm: 'newSupplierFormError', inviteUserForm: 'inviteUserFormError', editUserForm: 'editUserFormError' };
  const DEPENDS = {                                        // when X changes, re-check these (if already touched)
    movementProduct: ['movementQuantity', 'movementReason'],
    movementReason: ['movementNote'],
    movementDept: ['movementProduct', 'movementReason'],
    npCategory: ['npCategoryNew'],
    npDept: ['npListPrice'],
    newSupplierPhone: ['newSupplierEmail'],
    newSupplierEmail: ['newSupplierPhone'],
    newSupplierRegion: ['newSupplierProvince', 'newSupplierCity', 'newSupplierBarangay', 'newSupplierZip'],
    newSupplierProvince: ['newSupplierCity', 'newSupplierBarangay', 'newSupplierZip'],
    newSupplierCity: ['newSupplierBarangay', 'newSupplierZip'],
    newSupplierBarangay: ['newSupplierZip']
  };
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  const textRule = (id, label, o) => () => { const e = {}; vText(e, id, label, o); return e[id] || ''; };
  const numRule = (id, label, o) => () => { const e = {}; vNum(e, id, label, o); return e[id] || ''; };
  const selectRule = (id, msg) => () => ($(id) && $(id).value ? '' : msg);
  const emailRule = (id) => () => {
    const v = clean($(id).value);
    if (!v) return 'Email is required';
    if (v.length > 120) return 'Email must be at most 120 characters';
    return EMAIL_RE.test(v) ? '' : 'Enter a valid email address, e.g. name@company.com';
  };

  function defineRules() {
    Object.assign(LIVE, {
      /* stock in / out */
      movementProduct: selectRule('movementProduct', 'Choose a product'),
      movementReason: () => $('movementReason').value ? '' :
        (movementType() === 'out' ? 'Choose why this stock is going out' : 'Choose why this stock is coming in'),
      movementQuantity: () => {
        const e = {}; const q = vNum(e, 'movementQuantity', 'Quantity', { gt: true });
        if (e.movementQuantity) return e.movementQuantity;
        const item = movementItem();
        if (item && movementType() === 'out' && q > item.onHand)
          return 'Only ' + formatNumber(item.onHand) + ' ' + item.unit + ' on hand — cannot take out ' + formatNumber(q);
        return '';
      },
      movementNote: () => {
        const v = clean($('movementNote').value);
        if (v.length > 300) return 'Note must be at most 300 characters';
        if (NOTE_REQUIRED.indexOf($('movementReason').value) >= 0 && v.length < 3) return 'Please explain this entry in the note';
        return '';
      },
      /* product */
      npSku: () => {
        const v = clean($('npSku').value).toUpperCase();
        if (!v) return 'SKU is required';
        if (!/^[A-Z0-9][A-Z0-9._-]{2,39}$/.test(v)) return 'SKU must be 3–40 characters: letters, numbers, dot, dash or underscore';
        const d = duplicateSku(v);
        return d ? 'That SKU already exists (' + d.name + ')' : '';
      },
      npName: () => {
        const m = textRule('npName', 'Product name', { min: 2 })();
        if (m) return m;
        const d = duplicateProductName($('npName').value);
        return d ? dupNameMsg(d) : '';
      },
      npDept: () => DEPARTMENTS.indexOf($('npDept').value) >= 0 ? '' : 'Choose a department',
      npCategory: selectRule('npCategory', 'Choose a category'),
      npCategoryNew: textRule('npCategoryNew', 'Category name', { min: 2, max: 60 }),
      npUnit: selectRule('npUnit', 'Choose a unit'),
      npUnitCost: numRule('npUnitCost', 'Unit cost', { max: 1e7 }),
      npOnHand: () => $('npOnHand').readOnly ? '' : numRule('npOnHand', 'On hand')(),
      npReorder: () => ($('npReorderManual') && $('npReorderManual').checked ? numRule('npReorder', 'Reorder level')() : ''),   // automatic = nothing to type
      npListPrice: () => sellsNow() ? numRule('npListPrice', 'Selling price', { max: 1e7, gt: true })() : '',
      npLocation: selectRule('npLocation', 'Choose the storage location'),
      npLocationNew: textRule('npLocationNew', 'Storage location', { min: 2, max: 100 }),
      npSupplier: () => (!productModalState() && NEEDS_SUPPLIER.indexOf($('npDept').value) >= 0 && !$('npSupplier').value ? 'Choose the supplier for this material' : ''),
      /* supplier */
      newSupplierName: () => {
        const m = textRule('newSupplierName', 'Supplier name', { min: 2 })();
        if (m) return m;
        const v = clean($('newSupplierName').value);
        return !/[A-Za-z]/.test(v) ? 'Supplier name must contain letters' : supplierDup('name', v);
      },
      newSupplierContactPerson: () => {
        const m = textRule('newSupplierContactPerson', 'Contact person', { min: 2, max: 80, required: false })();
        if (m) return m;
        const v = clean($('newSupplierContactPerson').value);
        return v && !CONTACT_PERSON_RE.test(v) ? 'Contact person can only have letters, spaces, . , \' and -' : '';
      },
      newSupplierPhone: () => {
        const e = {}; const v = vText(e, 'newSupplierPhone', 'Phone number', { min: 7, max: 30, required: false });
        if (e.newSupplierPhone) return e.newSupplierPhone;
        if (!v) return clean($('newSupplierEmail').value) ? '' : 'Enter a phone number or an email address';
        return phoneUnchanged() ? '' : (phoneError(v) || supplierDup('phone', v));
      },
      newSupplierEmail: () => {
        const e = {}; const v = vText(e, 'newSupplierEmail', 'Email', { min: 5, max: 120, required: false });
        if (e.newSupplierEmail) return e.newSupplierEmail;
        if (!v) return clean($('newSupplierPhone').value) ? '' : 'Enter a phone number or an email address';
        if (emailUnchanged()) return '';
        if (!EMAIL_FORMAT.test(v)) return 'Enter a valid email address, e.g. name@company.com';
        const dup = supplierDup('email', v);
        if (dup) return dup;
        const known = emailResults.get(v.toLowerCase());
        return known && !known.ok ? known.message : '';
      },
      newSupplierAddress: textRule('newSupplierAddress', 'Warehouse address', { min: 5, max: 150 }),
      newSupplierCity: () => {
        const m = textRule('newSupplierCity', 'City / Municipality', { min: 2, max: 60 })();
        return m || (picked('newSupplierCity') || addressUnchanged() ? '' : 'Pick a city / municipality from the list');
      },
      newSupplierBarangay: () => {
        const m = textRule('newSupplierBarangay', 'Barangay', { min: 2, max: 80, required: !isOutsidePH() })();
        return m || (picked('newSupplierBarangay') || addressUnchanged() || !clean($('newSupplierBarangay').value) ? '' : 'Pick a barangay from the list');
      },
      newSupplierProvince: () => {
        const m = textRule('newSupplierProvince', 'Province / State', { min: 2, max: 60 })();
        return m || (picked('newSupplierProvince') || addressUnchanged() ? '' : 'Pick a province from the list');
      },
      newSupplierRegion: () => {
        if (!clean($('newSupplierRegion').value)) return 'Choose a region';
        return picked('newSupplierRegion') || addressUnchanged() ? '' : 'Pick a region from the list';
      },
      newSupplierZip: () => {
        const v = clean($('newSupplierZip').value);
        if (!v) return 'ZIP code is required';
        const region = clean($('newSupplierRegion').value);
        const fmt = region ? zipError(v, region) : '';
        if (fmt) return fmt;
        // result of the live check against the selected city (the submit check also runs it)
        return GEO.zip && GEO.zip.key === zipKey() && !GEO.zip.ok && !GEO.zip.unknown ? GEO.zip.message : '';
      },
      newSupplierProducts: () => $('newSupplierProducts').querySelector('.prod-check:checked') ? '' : 'Tick at least one product this supplier provides',
      /* users */
      inviteName: textRule('inviteName', 'Full name', { min: 2, max: 100 }),
      inviteEmail: emailRule('inviteEmail'),
      inviteRole: selectRule('inviteRole', 'Choose a role'),
      editUserName: textRule('editUserName', 'Full name', { min: 2, max: 100 }),
      editUserEmail: emailRule('editUserEmail'),
      editUserRole: selectRule('editUserRole', 'Choose a role')
    });
  }

  const isActive = (el) => {
    if (!el || el.disabled) return false;
    const grp = el.closest('#movementNoteGroup, #npCategoryNewWrap');
    return !(grp && grp.style.display === 'none');
  };

  function showLive(id, message) {
    const el = $(id);
    if (!el) return;
    const group = el.closest('.form-group') || el.parentNode;
    group.querySelectorAll('.field-msg[data-for="' + id + '"]').forEach((n) => n.remove());
    el.classList.toggle('field-invalid', !!message);
    if (message) {
      const m = document.createElement('div');
      m.className = 'field-msg'; m.dataset.for = id; m.textContent = message;
      group.appendChild(m);
    }
  }

  function validateField(id, force) {
    const el = $(id), rule = LIVE[id];
    if (!el || !rule) return '';
    if (!isActive(el)) { showLive(id, ''); return ''; }
    if (force) el.dataset.touched = '1';
    if (!el.dataset.touched) return '';
    const message = rule();
    showLive(id, message);
    const form = el.closest('form');
    if (form) {
      const banner = $(FORM_BANNERS[form.id]);
      if (banner && !form.querySelector('.field-invalid')) banner.classList.remove('show');
    }
    return message;
  }

  function resetLive(form) {
    form.querySelectorAll('[data-touched]').forEach((n) => delete n.dataset.touched);
    clearErrors(form);
    const banner = $(FORM_BANNERS[form.id]);
    if (banner) banner.classList.remove('show');
  }

  function setupLiveValidation() {
    defineRules();
    Object.keys(LIVE).forEach((id) => {
      const el = $(id);
      if (!el) return;
      const check = () => {
        validateField(id, true);
        (DEPENDS[id] || []).forEach((d) => validateField(d, false));
      };
      const isBox = el.classList.contains('check-list');
      if (isBox) el.addEventListener('change', check);
      else {
        el.addEventListener('input', check);
        el.addEventListener('change', check);
        el.addEventListener('blur', check);
      }
    });
    // switching Stock In <-> Stock Out changes what is valid
    const toggle = $('movementTypeToggle');
    if (toggle) toggle.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      setTimeout(() => { ['movementReason', 'movementQuantity'].forEach((i) => validateField(i, false)); }, 0);
    }));

    Object.keys(FORM_BANNERS).forEach((formId) => {
      const form = $(formId);
      if (!form) return;
      form.addEventListener('reset', () => resetLive(form));
      // runs BEFORE the page's own submit handlers (registered later), and blocks them when something is wrong
      form.addEventListener('submit', (e) => {
        const bad = [];
        Object.keys(LIVE).forEach((id) => { if (form.contains($(id)) && validateField(id, true)) bad.push(id); });
        if (!bad.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const banner = $(FORM_BANNERS[formId]);
        if (banner) { banner.textContent = 'Please fix the highlighted fields.'; banner.classList.add('show'); }
        const first = $(bad[0]);
        if (first && first.focus && first.tagName !== 'DIV') first.focus();
      }, true);
    });

    // a modal that is opened again starts clean
    ['newProductModalOverlay', 'newSupplierModalOverlay', 'inviteUserModalOverlay', 'editUserModalOverlay'].forEach((oid) => {
      const overlay = $(oid);
      if (!overlay) return;
      new MutationObserver(() => {
        if (overlay.classList.contains('open')) overlay.querySelectorAll('form').forEach((f) => {
          f.querySelectorAll('[data-touched]').forEach((n) => delete n.dataset.touched);
          clearErrors(f);
        });
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /* =====================================================
     UNIT DROPDOWN (kg, pcs first, then units used for metals)
  ===================================================== */
  function setUnitValue(unit) {
    const sel = $('npUnit');
    if (!sel) return;
    unit = clean(unit);
    if (unit && ![].some.call(sel.options, (o) => o.value === unit)) {   // an older product with a unit that is not in the list
      const opt = document.createElement('option');
      opt.value = unit; opt.textContent = unit; opt.dataset.legacy = '1';
      sel.appendChild(opt);
    }
    sel.value = unit || '';
  }
  function setupUnitSelect() {
    const sel = $('npUnit');
    if (!sel || sel.tagName !== 'SELECT') return;
    const form = sel.form;
    if (form) form.addEventListener('reset', () => setTimeout(() => {
      [].filter.call(sel.options, (o) => o.dataset.legacy).forEach((o) => o.remove());
      sel.value = '';
    }, 0));
  }

  /* =====================================================
     NUMBER BOXES ONLY TAKE NUMBERS (no letters, no e, +, -, no symbols; max 2 decimals)
  ===================================================== */
  function cleanNumberText(text, current, selStart, selEnd) {
    let t = String(text).replace(/[^0-9.]/g, '');
    const before = current.slice(0, selStart), after = current.slice(selEnd);
    let next = before + t + after;
    // keep one dot and at most 2 decimals
    const firstDot = next.indexOf('.');
    if (firstDot >= 0) {
      next = next.slice(0, firstDot + 1) + next.slice(firstDot + 1).replace(/\./g, '');
      next = next.slice(0, firstDot + 1) + next.slice(firstDot + 1, firstDot + 3);
    }
    return next;
  }
  function setupNumberGuard() {
    const isNum = (el) => el && el.tagName === 'INPUT' && el.type === 'number';
    // keyboard: block everything except digits, one dot and control keys
    document.addEventListener('keydown', (e) => {
      if (!isNum(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length > 1) return;                       // Backspace, Tab, arrows, Enter ...
      if (/[0-9]/.test(e.key)) return;
      if (e.key === '.' && e.target.value.indexOf('.') < 0) return;
      e.preventDefault();
    }, true);
    // typed / dropped / IME / mobile keyboards
    document.addEventListener('beforeinput', (e) => {
      if (!isNum(e.target) || !e.data) return;
      if (/[^0-9.]/.test(e.data)) e.preventDefault();
    }, true);
    // paste: keep only the number part
    document.addEventListener('paste', (e) => {
      if (!isNum(e.target)) return;
      e.preventDefault();
      const el = e.target;
      const txt = (e.clipboardData || window.clipboardData).getData('text') || '';
      const cur = el.value;
      let s0 = cur.length, s1 = cur.length;
      try { if (el.selectionStart != null) { s0 = el.selectionStart; s1 = el.selectionEnd; } } catch (x) { /* number inputs may not expose selection */ }
      el.value = cleanNumberText(txt, cur, s0, s1);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, true);
    document.addEventListener('drop', (e) => { if (isNum(e.target)) e.preventDefault(); }, true);
    // safety net: anything unreadable is cleared, and a 3rd decimal is cut off
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!isNum(el)) return;
      if (el.validity && el.validity.badInput) { el.value = ''; return; }
      const m = /^(\d*)\.(\d{3,})$/.exec(el.value);
      if (m) el.value = m[1] + '.' + m[2].slice(0, 2);
    }, true);
    // scrolling over a focused number box must not change it
    document.addEventListener('wheel', (e) => { if (isNum(e.target) && document.activeElement === e.target) e.target.blur(); }, { passive: true, capture: true });
  }

  /* =====================================================
     SHOW THE SIGNED-IN USER (greeting, top bar chip, menu)
  ===================================================== */
  function applyUser() {
    const u = currentUser;
    if (!u || !u.name) return;
    const first = u.name.trim().split(/\s+/)[0];
    const initials = u.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    const set = (sel, v) => document.querySelectorAll(sel).forEach((n) => { n.textContent = v; });
    set('#welcomeName', 'Welcome back, ' + first);
    set('.user-chip .uname', u.name);
    set('.user-chip .urole', u.roleLabel || '');
    set('.user-chip .avatar, .dropdown-avatar', initials);
    set('.dropdown-name', u.name);
    if (u.email) set('.dropdown-email', u.email);
    set('.brand-text .role', 'Product Co');
    const badge = document.querySelector('.topbar .badge');
    if (badge) badge.textContent = u.role === 'finance' ? 'Finance Admin' : (u.roleLabel || 'Staff');
    reapplyAvatar();
  }

  // shows the photo (or the initials when there is none) in the profile window, top bar chip and menu
  function reapplyAvatar() {
    const name = currentUser && currentUser.name ? currentUser.name : '';
    const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'A';
    document.querySelectorAll('#profileAvatar, .user-chip .avatar, .dropdown-avatar').forEach((n) => {
      if (avatarState.has) {
        n.style.backgroundImage = 'url("/api/auth/avatar?v=' + avatarState.v + '")';
        n.style.backgroundSize = 'cover';
        n.style.backgroundPosition = 'center';
        n.textContent = '';
      } else {
        n.style.backgroundImage = ''; n.style.backgroundSize = ''; n.style.backgroundPosition = '';
        n.textContent = initials;
      }
    });
    const rm = $('profileRemoveBtn');
    if (rm) rm.disabled = !avatarState.has;
  }

  /* =====================================================
     DARK / LIGHT THEME
  ===================================================== */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const light = t === 'light';
    if ($('themeIcon')) $('themeIcon').innerHTML = light ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' : '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    if ($('themeLabel')) $('themeLabel').textContent = light ? 'Dark mode' : 'Light mode';
    const b = $('themeToggle');
    if (b) b.title = light ? 'Switch to dark mode' : 'Switch to light mode';
  }
  function setupTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    const b = $('themeToggle');
    if (!b) return;
    b.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('tripleE.theme', next); } catch (e) { /* storage blocked */ }
    });
  }

  /* =====================================================
     REPORTS  (period picker, stat cards, charts, tables, CSV export, print)
  ===================================================== */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromIso = (x) => { const p = x.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const addDays = (x, n) => { const d = fromIso(x); d.setDate(d.getDate() + n); return iso(d); };
  const addMonths = (x, n) => { const d = fromIso(x); d.setDate(1); d.setMonth(d.getMonth() + n); return iso(d); };
  const niceDate = (x) => { const d = fromIso(x); return MON[d.getMonth()] + ' ' + pad(d.getDate()) + ', ' + d.getFullYear(); };
  const money = (n) => (typeof formatCurrency === 'function' ? formatCurrency(n) : '\u20B1' + Number(n).toFixed(2));
  const num = (n) => (typeof formatNumber === 'function' ? formatNumber(n) : String(n));
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  const rep = { type: 'daily', anchor: iso(new Date()), from: '', to: '' };
  // the chosen period (and custom dates) are kept in this browser so a reload does not jump back to Daily
  const REP_KEY = 'te_report_period', REP_TYPES = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
  const saveRepPrefs = () => { try { localStorage.setItem(REP_KEY, JSON.stringify({ type: rep.type, from: rep.from, to: rep.to })); } catch (e) { /* storage blocked: fine */ } };
  function loadRepPrefs() {
    try {
      const v = JSON.parse(localStorage.getItem(REP_KEY) || 'null');
      if (!v || REP_TYPES.indexOf(v.type) < 0) return;
      rep.type = v.type;
      const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
      if (ok(v.from) && ok(v.to)) { rep.from = v.from; rep.to = v.to; }
    } catch (e) { /* ignore a damaged value */ }
  }

  function repRange() {
    const a = fromIso(rep.anchor);
    if (rep.type === 'daily') return { from: rep.anchor, to: rep.anchor, label: niceDate(rep.anchor) };
    if (rep.type === 'weekly') {
      const mon = addDays(rep.anchor, -((a.getDay() + 6) % 7));
      const sun = addDays(mon, 6);
      return { from: mon, to: sun, label: niceDate(mon) + ' \u2013 ' + niceDate(sun) };
    }
    if (rep.type === 'monthly') {
      const first = iso(new Date(a.getFullYear(), a.getMonth(), 1));
      const last = iso(new Date(a.getFullYear(), a.getMonth() + 1, 0));
      return { from: first, to: last, label: MON[a.getMonth()] + ' ' + a.getFullYear() };
    }
    if (rep.type === 'yearly') return { from: a.getFullYear() + '-01-01', to: a.getFullYear() + '-12-31', label: String(a.getFullYear()) };
    const from = rep.from || rep.anchor, to = rep.to || rep.anchor;
    return { from, to, label: niceDate(from) + ' \u2013 ' + niceDate(to), invalid: from > to };
  }

  function repStep(dir) {
    if (rep.type === 'daily') rep.anchor = addDays(rep.anchor, dir);
    else if (rep.type === 'weekly') rep.anchor = addDays(rep.anchor, 7 * dir);
    else if (rep.type === 'monthly') rep.anchor = addMonths(rep.anchor, dir);
    else if (rep.type === 'yearly') rep.anchor = addMonths(rep.anchor, 12 * dir);
  }

  /* Sales that count as real revenue in a period: POS sales that are not voided, and online orders that were
     confirmed (not pending / cancelled) and not refunded. One row per product line. Dates use Manila time. */
  const SALE_TZ = 'Asia/Manila';
  const payLabel = (m) => (m === 'Xendit' ? 'Online payment' : m);   // Xendit is only the gateway behind it; the stored value stays 'Xendit'
  const saleDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: SALE_TZ });
  function repSales(range) {
    if (range.invalid) return [];
    const out = [];
    salesCache.forEach((t) => {
      const day = saleDay(t.createdAt);
      if (day < range.from || day > range.to) return;
      if (t.source === 'POS' ? t.status === 'Voided' : (t.status === 'Pending Confirmation' || t.status === 'Cancelled')) return;
      if (t.refund && t.refund.status === 'approved') return;
      const confirmedBy = (t.history || []).filter((h) => h.to === 'Paid').map((h) => h.by).pop();
      const handler = t.source === 'POS' ? (t.cashier || 'Cashier') : (confirmedBy || 'Online shop');
      (t.items || []).forEach((i) => out.push({
        ref: t.ref, source: t.source, date: day, product: i.name, qty: i.qty, unit: i.unit, price: i.price,
        revenue: i.qty * i.price, profit: i.qty * (i.price - i.cost), customer: t.customer || '', method: t.method || '', handledBy: handler
      }));
    });
    // custom quote orders: every payment received counts on the day it was received (profit is not tracked for custom work)
    quotesCache.forEach((q) => (q.payments || []).forEach((p) => {
      const day = saleDay(p.at);
      if (day < range.from || day > range.to) return;
      out.push({
        ref: q.id, source: 'Quote', date: day, product: (q.product || 'Custom order') + ' \u2013 quote payment', qty: 1, unit: 'payment', price: +p.amount || 0,
        revenue: +p.amount || 0, profit: null, customer: q.customer || '', method: p.method || '', handledBy: q.receivedBy || q.handledBy || 'Finance'
      });
    }));
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.ref < b.ref ? 1 : -1));
  }
  const srcLabel = (src) => (src === 'POS' ? 'POS walk-in' : src === 'Quote' ? 'Custom quote' : 'Online shop');
  const sumProfit = (rows) => rows.reduce((t, r) => t + (r.profit || 0), 0);

  /* ---- cash shifts + collections (same period), from /api/finance/cash-shifts/report ---- */
  const cashRep = { key: '', at: 0, data: null, error: '', pending: null, pendingKey: '' };
  const rsum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  const mergeRows = (map, rows, fields) => (rows || []).forEach((r) => {
    const m = map.get(r.method) || map.set(r.method, { method: r.method }).get(r.method);
    fields.forEach((f) => { m[f] = (m[f] || 0) + (Number(r[f]) || 0); });
  });
  async function fetchCash(from, to) {            // the server answers up to 92 days at a time, so a long period is asked in pieces
    const shifts = [], pos = new Map(), online = new Map();
    let start = from;
    while (start <= to) {
      let end = addDays(start, 91); if (end > to) end = to;
      const d = await api('/finance/cash-shifts/report?from=' + start + '&to=' + end);
      (d.shifts || []).forEach((x) => shifts.push(x));
      mergeRows(pos, d.payments && d.payments.pos, ['count', 'total', 'voided', 'voidedTotal', 'returned']);
      mergeRows(online, d.payments && d.payments.online, ['count', 'collected', 'awaitingCount', 'awaiting', 'cancelled', 'refunded']);
      start = addDays(end, 1);
    }
    shifts.sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
    const closed = shifts.filter((x) => x.closedAt);
    return {
      shifts, pos: [...pos.values()], online: [...online.values()],
      totals: {
        shifts: shifts.length, open: shifts.length - closed.length, expectedCash: rsum(shifts, (x) => x.expectedCash), countedCash: rsum(closed, (x) => x.closingCash),
        shortage: rsum(closed, (x) => Math.min(0, x.difference || 0)), overage: rsum(closed, (x) => Math.max(0, x.difference || 0)),
        needsReview: shifts.filter((x) => (x.flags || []).length).length
      }
    };
  }
  const cashKey = (range) => range.from + '|' + range.to;
  const cashFor = (range) => (cashRep.data && cashRep.key === cashKey(range) ? cashRep.data : null);
  const reportsOpen = () => { const r = $('reports'); return !!r && r.classList.contains('active-page'); };
  function ensureCash(range) {
    if (range.invalid) return Promise.resolve();
    const key = cashKey(range);
    if (cashRep.key === key && cashRep.data && Date.now() - cashRep.at < 30000) return Promise.resolve();
    if (cashRep.pending && cashRep.pendingKey === key) return cashRep.pending;
    cashRep.pendingKey = key; cashRep.error = '';
    cashRep.pending = fetchCash(range.from, range.to)
      .then((d) => { cashRep.key = key; cashRep.at = Date.now(); cashRep.data = d; })
      .catch((e) => { if (e.message === 'Not signed in') return; cashRep.key = key; cashRep.at = Date.now(); cashRep.data = null; cashRep.error = e.message || 'Could not load'; })
      .finally(() => { cashRep.pending = null; const cur = repRange(); if (cashKey(cur) === key) renderCashPanel(cur); });
    renderCashPanel(range);
    return cashRep.pending;
  }
  const cashWhen = (t) => (t ? new Date(t).toLocaleString('en-PH', { timeZone: SALE_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '\u2014');
  const varText = (x) => (x.difference == null ? '\u2014' : Math.abs(x.difference) < 0.005 ? 'Balanced' : (x.difference < 0 ? 'Short ' : 'Over ') + money(Math.abs(x.difference)));
  const collectedNet = (d) => rsum(d.pos, (x) => x.total - (x.returned || 0)) + rsum(d.online, (x) => x.collected - (x.refunded || 0));
  function ensureCashPanel() {
    if ($('reportCashPanel')) return true;
    const body = $('reportSalesBody'), host = body && body.closest('.panel');
    if (!host) return false;
    const div = document.createElement('div');
    div.className = 'panel report-detail-panel'; div.id = 'reportCashPanel';
    div.innerHTML = '<div class="panel-title">Cash Shifts &amp; Collections Report</div><div class="panel-sub report-period-sub" id="reportCashSub">Loading\u2026</div><div id="reportCashBody"></div>';
    host.insertAdjacentElement('afterend', div);
    return true;
  }
  function renderCashPanel(range) {
    if (!ensureCashPanel()) return;
    const sub = $('reportCashSub'), box = $('reportCashBody');
    if (range.invalid) { sub.textContent = 'Start date must be on or before the end date'; box.innerHTML = ''; return; }
    const d = cashFor(range);
    if (!d) {
      sub.textContent = cashRep.error ? 'Could not load cash shifts: ' + cashRep.error : range.label + ' \u00B7 loading\u2026';
      box.innerHTML = ''; return;
    }
    const t = d.totals, net = t.shortage + t.overage;
    sub.textContent = range.label + ' \u00B7 ' + t.shifts + ' shift' + (t.shifts === 1 ? '' : 's') + (t.open ? ' (' + t.open + ' still open)' : '') + ' \u00B7 collected ' + money(collectedNet(d)) +
      ' \u00B7 cash variance ' + (Math.abs(net) < 0.005 ? 'none' : (net < 0 ? '-' : '+') + money(Math.abs(net)));
    const coll = d.pos.map((x) => '<tr><td>POS walk-in</td><td>' + esc(payLabel(x.method)) + '</td><td>' + num(x.count) + '</td><td>' + esc(money(x.total - (x.returned || 0))) + '</td><td class="dim">' +
        (x.returned ? esc(money(x.returned)) + ' returned' : '\u2014') + '</td><td class="dim">' + (x.voided ? num(x.voided) + ' voided (' + esc(money(x.voidedTotal)) + ')' : '\u2014') + '</td></tr>')
      .concat(d.online.map((x) => '<tr><td>Online shop</td><td>' + esc(payLabel(x.method)) + '</td><td>' + num(x.count) + '</td><td>' + esc(money(x.collected - (x.refunded || 0))) + '</td><td class="dim">' +
        (x.refunded ? esc(money(x.refunded)) + ' refunded' : '\u2014') + '</td><td class="dim">' + [x.awaitingCount ? num(x.awaitingCount) + ' awaiting (' + money(x.awaiting) + ')' : '', x.cancelled ? num(x.cancelled) + ' cancelled' : ''].filter(Boolean).join(' \u00B7 ') + '</td></tr>'));
    const shiftRows = d.shifts.map((x) =>
      '<tr><td>' + esc(x.cashierName || '') + '</td><td class="dim">' + esc(cashWhen(x.openedAt)) + '</td><td class="dim">' + (x.closedAt ? esc(cashWhen(x.closedAt)) : 'Open') + '</td>' +
      '<td>' + esc(money(x.openingCash || 0)) + '</td><td>' + esc(money(x.cashSales || 0)) + '</td><td class="dim">+' + esc(money(x.cashIn || 0)) + ' / -' + esc(money(x.cashOut || 0)) + '</td>' +
      '<td class="dim">' + esc(money(x.cashReturns || 0)) + '</td><td>' + esc(money(x.expectedCash || 0)) + '</td><td>' + (x.closingCash == null ? '\u2014' : esc(money(x.closingCash))) + '</td>' +
      '<td class="' + (x.difference == null ? 'dim' : Math.abs(x.difference) < 0.005 ? 'qty-in' : 'qty-out') + '">' + esc(varText(x)) + '</td></tr>').join('');
    box.innerHTML =
      '<h4 style="margin:14px 0 6px;font-size:14px">Collections by payment method</h4><div class="table-wrapper"><table><thead><tr><th>Channel</th><th>Method</th><th>Paid transactions</th><th>Collected (net)</th><th>Returns / refunds</th><th>Voided / awaiting / cancelled</th></tr></thead><tbody>' +
      (coll.length ? coll.join('') : '<tr><td colspan="6" class="report-note">No POS or online payments in this period.</td></tr>') +
      '</tbody><tfoot>' + (coll.length ? '<tr class="report-foot-row"><td colspan="3">Net collected (POS + online, after returns and refunds)</td><td>' + esc(money(collectedNet(d))) + '</td><td colspan="2"></td></tr>' : '') + '</tfoot></table></div>' +
      '<h4 style="margin:18px 0 6px;font-size:14px">Cash drawer shifts</h4><div class="table-wrapper"><table><thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th>Opening cash</th><th>Cash sales</th><th>Added / removed</th><th>Cash refunds</th><th>Expected</th><th>Counted</th><th>Difference</th></tr></thead><tbody>' +
      (shiftRows || '<tr><td colspan="10" class="report-note">No cash shifts in this period.</td></tr>') + '</tbody><tfoot>' +
      (d.shifts.length ? '<tr class="report-foot-row"><td colspan="7">' + t.shifts + ' shift' + (t.shifts === 1 ? '' : 's') + ' \u00B7 ' + t.needsReview + ' need review \u00B7 short ' + esc(money(Math.abs(t.shortage))) + ' \u00B7 over ' + esc(money(t.overage)) + '</td><td>' + esc(money(t.expectedCash)) + '</td><td>' + esc(money(t.countedCash)) + '</td><td>' + (Math.abs(net) < 0.005 ? 'Balanced' : (net < 0 ? 'Short ' : 'Over ') + esc(money(Math.abs(net)))) + '</td></tr>' : '') + '</tfoot></table></div>';
  }

  function repMovements(range) {
    if (range.invalid) return [];
    return movementCache.filter((m) => m.date && m.date >= range.from && m.date <= range.to);
  }

  /* ---- charts ---- */
  function drawDonut(inv) {
    const box = $('donutChartContainer'), legend = $('donutLegend');
    if (!box || !legend) return;
    const colors = { 'Raw Materials': '#4a90d9', 'Finished Goods': '#43c47a', 'Finishing Supplies': '#e35b9e' };
    const byDept = {};
    inv.forEach((i) => { byDept[i.department] = (byDept[i.department] || 0) + i.onHand * i.unitCost; });
    const names = Object.keys(byDept).filter((k) => byDept[k] > 0);
    const total = names.reduce((t, k) => t + byDept[k], 0);
    if (!total) {
      box.innerHTML = '<div class="rep-chart-empty">No stock value yet.</div>'; legend.innerHTML = ''; return;
    }
    const R = 70, C = 2 * Math.PI * R;
    let off = 0;
    const segs = names.map((k) => {
      const len = byDept[k] / total * C;
      const seg = '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke="' + (colors[k] || '#8fa1b0') + '" stroke-width="30" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 100 100)"/>';
      off += len; return seg;
    }).join('');
    const compact = total >= 1e6 ? '\u20B1' + (total / 1e6).toFixed(2) + 'M' : total >= 1e3 ? '\u20B1' + (total / 1e3).toFixed(1) + 'K' : '\u20B1' + total.toFixed(0);
    box.innerHTML = '<svg viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Stock value by department">' + segs +
      '<text x="100" y="94" text-anchor="middle" class="donut-center-label">TOTAL</text>' +
      '<text x="100" y="116" text-anchor="middle" class="donut-center-value">' + esc(compact) + '</text></svg>';
    legend.innerHTML = names.map((k) =>
      '<div class="donut-legend-row"><div class="donut-legend-left"><span class="donut-legend-dot" style="background:' + (colors[k] || '#8fa1b0') + '"></span>' +
      '<span class="donut-legend-name">' + esc(k) + '</span><span class="donut-legend-pct">' + (byDept[k] / total * 100).toFixed(1) + '%</span></div>' +
      '<div class="donut-legend-value">' + esc(money(byDept[k])) + '</div></div>').join('');
  }

  function trendBuckets(range) {
    const out = [];
    const days = (a, b) => { const r = []; for (let d = a; d <= b; d = addDays(d, 1)) r.push(d); return r; };
    const monthsBetween = (a, b) => { const r = []; for (let d = a.slice(0, 7) + '-01'; d <= b; d = addMonths(d, 1)) r.push(d.slice(0, 7)); return r; };
    if (rep.type === 'yearly' || (rep.type === 'custom' && days(range.from, range.to).length > 45)) {
      monthsBetween(range.from, range.to).slice(0, 36).forEach((m) => out.push({ key: m, label: MON[Number(m.slice(5)) - 1] + (rep.type === 'custom' ? " '" + m.slice(2, 4) : ''), month: true }));
    } else {
      let list;
      if (rep.type === 'daily') list = days(addDays(range.to, -6), range.to);
      else list = days(range.from, range.to);
      list.forEach((d) => {
        const dt = fromIso(d);
        out.push({ key: d, label: rep.type === 'weekly' ? DOW[dt.getDay()] : (rep.type === 'monthly' ? String(dt.getDate()) : MON[dt.getMonth()] + ' ' + dt.getDate()) });
      });
    }
    return out;
  }

  function drawTrend(range, moves) {
    const box = $('scatterChartContainer');
    if (!box) return;
    if (range.invalid) { box.innerHTML = '<div class="rep-chart-empty">Fix the date range to see the chart.</div>'; return; }
    const buckets = trendBuckets(range);
    const all = rep.type === 'daily' ? movementCache.filter((m) => m.date && m.date >= buckets[0].key && m.date <= range.to) : moves;
    const data = buckets.map((b) => ({ b, in: 0, out: 0 }));
    const idx = {}; data.forEach((d, i) => { idx[d.b.key] = i; });
    all.forEach((m) => {
      const k = buckets[0].month ? m.date.slice(0, 7) : m.date;
      if (idx[k] !== undefined) data[idx[k]][m.type] += Number(m.qty) || 0;
    });
    const max = Math.max.apply(null, data.map((d) => Math.max(d.in, d.out)).concat([0]));
    const totIn = data.reduce((t, d) => t + d.in, 0), totOut = data.reduce((t, d) => t + d.out, 0);
    setText('scatterChartSub', 'Stock in vs stock out \u00B7 In ' + num(totIn) + ' \u00B7 Out ' + num(totOut));
    if (!max) { box.innerHTML = '<div class="rep-chart-empty">No stock movement in this period.</div>'; return; }
    const W = 560, H = 230, L = 46, Rm = 8, T = 18, B = 28, iw = W - L - Rm, ih = H - T - B;
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    const top = Math.ceil(max / step) * step;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Stock in versus stock out">';
    for (let g = 0; g <= 4; g++) {
      const y = T + ih - (ih * g / 4), v = top * g / 4;
      svg += '<line class="trend-grid-line" x1="' + L + '" y1="' + y + '" x2="' + (W - Rm) + '" y2="' + y + '"/>' +
        '<text class="trend-axis-label" x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(num(Math.round(v))) + '</text>';
    }
    const slot = iw / data.length, bw = Math.max(2, Math.min(22, slot / 2.6));
    const every = Math.ceil(data.length / 12);
    data.forEach((d, i) => {
      const cx = L + slot * i + slot / 2;
      // a small quantity next to a big one would be a hairline: keep every non-zero bar at least 4 px tall
      const hi = d.in > 0 ? Math.max(4, ih * d.in / top) : 0, ho = d.out > 0 ? Math.max(4, ih * d.out / top) : 0;
      const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n * 10) / 10));
      svg += '<rect class="trend-bar-in" x="' + (cx - bw - 1) + '" y="' + (T + ih - hi) + '" width="' + bw + '" height="' + hi + '" rx="2"><title>' + esc(d.b.label + ': in ' + num(d.in)) + '</title></rect>' +
        '<rect class="trend-bar-out" x="' + (cx + 1) + '" y="' + (T + ih - ho) + '" width="' + bw + '" height="' + ho + '" rx="2"><title>' + esc(d.b.label + ': out ' + num(d.out)) + '</title></rect>';
      if (data.length <= 10) {
        if (d.in > 0) svg += '<text class="trend-axis-label" x="' + (cx - bw / 2 - 1) + '" y="' + (T + ih - hi - 3) + '" text-anchor="middle" font-size="9">' + esc(short(d.in)) + '</text>';
        if (d.out > 0) svg += '<text class="trend-axis-label" x="' + (cx + bw / 2 + 1) + '" y="' + (T + ih - ho - 3) + '" text-anchor="middle" font-size="9">' + esc(short(d.out)) + '</text>';
      }
      if (i % every === 0) svg += '<text class="trend-axis-label" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d.b.label) + '</text>';
    });
    box.innerHTML = svg + '</svg>';
  }

  /* ---- tables ---- */
  function renderReports() {
    if (!$('reports')) return;
    const range = repRange();
    const moves = repMovements(range);
    const inv = inventoryCache;
    const catOf = {};
    (typeof productCatalogData !== 'undefined' ? productCatalogData : []).forEach((p) => { catOf[p.sku] = p.category; });

    // period panel
    const pill = $('dateShowingPill');
    if (pill && rep.type !== 'custom') pill.textContent = 'Showing ' + range.label;
    document.querySelectorAll('#reportPeriodToggle .period-btn').forEach((b) => b.classList.toggle('active', b.dataset.period === rep.type));
    const nav = $('dateNavRow'), cust = $('customRangeRow');
    if (nav) nav.style.display = rep.type === 'custom' ? 'none' : 'flex';
    if (cust) cust.style.display = rep.type === 'custom' ? 'flex' : 'none';

    // stat cards
    const stockValue = inv.reduce((t, i) => t + i.onHand * i.unitCost, 0);
    const low = inv.filter((i) => typeof getStockStatus === 'function' && getStockStatus(i) === 'low').length;
    setText('repSkusInReport', num(inv.length));
    setText('repStockValue', money(stockValue));
    setText('repMovementsInPeriod', num(moves.length));
    const sales = repSales(range);
    const saleRevenue = sales.reduce((t, r) => t + r.revenue, 0), saleProfit = sumProfit(sales);
    const saleCount = new Set(sales.map((r) => r.ref)).size;
    setText('repSalesInPeriod', num(saleCount));
    setText('repSalesRevenue', money(saleRevenue));
    setText('repSalesProfit', money(saleProfit));
    setText('repLowStockAlerts', num(low));

    drawDonut(inv);
    drawTrend(range, moves);

    // stock value detail
    setText('stockDetailSub', inv.length + ' SKUs \u00B7 ' + money(stockValue) + ' total \u00B7 live snapshot');
    const sBody = $('stockValueDetailBody'), sFoot = $('stockValueDetailFoot');
    if (sBody) {
      const rows = inv.slice().sort((a, b) => b.onHand * b.unitCost - a.onHand * a.unitCost);
      sBody.innerHTML = rows.length ? rows.map((i) => {
        const isLow = typeof getStockStatus === 'function' && getStockStatus(i) === 'low';
        return '<tr><td class="mono">' + esc(i.sku) + '</td><td>' + esc(i.name) + '</td><td class="dim">' + esc(catOf[i.sku] || i.department) + '</td>' +
          '<td class="dim' + (isLow ? ' low-cell' : '') + '">' + esc(num(i.onHand)) + ' ' + esc(i.unit) + '</td>' +
          '<td class="dim">' + esc(num(i.reorderLevel)) + ' ' + esc(i.unit) + '</td><td class="dim">' + esc(money(i.unitCost)) + '</td>' +
          '<td>' + esc(money(i.onHand * i.unitCost)) + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="report-note">No products yet.</td></tr>';
      if (sFoot) sFoot.innerHTML = rows.length ? '<tr class="report-foot-row"><td colspan="6">Total stock value</td><td>' + esc(money(stockValue)) + '</td></tr>' : '';
    }

    // movement report
    const inCount = moves.filter((m) => m.type === 'in').length, outCount = moves.length - inCount;
    setText('reportMovementSub', range.invalid ? 'Start date must be on or before the end date' : range.label + ' \u00B7 ' + moves.length + ' movement' + (moves.length === 1 ? '' : 's'));
    const mBody = $('reportMovementBody'), mFoot = $('reportMovementFoot');
    if (mBody) {
      mBody.innerHTML = moves.length ? moves.map((m) => {
        const isIn = m.type === 'in';
        return '<tr><td class="mono">' + esc(m.ref) + '</td><td class="dim">' + esc(niceDate(m.date)) + '</td><td>' + esc(m.product) + '</td>' +
          '<td><span class="status-pill ' + (isIn ? 'in' : 'out') + '">' + (isIn ? 'In' : 'Out') + '</span></td>' +
          '<td class="dim">' + esc(m.reason || '') + '</td>' +
          '<td class="' + (isIn ? 'qty-in' : 'qty-out') + '">' + (isIn ? '+' : '-') + esc(num(m.qty)) + ' ' + esc(m.unit) + '</td>' +
          '<td class="dim">' + esc(m.department) + '</td><td class="dim">' + esc(m.handledBy) + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="report-note">' + (range.invalid ? 'Fix the date range above.' : 'No stock movements in this period. Try another date, or use \u201CJump to latest activity\u201D.') + '</td></tr>';
      if (mFoot) mFoot.innerHTML = moves.length ? '<tr class="report-foot-row"><td colspan="8">' + moves.length + ' movements \u00B7 ' + inCount + ' stock in \u00B7 ' + outCount + ' stock out</td></tr>' : '';
    }

    // sales transaction report (POS walk-in + online shop)
    setText('reportSalesSub', range.invalid ? 'Start date must be on or before the end date'
      : range.label + ' \u00B7 ' + saleCount + ' transaction' + (saleCount === 1 ? '' : 's') + ' \u00B7 revenue ' + money(saleRevenue) + ' \u00B7 profit ' + money(saleProfit));
    const slBody = $('reportSalesBody'), slFoot = $('reportSalesFoot');
    if (slBody) {
      slBody.innerHTML = sales.length ? sales.map((r) =>
        '<tr><td class="mono">' + esc(r.ref) + '<div class="dim" style="font-size:12px">' + srcLabel(r.source) + '</div></td>' +
        '<td class="dim">' + esc(niceDate(r.date)) + '</td><td>' + esc(r.product) + '</td>' +
        '<td>' + esc(num(r.qty)) + ' ' + esc(r.unit || '') + '</td><td class="dim">' + esc(money(r.price)) + '</td>' +
        '<td>' + esc(money(r.revenue)) + '</td><td class="' + (r.profit == null ? 'dim' : r.profit < 0 ? 'qty-out' : 'qty-in') + '">' + (r.profit == null ? '\u2014' : esc(money(r.profit))) + '</td>' +
        '<td class="dim">' + esc(r.customer) + '</td><td class="dim">' + esc(payLabel(r.method)) + '</td><td class="dim">' + esc(r.handledBy) + '</td></tr>').join('')
        : '<tr><td colspan="10" class="report-note">' + (range.invalid ? 'Fix the date range above.' : 'No sales in this period. Voided, cancelled, unconfirmed and refunded sales are not counted.') + '</td></tr>';
    }
    if (slFoot) slFoot.innerHTML = sales.length ? '<tr class="report-foot-row"><td colspan="5">' + saleCount + ' transaction' + (saleCount === 1 ? '' : 's') + ' \u00B7 ' + sales.length + ' line' + (sales.length === 1 ? '' : 's') +
      ' \u00B7 product sales and quote payments received (delivery fees not included; profit is not tracked on custom quotes)</td><td>' + esc(money(saleRevenue)) + '</td><td>' + esc(money(saleProfit)) + '</td><td colspan="3"></td></tr>' : '';

    // cash shifts + collections for the same period (loaded on demand while Reports is open)
    renderCashPanel(range);
    if (reportsOpen()) ensureCash(range);
  }

  /* ---- CSV export ---- */
  function csvCell(v, isText) {
    let t = v == null ? '' : String(v);
    if (isText && /^[=+\-@\t\r]/.test(t)) t = "'" + t;        // stop spreadsheet formula injection
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  async function exportReportCsv() {
    const range = repRange();
    if (range.invalid) { toast('Fix the date range before exporting', 'error'); return; }
    await ensureCash(range);
    const cash = cashFor(range);
    const moves = repMovements(range);
    const row = (arr) => arr.map((c) => (c && c.t !== undefined ? csvCell(c.t, true) : csvCell(c, false))).join(',');
    const T = (v) => ({ t: v });
    const catOf = {};
    (typeof productCatalogData !== 'undefined' ? productCatalogData : []).forEach((p) => { catOf[p.sku] = p.category; });
    const lines = [
      row([T('Triple E Metal Products \u2013 Inventory report')]),
      row([T('Period'), T(range.label)]),
      row([T('Generated'), new Date().toLocaleString('en-PH')]),
      '',
      row([T('STOCK VALUE (live snapshot)')]),
      row(['SKU', 'Product', 'Category', 'On hand', 'Unit', 'Reorder level', 'Unit cost', 'Value'])
    ];
    let total = 0;
    inventoryCache.forEach((i) => {
      const v = i.onHand * i.unitCost; total += v;
      lines.push(row([T(i.sku), T(i.name), T(catOf[i.sku] || i.department), i.onHand, T(i.unit), i.reorderLevel, i.unitCost, v.toFixed(2)]));
    });
    lines.push(row(['', '', '', '', '', '', 'Total', total.toFixed(2)]), '', row([T('STOCK MOVEMENTS IN PERIOD')]),
      row(['Ref', 'Date', 'Product', 'Type', 'Reason', 'Quantity', 'Unit', 'Department', 'Handled by']));
    moves.forEach((m) => lines.push(row([T(m.ref), m.date, T(m.product), m.type === 'in' ? 'In' : 'Out', T(m.reason || ''),
      (m.type === 'in' ? '' : '-') + m.qty, T(m.unit), T(m.department), T(m.handledBy)])));
    lines.push('', row([T('SALES TRANSACTIONS IN PERIOD (POS + online + custom quote payments, excludes voided / cancelled / unconfirmed / refunded)')]),
      row(['Sales ref', 'Source', 'Date', 'Product', 'Quantity', 'Unit', 'Unit price', 'Revenue', 'Profit', 'Customer', 'Payment', 'Handled by']));
    repSales(range).forEach((r) => lines.push(row([T(r.ref), T(srcLabel(r.source)), r.date, T(r.product), r.qty, T(r.unit || ''),
      r.price.toFixed(2), r.revenue.toFixed(2), r.profit == null ? '' : r.profit.toFixed(2), T(r.customer), T(payLabel(r.method)), T(r.handledBy)])));
    if (cash) {
      lines.push('', row([T('COLLECTIONS BY PAYMENT METHOD')]), row(['Channel', 'Method', 'Paid transactions', 'Collected (net)', 'Returned / refunded', 'Voided or cancelled', 'Awaiting payment']));
      cash.pos.forEach((x) => lines.push(row([T('POS walk-in'), T(payLabel(x.method)), x.count, (x.total - (x.returned || 0)).toFixed(2), (x.returned || 0).toFixed(2), x.voided || 0, ''])));
      cash.online.forEach((x) => lines.push(row([T('Online shop'), T(payLabel(x.method)), x.count, (x.collected - (x.refunded || 0)).toFixed(2), (x.refunded || 0).toFixed(2), x.cancelled || 0, (x.awaiting || 0).toFixed(2)])));
      lines.push(row(['', '', '', collectedNet(cash).toFixed(2), '', '', '']), '', row([T('CASH SHIFTS IN PERIOD')]),
        row(['Shift', 'Cashier', 'Opened', 'Closed', 'Opening cash', 'Cash sales', 'Cash added', 'Cash removed', 'Cash refunds', 'Expected', 'Counted', 'Difference', 'Cashier note']));
      cash.shifts.forEach((x) => lines.push(row([T(x.id), T(x.cashierName || ''), T(cashWhen(x.openedAt)), T(x.closedAt ? cashWhen(x.closedAt) : 'Open'), x.openingCash || 0, x.cashSales || 0, x.cashIn || 0, x.cashOut || 0,
        x.cashReturns || 0, x.expectedCash || 0, x.closingCash == null ? '' : x.closingCash, x.difference == null ? '' : x.difference, T(x.closingNote || '')])));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'triple-e-report-' + range.from + (range.to !== range.from ? '_to_' + range.to : '') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Report exported');
  }

  function setupReports() {
    if (!$('reports')) return;
    // re-read sales each time Reports is opened, so orders confirmed or sold a moment ago are included
    document.querySelectorAll('.nav-item[data-page="reports"]').forEach((n) => n.addEventListener('click', () => {
      Promise.all([api('/sales'), api('/finance/quotes').catch(() => null)]).then(([r, q]) => { salesCache = (r && r.sales) || []; if (Array.isArray(q)) quotesCache = q; updateOrderStats(); renderReports(); }).catch((e) => console.warn('[api-bridge] /sales failed: ' + e.message));
    }));
    // sensible defaults for the custom range: the last 7 days
    rep.to = iso(new Date()); rep.from = addDays(rep.to, -6);
    if ($('reportFromDate')) $('reportFromDate').value = rep.from;
    if ($('reportToDate')) $('reportToDate').value = rep.to;
    loadRepPrefs();
    try { reportPeriodType = rep.type; } catch (e) { /* keep script.js's own report panel on the same period */ }
    if ($('reportFromDate')) $('reportFromDate').value = rep.from;
    if ($('reportToDate')) $('reportToDate').value = rep.to;
    try { reportAnchorDate = rep.anchor; } catch (e) { /* ignore */ }

    document.querySelectorAll('#reportPeriodToggle .period-btn').forEach((b) =>
      b.addEventListener('click', () => { rep.type = b.dataset.period; saveRepPrefs(); renderReports(); }));

    const stop = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); fn(); }, true); };
    stop('datePrevBtn', () => { repStep(-1); renderReports(); });
    stop('dateNextBtn', () => { repStep(1); renderReports(); });
    stop('jumpLatestLink', () => {
      const latest = movementCache.length ? movementCache.map((m) => m.date).filter(Boolean).sort().pop() : null;
      rep.anchor = latest || iso(new Date()); renderReports();
    });
    stop('exportCsvBtn', exportReportCsv);
    stop('printReportBtn', () => {
      toast('Tip: in the print window, switch off \u201CHeaders and footers\u201D for a clean document. Choose \u201CSave as PDF\u201D to keep a copy.');
      ensureCash(repRange()).then(() => setTimeout(() => window.print(), 350));
    });

    const onRange = () => {
      rep.from = $('reportFromDate').value; rep.to = $('reportToDate').value;
      const bad = rep.from && rep.to && rep.from > rep.to;
      showLive('reportToDate', bad ? 'End date must be on or after the start date' : '');
      saveRepPrefs();
      renderReports();
    };
    ['reportFromDate', 'reportToDate'].forEach((id) => { const el = $(id); if (el) { el.addEventListener('change', onRange); el.addEventListener('input', onRange); } });
  }

  /* =====================================================
     BURGER MENU
     - phones / tablets (<= 1024px): opens a slide-in drawer with a dimmed backdrop
     - laptops / desktops: the sidebar is always visible, so the burger is hidden
  ===================================================== */
  const DRAWER_MQ = '(max-width: 1024px)';
  const isDrawer = () => window.matchMedia(DRAWER_MQ).matches;

  function setupBurger() {
    const burger = $('burgerBtn'), side = $('sidebar'), back = $('sidebarBackdrop'), close = $('sidebarClose');
    if (!burger || !side) return;

    const setOpen = (open) => {
      side.classList.toggle('open', open);
      document.body.classList.toggle('nav-open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (open) { const first = side.querySelector('.nav-item.active') || side.querySelector('.nav-item'); first && first.focus && first.focus({ preventScroll: true }); }
    };
    const sync = () => {                                  // phones / tablets: drawer. laptops / desktops: sidebar always visible, no burger
      document.body.classList.remove('sidebar-collapsed');
      try { localStorage.removeItem('tripleE.sidebarCollapsed'); } catch (e) { /* ignore */ }
      side.classList.remove('open'); document.body.classList.remove('nav-open');
      setOpen(false);
    };

    burger.addEventListener('click', () => {
      if (isDrawer()) setOpen(!side.classList.contains('open'));
    });
    if (back) back.addEventListener('click', () => setOpen(false));
    if (close) close.addEventListener('click', () => { setOpen(false); burger.focus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && side.classList.contains('open')) { setOpen(false); burger.focus(); } });
    // choosing a page closes the drawer on phones / tablets
    side.addEventListener('click', (e) => { if (isDrawer() && e.target.closest('.nav-item')) setOpen(false); });
    const mq = window.matchMedia(DRAWER_MQ);
    (mq.addEventListener ? mq.addEventListener('change', sync) : mq.addListener(sync));
    sync();

    // show the current page name next to the burger
    const title = $('topbarTitle');
    const updateTitle = () => {
      const active = side.querySelector('.nav-item.active');
      if (title && active) title.textContent = (typeof window.sidebarLabelOf === 'function') ? window.sidebarLabelOf(active) : active.textContent.replace(/\s+/g, ' ').trim();
    };
    side.querySelectorAll('.nav-item').forEach((n) => new MutationObserver(updateTitle).observe(n, { attributes: true, attributeFilter: ['class'] }));
    updateTitle();
  }

  /* =====================================================
     STOP BROWSER AUTOFILL FROM FILLING SEARCH / FILTER BOXES (e.g. your email in the audit search)
  ===================================================== */
  function setupAutofillGuard() {
    const boxes = Array.from(document.querySelectorAll('input.inv-search, input[type="text"], input[type="email"], input[type="search"], textarea'))
      .filter((el) => !el.closest('.otp-row'));
    boxes.forEach((el) => {
      el.setAttribute('autocomplete', 'off');
      if (!el.name) el.name = 'f_' + (el.id || Math.random().toString(36).slice(2, 8));
      const typed = () => { el.dataset.userTyped = '1'; };
      el.addEventListener('keydown', typed); el.addEventListener('paste', typed); el.addEventListener('drop', typed);
    });
    const filters = Array.from(document.querySelectorAll('input.inv-search'));
    const purge = () => filters.forEach((el) => {
      if (el.value && !el.dataset.userTyped) {            // value the user never typed = autofill
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    [0, 150, 500, 1200, 2500].forEach((ms) => setTimeout(purge, ms));
  }

  /* =====================================================
     FORMAL PRINTED REPORT  (business document: letterhead, numbered sections, sign-off block)
  ===================================================== */
  const PERIOD_NAMES = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', custom: 'Custom range' };

  function buildPrintReport() {
    const range = repRange();
    const moves = repMovements(range);
    const inv = inventoryCache.slice();
    const catOf = {};
    (typeof productCatalogData !== 'undefined' ? productCatalogData : []).forEach((p) => { catOf[p.sku] = p.category; });
    const now = new Date();
    const stamp = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) + ', ' +
      now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    const refNo = 'IR-' + range.from.replace(/-/g, '') + (range.to !== range.from ? '-' + range.to.replace(/-/g, '') : '') + '-' + pad(now.getHours()) + pad(now.getMinutes());
    const who = currentUser && currentUser.name ? currentUser.name : '';
    const whoRole = currentUser && currentUser.roleLabel ? currentUser.roleLabel : '';
    const totalValue = inv.reduce((t, i) => t + i.onHand * i.unitCost, 0);
    const lowItems = inv.filter((i) => typeof getStockStatus === 'function' && getStockStatus(i) === 'low')
      .sort((a, b) => (a.onHand - a.reorderLevel) - (b.onHand - b.reorderLevel));
    const ins = moves.filter((m) => m.type === 'in'), outs = moves.filter((m) => m.type === 'out');
    const sumQty = (arr) => arr.reduce((t, m) => t + (Number(m.qty) || 0), 0);
    const cash = cashFor(range);
    const salesRows = repSales(range);
    const salesRev = salesRows.reduce((t, r) => t + r.revenue, 0), salesProf = sumProfit(salesRows);
    const salesTxn = new Set(salesRows.map((r) => r.ref)).size;
    const bySrc = {}; salesRows.forEach((r) => { const b = bySrc[r.source] || (bySrc[r.source] = { refs: new Set(), rev: 0 }); b.refs.add(r.ref); b.rev += r.revenue; });
    const salesBody = salesRows.map((r) =>
      '<tr><td>' + esc(r.ref) + '</td><td>' + esc(srcLabel(r.source)) + '</td><td>' + esc(niceDate(r.date)) + '</td><td>' + esc(r.product) +
      '</td><td class="r">' + esc(num(r.qty)) + (r.unit ? ' ' + esc(r.unit) : '') + '</td><td class="r">' + esc(money(r.revenue)) + '</td><td class="r">' +
      (r.profit == null ? '&mdash;' : esc(money(r.profit))) + '</td><td>' + esc(r.customer) + '</td><td>' + esc(payLabel(r.method)) + '</td></tr>').join('');

    const byDept = {};
    inv.forEach((i) => {
      const d = byDept[i.department] || (byDept[i.department] = { skus: 0, value: 0 });
      d.skus += 1; d.value += i.onHand * i.unitCost;
    });
    const deptRows = DEPARTMENTS.filter((d) => byDept[d]).map((d) =>
      '<tr><td>' + esc(d) + '</td><td class="r">' + byDept[d].skus + '</td><td class="r">' + esc(money(byDept[d].value)) +
      '</td><td class="r">' + (totalValue ? (byDept[d].value / totalValue * 100).toFixed(1) : '0.0') + '%</td></tr>').join('');

    const lowRows = lowItems.map((i) =>
      '<tr><td>' + esc(i.sku) + '</td><td>' + esc(i.name) + '</td><td class="r">' + esc(num(i.onHand)) + ' ' + esc(i.unit) +
      '</td><td class="r">' + esc(num(i.reorderLevel)) + ' ' + esc(i.unit) + '</td><td class="r">' + esc(num(Math.max(0, i.reorderLevel - i.onHand))) + ' ' + esc(i.unit) + '</td></tr>').join('');

    const stockRows = inv.slice().sort((a, b) => (a.department + a.name).localeCompare(b.department + b.name)).map((i) =>
      '<tr><td>' + esc(i.sku) + '</td><td>' + esc(i.name) + '</td><td>' + esc(catOf[i.sku] || i.department) +
      '</td><td class="r">' + esc(num(i.onHand)) + ' ' + esc(i.unit) + '</td><td class="r">' + esc(num(i.reorderLevel)) +
      '</td><td class="r">' + esc(money(i.unitCost)) + '</td><td class="r">' + esc(money(i.onHand * i.unitCost)) + '</td></tr>').join('');

    const moveRows = moves.map((m) =>
      '<tr><td>' + esc(m.ref) + '</td><td>' + esc(niceDate(m.date)) + '</td><td>' + esc(m.product) + '</td><td>' + (m.type === 'in' ? 'In' : 'Out') +
      '</td><td>' + esc(m.reason || '') + '</td><td class="r">' + (m.type === 'in' ? '+' : '-') + esc(num(m.qty)) + ' ' + esc(m.unit) +
      '</td><td>' + esc(m.handledBy) + '</td></tr>').join('');

    const kv = (k, v) => '<tr><th scope="row">' + esc(k) + '</th><td class="r">' + v + '</td></tr>';
    const table = (cls, head, body, foot) =>
      '<table class="pd-table ' + cls + '"><thead><tr>' + head.map((h) => '<th' + (h[1] ? ' class="r"' : '') + '>' + esc(h[0]) + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody>' + (foot ? '<tfoot>' + foot + '</tfoot>' : '') + '</table>';
    const empty = (text) => '<p class="pd-empty">' + esc(text) + '</p>';

    return '' +
      '<div class="pd-letterhead"><div class="pd-brand"><div class="pd-mono">TE</div><div>' +
        '<div class="pd-company">TRIPLE E METAL PRODUCTS</div><div class="pd-dept">Finance &amp; Inventory Department</div></div></div>' +
        '<table class="pd-meta"><tr><th>Report No.</th><td>' + esc(refNo) + '</td></tr><tr><th>Date issued</th><td>' + esc(stamp) + '</td></tr>' +
        '<tr><th>Classification</th><td>Confidential</td></tr></table></div>' +
      '<div class="pd-title"><h1>Inventory &amp; Sales Report</h1>' +
        '<p>' + esc(PERIOD_NAMES[rep.type] || 'Report') + ' report &middot; Period covered: <strong>' + esc(range.label) + '</strong></p></div>' +

      '<h2><span>1.</span> Summary</h2>' +
      '<table class="pd-kv">' +
        kv('Active SKUs on record', esc(num(inv.length))) +
        kv('Total stock value (at cost, as of ' + esc(niceDate(iso(now))) + ')', esc(money(totalValue))) +
        kv('Stock movements in period', esc(num(moves.length)) + ' (' + ins.length + ' in / ' + outs.length + ' out)') +
        kv('Quantity received in period', esc(num(sumQty(ins)))) +
        kv('Quantity issued in period', esc(num(sumQty(outs)))) +
        kv('Items at or below reorder level', esc(num(lowItems.length))) +
        kv('Sales transactions in period', esc(num(salesTxn)) + (Object.keys(bySrc).length ? ' (' + Object.keys(bySrc).map((k) => bySrc[k].refs.size + ' ' + srcLabel(k).toLowerCase()).join(' / ') + ')' : '')) +
        kv('Sales revenue in period', esc(money(salesRev))) +
        kv('Sales profit in period', esc(money(salesProf))) +
        (cash ? kv('Net collected (POS + online, after returns and refunds)', esc(money(collectedNet(cash)))) +
          kv('Cash drawer shifts in period', esc(num(cash.totals.shifts)) + (cash.totals.open ? ' (' + cash.totals.open + ' still open)' : '')) +
          kv('Cash variance (counted vs expected)', Math.abs(cash.totals.shortage + cash.totals.overage) < 0.005 ? 'None' : esc(money(Math.abs(cash.totals.shortage + cash.totals.overage))) + (cash.totals.shortage + cash.totals.overage < 0 ? ' short' : ' over')) : '') +
      '</table>' +

      '<h2><span>2.</span> Stock Value by Department</h2>' +
      (deptRows ? table('pd-dept-t', [['Department'], ['SKUs', 1], ['Stock value', 1], ['Share', 1]], deptRows,
        '<tr><td>Total</td><td class="r">' + inv.length + '</td><td class="r">' + esc(money(totalValue)) + '</td><td class="r">100.0%</td></tr>') : empty('No stock on record.')) +

      '<h2><span>3.</span> Items Requiring Reorder</h2>' +
      (lowRows ? table('', [['SKU'], ['Product'], ['On hand', 1], ['Reorder level', 1], ['Shortfall', 1]], lowRows) : empty('No items are at or below their reorder level.')) +

      '<h2><span>4.</span> Stock Value Detail</h2>' +
      (stockRows ? table('pd-small', [['SKU'], ['Product'], ['Category'], ['On hand', 1], ['Reorder', 1], ['Unit cost', 1], ['Value', 1]], stockRows,
        '<tr><td colspan="6">Total stock value</td><td class="r">' + esc(money(totalValue)) + '</td></tr>') : empty('No products on record.')) +

      '<h2><span>5.</span> Stock Movements</h2>' +
      (range.invalid ? empty('The selected date range is invalid (start date is after the end date).') :
        moveRows ? table('pd-small', [['Reference'], ['Date'], ['Product'], ['Type'], ['Reason'], ['Quantity', 1], ['Handled by']], moveRows,
          '<tr><td colspan="7">' + moves.length + ' movements &middot; ' + ins.length + ' stock in (' + esc(num(sumQty(ins))) + ' units) &middot; ' +
          outs.length + ' stock out (' + esc(num(sumQty(outs))) + ' units)</td></tr>') :
        empty('No stock movements were recorded during this period.')) +

      '<h2><span>6.</span> Sales Transactions</h2>' +
      (range.invalid ? empty('The selected date range is invalid (start date is after the end date).') :
        salesBody ? table('pd-small', [['Reference'], ['Source'], ['Date'], ['Product'], ['Qty', 1], ['Revenue', 1], ['Profit', 1], ['Customer'], ['Payment']], salesBody,
          '<tr><td colspan="5">' + salesTxn + ' transaction' + (salesTxn === 1 ? '' : 's') + ' &middot; ' + salesRows.length + ' line' + (salesRows.length === 1 ? '' : 's') +
          ' &middot; POS, online shop and custom quote payments (voided, cancelled, unconfirmed and refunded sales excluded; delivery fees not included)</td><td class="r">' +
          esc(money(salesRev)) + '</td><td class="r">' + esc(money(salesProf)) + '</td><td colspan="2"></td></tr>') :
        empty('No sales transactions were recorded during this period.')) +

      '<h2><span>7.</span> Cash Shifts &amp; Collections</h2>' +
      (range.invalid ? empty('The selected date range is invalid (start date is after the end date).') : !cash ? empty('Cash shift data could not be loaded. Close this preview and print again.') : (
        '<p class="pd-sub">Collections by payment method</p>' +
        ((cash.pos.length || cash.online.length) ? table('pd-small', [['Channel'], ['Method'], ['Paid', 1], ['Collected (net)', 1], ['Returns / refunds', 1], ['Voided / awaiting / cancelled']],
          cash.pos.map((x) => '<tr><td>POS walk-in</td><td>' + esc(payLabel(x.method)) + '</td><td class="r">' + esc(num(x.count)) + '</td><td class="r">' + esc(money(x.total - (x.returned || 0))) + '</td><td class="r">' + (x.returned ? esc(money(x.returned)) : '&mdash;') + '</td><td>' + (x.voided ? esc(num(x.voided)) + ' voided' : '&mdash;') + '</td></tr>').join('') +
          cash.online.map((x) => '<tr><td>Online shop</td><td>' + esc(payLabel(x.method)) + '</td><td class="r">' + esc(num(x.count)) + '</td><td class="r">' + esc(money(x.collected - (x.refunded || 0))) + '</td><td class="r">' + (x.refunded ? esc(money(x.refunded)) : '&mdash;') + '</td><td>' + ([x.awaitingCount ? esc(num(x.awaitingCount)) + ' awaiting (' + esc(money(x.awaiting)) + ')' : '', x.cancelled ? esc(num(x.cancelled)) + ' cancelled' : ''].filter(Boolean).join(', ') || '&mdash;') + '</td></tr>').join(''),
          '<tr><td colspan="3">Net collected</td><td class="r">' + esc(money(collectedNet(cash))) + '</td><td colspan="2"></td></tr>') : empty('No POS or online payments in this period.')) +
        '<p class="pd-sub">Cash drawer shifts</p>' +
        (cash.shifts.length ? table('pd-small', [['Cashier'], ['Opened'], ['Closed'], ['Opening', 1], ['Cash sales', 1], ['Added / removed', 1], ['Refunds', 1], ['Expected', 1], ['Counted', 1], ['Difference', 1]],
          cash.shifts.map((x) => '<tr><td>' + esc(x.cashierName || '') + '</td><td>' + esc(cashWhen(x.openedAt)) + '</td><td>' + (x.closedAt ? esc(cashWhen(x.closedAt)) : 'Open') + '</td><td class="r">' + esc(money(x.openingCash || 0)) + '</td><td class="r">' + esc(money(x.cashSales || 0)) + '</td><td class="r">+' + esc(money(x.cashIn || 0)) + ' / -' + esc(money(x.cashOut || 0)) + '</td><td class="r">' + esc(money(x.cashReturns || 0)) + '</td><td class="r">' + esc(money(x.expectedCash || 0)) + '</td><td class="r">' + (x.closingCash == null ? '&mdash;' : esc(money(x.closingCash))) + '</td><td class="r">' + esc(varText(x)) + '</td></tr>').join(''),
          '<tr><td colspan="7">' + cash.totals.shifts + ' shift' + (cash.totals.shifts === 1 ? '' : 's') + ' &middot; ' + cash.totals.needsReview + ' need review</td><td class="r">' + esc(money(cash.totals.expectedCash)) + '</td><td class="r">' + esc(money(cash.totals.countedCash)) + '</td><td class="r">' + esc(money(Math.abs(cash.totals.shortage + cash.totals.overage))) + '</td></tr>') : empty('No cash shifts were opened during this period.'))
      )) +

      '<div class="pd-sign"><div class="pd-sign-title">Authorisation</div><div class="pd-sign-row">' +
        '<div><div class="pd-line"></div><strong>Prepared by</strong><br>' + esc(who) + (whoRole ? '<br><span>' + esc(whoRole) + '</span>' : '') + '<br><span>Date: ____________</span></div>' +
        '<div><div class="pd-line"></div><strong>Reviewed by</strong><br>&nbsp;<br><span>Date: ____________</span></div>' +
        '<div><div class="pd-line"></div><strong>Approved by</strong><br>&nbsp;<br><span>Date: ____________</span></div>' +
      '</div></div>' +
      '<p class="pd-end">&mdash; End of report &mdash;</p>';
  }

  function mountPrintReport() {
    unmountPrintReport();
    const doc = document.createElement('div');
    doc.id = 'printReport';
    doc.setAttribute('aria-hidden', 'true');
    doc.innerHTML = buildPrintReport();
    document.body.appendChild(doc);
    document.body.classList.add('printing-report');
  }
  function unmountPrintReport() {
    const old = $('printReport'); if (old) old.remove();
    document.body.classList.remove('printing-report');
  }
  const reportPageActive = () => { const r = $('reports'); return !!r && r.classList.contains('active-page'); };

  function setupFormalPrint() {
    window.addEventListener('beforeprint', () => { if (reportPageActive()) { try { mountPrintReport(); } catch (e) { console.warn('[api-bridge] print', e); } } });
    window.addEventListener('afterprint', unmountPrintReport);
  }

  /* =====================================================
     TABLE PAGING  (10 rows per page, with < > arrows)
     - works on every table in the app; tables with 10 rows or fewer show no pager
     - stays on the same page when the data refreshes by itself
     - goes back to page 1 when you search, filter, sort or change the period
  ===================================================== */
  const PAGE_SIZE = 10;
  const ICON_PREV = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const ICON_NEXT = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  function pageList(cur, total) {                          // 1 … 4 5 6 … 12
    const keep = new Set([1, total, cur - 1, cur, cur + 1]);
    if (cur <= 3) { keep.add(2); keep.add(3); keep.add(4); }
    if (cur >= total - 2) { keep.add(total - 1); keep.add(total - 2); keep.add(total - 3); }
    const nums = [...keep].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const out = [];
    nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push('gap'); out.push(n); });
    return out;
  }

  function setupPagers() {
    const pagers = [];

    document.querySelectorAll('.table-wrapper table').forEach((table) => {
      const body = table.tBodies[0];
      if (!body || table.closest('#printReport')) return;
      const wrap = table.closest('.table-wrapper');
      const bar = document.createElement('div');
      bar.className = 'pager';
      bar.setAttribute('role', 'navigation');
      bar.setAttribute('aria-label', 'Table pages');
      bar.hidden = true;
      wrap.insertAdjacentElement('afterend', bar);
      const st = { body, bar, wrap, page: 1, reset: false, scope: table.closest('.page, .modal-overlay') };
      pagers.push(st);

      const render = () => {
        const rows = Array.from(body.rows);
        const total = rows.length;
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (st.reset) st.page = 1;
        st.page = Math.min(Math.max(st.page, 1), pages);
        const from = (st.page - 1) * PAGE_SIZE, to = from + PAGE_SIZE;
        rows.forEach((r, i) => r.classList.toggle('pg-hide', pages > 1 && (i < from || i >= to)));
        if (pages <= 1) { bar.hidden = true; bar.innerHTML = ''; return; }

        const nums = pageList(st.page, pages).map((n) => n === 'gap'
          ? '<span class="pager-gap" aria-hidden="true">&hellip;</span>'
          : '<button type="button" class="pager-btn pager-num' + (n === st.page ? ' active' : '') + '" data-page="' + n + '"' +
            (n === st.page ? ' aria-current="page"' : '') + ' aria-label="Page ' + n + '">' + n + '</button>').join('');
        bar.innerHTML =
          '<span class="pager-info">Showing <strong>' + (from + 1) + '&ndash;' + Math.min(to, total) + '</strong> of <strong>' + total + '</strong></span>' +
          '<div class="pager-ctrl">' +
            '<button type="button" class="pager-btn pager-arrow" data-dir="-1" aria-label="Previous page"' + (st.page === 1 ? ' disabled' : '') + '>' + ICON_PREV + '</button>' +
            '<span class="pager-nums">' + nums + '</span>' +
            '<span class="pager-count">Page ' + st.page + ' of ' + pages + '</span>' +
            '<button type="button" class="pager-btn pager-arrow" data-dir="1" aria-label="Next page"' + (st.page === pages ? ' disabled' : '') + '>' + ICON_NEXT + '</button>' +
          '</div>';
        bar.hidden = false;
      };
      st.render = render;

      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('.pager-btn');
        if (!btn || btn.disabled) return;
        st.page = btn.dataset.page ? Number(btn.dataset.page) : st.page + Number(btn.dataset.dir);
        render();
        const keep = btn.dataset.page ? '.pager-num[data-page="' + st.page + '"]' : '.pager-arrow[data-dir="' + btn.dataset.dir + '"]';
        const again = bar.querySelector(keep) || bar.querySelector('.pager-num.active');
        if (again && !again.disabled) again.focus({ preventScroll: true });
      });

      new MutationObserver(render).observe(body, { childList: true });   // the page redraws the rows -> page them again
      render();
    });

    // searching / filtering / sorting inside a page sends its tables back to page 1
    const back = (e) => {
      if (e.target.closest && e.target.closest('.pager')) return;
      const scope = e.target.closest && e.target.closest('.page, .modal-overlay');
      if (!scope) return;
      pagers.forEach((st) => {
        if (st.scope !== scope) return;
        st.reset = true;
        setTimeout(() => { st.reset = false; }, 0);
      });
    };
    ['input', 'change', 'click'].forEach((ev) => document.addEventListener(ev, back, true));
  }

  /* =====================================================
     MY PROFILE  (loads from / saves to the users table)
     Required: Full name, Email, Phone.  Photo: JPG/PNG up to 2 MB.
  ===================================================== */
  function setupProfileForm() {
    const fName = $('profileName'), fEmail = $('profileEmail'), fPhone = $('profilePhone');
    const saveBtn = $('profileSaveBtn'), cancelBtn = $('profileCancelBtn'), banner = $('profileFormError');
    const overlay = $('accountModalOverlay');
    if (!fName || !fEmail || !fPhone || !saveBtn) return;

    const NAME_RE = /^[\p{L}][\p{L}\p{M}\s.'’-]*$/u;
    const ids = ['profileName', 'profileEmail', 'profilePhone'];
    let saved = null;                 // what the database currently holds
    let loadError = '';               // set when the profile could not be loaded from the server
    let saving = false;
    let emailTaken = null;            // { email, taken, domainMsg, unverified } from the last live check
    let emailTimer = null;
    const touched = {};

    const values = () => ({
      name: clean(fName.value),
      email: clean(fEmail.value).toLowerCase(),
      phone: clean(fPhone.value)
    });

    // same rules as the server (PUT /api/auth/profile)
    function problems(v) {
      const e = {};
      if (!v.name) e.profileName = 'Full name is required';
      else if (v.name.length < 2) e.profileName = 'Full name must be at least 2 characters';
      else if (v.name.length > 100) e.profileName = 'Full name must be at most 100 characters';
      else if (!NAME_RE.test(v.name)) e.profileName = "Full name can only have letters, spaces, . ' and -";
      if (!v.email) e.profileEmail = 'Email is required';
      else if (v.email.length > 254 || !EMAIL_FORMAT.test(v.email)) e.profileEmail = 'Enter a valid email address';
      else if (emailTaken && emailTaken.email === v.email && emailTaken.taken) e.profileEmail = 'That email is already used by another account';
      else if (emailTaken && emailTaken.email === v.email && emailTaken.domainMsg) e.profileEmail = emailTaken.domainMsg;
      if (!v.phone) e.profilePhone = 'Phone number is required';
      else if (v.phone.length < 7) e.profilePhone = 'Phone number must be at least 7 characters';
      else { const m = phoneError(v.phone); if (m) e.profilePhone = m; }
      return e;
    }
    const changed = (v) => !!saved && (v.name !== saved.name || v.email !== saved.email.toLowerCase() || v.phone !== (saved.phone || ''));

    function paint(onlyTouched) {
      const v = values(), e = problems(v);
      ids.forEach((id) => {
        const el = $(id);
        el.classList.remove('field-invalid');
        const grp = el.closest('.form-group');
        grp.querySelectorAll('.field-msg[data-for="' + id + '"]').forEach((n) => n.remove());
        if (e[id] && (!onlyTouched || touched[id])) setError(id, e[id]);
      });
      // the button is never left dead: clicking it explains what is wrong (or retries the load)
      saveBtn.disabled = saving;
      if (!Object.keys(e).length && !loadError && banner) banner.classList.remove('show');
      return e;
    }

    function fill(p) {
      saved = p;
      fName.value = p.name || '';
      fEmail.value = p.email || '';
      fPhone.value = p.phone || '';
      const set = (id, val) => { const el = $(id); if (el) el.value = val || ''; };
      set('profileEmployeeId', p.employeeId); set('profileDepartment', p.department); set('profileJoined', p.joined);
      const badge = $('profileRoleBadge'); if (badge) badge.textContent = p.roleLabel || '';
      avatarState = { has: !!p.hasAvatar, v: avatarState.v || Date.now() };
      reapplyAvatar();
      ids.forEach((id) => { touched[id] = false; });
      emailTaken = null; showEmailStatus('');
      paint(true);
    }

    async function loadProfile() {
      try {
        fill(await api('/auth/profile'));
        loadError = '';
        if (banner) banner.classList.remove('show');
      } catch (err) {
        if (err.message === 'Not signed in') return;
        loadError = 'Could not load your profile from the database (' + err.message + '). ' +
          (err.status === 404 ? 'The backend is running an old server.js: replace it and restart with npm start. ' : 'Check the backend window for the error. ') +
          'Click Save Changes to try again.';
        if (banner) { banner.textContent = loadError; banner.classList.add('show'); }
      }
      paint(true);
    }

    // small status line under the email box: "Checking…" / "domain is valid"
    function showEmailStatus(text, color) {
      const grp = fEmail.closest('.form-group');
      let n = grp.querySelector('.profile-email-status');
      if (text == null) {
        const c = emailTaken && emailTaken.email === values().email ? emailTaken : null;
        if (!c || c.taken || c.domainMsg) text = '';
        else if (c.unverified) text = 'Email format is OK (domain could not be checked right now)';
        else text = 'Email domain is valid';
        color = c && !c.unverified ? '#5fbf8a' : '';
      }
      if (!text) { if (n) n.remove(); return; }
      if (!n) { n = document.createElement('div'); n.className = 'field-hint profile-email-status'; grp.appendChild(n); }
      n.textContent = text; n.style.color = color || '';
    }

    // Is this email already used, and does its domain really exist? (checked while typing, after a short pause)
    function checkEmailSoon() {
      clearTimeout(emailTimer);
      const v = values();
      if (!v.email || !EMAIL_FORMAT.test(v.email) || (saved && v.email === saved.email.toLowerCase())) { emailTaken = null; showEmailStatus(''); return; }
      showEmailStatus('Checking email domain…');
      emailTimer = setTimeout(async () => {
        try {
          const r = await api('/auth/check-email?email=' + encodeURIComponent(v.email));
          if (values().email === v.email) {
            emailTaken = { email: v.email, taken: !!r.taken, domainMsg: r.domainOk === false ? (r.message || 'That email domain cannot receive email') : '', unverified: !!r.unverified };
            paint(true);
            showEmailStatus();
          }
        } catch (e) { /* the server re-checks on save */ }
      }, 600);
    }

    // phone box only accepts phone characters
    fPhone.addEventListener('input', () => {
      const next = fPhone.value.replace(/[^\d+\s().-]/g, '');
      if (next !== fPhone.value) fPhone.value = next;
    });
    ids.forEach((id) => {
      const el = $(id);
      el.addEventListener('input', () => { touched[id] = true; if (id === 'profileEmail') checkEmailSoon(); paint(true); });
      el.addEventListener('blur', () => { touched[id] = true; paint(true); });
    });
    fName.addEventListener('blur', () => { fName.value = clean(fName.value); });
    fEmail.addEventListener('blur', () => { fEmail.value = clean(fEmail.value).toLowerCase(); });

    saveBtn.addEventListener('click', async () => {
      if (saving) return;
      if (!saved) { await loadProfile(); return; }          // never loaded: try again instead of doing nothing
      ids.forEach((id) => { touched[id] = true; });
      const e = paint(false);
      if (Object.keys(e).length) {
        if (banner) { banner.textContent = 'Please fix the highlighted fields.'; banner.classList.add('show'); }
        const first = ids.find((id) => e[id]); if (first) $(first).focus();
        return;
      }
      const v = values();
      if (!changed(v)) { toast('No changes to save'); return; }
      saving = true; saveBtn.disabled = true;
      const label = saveBtn.textContent; saveBtn.textContent = 'Saving…';
      try {
        const p = await api('/auth/profile', { method: 'PUT', body: JSON.stringify(v) });
        fill(p);
        currentUser = Object.assign({}, currentUser, { name: p.name, email: p.email });
        safe(applyUser);
        toast('Profile saved');
        if (typeof closeAccountModal === 'function') closeAccountModal();
      } catch (err) {
        if (err.message === 'Not signed in') return;
        const map = { name: 'profileName', email: 'profileEmail', phone: 'profilePhone' };
        const fe = mapFields(err.fields, map);
        if (Object.keys(fe).length) showErrors($('profileTabPanel'), banner, fe);
        else { if (banner) { banner.textContent = err.message; banner.classList.add('show'); } }
      } finally {
        saving = false;
        saveBtn.textContent = label;
        paint(true);
      }
    });

    /* ---- profile photo: Upload photo / Remove (saved to the database straight away) ---- */
    const upBtn = $('profileUploadBtn'), rmBtn = $('profileRemoveBtn');
    const MAX_PHOTO = 2 * 1024 * 1024;
    function photoMsg(text) {
      const row = upBtn && upBtn.closest('.profile-photo-row');
      if (!row) return;
      row.querySelectorAll('.profile-photo-msg').forEach((n) => n.remove());
      if (!text) return;
      const m = document.createElement('div');
      m.className = 'field-msg profile-photo-msg';
      m.textContent = text;
      row.appendChild(m);
    }
    if (upBtn) {
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = 'image/jpeg,image/png'; picker.hidden = true;
      document.body.appendChild(picker);
      upBtn.addEventListener('click', () => { photoMsg(''); picker.value = ''; picker.click(); });
      picker.addEventListener('change', async () => {
        const f = picker.files && picker.files[0];
        if (!f) return;
        if (!/^image\/(jpeg|png)$/.test(f.type)) return photoMsg('Choose a JPG or PNG image');
        if (!f.size) return photoMsg('That file is empty');
        if (f.size > MAX_PHOTO) return photoMsg('Photo must be 2 MB or smaller (yours is ' + (f.size / 1048576).toFixed(1) + ' MB)');
        upBtn.disabled = true; const label = upBtn.textContent; upBtn.textContent = 'Uploading…';
        try {
          const res = await fetch('/api/auth/avatar', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': f.type }, body: f });
          if (res.status === 401) { window.location.href = 'Login_Inventory.html'; return; }
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error((j.fields && j.fields.photo) || j.error || (res.status === 404 ? 'The backend is running an old server.js: replace it and restart' : 'Upload failed'));
          avatarState = { has: true, v: Date.now() };
          reapplyAvatar();
          toast('Photo updated');
        } catch (err) { photoMsg(err.message); }
        finally { upBtn.disabled = false; upBtn.textContent = label; }
      });
    }
    if (rmBtn) rmBtn.addEventListener('click', async () => {
      photoMsg('');
      if (!avatarState.has) return photoMsg('You have no photo to remove');
      rmBtn.disabled = true;
      try { await api('/auth/avatar', { method: 'DELETE' }); avatarState = { has: false, v: 0 }; toast('Photo removed'); }
      catch (err) { if (err.message !== 'Not signed in') photoMsg(err.message); }
      reapplyAvatar();
    });

    // Cancel throws away unsaved edits
    if (cancelBtn) cancelBtn.addEventListener('click', () => { if (saved) fill(saved); if (banner) banner.classList.remove('show'); });

    // reload from the database every time the account window opens
    if (overlay) {
      let wasOpen = false;
      new MutationObserver(() => {
        const open = overlay.classList.contains('open');
        if (open && !wasOpen) loadProfile();
        wasOpen = open;
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
    loadProfile();
  }

  /* ---------------- start ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    setupAutofillGuard();
    setupPagePersistence();
    setupTheme();
    setupBurger();
    setupReports();
    setupFormalPrint();
    setupNumberGuard();
    setupPagers();
    setupUnitSelect();
    setupLiveValidation();          // must be first so its submit check runs before the others
    setupMovementLog();
    setupMovementForm();
    setupProductModal();
    setupSupplierModal();
    setupStockAlerts();
    setupProfileForm();
    load().catch((err) => console.warn('[api-bridge]', err.message));
    setupLiveRefresh();
    const logout = $('logoutBtn');
    if (logout) logout.addEventListener('click', () => {
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    }, true);
  });
})();