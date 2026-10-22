/* sales-admin.js — Finance "Sales Overview" page (read-only).
   Shows every POS sale and every online order in one ledger, with totals and profit. The cashier processes the
   transactions (POS > Online Orders); Finance only monitors them here. Cancel / void / return requests are decided
   on the Online Orders and POS Sales & Shifts pages (see sales-orders.js); each request is flagged here and links there. */
(function () {
  'use strict';

  const TZ = 'Asia/Manila';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (ms) => new Date(ms).toLocaleString('en-PH', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });          // YYYY-MM-DD in Manila time

  const FINAL = ['Delivered', 'Picked Up'];
  const PILL = { 'Pending Confirmation': 'warn', Paid: 'info', Packed: 'info', 'Out for Delivery': 'info', 'Ready for Pickup': 'info',
    Delivered: 'ok', 'Picked Up': 'ok', Cancelled: 'bad', Completed: 'ok', 'Void Pending': 'warn', Voided: 'bad' };
  const STATUSES = ['Pending Confirmation', 'Paid', 'Packed', 'Out for Delivery', 'Ready for Pickup', 'Delivered', 'Picked Up', 'Cancelled', 'Completed', 'Void Pending', 'Voided'];

  let sourceTab = 'POS';
  let sales = [], FLOW = {}, quick = 'all', shown = 100, openRef = null, busy = false, pendingErr = null, built = false, loading = false;

  /* ---------- small helpers ---------- */
  async function api(path, options) {
    const res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields });
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'app-toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
  const pageActive = () => { const s = $('sales-overview'); return !!(s && s.classList.contains('active-page')); };
  const hasRequest = (s) => !!(s.cancelRequest || s.voidRequest || s.returnRequest);
  const inProgress = (s) => s.source === 'Shop' && !!s.next && s.status !== 'Pending Confirmation';
  // money only counts once it is real: POS sale not voided, online order confirmed and not cancelled
  const realized = (s) => (s.source === 'POS' ? ['Completed', 'Void Pending'].includes(s.status) : !['Pending Confirmation', 'Cancelled'].includes(s.status));
  const pill = (st) => '<span class="sa-pill ' + (PILL[st] || 'info') + '">' + esc(st) + '</span>';
  const byRef = (ref) => sales.find((s) => s.ref === ref);

  /* ---------- page skeleton ---------- */
  function build() {
    const root = $('salesAdminRoot');
    if (!root || built) return;
    built = true;
    root.innerHTML =
      '<div class="sa-kpis" id="saKpis"></div>' +
      '<div style="margin:16px 0 12px"><div style="font-size:11.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-faint);margin-bottom:6px">Ledger Channel View</div><div class="sa-source-tabs" role="tablist" aria-label="Transaction channel"><button type="button" class="sa-source-tab active" data-source-tab="POS" role="tab" aria-selected="true">In-Store Counter (POS)</button><button type="button" class="sa-source-tab" data-source-tab="Shop" role="tab" aria-selected="false">Online Customer Orders</button></div></div>' +
      '<div class="panel sales-log-panel">' +
        '<div class="panel-head">' +
          '<div><div class="panel-title">Combined Transaction Ledger</div><div class="panel-sub" id="saSub">Loading…</div></div>' +
          '<div class="sa-filters">' +
            '<input type="text" id="saSearch" class="inv-search" placeholder="Search ref, customer, product, phone…" autocomplete="off">' +
            
            '<select id="saStatus" class="inv-select"><option value="all">All statuses</option>' + STATUSES.map((s) => '<option>' + s + '</option>').join('') + '</select>' +
            '<label class="sa-date">From <input type="date" id="saFrom"></label>' +
            '<label class="sa-date">To <input type="date" id="saTo"></label>' +
            '<button type="button" class="btn-secondary btn-sm" id="saReset">Reset</button>' +
            '<button type="button" class="btn-secondary btn-sm" id="saExport">Export CSV</button>' +
            '<div class="sa-filter-msg" id="saFilterMsg"></div>' +
          '</div>' +
        '</div>' +
        '<div class="table-wrapper"><table class="sa-table"><thead><tr>' +
          '<th>Ref</th><th>Date</th><th>Source</th><th>Customer</th><th>Items</th><th>Type</th><th>Payment</th>' +
          '<th class="sa-num">Total</th><th class="sa-num">Est. profit</th><th>Status</th>' +
        '</tr></thead><tbody id="saBody"></tbody></table></div>' +
        '<div class="sa-foot"><span id="saCount"></span><button type="button" class="btn-secondary btn-sm" id="saMore" style="display:none">Show more</button></div>' +
      '</div>';

    ['saSearch', 'saStatus', 'saFrom', 'saTo'].forEach((id) => {
      $(id).addEventListener(id === 'saSearch' ? 'input' : 'change', () => { shown = 100; render(); });
    });
    $('saReset').addEventListener('click', () => {
      $('saSearch').value = ''; $('saStatus').value = 'all'; $('saFrom').value = ''; $('saTo').value = '';
      quick = 'all'; shown = 100; render();
    });
    $('saMore').addEventListener('click', () => { shown += 100; render(); });
    $('saExport').addEventListener('click', exportCsv);
    $('saKpis').addEventListener('click', (e) => {
      const b = e.target.closest('[data-quick]'); if (!b) return;
      quick = quick === b.dataset.quick ? 'all' : b.dataset.quick; shown = 100; render();
    });
    root.querySelectorAll('[data-source-tab]').forEach((tab) => tab.addEventListener('click', () => {
      sourceTab = tab.dataset.sourceTab; shown = 100;
      root.querySelectorAll('[data-source-tab]').forEach((b) => { const active = b === tab; b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); });
      render();
    }));
    $('saBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-ref]'); if (tr) openModal(tr.dataset.ref);
    });
    $('saBody').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-ref]'); if (tr) { e.preventDefault(); openModal(tr.dataset.ref); }
    });
  }

  /* ---------- list ---------- */
  function filtered() {
    const term = $('saSearch').value.trim().toLowerCase();
    const src = sourceTab, st = $('saStatus').value, from = $('saFrom').value, to = $('saTo').value;
    const today = dayKey(Date.now());
    const msg = $('saFilterMsg');
    const badRange = !!(from && to && from > to);
    $('saFrom').classList.toggle('sa-bad', badRange); $('saTo').classList.toggle('sa-bad', badRange);
    msg.textContent = badRange ? 'The "From" date cannot be after the "To" date.' : '';
    if (badRange) return [];
    return sales.filter((s) => {
      if (quick === 'today' && !(dayKey(s.createdAt) === today && realized(s))) return false;
      if (quick === 'pending' && s.status !== 'Pending Confirmation') return false;
      if (quick === 'progress' && !inProgress(s)) return false;
      if (quick === 'decision' && !hasRequest(s)) return false;
      if (src !== 'all' && s.source !== src) return false;
      if (st !== 'all' && s.status !== st) return false;
      const d = dayKey(s.createdAt);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (term) {
        const hay = [s.ref, s.customer, s.phone, s.method, s.cashier, s.fulfillment].concat(s.items.map((i) => i.name + ' ' + i.sku)).join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }

  function renderKpis() {
    const today = dayKey(Date.now());
    const todays = sales.filter((s) => dayKey(s.createdAt) === today && realized(s));
    const pending = sales.filter((s) => s.status === 'Pending Confirmation').length;
    const prog = sales.filter(inProgress).length;
    const dec = sales.filter(hasRequest).length;
    const card = (key, label, value, sub, cls) =>
      '<button type="button" class="sa-kpi ' + (cls || '') + (quick === key ? ' on' : '') + '" data-quick="' + key + '">' +
      '<div class="sa-kpi-label">' + label + '</div><div class="sa-kpi-value">' + value + '</div><div class="sa-kpi-sub">' + sub + '</div></button>';
    $('saKpis').innerHTML =
      card('today', 'Today\u2019s sales', peso(todays.reduce((n, s) => n + s.revenue, 0)), todays.length + ' confirmed transaction' + (todays.length === 1 ? '' : 's')) +
      card('pending', 'Waiting for the cashier', pending, 'new online orders not yet confirmed', pending ? 'warn' : '') +
      card('progress', 'Being fulfilled', prog, 'with the cashier: paid, packed or on the way') +
      card('decision', 'Needs your decision', dec, 'cancel, void or return requests to answer', dec ? 'bad' : '');
    updateBadge();
  }

  // Count only what Finance must answer. Online Orders: customer cancellation requests. POS Sales & Shifts: void / return requests.
  function badge(page, n, title) {
    const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
    if (!nav) return;
    let b = nav.querySelector('.sa-nav-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'sa-nav-badge'; nav.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    b.title = n + ' ' + title;
  }
  function updateBadge() {
    badge('orders', sales.filter((s) => s.source === 'Shop' && s.cancelRequest).length, 'cancellation request(s) to answer');
    badge('sales', sales.filter((s) => s.source === 'POS' && (s.voidRequest || s.returnRequest)).length, 'void / return request(s) to answer');
  }

  function render() {
    if (!built) return;
    renderKpis();
    const rows = filtered();
    const part = rows.slice(0, shown);
    $('saSub').textContent = (sourceTab === 'POS' ? 'POS transactions' : 'Online orders') + ' \u2014 read-only, select a row to view details';
    $('saBody').innerHTML = part.length ? part.map((s) => {
      const count = s.items.reduce((n, i) => n + i.qty, 0);
      return '<tr tabindex="0" role="button" aria-label="View transaction ' + esc(s.ref) + '" data-ref="' + esc(s.ref) + '">' +
        '<td class="sa-ref">' + esc(s.ref) + '</td>' +
        '<td>' + esc(fmtDate(s.createdAt)) + '</td>' +
        '<td><span class="sa-src ' + (s.source === 'POS' ? 'pos' : 'shop') + '">' + (s.source === 'POS' ? 'POS' : 'SHOP') + '</span></td>' +
        '<td>' + esc(s.customer) + (s.source === 'POS' && s.cashier ? '<span class="sa-sub">Cashier: ' + esc(s.cashier) + '</span>' : '') + '</td>' +
        '<td>' + s.items.length + ' item' + (s.items.length === 1 ? '' : 's') + '<span class="sa-sub">' + count + ' qty</span></td>' +
        '<td>' + esc(s.fulfillment) + '</td>' +
        '<td>' + esc(s.method) + '</td>' +
        '<td class="sa-num">' + peso(s.total) + '</td>' +
        '<td class="sa-num">' + (realized(s) ? peso(s.profit) : '\u2014') + '</td>' +
        '<td>' + pill(s.status) + (hasRequest(s) ? '<span class="sa-flag">' + (s.cancelRequest ? 'Cancel requested' : s.voidRequest ? 'Void requested' : 'Return requested') + '</span>' : '') + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="10" class="sa-empty">' + (sales.length ? 'No transactions match these filters.' : 'No sales yet. Sales made at the POS and orders placed in the shop appear here automatically.') + '</td></tr>';
    $('saCount').textContent = rows.length ? 'Showing ' + part.length + ' of ' + rows.length + ' transaction' + (rows.length === 1 ? '' : 's') : '';
    $('saMore').style.display = rows.length > part.length ? '' : 'none';
  }

  function exportCsv() {
    const rows = filtered();
    if (!rows.length) { toast('Nothing to export for these filters.', 'error'); return; }
    const cell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const head = ['Ref', 'Date', 'Source', 'Customer', 'Type', 'Payment', 'Items', 'Subtotal', 'Delivery fee', 'Total', 'Est. profit', 'Status'];
    const lines = [head].concat(rows.map((s) => [s.ref, fmtDate(s.createdAt), s.source, s.customer, s.fulfillment, s.method,
      s.items.map((i) => i.qty + ' x ' + i.name).join('; '), s.subtotal.toFixed(2), s.deliveryFee.toFixed(2), s.total.toFixed(2), s.profit.toFixed(2), s.status]));
    const blob = new Blob(['\uFEFF' + lines.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'sales-transactions-' + dayKey(Date.now()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- data ---------- */
  async function load(force) {
    if (loading && !force) return;
    loading = true;
    try {
      const data = await api('/sales');
      sales = Array.isArray(data.sales) ? data.sales : [];
      FLOW = data.flow || FLOW;
      if (built && !(openRef && !force)) render();
      else updateBadge();
    } catch (e) {
      if (e.message === 'Not signed in') return;
      if (built && !sales.length) $('saBody').innerHTML = '<tr><td colspan="10" class="sa-empty">Could not load sales: ' + esc(e.message) + ' <button type="button" class="btn-secondary btn-sm" id="saRetry">Try again</button></td></tr>';
      const r = $('saRetry'); if (r) r.addEventListener('click', () => load(true));
    } finally { loading = false; }
  }

  /* ---------- detail dialog ---------- */
  let overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'saOverlay';
    overlay.innerHTML = '<div class="account-modal sa-modal" role="dialog" aria-modal="true" aria-labelledby="saTitle"><button type="button" class="modal-close" id="saClose" aria-label="Close">\u00D7</button><div id="saModalBody"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !busy) closeModal(); });
    overlay.addEventListener('click', (e) => {
      const go = e.target.closest('[data-sa-go]'); if (!go) return;
      closeModal();
      if (typeof window.navigateToPage === 'function') window.navigateToPage(go.dataset.saGo);
    });
    $('saClose').addEventListener('click', () => { if (!busy) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openRef && !busy) closeModal(); });
    return overlay;
  }
  function closeModal() { openRef = null; pendingErr = null; if (overlay) overlay.classList.remove('open'); render(); }
  function openModal(ref) { openRef = ref; pendingErr = null; paintModal(); ensureOverlay().classList.add('open'); }

  function infoRow(label, value) { return value ? '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>' : ''; }

  function paintModal() {
    const s = byRef(openRef);
    ensureOverlay();
    if (!s) { closeModal(); return; }
    const flow = s.source === 'Shop' ? (FLOW[s.fulfillment] || []) : [];
    const at = flow.indexOf(s.status);
    let h = '<div class="sa-head"><h2 id="saTitle">' + esc(s.ref) + '</h2>' + pill(s.status) +
      '<span class="sa-src ' + (s.source === 'POS' ? 'pos' : 'shop') + '">' + (s.source === 'POS' ? 'POS SALE' : 'ONLINE ORDER') + '</span></div>';

    if (flow.length && s.status !== 'Cancelled')
      h += '<ol class="sa-steps">' + flow.map((st, i) => '<li class="' + (i < at ? 'done' : i === at ? 'now' : '') + '">' + esc(st) + '</li>').join('') + '</ol>';
    if (s.status === 'Cancelled') h += '<div class="sa-banner bad">This order was cancelled.</div>';
    if (s.status === 'Voided') h += '<div class="sa-banner bad">This sale was voided and its stock was returned.</div>';

    h += '<dl class="sa-info">' +
      infoRow('Date', fmtDate(s.createdAt)) + infoRow('Customer', s.customer) + infoRow('Phone', s.phone) +
      infoRow('Type', s.fulfillment) + infoRow('Delivery address', s.address) + infoRow('Payment', s.method) +
      infoRow('Cashier', s.cashier) + infoRow('Card reference', s.cardRef) +
      infoRow('Cash received', s.tendered != null ? peso(s.tendered) : '') + infoRow('Change given', s.change != null ? peso(s.change) : '') +
      infoRow(s.fulfillment === 'Delivery' ? 'Received by' : 'Picked up by', s.receivedBy) + '</dl>';

    if (s.delivery) {
      const dl = s.delivery, d2 = (ms) => (ms ? fmtDate(ms) : '');
      h += '<div class="sa-h">Delivery</div><dl class="sa-info">' +
        infoRow('Delivered by', dl.courier) + infoRow('Rider', dl.driverName) + infoRow('Rider phone', dl.driverPhone) + infoRow('Plate number', dl.vehiclePlate) +
        infoRow('Tracking number', dl.trackingNo) + infoRow('Left on', d2(dl.dispatchedAt)) + infoRow('Delivered on', d2(dl.deliveredAt)) + infoRow('Customer confirmed', s.status === 'Delivered' ? (dl.customerReceivedAt ? d2(dl.customerReceivedAt) : 'Not yet') : '') + infoRow('Delivery note', dl.notes) +
        (dl.proofIds && dl.proofIds.length ? '<div><dt>Proof of delivery</dt><dd>' + dl.proofIds.map((id, i) => '<a href="/api/orders/' + encodeURIComponent(s.ref) + '/delivery-proof/' + id + '" target="_blank" rel="noopener">Photo ' + (i + 1) + '</a>').join(', ') + '</dd></div>' : '') + '</dl>';
    }
    h += '<div class="sa-h">Items</div><table class="sa-lines"><thead><tr><th>Product</th><th class="sa-num">Qty</th><th class="sa-num">Price</th><th class="sa-num">Amount</th></tr></thead><tbody>' +
      s.items.map((i) => '<tr><td>' + esc(i.name) + '<span class="sa-sub">' + esc(i.sku) + '</span></td><td class="sa-num">' + i.qty + ' ' + esc(i.unit) + '</td><td class="sa-num">' + peso(i.price) + '</td><td class="sa-num">' + peso(i.qty * i.price) + '</td></tr>').join('') +
      '</tbody></table><div class="sa-totals"><div><span>Subtotal</span><span>' + peso(s.subtotal) + '</span></div>' +
      (s.deliveryFee ? '<div><span>Delivery fee</span><span>' + peso(s.deliveryFee) + '</span></div>' : '') +
      (s.vat ? '<div><span>VAT included (12%)</span><span>' + peso(s.vat) + '</span></div>' : '') +
      (s.refunded ? '<div><span>Originally sold for</span><span>' + peso(s.originalTotal) + '</span></div><div><span>Returned and refunded</span><span>\u2212' + peso(s.refunded) + '</span></div>' : '') +
      '<div class="grand"><span>' + (s.refunded ? 'Net total (after returns)' : 'Total') + '</span><span>' + peso(s.total) + '</span></div>' +
      '<div><span>Est. cost of goods</span><span>' + peso(s.cost) + '</span></div><div><span>Est. profit</span><span>' + peso(s.profit) + '</span></div></div>';

    if (s.returns && s.returns.length)
      h += '<div class="sa-h">Returns</div><ul class="sa-hist">' + s.returns.map((r) =>
        '<li><strong>' + esc(r.returnNo) + ' \u2014 ' + esc(r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : 'Waiting for Finance') + '</strong> \u00B7 ' + peso(r.amount) +
        '<br>' + r.items.map((i) => esc(i.qty + ' ' + i.unit + ' ' + i.name)).join(', ') +
        '<br>' + esc(r.reason) + (r.status === 'approved' ? ' \u00B7 ' + (r.restock ? 'put back in stock' : 'not put back in stock') : '') + (r.note ? ' \u00B7 Finance: ' + esc(r.note) : '') +
        '<small>' + esc(fmtDate(r.requestedAt)) + ' \u00B7 requested by ' + esc(r.requestedBy || 'cashier') + '</small></li>').join('') + '</ul>';

    if (s.history && s.history.length)
      h += '<div class="sa-h">Status history</div><ul class="sa-hist">' + s.history.map((x) =>
        '<li><strong>' + esc(x.from && x.from !== x.to ? x.from + ' \u2192 ' + x.to : x.to) + '</strong>' + (x.note ? ' \u2014 ' + esc(x.note) : '') +
        '<small>' + esc(fmtDate(x.at)) + ' \u00B7 ' + esc(x.by) + '</small></li>').join('') + '</ul>';

    const req = s.cancelRequest ? 'The customer asked to cancel this order.' : s.voidRequest ? 'The cashier asked to void this sale.' : s.returnRequest ? 'The cashier sent a return request (' + s.returnRequest.returnNo + ').' : '';
    if (req) h += '<div class="sa-banner warn"><strong>' + esc(req) + '</strong><br>' + esc((s.cancelRequest || s.voidRequest || s.returnRequest).reason || '') + '</div>' +
      '<div class="sa-actions"><button type="button" class="btn-primary" data-sa-go="' + (s.source === 'Shop' ? 'orders' : 'sales') + '">Go to ' + (s.source === 'Shop' ? 'Online Orders' : 'POS Sales &amp; Shifts') + ' to decide</button></div>';
    h += '<div class="sa-banner ok">Read-only. The cashier processes ' + (s.source === 'Shop' ? 'online orders' : 'POS sales') + ' (POS &rarr; ' + (s.source === 'Shop' ? 'Online Orders' : 'Point of Sale') + '); Finance follows them here.</div>';
    $('saModalBody').innerHTML = h;
    if (pendingErr) { showErr(pendingErr); pendingErr = null; }
  }

  function showErr(e) {
    const box = $('saModalErr'); if (!box) return;
    box.textContent = e.message || 'Something went wrong.'; box.classList.add('show');
    const f = e.fields || {};
    [['receivedBy', 'saRecv', 'saRecvErr'], ['note', 'saNote', 'saNoteErr'], ['reason', 'saReason', 'saReasonErr']].forEach(([k, input, err]) => {
      if (f[k] && $(err)) { $(err).textContent = f[k]; if ($(input)) $(input).classList.add('sa-bad'); }
    });
  }

  /* ---------- start ---------- */
  function start() {
    const section = $('sales-overview');
    if (!section || !$('salesAdminRoot')) return;
    build();
    new MutationObserver(() => { if (pageActive()) load(true); }).observe(section, { attributes: true, attributeFilter: ['class'] });
    load(true);
    setInterval(() => { if (!document.hidden && !busy && !openRef) load(); }, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !openRef) load(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
