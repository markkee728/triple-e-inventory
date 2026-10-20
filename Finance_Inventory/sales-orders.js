/* sales-orders.js — Finance "Online Orders" and "POS Sales & Shifts" pages (monitoring).
   The cashier now processes every order and sale (POS > Online Orders). Finance only FOLLOWS them here, so there are no
   confirm / pack / deliver / cancel buttons. Finance keeps the decisions that only Finance can make:
     • cancellation requests from customers (Approve / Reject)      • POS void requests         • POS return requests
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
    if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { fields: d.fields });
    return d;
  }
  const pill = (st) => {
    const c = ['Delivered', 'Picked Up', 'Completed'].includes(st) ? 'in'
      : ['Cancelled', 'Voided'].includes(st) ? 'out'
      : ['Pending Confirmation', 'Void Pending', 'Return Pending'].includes(st) ? 'low' : 'watch';
    return '<span class="status-pill ' + c + '">' + esc(st) + '</span>';
  };
  const FINAL = ['Delivered', 'Picked Up'];
  // Who has the order right now, in words (the cashier moves it; Finance only reads this).
  const holder = (o) => {
    if (o.status === 'Cancelled') return 'Closed';
    if (FINAL.includes(o.status)) return 'Completed';
    return { 'Pending Confirmation': 'Waiting for the cashier to confirm', Paid: 'Cashier: to pack', Packed: 'Cashier: to release', 'Ready for Pickup': 'Cashier: customer collecting', 'Out for Delivery': 'On its way (cashier)' }[o.status] || 'With the cashier';
  };
  // Small progress line under the status: done steps, the current step in bold, steps still to come in grey.
  const tracker = (o) => {
    const flow = o.flow || []; const at = flow.indexOf(o.status);
    if (!flow.length || o.status === 'Cancelled') return '';
    return '<div style="font-size:11.5px;margin-top:6px;line-height:1.5">' + flow.map((st, i) =>
      i < at ? '<span class="faint">' + esc(st) + '</span>' : i === at ? '<b>' + esc(st) + '</b>' : '<span class="faint" style="opacity:.55">' + esc(st) + '</span>').join(' <span class="faint">›</span> ') + '</div>';
  };

  // Delivery details under the status: who has it, when it left, tracking, when it arrived, proof photos (Delivery orders only).
  const dlvInfo = (o) => {
    if (o.fulfillment !== 'Delivery') return '';
    const d = o.delivery || {}, line = (t) => '<div class="faint" style="font-size:12px;margin-top:3px;line-height:1.45">' + t + '</div>';
    const who = [d.driverName, d.courier, d.vehiclePlate].filter(Boolean).map(esc).join(' · ');
    let h = '';
    if (who) h += line('<b>Rider:</b> ' + who + (d.driverPhone ? ' · ' + esc(d.driverPhone) : ''));
    if (d.trackingNo) h += line('<b>Tracking:</b> ' + esc(d.trackingNo));
    if (d.dispatchedAt) h += line('<b>Left:</b> ' + esc(when(d.dispatchedAt)));
    if (o.status === 'Delivered') h += line('<b>Delivered:</b> ' + (d.deliveredAt ? esc(when(d.deliveredAt)) : '—') + (o.receivedBy ? ' · received by ' + esc(o.receivedBy) : ''));
    if (o.status === 'Delivered') h += line('<b>Customer confirmed:</b> ' + (d.customerReceivedAt ? esc(when(d.customerReceivedAt)) : '<span style="opacity:.7">not yet</span>'));
    if (d.notes) h += line('<b>Note:</b> ' + esc(d.notes));
    if (d.proofIds && d.proofIds.length)
      h += line('<b>Proof:</b> ' + d.proofIds.map((id, i) => '<a href="/api/orders/' + encodeURIComponent(o.id) + '/delivery-proof/' + id + '" target="_blank" rel="noopener">Photo ' + (i + 1) + '</a>').join(', '));
    else if (o.status === 'Delivered') h += line('<b>Proof:</b> none attached');
    return h;
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
      (!q || (o.id + ' ' + o.customer + ' ' + (o.customerPhone || '') + ' ' + (o.phone || '') + ' ' + (o.recipient || '') + ' ' + [(o.delivery || {}).driverName, (o.delivery || {}).trackingNo, (o.delivery || {}).vehiclePlate, (o.delivery || {}).courier].filter(Boolean).join(' ') + ' ' + o.items.map(i => i.name + ' ' + i.sku).join(' ')).toLowerCase().includes(q)));
    $('soSub').textContent = rows.length + ' of ' + ORDERS.length + ' orders';
    $('soHead').innerHTML = '<tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Type / Payment</th><th>Status</th><th>Follow-up</th></tr>';
    $('soBody').innerHTML = rows.length ? rows.map(o => {
      const items = o.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>');
      // View only: the cashier moves the order. Finance only answers the customer's cancellation request.
      let act;
      if (o.cancelRequested) act = '<div class="so-by need">Customer asked to cancel</div><button class="btn-primary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="1">Approve cancel</button> <button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="0">Reject</button>';
      else act = '<span class="faint" style="font-size:12.5px">' + esc(holder(o)) + '</span>';
      // Customer = the account owner (live phone from the account). Deliver to = the recipient saved on the order.
      const sub = (t) => '<div class="faint" style="font-size:12px">' + t + '</div>';
      const who = esc(o.customer) + sub(esc(o.customerPhone || o.phone)) +
        (o.fulfillment === 'Delivery'
          ? sub('<b>Deliver to:</b> ' + esc([o.recipient, o.recipientPhone || o.phone].filter(Boolean).join(' · '))) + (o.address ? sub(esc(o.address)) : '')
          : '');
      return '<tr><td>' + esc(o.id) + '</td><td>' + esc(when(o.createdAt)) + '</td><td>' + who +
        '</td><td>' + items + '</td><td>' + peso(o.total) +
        '</td><td>' + esc(o.fulfillment) + '<div class="faint" style="font-size:12px">' + esc(payLabel(o.method)) + '</div></td><td>' + pill(o.status) +
        (o.cancelRequested ? '<div class="faint" style="font-size:12px">Cancel requested</div>' : '') + tracker(o) + dlvInfo(o) + '</td><td style="white-space:nowrap">' + act + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="report-note">No orders yet. Orders placed in the shop appear here.</td></tr>';
  }

  function localISO(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  let posPeriodMode = 'week';
  function setPosRange(mode) {
    posPeriodMode = mode;
    const now = new Date(); let from = '', to = localISO(now);
    if (mode === 'today') from = to;
    else if (mode === 'yesterday') { now.setDate(now.getDate()-1); from = to = localISO(now); }
    else if (mode === 'week') { now.setDate(now.getDate()-6); from = localISO(now); }
    else if (mode === 'month') from = localISO(new Date(now.getFullYear(),now.getMonth(),1));
    else if (mode === 'year') from = localISO(new Date(now.getFullYear(),0,1));
    $('soPosFrom').value = from;
    $('soPosTo').value = mode === 'all' ? '' : to;
    document.querySelectorAll('[data-pos-period]').forEach(b => {
      const active = b.dataset.posPeriod === mode;
      b.classList.toggle('active',active);
      b.setAttribute('aria-pressed',String(active));
    });
  }
  function posUrl() {
    const from = $('soPosFrom')?.value || '', to = $('soPosTo')?.value || '';
    if (posPeriodMode === 'all') return '/pos/sales?all=1';
    if (!from || !to || from > to) return null;
    return '/pos/sales?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
  }
  async function reloadPos() {
    const url = posUrl();
    if (!url) { $('soPosSub').textContent = 'Choose a valid date range (From must not exceed To).'; return; }
    const seq = ++posLoadSeq;
    $('soPosSub').textContent = 'Loading sales history…';
    try { const rows = await api(url); if (seq !== posLoadSeq) return; POS = rows; renderPos(); }
    catch (e) { if (seq === posLoadSeq) $('soPosSub').textContent = e.message; }
  }
  if ($('soPosFrom') && $('soPosTo')) {
    setPosRange('week');
    document.querySelectorAll('[data-pos-period]').forEach(b => b.addEventListener('click', () => { setPosRange(b.dataset.posPeriod); reloadPos(); }));
    ['soPosFrom','soPosTo'].forEach(id => $(id).addEventListener('change', () => {
      posPeriodMode = 'custom';
      document.querySelectorAll('[data-pos-period]').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed','false'); });
      if ($('soPosFrom').value && $('soPosTo').value) reloadPos();
    }));
    $('soPosExport')?.addEventListener('click', () => {
      const q = $('soPosSearch').value.trim().toLowerCase();
      const rows = POS.filter(s => !q || (s.receiptNo + ' ' + s.cashierName + ' ' + (s.customerName||'') + ' ' + (s.customerPhone||'') + ' ' + (s.items||[]).map(i=>i.name).join(' ')).toLowerCase().includes(q));
      const fields = ['Receipt','Date','Customer','Customer phone','Cashier','Items','Total','Refunded','Net','Payment','Status'];
      const csv = [fields,...rows.map(s => [s.receiptNo,s.createdAt,s.customerName||'Walk-in',s.customerPhone||'',s.cashierName,(s.items||[]).map(i=>i.qty+' x '+i.name).join('; '),s.total,s.refunded||0,s.status==='Voided'?0:Number(s.total)-Number(s.refunded||0),s.method,s.status])]
        .map(row => row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));
      const link = document.createElement('a'); link.href=url; link.download='pos-sales-'+(posPeriodMode==='all'?'all':($('soPosFrom').value+'-to-'+$('soPosTo').value))+'.csv';
      document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  }

  function renderPos() {
    const q = $('soPosSearch').value.trim().toLowerCase();
    const rows = POS.filter(s => !q || (s.receiptNo + ' ' + s.cashierName + ' ' + (s.customerName||'') + ' ' + (s.customerPhone||'') + ' ' + s.items.map(i => i.name).join(' ')).toLowerCase().includes(q));
    const live = rows.filter(s => s.status !== 'Voided');
    $('soPosSub').textContent = rows.length + ' sales · ' + peso(live.reduce((n, s) => n + s.total - (s.refunded || 0), 0)) + ' collected (after returns)';
    $('soPosHead').innerHTML = '<tr><th>Receipt</th><th>Time</th><th>Customer</th><th>Cashier</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Action</th></tr>';
    const small = (t) => '<div class="faint" style="font-size:12px;margin-top:4px;max-width:240px">' + t + '</div>';
    $('soPosBody').innerHTML = (rows.length || Object.keys(RETURNS).length) ? rows.map(s => {
      const rq = s.returnPending && RETURNS[s.receiptNo];
      const itemsHtml = s.items.map(i => esc(i.qty + ' × ' + i.name) + (i.returnedQty ? ' <span class="faint">(' + esc(i.returnedQty) + ' returned)</span>' : '')).join('<br>');
      return '<tr><td>' + esc(s.receiptNo) + '</td><td>' + esc(when(s.createdAt)) + '</td><td>' + (s.customerName || s.customerPhone ? esc(s.customerName || '—') + (s.customerPhone ? '<div class="faint" style="font-size:12px">' + esc(s.customerPhone) + '</div>' : '') : '<span class="faint">Walk-in</span>') + (s.fulfillment === 'Delivery' && s.shipTo ? '<div class="faint" style="font-size:12px;max-width:240px"><b>Delivery</b> · ' + esc(s.shipTo.fullAddress || '') + (s.shipTo.landmark ? ' (Landmark: ' + esc(s.shipTo.landmark) + ')' : '') + '<br>Fee ' + peso(s.deliveryFee || 0) + '</div>' : '') + '</td><td>' + esc(s.cashierName) + '</td><td>' + itemsHtml + '</td><td>' + peso(s.total) +
        (s.refunded ? small('Returned −' + peso(s.refunded) + ', net ' + peso(s.total - s.refunded)) : '') + '</td><td>' + esc(payLabel(s.method)) + '</td><td>' +
        (rq ? pill('Return Pending') : pill(s.status)) +
        (VOIDS[s.receiptNo] ? small('Cashier\'s reason: ' + esc(VOIDS[s.receiptNo].reason)) : '') +
        (rq ? small('<b>' + esc(rq.returnNo) + '</b>: ' + rq.items.map(i => esc(i.qty + ' ' + i.unit + ' ' + i.name)).join(', ') + '<br>Refund ' + peso(rq.amount) + (rq.refundMethod === 'Cash' ? ' (cash from ' + esc(rq.requestedBy || 'cashier') + '\'s drawer)' : ' (to the original payment method)') + '<br>Reason: ' + esc(rq.reason)) : '') + '</td><td>' +
        (s.status === 'Void Pending' && VOIDS[s.receiptNo]
          ? '<button class="btn-danger btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="1">Approve void</button> <button class="btn-secondary btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="0">Reject</button>'
          : rq ? '<button class="btn-primary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="1">Approve return</button> <button class="btn-secondary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="0">Reject</button>'
          : '<span class="faint">—</span>') + '</td></tr>';
    }).join('') + Object.values(RETURNS).filter(r => !rows.some(s => s.receiptNo === r.receiptNo)).map(r =>   // returns on an earlier day's receipt
        '<tr><td>' + esc(r.receiptNo) + '</td><td colspan="3"><span class="faint">Earlier sale</span></td><td>' + r.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>') + '<div class="faint" style="font-size:12px">being returned</div></td><td>' + peso(r.amount) +
        '<div class="faint" style="font-size:12px">refund</div></td><td>' + esc(r.refundMethod === 'Xendit' ? 'Online payment' : r.refundMethod) + '</td><td>' + pill('Return Pending') + small('<b>' + esc(r.returnNo) + '</b> · ' + esc(r.reason)) +
        '</td><td><button class="btn-primary btn-sm" data-so-return="' + esc(r.receiptNo) + '" data-ok="1">Approve return</button> <button class="btn-secondary btn-sm" data-so-return="' + esc(r.receiptNo) + '" data-ok="0">Reject</button></td></tr>').join('')
      : '<tr><td colspan="9" class="report-note">No POS sales for this period.</td></tr>';
  }


  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-so-cancel],[data-so-void],[data-so-return]'); if (!b) return;
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
  document.querySelectorAll('.nav-item[data-page="sales"], .nav-item[data-page="orders"], .sales-tab[data-page="sales"], .sales-tab[data-page="orders"]').forEach(n => n.addEventListener('click', load));
  const watching = () => ['orders', 'sales'].some(id => $(id) && $(id).classList.contains('active-page'));
  if (watching()) load();
  // Monitoring page: keep it current while it is open, since the cashier is moving orders along
  setInterval(() => { if (!document.hidden && watching()) load(); }, 15000);
})();