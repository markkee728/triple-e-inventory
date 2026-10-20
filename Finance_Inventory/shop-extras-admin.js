/* shop-extras-admin.js — Finance Admin screens for the online shop extras:
     Quote Requests   customers ask for a price on bulk orders / custom sizes; Finance replies or closes the request
     Product Reviews  verified-purchase reviews; Finance can hide an inappropriate review (and restore it)
   Needs the two pages (#quotes, #reviews) and the two menu items that Finance_Inventory.html already contains.
   Load it after refund-admin.js:   <script src="shop-extras-admin.js?v=1"></script>
   Server routes (backend/shop-extras.js): GET /api/finance/quotes · POST /api/finance/quotes/:no · GET /api/finance/quote-options · POST /api/finance/quotes/:no/step · POST /api/finance/quotes/:no/payment
                                           GET /api/finance/reviews · POST /api/finance/reviews/:id/visibility
   The server checks every rule again; the checks here only give faster feedback. */
(function () {
  'use strict';

  var TZ = 'Asia/Manila';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var peso = function (n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (ms) { return ms ? new Date(ms).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  var day = function (ymd) { return ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; };
  var stars = function (n) { return '<span style="color:var(--amber);letter-spacing:1px" aria-label="' + n + ' out of 5">' + '\u2605'.repeat(n) + '<span style="opacity:.3">' + '\u2605'.repeat(5 - n) + '</span></span>'; };

  var quotes = [], reviews = [], qopts = null, busy = false, openQuote = null, loadingQ = false, loadingR = false;

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

  function addStyles() {
    var css =
      '.sx-badge{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:var(--red);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}' +
      '.sx-modal{max-width:640px;width:100%;max-height:92vh;overflow-y:auto}' +
      '.sx-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding-right:34px}.sx-head h2{margin:0;font-size:22px}' +
      '.sx-info{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:0 0 14px}.sx-info dt{font-size:12.5px;color:var(--text-faint);margin:0}.sx-info dd{margin:2px 0 0;font-size:15px;overflow-wrap:anywhere}' +
      '.sx-box{margin:0 0 14px;padding:11px 13px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.03);font-size:14.5px;white-space:pre-line;overflow-wrap:anywhere}.sx-box b{display:block;margin-bottom:3px}' +
      '.sx-form label{display:block;font-size:13.5px;font-weight:600;color:var(--text-dim);margin:12px 0 6px}.sx-form .form-input{width:100%;box-sizing:border-box}.sx-form textarea{min-height:90px;resize:vertical}' +
      '.sx-err{display:none;margin-top:10px;padding:9px 12px;border-radius:6px;font-size:13.5px;color:var(--red);background:rgba(227,91,91,.1);border:1px solid rgba(227,91,91,.35)}.sx-err.show{display:block}' +
      '.sx-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}' +
      '.sx-two{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.sx-sub{margin:16px 0 4px;font-weight:700;font-size:14px}' +
      '.sx-empty{padding:22px;text-align:center;color:var(--text-faint)}' +
      '.sx-text{max-width:340px;overflow-wrap:anywhere;white-space:pre-line}' +
      '.sxr-row{cursor:pointer;transition:background .15s}.sxr-row:hover{background:color-mix(in srgb,var(--text) 5%,transparent)}.sxr-row:focus-visible{outline:2px solid var(--blue-bright);outline-offset:-2px}' +
      '.sxr-who{display:flex;align-items:center;gap:10px;min-width:0}.sxr-av{flex:none;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#16283b;border:1px solid rgba(74,144,217,.35);color:var(--blue-bright);font:600 13px Oswald,sans-serif}html[data-theme="light"] .sxr-av{background:#dbe6f0;color:var(--blue)}' +
      '.sxr-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '.sxr-top{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--text) 4%,var(--panel));margin-bottom:14px}.sxr-top .sxr-av{width:56px;height:56px;font-size:22px}.sxr-top strong{display:block;font-size:18px}.sxr-top span.faint{font-size:14px;overflow-wrap:anywhere}' +
      '.sxr-h{margin:18px 0 10px;font:500 12.5px "IBM Plex Mono",monospace;letter-spacing:1.2px;text-transform:uppercase;color:var(--text-dim);display:flex;align-items:center;gap:12px}.sxr-h:after{content:"";flex:1;height:1px;background:var(--border)}' +
      '.sxr-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.sxr-f{padding:10px 13px;border:1px solid var(--border);border-radius:10px;background:color-mix(in srgb,var(--text) 3%,var(--panel));overflow-wrap:anywhere}.sxr-f span{display:block;font-size:12.5px;color:var(--text-dim);margin-bottom:3px}.sxr-f strong{font-size:14.5px;font-weight:600}.sxr-f.is-empty strong{font-weight:400;color:var(--text-faint)}' +
      '.sxr-review{padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--text) 3%,var(--panel))}.sxr-review p{margin:10px 0 0;white-space:pre-line;overflow-wrap:anywhere;line-height:1.5}' +
      '@media(max-width:560px){.sx-info,.sx-two,.sxr-grid{grid-template-columns:1fr}}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  var qPill = function (x) {
    var st = x.status, cls = st === 'quoted' ? (x.expired ? 'out' : 'in') : st === 'new' ? 'low' : (st === 'accepted' || st === 'preparing' || st === 'ready' || st === 'completed') ? 'in' : 'out';
    return '<span class="status-pill ' + cls + '">' + esc(x.expired ? 'Quote expired' : (x.statusLabel || st)) + '</span>';
  };
  var months = function (m) { return m + (m === 1 ? ' month' : ' months'); };
  var ini = function (n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?'; };
  var rPill = function (st) { return '<span class="status-pill ' + (st === 'hidden' ? 'out' : 'in') + '">' + (st === 'hidden' ? 'Hidden' : 'Visible') + '</span>'; };

  /* ---------------- page skeletons ---------------- */
  function build() {
    var q = $('quotes'), r = $('reviews');
    if (q) q.innerHTML =
      '<div class="catalog-header"><div><div class="catalog-eyebrow">Orders</div><h1 class="catalog-title">Quote Requests</h1>' +
      '</div>' +
      '<button class="btn-secondary btn-sm" id="sxqRefresh" type="button">Refresh</button></div>' +
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">Requests</div><div class="panel-sub" id="sxqSub">Loading\u2026</div></div>' +
      '<div class="inv-filters"><select id="sxqFilter" class="inv-select"><option value="open">Needs my action</option><option value="quoted">Waiting for the customer</option><option value="completed">Completed</option><option value="declined">Declined</option><option value="closed">Closed</option><option value="all">All requests</option></select></div></div>' +
      '<div class="table-wrapper"><table><thead><tr><th>Ref</th><th>Customer</th><th>Item</th><th>Quantity</th><th>Needed by</th><th>Received</th><th>Status</th><th></th></tr></thead><tbody id="sxqBody"></tbody></table></div></div>';
    if (r) r.innerHTML =
      '<div class="catalog-header"><div><div class="catalog-eyebrow">Orders</div><h1 class="catalog-title">Product Reviews</h1>' +
      '</div>' +
      '<button class="btn-secondary btn-sm" id="sxrRefresh" type="button">Refresh</button></div>' +
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">Reviews</div><div class="panel-sub" id="sxrSub">Loading\u2026</div></div>' +
      '<div class="inv-filters"><input type="text" id="sxrSearch" class="inv-search" placeholder="Search product, customer or text..." autocomplete="off">' +
      '<select id="sxrFilter" class="inv-select"><option value="all">All reviews</option><option value="visible">Visible</option><option value="hidden">Hidden</option></select></div></div>' +
      '<div class="table-wrapper"><table><thead><tr><th>Product</th><th>Rating</th><th>Customer</th><th>Review</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody id="sxrBody"></tbody></table></div></div>';
    if (q) {
      $('sxqRefresh').addEventListener('click', loadQuotes);
      $('sxqFilter').addEventListener('change', renderQuotes);
      $('sxqBody').addEventListener('click', function (e) { var b = e.target.closest('[data-sxq]'); if (b) openQ(b.dataset.sxq); });
    }
    if (r) {
      $('sxrRefresh').addEventListener('click', loadReviews);
      $('sxrFilter').addEventListener('change', renderReviews);
      $('sxrSearch').addEventListener('input', renderReviews);
      $('sxrBody').addEventListener('click', function (e) {
        var b = e.target.closest('[data-sxr]');
        if (b) {
          var rv = reviews.find(function (x) { return x.id === Number(b.dataset.sxr); });
          if (!rv) return;
          if (rv.status === 'hidden') setVisibility(rv, false, ''); else askHide(rv);
          return;
        }
        var tr = e.target.closest('[data-sxrow]'); if (tr) openReview(Number(tr.dataset.sxrow));
      });
      $('sxrBody').addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) { var tr = e.target.closest('[data-sxrow]'); if (tr) { e.preventDefault(); openReview(Number(tr.dataset.sxrow)); } }
      });
    }
  }

  /* ---------------- quotes ---------------- */
  var IN_FLOW = ['accepted', 'preparing', 'ready'];
  var needsAction = function (x) { return x.status === 'new' || IN_FLOW.indexOf(x.status) >= 0; };
  var newCount = function () { return quotes.filter(needsAction).length; };
  function renderQuotes() {
    if (!$('sxqBody')) return;
    var f = $('sxqFilter').value, n = newCount();
    var list = quotes.filter(function (x) { return f === 'all' || (f === 'open' ? needsAction(x) : x.status === f); });
    $('sxqSub').textContent = quotes.length ? (n ? n + ' need your action (new requests to price, or accepted quotes to prepare and hand over)' : 'Nothing waiting \u2014 all requests have been answered') + ' \u00B7 ' + quotes.length + ' in total'
      : 'Requests from customers will appear here.';
    $('sxqBody').innerHTML = list.length ? list.map(function (x) {
      return '<tr><td>' + esc(x.id) + '</td><td>' + esc(x.customer) + (x.source === 'pos' ? ' <span class="faint" style="font-size:12px">\u00B7 Walk-in</span>' : '') + '<div class="faint" style="font-size:12px">' + esc(x.phone) + '</div></td>' +
        '<td>' + esc(x.product || 'Custom item') + (x.sku ? '<div class="faint" style="font-size:12px">' + esc(x.sku) + '</div>' : '') + '</td>' +
        '<td>' + esc(x.quantity) + '</td><td>' + esc(x.neededBy ? day(x.neededBy) : x.neededMonths ? 'within ' + months(x.neededMonths) : '\u2014') + '</td><td>' + esc(when(x.createdAt)) + '</td><td>' + qPill(x) + '</td>' +
        '<td style="white-space:nowrap"><button type="button" class="' + (needsAction(x) ? 'btn-primary' : 'btn-secondary') + ' btn-sm" data-sxq="' + esc(x.id) + '">' + (x.status === 'new' ? 'Reply' : IN_FLOW.indexOf(x.status) >= 0 ? 'Manage' : 'View') + '</button></td></tr>';
    }).join('') : '<tr><td colspan="8" class="sx-empty">' + (quotes.length ? 'No requests in this view.' : 'No quote requests yet.') + '</td></tr>';
    paintBadge();
  }
  function paintBadge() {
    var nav = document.querySelector('.nav-item[data-page="quotes"]'); if (!nav) return;
    var n = newCount(), b = nav.querySelector('.sx-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'sx-badge'; nav.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n); b.title = n + ' quote request(s) need your action';
  }
  async function loadQuotes() {
    if (loadingQ) return; loadingQ = true;
    try {
      if (!qopts) { try { qopts = await api('/finance/quote-options'); } catch (e) { /* the reply form shows a message if this is still missing */ } }
      var d = await api('/finance/quotes'); quotes = Array.isArray(d) ? d : [];
      if (!(openQuote && busy)) renderQuotes();
      if (openQuote && !busy) paintQuote();
    } catch (e) { if (e.message !== 'Not signed in' && $('sxqSub') && !quotes.length) $('sxqSub').textContent = 'Could not load quote requests: ' + e.message; }
    finally { loadingQ = false; }
  }

  var overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'sxOverlay';
    overlay.innerHTML = '<div class="account-modal sx-modal" role="dialog" aria-modal="true"><button type="button" class="modal-close" id="sxClose" aria-label="Close">\u00D7</button><div id="sxBody"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !busy) closeModal(); });
    $('sxClose').addEventListener('click', function () { if (!busy) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('open') && !busy) closeModal(); });
    return overlay;
  }
  function closeModal() { openQuote = null; if (overlay) overlay.classList.remove('open'); }
  function openQ(id) { openQuote = id; paintQuote(); ensureOverlay().classList.add('open'); }
  var info = function (label, value) { return value ? '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>' : ''; };

  function paintQuote() {
    var x = quotes.find(function (q) { return q.id === openQuote; });
    ensureOverlay();
    if (!x) { closeModal(); return; }
    var o = qopts || { leadTimes: [], validDays: [7] };
    var h = '<div class="sx-head"><h2>Quote \u00B7 ' + esc(x.id) + '</h2>' + qPill(x) + '</div>' +
      '<dl class="sx-info">' + info('Customer', x.customer) + info('Phone', x.phone) + info('Email', x.email) + info('Came from', x.source === 'pos' ? 'Walk-in at the counter (no account \u2014 reply by phone)' : 'Online shop') + info('Item', x.product || 'Custom item') + info('SKU', x.sku) +
      info('Quantity', x.quantity) + info('Needed by', x.neededBy ? day(x.neededBy) : (x.neededMonths ? 'within ' + months(x.neededMonths) : '')) + info('Receive by', x.fulfillment ? x.fulfillment + (x.area ? ' \u00B7 ' + x.area : '') : '') + info('Received', when(x.createdAt)) + '</dl>' +
      '<div class="sx-box"><b>Sizes and details</b>' + esc(x.details) + '</div>';
    var inFlow = IN_FLOW.indexOf(x.status) >= 0;
    if (x.status !== 'new') {
      var title = { quoted: x.expired ? 'Quote sent (expired)' : 'Quote sent', declined: 'Customer declined this quote', closed: 'Closed', completed: (x.statusLabel || 'Completed') }[x.status] || 'Customer accepted this quote';
      h += '<div class="sx-box"><b>' + esc(title) + (x.quotedAmount != null ? ' \u2014 ' + peso(x.quotedAmount) : '') + '</b>' +
        (x.leadTime ? 'Ready in: ' + esc(x.leadTime) + '\n' : '') + (x.payMethod && x.status !== 'quoted' && x.status !== 'declined' ? 'Payment method: ' + esc(x.payMethod) + (x.payOnline ? ' (the customer pays online; it is recorded automatically when paid)' : x.payLater ? ' (collect the payment, then record it below)' : '') + '\n' : '') + (x.validUntil && x.status === 'quoted' ? 'Price valid until: ' + esc(day(x.validUntil)) + '\n' : '') +
        (x.handledBy ? 'Handled by ' + esc(x.handledBy) + (x.updatedAt ? ' \u00B7 ' + esc(when(x.updatedAt)) : '') + '\n' : '') + (x.replyNote ? esc(x.replyNote) : '') +
        (x.respondedAt && x.status !== 'quoted' ? '\nAnswered: ' + esc(when(x.respondedAt)) + (x.responseNote ? ' \u2014 ' + esc(x.responseNote) : '') : '') + '</div>';
    }
    if (x.status === 'pending_approval') h += '<div class="sx-box"><b>Cashier pricing requires approval</b><p>Proposed total: ' + peso(x.proposedAmount || 0) + '</p><p>Reason: ' + esc(x.approvalReason || 'Not provided') + '</p></div>';
    if (inFlow || x.status === 'completed') {
      var steps = (x.progress || []).map(function (e) { return '\u2022 ' + esc(e.label) + ' \u2014 ' + esc(when(e.at)) + (e.note ? ' (' + esc(e.note) + ')' : ''); }).join('\n');
      h += '<div class="sx-box"><b>Progress</b>' + steps + '</div>';
      var pays = (x.payments || []).map(function (p) { return '\u2022 ' + peso(p.amount) + ' \u00B7 ' + esc(p.method) + ' \u2014 ' + esc(when(p.at)) + (p.note ? ' (' + esc(p.note) + ')' : ''); }).join('\n');
      h += '<div class="sx-box"><b>Payment \u2014 paid ' + peso(x.paidAmount || 0) + ' of ' + peso(x.quotedAmount || 0) + (x.balance > 0 ? ' \u00B7 balance ' + peso(x.balance) : ' \u00B7 fully paid') + '</b>' + (pays || 'No payment recorded yet.') + '</div>';
    }
    h += '<div class="sx-form">';
    if (inFlow) {
      if (x.balance > 0) {
        h += '<div class="sx-sub">Record a payment</div><div class="sx-two"><div><label for="sxPayAmt">Amount received (\u20B1)</label><input type="text" data-money class="form-input" id="sxPayAmt" inputmode="decimal" autocomplete="off" placeholder="up to ' + Number(x.balance).toFixed(2) + '"></div>' +
          '<div><label for="sxPayMethod">Paid by</label><select id="sxPayMethod" class="form-input"><option value="">Choose</option>' + ((qopts && qopts.payMethods) || []).map(function (m) { return '<option' + (x.payMethod === m ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('') + '</select></div></div>' +
          '<div class="sx-actions" style="margin-top:8px"><button type="button" class="btn-secondary" id="sxPay">Record payment</button></div>';
      }
      if (x.next) {
        h += '<div class="sx-sub">Next step: ' + esc(x.nextLabel) + '</div>';
        if (x.next === 'completed') h += '<label for="sxRecv">' + (x.fulfillment === 'Delivery' ? 'Received by' : 'Picked up by') + ' <span class="faint" style="font-weight:400">(name of the person, required)</span></label><input type="text" class="form-input" id="sxRecv" maxlength="80" autocomplete="off">' + (x.balance > 0 ? '<div class="faint" style="margin-top:6px;font-size:13px">The balance of ' + peso(x.balance) + ' must be paid first.</div>' : '');
      }
    } else if (x.status !== 'completed') {
      h += '<label for="sxAmount">Total quoted amount (\u20B1) <span class="faint" style="font-weight:400">(required to send a quote)</span></label><input type="text" data-money class="form-input" id="sxAmount" inputmode="decimal" autocomplete="off" placeholder="e.g. 164000.00" value="' + (x.quotedAmount != null ? MoneyInput.fmt(x.quotedAmount) : '') + '">' +
        '<div class="sx-two"><div><label for="sxLead">Ready in</label><select id="sxLead" class="form-input"><option value="">Choose</option>' + (o.leadTimes || []).map(function (t) { return '<option value="' + esc(t) + '"' + (x.leadTime === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
        '<div><label for="sxDays">Price valid for</label><select id="sxDays" class="form-input">' + (o.validDays || [7]).map(function (d) { return '<option value="' + d + '"' + (d === 7 ? ' selected' : '') + '>' + d + ' days</option>'; }).join('') + '</select></div></div>';
      if (!qopts) h += '<div class="sx-err show">Could not load the lead-time choices. Press Refresh and open this request again.</div>';
    }
    if (x.status !== 'completed') h += '<label for="sxNote">' + (inFlow ? 'Note' : 'Message to the customer') + ' <span class="faint" style="font-weight:400">(optional' + (inFlow ? ', saved with the step or the cancellation' : '') + ')</span></label><textarea id="sxNote" class="form-input" maxlength="1500" placeholder="' + (inFlow ? 'e.g. Cutting done, waiting for powder coating.' : 'e.g. Price is per full quantity. Delivery fee is extra.') + '">' + esc(x.status === 'new' || inFlow ? '' : (x.replyNote || '')) + '</textarea>';
    h += '<div class="sx-err" id="sxErr" role="alert"></div><div class="sx-actions">';
    if (x.status === 'pending_approval') h += '<button type="button" class="btn-primary" id="sxApprovePrice">Approve cashier price</button>';
    if (inFlow && x.next) h += '<button type="button" class="btn-primary" id="sxStep">' + esc(x.nextLabel === 'Preparing' ? 'Start preparing' : x.next === 'completed' ? 'Mark ' + String(x.nextLabel).toLowerCase() : 'Mark ' + String(x.nextLabel).toLowerCase()) + '</button>';
    if (!inFlow && x.status !== 'completed') h += '<button type="button" class="btn-primary" id="sxSend">' + (x.status === 'new' ? 'Send quote' : 'Send updated quote') + '</button>';
    if (x.status !== 'completed') h += '<button type="button" class="btn-secondary" id="sxCloseReq">' + (x.status === 'closed' ? 'Keep closed' : inFlow ? 'Cancel this quote' : 'Close request') + '</button>';
    if (x.status !== 'new' && !inFlow && x.status !== 'completed') h += '<button type="button" class="btn-secondary" id="sxReopen">Reopen</button>';
    h += '</div></div>';
    $('sxBody').innerHTML = h;
    if ($('sxApprovePrice')) $('sxApprovePrice').addEventListener('click', function () { post(x, '/approve-price', {}, 'Cashier price approved.'); });
    if ($('sxSend')) $('sxSend').addEventListener('click', function () { submitQuote(x, 'quoted'); });
    if ($('sxStep')) $('sxStep').addEventListener('click', function () { submitStep(x); });
    if ($('sxPay')) $('sxPay').addEventListener('click', function () { submitPayment(x); });
    if ($('sxCloseReq')) $('sxCloseReq').addEventListener('click', function () { submitQuote(x, 'closed'); });
    if ($('sxReopen')) $('sxReopen').addEventListener('click', function () { submitQuote(x, 'new'); });
  }
  function showErr(msg) { var b = $('sxErr'); if (b) { b.textContent = msg; b.classList.add('show'); } }

  async function submitQuote(x, status) {
    if (busy) return;
    var note = $('sxNote').value.trim(), amount = $('sxAmount') ? MoneyInput.raw($('sxAmount').value) : '', lead = $('sxLead') ? $('sxLead').value : '', days = $('sxDays') ? $('sxDays').value : '';
    $('sxErr').classList.remove('show');
    if (note && note.length < 5) { showErr('Write at least 5 characters, or leave the message empty.'); $('sxNote').focus(); return; }
    if (status === 'quoted') {
      if (!amount) { showErr('Enter the quoted amount.'); $('sxAmount').focus(); return; }
      var n = Number(amount.replace(/[,\u20B1\s]/g, ''));
      if (!(n > 0)) { showErr('Enter a valid amount greater than 0.'); $('sxAmount').focus(); return; }
      if (!lead) { showErr('Choose how long it will take to make or prepare.'); $('sxLead').focus(); return; }
    }
    busy = true; overlay.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      var body = { status: status, note: note };
      if (status === 'quoted') { body.amount = amount; body.leadTime = lead; body.validDays = Number(days); }
      await api('/finance/quotes/' + encodeURIComponent(x.id), { method: 'POST', body: JSON.stringify(body) });
      toast(status === 'quoted' ? 'Quote sent for ' + x.id + '.' : status === 'closed' ? x.id + ' closed.' : x.id + ' reopened.');
      busy = false; closeModal(); await loadQuotes();
    } catch (e) {
      busy = false; if (e.message === 'Not signed in') return;
      await loadQuotes(); if (openQuote) { paintQuote(); $('sxNote').value = note; if ($('sxAmount')) $('sxAmount').value = amount; if ($('sxLead')) $('sxLead').value = lead; showErr((e.fields && Object.values(e.fields)[0]) || e.message); }
    } finally { busy = false; }
  }

  async function post(x, path, body, doneMsg) {
    if (busy) return;
    busy = true; overlay.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      await api('/finance/quotes/' + encodeURIComponent(x.id) + path, { method: 'POST', body: JSON.stringify(body) });
      toast(doneMsg); busy = false; await loadQuotes(); if (openQuote) paintQuote();
    } catch (e) {
      busy = false; if (e.message === 'Not signed in') return;
      await loadQuotes(); if (openQuote) { paintQuote(); showErr((e.fields && Object.values(e.fields)[0]) || e.message); }
    } finally { busy = false; }
  }
  function submitStep(x) {
    $('sxErr').classList.remove('show');
    var note = $('sxNote') ? $('sxNote').value.trim() : '', recv = $('sxRecv') ? $('sxRecv').value.trim() : '';
    if (note.length > 200) { showErr('Keep the note under 200 characters for a step.'); return; }
    if (x.next === 'completed' && recv.length < 2) { showErr('Enter the name of the person who ' + (x.fulfillment === 'Delivery' ? 'received' : 'picked up') + ' the order.'); $('sxRecv').focus(); return; }
    post(x, '/step', { status: x.next, note: note, receivedBy: recv || undefined }, x.id + ': ' + x.nextLabel + '.');
  }
  function submitPayment(x) {
    $('sxErr').classList.remove('show');
    var amt = MoneyInput.raw($('sxPayAmt').value), method = $('sxPayMethod').value;
    if (!(Number(amt.replace(/[,\u20B1\s]/g, '')) > 0)) { showErr('Enter the amount received.'); $('sxPayAmt').focus(); return; }
    if (!method) { showErr('Choose how it was paid.'); $('sxPayMethod').focus(); return; }
    post(x, '/payment', { amount: amt, method: method }, 'Payment recorded for ' + x.id + '.');
  }

  /* ---------------- reviews ---------------- */
  function renderReviews() {
    if (!$('sxrBody')) return;
    var f = $('sxrFilter').value, t = $('sxrSearch').value.trim().toLowerCase();
    var list = reviews.filter(function (r) {
      return (f === 'all' || r.status === f) && (!t || (r.product + ' ' + r.sku + ' ' + r.customer + ' ' + r.body).toLowerCase().indexOf(t) >= 0);
    });
    var hidden = reviews.filter(function (r) { return r.status === 'hidden'; }).length;
    $('sxrSub').textContent = reviews.length ? reviews.length + ' review' + (reviews.length === 1 ? '' : 's') + ' \u00B7 ' + hidden + ' hidden' : 'Reviews will appear here after customers rate products they received.';
    $('sxrBody').innerHTML = list.length ? list.map(function (r) {
      return '<tr class="sxr-row" tabindex="0" role="button" aria-label="View review and customer details for ' + esc(r.customer) + '" data-sxrow="' + r.id + '"><td>' + esc(r.product) + '<div class="faint" style="font-size:12px">' + esc(r.sku) + '</div></td><td>' + stars(r.rating) + '</td>' +
        '<td><div class="sxr-who"><span class="sxr-av" aria-hidden="true">' + esc(ini(r.customer)) + '</span><div>' + esc(r.customer) + (r.orderNo ? '<div class="faint" style="font-size:12px">Order ' + esc(r.orderNo) + '</div>' : '') + '</div></div></td>' +
        '<td class="sx-text">' + (r.body ? '<span class="sxr-clamp">' + esc(r.body) + '</span>' : '<span class="faint">No comment</span>') + (r.status === 'hidden' && r.hiddenReason ? '<div class="faint" style="font-size:12px;margin-top:4px">Hidden: ' + esc(r.hiddenReason) + (r.hiddenBy ? ' (' + esc(r.hiddenBy) + ')' : '') + '</div>' : '') + '</td>' +
        '<td>' + esc(when(r.createdAt)) + '</td><td>' + rPill(r.status) + '</td>' +
        '<td style="white-space:nowrap"><button type="button" class="' + (r.status === 'hidden' ? 'btn-secondary' : 'btn-danger') + ' btn-sm" data-sxr="' + r.id + '">' + (r.status === 'hidden' ? 'Restore' : 'Hide') + '</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="sx-empty">' + (reviews.length ? 'No reviews match.' : 'No reviews yet.') + '</td></tr>';
  }
  async function loadReviews() {
    if (loadingR) return; loadingR = true;
    try { var d = await api('/finance/reviews'); reviews = Array.isArray(d) ? d : []; renderReviews(); }
    catch (e) { if (e.message !== 'Not signed in' && $('sxrSub') && !reviews.length) $('sxrSub').textContent = 'Could not load reviews: ' + e.message; }
    finally { loadingR = false; }
  }
  var fld = function (l, v) { var e = v == null || String(v).trim() === ''; return '<div class="sxr-f' + (e ? ' is-empty' : '') + '"><span>' + esc(l) + '</span><strong>' + (e ? 'Not provided' : esc(v)) + '</strong></div>'; };
  var reviewToken = 0;
  async function openReview(id) {
    var rv = reviews.find(function (x) { return x.id === id; }); if (!rv) return;
    ensureOverlay(); openQuote = null; var tok = ++reviewToken;
    function paint(d, note) {
      d = d || {};
      $('sxBody').innerHTML = '<div class="sx-head"><h2>Review details</h2>' + rPill(rv.status) + '</div>' +
        '<div class="sxr-review"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><strong>' + esc(rv.product) + '</strong>' + stars(rv.rating) + '</div>' +
        '<div class="faint" style="font-size:12.5px;margin-top:2px">' + esc(rv.sku) + (rv.orderNo ? ' \u00B7 Order ' + esc(rv.orderNo) : '') + ' \u00B7 ' + esc(when(rv.createdAt)) + '</div>' +
        '<p>' + (rv.body ? esc(rv.body) : '<span class="faint">No comment</span>') + '</p>' +
        (rv.status === 'hidden' && rv.hiddenReason ? '<div class="faint" style="font-size:13px;margin-top:8px">Hidden: ' + esc(rv.hiddenReason) + (rv.hiddenBy ? ' (' + esc(rv.hiddenBy) + ')' : '') + '</div>' : '') + '</div>' +
        '<div class="sxr-h">Customer</div>' +
        '<div class="sxr-top"><span class="sxr-av" aria-hidden="true">' + esc(ini(d.name || rv.customer)) + '</span><div><strong>' + esc(d.name || rv.customer) + '</strong><span class="faint">' + esc(d.email || rv.email || '') + '</span></div></div>' +
        (note ? '<p class="faint" style="margin:0">' + esc(note) + '</p>' :
          '<div class="sxr-grid">' + fld('Phone', d.phone) + fld('Birthdate', d.birthdate) + fld('Gender', d.gender) + fld('Email Verified', d.emailVerified ? 'Yes' : 'No') +
          fld('Joined', d.joined) + fld('Last Login', d.lastLogin) + fld('Company', d.companyName) + fld('Position', d.companyPosition) + '</div>') +
        '<div class="sx-actions"><button type="button" class="' + (rv.status === 'hidden' ? 'btn-secondary' : 'btn-danger') + '" id="sxrAct">' + (rv.status === 'hidden' ? 'Restore review' : 'Hide review') + '</button><button type="button" class="btn-secondary" id="sxCancel">Close</button></div>';
      $('sxCancel').addEventListener('click', closeModal);
      $('sxrAct').addEventListener('click', function () { if (rv.status === 'hidden') setVisibility(rv, false, ''); else askHide(rv); });
    }
    paint(null, 'Loading customer details\u2026'); overlay.classList.add('open');
    try {
      if (!rv.userId) throw new Error('Customer details unavailable.');
      var res = await fetch('/api/customers/' + encodeURIComponent(rv.userId) + '/profile', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Customer details unavailable (' + res.status + ').');
      var d = await res.json(); if (tok === reviewToken && overlay.classList.contains('open')) paint(d);
    } catch (e) { if (tok === reviewToken && overlay.classList.contains('open')) paint(null, e.message); }
  }
  function askHide(rv) {
    ensureOverlay(); openQuote = null;
    $('sxBody').innerHTML = '<div class="sx-head"><h2>Hide this review?</h2></div>' +
      '<div class="sx-box"><b>' + esc(rv.customer) + ' on ' + esc(rv.product) + ' \u00B7 ' + rv.rating + '/5</b>' + (rv.body ? esc(rv.body) : 'No comment') + '</div>' +
      '<p class="faint" style="margin:0 0 6px">Customers will no longer see it, and it stops counting toward the star rating. You can restore it any time.</p>' +
      '<div class="sx-form"><label for="sxReason">Reason (kept in the audit log)</label><input type="text" class="form-input" id="sxReason" maxlength="300" placeholder="e.g. Abusive language">' +
      '<div class="sx-err" id="sxErr" role="alert"></div><div class="sx-actions"><button type="button" class="btn-danger" id="sxHide">Hide review</button><button type="button" class="btn-secondary" id="sxCancel">Cancel</button></div></div>';
    overlay.classList.add('open'); $('sxReason').focus();
    $('sxCancel').addEventListener('click', closeModal);
    $('sxHide').addEventListener('click', function () {
      var reason = $('sxReason').value.trim();
      if (reason.length < 3) { showErr('Write a short reason (at least 3 characters).'); return; }
      setVisibility(rv, true, reason);
    });
  }
  async function setVisibility(rv, hide, reason) {
    if (busy) return; busy = true;
    try {
      await api('/finance/reviews/' + rv.id + '/visibility', { method: 'POST', body: JSON.stringify({ hidden: hide, reason: reason }) });
      toast(hide ? 'Review hidden.' : 'Review restored.'); busy = false; closeModal(); await loadReviews();
    } catch (e) { busy = false; if (e.message !== 'Not signed in') { if (overlay && overlay.classList.contains('open') && $('sxErr')) showErr(e.message); else toast(e.message, true); } }
    finally { busy = false; }
  }

  /* ---------------- start ---------------- */
  function start() {
    if (!$('quotes') || !$('reviews')) return;
    addStyles(); build(); loadQuotes(); loadReviews();
    [['quotes', loadQuotes], ['reviews', loadReviews]].forEach(function (p) {
      var sec = $(p[0]);
      new MutationObserver(function () { if (sec.classList.contains('active-page')) p[1](); }).observe(sec, { attributes: true, attributeFilter: ['class'] });
    });
    setInterval(function () { if (!document.hidden && !busy && !openQuote) loadQuotes(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !busy && !openQuote) loadQuotes(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();