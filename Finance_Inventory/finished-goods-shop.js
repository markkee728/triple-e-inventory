// Integrated Finished Goods shop editor. Uses existing Finance product modal.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dept = $('npDept'), section = $('npShopSection'), sku = $('npSku');
  if (!dept || !section || !sku) return;
  const status = message => { $('npShopStatus').textContent = message; };
  let loadedSku = '';
  let pendingLoad = 0;
  function reset() {
    $('npShopDescription').value = '';
    $('npShopSpecs').value = '';
    $('npShopImages').value = '';
    $('npShopVisible').checked = false; // Safer default: unpublished
    loadedSku = '';
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
    if (!key) { reset(); status('Save the product first, then add its online details.'); return; }
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
  $('npShopSaveBtn').addEventListener('click', async () => {
    if (dept.value !== 'Finished Goods') return status('Only Finished Goods can be listed online.');
    const key = sku.value.trim().toUpperCase();
    if (!key) return status('Save the product first so it has an SKU.');
    const specs = {};
    for (const line of $('npShopSpecs').value.split('\n').map(s=>s.trim()).filter(Boolean)) {
      const idx = line.indexOf(':');
      if (idx < 1) return status('Specifications must use Name: Value, one per line.');
      const name = line.slice(0,idx).trim(), value = line.slice(idx+1).trim();
      if (!name || !value) return status('Each specification needs a name and a value.');
      specs[name] = value;
    }
    const images = $('npShopImages').value.split('\n').map(s=>s.trim()).filter(Boolean)
      .map(url=>({url,alt:$('npName').value.trim() || key}));
    const button = $('npShopSaveBtn');
    try {
      button.disabled = true;
      status('Saving...');
      await request('/api/finance/shop-products/' + encodeURIComponent(key), {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({description:$('npShopDescription').value,specs,images,visible:$('npShopVisible').checked})
      });
      loadedSku = key;
      status('Online shop details saved successfully.');
    } catch (error) { status('Could not save: ' + error.message); }
    finally { button.disabled = false; }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('#productTableBody, #newProductBtn')) {
      setTimeout(refresh, 100);
      setTimeout(refresh, 450);
    }
  }, true);
  reset(); refresh();
})();
