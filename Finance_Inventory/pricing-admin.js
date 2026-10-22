/* pricing-admin.js — Finance > Products > "Pricing rules".
   One place for every number the automatic prices use (pricing.js on the server):
     - finished goods markup (selling price = unit cost + markup, default 20%)
     - quote markup, and the ESTIMATES the quick recipe of a made-to-order quote starts from (weights, fill factor, density,
       scrap, finishing supply per kg). They are first guesses, labelled as estimates; the cashier / Finance can still correct
       the recipe lines on each quote. Saving re-prices every finished good on automatic pricing straight away. Loaded after api-bridge.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const B = () => window.TripleEBridge;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // which rate groups are shown, in what order, with what unit
  const GROUPS = [
    ['finishUsePerKg', 'Finishing supply used per kg of the piece', 'unit/kg', 'How much of the finishing supply (powder, plating salt, polishing compound …, in its stock unit) one kg of the piece uses. 0 = the finish uses no stock item.'],
    ['rangeWeightKg', 'Weight of a size range (aluminum)', 'kg', 'Brass weighs more: it is scaled by the densities below.'],
    ['pipeWeightKg', 'Weight of a fitting by pipe size (brass)', 'kg', 'Typed sizes between two of these are worked out in between.'],
    ['density', 'Density', 'g/cm³', 'Used for typed dimensions (length × width × height).']
  ];
  const SINGLES = [
    ['scrapPct', 'Material scrap allowance', '%'], ['fillFactor', 'Fill factor for typed dimensions', '0–1'],
    ['thicknessRefMm', 'Reference wall thickness', 'mm']
  ];
  const EST = ' <em class="pr-est">estimate</em>';
  let data = null;

  function ensureModal() {
    let ov = $('pricingOverlay'); if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'modal-overlay'; ov.id = 'pricingOverlay';
    ov.innerHTML = '<div class="account-modal supplier-modal product-modal pr-modal" role="dialog" aria-modal="true" aria-labelledby="prTitle">' +
      '<button type="button" class="modal-close" id="prClose" aria-label="Close">×</button>' +
      '<div class="supplier-modal-head"><div class="supplier-modal-icon"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>' +
      '<div><div class="modal-eyebrow">Catalog</div><h2 class="modal-title" id="prTitle" style="margin-bottom:0">Pricing rules</h2></div></div>' +
      '<form id="prForm" novalidate><div id="prBody"><p class="dim">Loading…</p></div>' +
      '<p class="form-error" id="prErr"></p><div class="modal-footer"><button type="button" class="btn-secondary" id="prCancel">Cancel</button>' +
      '<button type="submit" class="btn-primary" id="prSave">Save pricing rules</button></div></form></div>';
    document.body.appendChild(ov);
    const close = () => { ov.classList.remove('open'); if (!document.querySelector('.modal-overlay.open')) { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; } };
    $('prClose').addEventListener('click', close); $('prCancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
    $('prForm').addEventListener('submit', (e) => { e.preventDefault(); save(close); });
    $('prBody').addEventListener('input', preview);
    return ov;
  }
  const field = (name, label, unit, value, step, est) =>
    '<label class="pr-f"><span>' + esc(label) + (est ? EST : '') + '</span><span class="pr-in"><input type="number" min="0" step="' + (step || 'any') + '" inputmode="decimal" name="' + esc(name) + '" value="' + esc(value) + '"><i>' + esc(unit) + '</i></span></label>';

  function render() {
    const r = data.rates, mp = data.materialItems || {};
    $('prBody').innerHTML =
      '<div class="form-section-label">Finished goods</div>' +
      '<div class="pr-grid">' + field('fgMarkupPct', 'Markup on cost', '%', data.fgMarkupPct, '0.01') + '</div>' +
      '<p class="field-hint" id="prFgHint"></p>' +
      '<div class="form-section-label">Custom made-to-order quotes</div>' +
      '<div class="pr-grid">' + field('quoteMarkupPct', 'Markup on the computed cost', '%', data.quoteMarkupPct, '0.01') +
        SINGLES.map((s) => field('rates.' + s[0], s[1], s[2], r[s[0]], null, true)).join('') + '</div>' +
      '<p class="field-hint">The quick recipe uses the stock item that matches each material, at its current unit cost: ' + Object.keys(mp).map((m) => esc(m) + ' → ' +
        (mp[m] ? esc(mp[m].name) + ' ' + (mp[m].unitCost > 0 ? peso(mp[m].unitCost) + '/' + esc(mp[m].unit) : '<b>no cost yet: cannot price</b>') : '<b>no stock item: cannot price</b>')).join(' · ') + '.</p>' +
      GROUPS.map((g) => '<details class="pr-group"><summary>' + esc(g[1]) + EST + '</summary><p class="field-hint">' + esc(g[3]) + '</p><div class="pr-grid">' +
        Object.keys(r[g[0]] || {}).map((k) => field('rates.' + g[0] + '.' + k, k, g[2], r[g[0]][k])).join('') + '</div></details>').join('') +
      '<p class="field-hint">Quick recipe per piece: raw material = estimated weight × (1 + scrap), finishing supply = weight × its use per kg. ' +
        'Cost = each quantity × the item’s current unit cost (materials only, the same formula as a finished good’s recipe); price = cost × (1 + markup). ' +
        'Fields marked <em class="pr-est">estimate</em> are first guesses: the cashier or Finance can correct the recipe on each quote.' +
        (data.updatedAt ? ' Last changed ' + esc(new Date(data.updatedAt).toLocaleString('en-PH')) + (data.updatedBy ? ' by ' + esc(data.updatedBy) : '') + '.' : '') + '</p>';
    preview();
  }
  function preview() {
    const f = $('prForm'), m = Number(f.elements.fgMarkupPct && f.elements.fgMarkupPct.value), h = $('prFgHint'); if (!h) return;
    h.textContent = Number.isFinite(m) && m >= 0 ? 'Markup is on COST, not on the price. Selling price = unit cost × ' + (1 + m / 100).toFixed(2) + '. Example: cost ₱100.00 → price ' + peso(100 * (1 + m / 100)) +
      ', which is a margin of ' + (m / (100 + m) * 100).toFixed(1) + '%. The unit cost of a finished good comes from its recipe (materials only). Every finished good on automatic pricing is updated when you save.' : 'Enter the markup in percent.';
  }
  async function open() {
    const ov = ensureModal(); ov.classList.add('open'); document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    $('prErr').classList.remove('show'); $('prBody').innerHTML = '<p class="dim">Loading…</p>';
    try { data = await B().api('/pricing'); render(); } catch (e) { $('prBody').innerHTML = '<p class="prod-warn">' + esc(e.message) + '</p>'; }
  }
  async function save(close) {
    const f = $('prForm'), err = $('prErr'), btn = $('prSave');
    const body = { fgMarkupPct: f.elements.fgMarkupPct.value, quoteMarkupPct: f.elements.quoteMarkupPct.value, rates: {} };
    [].forEach.call(f.querySelectorAll('input[name^="rates."]'), (i) => {
      const parts = i.name.split('.'); if (parts.length === 2) body.rates[parts[1]] = i.value;
      else { body.rates[parts[1]] = body.rates[parts[1]] || {}; body.rates[parts[1]][parts.slice(2).join('.')] = i.value; }
    });
    btn.disabled = true; err.classList.remove('show');
    try {
      const r = await B().api('/finance/pricing', { method: 'PUT', body: JSON.stringify(body) });
      B().toast('Pricing rules saved' + (r.repriced ? ' · ' + r.repriced + ' finished good price' + (r.repriced === 1 ? '' : 's') + ' recalculated' : '') + '.');
      document.dispatchEvent(new CustomEvent('triplee:pricing-saved', { detail: r }));
      close(); await B().reload();
    } catch (e) {
      const first = e.fields && Object.keys(e.fields)[0];
      err.textContent = first ? e.fields[first] : e.message; err.classList.add('show');
      if (first && f.elements[first]) f.elements[first].focus();
    } finally { btn.disabled = false; }
  }
  function init() {
    const right = document.querySelector('#products .catalog-toolbar-right'), nb = $('newProductBtn');
    if (!right || !nb || $('pricingRulesBtn')) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary'; b.id = 'pricingRulesBtn';
    b.title = 'Markup and the automatic price formula'; b.textContent = 'Pricing rules';
    right.insertBefore(b, nb); b.addEventListener('click', open);
    const st = document.createElement('style');
    st.textContent = '.pr-modal{max-width:760px}.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 14px;margin:6px 0 4px}' +
      '.pr-f{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-dim);min-width:0}.pr-in{display:flex;align-items:center;gap:6px}' +
      '.pr-in input{flex:1 1 auto;min-width:0;background:var(--black);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit}' +
      '.pr-in i{font-style:normal;color:var(--text-faint);white-space:nowrap;font-size:12px}.pr-group{margin:8px 0;border:1px solid var(--border);border-radius:10px;padding:8px 12px}' +
      '.pr-group summary{cursor:pointer;font-weight:650;color:var(--text)}#pricingRulesBtn{white-space:nowrap}' +
      '.pr-est{font-style:normal;font-size:11px;font-weight:650;color:var(--amber);border:1px solid var(--amber);border-radius:99px;padding:0 6px;margin-left:4px;text-transform:uppercase;letter-spacing:.4px}';
    document.head.appendChild(st);
  }
  window.TripleEPricing = { open };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
