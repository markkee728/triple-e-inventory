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
    $('npShopVisible').checked = false; // Safer default: unpublished
    loadedSku = ''; dirty = false;
  }
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
      $('npShopImages').value = (data.images || []).map(i => i.url).join('\n');
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
