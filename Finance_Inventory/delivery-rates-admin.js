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
        <td><input class="inv-search" type="number" min="0" max="100000" step="0.01" data-i="${i}" data-f="fee" value="${esc(r.fee)}" style="width:120px" ${r.available === false ? 'disabled' : ''}></td>
        <td>${r.scope === 'default' ? '' : `<button type="button" class="btn-secondary btn-sm" data-del="${i}">Remove</button>`}</td></tr>`;
    }).join('');
  }
  panel.addEventListener('input', (e) => {
    const t = e.target; if (t.dataset.i == null) return;
    if (t.dataset.f === 'available') { rows[+t.dataset.i].available = t.checked; draw(); $('drMsg').textContent = ''; return; }
    rows[+t.dataset.i][t.dataset.f] = t.value;
    $('drMsg').textContent = '';
  });
  panel.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { rows.splice(+del.dataset.del, 1); draw(); }
  });
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
})();
