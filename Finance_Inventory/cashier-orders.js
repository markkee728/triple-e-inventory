/* Cashier · Online Orders
   The cashier runs the whole life of an online order here: confirm -> pack -> ready for pickup / out for delivery -> picked up / delivered.
   - Store pickups are processed at the counter: ID check, the person collecting, and the cash (for "Cash on Pickup") go into the cashier's open Cash Shift.
   - Deliveries have no rider assignment: the cashier marks "Out for delivery" and later "Delivered" (who received it). Cash on Delivery is recorded the same way.
   - The server enforces every rule again (one step at a time, payment before release, shift open, names / ID / amounts), so this page only guides and pre-checks. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (t) => (t ? new Date(t).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago');
};
const say = (text, bad) => { if (typeof toast === 'function') toast(text, !!bad); };

/* ---------- rules (the same ones the server checks) ---------- */
const NAME_RE = /^\p{L}[\p{L}\s.'\u2019-]{1,79}$/u;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9 \-_/]{3,39}$/;
const ID_TYPES = ['National ID', 'Driver License', 'Passport', 'School ID', 'Company ID', 'Other Government ID'];
const FINAL = ['Delivered', 'Picked Up'];
const isOpen = (o) => o.status !== 'Cancelled' && !FINAL.includes(o.status);
const TABS = [
  { key: 'open', label: 'Open', test: isOpen },
  { key: 'confirm', label: 'To confirm', hot: true, test: (o) => o.status === 'Pending Confirmation' },
  { key: 'pack', label: 'To pack', hot: true, test: (o) => o.status === 'Paid' },
  { key: 'ready', label: 'Packed & ready', test: (o) => ['Packed', 'Ready for Pickup', 'Out for Delivery'].includes(o.status) },
  { key: 'done', label: 'Completed', test: (o) => FINAL.includes(o.status) },
  { key: 'cancelled', label: 'Cancelled', test: (o) => o.status === 'Cancelled' }
];
const ACTION = {
  'Paid': 'Confirm order', 'Packed': 'Mark as packed', 'Ready for Pickup': 'Ready for pickup',
  'Out for Delivery': 'Send out for delivery', 'Picked Up': 'Release to customer', 'Delivered': 'Mark as delivered'
};
const statusLabel = (o) => (o.status === 'Paid' ? 'Confirmed' : o.status);
const statusClass = (s) => (s === 'Pending Confirmation' ? 's-pending' : FINAL.includes(s) ? 's-done' : s === 'Cancelled' ? 's-off' : 's-active');
const isCash = (o) => /^Cash on /.test(o.method || '');
function payLabel(o) {
  if (o.paymentStatus === 'paid') return 'Paid';
  if (isCash(o)) return o.fulfillment === 'Delivery' ? 'Cash on delivery' : 'Pay at counter';
  if (o.paymentStatus === 'expired') return 'Payment expired';
  return 'Awaiting payment';
}
function parseMoney(v) {
  const s = String(v == null ? '' : v).replace(/[\u20B1,\s]/g, '');
  return /^\d{1,8}(\.\d{1,2})?$/.test(s) ? Math.round(parseFloat(s) * 100) / 100 : null;
}

/* ---------- state ---------- */
let orders = [], tab = 'open', chosen = null, target = '', busy = false, shiftOpen = null, opener = null, loading = false;

async function request(path, options = {}) {
  let r;
  try { r = await fetch('/api' + path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); }
  catch { throw Object.assign(new Error('Cannot reach the server. Check the connection and try again.'), { fields: {} }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(new Error('Your session has ended. Please sign in again.'), { fields: {} });
  if (!r.ok) throw Object.assign(new Error(j.error || Object.values(j.fields || {}).join('; ') || 'Request failed'), { fields: j.fields || {} });
  return j;
}
function message(t, bad) { const m = $('coMessage'); m.textContent = t || ''; m.classList.toggle('err', !!bad); }

/* ---------- list ---------- */
function visible() {
  const t = TABS.find((x) => x.key === tab) || TABS[0];
  const q = $('coSearch').value.trim().toLowerCase(), f = $('coFilter').value;
  const list = orders.filter((o) => t.test(o) && (!f || o.fulfillment === f)
    && (!q || [o.id, o.customer, o.phone, o.customerPhone, o.recipient].join(' ').toLowerCase().includes(q)));
  const oldestFirst = ['open', 'confirm', 'pack', 'ready'].includes(tab);          // the queue: whoever has waited longest first
  return list.sort((a, b) => (oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
}
function renderTabs() {
  $('coTabs').innerHTML = TABS.map((t) => {
    const n = orders.filter(t.test).length;
    return `<button type="button" role="tab" class="co-tab${t.hot && n ? ' hot' : ''}" data-tab="${t.key}" aria-selected="${t.key === tab}">${esc(t.label)} <b>${n}</b></button>`;
  }).join('');
  const toConfirm = orders.filter((o) => o.status === 'Pending Confirmation').length, badge = $('navOrdersBadge');
  if (badge) { badge.textContent = toConfirm; badge.hidden = !toConfirm; }
}
function flagsFor(o) {
  const out = [];
  if (o.cancelRequested) out.push('<div class="co-flag bad">The customer asked to cancel this order. Finance must approve or reject it before it can move.</div>');
  else if (o.awaitingPayment) out.push('<div class="co-flag">Waiting for the customer\u2019s online payment (' + esc(o.method) + '). It cannot be confirmed until it is paid.</div>');
  else if (o.cashOnHandover) out.push(`<div class="co-flag">Collect <b>${peso(o.total)}</b> in cash when the order is ${o.fulfillment === 'Delivery' ? 'received' : 'picked up'}.</div>`);
  return out.join('');
}
function actionButton(o) {
  if (!o.next || o.cancelRequested) return '';
  if (o.next === 'Paid' && o.awaitingPayment && o.method === 'Xendit') return `<button type="button" class="btn-primary" data-check="${esc(o.id)}">Check payment</button>`;
  return `<button type="button" class="btn-primary" data-act="${esc(o.id)}">${esc(ACTION[o.next] || 'Next step')}</button>`;
}
function render() {
  renderTabs();
  const data = visible();
  $('coList').innerHTML = data.length ? data.map((o) => {
    const items = (o.items || []).map((i) => esc(i.qty + ' \u00D7 ' + i.name)).join(', ');
    return `<article class="co-card${o.status === 'Pending Confirmation' || o.cashOnHandover ? ' attn' : ''}">
      <div class="co-card-head">
        <div><div class="co-no">${esc(o.id)}</div><div class="co-who">${esc(o.customer)} \u00B7 ${esc(o.phone || o.customerPhone || '')} \u00B7 ${esc(ago(o.createdAt))}</div></div>
        <div class="co-pills"><span class="co-pill ${statusClass(o.status)}">${esc(statusLabel(o))}</span><span class="co-pill">${esc(o.fulfillment)}</span><span class="co-pill ${o.paymentStatus === 'paid' ? 's-done' : ''}">${esc(payLabel(o))}</span></div>
      </div>
      <div class="co-items">${items || 'No items'}</div>
      ${flagsFor(o)}
      <div class="co-foot">
        <div class="co-total">${peso(o.total)}<span class="co-due">${esc(o.method)}</span></div>
        <div class="co-btns"><button type="button" class="btn-secondary" data-detail="${esc(o.id)}">Details</button>${actionButton(o)}</div>
      </div></article>`;
  }).join('') : `<div class="co-empty">${orders.length ? 'No orders match this view.' : 'No online orders yet.'}</div>`;
}
async function load(silent) {
  if (loading) return; loading = true;
  if (!silent) message('Loading orders\u2026');
  try {
    orders = await request('/orders');
    render();
    message(silent ? '' : orders.length + ' orders \u00B7 updated ' + new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }));
    return true;
  } catch (e) { if (!silent) message(e.message, true); return false; }
  finally { loading = false; }
}
const byId = (id) => orders.find((x) => String(x.id) === String(id));

/* ---------- modal plumbing ---------- */
function openModal(el) { opener = document.activeElement; el.hidden = false; document.body.style.overflow = 'hidden'; const f = el.querySelector('input:not([type=checkbox]),select,textarea,button.btn-primary,button'); if (f) setTimeout(() => f.focus(), 30); }
function closeModal(el) { el.hidden = true; el.innerHTML = ''; if ($('coDetail').hidden && $('coAction').hidden) document.body.style.overflow = ''; if (opener && document.contains(opener)) opener.focus(); }
function closeAction() { chosen = null; target = ''; closeModal($('coAction')); }
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (!$('coAction').hidden) closeAction(); else if (!$('coDetail').hidden) closeModal($('coDetail')); });
['coDetail', 'coAction'].forEach((id) => $(id).addEventListener('mousedown', (e) => { if (e.target === $(id)) (id === 'coAction' ? closeAction() : closeModal($(id))); }));

/* ---------- details ---------- */
function detailHtml(o) {
  const lines = (o.items || []).map((i) => `<tr><td>${esc(i.name)}<br><small class="faint">${esc(i.sku || '')}</small></td><td class="r">${esc(i.qty)} ${esc(i.unit || '')}</td><td class="r">${peso(i.price)}</td><td class="r">${peso(i.qty * i.price)}</td></tr>`).join('');
  const ship = o.shipTo;
  const where = o.fulfillment === 'Delivery'
    ? `<p><b>${esc(o.recipient || o.customer)}</b>${o.recipientPhone ? ' \u00B7 ' + esc(o.recipientPhone) : ''}<br>${esc(ship ? [ship.addressLine, ship.barangay, ship.city, ship.province, ship.zip].filter(Boolean).join(', ') : o.address || '')}${ship && ship.landmark ? '<br><small class="faint">Landmark: ' + esc(ship.landmark) + '</small>' : ''}</p>`
    : '<p>Store pickup \u2014 the customer brings the order number and a valid ID.</p>';
  const dl = o.delivery || {};
  const dInfo = [dl.trackingNo && 'Tracking no. ' + esc(dl.trackingNo), dl.dispatchedAt && 'Out for delivery ' + esc(when(dl.dispatchedAt)), dl.deliveredAt && 'Delivered ' + esc(when(dl.deliveredAt)), o.receivedBy && 'Received by ' + esc(o.receivedBy), dl.customerReceivedAt && 'Customer confirmed receipt ' + esc(when(dl.customerReceivedAt))].filter(Boolean).join('<br>');
  const pay = [esc(o.method), o.paymentStatus === 'paid' ? 'Paid' + (o.paidAt ? ' \u00B7 ' + esc(when(o.paidAt)) : '') : 'Not paid yet', o.paymentRef && 'Ref. ' + esc(o.paymentRef), o.cashTendered != null && 'Cash received ' + peso(o.cashTendered) + ' \u00B7 change ' + peso(o.cashChange || 0)].filter(Boolean).join('<br>');
  const hist = (o.history || []).map((h) => `<li><b>${esc(h.to === 'Paid' ? 'Confirmed' : h.to)}</b>${h.note ? ' \u2014 ' + esc(h.note) : ''}<small>${esc(when(h.at))} \u00B7 ${esc(h.by)}</small></li>`).join('');
  return `<div class="co-sheet wide">
    <div class="co-card-head"><div><h2 id="coDetailTitle">${esc(o.id)}</h2><div class="co-sub">${esc(o.customer)} \u00B7 placed ${esc(when(o.createdAt))}</div></div>
      <div class="co-pills"><span class="co-pill ${statusClass(o.status)}">${esc(statusLabel(o))}</span><span class="co-pill">${esc(o.fulfillment)}</span></div></div>
    ${flagsFor(o)}
    <div class="co-grid">
      <div><h3>Customer</h3><p>${esc(o.customer)}<br>${o.customerPhone ? '<a href="tel:' + esc(o.customerPhone) + '">' + esc(o.customerPhone) + '</a><br>' : ''}${esc(o.customerEmail || '')}</p></div>
      <div><h3>${o.fulfillment === 'Delivery' ? 'Deliver to' : 'Pickup'}</h3>${where}</div>
      <div><h3>Payment</h3><p>${pay}</p></div>
      ${dInfo ? `<div><h3>Delivery record</h3><p>${dInfo}</p></div>` : ''}
    </div>
    <table class="co-table"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${lines}</tbody>
      <tfoot>${o.deliveryFee ? `<tr><td colspan="3" class="r">Subtotal</td><td class="r">${peso(o.subtotal)}</td></tr><tr><td colspan="3" class="r">Delivery fee</td><td class="r">${peso(o.deliveryFee)}</td></tr>` : ''}<tr><td colspan="3" class="r">Total</td><td class="r">${peso(o.total)}</td></tr></tfoot></table>
    <h3 class="faint" style="font:500 12px 'IBM Plex Mono',monospace;letter-spacing:1px;text-transform:uppercase;margin-top:12px">History</h3>
    <ul class="co-line">${hist || '<li>No history yet.</li>'}</ul>
    <div class="co-actions"><button type="button" class="btn-secondary" data-slip="${esc(o.id)}">Print slip</button><button type="button" class="btn-secondary" data-close-detail>Close</button>${actionButton(o)}</div></div>`;
}
function openDetail(o) { $('coDetail').innerHTML = detailHtml(o); openModal($('coDetail')); }

function printSlip(o) {
  const rows = (o.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td style="text-align:right">${esc(i.qty)} ${esc(i.unit || '')}</td><td style="text-align:right">${peso(i.qty * i.price)}</td></tr>`).join('');
  const html = `<!doctype html><html><head><title>${esc(o.id)}</title><style>body{font:13px Arial,sans-serif;margin:18px;color:#000}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border-bottom:1px solid #999;padding:5px 3px;text-align:left}.sig{margin-top:38px;border-top:1px solid #000;width:260px;padding-top:4px}</style></head><body>
    <h1>Triple E Metal Products \u2014 ${o.fulfillment === 'Delivery' ? 'Delivery' : 'Pickup'} slip</h1>
    <div><b>${esc(o.id)}</b> \u00B7 ${esc(when(o.createdAt))}</div><div>Customer: ${esc(o.customer)} ${esc(o.phone || '')}</div>
    ${o.fulfillment === 'Delivery' ? `<div>Deliver to: ${esc(o.recipient || o.customer)}, ${esc(o.address || '')}</div>` : ''}
    <table><thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div><b>Total ${peso(o.total)}</b> \u00B7 ${esc(o.method)} \u00B7 ${o.paymentStatus === 'paid' ? 'PAID' : 'TO COLLECT'}</div>
    ${o.cashTendered != null ? `<div>Cash received ${peso(o.cashTendered)} \u00B7 change ${peso(o.cashChange || 0)}</div>` : ''}
    <div class="sig">Received by (signature over printed name)</div></body></html>`;
  const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'; document.body.appendChild(f);
  const d = f.contentWindow.document; d.open(); d.write(html); d.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { say('Could not open the print dialog.', true); } setTimeout(() => f.remove(), 1500); }, 250);
}

/* ---------- action dialog ---------- */
const fld = (name, label, control, hint) => `<div class="co-fld" data-fld="${name}"><label for="co_${name}">${label}</label>${control}${hint ? '<small class="faint">' + hint + '</small>' : ''}<span class="co-err" data-err="${name}" role="alert"></span></div>`;
function setErr(name, msg) {
  const box = document.querySelector(`#coAction [data-err="${name}"]`);
  if (!box) { const g = $('coActErr'); if (g) g.textContent = msg || ''; return; }
  box.textContent = msg || ''; box.closest('.co-fld').classList.toggle('bad', !!msg);
}
function clearErrs() { document.querySelectorAll('#coAction [data-err]').forEach((x) => { x.textContent = ''; x.closest('.co-fld').classList.remove('bad'); }); $('coActErr').textContent = ''; }

function actionBody(o, t) {
  const who = o.fulfillment === 'Delivery' ? (o.recipient || o.customer) : o.customer;
  const handover = FINAL.includes(t);
  let h = '';
  if (t === 'Paid') {
    if (o.paymentStatus === 'paid') h += `<p>Online payment received (${esc(o.method)}). Confirming reserves the stock for this order.</p>`;
    else if (isCash(o)) h += `<p>Accepting this order reserves the stock now. <b>${peso(o.total)}</b> is collected in cash when the customer ${o.fulfillment === 'Delivery' ? 'receives' : 'picks up'} it.</p>`;
    else h += `<p>Check that the money really arrived in the bank / e-wallet, then enter the reference number from the statement.</p>` + fld('paymentRef', 'Payment reference no.', '<input id="co_paymentRef" maxlength="40" autocomplete="off" placeholder="e.g. GCASH 1234567890">');
  } else if (t === 'Packed') {
    h += `<p>Count the items against the order.</p><ul style="margin:6px 0 0 18px">${(o.items || []).map((i) => `<li>${esc(i.qty)} ${esc(i.unit || '')} \u00D7 ${esc(i.name)}</li>`).join('')}</ul>`
      + '<label class="co-check"><input type="checkbox" id="co_checked"> I checked the items and quantities</label><div class="co-fld" data-fld="checked" style="margin:0"><span class="co-err" data-err="checked" role="alert"></span></div>';
  } else if (t === 'Ready for Pickup') {
    h += '<p>The customer is told the order is ready. They bring the order number and a valid ID.</p>';
  } else if (t === 'Out for Delivery') {
    h += `<p>The customer is told the order is on its way. A tracking number is created automatically; no rider needs to be assigned.</p><p class="faint">${esc(o.recipient || o.customer)} \u00B7 ${esc(o.recipientPhone || o.phone || '')}<br>${esc(o.address || '')}</p>`;
  } else if (handover) {
    h += fld('receivedBy', t === 'Delivered' ? 'Received by' : 'Picked up by', `<input id="co_receivedBy" maxlength="80" autocomplete="off" value="${esc(who)}">`)
      + `<label class="co-check"><input type="checkbox" id="co_rep"> Someone else is ${t === 'Delivered' ? 'receiving' : 'collecting'} it for the customer</label>`
      + `<div id="coRepBox" hidden>${fld('relationship', 'Relationship / authorisation', '<input id="co_relationship" maxlength="60" autocomplete="off" placeholder="e.g. Driver of the company, spouse, with authorisation letter">')}</div>`;
    if (t === 'Picked Up') h += `<div class="co-grid" style="margin:0">${fld('pickupIdType', 'ID presented', `<select id="co_pickupIdType"><option value="">Choose ID type</option>${ID_TYPES.map((x) => `<option>${esc(x)}</option>`).join('')}</select>`)}${fld('pickupIdLast4', 'Last 4 characters of the ID', '<input id="co_pickupIdLast4" maxlength="4" autocomplete="off" placeholder="Last 4 only">')}</div><p class="faint">Check the original ID in person. Never photograph or write down the full ID number.</p>`;
    if (o.cashOnHandover) {
      const due = Number(o.total), bills = [...new Set([due, Math.ceil(due / 100) * 100, Math.ceil(due / 500) * 500, Math.ceil(due / 1000) * 1000])].filter((x) => x >= due).slice(0, 4);
      h += `<div class="co-box"><div class="faint">Amount to collect</div><div class="big">${peso(due)}</div>
        ${fld('cashReceived', 'Cash received', '<input id="co_cashReceived" inputmode="decimal" autocomplete="off" placeholder="0.00">')}
        <div class="co-quick">${bills.map((b, i) => `<button type="button" class="btn-secondary" data-cash="${b}">${i === 0 ? 'Exact ' : ''}${peso(b)}</button>`).join('')}</div>
        <div class="co-change" id="coChange" aria-live="polite"></div><div id="coShiftWarn"></div></div>`;
    }
  }
  return h + fld('note', 'Note (optional)', '<textarea id="co_note" rows="2" maxlength="200"></textarea>');
}
async function openAction(o) {
  chosen = o; target = o.next; shiftOpen = null;
  const t = target;
  $('coAction').innerHTML = `<form class="co-sheet" id="coForm" novalidate>
    <h2 id="coActionTitle">${esc(ACTION[t] || 'Next step')}</h2><div class="co-sub">${esc(o.id)} \u00B7 ${esc(o.customer)} \u00B7 ${peso(o.total)}</div>
    ${actionBody(o, t)}<p class="co-err" id="coActErr" role="alert"></p>
    <div class="co-actions"><button type="button" class="btn-secondary" id="coCancel">Cancel</button><button type="submit" class="btn-primary" id="coSubmit">${esc(ACTION[t] || 'Confirm')}</button></div></form>`;
  openModal($('coAction'));
  if (FINAL.includes(t) && o.cashOnHandover) {          // cash must land in an open Cash Shift
    try { shiftOpen = !!(await request('/pos/cash-shifts/current')); } catch { shiftOpen = null; }
    if (shiftOpen === false && $('coShiftWarn')) {
      $('coShiftWarn').innerHTML = '<div class="co-flag bad" style="margin-top:10px">You have no open Cash Shift. Open one first so this cash is counted in your drawer. <button type="button" class="btn-secondary" id="coGoShift" style="margin-top:6px">Open Cash Shift</button></div>';
      $('coSubmit').disabled = true;
    }
  }
}
function updateChange() {
  const box = $('coChange'); if (!box || !chosen) return;
  const v = parseMoney($('co_cashReceived').value), due = Number(chosen.total);
  if (v === null) { box.innerHTML = ''; return; }
  box.innerHTML = v + 1e-9 >= due ? `Change to give: <b>${peso(Math.round((v - due) * 100) / 100)}</b>` : `<span style="color:var(--red)">Short by <b>${peso(Math.round((due - v) * 100) / 100)}</b></span>`;
}

function collect() {                    // reads + validates the form; returns the request body or null
  const o = chosen, t = target, body = {}; let ok = true; clearErrs();
  const bad = (n, m) => { setErr(n, m); ok = false; };
  const val = (id) => ($('co_' + id) ? $('co_' + id).value.trim() : '');
  const note = val('note'); if (note.length > 200) bad('note', 'The note must be 200 characters or fewer'); body.note = note;
  if (t === 'Paid') {
    if (o.paymentStatus !== 'paid' && !isCash(o)) { const r = val('paymentRef'); if (!REF_RE.test(r)) bad('paymentRef', 'Enter the reference number (4\u201340 letters and numbers)'); body.paymentRef = r; }
  } else {
    body.status = t;
    if (t === 'Packed' && !$('co_checked').checked) bad('checked', 'Tick the box once you have counted the items');
    if (FINAL.includes(t)) {
      const name = val('receivedBy'), rep = $('co_rep').checked;
      if (!NAME_RE.test(name)) bad('receivedBy', 'Enter the full name (2\u201380 letters, no numbers)');
      body.receivedBy = name;
      if (rep) { const rel = val('relationship'); if (rel.length < 3 || rel.length > 60) bad('relationship', 'Enter how this person is related or authorised (3\u201360 characters)'); body.representative = true; body.relationship = rel; }
      if (t === 'Picked Up') {
        const type = val('pickupIdType'), last4 = val('pickupIdLast4');
        if (!ID_TYPES.includes(type)) bad('pickupIdType', 'Choose the ID that was presented');
        if (!/^[A-Za-z0-9]{4}$/.test(last4)) bad('pickupIdLast4', 'Enter exactly 4 letters or numbers');
        body.pickupIdType = type; body.pickupIdLast4 = last4;
      }
      if (o.cashOnHandover) {
        const cash = parseMoney(val('cashReceived'));
        if (cash === null) bad('cashReceived', 'Enter the cash received, e.g. 1500 or 1500.50');
        else if (cash + 1e-9 < Number(o.total)) bad('cashReceived', 'Less than the amount due (' + peso(o.total) + ')');
        else if (cash > Number(o.total) + 100000) bad('cashReceived', 'That is far above the total. Check the amount');
        else body.cashReceived = cash;
        if (shiftOpen === false) { $('coActErr').textContent = 'Open your Cash Shift first.'; ok = false; }
      }
    }
  }
  return ok ? body : null;
}
async function submit(e) {
  e.preventDefault(); if (busy || !chosen) return;
  const body = collect(); if (!body) { const first = document.querySelector('#coAction .co-fld.bad input,#coAction .co-fld.bad select'); if (first) first.focus(); return; }
  const o = chosen, t = target, btn = $('coSubmit'); busy = true; btn.disabled = true; btn.textContent = 'Saving\u2026';
  try {
    const res = await request('/orders/' + encodeURIComponent(o.id) + (t === 'Paid' ? '/confirm' : '/status'), { method: 'POST', body: JSON.stringify(body) });
    await load(true);
    if (res && res.change != null && body.cashReceived != null) {           // cash handover: show the change the cashier must give back
      $('coAction').innerHTML = `<div class="co-sheet"><h2 id="coActionTitle">${esc(t === 'Delivered' ? 'Delivered' : 'Released')} \u2014 payment recorded</h2><div class="co-sub">${esc(o.id)} \u00B7 added to your Cash Shift</div>
        <div class="co-box"><div class="faint">Cash received ${peso(body.cashReceived)} \u00B7 total ${peso(o.total)}</div><div class="co-change" style="font-size:16px">Give change: <b style="font-size:26px">${peso(res.change)}</b></div></div>
        <div class="co-actions"><button type="button" class="btn-secondary" data-slip="${esc(o.id)}">Print slip</button><button type="button" class="btn-primary" id="coDone">Done</button></div></div>`;
      render(); return;
    }
    closeAction(); message('', false); say(o.id + ': ' + (t === 'Paid' ? 'order confirmed' : t === 'Picked Up' ? 'released to the customer' : t === 'Delivered' ? 'marked delivered' : 'marked ' + t.toLowerCase()) + '.');
  } catch (err) {
    const names = Object.keys(err.fields || {});
    if (names.length) names.forEach((n) => setErr(n, err.fields[n])); else $('coActErr').textContent = err.message;
    if (err.fields && err.fields.status === undefined && !names.length) { /* plain error already shown */ }
    await load(true);                                                      // someone else may have changed the order: show the truth
    const fresh = byId(o.id);
    if (fresh && fresh.status !== o.status) { closeAction(); message(o.id + ' changed in the meantime: ' + err.message, true); }
    else if (btn.isConnected) { btn.disabled = shiftOpen === false; btn.textContent = ACTION[t] || 'Confirm'; }
  } finally { busy = false; if ($('coSubmit') && !$('coSubmit').disabled) $('coSubmit').textContent = ACTION[target] || 'Confirm'; }
}
async function checkPayment(id, btn) {
  if (busy) return; busy = true; const old = btn.textContent; btn.disabled = true; btn.textContent = 'Checking\u2026';
  try {
    const r = await request('/orders/' + encodeURIComponent(id) + '/check-payment', { method: 'POST', body: '{}' });
    await load(true);
    say(r.paymentStatus === 'paid' ? id + ': payment received, order confirmed.' : id + ': not paid yet.', r.paymentStatus !== 'paid');
  } catch (e) { message(e.message, true); say(e.message, true); }
  finally { busy = false; if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
}

/* ---------- events ---------- */
$('coTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; render(); } });
document.addEventListener('click', (e) => {
  const t = e.target; if (!t.closest) return;
  const detail = t.closest('[data-detail]'), act = t.closest('[data-act]'), chk = t.closest('[data-check]'), slip = t.closest('[data-slip]'), cash = t.closest('[data-cash]');
  if (detail && $('coList').contains(detail)) { const o = byId(detail.dataset.detail); if (o) openDetail(o); }
  else if (act && (act.closest('#coList') || act.closest('#coDetail'))) { const o = byId(act.dataset.act); if (o) { closeModal($('coDetail')); openAction(o); } }
  else if (chk && (chk.closest('#coList') || chk.closest('#coDetail'))) checkPayment(chk.dataset.check, chk);
  else if (slip) { const o = byId(slip.dataset.slip); if (o) printSlip(o); }
  else if (cash && $('coAction').contains(cash)) { $('co_cashReceived').value = cash.dataset.cash; updateChange(); }
  else if (t.closest('[data-close-detail]')) closeModal($('coDetail'));
  else if (t.id === 'coCancel') closeAction();
  else if (t.id === 'coDone') closeAction();
  else if (t.id === 'coGoShift') { closeAction(); if (typeof showPage === 'function') showPage('shift'); }
});
$('coAction').addEventListener('submit', (e) => { if (e.target.id === 'coForm') submit(e); });
$('coAction').addEventListener('input', (e) => {
  if (e.target.id === 'co_cashReceived') updateChange();
  const f = e.target.closest && e.target.closest('.co-fld'); if (f && f.dataset.fld) setErr(f.dataset.fld, '');
});
$('coAction').addEventListener('change', (e) => {
  if (e.target.id !== 'co_rep' || !chosen) return;                         // "someone else is collecting": the name must be typed fresh
  $('coRepBox').hidden = !e.target.checked;
  const n = $('co_receivedBy'); n.value = e.target.checked ? '' : (chosen.fulfillment === 'Delivery' ? (chosen.recipient || chosen.customer) : chosen.customer);
  if (e.target.checked) n.focus();
});
$('coSearch').addEventListener('input', render); $('coFilter').addEventListener('change', render); $('coRefresh').addEventListener('click', () => load(false));

window.cashierOrdersLoad = () => load(false);
load(true);                                                                // fills the "To confirm" badge in the menu right away
setInterval(() => { if (!document.hidden && $('coDetail').hidden && $('coAction').hidden && !busy) load(true); }, 45000);
})();
