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
    $('npShopSpecs').value = '';
    $('npShopImages').value = '';
    $('npShopVisible').checked = true;  // new products are shown in the shop by default (untick to hide)
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
      $('npShopImages').value = (data.images || []).map(i => i.url).join('\n'); renderThumbs();
      $('npShopVisible').checked = !!data.visible;
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
    const images = $('npShopImages').value.split('\n').map(s=>s.trim()).filter(Boolean)
      .map(url=>({url,alt:$('npName').value.trim() || key}));
    await request('/api/finance/shop-products/' + encodeURIComponent(key), {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({description:$('npShopDescription').value,specs,images,visible:$('npShopVisible').checked})
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
  // Quick-add chips for common specification names (every product differs, so they only add an empty "Name: " line)
  (() => {
    const ta = $('npShopSpecs'); if (!ta || $('npSpecChips')) return;
    const box = document.createElement('div');
    box.id = 'npSpecChips';
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px';
    ['Material','Finish','Color','Dimensions','Size','Thickness','Weight','Grade','Capacity','Warranty'].forEach(name => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '+ ' + name;
      b.style.cssText = 'padding:4px 10px;border-radius:99px;border:1px solid var(--border,#7775);background:transparent;color:inherit;cursor:pointer;font-size:12.5px';
      b.addEventListener('click', () => {
        const has = ta.value.split('\n').some(l => l.trim().toLowerCase().startsWith(name.toLowerCase() + ':'));
        if (!has) { ta.value = (ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' : '') + name + ': '; ta.dispatchEvent(new Event('input', {bubbles:true})); }
        ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      box.appendChild(b);
    });
    ta.insertAdjacentElement('afterend', box);
  })();
  document.addEventListener('click', event => {
    if (event.target.closest('#productTableBody, #newProductBtn')) {
      setTimeout(refresh, 100);
      setTimeout(refresh, 450);
    }
  }, true);
  reset(); refresh();
})();
