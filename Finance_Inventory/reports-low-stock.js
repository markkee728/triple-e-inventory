/* reports-low-stock.js — Finance > Reports > "Low-Stock Report".
   Shows Raw Materials, Finishing Supplies and Finished Goods that are at or below their reorder level.
   It only READS stock levels (/api/reports/low-stock). It never creates or changes a notification: the Notification
   Center keeps raising each low-stock alert once, exactly as before.
   Needs reports-sales.css and a <div id="repLowRoot"></div> inside the Reports page. */
(function () {
  'use strict';

  const TZ = 'Asia/Manila';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 });
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-PH', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' }) : '\u2014');
  const DEPTS = ['Raw Materials', 'Finishing Supplies', 'Finished Goods'];
  const LABEL = { out: 'Out of stock', low: 'Low', watch: 'Watch', ok: 'OK', no_level: 'No level set' };
  const PAGE = 50;

  const state = { dept: 'all', status: 'attention', sort: 'status', dir: '', search: '', shown: PAGE, data: null, loading: false, error: '', seq: 0, built: false, loadedOnce: false, timer: null };

  const qs = () => 'dept=' + encodeURIComponent(state.dept) + '&status=' + state.status + '&sort=' + state.sort + (state.dir ? '&dir=' + state.dir : '') + '&q=' + encodeURIComponent(state.search);
  async function getJson(path) {
    const res = await fetch('/api' + path, { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status === 403 ? 'Only Finance-Admin can view financial reports.' : 'Could not load the report.'));
    return data;
  }
  function toast(message, type) {
    const el = document.createElement('div'); el.className = 'app-toast' + (type === 'error' ? ' error' : '');
    el.textContent = message; document.body.appendChild(el); setTimeout(() => el.remove(), 4500);
  }

  function build() {
    const root = $('repLowRoot'); if (!root || state.built) return;
    state.built = true;
    root.innerHTML =
      '<div class="panel rs-panel">' +
        '<div class="panel-head rs-head"><div><div class="panel-title">Low-Stock Report</div>' +
        '<div class="panel-sub">Products at or below their reorder level. This report only reads stock; alerts stay in the Notification Center and are not duplicated here.</div></div>' +
        '<div class="rs-actions"><button type="button" class="btn-secondary" id="lsRefresh">Refresh</button><button type="button" class="btn-primary" id="lsCsv">Export CSV</button></div></div>' +
        '<div class="rs-filters">' +
          '<div class="rs-tabs" id="lsTabs" role="group" aria-label="Department"></div>' +
          '<label class="rs-date">Status <select id="lsStatus" class="inv-select"><option value="attention">Needs attention</option><option value="out">Out of stock</option><option value="low">Low</option><option value="watch">Watch (near level)</option><option value="ok">OK</option><option value="no_level">No reorder level</option><option value="all">All products</option></select></label>' +
          '<label class="rs-date">Sort by <select id="lsSort" class="inv-select"><option value="status">Most urgent</option><option value="shortage">Shortage</option><option value="cover">Days of cover</option><option value="on_hand">On hand</option><option value="cost">Restock cost</option><option value="name">Name</option></select></label>' +
          '<input type="search" id="lsSearch" class="rs-search" placeholder="Search SKU or product" autocomplete="off" aria-label="Search products">' +
        '</div>' +
      '</div><div id="lsBody"></div>';
    $('lsTabs').addEventListener('click', (e) => { const b = e.target.closest('.rs-tab'); if (!b) return; state.dept = b.dataset.d; state.shown = PAGE; load(); });
    $('lsStatus').addEventListener('change', (e) => { state.status = e.target.value; state.shown = PAGE; load(); });
    $('lsSort').addEventListener('change', (e) => { state.sort = e.target.value; state.dir = ''; state.shown = PAGE; load(); });
    $('lsSearch').addEventListener('input', (e) => { state.search = e.target.value.trim().slice(0, 60); clearTimeout(state.timer); state.timer = setTimeout(() => { state.shown = PAGE; load(); }, 300); });
    $('lsRefresh').addEventListener('click', load); $('lsCsv').addEventListener('click', downloadCsv);
    $('lsBody').addEventListener('click', (e) => {
      if (e.target.closest('#lsRetry')) return load();
      if (e.target.closest('#lsMore')) { state.shown += PAGE; return render(); }
      const th = e.target.closest('th.sortable'); if (!th) return;
      const k = th.dataset.k; state.dir = state.sort === k ? ((state.data && state.data.filters.dir) === 'asc' ? 'desc' : 'asc') : ''; state.sort = k; $('lsSort').value = k; state.shown = PAGE; load();
    });
  }

  function tabs(d) {
    const by = Object.fromEntries(d.summary.byDepartment.map((x) => [x.department, x]));
    const badge = (x) => { const n = x ? x.out + x.low : d.summary.needAttention; return '<b class="' + (n ? '' : 'zero') + '">' + n + '</b>'; };
    $('lsTabs').innerHTML = [['all', 'All departments', null]].concat(DEPTS.map((k) => [k, k, by[k]])).map((t) => '<button type="button" class="rs-tab' + (state.dept === t[0] ? ' on' : '') + '" data-d="' + esc(t[0]) + '">' + esc(t[1]) + badge(t[2]) + '</button>').join('');
  }

  async function load() {
    const seq = ++state.seq; state.loading = true; state.error = ''; render();
    try { const d = await getJson('/reports/low-stock?' + qs()); if (seq !== state.seq) return; state.data = d; }
    catch (e) { if (seq !== state.seq) return; state.error = e.message; state.data = null; }
    state.loading = false; state.loadedOnce = true; render();
  }
  async function downloadCsv() {
    const btn = $('lsCsv'); btn.disabled = true;
    try {
      const res = await fetch('/api/reports/low-stock.csv?' + qs(), { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not export.'); }
      const url = URL.createObjectURL(await res.blob()), a = document.createElement('a');
      a.href = url; a.download = 'low-stock_' + new Date().toLocaleDateString('en-CA', { timeZone: TZ }) + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  }

  function render() {
    const body = $('lsBody'); if (!body) return;
    if (state.loading && !state.data) { body.innerHTML = '<div class="rs-kpis five">' + '<div class="rs-kpi rs-skel"></div>'.repeat(5) + '</div><div class="panel rs-skel rs-skel-chart"></div>'; return; }
    if (state.error) { body.innerHTML = '<div class="panel rs-empty"><strong>Could not load the low-stock report</strong><p>' + esc(state.error) + '</p><button type="button" class="btn-secondary" id="lsRetry">Try again</button></div>'; return; }
    const d = state.data; if (!d) return;
    tabs(d); body.classList.toggle('rs-busy', state.loading);
    const s = d.summary, card = (l, v, sub, cls) => '<div class="rs-kpi ' + (cls || '') + '"><div class="rs-kpi-label">' + l + '</div><div class="rs-kpi-value">' + v + '</div><div class="rs-kpi-sub">' + sub + '</div></div>';
    body.innerHTML = '<div class="rs-kpis five">' +
      card('Need attention', num(s.needAttention), 'of ' + num(s.total) + ' active products', s.needAttention ? 'bad' : '') +
      card('Out of stock', num(s.out), 'on hand is zero', s.out ? 'bad' : '') + card('Low', num(s.low), 'at or below reorder level', s.low ? 'warn' : '') +
      card('Watch', num(s.watch), 'within 20% above the level') + card('Est. restock cost', peso(s.restockCost), 'to reach reorder levels') + '</div>' +
      depts(d) + table(d);
  }

  function depts(d) {
    return '<div class="rs-depts">' + d.summary.byDepartment.map((x) => {
      const seg = (n, c) => (x.total ? '<div class="' + c + '" style="width:' + (n / x.total * 100).toFixed(2) + '%"></div>' : '');
      return '<div class="rs-dept"><div class="rs-dept-top">' + esc(x.department) + '<span>' + num(x.total) + ' products</span></div>' +
        '<div class="rs-stack sm">' + seg(x.out, 'bad') + seg(x.low, 'warn') + seg(x.watch, 'blue') + seg(x.ok, 'ok') + seg(x.no_level, 'gray') + '</div>' +
        '<div class="rs-outcome"><span><i class="rs-dot bad"></i>Out <strong>' + x.out + '</strong></span><span><i class="rs-dot warn"></i>Low <strong>' + x.low + '</strong></span><span><i class="rs-dot ok"></i>OK <strong>' + (x.ok + x.watch) + '</strong></span></div></div>';
    }).join('') + '</div>';
  }

  function table(d) {
    const rows = d.rows.slice(0, state.shown), dir = d.filters.dir;
    const th = (k, label, cls) => '<th class="sortable' + (state.sort === k ? ' on' + (dir === 'desc' ? ' desc' : '') : '') + (cls ? ' ' + cls : '') + '" data-k="' + k + '" title="Sort by ' + label.toLowerCase() + '">' + label + '</th>';
    const body = rows.map((r) => {
      const pct = r.coveragePct == null ? 0 : Math.min(100, r.coveragePct);
      return '<tr><td><span class="rs-sku">' + esc(r.sku) + '</span></td><td>' + esc(r.name) + (r.category ? '<span class="rs-dim" style="display:block">' + esc(r.category) + '</span>' : '') + '</td><td>' + esc(r.department) + '</td>' +
        '<td class="rs-num"><strong>' + num(r.onHand) + '</strong> <span class="rs-dim">' + esc(r.unit || '') + '</span></td><td class="rs-num">' + (r.reorderLevel ? num(r.reorderLevel) : '\u2014') + '</td>' +
        '<td class="rs-num">' + (r.status === 'low' || r.status === 'out' ? '<strong>' + num(r.shortage) + '</strong>' : '\u2014') + '</td>' +
        '<td><span class="rs-cover ' + r.status + '"><i style="width:' + pct.toFixed(0) + '%"></i></span>' + (r.coveragePct == null ? '\u2014' : r.coveragePct.toFixed(0) + '%') + '</td>' +
        '<td><span class="rs-status ' + r.status + '">' + LABEL[r.status] + '</span></td>' +
        '<td class="rs-num">' + (r.daysOfCover == null ? '\u2014' : num(r.daysOfCover) + ' d') + '</td><td class="rs-num">' + (r.usedLast30Days ? num(r.usedLast30Days) : '\u2014') + '</td>' +
        '<td>' + esc(r.supplier || '\u2014') + '<span class="rs-dim" style="display:block">last in: ' + day(r.lastReceipt) + '</span></td>' +
        '<td class="rs-num">' + (r.restockCost ? peso(r.restockCost) : '\u2014') + '</td>' +
        '<td>' + (r.status === 'low' || r.status === 'out' ? (r.notified ? '<span class="rs-yes">Alert raised</span>' : '<span class="rs-no">Not yet</span>') : '<span class="rs-no">\u2014</span>') + '</td></tr>';
    }).join('');
    const empty = d.summary.total === 0 ? 'No active products yet.' : state.status === 'attention' && !state.search && state.dept === 'all' ? 'Nothing needs restocking right now.' : 'No products match these filters.';
    return '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">Products</div><div class="panel-sub">' + num(d.count) + ' product' + (d.count === 1 ? '' : 's') + ' shown \u00B7 ' + esc(d.rule) + ' Shortage 0 means exactly at the level.</div></div></div>' +
      '<div class="rs-scroll"><table class="rs-table"><thead><tr><th>SKU</th>' + th('name', 'Product') + '<th>Department</th>' + th('on_hand', 'On hand', 'rs-num') + '<th class="rs-num">Reorder level</th>' + th('shortage', 'Shortage', 'rs-num') + '<th>Coverage</th>' + th('status', 'Status') + th('cover', 'Days of cover', 'rs-num') + '<th class="rs-num">Used 30 d</th><th>Supplier</th>' + th('cost', 'Restock cost', 'rs-num') + '<th>Notification</th></tr></thead><tbody>' +
      (body || '<tr><td colspan="13" class="rs-none">' + empty + '</td></tr>') + '</tbody></table></div>' +
      (d.rows.length > state.shown ? '<div class="rs-more"><button type="button" class="btn-secondary" id="lsMore">Show ' + Math.min(PAGE, d.rows.length - state.shown) + ' more</button></div>' : '') + '</div>';
  }

  function init() {
    build(); const page = $('reports'); if (!page || !state.built) return;
    const kick = () => { if (page.classList.contains('active-page') && !state.loadedOnce && !state.loading) load(); };
    new MutationObserver(kick).observe(page, { attributes: true, attributeFilter: ['class'] }); kick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
