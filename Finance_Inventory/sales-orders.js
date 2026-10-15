/* sales-orders.js — Finance "Sales Transactions" page.
   Shows online orders (and POS walk-in sales) from the database and lets Finance move an order to its next status.
   Loaded after api-bridge.js in Finance_Inventory.html. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (t) => new Date(t).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let ORDERS = [], POS = [], VOIDS = {}, RETURNS = {}, posLoadSeq = 0;   // VOIDS / RETURNS: receipt no. -> pending void request {id, reason} / pending partial return {id, items, amount, ...}
  const payLabel = (m) => (m === 'Xendit' ? 'Online payment' : m);   // Xendit is only the gateway behind it; the stored value stays 'Xendit'

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
      : ['Pending Confirmation', 'Void Pending', 'Return Pending'].includes(st) ? 'low' : 'watch';
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
    const [o, p, v, rt] = await Promise.allSettled([api('/orders'), api(posUrl()), api('/pos/void-requests'), api('/pos/return-requests')]);
    VOIDS = {}; if (v.status === 'fulfilled') v.value.forEach(r => { VOIDS[r.receiptNo] = r; });
    RETURNS = {}; if (rt.status === 'fulfilled') rt.value.forEach(r => { RETURNS[r.receiptNo] = r; });
    if (o.status === 'fulfilled') ORDERS = o.value; else $('soSub').textContent = o.reason.message;
    if (p.status === 'fulfilled') POS = p.value; else $('soPosSub').textContent = p.reason.message;
    if (o.status === 'fulfilled') renderOrders();
    if (p.status === 'fulfilled') renderPos();
    if (window.CashReports) window.CashReports.show();   // payment summary + cash shifts
  }

  function renderOrders() {
    const q = $('soSearch').value.trim().toLowerCase(), st = $('soStatus').value, ty = $('soType') ? $('soType').value : 'all';
    const rows = ORDERS.filter(o => (st === 'all' || o.status === st) && (ty === 'all' || o.fulfillment === ty) &&
      (!q || (o.id + ' ' + o.customer + ' ' + (o.customerPhone || '') + ' ' + (o.phone || '') + ' ' + (o.recipient || '') + ' ' + o.items.map(i => i.name + ' ' + i.sku).join(' ')).toLowerCase().includes(q)));
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
      // Customer = the account owner (live phone from the account). Deliver to = the recipient saved on the order.
      const sub = (t) => '<div class="faint" style="font-size:12px">' + t + '</div>';
      const who = esc(o.customer) + sub(esc(o.customerPhone || o.phone)) +
        (o.fulfillment === 'Delivery'
          ? sub('<b>Deliver to:</b> ' + esc([o.recipient, o.recipientPhone || o.phone].filter(Boolean).join(' · '))) + (o.address ? sub(esc(o.address)) : '')
          : '');
      return '<tr><td>' + esc(o.id) + '</td><td>' + esc(when(o.createdAt)) + '</td><td>' + who +
        '</td><td>' + items + '</td><td>' + peso(o.total) +
        '</td><td>' + esc(o.fulfillment) + '<div class="faint" style="font-size:12px">' + esc(payLabel(o.method)) + '</div></td><td>' + pill(o.status) +
        (o.cancelRequested ? '<div class="faint" style="font-size:12px">Cancel requested</div>' : '') + tracker(o) + '</td><td style="white-space:nowrap">' + act + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="report-note">No orders yet. Orders placed in the shop appear here.</td></tr>';
  }

  function localISO(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  function posUrl() {
    const mode = $('soPosPeriod')?.value || 'today', now = new Date();
    let from = '', to = localISO(now);
    if (mode === 'today') from = to;
    else if (mode === 'yesterday') { now.setDate(now.getDate()-1); from = to = localISO(now); }
    else if (mode === 'week') { now.setDate(now.getDate()-6); from = localISO(now); }
    else if (mode === 'month') from = localISO(new Date(now.getFullYear(),now.getMonth(),1));
    else if (mode === 'year') from = localISO(new Date(now.getFullYear(),0,1));
    else if (mode === 'custom') { from = $('soPosFrom').value; to = $('soPosTo').value; if (!from || !to || from > to) return null; }
    else return '/pos/sales?all=1';
    return '/pos/sales?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
  }
  async function reloadPos() {
    const url = posUrl();
    if (!url) { $('soPosSub').textContent = 'Choose a valid date range.'; return; }
    const seq = ++posLoadSeq;
    $('soPosSub').textContent = 'Loading sales history…';
    try { const rows = await api(url); if (seq !== posLoadSeq) return; POS = rows; renderPos(); }
    catch (e) { if (seq === posLoadSeq) $('soPosSub').textContent = e.message; }
  }
  const posPeriod = $('soPosPeriod');
  if (posPeriod) {
    posPeriod.addEventListener('change', () => {
      const custom = posPeriod.value === 'custom';
      document.querySelectorAll('.pos-custom-date').forEach(el => el.hidden = !custom);
      if (!custom) reloadPos();
    });
    ['soPosFrom','soPosTo'].forEach(id => $(id)?.addEventListener('change', reloadPos));
  }

  function renderPos() {
    const q = $('soPosSearch').value.trim().toLowerCase();
    const rows = POS.filter(s => !q || (s.receiptNo + ' ' + s.cashierName + ' ' + s.items.map(i => i.name).join(' ')).toLowerCase().includes(q));
    const live = rows.filter(s => s.status !== 'Voided');
    $('soPosSub').textContent = rows.length + ' sales · ' + peso(live.reduce((n, s) => n + s.total - (s.refunded || 0), 0)) + ' collected (after returns)';
    $('soPosHead').innerHTML = '<tr><th>Receipt</th><th>Time</th><th>Cashier</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Action</th></tr>';
    const small = (t) => '<div class="faint" style="font-size:12px;margin-top:4px;max-width:240px">' + t + '</div>';
    $('soPosBody').innerHTML = (rows.length || Object.keys(RETURNS).length) ? rows.map(s => {
      const rq = s.returnPending && RETURNS[s.receiptNo];
      const itemsHtml = s.items.map(i => esc(i.qty + ' × ' + i.name) + (i.returnedQty ? ' <span class="faint">(' + esc(i.returnedQty) + ' returned)</span>' : '')).join('<br>');
      return '<tr><td>' + esc(s.receiptNo) + '</td><td>' + esc(when(s.createdAt)) + '</td><td>' + esc(s.cashierName) + '</td><td>' + itemsHtml + '</td><td>' + peso(s.total) +
        (s.refunded ? small('Returned −' + peso(s.refunded) + ', net ' + peso(s.total - s.refunded)) : '') + '</td><td>' + esc(payLabel(s.method)) + '</td><td>' +
        (rq ? pill('Return Pending') : pill(s.status)) +
        (VOIDS[s.receiptNo] ? small('Cashier\'s reason: ' + esc(VOIDS[s.receiptNo].reason)) : '') +
        (rq ? small('<b>' + esc(rq.returnNo) + '</b>: ' + rq.items.map(i => esc(i.qty + ' ' + i.unit + ' ' + i.name)).join(', ') + '<br>Refund ' + peso(rq.amount) + (rq.refundMethod === 'Cash' ? ' (cash from ' + esc(rq.requestedBy || 'cashier') + '\'s drawer)' : ' (to the original payment method)') + '<br>Reason: ' + esc(rq.reason)) : '') + '</td><td>' +
        (s.status === 'Void Pending' && VOIDS[s.receiptNo]
          ? '<button class="btn-danger btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="1">Approve void</button> <button class="btn-secondary btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="0">Reject</button>'
          : rq ? '<button class="btn-primary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="1">Approve return</button> <button class="btn-secondary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="0">Reject</button>'
          : '<span class="faint">—</span>') + '</td></tr>';
    }).join('') + Object.values(RETURNS).filter(r => !rows.some(s => s.receiptNo === r.receiptNo)).map(r =>   // returns on an earlier day's receipt
        '<tr><td>' + esc(r.receiptNo) + '</td><td colspan="2"><span class="faint">Earlier sale</span></td><td>' + r.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>') + '<div class="faint" style="font-size:12px">being returned</div></td><td>' + peso(r.amount) +
        '<div class="faint" style="font-size:12px">refund</div></td><td>' + esc(r.refundMethod === 'Xendit' ? 'Online payment' : r.refundMethod) + '</td><td>' + pill('Return Pending') + small('<b>' + esc(r.returnNo) + '</b> · ' + esc(r.reason)) +
        '</td><td><button class="btn-primary btn-sm" data-so-return="' + esc(r.receiptNo) + '" data-ok="1">Approve return</button> <button class="btn-secondary btn-sm" data-so-return="' + esc(r.receiptNo) + '" data-ok="0">Reject</button></td></tr>').join('')
      : '<tr><td colspan="8" class="report-note">No POS sales for this period.</td></tr>';
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-so-next],[data-so-cancel],[data-so-abort],[data-so-void],[data-so-return]'); if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.soReturn) {
        const no = b.dataset.soReturn, ok = b.dataset.ok === '1', r = RETURNS[no];
        if (!r) { toast('No pending return for ' + no + '. Refreshing…', true); await load(); return; }
        const items = r.items.map(i => '  • ' + i.qty + ' ' + i.unit + ' ' + i.name).join('\n');
        const how = r.refundMethod === 'Cash' ? 'The ' + peso(r.amount) + ' is paid in cash from ' + (r.requestedBy || 'the cashier') + '\'s open drawer and taken off that shift\'s expected cash.'
          : 'This sale was paid by ' + (r.refundMethod === 'Xendit' ? 'online payment' : 'card') + ': send the ' + peso(r.amount) + ' refund through the payment provider. No drawer cash is involved.';
        const body = { approve: ok };
        if (ok) {
          if (!window.confirm('Approve return ' + r.returnNo + ' for ' + no + '?\n\n' + items + '\n\nRefund: ' + peso(r.amount) + '\n' + how + '\n\nCashier\'s reason: ' + r.reason)) { b.disabled = false; return; }
          body.restock = window.confirm('Are the returned items in resellable condition?\n\nOK = put them back in stock\nCancel = refund only, do NOT add them back to stock (damaged goods)');
        } else {
          const why = window.prompt('Why is return ' + r.returnNo + ' rejected? The cashier will see this. (5–200 characters)');
          if (why === null) { b.disabled = false; return; }
          body.note = why.trim();
        }
        await api('/pos/return-requests/' + encodeURIComponent(r.id) + '/decision', { method: 'POST', body: JSON.stringify(body) });
        toast(ok ? r.returnNo + ' approved' + (body.restock ? ' and the items are back in stock.' : '. Items were not added back to stock.') : r.returnNo + ' rejected.');
      } else if (b.dataset.soVoid) {
        const no = b.dataset.soVoid, ok = b.dataset.ok === '1', v = VOIDS[no], sale = POS.find(x => x.receiptNo === no);
        if (!v) { toast('No pending void request for ' + no + '. Refreshing…', true); await load(); return; }
        const online = sale && sale.method === 'Xendit';
        const msg = (ok ? 'Approve the void of ' + no + '?\nAll items go back into stock. This cannot be undone.' : 'Reject the void request for ' + no + '?\nThe sale stays completed.')
          + '\n\nCashier\'s reason: ' + v.reason + (ok && online ? '\n\nThis sale was paid online. Voiding does not refund the customer: send the refund from your Xendit dashboard.' : '');
        if (!window.confirm(msg)) { b.disabled = false; return; }
        await api('/pos/void-requests/' + encodeURIComponent(v.id) + '/decision', { method: 'POST', body: JSON.stringify({ approve: ok }) });
        toast(ok ? no + ' was voided and the stock returned.' : 'Void request for ' + no + ' rejected.');
      } else if (b.dataset.soNext) {
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
  $('soType') && $('soType').addEventListener('change', renderOrders);
  document.querySelectorAll('.so-refresh').forEach(b => b.addEventListener('click', load));
  document.querySelectorAll('.nav-item[data-page="sales"], .nav-item[data-page="orders"]').forEach(n => n.addEventListener('click', load));
  if (['orders', 'sales'].some(id => $(id) && $(id).classList.contains('active-page'))) load();
})();