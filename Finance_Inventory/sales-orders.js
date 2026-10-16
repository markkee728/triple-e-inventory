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
    if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { fields: d.fields });
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
    $('soHead').innerHTML = '<tr><th>Order</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Type / Payment</th><th>Status</th><th>Action</th></tr>';
    $('soBody').innerHTML = rows.length ? rows.map(o => {
      const items = o.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>');
      let act = '';
      if (o.cancelRequested) act = '<button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="1">Approve cancel</button> <button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="0">Reject</button>';
      else {
        if (o.next) act = '<button class="btn-primary btn-sm" data-so-next="' + esc(o.id) + '" data-to="' + esc(o.next) + '">' + esc(actionLabel(o.next)) + '</button>';
        if (o.fulfillment === 'Delivery' && o.status === 'Out for Delivery') act += ' <button class="btn-secondary btn-sm" data-so-edit="' + esc(o.id) + '">Edit rider</button>';
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
      return '<tr><td>' + esc(s.receiptNo) + '</td><td>' + esc(when(s.createdAt)) + '</td><td>' + (s.customerName || s.customerPhone ? esc(s.customerName || '—') + (s.customerPhone ? '<div class="faint" style="font-size:12px">' + esc(s.customerPhone) + '</div>' : '') : '<span class="faint">Walk-in</span>') + '</td><td>' + esc(s.cashierName) + '</td><td>' + itemsHtml + '</td><td>' + peso(s.total) +
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


  /* ---------- delivery dialog: rider / courier details when the order leaves, proof when it arrives ---------- */
  const COURIERS = ['Own rider', 'Lalamove', 'Grab Express', 'Borzo', 'LBC', 'J&T Express', '2GO', 'Other'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const toLocalInput = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');
  let dlg = null;   // { o, mode, photos:[ids], busy, touched }

  function dlgCss() {
    if ($('dlCss')) return;
    const st = document.createElement('style'); st.id = 'dlCss';
    st.textContent = '#dlOverlay{z-index:1200}.dl-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.dl-grid .full{grid-column:1/-1}@media(max-width:560px){.dl-grid{grid-template-columns:1fr}}' +
      '.dl-photos{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}.dl-photo{position:relative;width:92px;height:92px;border-radius:8px;overflow:hidden;border:1px solid var(--border)}' +
      '.dl-photo img{width:100%;height:100%;object-fit:cover;display:block}.dl-photo button{position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,.72);color:#fff;cursor:pointer;line-height:22px;padding:0;font-size:14px}' +
      '.dl-add{width:92px;height:92px;border-radius:8px;border:1px dashed var(--text-faint);background:none;color:var(--text-dim);cursor:pointer;font:inherit;font-size:13px}.dl-add:disabled{opacity:.5;cursor:default}';
    document.head.appendChild(st);
  }
  function closeDlg(force) {
    if (!dlg || (dlg.busy && !force)) return;
    const touched = dlg.touched; dlg = null;
    const ov = $('dlOverlay'); if (ov) ov.remove();
    if (touched) load();   // photos were added / removed: refresh the list
  }
  const dlErr = (key, msg) => { if ($('dl_' + key + '_err')) $('dl_' + key + '_err').textContent = msg || ''; if ($('dl_' + key)) $('dl_' + key).classList.toggle('sa-bad', !!msg); };
  function dlClear() { const b = $('dlTopErr'); if (b) { b.textContent = ''; b.style.display = 'none'; } document.querySelectorAll('#dlOverlay .sa-err').forEach(e => { e.textContent = ''; }); document.querySelectorAll('#dlOverlay .sa-bad').forEach(e => e.classList.remove('sa-bad')); }
  function dlShowErr(e) {
    const f = e.fields || {}; let placed = false;
    Object.keys(f).forEach(k => { if ($('dl_' + k + '_err')) { dlErr(k, f[k]); placed = true; } });
    if (!placed || !Object.keys(f).length) { const b = $('dlTopErr'); if (b) { b.textContent = e.message || 'Something went wrong.'; b.style.display = 'block'; } }
    const first = document.querySelector('#dlOverlay .sa-bad'); if (first) first.focus();
  }

  // phone photos are 3-8 MB: shrink to a 1600px JPEG (about 300 KB) in the browser before sending
  async function shrinkPhoto(file) {
    if (!/^image\//.test(file.type)) throw new Error('Choose a photo (JPG, PNG or WEBP)');
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e1) { try { bmp = await createImageBitmap(file); } catch (e2) { throw new Error('This photo format is not supported here. Take it again as JPG or PNG'); } }
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Could not prepare the photo');
    if (blob.size > 2 * 1024 * 1024) throw new Error('The photo is still over 2 MB. Try a smaller one');
    return blob;
  }
  async function uploadProof(no, blob) {
    const r = await fetch('/api/orders/' + encodeURIComponent(no) + '/delivery-proof', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'Upload failed'), { fields: d.fields });
    return d.id;
  }
  function paintPhotos() {
    const box = $('dlPhotos'); if (!box || !dlg) return;
    box.innerHTML = dlg.photos.map((id, i) => '<div class="dl-photo"><a href="/api/orders/' + encodeURIComponent(dlg.o.id) + '/delivery-proof/' + id + '" target="_blank" rel="noopener"><img alt="Proof photo ' + (i + 1) + '" src="/api/orders/' + encodeURIComponent(dlg.o.id) + '/delivery-proof/' + id + '"></a>' +
      '<button type="button" data-dl-rm="' + id + '" aria-label="Remove photo ' + (i + 1) + '" title="Remove">&times;</button></div>').join('') +
      (dlg.photos.length < 3 ? '<button type="button" class="dl-add" id="dlAdd">+ Add photo<br>(' + dlg.photos.length + ' of 3)</button>' : '');
  }

  function openDelivery(o, mode) {
    dlgCss(); closeDlg(true);
    const d = o.delivery || {};
    dlg = { o, mode, photos: (d.proofIds || []).slice(), busy: false, touched: false };
    const fld = (key, label, input, full, hint) => '<div' + (full ? ' class="full"' : '') + '><label for="dl_' + key + '">' + label + '</label>' + input + (hint ? '<div class="faint" style="font-size:12.5px;margin-top:3px">' + hint + '</div>' : '') + '<div class="sa-err" id="dl_' + key + '_err"></div></div>';
    const txt = (key, val, max, ph, extra) => '<input type="text" id="dl_' + key + '" class="sa-in" maxlength="' + max + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '" autocomplete="off"' + (extra || '') + '>';
    const star = ' <span style="color:#ef7a7a">*</span>';
    const nowIn = toLocalInput(Date.now());
    const title = mode === 'deliver' ? 'Mark delivered' : mode === 'edit' ? 'Edit rider details' : 'Send out for delivery';
    let body = '<h2 id="dlTitle" style="margin:0 0 4px">' + title + '</h2><div class="faint" style="font-size:14px">' + esc(o.id) + ' · ' + esc(o.recipient || o.customer || '') + (o.address ? '<br>' + esc(o.address) : '') + '</div><div class="sa-form">';
    if (mode === 'deliver') {
      const who = [d.driverName, d.courier, d.vehiclePlate].filter(Boolean).join(' · ');
      body += (who || d.dispatchedAt ? '<div class="sa-banner ok" style="font-size:14px">Out with <b>' + esc(who || 'the courier') + '</b>' + (d.dispatchedAt ? ' since ' + esc(when(d.dispatchedAt)) : '') + '.</div>'
        : '<div class="sa-banner warn" style="font-size:14px">No rider details were saved for this order (it left before delivery details were tracked).</div>') +
        '<div class="dl-grid">' +
        fld('receivedBy', 'Received by' + star, txt('receivedBy', '', 80, 'Full name of the person who received it'), true) +
        fld('deliveredAt', 'Delivered on', '<input type="datetime-local" id="dl_deliveredAt" class="sa-in" value="' + nowIn + '" max="' + nowIn + '"' + (d.dispatchedAt ? ' min="' + toLocalInput(d.dispatchedAt) + '"' : '') + '>', false, 'Change this if you are recording it later.') +
        fld('notes', 'Delivery note', '<textarea id="dl_notes" class="sa-in" maxlength="300" placeholder="e.g. Left with the guard, signed the delivery receipt">' + esc(d.notes || '') + '</textarea>', true) +
        '<div class="full"><label>Proof of delivery' + (o.proofRequired ? star : ' (optional)') + '</label><div class="faint" style="font-size:12.5px">Photo of the items at the door, or of the signed delivery receipt. Up to 3 photos.</div><div class="dl-photos" id="dlPhotos"></div><input type="file" id="dlFile" accept="image/*" style="display:none"><div class="sa-err" id="dl_proof_err"></div></div></div>';
    } else {
      body += (mode === 'dispatch' ? '<div class="sa-banner warn" style="font-size:14px">The customer is told who is bringing the order. Enter the rider\'s name, or a tracking number for a courier parcel.</div>' : '') +
        '<div class="dl-grid">' +
        fld('courier', 'Delivered by' + star, txt('courier', d.courier || (mode === 'dispatch' ? 'Own rider' : ''), 60, 'Own rider, Lalamove, LBC…', ' list="dlCouriers"') + '<datalist id="dlCouriers">' + COURIERS.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist>') +
        fld('dispatchedAt', 'Left on', '<input type="datetime-local" id="dl_dispatchedAt" class="sa-in" value="' + (d.dispatchedAt ? toLocalInput(d.dispatchedAt) : nowIn) + '" max="' + nowIn + '">') +
        fld('driverName', 'Rider / driver name', txt('driverName', d.driverName, 80, 'e.g. Juan Dela Cruz')) +
        fld('driverPhone', 'Rider phone', txt('driverPhone', d.driverPhone, 20, '0917 123 4567', ' inputmode="tel"'), false, 'Only Finance sees this.') +
        fld('vehiclePlate', 'Plate number', txt('vehiclePlate', d.vehiclePlate, 15, 'ABC 1234')) +
        fld('trackingNo', 'Tracking number', txt('trackingNo', d.trackingNo, 60, 'For courier parcels (LBC, J&T…)'), false, 'Shown to the customer.') +
        fld('notes', 'Delivery note', '<textarea id="dl_notes" class="sa-in" maxlength="300" placeholder="Internal. e.g. call before arriving, gate is blue">' + esc(d.notes || '') + '</textarea>', true, 'Only Finance sees this.') + '</div>';
    }
    body += '<div class="sa-banner bad" id="dlTopErr" style="display:none"></div><div class="sa-actions"><button type="button" class="btn-primary" id="dlGo">' + (mode === 'deliver' ? 'Mark delivered' : mode === 'edit' ? 'Save changes' : 'Send out for delivery') + '</button><button type="button" class="btn-secondary" id="dlCancel">Cancel</button></div></div>';
    const ov = document.createElement('div'); ov.className = 'modal-overlay open'; ov.id = 'dlOverlay';
    ov.innerHTML = '<div class="account-modal sa-modal" role="dialog" aria-modal="true" aria-labelledby="dlTitle" style="max-width:620px"><button type="button" class="modal-close" id="dlClose" aria-label="Close">&times;</button>' + body + '</div>';
    document.body.appendChild(ov);
    if (mode === 'deliver') paintPhotos();
    const first = ov.querySelector('input:not([type=file]),textarea'); if (first) first.focus();
  }

  async function submitDelivery() {
    if (!dlg || dlg.busy) return;
    const { o, mode } = dlg, v = (k) => ($('dl_' + k) ? $('dl_' + k).value.trim().replace(/\s+/g, ' ') : '');
    dlClear();
    let path, body;
    if (mode === 'deliver') {
      let bad = false;
      if (v('receivedBy').length < 2 || v('receivedBy').length > 80) { dlErr('receivedBy', 'Enter the name of the person who received it (2–80 characters)'); bad = true; }
      if (o.proofRequired && !dlg.photos.length) { dlErr('proof', 'Attach at least one proof-of-delivery photo'); bad = true; }
      if (bad) return;
      path = '/orders/' + encodeURIComponent(o.id) + '/status';
      body = { status: 'Delivered', receivedBy: v('receivedBy'), delivery: { deliveredAt: fromLocalInput(v('deliveredAt')), notes: v('notes') } };
    } else {
      let bad = false;
      if (v('courier').length < 2) { dlErr('courier', 'Enter who delivers it, e.g. Own rider, Lalamove, LBC'); bad = true; }
      if (!v('driverName') && !v('trackingNo')) { dlErr('driverName', 'Enter the rider name (or a tracking number for a courier parcel)'); bad = true; }
      if (bad) return;
      const delivery = { courier: v('courier'), driverName: v('driverName'), driverPhone: v('driverPhone'), vehiclePlate: v('vehiclePlate'), trackingNo: v('trackingNo'), notes: v('notes'), dispatchedAt: fromLocalInput(v('dispatchedAt')) };
      if (mode === 'edit') { path = '/orders/' + encodeURIComponent(o.id) + '/delivery'; body = delivery; }
      else { path = '/orders/' + encodeURIComponent(o.id) + '/status'; body = { status: 'Out for Delivery', delivery }; }
    }
    dlg.busy = true; $('dlGo').disabled = true; $('dlCancel').disabled = true;
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      dlg.touched = false; closeDlg(true);
      toast(mode === 'deliver' ? o.id + ' is now Delivered. The customer can see it.' : mode === 'edit' ? 'Delivery details saved.' : o.id + ' is out for delivery. The customer was told who is bringing it.');
      await load();
    } catch (e) {
      if (!dlg) return;
      dlg.busy = false; $('dlGo').disabled = false; $('dlCancel').disabled = false; dlShowErr(e);
    }
  }

  document.addEventListener('click', async (e) => {
    if (!dlg) return;
    const t = e.target;
    if (t.id === 'dlGo') return submitDelivery();
    if (t.id === 'dlCancel' || t.id === 'dlClose') return closeDlg();
    if (t.id === 'dlAdd') { if (!dlg.busy) $('dlFile').click(); return; }
    if (t.dataset && t.dataset.dlRm && !dlg.busy) {
      dlg.busy = true; dlClear();
      try { await api('/orders/' + encodeURIComponent(dlg.o.id) + '/delivery-proof/' + t.dataset.dlRm, { method: 'DELETE' }); if (dlg) { dlg.photos = dlg.photos.filter(x => String(x) !== t.dataset.dlRm); dlg.touched = true; paintPhotos(); } }
      catch (err) { if (dlg) dlShowErr(err); }
      if (dlg) dlg.busy = false;
    }
  });
  document.addEventListener('change', async (e) => {
    if (!dlg || e.target.id !== 'dlFile' || !e.target.files.length) return;
    const file = e.target.files[0]; e.target.value = '';
    if (dlg.busy) return;
    dlg.busy = true; dlClear();
    const add = $('dlAdd'); if (add) { add.disabled = true; add.textContent = 'Uploading…'; }
    try { const id = await uploadProof(dlg.o.id, await shrinkPhoto(file)); if (dlg) { dlg.photos.push(id); dlg.touched = true; } }
    catch (err) { if (dlg) dlErr('proof', err.message); }
    if (dlg) { dlg.busy = false; paintPhotos(); }
  });
  document.addEventListener('mousedown', (e) => { if (dlg && e.target.id === 'dlOverlay') closeDlg(); });
  document.addEventListener('keydown', (e) => { if (dlg && e.key === 'Escape') closeDlg(); });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-so-next],[data-so-cancel],[data-so-abort],[data-so-void],[data-so-return],[data-so-edit]'); if (!b) return;
    // Delivery orders: leaving and arriving need details (rider, proof), so they open a form instead of a one-line prompt
    if (b.dataset.soEdit || (b.dataset.soNext && ['Out for Delivery', 'Delivered'].includes(b.dataset.to))) {
      const dOrder = ORDERS.find(x => x.id === (b.dataset.soEdit || b.dataset.soNext));
      if (dOrder && dOrder.fulfillment === 'Delivery') { openDelivery(dOrder, b.dataset.soEdit ? 'edit' : b.dataset.to === 'Delivered' ? 'deliver' : 'dispatch'); return; }
    }
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