/* sales-orders.js — Finance "Sales Transactions" page.
   Shows online orders (and POS walk-in sales) from the database and lets Finance move an order to its next status.
   Loaded after api-bridge.js in Finance_Inventory.html. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (t) => new Date(t).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let ORDERS = [], POS = [];

  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = 'app-toast' + (err ? ' error' : '');
    el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 4000);
  }
  async function api(path, opts) {
    const r = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts));
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }
  const pill = (st) => {
    const c = ['Delivered', 'Picked Up', 'Completed'].includes(st) ? 'in'
      : ['Cancelled', 'Voided'].includes(st) ? 'out'
      : ['Pending Confirmation', 'Void Pending'].includes(st) ? 'low' : 'watch';
    return '<span class="status-pill ' + c + '">' + esc(st) + '</span>';
  };
  const actionLabel = (next) => next === 'Paid' ? 'Confirm payment' : 'Mark ' + next;

  async function load() {
    try {
      const [o, p] = await Promise.all([api('/orders'), api('/pos/sales')]);
      ORDERS = o; POS = p; render();
    } catch (e) { $('soSub').textContent = e.message; }
  }

  function render() {
    const view = $('soView').value, q = $('soSearch').value.trim().toLowerCase(), st = $('soStatus').value;
    const cashView = view === 'payments' || view === 'shifts';
    if ($('soTableWrap')) $('soTableWrap').hidden = cashView;
    if ($('soCash')) $('soCash').hidden = !cashView;
    $('soSearch').style.display = cashView ? 'none' : '';
    if (cashView) { $('soStatus').style.display = 'none'; if (window.CashReports) window.CashReports.show(view); return; }
    $('soStatus').style.display = view === 'orders' ? '' : 'none';
    if (view === 'orders') {
      const rows = ORDERS.filter(o => (st === 'all' || o.status === st) &&
        (!q || (o.id + ' ' + o.customer + ' ' + o.items.map(i => i.name + ' ' + i.sku).join(' ')).toLowerCase().includes(q)));
      $('soTitle').textContent = 'Online Orders';
      $('soSub').textContent = rows.length + ' of ' + ORDERS.length + ' orders';
      $('soHead').innerHTML = '<tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Type / Payment</th><th>Status</th><th>Action</th></tr>';
      $('soBody').innerHTML = rows.length ? rows.map(o => {
        const items = o.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>');
        let act = '';
        if (o.cancelRequested) act = '<button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="1">Approve cancel</button> <button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="0">Reject</button>';
        else if (o.next) act = '<button class="btn-primary btn-sm" data-so-next="' + esc(o.id) + '" data-to="' + esc(o.next) + '">' + esc(actionLabel(o.next)) + '</button>';
        else act = '<span class="faint">—</span>';
        return '<tr><td>' + esc(o.id) + '</td><td>' + esc(when(o.createdAt)) + '</td><td>' + esc(o.customer) +
          (o.address ? '<div class="faint" style="font-size:12px">' + esc(o.address) + '</div>' : '') +
          '<div class="faint" style="font-size:12px">' + esc(o.phone) + '</div></td><td>' + items + '</td><td>' + peso(o.total) +
          '</td><td>' + esc(o.fulfillment) + '<div class="faint" style="font-size:12px">' + esc(o.method) + '</div></td><td>' + pill(o.status) +
          (o.cancelRequested ? '<div class="faint" style="font-size:12px">Cancel requested</div>' : '') + '</td><td style="white-space:nowrap">' + act + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="report-note">No orders yet. Orders placed in the shop appear here.</td></tr>';
    } else {
      const rows = POS.filter(s => !q || (s.receiptNo + ' ' + s.cashierName + ' ' + s.items.map(i => i.name).join(' ')).toLowerCase().includes(q));
      const live = rows.filter(s => s.status !== 'Voided');
      $('soTitle').textContent = 'POS Walk-in Sales (today)';
      $('soSub').textContent = rows.length + ' sales · ' + peso(live.reduce((n, s) => n + s.total, 0)) + ' collected';
      $('soHead').innerHTML = '<tr><th>Receipt</th><th>Time</th><th>Cashier</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th></tr>';
      $('soBody').innerHTML = rows.length ? rows.map(s => '<tr><td>' + esc(s.receiptNo) + '</td><td>' + esc(when(s.createdAt)) + '</td><td>' + esc(s.cashierName) + '</td><td>' +
        s.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>') + '</td><td>' + peso(s.total) + '</td><td>' + esc(s.method) + '</td><td>' + pill(s.status) + '</td></tr>').join('')
        : '<tr><td colspan="7" class="report-note">No POS sales today.</td></tr>';
    }
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-so-next],[data-so-cancel]'); if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.soNext) {
        const r = await api('/orders/' + encodeURIComponent(b.dataset.soNext) + '/advance', { method: 'POST', body: JSON.stringify({ status: b.dataset.to }) });
        toast(b.dataset.soNext + ' is now ' + r.status + '. The customer can see it.');
      } else {
        await api('/orders/' + encodeURIComponent(b.dataset.soCancel) + '/cancel-decision', { method: 'POST', body: JSON.stringify({ approve: b.dataset.ok === '1' }) });
        toast(b.dataset.ok === '1' ? 'Cancellation approved. Stock restored.' : 'Cancellation rejected.');
      }
      await load();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });

  ['soView', 'soStatus'].forEach(id => $(id) && $(id).addEventListener('change', render));
  $('soSearch') && $('soSearch').addEventListener('input', render);
  $('soRefresh') && $('soRefresh').addEventListener('click', load);
  document.querySelectorAll('.nav-item[data-page="sales"]').forEach(n => n.addEventListener('click', load));
  if ($('sales') && $('sales').classList.contains('active-page')) load();
})();
