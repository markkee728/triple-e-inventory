/* stock-count-admin.js — Finance: physical inventory (stock count).
   Adds a "Stock Count" page under Inventory. Load it last in Finance_Inventory.html:
       <script src="stock-count-admin.js?v=1"></script>
   Server routes: GET/POST /api/stock-counts · GET /api/stock-counts/:id · PUT .../lines · POST .../post · POST .../cancel
   The server checks every rule again; the checks here only give faster feedback. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var peso = function (n) { return (n < 0 ? '−' : '') + '₱' + Math.abs(Number(n || 0)).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var num = function (n) { return Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 }); };
  var when = function (ms) { return new Date(ms).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  var round2 = function (n) { return Math.round((n + Number.EPSILON) * 100) / 100; };

  var list = [], cur = null, busy = false, dirty = false, filter = 'all', term = '', blind = false;
  var DEPTS = ['Raw Materials', 'Finished Goods', 'Finishing Supplies'];

  async function api(path, options) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields });
    return data;
  }
  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'app-toast' + (isError ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  /* ---------------- page shell ---------------- */
  function addStyles() {
    var css =
      '.sc-top{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}' +
      '.sc-top .grow{flex:1;min-width:220px}' +
      '.sc-top label{display:block;font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:6px}' +
      '.sc-sheet input.sc-in{width:96px;text-align:right;padding:6px 8px;box-sizing:border-box}' +
      '.sc-sheet input.sc-note{width:100%;min-width:130px;padding:6px 8px;box-sizing:border-box}' +
      '.sc-sheet td,.sc-sheet th{vertical-align:middle}.sc-sheet .r{text-align:right;white-space:nowrap}.sc-sheet input.sc-in{display:inline-block}' +
      '.sc-up{color:var(--green,#43c47a);font-weight:600}.sc-down{color:var(--red,#e35b5b);font-weight:600}.sc-same{color:var(--text-faint)}' +
      '.sc-row-diff td{background:rgba(217,164,65,.07)}' +
      '.sc-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}' +
      '.sc-bar .sp{flex:1}' +
      '.sc-sum{display:flex;gap:10px 22px;flex-wrap:wrap;margin:0 0 14px;font-size:14.5px}.sc-sum b{font-size:17px}' +
      '.sc-err{display:none;margin:10px 0;padding:9px 12px;border-radius:6px;font-size:13.5px;color:var(--red);background:rgba(227,91,91,.1);border:1px solid rgba(227,91,91,.35)}.sc-err.show{display:block}' +
      '.sc-chk{display:flex;gap:8px;align-items:center;font-size:14px;cursor:pointer}.sc-chk input{width:auto}' +
      '.sc-hint{font-size:13px;color:var(--text-faint);margin:0 0 12px}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  function build() {
    if ($('stockcount')) return true;
    var after = $('stockflow');
    if (!after) return false;
    var sec = document.createElement('section');
    sec.id = 'stockcount'; sec.className = 'page';
    sec.innerHTML =
      '<div class="welcome"><h1>Stock Count</h1></div>' +
      '<div id="scBody"></div>';
    after.parentNode.insertBefore(sec, after.nextSibling);

    var nav = document.querySelector('.nav-item[data-page="stockflow"]');
    if (nav && !document.querySelector('.nav-item[data-page="stockcount"]')) {
      var b = document.createElement('button');
      b.className = 'nav-item'; b.setAttribute('data-page', 'stockcount');
     b.innerHTML = '<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="18" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/><path d="M9 18h6"/></svg> Stock Count';
      nav.parentNode.insertBefore(b, nav.nextSibling);
      b.addEventListener('click', function () { if (typeof navigateToPage === 'function') navigateToPage('stockcount'); onOpen(); });
    }
    try { if (typeof pageInformation !== 'undefined') pageInformation.stockcount = { title: 'Stock Count', subtitle: 'Compare the physical count with the system' }; } catch (e) {}
    return true;
  }

  /* ---------------- views ---------------- */
  function statusPill(st) {
    var cls = st === 'posted' ? 'in' : st === 'cancelled' ? 'out' : 'low';
    return '<span class="status-pill ' + cls + '">' + (st === 'posted' ? 'Posted' : st === 'cancelled' ? 'Cancelled' : 'Open') + '</span>';
  }

  function renderList() {
    cur = null;
    var open = list.filter(function (c) { return c.status === 'open'; })[0];
    var html = '<div class="panel" style="margin-bottom:18px"><div class="panel-head"><div><div class="panel-title">' + (open ? 'Count in progress' : 'Start a new count') + '</div>' +
      '<div class="panel-sub">' + (open ? 'Only one count can be open at a time.' : 'The system quantities are saved when you start, so you can count at your own pace.') + '</div></div></div>';
    if (open) {
      html += '<div class="sc-sum"><span>' + esc(open.no) + ' · ' + esc(open.scope) + '</span><span>' + open.counted + ' of ' + open.lines + ' counted</span><span>started ' + esc(when(open.createdAt)) + ' by ' + esc(open.createdBy) + '</span></div>' +
        '<button class="btn-primary" data-sc="open" data-id="' + esc(open.id) + '">Continue counting</button>';
    } else {
      html += '<div class="sc-top"><div class="grow"><label for="scDept">What do you want to count?</label><select id="scDept" class="form-select"><option value="">All departments</option>' +
        DEPTS.map(function (d) { return '<option>' + esc(d) + '</option>'; }).join('') + '</select></div>' +
        '<div class="grow"><label for="scNote">Note (optional)</label><input id="scNote" class="form-input" maxlength="300" placeholder="e.g. Month-end count, warehouse A" autocomplete="off"></div>' +
        '<button class="btn-primary" id="scStart">Start count</button></div><div class="sc-err" id="scErr"></div>' +
        '<p class="sc-hint">Tip: stop sales and stock movements for the area while you count, so the numbers match exactly.</p>';
    }
    html += '</div><div class="panel"><div class="panel-head"><div><div class="panel-title">Count history</div><div class="panel-sub">Posted counts have already corrected the stock</div></div></div>' +
      '<div class="table-wrapper"><table><thead><tr><th>Count</th><th>Scope</th><th>Status</th><th class="r">Counted</th><th class="r">Differences</th><th class="r">Net value</th><th>Date</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map(function (c) {
        return '<tr><td class="mono">' + esc(c.no) + '</td><td>' + esc(c.scope) + '</td><td>' + statusPill(c.status) + '</td><td class="r">' + c.counted + ' / ' + c.lines + '</td>' +
          '<td class="r">' + (c.status === 'cancelled' ? '—' : c.differences) + '</td><td class="r ' + (c.netValue < 0 ? 'sc-down' : c.netValue > 0 ? 'sc-up' : '') + '">' + (c.status === 'posted' ? peso(c.netValue) : '—') + '</td>' +
          '<td class="dim">' + esc(when(c.closedAt || c.createdAt)) + '</td><td class="r"><button class="btn-secondary btn-sm" data-sc="open" data-id="' + esc(c.id) + '">' + (c.status === 'open' ? 'Continue' : 'View') + '</button></td></tr>';
      }).join('') : '<tr><td colspan="8" class="dim" style="text-align:center;padding:22px">No stock counts yet.</td></tr>') +
      '</tbody></table></div></div>';
    $('scBody').innerHTML = html;
  }

  // difference for one line: only when a quantity was typed
  function diffOf(it) { return it.countedQty === null ? null : round2(it.countedQty - it.systemQty); }

  function renderCount() {
    var open = cur.status === 'open';
    var items = cur.items;
    var counted = items.filter(function (i) { return i.countedQty !== null; });
    var diffs = counted.filter(function (i) { return diffOf(i) !== 0; });
    var net = diffs.reduce(function (s, i) { return s + diffOf(i) * i.unitCost; }, 0);
    var html = '<div class="sc-bar"><button class="btn-secondary btn-sm" data-sc="back">&larr; All counts</button><b class="mono">' + esc(cur.no) + '</b> ' + statusPill(cur.status) +
      '<span class="dim">' + esc(cur.scope) + ' · started ' + esc(when(cur.createdAt)) + ' by ' + esc(cur.createdBy) + (cur.note ? ' · ' + esc(cur.note) : '') + '</span></div>' +
      '<div class="panel"><div class="sc-sum" id="scSum"></div>' +
      '<div class="sc-bar"><input id="scSearch" class="inv-search" placeholder="Search product or SKU…" value="' + esc(term) + '" autocomplete="off">' +
      '<select id="scFilter" class="inv-select"><option value="all">All products</option><option value="todo">Not counted yet</option><option value="diff">Differences only</option></select>' +
      (open ? '<label class="sc-chk"><input type="checkbox" id="scBlind"' + (blind ? ' checked' : '') + '> Hide system quantity (blind count)</label>' : '') +
      '<span class="sp"></span>' +
      (open ? '<button class="btn-secondary" id="scSave">Save progress</button><button class="btn-primary" id="scPost">Review &amp; post…</button><button class="btn-danger btn-sm" id="scCancel">Cancel count</button>' : '') + '</div>' +
      '<div class="sc-err" id="scErr"></div>' +
      '<div class="table-wrapper"><table class="sc-sheet"><thead><tr><th>SKU</th><th>Product</th><th>Location</th>' + (blind && open ? '' : '<th class="r">System</th>') +
      '<th class="r">Counted</th><th class="r">Difference</th><th class="r">Value</th><th>Note</th></tr></thead><tbody id="scRows"></tbody></table></div></div>';
    $('scBody').innerHTML = html;
    $('scFilter').value = filter;
    renderRows(); renderSummary();
  }

  function renderSummary() {
    var items = cur.items, counted = items.filter(function (i) { return i.countedQty !== null; });
    var diffs = counted.filter(function (i) { return diffOf(i) !== 0; });
    var net = diffs.reduce(function (s, i) { return s + diffOf(i) * i.unitCost; }, 0);
    var el = $('scSum'); if (!el) return;
    el.innerHTML = '<span><b>' + counted.length + '</b> of ' + items.length + ' counted</span>' +
      '<span><b>' + diffs.length + '</b> with differences</span>' +
      (blind && cur.status === 'open' ? '' : '<span>Net value of differences <b class="' + (net < 0 ? 'sc-down' : net > 0 ? 'sc-up' : '') + '">' + peso(net) + '</b></span>');
  }

  function visible() {
    var t = term.trim().toLowerCase();
    return cur.items.filter(function (i) {
      if (t && (i.name + ' ' + i.sku).toLowerCase().indexOf(t) < 0) return false;
      if (filter === 'todo') return i.countedQty === null;
      if (filter === 'diff') return i.countedQty !== null && diffOf(i) !== 0;
      return true;
    });
  }

  function diffCell(it) {
    var d = diffOf(it);
    if (d === null) return '<span class="sc-same">—</span>';
    if (d === 0) return '<span class="sc-same">0</span>';
    return '<span class="' + (d > 0 ? 'sc-up' : 'sc-down') + '">' + (d > 0 ? '+' : '−') + num(Math.abs(d)) + ' ' + esc(it.unit) + '</span>';
  }

  function renderRows() {
    var open = cur.status === 'open', rows = visible();
    var hideSys = blind && open;
    $('scRows').innerHTML = rows.length ? rows.map(function (it) {
      var d = diffOf(it), v = d === null ? null : d * it.unitCost;
      return '<tr data-sku="' + esc(it.sku) + '"' + (d ? ' class="sc-row-diff"' : '') + '><td class="mono">' + esc(it.sku) + '</td><td>' + esc(it.name) + '<div class="dim" style="font-size:12.5px">' + esc(it.department) + '</div></td>' +
        '<td class="dim">' + esc(it.location || '—') + '</td>' +
        (hideSys ? '' : '<td class="r">' + num(it.systemQty) + ' ' + esc(it.unit) + '</td>') +
        '<td class="r">' + (open ? '<input class="form-input sc-in" type="number" inputmode="decimal" min="0" step="any" data-in="' + esc(it.sku) + '" value="' + (it.countedQty === null ? '' : it.countedQty) + '" aria-label="Counted quantity for ' + esc(it.name) + '"> ' + esc(it.unit) : (it.countedQty === null ? '—' : num(it.countedQty) + ' ' + esc(it.unit))) + '</td>' +
        '<td class="r" data-d="' + esc(it.sku) + '">' + (hideSys ? '<span class="sc-same">hidden</span>' : diffCell(it)) + '</td>' +
        '<td class="r" data-v="' + esc(it.sku) + '">' + (hideSys || v === null || v === 0 ? '—' : '<span class="' + (v > 0 ? 'sc-up' : 'sc-down') + '">' + peso(v) + '</span>') + '</td>' +
        '<td>' + (open ? '<input class="form-input sc-note" maxlength="200" data-note="' + esc(it.sku) + '" value="' + esc(it.note) + '" placeholder="Why? (optional)" autocomplete="off">' : esc(it.note)) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="dim" style="text-align:center;padding:22px">No products match.</td></tr>';
  }

  /* ---------------- actions ---------------- */
  function showErr(msg) { var e = $('scErr'); if (!e) return toast(msg, true); e.textContent = msg; e.classList.toggle('show', !!msg); }

  async function loadList() { list = await api('/stock-counts'); }
  async function openCount(id) {
    cur = await api('/stock-counts/' + encodeURIComponent(id)); dirty = false; term = ''; filter = 'all'; renderCount();
  }
  async function showList() { await loadList(); renderList(); }
  async function onOpen() {
    if (!build()) return;
    if (cur && dirty) return;                 // keep unsaved typing when the user comes back to this page
    try { if (cur && cur.status === 'open') await openCount(cur.id); else await showList(); }
    catch (e) { $('scBody').innerHTML = '<div class="panel"><p class="dim" style="padding:18px">' + esc(e.message) + '</p></div>'; }
  }

  async function save(quiet) {
    if (!cur || cur.status !== 'open') return true;
    // Send every line (so cleared boxes are saved as "not counted" too)
    var lines = cur.items.map(function (i) { return { sku: i.sku, countedQty: i.countedQty, note: i.note }; });
    try { await api('/stock-counts/' + encodeURIComponent(cur.id) + '/lines', { method: 'PUT', body: JSON.stringify({ lines: lines }) }); dirty = false; if (!quiet) toast('Progress saved'); return true; }
    catch (e) { showErr(e.message); return false; }
  }

  function onInput(e) {
    var t = e.target, sku = t.getAttribute('data-in'), nsku = t.getAttribute('data-note');
    if (!sku && !nsku) return;
    var it = cur.items.filter(function (i) { return i.sku === (sku || nsku); })[0]; if (!it) return;
    if (sku) {
      var raw = t.value.trim();
      if (raw === '') it.countedQty = null;
      else { var n = Number(raw); if (!isFinite(n) || n < 0) { t.classList.add('field-invalid'); return; } t.classList.remove('field-invalid'); it.countedQty = round2(n); }
      var row = t.closest('tr'), d = diffOf(it), v = d === null ? null : d * it.unitCost;
      row.classList.toggle('sc-row-diff', !!d);
      if (!blind) { row.querySelector('[data-d]').innerHTML = diffCell(it); row.querySelector('[data-v]').innerHTML = v === null || v === 0 ? '—' : '<span class="' + (v > 0 ? 'sc-up' : 'sc-down') + '">' + peso(v) + '</span>'; }
      renderSummary();
    } else it.note = t.value;
    dirty = true; showErr('');
  }

  // Review dialog: lists only the lines that will change stock
  function review() {
    var counted = cur.items.filter(function (i) { return i.countedQty !== null; });
    if (!counted.length) return showErr('Enter at least one counted quantity first.');
    var diffs = counted.filter(function (i) { return diffOf(i) !== 0; });
    var net = diffs.reduce(function (s, i) { return s + diffOf(i) * i.unitCost; }, 0);
    var ov = document.createElement('div'); ov.className = 'modal-overlay open'; ov.style.zIndex = 1200;
    ov.innerHTML = '<div class="account-modal" style="max-width:640px;width:100%;max-height:92vh;overflow:auto" role="dialog" aria-modal="true"><h3 style="margin:0 0 8px">Post ' + esc(cur.no) + '?</h3>' +
      '<p class="dim">' + counted.length + ' product(s) counted, <b>' + diffs.length + '</b> will change stock. Products you left blank are not touched. This cannot be undone — it writes Stock In / Stock Out entries.</p>' +
      (diffs.length ? '<div class="table-wrapper"><table><thead><tr><th>Product</th><th class="r">System</th><th class="r">Counted</th><th class="r">Change</th><th class="r">Value</th></tr></thead><tbody>' +
        diffs.map(function (i) { var d = diffOf(i); return '<tr><td>' + esc(i.name) + '</td><td class="r">' + num(i.systemQty) + '</td><td class="r">' + num(i.countedQty) + '</td><td class="r ' + (d > 0 ? 'sc-up' : 'sc-down') + '">' + (d > 0 ? '+' : '−') + num(Math.abs(d)) + ' ' + esc(i.unit) + '</td><td class="r">' + peso(d * i.unitCost) + '</td></tr>'; }).join('') +
        '</tbody></table></div><p style="margin:10px 0 0">Net value of corrections: <b class="' + (net < 0 ? 'sc-down' : net > 0 ? 'sc-up' : '') + '">' + peso(net) + '</b></p>'
        : '<p>Everything counted matches the system. Posting will just close this count.</p>') +
      '<div class="sc-err" id="scPostErr"></div>' +
      '<div class="modal-actions" style="display:flex;gap:10px;margin-top:16px"><button class="btn-primary" id="scConfirm">Post corrections</button><button class="btn-secondary" id="scBack">Go back</button></div></div>';
    document.body.appendChild(ov);
    $('scBack').onclick = function () { ov.remove(); };
    $('scConfirm').onclick = async function () {
      if (busy) return; busy = true; this.disabled = true; this.textContent = 'Posting…';
      try {
        if (!(await save(true))) throw new Error('Could not save your counts — check your connection and try again.');
        var r = await api('/stock-counts/' + encodeURIComponent(cur.id) + '/post', { method: 'POST' });
        ov.remove(); toast(r.no + ' posted: ' + r.increased + ' increased, ' + r.decreased + ' decreased.');
        await openCount(cur.id); await refreshInventory();
      } catch (e) { var pe = $('scPostErr'); pe.textContent = e.message; pe.classList.add('show'); this.disabled = false; this.textContent = 'Post corrections'; }
      busy = false;
    };
  }

  // the Finance app reloads its stock numbers by itself every 10 seconds, so nothing else is needed after posting
  async function refreshInventory() {}

  function bind() {
    document.addEventListener('click', async function (e) {
      var b = e.target.closest('#stockcount button, #stockcount [data-sc]'); if (!b || !$('stockcount')) return;
      var act = b.getAttribute('data-sc');
      try {
        if (act === 'open') await openCount(b.getAttribute('data-id'));
        else if (act === 'back') { if (dirty && !(await save(true))) return; await showList(); }
        else if (b.id === 'scStart') {
          showErr('');
          var r = await api('/stock-counts', { method: 'POST', body: JSON.stringify({ department: $('scDept').value, note: $('scNote').value }) });
          await openCount(r.id);
        }
        else if (b.id === 'scSave') await save(false);
        else if (b.id === 'scPost') { if (await save(true)) review(); }
        else if (b.id === 'scCancel') {
          if (!window.confirm('Cancel ' + cur.no + '? Nothing will be changed in your stock, and the counts you typed will be kept in history only.')) return;
          await api('/stock-counts/' + encodeURIComponent(cur.id) + '/cancel', { method: 'POST' }); toast(cur.no + ' cancelled'); await showList();
        }
      } catch (err) { showErr(err.message); if (!$('scErr')) toast(err.message, true); }
    });
    document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('#stockcount')) { if (e.target.id === 'scSearch') { term = e.target.value; renderRows(); } else onInput(e); } });
    document.addEventListener('change', function (e) {
      if (!e.target.closest || !e.target.closest('#stockcount')) return;
      if (e.target.id === 'scFilter') { filter = e.target.value; renderRows(); }
      if (e.target.id === 'scBlind') { blind = e.target.checked; renderCount(); }
    });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  function init() {
    addStyles(); if (!build()) return; bind();
    if (location.hash === '#stockcount' && typeof navigateToPage === 'function') { navigateToPage('stockcount'); onOpen(); }   // page reloaded while on Stock Count
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
