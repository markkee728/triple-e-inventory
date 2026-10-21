/* payment-terms-admin.js — Finance: the payment-terms screen (§9).
   Four things the specification makes Finance own, on one page:
     • which payment terms exist and may be offered at all, and for which kind of order;
     • the partial term a cashier proposed on a quotation, which only becomes real when Finance signs it;
     • who owes money right now, order by order and quotation by quotation;
     • every payment and every refund the ledger holds, with the drawer each cash payment went into.
   Every amount is read from the backend ledger — this file never works one out. No browser dialogs are used: the
   errors come back from the server and are shown against the row they belong to.
   Server routes (backend/payment-terms.js, backend/shop-extras.js):
     GET  /api/finance/payment-terms · POST /api/finance/payment-terms/:key
     GET  /api/finance/quotes        · POST /api/finance/quotes/:no/terms
     GET  /api/finance/receivables   · GET  /api/finance/payments?kind=order|quote                  */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var peso = function (n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (ms) { return ms ? new Date(ms).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };

  var POLICY = [], QUOTES = [], DEBT = null, MONEY = null, LEDGER_READY = true, busy = false;

  async function api(path, options) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields || {} });
    return data;
  }
  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'app-toast' + (isError ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  /* ---------------- the page ---------------- */
  var PANELS = [
    ['ptrPolicy', 'Payment terms on offer',
     'Switch a term on to offer it. Payments already recorded are not affected.',
     '<th style="min-width:160px">Term</th><th style="width:190px">Pay now</th><th style="width:160px">Allowed for</th><th style="width:200px">Balance due</th><th style="width:220px">Status</th><th style="width:90px"></th>'],
    ['ptrProposed', 'Waiting for your approval',
     'Part-payments a cashier proposed. The customer only sees them after you approve.',
     '<th>Quotation</th><th>Customer</th><th class="mono">Quoted</th><th>Proposed</th><th>Balance due</th><th style="width:280px">Decision</th>'],
    ['ptrDebt', 'Balances outstanding',
     'Orders and quotations with money still owed.',
     '<th>Reference</th><th>Customer</th><th>Payment option</th><th class="mono">Value</th><th class="mono">Collected</th><th class="mono">Outstanding</th><th>Payment state</th><th>Exception</th>'],
    ['ptrMoney', 'Payments and refunds',
     'Newest first. Drawer cash and online payments are kept apart.',
     '<th>When</th><th>Against</th><th class="mono">Amount</th><th>How</th><th>Reference / drawer</th><th>Recorded by</th><th>Note</th>']
  ];

  (function styles() {
    var st = document.createElement('style');
    st.textContent = '#payment-terms input:not([type=checkbox]):not([type=hidden]),#payment-terms select{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 9px;font:inherit;font-size:13px;min-height:34px;max-width:100%}'
      + '#payment-terms input:focus,#payment-terms select:focus{outline:none;border-color:var(--blue-bright);box-shadow:0 0 0 3px rgba(74,144,217,.18)}'
      + '#payment-terms input[type=checkbox]{accent-color:var(--blue-bright);width:16px;height:16px;vertical-align:-3px;margin-right:6px}'
      + '#payment-terms td{vertical-align:top;padding-top:14px;padding-bottom:14px}#payment-terms td label{line-height:1.9}'
      + '#payment-terms .faint{color:var(--text-faint);font-size:12.5px;line-height:1.5}#payment-terms select[data-f=balanceCondition]{width:100%}';
    document.head.appendChild(st);
  })();
  function build() {
    var host = $('payment-terms');
    if (!host || host.dataset.built === '1') return;
    host.dataset.built = '1';
    host.innerHTML = '<div class="catalog-header"><div><div class="catalog-eyebrow">Sales / Payment Terms</div><h1 class="catalog-title">Payment Terms</h1>'
      + '<div class="panel-sub">Part-payment rules, approvals and balances.</div></div>'
      + '<button type="button" class="btn-secondary btn-sm" data-reload="all">Reload</button></div>'
      + PANELS.map(function (p) {
        return '<div class="panel" id="' + p[0] + 'Box" style="margin-bottom:18px">'
          + '<div class="panel-head"><div><div class="panel-title">' + p[1] + '</div><div class="panel-sub">' + p[2] + '</div></div>'
          + '<div class="inv-filters"><button type="button" class="btn-secondary btn-sm" data-reload="' + p[0] + '">Reload</button></div></div>'
          + '<div class="faint" id="' + p[0] + 'Status" data-status="' + p[0] + '" style="padding:8px 16px 0;min-height:18px"></div>'
          + '<div class="table-wrapper"><table><thead><tr>' + p[3] + '</tr></thead>'
          + '<tbody id="' + p[0] + 'Body"><tr><td class="faint">Loading\u2026</td></tr></tbody></table></div></div>';
      }).join('');
    // cash on delivery / pickup rules sit right under the terms they go with
    var pol = $('ptrPolicyBox'); if (pol) pol.insertAdjacentHTML('afterend', codPanel());
  }

  /* ---------------- cash on delivery / pickup rules (order_rules) ---------------- */
  var RULES = null;
  function codPanel() {
    var f = function (id, label, hint, attrs) {
      return '<div style="flex:1 1 200px;min-width:180px;display:flex;flex-direction:column"><label for="' + id + '" style="display:flex;align-items:flex-end;min-height:40px;margin-bottom:6px">' + label + '</label>'
        + '<input id="' + id + '" class="mono" inputmode="numeric" autocomplete="off" ' + attrs + ' style="width:100%">'
        + '<div class="faint" style="margin-top:5px">' + hint + '</div><div class="faint" data-coderr="' + id + '" role="alert" style="color:var(--red,#c0392b)"></div></div>';
    };
    return '<div class="panel" id="ptrCodBox" style="margin-bottom:18px">'
      + '<div class="panel-head"><div><div class="panel-title">Cash on delivery and pickup</div>'
      + '<div class="panel-sub">Cash on delivery: the customer pays the delivery fee and a down payment online first, the rider collects the rest in cash. '
      + 'Cash on pickup: a down payment is paid online first (taken off the total), the rest in cash at the counter; a no-show keeps the down payment. '
      + 'The checkout hides cash when a rule says no, and the server checks again.</div></div></div>'
      + '<div style="display:flex;gap:18px;flex-wrap:wrap;padding:4px 16px 0">'
      + f('codLimit', 'Cash on delivery limit (\u20B1)', 'Bigger delivery orders must be paid online. 0 = no limit.', 'placeholder="10000"')
      + f('codShows', 'Missed deliveries or pickups before cash is blocked', 'The customer can then only pay online. 0 = never block.', 'placeholder="2"')
      + f('codHold', 'Days to hold a paid-online pickup', 'Not collected by then: cancelled, restocked and refunded (reminder 2 days before).', 'placeholder="7"')
      + '</div><div style="display:flex;gap:18px;flex-wrap:wrap;padding:14px 16px 0">'
      + f('copDeposit', 'Cash on pickup down payment (\u20B1)', 'Paid online to reserve the items; taken off the total. 0 = no down payment (pay everything at the counter).', 'placeholder="200"')
      + f('copHours', 'Hours to hold a cash-on-pickup order', 'Counted from \u201CReady for pickup\u201D. Not picked up by then: cancelled, restocked, and the down payment is kept.', 'placeholder="48"')
      + f('codDeposit', 'Cash on delivery down payment (\u20B1)', 'Paid online together with the delivery fee; taken off what the rider collects. 0 = delivery fee only.', 'placeholder="200"')
      + '</div><div style="display:flex;gap:12px;align-items:center;padding:14px 16px 16px"><button type="button" class="btn-primary btn-sm" data-cod-save>Save rules</button>'
      + '<span class="faint" id="codStatus"></span></div></div>';
  }
  function renderCod() {
    if (!RULES || !$('codLimit')) return;
    $('codLimit').value = RULES.codLimit; $('codShows').value = RULES.maxNoShows; $('codHold').value = RULES.pickupHoldDays;
    $('copDeposit').value = RULES.copDeposit != null ? RULES.copDeposit : 200; $('copHours').value = RULES.copHoldHours != null ? RULES.copHoldHours : 48;
    $('codDeposit').value = RULES.codDeposit != null ? RULES.codDeposit : 200;
    $('codStatus').textContent = RULES.updatedBy ? 'Last changed by ' + RULES.updatedBy + ' \u00B7 ' + when(RULES.updatedAt) : 'Default rules (not changed yet)';
  }
  async function saveCod(btn) {
    document.querySelectorAll('[data-coderr]').forEach(function (x) { x.textContent = ''; });
    var body = { codLimit: $('codLimit').value.trim(), maxNoShows: Number($('codShows').value), pickupHoldDays: Number($('codHold').value),
      copDeposit: $('copDeposit').value.trim(), copHoldHours: Number($('copHours').value), codDeposit: $('codDeposit').value.trim() };
    btn.disabled = true;
    try { RULES = await api('/finance/order-rules', { method: 'PUT', body: JSON.stringify(body) }); renderCod(); toast('Cash rules saved.'); }
    catch (e) {
      if (e.message === 'Not signed in') return;
      var map = { codLimit: 'codLimit', maxNoShows: 'codShows', pickupHoldDays: 'codHold', copDeposit: 'copDeposit', copHoldHours: 'copHours', codDeposit: 'codDeposit' }, shown = false;
      Object.keys(e.fields || {}).forEach(function (k) { var el = document.querySelector('[data-coderr="' + (map[k] || k) + '"]'); if (el) { el.textContent = e.fields[k]; shown = true; } });
      if (!shown) toast(e.message, true);
    } finally { btn.disabled = false; }
  }

  /* ---------------- the policy table ---------------- */
  // when the rest is paid: a moment in the order flow the system enforces (never a free-typed promise)
  var BALANCE_DUE = [['balance due before release', 'Before pickup / delivery'], ['balance due before production starts', 'Before production starts']];
  var STATE_PILL = { unpaid: ['unpaid', 'Not paid'], partially_paid: ['low', 'Partly paid'], paid: ['in', 'Paid'],
    refunded: ['out', 'Refunded'], partially_refunded: ['watch', 'Partly refunded'] };

  function policyRow(t) {
    var lock = t.key === 'full';
    return '<tr data-term="' + esc(t.key) + '">'
      + '<td><b>' + esc(t.label) + '</b><div class="faint">' + (lock ? 'Default for every order' : 'Hidden until switched on') + '</div></td>'
      + '<td>' + (lock ? '<span class="mono">100% of the order</span>'
        : '<label class="faint" style="display:block">Basis</label>'
          + '<select data-f="basis"><option value="percent"' + (t.basis === 'fixed' ? '' : ' selected') + '>Percentage</option>'
          + '<option value="fixed"' + (t.basis === 'fixed' ? ' selected' : '') + '>Fixed amount</option></select>'
          + '<div style="margin-top:6px"><input data-f="percent" class="mono" inputmode="decimal" placeholder="50" aria-label="percentage" value="' + (t.percent == null ? '' : esc(t.percent)) + '" style="width:80px"> %</div>'
          + '<div style="margin-top:6px"><input data-f="fixedAmount" class="mono" inputmode="decimal" placeholder="5000" aria-label="fixed amount" value="' + (t.fixedAmount == null ? '' : esc(t.fixedAmount)) + '" style="width:110px"> \u20B1</div>') + '</td>'
      + '<td>' + (lock ? '<label><input type="checkbox" data-f="retailAllowed" checked disabled> Ready stock</label>'
        : '<label style="display:block"><input type="checkbox" data-f="retailAllowed"' + (t.retailAllowed ? ' checked' : '') + '> Ready stock</label>'
          + '<label style="display:block"><input type="checkbox" data-f="madeToOrderAllowed"' + (t.madeToOrderAllowed ? ' checked' : '') + '> Made-to-order</label>') + '</td>'
      + '<td>' + (lock ? '<span class="faint">Nothing further</span><input type="hidden" data-f="balanceCondition" value="nothing further to pay">'
        : '<select data-f="balanceCondition" aria-label="when the balance is due">' + BALANCE_DUE.map(function (c) {
            return '<option value="' + esc(c[0]) + '"' + (c[0] === t.balanceCondition ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('')
          + (BALANCE_DUE.some(function (c) { return c[0] === t.balanceCondition; }) || !t.balanceCondition ? '' : '<option selected value="' + esc(t.balanceCondition) + '">' + esc(t.balanceCondition) + '</option>') + '</select>') + '</td>'
      + '<td><label><input type="checkbox" data-f="enabled"' + (lock ? ' checked disabled' : (t.enabled ? ' checked' : '')) + '> Offer this term</label>'
        + '<div class="faint">' + (lock ? 'Always on'
          : (t.enabled ? 'On since ' + esc(when(t.enabledAt)) + ' \u00B7 ' + esc(t.enabledBy || 'Finance') : 'Off')) + '</div>'
        + (lock ? '' : '<input data-f="note" maxlength="300" aria-label="reason, for the audit trail" value="' + esc(t.note || '') + '" placeholder="Reason (for the audit log)" style="margin-top:6px;width:100%">') + '</td>'
      + '<td>' + (lock ? '' : '<button type="button" class="btn-primary btn-sm" data-save>Save</button>')
        + '<div class="faint" data-err role="alert" style="color:var(--red,#c0392b);margin-top:6px"></div></td>'
      + '</tr>';
  }

  function renderPolicy() {
    var body = $('ptrPolicyBody');
    if (!body) return;
    var offered = POLICY.filter(function (t) { return t.enabled && (t.key === 'full' || t.retailAllowed || t.madeToOrderAllowed); });
    $('ptrPolicyStatus').innerHTML = POLICY.length
      + ' term(s) on file \u00B7 offered now: ' + (offered.map(function (t) { return esc(t.label); }).join(', ') || 'none')
      + (LEDGER_READY ? '' : ' \u00B7 <b style="color:var(--red,#c0392b)">the payment ledger is not active in this database. Run backend/db/020_payment_terms.sql before relying on any balance below.</b>');
    body.innerHTML = POLICY.map(policyRow).join('');
  }

  /* ---------------- proposals waiting for Finance ---------------- */
  function proposedRows() {
    return (QUOTES || []).filter(function (q) { return q.terms && q.terms.state === 'proposed'; });
  }
  function renderProposed() {
    var body = $('ptrProposedBody'), rows = proposedRows();
    if (!body) return;
    $('ptrProposedStatus').textContent = rows.length
      ? rows.length + ' waiting'
      : 'Nothing waiting.';
    if (!rows.length) { body.innerHTML = '<tr><td class="faint" colspan="6">No quotation has proposed a partial payment.</td></tr>'; return; }
    body.innerHTML = rows.map(function (q) {
      var t = q.terms;
      return '<tr data-quote="' + esc(q.id) + '">'
        + '<td><b>' + esc(q.id) + '</b><div class="faint">' + esc(q.product || 'Custom item') + ' \u00B7 qty ' + esc(q.quantity || '') + '</div>'
        + '<div class="faint">sent by ' + esc(q.handledBy || 'the cashier') + '</div></td>'
        + '<td>' + esc(q.customer || '\u2014') + '</td>'
        + '<td class="mono">' + peso(q.quotedAmount == null ? t.total : q.quotedAmount) + '</td>'
        + '<td>' + esc(t.percent) + '% now = <span class="mono">' + peso(t.amount) + '</span>'
        + '<div class="faint"><span class="mono">' + peso(t.balance) + '</span> later</div></td>'
        + '<td>' + esc(t.condition || '\u2014') + '<div class="faint">' + esc(t.availability || '') + '</div></td>'
        + '<td><input data-f="note" maxlength="300" aria-label="note for the record" placeholder="note for the record" style="width:100%">'
        + '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">'
        + '<button type="button" class="btn-primary btn-sm" data-approve>Approve these terms</button>'
        + '<button type="button" class="btn-secondary btn-sm" data-refuse>Refuse \u2192 full payment</button></div>'
        + '<div class="faint" data-err role="alert" style="color:var(--red,#c0392b);margin-top:6px"></div></td></tr>';
    }).join('');
  }

  /* ---------------- who owes money ---------------- */
  function debtRow(x) {
    var pill = STATE_PILL[x.paymentState] || ['low', x.paymentState];
    var term = x.termsKey === 'full' ? 'Full payment' : x.termsKey + (x.termsPercent == null ? '' : ' \u00B7 ' + x.termsPercent + '%');
    return '<tr>'
      + '<td><b>' + esc(x.no) + '</b><div class="faint">' + (x.kind === 'quote' ? 'Quotation' : 'Order') + ' \u00B7 ' + esc(x.status || '') + '</div></td>'
      + '<td>' + esc(x.customer || '\u2014') + '</td>'
      + '<td>' + esc(term) + '<div class="faint">' + esc(x.termsCondition || '') + '</div></td>'
      + '<td class="mono">' + peso(x.total) + '</td><td class="mono">' + peso(x.paidAmount) + '</td>'
      + '<td class="mono"><b>' + peso(x.outstanding) + '</b></td>'
      + '<td><span class="status-pill ' + pill[0] + '">' + esc(pill[1]) + '</span>' + (x.method ? '<div class="faint">' + esc(x.method) + '</div>' : '') + '</td>'
      + '<td>' + (x.creditException ? '<span class="chip-pill warn">exception on file</span><div class="faint">' + esc(x.creditException.note) + '</div>' : '\u2014') + '</td></tr>';
  }
  function renderDebt() {
    var body = $('ptrDebtBody');
    if (!body) return;
    if (!DEBT) { body.innerHTML = '<tr><td class="faint" colspan="8">Loading\u2026</td></tr>'; return; }
    var t = DEBT.totals;
    $('ptrDebtStatus').innerHTML = 'Orders ' + t.openOrders + ' \u00B7 ' + peso(t.ordersOwed)
      + ' \u00B7 quotations ' + t.openQuotes + ' \u00B7 ' + peso(t.quotesOwed)
      + ' \u00B7 <b>total still to collect ' + peso(t.allOwed) + '</b>';
    var rows = DEBT.orders.concat(DEBT.quotes).sort(function (a, b) { return b.outstanding - a.outstanding; });
    if (!rows.length) { body.innerHTML = '<tr><td class="faint" colspan="8">Nothing is owed. Every order and quotation with money on it has been fully collected.</td></tr>'; return; }
    body.innerHTML = rows.map(debtRow).join('');
  }

  /* ---------------- the ledger ---------------- */
  function moneyRow(p) {
    return '<tr>'
      + '<td class="faint">' + esc(when(p.at)) + '</td>'
      + '<td><b>' + esc(p.ref || '') + '</b><div class="faint">' + (p.kind === 'quote' ? 'Quotation' : 'Order') + '</div></td>'
      + '<td class="mono"' + (p.direction === 'out' ? ' style="color:var(--red,#c0392b)"' : '') + '>'
      + (p.direction === 'out' ? '\u2212' : '+') + peso(p.amount) + '</td>'
      + '<td>' + esc(p.method) + '<div class="faint">' + esc(p.purpose || '') + '</div></td>'
      + '<td class="faint">' + esc(p.providerRef || (p.cashShiftId != null ? 'drawer #' + p.cashShiftId : '\u2014')) + '</td>'
      + '<td>' + esc(p.actor || 'system') + '</td>'
      + '<td class="faint">' + esc(p.note || '') + (p.reversedOf ? ' reverses payment #' + esc(p.reversedOf) : '') + '</td></tr>';
  }
  function renderMoney() {
    var body = $('ptrMoneyBody');
    if (!body) return;
    if (!MONEY) { body.innerHTML = '<tr><td class="faint" colspan="7">Loading\u2026</td></tr>'; return; }
    var t = MONEY.totals;
    $('ptrMoneyStatus').innerHTML = MONEY.count + ' money event(s) \u00B7 collected ' + peso(t.collected)
      + ' \u00B7 refunded back ' + peso(t.refunded)
      + ' \u00B7 <b>cash in drawers ' + peso(t.cashInDrawer) + '</b> \u00B7 paid online or otherwise ' + peso(t.onlineAndOther);
    if (!MONEY.payments.length) { body.innerHTML = '<tr><td class="faint" colspan="7">No payment has been recorded on the ledger yet.</td></tr>'; return; }
    body.innerHTML = MONEY.payments.map(moneyRow).join('');
  }

  /* ---------------- loading and saving ---------------- */
  function setErr(scope, msg) {
    var box = scope && scope.querySelector('[data-err]');
    if (box) box.textContent = msg || '';
    else if (msg) toast(msg, true);
  }

  async function loadAll() {
    if (busy) return;
    busy = true;
    try {
      var res = await Promise.all([
        api('/finance/payment-terms'), api('/finance/quotes').catch(function () { return []; }),
        api('/finance/receivables'), api('/finance/payments'), api('/finance/order-rules').catch(function () { return null; })
      ]);
      RULES = res[4];
      POLICY = res[0].terms || []; LEDGER_READY = res[0].ledgerReady !== false;
      QUOTES = Array.isArray(res[1]) ? res[1] : []; DEBT = res[2]; MONEY = res[3];
    } catch (e) {
      if (e.message !== 'Not signed in') toast(e.message || 'The payment-terms screen could not be loaded.', true);
      busy = false; return;
    }
    renderPolicy(); renderProposed(); renderDebt(); renderMoney(); renderCod();
    busy = false;
  }

  async function saveTerm(tr) {
    var key = tr.dataset.term,
      val = function (f) { var el = tr.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; },
      on = function (f) { var el = tr.querySelector('[data-f="' + f + '"]'); return !!(el && el.checked); };
    var enabled = key === 'full' ? true : on('enabled');
    setErr(tr, '');
    // the same two rules the server enforces, checked here only so the row answers straight away
    if (enabled && key !== 'full' && !on('retailAllowed') && !on('madeToOrderAllowed')) return setErr(tr, 'Say which orders this term covers before offering it.');
    if (enabled && key !== 'full' && String(val('note') || '').trim().length < 5) return setErr(tr, 'Write why you are switching this on \u2014 it goes in the audit log.');
    // Full Payment has no scope or percentage to choose: it is always 100% and always allowed, so the row must not
    // send those fields at all — leaving them out is what keeps the stored policy as it is.
    var body = { enabled: enabled, balanceCondition: val('balanceCondition'), note: val('note') };
    if (key !== 'full') { body.retailAllowed = on('retailAllowed'); body.madeToOrderAllowed = on('madeToOrderAllowed');
      body.basis = val('basis'); body.percent = val('percent'); body.fixedAmount = val('fixedAmount'); }
    try {
      var out = await api('/finance/payment-terms/' + encodeURIComponent(key), { method: 'POST', body: JSON.stringify(body) });
      POLICY = POLICY.map(function (t) { return t.key === key ? out.term : t; });
      renderPolicy();
      toast(out.term.enabled ? out.term.label + ' is now offered where you allowed it.' : out.term.label + ' is no longer offered.');
    } catch (e) {
      if (e.message === 'Not signed in') return;
      setErr(tr, (e.fields && (e.fields.percent || e.fields.fixedAmount || e.fields.scope || e.fields.note)) || e.message);
    }
  }

  async function decide(row, action) {
    var no = row.dataset.quote, t = (QUOTES.find(function (q) { return q.id === no; }) || {}).terms || {};
    var note = ((row.querySelector('[data-f="note"]') || {}).value || '').trim();
    setErr(row, '');
    if (String(note).length > 0 && String(note).length < 5) return setErr(row, 'Write at least 5 characters in the note, or leave it empty.');
    if (action === 'approve' && t.key === 'custom' && !(Number(t.percent) > 0 && Number(t.percent) < 100)) return setErr(row, 'This custom term has no usable percentage \u2014 refuse it and price the quotation on full payment.');
    try {
      await api('/finance/quotes/' + encodeURIComponent(no) + '/terms', { method: 'POST',
        body: JSON.stringify(action === 'refuse' ? { action: 'refuse', note: note }
          : { action: 'approve', termKey: t.key, percent: t.percent, condition: t.condition, note: note }) });
      toast(action === 'refuse' ? no + ' is back to full payment.' : no + ': the partial terms are approved and the customer told.');
      loadAll();
    } catch (e) {
      if (e.message === 'Not signed in') return;
      setErr(row, (e.fields && (e.fields.note || e.fields.terms || e.fields.termKey || e.fields.percent || e.fields.payment || e.fields.status || e.fields.amount)) || e.message);
    }
  }

  function start() {
    build();
    var host = $('payment-terms');
    if (!host) return;
    loadAll();
    host.addEventListener('click', function (e) {
      var reload = e.target.closest('[data-reload]');
      if (reload) { e.preventDefault(); loadAll(); return; }
      var cod = e.target.closest('[data-cod-save]');
      if (cod) { e.preventDefault(); saveCod(cod); return; }
      var save = e.target.closest('[data-save]');
      if (save) { e.preventDefault(); var tr = save.closest('tr[data-term]'); if (tr) saveTerm(tr); return; }
      var ap = e.target.closest('[data-approve]'), rf = e.target.closest('[data-refuse]');
      if (ap || rf) { e.preventDefault(); var row = (ap || rf).closest('tr[data-quote]'); if (row) decide(row, ap ? 'approve' : 'refuse'); }
    });
    // finance lives with this screen open; refresh it when it comes back into view
    new MutationObserver(function () { if (host.classList.contains('active-page')) loadAll(); }).observe(host, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && host.classList.contains('active-page')) loadAll(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
