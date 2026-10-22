/* delivery-rates-admin.js — Finance: "Delivery rates" panel on the Online Orders page.
   The delivery fee of an online order is worked out from the delivery address:
   a rate for the province wins, otherwise the rate for the region, otherwise the "All other areas" rate.
   Loaded after sales-orders.js in Finance_Inventory.html. Talks to GET / PUT /api/delivery-rates. */
(function () {
  'use strict';
  const REGIONS = ['NCR - National Capital Region', 'CAR - Cordillera Administrative Region', 'Region I - Ilocos Region',
    'Region II - Cagayan Valley', 'Region III - Central Luzon', 'Region IV-A - CALABARZON', 'MIMAROPA - Region IV-B',
    'Region V - Bicol Region', 'Region VI - Western Visayas', 'NIR - Negros Island Region', 'Region VII - Central Visayas',
    'Region VIII - Eastern Visayas', 'Region IX - Zamboanga Peninsula', 'Region X - Northern Mindanao', 'Region XI - Davao Region',
    'Region XII - SOCCSKSARGEN', 'Region XIII - Caraga', 'BARMM - Bangsamoro Autonomous Region'];
  // Recommended coverage: NCR near, Central Luzon + CALABARZON nearby, everything else not delivered (customers can request a quote or pick up)
  const RECOMMENDED = { 'NCR - National Capital Region': [150, true], 'Region III - Central Luzon': [250, true], 'Region IV-A - CALABARZON': [250, true],
    'CAR - Cordillera Administrative Region': [350, false], 'Region I - Ilocos Region': [350, false], 'Region II - Cagayan Valley': [350, false],
    'MIMAROPA - Region IV-B': [350, false], 'Region V - Bicol Region': [350, false], 'Region VI - Western Visayas': [450, false],
    'NIR - Negros Island Region': [450, false], 'Region VII - Central Visayas': [450, false], 'Region VIII - Eastern Visayas': [450, false],
    'Region IX - Zamboanga Peninsula': [550, false], 'Region X - Northern Mindanao': [550, false], 'Region XI - Davao Region': [550, false],
    'Region XII - SOCCSKSARGEN': [550, false], 'Region XIII - Caraga': [550, false], 'BARMM - Bangsamoro Autonomous Region': [550, false] };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const host = document.querySelector('#orders .sales-log-panel');
  if (!host) return;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.marginTop = '18px';
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <div class="panel-title">Delivery rates</div>
        <div class="panel-sub">The delivery fee of an order depends on where it is delivered. A province rate wins over a region rate; anything not listed uses &ldquo;All other areas&rdquo;. Untick &ldquo;We deliver here&rdquo; for places you do not cover: customers there cannot place a delivery order (they can still pick up). Pickup is always free.</div>
      </div>
      <div class="inv-filters">
        <button type="button" class="btn-secondary btn-sm" id="drRecommended" title="NCR, Central Luzon and CALABARZON only; every other region blocked">Use recommended coverage</button>
        <button type="button" class="btn-secondary btn-sm" id="drAddRegion">Add region</button>
        <button type="button" class="btn-secondary btn-sm" id="drAddProvince">Add province</button>
        <button type="button" class="btn-primary btn-sm" id="drSave">Save rates</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Applies to</th><th>Place</th><th style="width:110px">We deliver here</th><th style="width:150px">Fee (₱)</th><th style="width:90px"></th></tr></thead>
        <tbody id="drBody"><tr><td colspan="5" class="faint">Loading&hellip;</td></tr></tbody>
      </table>
    </div>
    <div class="faint" id="drMsg" style="padding:10px 16px;min-height:18px"></div>`;
  host.insertAdjacentElement('afterend', panel);

  const $ = (id) => panel.querySelector('#' + id);
  let rows = [];     // { scope, name, fee }

  function toast(msg, err) {
    const el = document.createElement('div'); el.className = 'app-toast' + (err ? ' error' : '');
    el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 4000);
  }
  async function api(method, body) {
    const r = await fetch('/api/delivery-rates', { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || (d.errors && Object.values(d.errors)[0]) || 'Request failed'); e.status = r.status; throw e; }
    return d;
  }
  // order: all other areas, then regions (in the usual north-to-south order), then provinces A-Z
  const order = (a, b) => {
    const rank = { default: 0, region: 1, province: 2 };
    if (a.scope !== b.scope) return rank[a.scope] - rank[b.scope];
    if (a.scope === 'region') return REGIONS.indexOf(a.name) - REGIONS.indexOf(b.name);
    return a.name.localeCompare(b.name);
  };

  function draw() {
    $('drBody').innerHTML = rows.map((r, i) => {
      const place = r.scope === 'default'
        ? '<b>All other areas</b> <span class="faint">(used when no region or province rate matches)</span>'
        : r.scope === 'region'
          ? `<select class="inv-select" data-i="${i}" data-f="name">${(REGIONS.includes(r.name) || !r.name ? REGIONS : REGIONS.concat(r.name)).map((n) => `<option ${n === r.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`
          : `<input class="inv-search" data-i="${i}" data-f="name" value="${esc(r.name)}" placeholder="Province, e.g. Cebu" maxlength="100" autocomplete="off">`;
      return `<tr>
        <td>${r.scope === 'default' ? 'Default' : r.scope === 'region' ? 'Region' : 'Province'}</td>
        <td>${place}</td>
        <td><label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-i="${i}" data-f="available" ${r.available === false ? '' : 'checked'}> <span class="faint">${r.available === false ? 'No' : 'Yes'}</span></label></td>
        <td><input class="inv-search" type="text" data-money inputmode="decimal" autocomplete="off" data-i="${i}" data-f="fee" value="${esc(MoneyInput.fmt(r.fee))}" style="width:120px" ${r.available === false ? 'disabled' : ''}></td>
        <td>${r.scope === 'default' ? '' : `<button type="button" class="btn-secondary btn-sm" data-del="${i}">Remove</button>`}</td></tr>`;
    }).join('');
  }
  panel.addEventListener('input', (e) => {
    const t = e.target; if (t.dataset.i == null) return;
    if (t.dataset.f === 'available') { rows[+t.dataset.i].available = t.checked; draw(); $('drMsg').textContent = ''; return; }
    rows[+t.dataset.i][t.dataset.f] = t.dataset.f === 'fee' ? MoneyInput.raw(t.value) : t.value;
    $('drMsg').textContent = '';
  });
  panel.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { rows.splice(+del.dataset.del, 1); draw(); }
  });
  $('drRecommended').onclick = () => {
    if (!window.confirm('Set every region to the recommended coverage (deliver to NCR, Central Luzon and CALABARZON only; block all other regions and "All other areas")?\nProvince exceptions you added are kept. Nothing changes until you press Save rates.')) return;
    const keep = rows.filter((r) => r.scope === 'province');
    const def = rows.find((r) => r.scope === 'default') || { scope: 'default', name: 'All other areas', fee: 150 };
    rows = [Object.assign({}, def, { available: false })]
      .concat(REGIONS.map((n) => ({ scope: 'region', name: n, fee: RECOMMENDED[n][0], available: RECOMMENDED[n][1] })), keep).sort(order);
    draw(); $('drMsg').textContent = 'Recommended coverage loaded. Review it, then press Save rates.';
  };
  $('drAddRegion').onclick = () => {
    const free = REGIONS.find((n) => !rows.some((r) => r.scope === 'region' && r.name === n)) || REGIONS[0];
    rows.push({ scope: 'region', name: free, fee: (rows.find((r) => r.scope === 'default') || {}).fee || 0 }); draw();
  };
  $('drAddProvince').onclick = () => { rows.push({ scope: 'province', name: '', fee: (rows.find((r) => r.scope === 'default') || {}).fee || 0 }); draw(); const el = panel.querySelector('tbody tr:last-child input[data-f="name"]'); if (el) el.focus(); };
  $('drSave').onclick = async () => {
    const msg = $('drMsg'); msg.textContent = '';
    for (const r of rows) {
      const fee = Number(r.fee);
      if (r.scope !== 'default' && String(r.name).trim().length < 2) { msg.textContent = 'Enter the province name for every province rate (or remove the row).'; return; }
      if (r.available !== false && (r.fee === '' || !Number.isFinite(fee) || fee < 0)) { msg.textContent = 'Enter a fee of 0 or more for ' + (r.name || 'every row') + '.'; return; }
    }
    const btn = $('drSave'); btn.disabled = true;
    try {
      rows = (await api('PUT', { rates: rows.map((r) => ({ scope: r.scope, name: String(r.name).trim(), fee: Number(r.fee) || 0, available: r.available !== false })) })).sort(order);
      draw(); toast('Delivery rates saved. New orders use them right away.');
    } catch (er) { msg.textContent = er.message; }
    btn.disabled = false;
  };

  api('GET').then((d) => { rows = d.sort(order); draw(); })
    .catch((er) => { if (er.status === 403) panel.remove(); else $('drBody').innerHTML = `<tr><td colspan="5" class="faint">${esc(er.message)}</td></tr>`; });

  /* ---------- weight charge + estimated arrival (delivery-calc.js) ---------- */
  const FIELDS = [
    ['freeWeightKg', 'Free weight allowance (kg)', 'No weight charge up to this weight per order.'],
    ['perKgFee', 'Charge per extra kg (₱)', 'Added for every started kg above the allowance. 0 switches the weight charge off.'],
    ['freeOverAmount', 'Free delivery on orders of (₱)', 'Goods total that earns free delivery. 0 = no free delivery.'],
    ['packDays', 'Packing time (working days)', 'From the order to handing the parcel to the courier.'],
    ['transitMetro', 'Travel time, Metro Manila (working days)', 'Added to the packing time.'],
    ['transitOther', 'Travel time, other areas (working days)', 'Added to the packing time.'],
    ['rangeDays', 'Arrival range (working days)', 'The customer is shown "earliest to latest"; the latest is this many days after the earliest.']
  ];
  const sp = document.createElement('div');
  sp.className = 'panel'; sp.style.marginTop = '18px';
  sp.innerHTML = '<div class="panel-head"><div><div class="panel-title">Delivery fee by weight &amp; arrival date</div>' +
    '<div class="panel-sub">The fee is the area rate above plus a weight charge for heavy orders, worked out from each product&rsquo;s weight (set in Products). ' +
    'The arrival date shown to customers and cashiers counts working days only: no Sundays, no fixed-date holidays. Orders placed after 3 PM count from the next working day.</div></div>' +
    '<div class="inv-filters"><button type="button" class="btn-primary btn-sm" id="dsSave">Save</button></div></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;padding:4px 16px 8px">' +
    FIELDS.map((x) => '<div><label class="form-label" for="ds_' + x[0] + '">' + esc(x[1]) + '</label><input class="inv-search" style="width:100%" id="ds_' + x[0] + '" inputmode="decimal" autocomplete="off">' +
      '<div class="faint" style="font-size:12px;margin-top:4px">' + esc(x[2]) + '</div></div>').join('') + '</div>' +
    '<div class="faint" id="dsExample" style="padding:6px 16px 4px"></div><div class="faint" id="dsMsg" style="padding:6px 16px 12px;min-height:18px"></div>';
  panel.insertAdjacentElement('afterend', sp);
  const $s = (id) => sp.querySelector('#' + id);
  async function sapi(method, body) {
    const r = await fetch('/api/delivery-settings', { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || (d.errors && Object.values(d.errors)[0]) || 'Request failed'); e.status = r.status; throw e; }
    return d;
  }
  const readS = () => { const o = {}; FIELDS.forEach((x) => { o[x[0]] = $s('ds_' + x[0]).value.replace(/[,\s₱]/g, ''); }); return o; };
  function example() {
    const v = readS(), free = Number(v.freeWeightKg), per = Number(v.perKgFee);
    if (![free, per].every(Number.isFinite) || v.freeWeightKg === '' || v.perKgFee === '') { $s('dsExample').textContent = ''; return; }
    const kg = Math.max(60, Math.ceil(free) + 40), extra = Math.max(0, Math.ceil(kg - free));
    $s('dsExample').innerHTML = per > 0 ? 'Example: a ' + kg + ' kg order pays the area rate + <b>' + extra + ' kg × ₱' + per.toLocaleString('en-PH') + ' = ₱' + (extra * per).toLocaleString('en-PH', { minimumFractionDigits: 2 }) + '</b>.' : 'Weight charge is off: the fee is just the area rate.';
  }
  sp.addEventListener('input', () => { $s('dsMsg').textContent = ''; example(); });
  function fillS(d) { FIELDS.forEach((x) => { $s('ds_' + x[0]).value = d[x[0]]; }); example(); }
  $s('dsSave').onclick = async () => {
    const btn = $s('dsSave'), msg = $s('dsMsg'); msg.textContent = ''; btn.disabled = true;
    try { fillS(await sapi('PUT', readS())); toast('Delivery fee and arrival settings saved. New orders use them right away.'); }
    catch (er) { msg.textContent = er.message; }
    btn.disabled = false;
  };
  sapi('GET').then(fillS).catch((er) => { if (er.status === 403) sp.remove(); else $s('dsMsg').textContent = er.message; });
})();