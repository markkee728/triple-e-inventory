// Integrated Finished Goods shop editor. Uses existing Finance product modal.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dept = $('npDept'), section = $('npShopSection'), sku = $('npSku');
  if (!dept || !section || !sku) return;
  const status = message => { $('npShopStatus').textContent = message; };
  let loadedSku = '';
  let dirty = false;
  let pendingLoad = 0;
  function reset() {
    $('npShopDescription').value = '';
    $('npShopSpecs').value = ''; renderSpecRows();
    $('npShopImages').value = '';
    $('npShopVisible').checked = true;  // new products are shown in the shop by default (untick to hide)
    $('npShopMinOrder').value = '1';
    renderThumbs();
    loadedSku = ''; dirty = false;
  }
  // ---- photo upload: pick files, shrink them in the browser, send to the server, keep the returned links in the box ----
  const imgBox = $('npShopImages'), thumbs = $('npShopThumbs'), fileInput = $('npShopFile'), uploadBtn = $('npShopUploadBtn');
  const urls = () => imgBox.value.split('\n').map(s => s.trim()).filter(Boolean);
  function setUrls(list) { imgBox.value = list.join('\n'); renderThumbs(); section.dispatchEvent(new Event('input', {bubbles: true})); }
  function renderThumbs() {
    if (!thumbs) return;
    thumbs.innerHTML = '';
    urls().forEach((u, i) => {
      const d = document.createElement('div'); d.className = 'np-thumb';
      const im = document.createElement('img'); im.src = u; im.alt = ''; im.onerror = () => { im.style.opacity = '.25'; };
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Remove photo';
      x.addEventListener('click', () => setUrls(urls().filter((_, j) => j !== i)));
      d.append(im, x);
      if (i === 0) { const c = document.createElement('span'); c.className = 'cover'; c.textContent = 'Cover'; d.appendChild(c); }
      thumbs.appendChild(d);
    });
  }
  imgBox.addEventListener('input', renderThumbs);
  function shrink(file) {   // max 1400 px, JPEG, so every photo is far below the 2 MB limit
    return new Promise((resolve, reject) => {
      const img = new Image(), src = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(src);
        const k = Math.min(1, 1400 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => b ? resolve(b) : reject(new Error('Could not read that image')), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(src); reject(new Error(file.name + ' is not a readable image')); };
      img.src = src;
    });
  }
  if (uploadBtn) uploadBtn.addEventListener('click', () => fileInput.click());
  if (fileInput) fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files]; fileInput.value = '';
    if (!files.length) return;
    const room = 8 - urls().length;
    if (room <= 0) return status('You already have 8 photos. Remove one first.');
    uploadBtn.disabled = true;
    const list = urls(); let done = 0, failed = '';
    for (const f of files.slice(0, room)) {
      try {
        status('Uploading ' + (done + 1) + ' of ' + Math.min(files.length, room) + '...');
        const blob = await shrink(f);
        const r = await request('/api/finance/shop-images', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        list.push(r.url); done++;
      } catch (e) { failed = e.message; }
    }
    uploadBtn.disabled = false;
    if (done) setUrls(list);
    status((done ? done + ' photo(s) added. ' : '') + (files.length > room ? 'Only 8 photos fit; the rest were skipped. ' : '') + (failed ? 'Failed: ' + failed + '. ' : '') + (done ? 'Click Save Product (or Save Online Shop Details) to publish them.' : ''));
  });
  async function request(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async function refresh() {
    const token = ++pendingLoad;
    const eligible = dept.value === 'Finished Goods';
    section.hidden = !eligible;
    if (!eligible) { reset(); return; }
    const key = sku.value.trim().toUpperCase();
    if (!key) { reset(); status('You can fill this in now. It saves together with the product when you click Save Product.'); return; }
    if (key === loadedSku) return;
    reset();
    status('Loading online shop details...');
    try {
      const data = await request('/api/shop/product-content/' + encodeURIComponent(key));
      if (token !== pendingLoad || dept.value !== 'Finished Goods' || sku.value.trim().toUpperCase() !== key) return;
      $('npShopDescription').value = data.description || '';
      $('npShopSpecs').value = Object.entries(data.specs || {}).map(([k,v]) => `${k}: ${v}`).join('\n');
      renderSpecRows();
      $('npShopImages').value = (data.images || []).map(i => i.url).join('\n'); renderThumbs();
      $('npShopVisible').checked = !!data.visible;
      $('npShopMinOrder').value = data.minOrder || 1;
      loadedSku = key;
      status('Online shop details loaded.');
    } catch (error) {
      if (token !== pendingLoad) return;
      status('Not loaded yet: ' + error.message + '. Save the product first if it is new.');
    }
  }
  dept.addEventListener('change', refresh);
  sku.addEventListener('change', refresh);
  // Existing script opens/populates the modal; observe its visibility and input changes.
  const modal = $('newProductModalOverlay');
  if (modal) {
    const observer = new MutationObserver(() => {
      if (modal.classList.contains('active') || getComputedStyle(modal).display !== 'none') refresh();
    });
    observer.observe(modal, {attributes:true,attributeFilter:['class','style']});
  }
  section.addEventListener('input', () => { dirty = true; });
  // Saves the online details of one SKU. Throws an Error with a readable message on failure.
  async function saveOnline(key) {
    const specs = {};
    for (const line of $('npShopSpecs').value.split('\n').map(s=>s.trim()).filter(Boolean)) {
      const idx = line.indexOf(':');
      if (idx < 1) throw new Error('Specifications must use Name: Value, one per line.');
      const name = line.slice(0,idx).trim(), value = line.slice(idx+1).trim();
      if (!name || !value) throw new Error('Each specification needs a name and a value.');
      specs[name] = value;
    }
    const minOrder = Number($('npShopMinOrder').value);
    if (!Number.isFinite(minOrder) || minOrder <= 0) throw new Error('Minimum order must be a number above 0 (use 1 for no minimum).');
    const images = $('npShopImages').value.split('\n').map(s=>s.trim()).filter(Boolean)
      .map(url=>({url,alt:$('npName').value.trim() || key}));
    await request('/api/finance/shop-products/' + encodeURIComponent(key), {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({description:$('npShopDescription').value,specs,images,visible:$('npShopVisible').checked,minOrder})
    });
    loadedSku = key; dirty = false;
  }
  // Called by the main "Save Product" button (api-bridge.js) right after the product itself is saved,
  // so the online details typed in the same window are not lost. Only saves when something was edited.
  window.TripleEShop = {
    async saveWithProduct(skuValue) {
      if (dept.value !== 'Finished Goods' || !dirty) return false;
      await saveOnline(String(skuValue).trim().toUpperCase());
      return true;
    }
  };
  $('npShopSaveBtn').addEventListener('click', async () => {
    if (dept.value !== 'Finished Goods') return status('Only Finished Goods can be listed online.');
    const key = sku.value.trim().toUpperCase();
    if (!key) return status('Save the product first so it has an SKU.');
    const button = $('npShopSaveBtn');
    try {
      button.disabled = true;
      status('Saving...');
      await saveOnline(key);
      status('Online shop details saved successfully.');
    } catch (error) { status('Could not save: ' + error.message); }
    finally { button.disabled = false; }
  });
  // ---- Specifications: dropdown rows. The hidden textarea keeps the saved format ("Name: Value", one per line),
  //      so saving, loading and the online shop work exactly as before. ----
  const SPEC_NAMES = ['Material', 'Finish', 'Color', 'Grade', 'Size', 'Dimensions', 'Thickness', 'Weight', 'Capacity', 'Warranty'];
  const SPEC_PRESETS = {
    Material: ['Brass', 'Bronze', 'Copper', 'Stainless Steel 304', 'Stainless Steel 316', 'Carbon Steel', 'Galvanized Steel', 'Aluminum', 'Cast Iron'],
    Finish: ['Polished', 'Satin / Brushed', 'Matte', 'Powder Coated', 'Galvanized', 'Chrome Plated', 'Painted', 'Raw / Unfinished'],
    Color: ['Gold / Brass', 'Silver', 'Black', 'White', 'Bronze', 'Copper', 'Gray', 'Natural Metal'],
    Grade: ['Standard', 'Commercial', 'Industrial', 'Marine', 'Food Grade'],
    Size: ['1/4"', '3/8"', '1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '2-1/2"', '3"', '4"'],
    Warranty: ['No warranty', '6 months', '1 year', '2 years', '5 years', 'Lifetime']
  };
  const SPEC_FREE = { Dimensions: 'e.g. 25 x 100 mm', Thickness: 'e.g. 3 mm', Weight: 'e.g. 1.5 kg', Capacity: 'e.g. 20 liters' };
  const OTHER = '__other__';
  const specTa = $('npShopSpecs');
  let specBox = null, specRows = null;
  const el = (tag, cls, attrs) => { const e = document.createElement(tag); if (cls) e.className = cls; Object.assign(e, attrs || {}); return e; };
  const canonName = n => SPEC_NAMES.find(x => x.toLowerCase() === String(n).trim().toLowerCase()) || '';

  function specSync() {
    const lines = [], used = new Set();
    specRows.querySelectorAll('.np-spec-row').forEach(row => {
      const name = row._name();
      if (!name) return;
      used.add(name.toLowerCase());
      lines.push(name + ': ' + row._value());
    });
    // a specification can only be used once: grey out names already chosen in another row
    specRows.querySelectorAll('.np-spec-row').forEach(row => {
      const mine = (row._name() || '').toLowerCase();
      [...row._nameSel.options].forEach(o => { o.disabled = !!o.value && o.value !== OTHER && used.has(o.value.toLowerCase()) && o.value.toLowerCase() !== mine; });
    });
    specTa.value = lines.join('\n');
    specTa.dispatchEvent(new Event('input', { bubbles: true }));   // marks the online details as edited
  }

  function buildSpecRow(name, value) {
    const row = el('div', 'np-spec-row');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px';
    const known = canonName(name);
    const nameSel = el('select', 'form-select');
    nameSel.style.cssText = 'flex:1 1 170px;min-width:150px';
    nameSel.innerHTML = '<option value="">Choose specification…</option>' + SPEC_NAMES.map(n => '<option value="' + n + '">' + n + '</option>').join('') + '<option value="' + OTHER + '">Other specification…</option>';
    const nameInp = el('input', 'form-input', { type: 'text', placeholder: 'Specification name', maxLength: 80, autocomplete: 'off' });
    nameInp.style.cssText = 'flex:1 1 150px;min-width:130px';
    const valBox = el('div'); valBox.style.cssText = 'flex:2 1 220px;display:flex;gap:8px;min-width:180px';
    const rm = el('button', 'btn-secondary btn-sm', { type: 'button', title: 'Remove this specification', textContent: '×' });
    rm.setAttribute('aria-label', 'Remove this specification');
    let valSel = null, valInp = null;

    function buildValue(initial) {
      valBox.innerHTML = ''; valSel = valInp = null;
      const n = nameSel.value === OTHER ? '' : nameSel.value;
      nameInp.style.display = nameSel.value === OTHER ? '' : 'none';
      if (!nameSel.value) { valBox.innerHTML = '<span class="field-hint" style="align-self:center">Choose a specification first.</span>'; return; }
      const preset = SPEC_PRESETS[n];
      if (preset) {
        valSel = el('select', 'form-select'); valSel.style.flex = '1';
        valSel.innerHTML = '<option value="">Choose value…</option>' + preset.map(v => '<option value="' + v.replace(/"/g, '&quot;') + '">' + v + '</option>').join('') + '<option value="' + OTHER + '">Other value…</option>';
        valBox.appendChild(valSel);
      }
      valInp = el('input', 'form-input', { type: 'text', maxLength: 300, autocomplete: 'off', placeholder: SPEC_FREE[n] || 'Type the value' });
      valInp.style.flex = '1';
      valBox.appendChild(valInp);
      if (valSel) {
        const showInp = () => { valInp.style.display = valSel.value === OTHER ? '' : 'none'; };
        valSel.addEventListener('change', () => { showInp(); if (valSel.value === OTHER) valInp.focus(); specSync(); });
        if (initial) { if ([...valSel.options].some(o => o.value === initial)) valSel.value = initial; else { valSel.value = OTHER; valInp.value = initial; } }
        showInp();
      } else if (initial) valInp.value = initial;
      valInp.addEventListener('input', specSync);
    }

    row._nameSel = nameSel;
    row._name = () => nameSel.value === OTHER ? nameInp.value.replace(/:/g, '').trim() : nameSel.value;
    row._value = () => valSel && valSel.value !== OTHER ? valSel.value : (valInp ? valInp.value.replace(/\n/g, ' ').trim() : '');
    nameSel.addEventListener('change', () => { buildValue(''); if (nameSel.value === OTHER) nameInp.focus(); specSync(); });
    nameInp.addEventListener('input', specSync);
    rm.addEventListener('click', () => { row.remove(); specSync(); });

    if (known) nameSel.value = known; else if (name) { nameSel.value = OTHER; nameInp.value = name; }
    buildValue(value || '');
    row.append(nameSel, nameInp, valBox, rm);
    return row;
  }

  // Rebuild the dropdown rows from the textarea (used when a product is opened or the form is reset).
  function renderSpecRows() {
    if (!specRows) return;
    specRows.innerHTML = '';
    specTa.value.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
      const i = l.indexOf(':');
      specRows.appendChild(buildSpecRow(i < 0 ? l : l.slice(0, i).trim(), i < 0 ? '' : l.slice(i + 1).trim()));
    });
    // keep "already used" names greyed out without marking the form as edited
    const used = new Set([...specRows.querySelectorAll('.np-spec-row')].map(r => (r._name() || '').toLowerCase()));
    specRows.querySelectorAll('.np-spec-row').forEach(row => {
      const mine = (row._name() || '').toLowerCase();
      [...row._nameSel.options].forEach(o => { o.disabled = !!o.value && o.value !== OTHER && used.has(o.value.toLowerCase()) && o.value.toLowerCase() !== mine; });
    });
  }

  (() => {
    if (!specTa || $('npSpecRows')) return;
    specTa.style.display = 'none';
    specBox = el('div'); specBox.id = 'npSpecBox';
    specRows = el('div'); specRows.id = 'npSpecRows';
    const add = el('button', 'btn-secondary btn-sm', { type: 'button', textContent: '+ Add specification' });
    add.addEventListener('click', () => {
      const row = buildSpecRow('', ''); specRows.appendChild(row); specSync(); row._nameSel.focus();
    });
    specBox.append(specRows, add);
    specTa.insertAdjacentElement('afterend', specBox);
    const hint = specTa.parentElement && specTa.parentElement.querySelector('.field-hint');
    if (hint) hint.textContent = 'Choose a specification, then pick its value from the list (use "Other…" if it is not listed).';
    renderSpecRows();
  })();
  document.addEventListener('click', event => {
    if (event.target.closest('#productTableBody, #newProductBtn')) {
      setTimeout(refresh, 100);
      setTimeout(refresh, 450);
    }
  }, true);
  reset(); refresh();
})();