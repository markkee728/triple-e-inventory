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
  const LABELS = { Paid: 'Confirm payment', Packed: 'Mark packed', 'Out for Delivery': 'Out for delivery', 'Ready for Pickup': 'Ready for pickup', Delivered: 'Mark delivered', 'Picked Up': 'Mark picked up' };
  const actionLabel = (next) => LABELS[next] || 'Mark ' + next;
  const FINAL = ['Delivered', 'Picked Up'];
  // Small progress line under the status: done steps, the current step in bold, steps still to come in grey.
  const tracker = (o) => {
    const flow = o.flow || []; const at = flow.indexOf(o.status);
    if (!flow.length || o.status === 'Cancelled') return '';
    return '<div style="font-size:11.5px;margin-top:6px;line-height:1.5">' + flow.map((st, i) =>
      i < at ? '<span class="faint">' + esc(st) + '</span>' : i === at ? '<b>' + esc(st) + '</b>' : '<span class="faint" style="opacity:.55">' + esc(st) + '</span>').join(' <span class="faint">›</span> ') + '</div>';
  };

  async function load() {
    // Each list loads on its own so one failing request doesn't blank the others.
    const [o, p] = await Promise.allSettled([api('/orders'), api('/pos/sales')]);
    if (o.status === 'fulfilled') ORDERS = o.value; else $('soSub').textContent = o.reason.message;
    if (p.status === 'fulfilled') POS = p.value; else $('soPosSub').textContent = p.reason.message;
    if (o.status === 'fulfilled') renderOrders();
    if (p.status === 'fulfilled') renderPos();
    if (window.CashReports) window.CashReports.show();   // payment summary + cash shifts
  }

  function renderOrders() {
    const q = $('soSearch').value.trim().toLowerCase(), st = $('soStatus').value;
    const rows = ORDERS.filter(o => (st === 'all' || o.status === st) &&
      (!q || (o.id + ' ' + o.customer + ' ' + o.items.map(i => i.name + ' ' + i.sku).join(' ')).toLowerCase().includes(q)));
    $('soSub').textContent = rows.length + ' of ' + ORDERS.length + ' orders';
    $('soHead').innerHTML = '<tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Type / Payment</th><th>Status</th><th>Action</th></tr>';
    $('soBody').innerHTML = rows.length ? rows.map(o => {
      const items = o.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>');
      let act = '';
      if (o.cancelRequested) act = '<button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="1">Approve cancel</button> <button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="0">Reject</button>';
      else {
        if (o.next) act = '<button class="btn-primary btn-sm" data-so-next="' + esc(o.id) + '" data-to="' + esc(o.next) + '">' + esc(actionLabel(o.next)) + '</button>';
        if (o.canCancel) act += (act ? ' ' : '') + '<button class="btn-secondary btn-sm" data-so-abort="' + esc(o.id) + '">Cancel order</button>';
        if (!act) act = '<span class="faint">—</span>';
      }
      return '<tr><td>' + esc(o.id) + '</td><td>' + esc(when(o.createdAt)) + '</td><td>' + esc(o.customer) +
        (o.address ? '<div class="faint" style="font-size:12px">' + esc(o.address) + '</div>' : '') +
        '<div class="faint" style="font-size:12px">' + esc(o.phone) + '</div></td><td>' + items + '</td><td>' + peso(o.total) +
        '</td><td>' + esc(o.fulfillment) + '<div class="faint" style="font-size:12px">' + esc(o.method) + '</div></td><td>' + pill(o.status) +
        (o.cancelRequested ? '<div class="faint" style="font-size:12px">Cancel requested</div>' : '') + tracker(o) + '</td><td style="white-space:nowrap">' + act + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="report-note">No orders yet. Orders placed in the shop appear here.</td></tr>';
  }

  function renderPos() {
    const q = $('soPosSearch').value.trim().toLowerCase();
    const rows = POS.filter(s => !q || (s.receiptNo + ' ' + s.cashierName + ' ' + s.items.map(i => i.name).join(' ')).toLowerCase().includes(q));
    const live = rows.filter(s => s.status !== 'Voided');
    $('soPosSub').textContent = rows.length + ' sales · ' + peso(live.reduce((n, s) => n + s.total, 0)) + ' collected';
    $('soPosHead').innerHTML = '<tr><th>Receipt</th><th>Time</th><th>Cashier</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th></tr>';
    $('soPosBody').innerHTML = rows.length ? rows.map(s => '<tr><td>' + esc(s.receiptNo) + '</td><td>' + esc(when(s.createdAt)) + '</td><td>' + esc(s.cashierName) + '</td><td>' +
      s.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>') + '</td><td>' + peso(s.total) + '</td><td>' + esc(s.method) + '</td><td>' + pill(s.status) + '</td></tr>').join('')
      : '<tr><td colspan="7" class="report-note">No POS sales today.</td></tr>';
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-so-next],[data-so-cancel],[data-so-abort]'); if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.soNext) {
        const no = b.dataset.soNext, to = b.dataset.to, body = { status: to };
        if (FINAL.includes(to)) {                         // the server needs the name of the person who received the order
          const who = window.prompt('Who ' + (to === 'Delivered' ? 'received the delivery' : 'picked up the order') + '? (2–80 characters)');
          if (who === null) { b.disabled = false; return; }
          body.receivedBy = who.trim();
        }
        await api('/orders/' + encodeURIComponent(no) + '/status', { method: 'POST', body: JSON.stringify(body) });
        toast(no + ' is now ' + to + '. The customer can see it.');
      } else if (b.dataset.soAbort) {
        const why = window.prompt('Why is this order being cancelled? (5–300 characters)\nStock is put back if it was already deducted.');
        if (why === null) { b.disabled = false; return; }
        await api('/orders/' + encodeURIComponent(b.dataset.soAbort) + '/cancel', { method: 'POST', body: JSON.stringify({ reason: why.trim() }) });
        toast(b.dataset.soAbort + ' was cancelled.');
      } else {
        await api('/orders/' + encodeURIComponent(b.dataset.soCancel) + '/cancel-decision', { method: 'POST', body: JSON.stringify({ approve: b.dataset.ok === '1' }) });
        toast(b.dataset.ok === '1' ? 'Cancellation approved. Stock restored.' : 'Cancellation rejected.');
      }
      await load();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });

  $('soStatus') && $('soStatus').addEventListener('change', renderOrders);
  $('soSearch') && $('soSearch').addEventListener('input', renderOrders);
  $('soPosSearch') && $('soPosSearch').addEventListener('input', renderPos);
  $('soRefresh') && $('soRefresh').addEventListener('click', load);
  document.querySelectorAll('.nav-item[data-page="sales"]').forEach(n => n.addEventListener('click', load));
  if ($('sales') && $('sales').classList.contains('active-page')) load();
})();