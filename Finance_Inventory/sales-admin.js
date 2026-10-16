/* sales-admin.js — admin "Sales Transactions" page.
   Shows every POS sale (cashier) and every online order (shop) in one list, and lets the admin move
   online orders through their steps, cancel them, and answer cancel / void requests.
   The server checks every rule again; the checks here only give faster feedback. */
(function () {
  'use strict';

  const TZ = 'Asia/Manila';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (ms) => new Date(ms).toLocaleString('en-PH', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });          // YYYY-MM-DD in Manila time

  const FINAL = ['Delivered', 'Picked Up'];
  const STEP_LABEL = { Paid: 'Confirm payment', Packed: 'Mark packed', 'Out for Delivery': 'Out for delivery',
    'Ready for Pickup': 'Ready for pickup', Delivered: 'Mark delivered', 'Picked Up': 'Mark picked up' };
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
      '<div class="sa-source-tabs" role="tablist" aria-label="Transaction source"><button type="button" class="sa-source-tab active" data-source-tab="POS" role="tab" aria-selected="true">POS Transactions</button><button type="button" class="sa-source-tab" data-source-tab="Shop" role="tab" aria-selected="false">Online Orders</button></div>' +
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
      card('pending', 'Awaiting payment confirmation', pending, 'online orders to confirm', pending ? 'warn' : '') +
      card('progress', 'Being fulfilled', prog, 'paid, packed or on the way') +
      card('decision', 'Needs your decision', dec, 'cancel, void or return requests', dec ? 'bad' : '');
    updateBadge();
  }

  function updateBadge() {
    const nav = document.querySelector('.nav-item[data-page="sales"]');
    if (!nav) return;
    const n = sales.filter((s) => s.status === 'Pending Confirmation' || hasRequest(s)).length;
    let b = nav.querySelector('.sa-nav-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'sa-nav-badge'; nav.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    b.title = n + ' order(s) need attention';
  }

  function render() {
    if (!built) return;
    renderKpis();
    const rows = filtered();
    const part = rows.slice(0, shown);
    $('saSub').textContent = sourceTab === 'POS' ? 'POS transactions — select a row to view details' : 'Online orders — select a row to view details';
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

    h += '<div class="sa-banner ok">Read-only transaction details. Use POS Management or Online Orders to process transactions.</div>';
    $('saModalBody').innerHTML = h;
    if (pendingErr) { showErr(pendingErr); pendingErr = null; }
  }

  function actionsHtml(s) {
    if (s.cancelRequest)
      return '<div class="sa-banner warn"><strong>The customer asked to cancel this order.</strong><br>Reason: ' + esc(s.cancelRequest.reason) + '</div>' +
        '<div class="sa-actions"><button type="button" class="btn-danger" id="saApproveCancel">Approve cancellation</button><button type="button" class="btn-secondary" id="saRejectCancel">Reject request</button></div>' +
        '<p class="sa-count" style="text-align:left;margin-top:8px">Approving cancels the order' + (s.status === 'Pending Confirmation' ? '.' : ' and puts the stock back. A refund to the original payment method is then due.') + ' Rejecting keeps the order going.</p>';
    if (s.returnRequest) {
      const r = s.returnRequest;
      return '<div class="sa-banner warn"><strong>The cashier sent a return (' + esc(r.returnNo) + ').</strong><br>' + r.items.map((i) => esc(i.qty + ' ' + i.unit + ' ' + i.name + ' \u2014 ' + peso(i.amount))).join('<br>') +
        '<br>Refund: <strong>' + peso(r.amount) + '</strong> (' + (r.refundMethod === 'Cash' ? 'cash from ' + esc(r.requestedBy || 'the cashier') + '\u2019s drawer' : 'back to the original payment method \u2014 do this outside the POS') + ')<br>Reason: ' + esc(r.reason) + '</div>' +
        '<div class="sa-form"><label class="sa-check"><input type="checkbox" id="saRestock" checked> The items are in resellable condition \u2014 put them back in stock</label>' +
        '<label for="saNote" style="margin-top:8px">Note (required if you reject)</label><textarea id="saNote" class="sa-in" maxlength="200" placeholder="Shown in the audit log"></textarea><div class="sa-count"><span id="saNoteN">0</span> / 200</div><div class="sa-err" id="saNoteErr"></div></div>' +
        '<div class="sa-actions"><button type="button" class="btn-primary" id="saApproveReturn">Approve return</button><button type="button" class="btn-secondary" id="saRejectReturn">Reject request</button></div>' +
        '<p class="sa-count" style="text-align:left;margin-top:8px">Approving records the refund' + (r.refundMethod === 'Cash' ? ' against the cashier\u2019s open cash shift' : '') + ' and keeps the rest of the sale as it is. Everything is written to the audit log.</p>';
    }
    if (s.voidRequest)
      return '<div class="sa-banner warn"><strong>The cashier asked to void this sale.</strong><br>Reason: ' + esc(s.voidRequest.reason) + '</div>' +
        '<div class="sa-actions"><button type="button" class="btn-danger" id="saApproveVoid">Approve void</button><button type="button" class="btn-secondary" id="saRejectVoid">Reject request</button></div>' +
        '<p class="sa-count" style="text-align:left;margin-top:8px">Approving voids the sale and puts every item back in stock.</p>';
    if (s.source === 'POS') return '<div class="sa-banner ok">POS sales are completed at the counter. If something went wrong, the cashier sends a void request; if a customer brings back some items, the cashier sends a return. Both show up here for you to approve.</div>';
    if (s.status === 'Cancelled') return '<div class="sa-banner bad">Closed: cancelled orders cannot be changed.</div>';
    if (FINAL.includes(s.status)) return '<div class="sa-banner ok">Completed: this order is closed' + (s.receivedBy ? ' (received by ' + esc(s.receivedBy) + ')' : '') + '.</div>';
    if (!s.next) return '';
    const fin = FINAL.includes(s.next);
    return '<div class="sa-form">' +
      (s.next === 'Paid' ? '<div class="sa-banner warn">Confirm only when the payment is in (gateway approved, or cash collected). This takes the items out of stock' + '.</div>' : '') +
      (fin ? '<label for="saRecv">' + (s.fulfillment === 'Delivery' ? 'Received by' : 'Picked up by') + ' <span style="color:#ef7a7a">*</span></label><input type="text" id="saRecv" class="sa-in" maxlength="80" placeholder="Full name of the person" autocomplete="off"><div class="sa-err" id="saRecvErr"></div>' : '') +
      '<label for="saNote">Note (optional)</label><textarea id="saNote" class="sa-in" maxlength="200" placeholder="e.g. rider name, plate number, remarks"></textarea>' +
      '<div class="sa-count"><span id="saNoteN">0</span> / 200</div><div class="sa-err" id="saNoteErr"></div>' +
      '<div class="sa-actions"><button type="button" class="btn-primary" id="saAdvance">' + esc(STEP_LABEL[s.next] || 'Mark as ' + s.next) + '</button>' +
      (s.canCancel ? '<button type="button" class="sa-link-danger" id="saCancelOpen">Cancel this order\u2026</button>' : '') + '</div></div>' +
      '<div id="saCancelBox" style="display:none"><div class="sa-form"><label for="saReason">Why is this order being cancelled? <span style="color:#ef7a7a">*</span></label>' +
      '<textarea id="saReason" class="sa-in" maxlength="300" placeholder="Required, at least 5 characters"></textarea><div class="sa-err" id="saReasonErr"></div>' +
      '<div class="sa-actions"><button type="button" class="btn-danger" id="saCancelGo">Cancel order</button><button type="button" class="btn-secondary" id="saCancelBack">Keep order</button></div></div></div>';
  }

  function showErr(e) {
    const box = $('saModalErr'); if (!box) return;
    box.textContent = e.message || 'Something went wrong.'; box.classList.add('show');
    const f = e.fields || {};
    [['receivedBy', 'saRecv', 'saRecvErr'], ['note', 'saNote', 'saNoteErr'], ['reason', 'saReason', 'saReasonErr']].forEach(([k, input, err]) => {
      if (f[k] && $(err)) { $(err).textContent = f[k]; if ($(input)) $(input).classList.add('sa-bad'); }
    });
  }
  function clearErr() {
    const box = $('saModalErr'); if (box) { box.textContent = ''; box.classList.remove('show'); }
    ['saRecvErr', 'saNoteErr', 'saReasonErr'].forEach((id) => { if ($(id)) $(id).textContent = ''; });
    ['saRecv', 'saNote', 'saReason'].forEach((id) => { if ($(id)) $(id).classList.remove('sa-bad'); });
  }
  function fieldErr(input, err, msg) { if ($(input)) $(input).classList.add('sa-bad'); if ($(err)) $(err).textContent = msg; const first = $(input); if (first) first.focus(); }

  // runs one action, then reloads the list and repaints the dialog from fresh data
  async function run(doneMessage, fn) {
    if (busy) return;
    busy = true; clearErr();
    overlay.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await fn();
      toast(doneMessage);
      await load(true);
    } catch (e) {
      if (e.message === 'Not signed in') return;
      pendingErr = e;
      await load(true).catch(() => {});                 // the order may have changed somewhere else — show it as it is now
    } finally { busy = false; }
    if (openRef) paintModal();
  }

  // asks "are you sure?" in place of the buttons for actions that move stock or cannot be undone
  function ask(message, yesLabel, fn) {
    const box = $('saActions');
    const kids = Array.from(box.children).map((k) => ({ k, d: k.style.display }));
    kids.forEach((x) => { x.k.style.display = 'none'; });                       // hide (not remove) so typed text is kept
    const q = document.createElement('div');
    q.innerHTML = '<div class="sa-banner warn">' + esc(message) + '</div><div class="sa-actions"><button type="button" class="btn-danger" id="saYes">' + esc(yesLabel) + '</button><button type="button" class="btn-secondary" id="saNo">Go back</button></div>';
    box.appendChild(q);
    q.querySelector('#saYes').addEventListener('click', fn);
    q.querySelector('#saNo').addEventListener('click', () => { q.remove(); kids.forEach((x) => { x.k.style.display = x.d; }); });
  }

  function wireActions(s) {
    if (!s) return;
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    const note = $('saNote');
    if (note) note.addEventListener('input', () => { $('saNoteN').textContent = note.value.length; });

    on('saAdvance', () => {
      clearErr();
      const nt = note ? note.value.trim() : '', recv = $('saRecv') ? $('saRecv').value.trim().replace(/\s+/g, ' ') : '';
      if (nt.length > 200) return fieldErr('saNote', 'saNoteErr', 'The note must be 200 characters or fewer');
      if (FINAL.includes(s.next) && (recv.length < 2 || recv.length > 80)) return fieldErr('saRecv', 'saRecvErr', 'Enter the name of the person (2\u201380 characters)');
      const go = () => run(s.ref + ' is now ' + s.next + '.', () => post('/orders/' + encodeURIComponent(s.ref) + '/status', { status: s.next, note: nt, receivedBy: recv }));
      if (s.next === 'Paid') ask('Confirm payment for ' + s.ref + ' (' + peso(s.total) + ')? Stock will be deducted for ' + s.items.length + ' item(s).', 'Yes, confirm payment', go);
      else go();
    });
    on('saCancelOpen', () => { $('saCancelBox').style.display = ''; $('saCancelBox').scrollIntoView({ block: 'nearest' }); $('saReason').focus(); });
    on('saCancelBack', () => { $('saCancelBox').style.display = 'none'; clearErr(); });
    on('saCancelGo', () => {
      clearErr();
      const reason = $('saReason').value.trim().replace(/\s+/g, ' ');
      if (reason.length < 5 || reason.length > 300) return fieldErr('saReason', 'saReasonErr', 'Please explain why (5 to 300 characters)');
      ask('Cancel ' + s.ref + '? ' + (s.status === 'Pending Confirmation' ? 'No stock has been taken yet.' : 'The items go back into stock and a refund to the customer is due.') + ' This cannot be undone.', 'Yes, cancel order',
        () => run(s.ref + ' was cancelled.', () => post('/orders/' + encodeURIComponent(s.ref) + '/cancel', { reason })));
    });
    on('saApproveCancel', () => ask('Approve the cancellation of ' + s.ref + '? This cannot be undone.', 'Yes, approve',
      () => run('Cancellation approved.', () => post('/orders/' + encodeURIComponent(s.ref) + '/cancel-decision', { approve: true }))));
    on('saRejectCancel', () => run('Cancellation request rejected.', () => post('/orders/' + encodeURIComponent(s.ref) + '/cancel-decision', { approve: false })));
    on('saApproveReturn', () => {
      clearErr();
      const nt = note ? note.value.trim() : '', restock = !!($('saRestock') && $('saRestock').checked), r = s.returnRequest;
      if (nt.length > 200) return fieldErr('saNote', 'saNoteErr', 'The note must be 200 characters or fewer');
      ask('Approve ' + r.returnNo + ' and refund ' + peso(r.amount) + '? ' + (restock ? 'The items go back into stock.' : 'The items will NOT go back into stock.') + ' This cannot be undone.', 'Yes, approve return',
        () => run('Return approved' + (restock ? ' and stock restored.' : '.'), () => post('/pos/return-requests/' + encodeURIComponent(r.id) + '/decision', { approve: true, restock, note: nt })));
    });
    on('saRejectReturn', () => {
      clearErr();
      const nt = note ? note.value.trim() : '';
      if (nt.length < 5 || nt.length > 200) return fieldErr('saNote', 'saNoteErr', 'Tell the cashier why (5 to 200 characters)');
      run('Return rejected.', () => post('/pos/return-requests/' + encodeURIComponent(s.returnRequest.id) + '/decision', { approve: false, note: nt }));
    });
    on('saApproveVoid', () => ask('Void sale ' + s.ref + '? All items go back into stock. This cannot be undone.', 'Yes, void sale',
      () => run('Sale voided and stock returned.', () => post('/pos/void-requests/' + encodeURIComponent(s.voidRequest.id) + '/decision', { approve: true }))));
    on('saRejectVoid', () => run('Void request rejected.', () => post('/pos/void-requests/' + encodeURIComponent(s.voidRequest.id) + '/decision', { approve: false })));
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
