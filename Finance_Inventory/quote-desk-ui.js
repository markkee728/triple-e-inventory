/* quote-desk-ui.js — the Cashier Quotation Desk screen (POS_Cashier.html > Quotations).
   Talks to GET /api/pos/quote-desk (search, filters, sorting, pagination and facet counts are done by the server),
   to GET/POST /api/pos/quote-desk/:no[...] for one quotation, its reference files and the order conversion, and reuses
   the existing /api/pos/quotes/:no/clarifications | /price | /respond routes for the life-cycle itself.
   Expects the page globals: $, api, esc, peso, toast, PRODUCTS, prod, showPage, QuoteFields. */
(function () {
  'use strict';

  const PAGE_SIZES = [10, 20, 50, 100];
  const FILTERS = [['all', 'All requests'], ['open', 'Needs my action'], ['approval', 'With Finance'], ['quoted', 'Quote ready'], ['active', 'Accepted'], ['done', 'Closed']];
  const SOURCES = [['all', 'Online + walk-in'], ['shop', 'Online only'], ['pos', 'Walk-in only']];
  const CLARIFY = [['dimensions', 'Size / dimensions'], ['thickness', 'Thickness'], ['material', 'Material / grade'], ['finish', 'Surface finish'], ['quantity', 'Quantity / unit'], ['other', 'Other detail']];

  const S = { rows: [], total: 0, pageCount: 1, page: 1, pageSize: 20, counts: {}, sort: 'created', dir: 'desc', filter: 'open', source: 'all', q: '', busy: false, error: '', detail: null, openPrice: false, openTerms: false, view: 'requests' };
  const desk = (p) => '/api/pos/quote-desk' + p;
  const el = (id) => document.getElementById(id);
  const day = (v) => (!v ? '—' : new Date(v).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }));
  const shortDay = (v) => (!v ? '—' : new Date(v).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }));
  const money = (v) => (v == null || !Number.isFinite(Number(v)) ? null : peso(Number(v)));
  const neededText = (r) => (r.neededBy ? shortDay(r.neededBy) : r.flexibleDate ? 'Flexible' : r.neededMonths ? 'Within ' + r.neededMonths + ' mo' : 'Not set');
  const pillClass = (r) => (r.expired || ['declined', 'closed'].includes(r.status) ? 'bad' : ['new', 'awaiting_details', 'pending_approval'].includes(r.status) ? 'warn' : 'ok');
  const qtyParts = (text) => { const m = /^([\d,.]+)\s+(.+)$/.exec(String(text || '').trim()); if (!m) return null; const n = Number(m[1].replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? { qty: n, unit: m[2] } : null; };
  const requestId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 32) : 'qd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14));
  const fieldErr = (e) => (e && e.fields ? Object.values(e.fields)[0] : e && e.message) || 'Something went wrong. Try again.';
  async function call(path, opts) {
    try { return await api(path, opts); }
    catch (e) {                                          // api() throws a plain Error; keep the server's per-field message
      const body = e && e.fields ? e : null;
      throw Object.assign(new Error(body ? Object.values(body.fields)[0] : e.message), { fields: body && body.fields });
    }
  }

  /* ================= 1. the two views ================= */
  function showView(which) {
    S.view = which === 'walkin' ? 'walkin' : 'requests';
    el('qdRequestsView').hidden = S.view !== 'requests';
    el('qdWalkinView').hidden = S.view !== 'walkin';
    el('qdTabRequests').setAttribute('aria-selected', String(S.view === 'requests'));
    el('qdTabWalkin').setAttribute('aria-selected', String(S.view === 'walkin'));
    if (S.view === 'walkin') ensureFields(); else loadDesk();
  }

  /* ================= 2. the request queue ================= */
  function listUrl() {
    const p = ['sort=' + encodeURIComponent(S.sort), 'dir=' + encodeURIComponent(S.dir), 'status=' + encodeURIComponent(S.filter),
      'source=' + encodeURIComponent(S.source), 'page=' + S.page, 'pageSize=' + S.pageSize];
    if (S.q.trim()) p.push('q=' + encodeURIComponent(S.q.trim()));
    return desk('?' + p.join('&'));
  }
  async function loadDesk() {
    if (S.busy) return;
    S.busy = true; S.error = '';
    renderList();
    try {
      const r = await call(listUrl());
      S.rows = r.rows || []; S.total = r.total || 0; S.pageCount = r.pageCount || 1; S.page = r.page || 1; S.pageSize = r.pageSize || 20;
      S.counts = r.counts || {}; S.sort = r.sort; S.dir = r.dir; S.filter = r.filter; S.source = r.source;
      const ready = S.counts.quoted || 0;
      el('navQuoteCount').textContent = ready; el('navQuoteCount').hidden = !ready;
      el('navQuoteCount').title = ready + ' quote(s) ready to tell the customer';
      el('pqRequestCount').textContent = (S.counts.open || 0) + (S.counts.approval || 0);
    } catch (e) {
      S.rows = []; S.error = e instanceof TypeError ? 'No connection to the server. Check your network and try again.' : fieldErr(e);
    }
    S.busy = false;
    renderList(); renderPager();
  }
  function tableHeads() {
    const cols = [['ref', 'Reference', 'reference'], ['customer', 'Customer', 'customer'], ['product', 'Product', 'product'],
      ['qty', 'Quantity', null], ['needed', 'Needed by', 'needed'], ['amount', 'Quoted amount', 'amount'],
      ['requested', 'Requested', 'created'], ['status', 'Status', 'status'], ['source', 'Source', null], ['act', '', null]];
    return '<tr>' + cols.map(([k, label, sort]) => {
      const on = sort && S.sort === sort;
      return '<th' + (sort ? ' data-sort="' + sort + '"' : '') + (on ? ' aria-sort="' + (S.dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + ' scope="col">' +
        label + (sort ? '<span class="qd-arrow">' + (on ? (S.dir === 'asc' ? '▲' : '▼') : '↕') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
  }
  function rowCells(r) {
    const amt = money(r.amount);
    return '<td><span class="qd-ref">' + esc(r.id) + '</span></td>' +
      '<td><div class="qd-who"><b>' + esc(r.customer || '—') + '</b><small>' + esc(r.phone || '') + (r.company ? ' · ' + esc(r.company) : '') + '</small></div></td>' +
      '<td><div class="qd-what"><b>' + esc(r.product || 'Custom item') + '</b><small>' + (r.sku ? esc(r.sku) + ' · catalog' : 'custom specification') + '</small></div></td>' +
      '<td class="qd-num">' + esc(r.quantity || '—') + '</td>' +
      '<td>' + neededText(r) + '</td>' +
      '<td class="qd-num">' + (amt || (r.proposedAmount != null ? 'proposed ' + money(r.proposedAmount) : '—')) + '</td>' +
      '<td>' + day(r.requestDate) + '</td>' +
      '<td><span class="qd-pill ' + pillClass(r) + '">' + esc(r.statusLabel || r.status) + '</span>' + (r.financeNote && r.status === 'new' ? '<small class="qd-back">Sent back by Finance</small>' : '') + '</td>' +
      '<td><span class="qd-src ' + (r.source === 'pos' ? 'pos' : '') + '">' + (r.source === 'pos' ? 'Walk-in' : 'Online') + '</span></td>' +
      '<td class="is-right"><button type="button" class="qd-open" data-open="' + esc(r.id) + '">Open</button></td>';
  }
  function cardRow(r) {
    const amt = money(r.amount);
    return '<div class="qd-qcard" data-open="' + esc(r.id) + '" tabindex="0" role="button" aria-label="Open quotation ' + esc(r.id) + '">' +
      '<div class="qd-line"><span class="qd-ref">' + esc(r.id) + '</span><span class="qd-pill ' + pillClass(r) + '">' + esc(r.statusLabel || r.status) + '</span></div>' +
      '<div class="qd-who"><b>' + esc(r.customer || '—') + '</b><small>' + esc(r.phone || '') + '</small></div>' +
      '<div class="qd-what"><b>' + esc(r.product || 'Custom item') + '</b><small>' + esc(r.quantity || '') + ' · needed ' + neededText(r) + '</small></div>' +
      '<div class="qd-line"><span class="qd-mut">' + (r.source === 'pos' ? 'Walk-in' : 'Online') + ' · ' + day(r.requestDate) + '</span>' +
      '<span class="qd-num">' + (amt || (r.proposedAmount != null ? 'proposed ' + money(r.proposedAmount) : '—')) + '</span></div></div>';
  }
  function renderList() {
    const bar = el('qdChips');
    if (bar) bar.innerHTML = FILTERS.map(([k, label]) => '<button type="button" class="qd-chip' + (S.filter === k ? ' on' : '') + '" data-filter="' + k + '" aria-pressed="' + (S.filter === k) + '">' +
      label + '<em>' + (S.counts[k] != null ? S.counts[k] : 0) + '</em></button>').join('');
    const head = el('qdHead'); if (head) head.innerHTML = tableHeads();
    const body = el('qdBody'), cards = el('qdCards');
    if (S.busy) { if (body) body.innerHTML = ''; if (cards) cards.innerHTML = ''; el('qdState').hidden = false; el('qdState').className = 'qd-state';
      el('qdState').innerHTML = '<div class="qd-skeleton"></div><div class="qd-skeleton" style="margin-top:10px"></div><div class="qd-skeleton" style="margin-top:10px"></div><p style="margin:14px 0 0">Loading quotations…</p>'; el('qdTablewrap').style.display = 'none'; return; }
    if (S.error) { el('qdState').hidden = false; el('qdState').className = 'qd-state error';
      el('qdState').innerHTML = '<strong>Could not load the quotation list.</strong><p>' + esc(S.error) + '</p><button type="button" class="btn-secondary qd-retry" data-retry>Try again</button>';
      el('qdTablewrap').style.display = 'none'; if (cards) cards.innerHTML = ''; return; }
    el('qdState').hidden = true;
    if (!S.rows.length) { el('qdTablewrap').style.display = 'none'; if (cards) cards.innerHTML = '';
      el('qdState').hidden = false; el('qdState').className = 'qd-state'; el('qdState').textContent = 'No quotation matches this search or filter.'; return; }
    el('qdTablewrap').style.display = '';
    if (body) body.innerHTML = S.rows.map((r) => '<tr data-open="' + esc(r.id) + '" tabindex="0">' + rowCells(r) + '</tr>').join('');
    if (cards) cards.innerHTML = S.rows.map(cardRow).join('');
    el('qdNote').textContent = 'Showing page ' + S.page + ' of ' + S.pageCount + ' · ' + S.total + ' quotation' + (S.total === 1 ? '' : 's') + ' in this filter';
  }
  function renderPager() {
    const box = el('qdPager'); if (!box) return;
    box.innerHTML = '<span>' + (S.total ? 'Quotations are newest first unless you sort another column.' : '') + '</span>' +
      '<span class="qd-pager-btns"><button type="button" class="btn-secondary btn-sm" data-page="prev"' + (S.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<span style="align-self:center">Page ' + S.page + ' / ' + S.pageCount + '</span>' +
      '<button type="button" class="btn-secondary btn-sm" data-page="next"' + (S.page >= S.pageCount ? ' disabled' : '') + '>Next</button></span>';
  }

  /* ================= 3. one quotation in a drawer ================= */
  async function openDetail(no) {
    el('qdScrim').hidden = false; el('qdDrawer').hidden = false;
    void el('qdDrawer').offsetWidth;                                       // flush layout so the slide starts off-screen; rAF never fires in a background tab
    el('qdScrim').classList.add('open'); el('qdDrawer').classList.add('open');
    el('qdDrawerTitle').textContent = no; el('qdDrawerSub').textContent = 'Loading…';
    el('qdDrawerBody').innerHTML = '<div class="qd-skeleton"></div><div class="qd-skeleton" style="margin-top:12px"></div><div class="qd-skeleton" style="margin-top:12px"></div>';
    el('qdDrawerFoot').innerHTML = '';
    document.body.style.overflow = 'hidden';
    try { S.detail = await call(desk('/' + encodeURIComponent(no))); S.openPrice = false; S.openTerms = false; renderDetail(); }
    catch (e) { S.detail = null; el('qdDrawerBody').innerHTML = '<div class="qd-callout bad">Could not open this quotation: ' + esc(fieldErr(e)) + '</div>'; }
  }
  function closeDetail() {
    S.detail = null;
    el('qdScrim').classList.remove('open'); el('qdDrawer').classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => { el('qdScrim').hidden = true; el('qdDrawer').hidden = true; }, 240);
  }
  const kv = (pairs) => '<dl class="qd-kv">' + pairs.filter((p) => p[1] !== null && p[1] !== undefined && p[1] !== '').map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>';
  const sec = (title, inner) => '<section class="qd-sec"><h4>' + esc(title) + '</h4>' + inner + '</section>';

  const row = (label, value) => [label, value];
  const noteBox = (text) => '<div class="qd-note-box">' + esc(text) + '</div>';

  function renderDetail() {
    const d = S.detail; if (!d) return;
    el('qdDrawerSub').textContent = (d.statusLabel || d.status) + ' · ' + (d.source === 'pos' ? 'Walk-in at the counter' : 'Online request');
    const sp = d.specs || {};
    const payWhere = d.payMethod || (d.fulfillment === 'Delivery' ? 'Cash on delivery' : 'Pay at pickup');
    const parts = [
      sec('Customer', kv([
        row('Name', '<b>' + esc(d.customer || '—') + '</b>'),
        row('Mobile', esc(d.phone || '—')),
        row('Email', esc(d.contactEmail || d.email || 'not given')),
        row('Company', esc(d.company || '—')),
        row('Requested by', esc(d.createdBy || (d.source === 'pos' ? 'this counter' : 'the customer'))),
        row('Online account', d.customerId ? 'yes — only the customer can answer here' : 'no, a walk-in request at this counter')])),

      sec('What they need', kv([
        row('Item', '<b>' + esc(d.product || 'Custom item') + '</b>' + (d.sku ? ' <span class="dim">· catalog ' + esc(d.sku) + '</span>' : ' <span class="dim">· custom specification</span>')),
        row('Quantity', esc(d.quantity || '—')),
        row('Item type', esc(sp.itemType || (d.sku ? 'Ready-made catalog product (sold by ' + ((d.quantity || '').split(' ').slice(1).join(' ') || 'pcs') + ')' : '—'))),
        row('Material', esc(sp.material || '—')),
        row('Size', esc(sp.size || '—')),
        row('Thickness', esc(sp.thickness || '—')),
        row('Finish', esc(sp.finish || '—')),
        row('Machining / secondary work', esc(sp.service || '—')),
        row('Needed by', neededText(d)),
        row('Customer notes', d.details ? noteBox(d.details) : '') ])),

      sec('How they want it', kv([
        row('Fulfilment', esc(d.fulfillment || '—')),
        row('Delivery area', esc(d.area || '—')),
        row('Where they pay', esc(payWhere)) ])),

      sec('Price', kv([
        row('Quoted amount', money(d.amount) || '—'),
        row('Paid so far', money(d.paidAmount) || '₱0.00'),
        row('Balance', d.balance != null ? money(d.balance) : '—'),
        row('Estimated availability', esc(d.leadTime || '—')),
        row('Estimated ready date', d.estimatedReady ? '<b>' + esc(day(d.estimatedReady)) + '</b> <span class="dim">· ' + (d.readyFromAcceptance ? 'counted from the day the customer accepted' : 'if the customer accepts today') + '</span>' + (d.lateForNeededBy ? ' <span class="qd-pill warn">later than the date they need it</span>' : '') : '—'),
        row('Price valid until', d.validUntil ? day(d.validUntil) + (d.expired ? ' <span class="qd-pill bad">expired</span>' : '') : '—'),
        row('Finance approval', d.status === 'pending_approval'
            ? '<span class="qd-pill warn">Waiting for Finance</span> ' + (d.proposedAmount != null ? 'your price ' + money(d.proposedAmount) + ' · ' : '') + esc(d.approvalReason || '')
          : d.financeNote && d.status === 'new' ? '<span class="qd-pill bad">Sent back by Finance</span> ' + esc(d.financeNote) + (d.proposedAmount != null ? ' <span class="dim">· your price was ' + money(d.proposedAmount) + '</span>' : '')
          : d.approvalReason && d.amount != null ? '<span class="qd-pill ok">Approved by Finance</span> ' + esc(d.approvalReason)
          : 'not needed'),
        row('Closed because', d.status === 'closed' && d.closeReason ? '<span class="qd-pill bad">Closed by Finance</span> ' + esc(d.closeReason) : ''),
        row('Note to customer', d.replyNote ? noteBox(d.replyNote) : ''),
        row('Customer answer', d.responseNote ? noteBox(d.responseNote) : '') ])),

      sec('Payment terms on this quotation', termsSectionHtml(d)),
      sec('History', timelineHtml(d)),
      d.orderNo ? sec('Converted', '<div class="qd-callout ok">This quotation became order <b>' + esc(d.orderNo) + '</b>. A quotation is not a reservation: stock leaves inventory only at the sale or order-confirm step.</div>') : '',
      sec('Pricing', priceFormHtml(d))
    ];
    el('qdDrawerBody').innerHTML = parts.filter(Boolean).join('');
    el('qdDrawerFoot').innerHTML = footHtml(d);
    // fill the term lists from the policy once the markup exists — the amounts must come from the server
    const q = qtyParts(d.quantity);
    if (S.openPrice) {
      const form = el('qdPriceForm'), unit = form && form.querySelector('[name=unit]');
      const total = unit && unit.value && q ? Number(unit.value) * q.qty : (d.proposedAmount != null ? d.proposedAmount : d.amount);
      loadTermOptions(form, total, (d.terms || {}).key);
      if (form && unit && unit.value && q) { const t = form.querySelector('[data-total]'); if (t) t.textContent = peso(total); syncRoute(form, total); }
      loadSystemPrice(d, form);
    }
    if (S.openTerms) loadTermOptions(el('qdTermsForm'), d.amount != null ? d.amount : d.proposedAmount, (d.terms || {}).key);
  }
  function timelineHtml(d) {
    const items = (d.clarifications || []).map((c) => '<div class="qd-tl-item ' + (c.status === 'answered' ? 'done' : 'wait') + '">' +
      '<b>Clarification ' + (c.status === 'answered' ? 'answered' : 'waiting for the customer') + '</b><time>' + day(c.createdAt) + '</time>' +
      '<p>' + esc((c.fields || []).join(', ')) + ' — ' + esc(c.message) + '</p>' +
      (c.response ? '<p><b>Customer replied:</b> ' + esc(c.response) + '</p>' : '') +
      (c.submittedSpecs ? '<p><b>New details:</b> ' + esc(Object.entries(c.submittedSpecs).map(([k, v]) => k + ': ' + v).join(' · ')) + '</p>' : '') +
      '</div>');
    (d.progress || []).forEach((p) => items.push('<div class="qd-tl-item done"><b>' + esc(p.label || p.status) + '</b><time>' + day(p.at) + '</time>' + (p.note ? '<p>' + esc(p.note) + '</p>' : '') + '</div>'));
    (d.notes || []).slice(0, 8).forEach((n) => items.push('<div class="qd-tl-item"><b>' + esc(n.action) + '</b><time>' + day(n.at) + ' · ' + esc(n.by || '') + '</time><p>' + esc(n.detail) + '</p></div>'));
    return items.length ? '<div class="qd-tl">' + items.join('') + '</div>' : '<p class="qd-mut dim" style="margin:0">Nothing has happened on this request yet.</p>';
  }
  /* the system price (pricing.js): worked out from the request's material, size, finish, service and quantity + the markup.
     It is filled in as the unit price when the cashier has not typed one; the cashier can still change it. */
  async function loadSystemPrice(d, form) {
    const box = form && form.querySelector('[data-sys]'); if (!box) return;
    let e;
    try { e = await api('/api/pricing/quote/' + encodeURIComponent(d.id)); } catch (err) { box.innerHTML = '<p class="q-hint">The system price could not be worked out: ' + esc(err.message) + '</p>'; return; }
    if (!box.isConnected) return;
    if (!e.ok) { box.innerHTML = '<p class="q-hint">No system price yet: the request does not give the ' + esc((e.missing || []).join(', ')) + '.</p>'; return; }
    S.sysCost = { id: d.id, total: e.catalog ? e.costPerPiece * e.quantity : e.costTotal };
    box.innerHTML = '<div class="qd-sys-head"><span>System price <span class="dim">(automatic)</span></span><strong>' + peso(e.total) + '</strong></div>' +
      '<div class="dim">' + peso(e.pricePerPiece) + ' per piece \u00D7 ' + esc(e.quantity) + ' \u00B7 cost ' + peso(e.costPerPiece) + '/pc + ' + esc(e.markupPct) + '% markup</div>' +
      '<details><summary>How it is worked out</summary><ul>' + (e.lines || []).map((l) => '<li><span>' + esc(l.label) + '</span><b>' + peso(l.amount) + '</b></li>').join('') +
      (e.weightKg ? '<li><span>Estimated weight: ' + esc(e.weightKg) + ' kg (' + esc(e.weightBasis) + ')</span><b></b></li>' : '') + '</ul></details>' +
      ((e.notes || []).length ? '<p class="q-hint">' + esc(e.notes.join(' ')) + '</p>' : '') +
      '<button type="button" class="btn-secondary btn-sm" data-use-sys="' + esc(e.pricePerPiece) + '">Use the system price</button>';
    const unit = form.querySelector('[name=unit]');
    if (unit && !unit.value) { unit.value = String(e.pricePerPiece); unit.dispatchEvent(new Event('input', { bubbles: true })); }
    box.querySelector('[data-use-sys]').addEventListener('click', (ev) => { unit.value = ev.currentTarget.dataset.useSys; unit.dispatchEvent(new Event('input', { bubbles: true })); unit.focus(); });
  }
  function priceFormHtml(d) {
    const can = ['new', 'pending_approval', 'awaiting_details'].includes(d.status);
    if (!can) return d.status === 'awaiting_details' ? '<div class="qd-callout warn">Waiting for the customer to send the missing details. Pricing opens as soon as they reply.</div>' : '';
    if (!S.openPrice) return ['new', 'pending_approval'].includes(d.status)
      ? '<button type="button" class="btn-secondary" data-act="price">' + (d.status === 'pending_approval' ? 'Edit and resubmit the price' : 'Prepare a price') + '</button>'
      : '<p class="q-hint">Pricing is only possible while the request is pending cashier review or waiting for Finance; ' + esc(d.statusLabel || d.status) + ' requests are handled from the buttons below.</p>';
    const o = window.PQ_OPTIONS || {}, q = qtyParts(d.quantity) || {};
    const back = d.financeNote && d.status === 'new' ? '<div class="qd-callout warn">Finance sent your price back: <b>' + esc(d.financeNote) + '</b>. Change the price and send it again.</div>' : '';
    const unit = d.proposedAmount != null && q.qty ? (d.proposedAmount / q.qty).toFixed(2) : '';
    return back + '<form class="qd-price" id="qdPriceForm" novalidate>' +
      '<div class="qd-sys wide" data-sys><p class="q-hint">Working out the system price\u2026</p></div>' +
      '<label>Unit price (PHP)<input name="unit" type="number" step="0.01" min="0" placeholder="0.00" value="' + esc(unit) + '" required></label>' +
      '<label>Quantity<input value="' + esc(d.quantity || '—') + '" disabled></label>' +
      '<div class="qd-calc"><span>Calculated total for the customer' + (q.qty ? ' <span class="dim">(' + q.qty + ' × unit price)</span>' : '') + '</span><strong data-total>—</strong></div>' +
      '<div class="qd-callout wide" data-route role="status" hidden></div>' +
      '<label>Estimated availability<select name="leadTime" required><option value="">Select…</option>' + (o.leadTimes || []).map((x) => '<option value="' + esc(x) + '">' + esc(x) + '</option>').join('') + '</select></label>' +
      '<div class="qd-calc" data-ready hidden role="status"><span>Estimated ready date <span class="dim">(working days, if accepted today)</span></span><strong data-ready-date>—</strong></div>' +
      '<div class="qd-callout warn wide" data-ready-late hidden>That is later than the date the customer needs it' + (d.neededBy ? ' (' + esc(shortDay(d.neededBy)) + ')' : '') + '. Choose a shorter time, or say in your remarks when you can deliver.</div>' +
      '<label>Quotation validity<select name="validDays" required>' + (o.validDays || []).map((x) => '<option value="' + esc(x) + '"' + (x === 7 ? ' selected' : '') + '>' + esc(x) + ' days</option>').join('') + '</select></label>' +
      '<fieldset class="qd-terms"><legend>Payment terms</legend>' +
      '<div class="qd-term-list" data-terms-opts><p class="q-hint">Reading the payment policy…</p></div>' +
      '<small class="q-hint">Only the terms Finance switched on for this kind of item appear. Choosing one never takes money now; it says what the customer pays now and what stays outstanding.</small></fieldset>' +
      '<label class="wide">Remarks for the customer<textarea name="note" maxlength="1500" rows="2" placeholder="What is included, any assumption you made, how to reach you"></textarea></label>' +
      '<label class="qd-check"><input type="checkbox" name="exception"> Custom manufacturing, or a price that needs Finance approval first</label>' +
      '<label class="wide" data-reason hidden>Why Finance must approve<textarea name="reason" maxlength="500" rows="2" placeholder="Costing, material sourcing, or the discount you are asking for"></textarea></label>' +
      '<div class="err-text wide" data-price-err role="alert"></div>' +
      '<div class="wide" style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn-secondary" data-act="cancelprice">Cancel</button>' +
      '<button type="submit" class="btn-primary">' + (d.status === 'pending_approval' ? 'Resubmit for approval' : 'Review & send price') + '</button></div></form>' +
      '<p class="q-hint">Approval status: ' + esc(d.status === 'pending_approval' ? 'waiting for Finance' : limitHint()) + '</p>';
  }
  /* ---- payment terms. The policy table, the allowed scope per item type and every peso figure come from the
     backend; this screen only renders what GET /api/pos/payment-terms returns for the total being quoted. ---- */
  const TERM_NAME = { full: 'Full Payment', half: 'Half Payment', down: 'Down Payment', custom: 'Custom partial payment' };
  const TERMS_STATE = { none: ['No terms attached yet', 'warn'], proposed: ['Proposed — waiting for Finance', 'warn'],
    approved: ['Approved', 'ok'], rejected: ['Refused — full payment', 'bad'] };
  let termSeq = 0, termTimer = null;

  function termOptionHtml(o, current) {
    const on = o.key === (current || 'full');
    return '<label class="qd-term' + (Number(o.percent) < 100 ? ' partial' : '') + '">' +
      '<input type="radio" name="term" value="' + esc(o.key) + '"' + (on ? ' checked' : '') + '>' +
      '<span class="qd-term-name">' + esc(o.label || TERM_NAME[o.key] || o.key) + '</span>' +
      '<span class="qd-term-calc">Pay now <b>' + (money(o.dueNow) || '—') + '</b> · balance <b>' + (money(o.balance) || '₱0.00') + '</b>' +
      (o.balanceCondition ? ' <em>— ' + esc(o.balanceCondition) + '</em>' : '') + '</span>' +
      (o.enabledBy ? '<span class="qd-term-by">switched on by ' + esc(o.enabledBy) + '</span>' : '') + '</label>';
  }

  async function loadTermOptions(root, total, current) {
    const box = root && root.querySelector('[data-terms-opts]'); if (!box) return;
    const seq = ++termSeq, d = S.detail;
    if (!(Number(total) > 0)) { box.innerHTML = '<p class="q-hint">Enter the quoted total first — which terms are allowed depends on the amount.</p>'; return; }
    box.innerHTML = '<p class="q-hint">Reading the payment policy…</p>';
    try {
      const r = await call('/api/pos/payment-terms?total=' + encodeURIComponent(Number(total).toFixed(2)) +
        '&madeToOrder=' + (d && d.madeToOrder ? 'true' : 'false'));
      if (seq !== termSeq || !box.isConnected) return;
      const opts = (r && r.options) || [];
      S.termOpts = opts;
      box.innerHTML = opts.length ? opts.map((o) => termOptionHtml(o, current)).join('')
        : '<p class="q-hint">Only Full Payment is allowed for this item.</p>';
      syncTermFields(root);
    } catch (e) { if (seq === termSeq && box.isConnected) box.innerHTML = '<p class="q-hint qd-bad">The payment policy could not be read: ' + esc(fieldErr(e)) + '</p>'; }
  }

  // when the balance is paid: a step the release gate enforces, worded for this quotation's pickup / delivery
  const balanceDue = (d) => [[d.fulfillment === 'Delivery' ? 'balance due before delivery' : 'balance due before pickup', d.fulfillment === 'Delivery' ? 'Before delivery' : 'Before pickup'],
    ['balance due before production starts', 'Before production starts']];
  // the balance fields only matter for a part-payment
  function syncTermFields(root) {
    if (!root) return; const pick = root.querySelector('input[name=term]:checked'), partial = !!pick && pick.value !== 'full';
    root.querySelectorAll('[data-cond]').forEach((x) => { x.hidden = !partial; });
  }
  function termsSectionHtml(d) {
    const t = d.terms, state = (t && t.state) || 'none', lab = TERMS_STATE[state] || TERMS_STATE.none;
    const settled = Number(d.paidAmount) > 0;
    const canSet = !d.converted && !settled && ['new', 'awaiting_details', 'pending_approval', 'quoted'].includes(d.status);
    if (S.openTerms) {
      const total = d.amount != null ? d.amount : d.proposedAmount;
      if (!(Number(total) > 0)) return '<div class="qd-callout">Set the price first — the payment options depend on the quoted total.</div>' +
        '<button type="button" class="btn-secondary" data-act="cancelterms">Close</button>';
      const cur = (t && t.condition) || '';
      return '<form class="qd-price qd-terms-form" id="qdTermsForm" novalidate>' +
        '<div class="qd-term-list" data-terms-opts><p class="q-hint">Reading the payment policy…</p></div>' +
        '<label class="wide" data-cond hidden>Balance due<select name="condition">' + balanceDue(d).map((c) =>
          '<option value="' + esc(c[0]) + '"' + (c[0] === cur ? ' selected' : '') + '>' + esc(c[1]) + '</option>').join('') + '</select></label>' +
        '<label class="wide" data-cond hidden>Note for Finance <span class="q-optional">(optional)</span><textarea name="note" rows="2" maxlength="300" placeholder="Why a part-payment for this job"></textarea></label>' +
        '<div class="err-text wide" data-terms-err role="alert"></div>' +
        '<div class="wide" style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn-secondary" data-act="cancelterms">Cancel</button>' +
        '<button type="submit" class="btn-primary">Save terms</button></div></form>' +
        '<p class="q-hint">Part-payments need Finance approval before the customer sees them.</p>';
    }
    return kv([
      row('Payment term', t ? '<b>' + esc(TERM_NAME[t.key] || t.key) + '</b>' + (t.percent != null ? ' — ' + t.percent + '%' : '') : '<b>Full Payment</b> — everything before release'),
      row('Initial payment', t && t.amount != null ? money(t.amount) : money(d.amount) || '—'),
      row('Remaining balance', t && t.balance != null ? money(t.balance) : '₱0.00'),
      row('Balance due', t && t.condition ? esc(t.condition) : 'nothing further to pay'),
      row('Estimated availability', esc((t && t.availability) || d.leadTime || '—')),
      row('Approval', '<span class="qd-pill ' + lab[1] + '">' + lab[0] + '</span>' +
        (t && t.decidedAt ? ' <span class="dim">' + esc(t.decidedBy || 'Finance') + ' · ' + day(t.decidedAt) + '</span>' : '')),
      row('Customer reviewed', t && t.seenAt ? day(t.seenAt) : 'not yet'),
      row('Confirmed payments', (money(d.paidAmount) || '₱0.00') + ' <span class="dim">· ' + esc(d.paymentState || 'unpaid') +
        (Number(d.balance) > 0 ? ', outstanding ' + money(d.balance) : '') + '</span>')
    ]) + (settled ? '<div class="qd-callout">Money is already recorded against this quotation, so its terms are fixed. Collect the rest at the counter or with the payment link.</div>'
      : canSet ? '<button type="button" class="btn-secondary" data-act="terms">' + (t && state !== 'none' ? 'Change the payment terms' : 'Choose the payment terms') + '</button>' : '');
  }

  async function saveTerms(form) {
    const d = S.detail; if (!d) return;
    const err = form.querySelector('[data-terms-err]'), f = new FormData(form);
    const key = f.get('term'), condition = key === 'full' ? '' : String(f.get('condition') || '').trim(), note = key === 'full' ? '' : String(f.get('note') || '').trim();
    err.textContent = '';
    if (!key) { err.textContent = 'Choose a payment term from the list.'; return; }
    const o = (S.termOpts || []).find((x) => x.key === key) || {};
    const go = await pqConfirm({ title: 'Attach these payment terms to the quotation?',
      description: key === 'full' ? 'Full Payment: the customer settles everything before the goods are released.'
        : 'This is sent to Finance as a proposal. The customer is not shown partial terms until Finance signs them.',
      rows: [['Quotation', d.id], ['Customer', d.customer], ['Total quoted', money(d.amount) || '—'],
        ['Term', o.label || TERM_NAME[key] || key], ['Pay now', money(o.dueNow) || '—'], ['Balance', money(o.balance) || '₱0.00'],
        ['Balance due', condition || o.balanceCondition || 'before release']],
      acknowledgment: 'These amounts are what the customer and I agreed.', confirmLabel: 'Save terms' });
    if (!go) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/terms', { method: 'POST', body: JSON.stringify({ termKey: key, condition: condition || undefined, note: note || undefined }) });
      toast(r.terms && r.terms.state === 'proposed' ? 'Sent to Finance to approve the terms.' : 'Payment terms saved for this quotation.');
      S.openTerms = false; await openDetail(d.id); loadDesk();
    } catch (e) { err.textContent = fieldErr(e); btn.disabled = false; }
  }

  function footHtml(d) {
    const b = [];
    if (['new', 'awaiting_details'].includes(d.status) && d.customerId) b.push('<button type="button" class="btn-secondary" data-act="clarify">Request missing details</button>');
    if (d.status === 'quoted' && d.source === 'pos' && !d.expired) b.push('<button type="button" class="btn-primary" data-act="accept">Customer accepted</button><button type="button" class="btn-secondary" data-act="decline">Customer declined</button>');
    if (d.status === 'quoted' && d.expired) b.push('<button type="button" class="btn-secondary" data-act="renew">Ask Finance for a new price</button>');
    if (d.status === 'quoted' && d.source !== 'pos') b.push('<button type="button" class="btn-secondary" data-act="renew">Ask Finance to re-issue</button>');
    if (d.status === 'accepted') b.push('<button type="button" class="btn-primary" data-act="convert">' + (d.source === 'pos' ? 'Hand over to the counter' : 'Convert into an order') + '</button>');
    if (d.converted) b.push('<span class="qd-callout ok" style="flex:1 1 220px">Already converted to ' + esc(d.orderNo || 'an order') + '.</span>');
    b.push('<button type="button" class="btn-secondary" data-act="close">Close</button>');
    return b.join('');
  }

  /* ================= 4. actions ================= */
  function pqConfirm(opts) {
    return new Promise((resolve) => {
      const overlay = el('pqConfirmOverlay'), yes = el('pqConfirmSubmit'), ack = el('pqConfirmAcknowledged'), prior = document.activeElement;
      el('pqConfirmTitle').textContent = opts.title;
      el('pqConfirmDesc').textContent = opts.description;
      el('pqConfirmSummary').replaceChildren();
      (opts.rows || []).forEach(([label, value]) => {
        const row = document.createElement('div'); row.className = 'pq-review-row';
        const l = document.createElement('span'); l.textContent = label;
        const v = document.createElement('strong'); v.textContent = String(value == null ? '—' : value);
        row.append(l, v); el('pqConfirmSummary').append(row);
      });
      el('pqConfirmAckLabel').textContent = opts.acknowledgment;
      el('pqConfirmError').textContent = ''; ack.checked = false; yes.disabled = true; yes.textContent = opts.confirmLabel || 'Confirm';
      overlay.hidden = false; document.body.style.overflow = 'hidden'; el('pqConfirmCancel').focus();
      const cleanup = (result) => { overlay.hidden = true; document.body.style.overflow = S.detail ? 'hidden' : '';
        ack.removeEventListener('change', onChange); yes.removeEventListener('click', onYes); el('pqConfirmCancel').removeEventListener('click', onCancel);
        el('pqConfirmClose').removeEventListener('click', onCancel); overlay.removeEventListener('click', onBackdrop); document.removeEventListener('keydown', onKey);
        if (prior && prior.focus) prior.focus(); resolve(result); };
      const onChange = () => { yes.disabled = !ack.checked; };
      const onYes = () => { if (ack.checked) cleanup(true); };
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => { if (e.target === overlay) onCancel(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } if (e.key === 'Tab') {
        const list = Array.from(overlay.querySelectorAll('button,input')).filter((x) => !x.disabled); if (!list.length) return;
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
      ack.addEventListener('change', onChange); yes.addEventListener('click', onYes); el('pqConfirmCancel').addEventListener('click', onCancel);
      el('pqConfirmClose').addEventListener('click', onCancel); overlay.addEventListener('click', onBackdrop); document.addEventListener('keydown', onKey);
    });
  }

  async function doClarify() {
    const d = S.detail; if (!d) return;
    const overlay = el('qdClarifyOverlay');
    el('qdClarifySubtitle').textContent = d.id + ' · ' + (d.customer || 'customer') + ' · ' + (d.product || 'custom item');
    el('qdClarifyForm').reset(); el('qdClarifyError').textContent = '';
    el('qdClarifyDue').min = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    // what the request says NOW for each detail, so the cashier asks only for what is really missing (those are ticked for them)
    const sp = d.specs || {}, cur = { dimensions: sp.size, thickness: sp.thickness, material: sp.material, finish: sp.finish, quantity: d.quantity };
    const missing = (v) => !v || /^(not specified|not sure)/i.test(String(v));
    const grid = overlay.querySelector('.qd-modal-grid');
    grid.innerHTML = (sp.itemType || d.product ? '<p class="qd-cl-item">' + esc(d.product || 'Custom item') + (sp.itemType ? ' · ' + esc(sp.itemType) : '') + '</p>' : '') +
      CLARIFY.map(([k, label]) => { const v = cur[k], gap = k !== 'other' && missing(v);
        return '<label class="qd-cl' + (gap ? ' gap' : '') + '"><input type="checkbox" name="fields" value="' + k + '"' + (gap ? ' checked' : '') + '>' +
          '<span><b>' + esc(label) + '</b><small>' + (k === 'other' ? 'Anything not listed above' : 'Now: ' + esc(v || 'not given')) + '</small></span>' + (gap ? '<em>missing</em>' : '') + '</label>'; }).join('');
    // a starting message from what is ticked; the cashier can rewrite it (it is only filled while untouched)
    const msg = el('qdClarifyMessage'); msg.dataset.auto = '1';
    const suggest = () => {
      if (msg.dataset.auto !== '1') return;
      const picked = Array.from(grid.querySelectorAll('[name=fields]:checked')).map((x) => x.value);
      if (!picked.length) { msg.value = ''; return; }
      const words = picked.map((k) => k === 'other' ? 'any other detail we should know' : ({ dimensions: 'the exact size (length x width x height, with the unit)', thickness: 'the wall thickness in mm', material: 'the material or grade', finish: 'the surface finish', quantity: 'the quantity' })[k] + (cur[k] && !missing(cur[k]) ? ' (you wrote: ' + cur[k] + ')' : ''));
      msg.value = 'Hi ' + (d.customer || '').split(' ')[0] + ', to price your ' + (d.product || 'custom item') + ' we need ' + (words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1] : words[0]) + '. Please reply with the exact values in your account.';
    };
    grid.onchange = suggest; msg.oninput = () => { msg.dataset.auto = ''; };
    suggest();
    overlay.hidden = false; overlay.classList.add('open'); msg.focus();
    el('qdClarifyForm').onsubmit = async (e) => {
      e.preventDefault();
      const fields = Array.from(overlay.querySelectorAll('[name=fields]:checked')).map((x) => x.value);
      const message = el('qdClarifyMessage').value.trim(), responseDue = el('qdClarifyDue').value, err = el('qdClarifyError');
      err.textContent = '';
      if (!fields.length || message.length < 15 || message.length > 1000) { err.textContent = 'Tick at least one detail and explain what you need in 15–1000 characters.'; return; }
      const go = await pqConfirm({ title: 'Send this clarification request?', description: 'The quotation moves to “Awaiting Customer Details”, the customer is notified, and your original notes stay untouched.',
        rows: [['Quotation', d.id], ['Customer', d.customer], ['Details asked for', fields.map((f) => (CLARIFY.find((c) => c[0] === f) || [f, f])[1]).join(', ')], ['Message', message], ['Suggested reply by', responseDue || 'no date set']],
        acknowledgment: 'I checked that these details really are missing before pricing.', confirmLabel: 'Confirm & send' });
      if (!go) return;
      const btn = el('qdClarifySubmit'); btn.disabled = true;
      try { await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/clarifications', { method: 'POST', body: JSON.stringify({ fields, message, responseDue: responseDue || null }) });
        closeClarify(); toast('Clarification sent. The customer can now reply in their account.'); await openDetail(d.id); loadDesk(); }
      catch (ex) { err.textContent = fieldErr(ex); }
      finally { btn.disabled = false; }
    };
  }
  function closeClarify() { const o = el('qdClarifyOverlay'); o.classList.remove('open'); o.hidden = true; }

  async function doRespond(action) {
    const d = S.detail; if (!d) return;
    const names = { accept: 'Record that the customer accepted', decline: 'Record that the customer declined', renew: 'Ask Finance for a new price' };
    const go = await pqConfirm({ title: names[action] + '?',
      description: action === 'accept' ? 'Only record acceptance after the walk-in customer said yes out loud. This does not take payment and does not reserve stock.'
        : 'Confirm the response before it is written to the quotation.',
      rows: [['Quotation', d.id], ['Customer', d.customer], ['Item', d.product], ['Quantity', d.quantity], ['Quoted amount', money(d.amount) || '—'], ['Step', names[action]]],
      acknowledgment: action === 'accept' ? 'The customer explicitly accepted this quotation.' : 'I verified this response with the customer or with Finance.',
      confirmLabel: 'Confirm response' });
    if (!go) return;
    try { await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/respond', { method: 'POST', body: JSON.stringify({ action }) });
      toast(action === 'accept' ? 'Acceptance recorded. Ring it up at the counter or convert it to an order — payment is not collected yet.' : action === 'decline' ? 'Decline recorded.' : 'Finance asked for a new price.');
      await openDetail(d.id); loadDesk(); }
    catch (e) { toast(fieldErr(e), true); }
  }

  async function doConvert() {
    const d = S.detail; if (!d) return;
    const walkIn = d.source === 'pos' || !d.customerId;
    const paid = Number(d.paidAmount) || 0, owing = Number(d.balance) || 0;
    const go = await pqConfirm({ title: walkIn ? 'Hand this accepted quotation to the counter?' : 'Convert this accepted quotation into an order?',
      description: walkIn ? 'The item goes into the Point of Sale cart at the quoted unit price. The customer still pays there, and stock leaves inventory only when the sale is completed.'
        : 'One order will be created for the accepted quantity and price. Payments already recorded on the quotation move onto it, so the customer never pays twice.',
      rows: [['Quotation', d.id], ['Customer', d.customer], ['Item', (d.product || 'Custom item') + (d.sku ? ' (' + d.sku + ')' : '')], ['Quantity', d.quantity], ['Total', money(d.amount) || '—'],
        ['Payment term', d.terms ? (TERM_NAME[d.terms.key] || d.terms.key) + (d.terms.percent != null ? ' — ' + d.terms.percent + '%' : '') : 'Full Payment'],
        ['Already paid', money(paid) || '₱0.00'], ['Still outstanding', money(owing) || '₱0.00']],
      acknowledgment: 'The accepted price and quantity above are exactly what the customer agreed to.',
      confirmLabel: walkIn ? 'Hand over' : 'Create the order' });
    if (!go) return;
    try {
      const r = await call(desk('/' + encodeURIComponent(d.id) + '/convert'), { method: 'POST', body: JSON.stringify({ requestId: requestId() }) });
      if (r.kind === 'pos') {
        window.QUOTE_HANDOVER = d.id;
        toast('Added to the sale: ' + r.qty + ' ' + r.unit + ' of ' + r.name + ' at ' + peso(r.unitPrice) + '.');
        closeDetail(); showPage('terminal'); addToCart(r.sku);
        const line = cart.find((x) => x.sku === r.sku); if (line) { line.qty = Math.min(r.qty, line.qty > r.qty ? line.qty : r.qty); renderCart(); }
      } else {
        toast(r.duplicate ? 'This quotation was already converted — order ' + r.orderNo + '.' : 'Order ' + r.orderNo + ' created. It is unpaid until the normal payment step.');
        await openDetail(d.id); loadDesk();
      }
    } catch (e) { toast(fieldErr(e), true); }
  }

  // live "estimated ready date" under the lead-time select: working days from today (Philippine time), never a weekend
  function updateReady(form) {
    const d = S.detail, o = window.PQ_OPTIONS || {}, box = form.querySelector('[data-ready]'), out = form.querySelector('[data-ready-date]'), late = form.querySelector('[data-ready-late]');
    if (!box || !d) return;
    const n = (o.leadWorkdays || {})[form.elements.leadTime.value];
    if (!n) { box.hidden = true; late.hidden = true; return; }
    let x = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) + 'T00:00:00Z'), left = n;
    while (left > 0) { x = new Date(x.getTime() + 86400000); const w = x.getUTCDay(); if (w !== 0 && w !== 6) left--; }
    const iso = x.toISOString().slice(0, 10);
    out.textContent = day(iso); box.hidden = false; late.hidden = !(d.neededBy && iso > d.neededBy);
  }

  /* Whether a price goes to Finance is decided by the server's cashier ceiling (GET /api/pos/quote-options).
     Going over it is automatic and needs no written reason; only the "custom manufacturing" tick asks for one. */
  const cashierLimit = () => { const n = Number((window.PQ_OPTIONS || {}).cashierQuoteLimit || 0); return n > 0 ? n : 0; };
  const overLimit = (total) => { const lim = cashierLimit(); return lim <= 0 || total > lim; };
  function limitHint() {
    const lim = cashierLimit();
    return lim > 0 ? 'you can send prices up to ' + peso(lim) + ' straight to the customer; a higher price goes to Finance automatically, no reason needed.'
      : 'no cashier pricing limit is set yet, so every counter price is checked by Finance before the customer sees it. You do not need to write a reason for that.';
  }
  function syncRoute(form, total) {
    const box = form && form.querySelector('[data-route]'); if (!box) return;
    const cost = S.sysCost && S.detail && S.sysCost.id === S.detail.id ? S.sysCost.total : 0;
    if (total > 0 && cost > 0 && total < cost) {          // the server routes a loss-making price to Finance (pricing.js)
      box.hidden = false;
      box.textContent = peso(total) + ' is below the computed cost of ' + peso(cost) + ', so Finance approves this price before the customer sees it.';
      return;
    }
    if (!(total > 0) || !overLimit(total)) { box.hidden = true; box.textContent = ''; return; }
    const lim = cashierLimit();
    box.hidden = false;
    box.textContent = (lim > 0 ? peso(total) + ' is above your ' + peso(lim) + ' pricing limit' : 'No cashier pricing limit is set')
      + ', so Finance approves this price before the customer sees it. This is automatic; you do not need to tick the box below or write a reason.';
  }

  async function submitPrice(form) {
    const d = S.detail; if (!d) return;
    const err = form.querySelector('[data-price-err]'), f = new FormData(form);
    const q = qtyParts(d.quantity);
    const unit = String(f.get('unit') || '').trim();
    err.textContent = '';
    if (!/^\d+(?:\.\d{1,2})?$/.test(unit) || Number(unit) <= 0) { err.textContent = 'Enter the unit price in pesos, up to two decimals.'; return; }
    if (!q) { err.textContent = 'The quoted quantity could not be read. Fix it with Finance before pricing.'; return; }
    const total = Math.round(Number(unit) * q.qty * 100) / 100;
    const leadTime = f.get('leadTime'), validDays = Number(f.get('validDays')), note = String(f.get('note') || '').trim();
    const exception = f.has('exception'), reason = String(f.get('reason') || '').trim();
    if (!leadTime || !validDays) { err.textContent = 'Choose the preparation time and how long the price is valid.'; return; }
    if (exception && reason.length < 10) { err.textContent = 'Explain why Finance must approve it (at least 10 characters).'; return; }
    const auto = !exception && overLimit(total), toFinance = exception || auto;
    const autoWhy = cashierLimit() > 0 ? 'above your ' + peso(cashierLimit()) + ' pricing limit' : 'no cashier pricing limit is set';
    const termKey = f.get('term') || 'full';
    const termOpt = (S.termOpts || []).find((x) => x.key === termKey) || {};
    const dueNow = termOpt.dueNow != null ? money(termOpt.dueNow) : peso(total);
    const balance = termOpt.balance != null ? money(termOpt.balance) : '₱0.00';
    const go = await pqConfirm({ title: 'Review the quotation price',
      description: toFinance ? 'This goes to Finance for approval before the customer is told anything.' : 'The customer is told this price as soon as it is saved.',
      rows: [['Quotation', d.id], ['Customer', d.customer + ' · ' + (d.phone || '')], ['Item', (d.product || 'Custom item') + ' · ' + d.quantity],
        ['Unit price', peso(Number(unit))], ['Calculated total', peso(total)], ['Ready in', leadTime], ['Price valid', validDays + ' days'],
        ['Payment term', (termOpt.label || TERM_NAME[termKey] || termKey) + ' — pay ' + dueNow + ' now, balance ' + balance],
        ['Where they pay', d.payMethod || (d.fulfillment === 'Delivery' ? 'Cash on delivery' : 'Pay at pickup')],
        ['Needs Finance approval', exception ? 'Yes — ' + reason : auto ? 'Yes, automatically — ' + autoWhy : 'No'], ['Remarks', note || 'none']],
      acknowledgment: 'I checked the specifications, the quantity and the arithmetic before sending this price.', confirmLabel: toFinance ? 'Send to Finance' : 'Approve & tell customer' });
    if (!go) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/price', { method: 'POST', body: JSON.stringify({ amount: total.toFixed(2), leadTime, validDays, note, reason, customManufacturing: exception }) });
      // The terms are attached to the price the customer is shown, so they go on straight after it exists.
      let termsState = null;
      if (termKey !== ((d.terms || {}).key || 'full')) {
        try { const t = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/terms', { method: 'POST', body: JSON.stringify({ termKey }) }); termsState = t.terms && t.terms.state; }
        catch (te) { err.textContent = 'The price was saved, but the payment terms were not: ' + fieldErr(te); S.openPrice = false; await openDetail(d.id); loadDesk(); return; }
      }
      toast(r.status === 'pending_approval' ? 'Sent to Finance for approval.'
        : termsState === 'proposed' ? 'Price sent. The partial payment terms now go to Finance for a signature.'
        : 'Price approved and shown to the customer.');
      S.openPrice = false; await openDetail(d.id); loadDesk();
    } catch (e) { err.textContent = fieldErr(e); btn.disabled = false; if (/reason|justif/i.test(err.textContent)) { const box = form.querySelector('[data-reason]'); if (box) { box.hidden = false; box.querySelector('textarea').focus(); } } }
  }

  /* ================= 5. walk-in quotation form ================= */
  const PQ_IDS = { productName: 'pqItem', contactName: 'pqName', phone: 'pqPhone', email: 'pqEmail', company: 'pqCompany', region: 'pqRegion', province: 'pqProvince', city: 'pqCity', barangay: 'pqBrgy', street: 'pqStreet' };
  const PQ_PHONE_RE = /^(\+63|0)9\d{9}$/, PQ_NAME_RE = /^[\p{L}][\p{L}\p{M}\s.,'’-]*$/u, PQ_MAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
  let pqMounted = false;
  const pqFulfil = () => (document.querySelector('input[name="pqFulfil"]:checked') || {}).value || 'Pickup';
  const isFlexible = () => el('pqFlexible').checked;
  const pqNeededEl = () => el('pqNeeded');                                    // built by QuoteFields.mount(), so it can be missing while options fail to load
  const pqNeededVal = () => { const x = pqNeededEl(); return x ? x.value : ''; };
  function pqErr(f, msg) { const b = el('pqE_' + f); if (b) b.textContent = msg || ''; if (PQ_IDS[f]) el(PQ_IDS[f]).classList.toggle('is-bad', !!msg); return !msg; }
  const PQ_CHECK = {
    contactName: () => { const v = el('pqName').value.trim(); return v.length >= 2 && PQ_NAME_RE.test(v) ? '' : 'Enter the customer’s name (letters only).'; },
    phone: () => { const v = el('pqPhone').value.replace(/[\s().-]/g, ''); return !v ? 'Enter a mobile number so we can reach the customer.' : PQ_PHONE_RE.test(v) ? '' : 'Enter a valid mobile number, e.g. 0917 123 4567.'; },
    email: () => { const v = el('pqEmail').value.trim(); return !v || (v.length <= 120 && PQ_MAIL_RE.test(v)) ? '' : 'Enter a valid email address, or leave it empty.'; },
    company: () => (el('pqCompany').value.trim().length <= 80 ? '' : 'Keep the company name within 80 characters.'),
    productName: () => el('pqProduct').value || el('pqItem').value.trim().length >= 3 ? '' : 'Tell us what they need (at least 3 characters).',
    neededBy: () => (!pqNeededVal() || isFlexible() ? '' : 'Choose the date they need it, or tick that the date is flexible.'),
    region: () => (pqFulfil() === 'Delivery' && !el('pqRegion').value ? 'Choose the region.' : ''),
    province: () => (pqFulfil() !== 'Delivery' ? '' : !el('pqProvince').value ? 'Choose the province.' : pqNoCover),
    city: () => { if (pqFulfil() !== 'Delivery') return ''; const v = pqClean(el('pqCity').value); return !v ? 'Choose the city or municipality.' : PQG.cities.length && !pqCode(PQG.cities, v) ? 'Pick the city / municipality from the list.' : ''; },
    barangay: () => { if (pqFulfil() !== 'Delivery') return ''; const v = pqClean(el('pqBrgy').value); return !v ? 'Choose the barangay.' : PQG.barangays.length && !pqCode(PQG.barangays, v) ? 'Pick the barangay from the list.' : ''; },
    street: () => { const v = el('pqStreet').value.trim(); return pqFulfil() === 'Delivery' && v && v.length < 5 ? 'Enter the house no. and street, or leave it empty.' : ''; }
  };
  const pqField = (f) => pqErr(f, PQ_CHECK[f]());
  // same coverage as a POS delivery sale (Finance > Delivery rates): the cashier sees it before the request is logged
  let pqNoCover = '';
  async function pqCheckCover() {
    pqNoCover = ''; const region = el('pqRegion').value, province = el('pqProvince').value;
    if (!region || !province) return;
    try { const q = await api('/api/pos/delivery-fee?region=' + encodeURIComponent(region) + '&province=' + encodeURIComponent(province));
      if (q && q.available === false) pqNoCover = 'We do not deliver to ' + province + ' yet. Choose another area or switch to Pickup.'; } catch (_) { /* the server checks again on save */ }
    if (pqFulfil() === 'Delivery') pqField('province');
  }

  const PQG = { regions: [], provinces: [], cities: [], barangays: [], city: '', tok: { prov: 0, city: 0, bgy: 0 } };
  const pqClean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const pqCode = (list, name) => { const n = pqClean(name).toLowerCase(); const m = list.find((x) => x.name.toLowerCase() === n); return m ? m.code : null; };
  const pqGeo = async (path) => { try { return await api(path); } catch (e) { if (e instanceof TypeError) throw new Error('No connection to the server'); throw e; } };
  function pqOptions(sel, rows, placeholder, disabled) { sel.innerHTML = '<option value="">' + esc(placeholder) + '</option>' + rows.map((r) => '<option value="' + esc(r.name) + '">' + esc(r.name) + '</option>').join(''); sel.disabled = !!disabled; }
  const pqListOpts = (id, rows) => { el(id).innerHTML = rows.map((r) => '<option value="' + esc(r.name) + '"></option>').join(''); };
  const pqBox = (id, placeholder, disabled) => { const x = el(id); x.value = ''; x.disabled = !!disabled; x.placeholder = placeholder; };
  function pqReset(from) {
    const i = ['province', 'city', 'barangay'].indexOf(from);
    if (i <= 0) { PQG.provinces = []; pqOptions(el('pqProvince'), [], 'Choose a region first', true); }
    if (i <= 1) { PQG.cities = []; pqListOpts('pqCityList', []); pqBox('pqCity', 'Choose a province first', true); }
    PQG.barangays = []; PQG.city = ''; pqListOpts('pqBgyList', []); pqBox('pqBrgy', 'Choose a city first', true);
  }
  async function pqLoadRegions() {
    const sel = el('pqRegion');
    try { if (!PQG.regions.length) PQG.regions = await pqGeo('/api/geo/regions'); const keep = sel.value; pqOptions(sel, PQG.regions, 'Choose a region…'); sel.value = keep; }
    catch (e) { sel.innerHTML = '<option value="">Could not load regions — focus to try again</option>'; sel.onfocus = () => { sel.onfocus = null; pqLoadRegions(); }; pqErr('region', e.message); }
  }
  async function pqOnRegion() {
    pqReset('province'); pqNoCover = ''; ['region', 'province', 'city', 'barangay'].forEach((f) => pqErr(f, ''));
    const reg = PQG.regions.find((r) => r.name === el('pqRegion').value); if (!reg) return;
    const t = ++PQG.tok.prov, psel = el('pqProvince');
    pqOptions(psel, [], 'Loading provinces…', true);
    try {
      const rows = await pqGeo('/api/geo/regions/' + encodeURIComponent(reg.code) + '/provinces'); if (t !== PQG.tok.prov) return;
      if (rows.length) { PQG.provinces = rows; pqOptions(psel, rows, 'Choose a province…'); return; }
      PQG.provinces = [{ code: 'NCR', name: 'Metro Manila' }];
      pqOptions(psel, PQG.provinces, 'Metro Manila', true); psel.value = 'Metro Manila'; pqCheckCover();
      await pqLoadCities('/api/geo/regions/' + encodeURIComponent(reg.code) + '/cities');
    } catch (e) { if (t === PQG.tok.prov) { pqOptions(psel, [], 'Could not load — choose the region again', true); pqErr('province', e.message); } }
  }
  async function pqOnProvince() {
    pqReset('city'); ['province', 'city', 'barangay'].forEach((f) => pqErr(f, ''));
    const prov = PQG.provinces.find((p) => p.name === el('pqProvince').value); if (!prov) return;
    pqCheckCover();
    await pqLoadCities('/api/geo/provinces/' + encodeURIComponent(prov.code) + '/cities');
  }
  async function pqLoadCities(path) {
    const t = ++PQG.tok.city; pqBox('pqCity', 'Loading cities…', true);
    try { const rows = await pqGeo(path); if (t !== PQG.tok.city) return; PQG.cities = rows; pqListOpts('pqCityList', rows); pqBox('pqCity', 'Type to search city / municipality…', false); }
    catch (e) { if (t === PQG.tok.city) { pqBox('pqCity', 'Could not load — choose the province again', true); pqErr('city', e.message); } }
  }
  async function pqOnCity() {
    const name = pqClean(el('pqCity').value);
    if (name && name.toLowerCase() === PQG.city.toLowerCase()) return;
    pqReset('barangay'); pqErr('city', ''); pqErr('barangay', ''); if (!name) return;
    const city = PQG.cities.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!city) { if (PQG.cities.length) pqErr('city', 'Pick the city / municipality from the list.'); return; }
    el('pqCity').value = city.name; PQG.city = city.name;
    const t = ++PQG.tok.bgy; pqBox('pqBrgy', 'Loading barangays…', true);
    try { const rows = await pqGeo('/api/geo/cities/' + encodeURIComponent(city.code) + '/barangays'); if (t !== PQG.tok.bgy) return; PQG.barangays = rows; pqListOpts('pqBgyList', rows); pqBox('pqBrgy', rows.length ? 'Type to search barangay…' : 'Type the barangay', false); }
    catch (e) { if (t === PQG.tok.bgy) pqBox('pqBrgy', 'Type the barangay', false); }
  }
  function pqOnBarangay() {
    pqErr('barangay', ''); const name = pqClean(el('pqBrgy').value); if (!name) return;
    const b = PQG.barangays.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (b) el('pqBrgy').value = b.name; else if (PQG.barangays.length) pqErr('barangay', 'Pick the barangay from the list.');
  }
  function pqResetArea() { el('pqRegion').value = ''; pqReset('province'); ['region', 'province', 'city', 'barangay', 'street'].forEach((f) => pqErr(f, '')); }

  function renderPosQuoteForm() {
    const sel = el('pqProduct'); if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">Other / custom item…</option>' + PRODUCTS.map((p) => '<option value="' + esc(p.sku) + '">' + esc(p.name) + (p.spec ? ' — ' + esc(p.spec) : '') + ' (' + esc(p.sku) + ')</option>').join('');
    if (keep && prod(keep)) sel.value = keep;
    ensureFields(); pqProductChanged();
  }
  async function ensureFields() {
    if (pqMounted || !el('pqFields')) return;
    let o;
    try { o = await api('/api/pos/quote-options'); window.PQ_OPTIONS = o; }
    catch (e) { el('pqFields').innerHTML = '<div class="qd-load-error" role="alert"><strong>The product specifications could not be loaded.</strong><p>' +
      esc(e instanceof TypeError ? 'No connection to the server.' : e.message || 'The server refused the request.') + '</p><button type="button" class="btn-secondary" id="pqRetryOptions">Try again</button></div>';
      el('pqRetryOptions').onclick = () => { el('pqFields').innerHTML = '<p class="dim">Loading the form…</p>'; ensureFields(); }; return; }
    if (pqMounted) return;
    QuoteFields.mount(el('pqFields'), { prefix: 'pq', options: o, flexible: isFlexible, estimate: 'staff', productSku: () => el('pqProduct').value || '' });
    pqMounted = true;
    // the date stays next to Quantity, exactly where the online form has it; the counter-only "No fixed date" switch sits under it
    const dateField = el('pqNeeded') && el('pqNeeded').closest('.q-field'), flex = el('pqFlexible') && el('pqFlexible').closest('label');
    if (dateField && flex) { dateField.appendChild(flex); const holder = el('pqFlexHolder'); if (holder) holder.remove(); }
    pqProductChanged(); buildReview();
  }
  function pqProductChanged() {
    const p = prod(el('pqProduct').value);
    el('pqNameWrap').hidden = !!p; if (p) pqErr('productName', '');
    if (pqMounted) { QuoteFields.autofill('pq', p ? p.specs : null); if (p) QuoteFields.setUnit('pq', p.unit); QuoteFields.estimate('pq'); }
  }
  function collectForm() {
    const f = pqFulfil(), r = pqMounted ? QuoteFields.read('pq') : {};
    const b = { contactName: el('pqName').value.trim(), phone: el('pqPhone').value.replace(/[\s().-]/g, ''),
      contactEmail: el('pqEmail').value.trim() || undefined, company: el('pqCompany').value.trim() || undefined,
      sku: el('pqProduct').value || undefined, productName: el('pqItem').value.trim() || undefined, fulfillment: f,
      neededBy: pqNeededVal() || undefined, flexibleDate: isFlexible() };
    Object.assign(b, r);
    if (f === 'Delivery') Object.assign(b, { region: el('pqRegion').value, province: el('pqProvince').value, city: pqClean(el('pqCity').value), barangay: pqClean(el('pqBrgy').value), street: el('pqStreet').value.trim() || undefined });
    return b;
  }
  function buildReview() {
    const box = el('qdReview'); if (!box) return;
    const d = collectForm(), sp = d.specs || {}, p = prod(d.sku);
    // the same rows, order and labels as the customer's review in the online shop; optional details left empty are not listed
    const spec = (v) => v || 'Not specified';
    const rows = [['Product', p ? p.name + ' (' + p.sku + ')' : d.productName], ['Item type', p ? '' : d.itemType || sp.itemType],
      ['Material', spec(sp.material)], ['Size', spec(sp.size)], ['Thickness', spec(sp.thickness)], ['Finish', spec(sp.finish)], ['Machining / secondary work', spec(sp.service)],
      ['Quantity', [d.quantity, d.quantityUnit].filter(Boolean).join(' ')], ['Needed by', d.neededBy ? day(d.neededBy) : d.flexibleDate ? 'No fixed date' : ''],
      ['Extra notes', d.notes || sp.notes], ['Receive by', d.fulfillment],
      ['Delivery area', d.fulfillment === 'Delivery' ? [d.street, d.barangay, d.city, d.province, d.region].filter(Boolean).join(', ') : ''],
      ['Contact name', d.contactName], ['Mobile number', d.phone], ['Email', d.contactEmail], ['Company', d.company]].filter(([, v]) => v);
    box.innerHTML = '<div class="qd-review"><h3>Review quotation request</h3><p>Please double-check the specifications and contact details with the customer.</p>' +
      rows.map(([k, v]) => '<div class="qd-review-row"><span>' + esc(k) + '</span><strong>' + esc(String(v)) + '</strong></div>').join('') +
      '<p class="qd-review-note">This is only a request for pricing and availability. No stock is reserved and no payment is taken.</p>' +
      '<div class="qd-review-actions"><button type="button" class="btn-secondary" data-act="edit">Edit details</button><button type="button" class="btn-primary" id="qdConfirmSave">Confirm &amp; save</button></div></div>';
  }
  function showFormStep() { const box = el('qdReview'); box.innerHTML = ''; box.hidden = true; el('qdFormSections').hidden = false; el('pqProduct').focus(); }
  let saving = false;
  async function saveWalkIn() {
    if (saving) return;                                             // a double click must never make two requests
    const err = el('pqErr'); err.textContent = '';
    const f = pqFulfil();
    const fields = ['contactName', 'phone', 'email', 'company', 'productName', 'neededBy'].concat(f === 'Delivery' ? ['region', 'province', 'city', 'barangay', 'street'] : []);
    let first = null;
    fields.forEach((k) => { if (!pqField(k) && !first) first = PQ_IDS[k]; });
    if (pqMounted) { const qf = QuoteFields.validate('pq'); if (!qf.ok && !first) first = qf.focus; }
    if (first) { err.textContent = 'Please fix the highlighted fields.'; const x = el(first); x.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (x.focus) x.focus({ preventScroll: true }); return; }
    buildReview();
    el('qdFormSections').hidden = true;
    el('qdReview').hidden = false;
    el('qdReview').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  async function commitWalkIn() {
    if (saving) return;
    saving = true;
    const btn = el('qdConfirmSave'); if (btn) btn.disabled = true;
    const err = el('pqErr'), body = collectForm();
    try {
      const r = await call('/api/pos/quotes', { method: 'POST', body: JSON.stringify(body) });
      const no = r && r.id;
      toast('Saved as ' + (no || 'a new request') + '. Nothing is priced, paid or reserved yet.');
      ['pqName', 'pqPhone', 'pqEmail', 'pqCompany', 'pqItem', 'pqCity', 'pqBrgy', 'pqStreet'].forEach((id) => { el(id).value = ''; el(id).classList.remove('is-bad'); });
      pqResetArea(); Object.keys(PQ_IDS).forEach((k) => pqErr(k, '')); el('pqProduct').value = '';
      if (pqMounted) QuoteFields.reset('pq');
      pqProductChanged(); el('pqFlexible').checked = false; const nd = pqNeededEl(); if (nd) nd.disabled = false;
      document.querySelector('input[name="pqFulfil"][value="Pickup"]').checked = true; el('pqArea').hidden = true;
      showFormStep(); loadDesk();
      if (no) openDetail(no);                        // straight to the request, where the price is prepared
    } catch (e) {
      if (!QuoteFields.showServerError('pq', e.fields)) err.textContent = fieldErr(e); else err.textContent = 'Please fix the highlighted fields.';
      showFormStep();
    } finally { saving = false; if (btn) btn.disabled = false; }
  }

  /* ================= 6. wiring ================= */
  function wire() {
    el('qdTabRequests').addEventListener('click', () => showView('requests'));
    el('qdTabWalkin').addEventListener('click', () => showView('walkin'));
    let timer;
    el('qdSearch').addEventListener('input', (e) => { S.q = e.target.value; clearTimeout(timer); S.page = 1; timer = setTimeout(loadDesk, 350); });
    el('qdSource').innerHTML = SOURCES.map(([k, l]) => '<option value="' + k + '">' + l + '</option>').join('');
    el('qdSize').innerHTML = PAGE_SIZES.map((n) => '<option value="' + n + '"' + (n === 20 ? ' selected' : '') + '>' + n + ' rows</option>').join('');
    el('qdSource').addEventListener('change', (e) => { S.source = e.target.value; S.page = 1; loadDesk(); });
    el('qdSize').addEventListener('change', (e) => { S.pageSize = Number(e.target.value); S.page = 1; loadDesk(); });
    el('qdRefresh').addEventListener('click', loadDesk);
    // the chip bar sits in the toolbar, outside #qdDesk, so it needs its own listener
    el('qdChips').addEventListener('click', (e) => { const chip = e.target.closest('[data-filter]'); if (chip && chip.dataset.filter !== S.filter) { S.filter = chip.dataset.filter; S.page = 1; loadDesk(); } });
    el('qdDesk').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]'); if (th) { const k = th.dataset.sort; if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc'; else { S.sort = k; S.dir = 'desc'; } S.page = 1; loadDesk(); return; }
      const pg = e.target.closest('[data-page]'); if (pg) { S.page = Math.min(S.pageCount, Math.max(1, S.page + (pg.dataset.page === 'next' ? 1 : -1))); loadDesk(); return; }
      if (e.target.closest('[data-retry]')) { loadDesk(); return; }
      const row = e.target.closest('[data-open]'); if (row) openDetail(row.dataset.open);
    });
    el('qdDesk').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.open) { e.preventDefault(); openDetail(e.target.dataset.open); } });

    el('qdScrim').addEventListener('click', closeDetail);
    el('qdDrawerClose').addEventListener('click', closeDetail);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.detail) { if (!el('qdClarifyOverlay').hidden) closeClarify(); else closeDetail(); } });
    el('qdDrawerBody').addEventListener('input', (e) => {
      if (e.target.name === 'unit') { const d = S.detail, q = qtyParts(d.quantity), out = e.target.form.querySelector('[data-total]');
        const okNum = /^\d+(\.\d{1,2})?$/.test(e.target.value.trim());
        if (out) out.textContent = q && okNum ? peso(Number(e.target.value) * q.qty) : '—';
        syncRoute(e.target.form, q && okNum ? Number(e.target.value) * q.qty : 0);
        clearTimeout(termTimer);
        termTimer = setTimeout(() => loadTermOptions(e.target.form, q && okNum ? Number(e.target.value) * q.qty : 0, (d.terms || {}).key), 350); }
    });
    el('qdDrawerBody').addEventListener('change', (e) => {
      if (e.target.name === 'leadTime') updateReady(e.target.form);
      if (e.target.name === 'term') syncTermFields(e.target.form);
      if (e.target.name === 'exception') { const box = e.target.form.querySelector('[data-reason]'); box.hidden = !e.target.checked; if (e.target.checked) box.querySelector('textarea').focus(); }
    });
    el('qdDrawerBody').addEventListener('submit', (e) => {
      if (e.target.id === 'qdPriceForm') { e.preventDefault(); submitPrice(e.target); }
      if (e.target.id === 'qdTermsForm') { e.preventDefault(); saveTerms(e.target); }
    });
    el('qdDrawerFoot').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') closeDetail();
      else if (act === 'clarify') doClarify();
      else if (act === 'convert') doConvert();
      else if (['accept', 'decline', 'renew'].includes(act)) doRespond(act);
    });
    el('qdDrawerBody').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'price') { S.openPrice = true; renderDetail(); }
      if (b.dataset.act === 'cancelprice') { S.openPrice = false; renderDetail(); }
      if (b.dataset.act === 'terms') { S.openTerms = true; renderDetail(); }
      if (b.dataset.act === 'cancelterms') { S.openTerms = false; renderDetail(); }
    });

    el('pqClarifyCancel').addEventListener('click', closeClarify);
    el('qdClarifyOverlay').addEventListener('click', (e) => { if (e.target === el('qdClarifyOverlay')) closeClarify(); });

    el('pqProduct').addEventListener('change', pqProductChanged);
    document.querySelectorAll('input[name="pqFulfil"]').forEach((r) => r.addEventListener('change', () => {
      el('pqArea').hidden = pqFulfil() !== 'Delivery';
      ['region', 'province', 'city', 'barangay', 'street'].forEach((f) => pqErr(f, ''));
      if (pqFulfil() === 'Delivery' && !PQG.regions.length) pqLoadRegions();
    }));
    el('pqRegion').addEventListener('change', pqOnRegion);
    el('pqProvince').addEventListener('change', pqOnProvince);
    el('pqCity').addEventListener('change', pqOnCity);
    el('pqBrgy').addEventListener('change', pqOnBarangay);
    el('pqFlexible').addEventListener('change', () => { const x = pqNeededEl(); if (!x) return; x.disabled = isFlexible(); if (isFlexible()) { x.value = ''; pqErr('neededBy', ''); } });
    Object.keys(PQ_IDS).forEach((f) => { const x = el(PQ_IDS[f]); x.addEventListener('blur', () => pqField(f)); x.addEventListener('input', () => { if (x.classList.contains('is-bad')) pqField(f); el('pqErr').textContent = ''; }); });
    el('pqPhone').addEventListener('input', () => { const p = el('pqPhone'), d = p.value.replace(/[^\d+\s]/g, ''); if (d !== p.value) p.value = d; });
    el('pqForm').addEventListener('submit', (e) => { e.preventDefault(); saveWalkIn(); });
    el('qdReview').addEventListener('click', (e) => {
      if (e.target.closest('[data-act="edit"]')) showFormStep();
      if (e.target.closest('#qdConfirmSave')) commitWalkIn();
    });
  }

  /* page glue: showPage('quotes') and the start-up poll both call these */
  window.renderPosQuoteForm = renderPosQuoteForm;
  window.loadPosQuotes = function () { if (el('qdDesk')) loadDesk(); };
  window.initQuoteDesk = function () { if (window.__qdWired) return; window.__qdWired = true; wire(); renderPosQuoteForm(); loadDesk(); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.initQuoteDesk);
  else window.initQuoteDesk();
})();
