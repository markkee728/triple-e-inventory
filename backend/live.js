/* live.js — keeps every page up to date without reloading.
   Opens one connection to /api/events. When anyone saves a change, the server sends a "change" ping
   and this script re-reads the data for the page you are on (admin, cashier or customer).
   Put it in the same folder as the HTML files and add this line before </body> of
   Finance_Inventory.html, POS_Cashier.html and Shop_Customer.html:
       <script src="live.js"></script>                                                              */
(function () {
  'use strict';
  if (!window.EventSource) return;                       // very old browser: the pages still refresh by timer

  const page = (location.pathname.split('/').pop() || '').toLowerCase();
  let busy = false, again = false, timer = null, wasDown = false;

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function refresh() {
    if (document.hidden) { again = true; return; }       // refresh when the tab is shown again
    if (busy) { again = true; return; }
    busy = true;
    try {
      if (page === 'pos_cashier.html' && typeof renderSales === 'function') {
        // cashier: product stock + today's sales (a failed request keeps what is already on screen)
        const [p, s] = await Promise.all([getJson('/api/pos/products'), getJson('/api/pos/sales')]);
        PRODUCTS = p; sales = s;
        renderCats(); renderProducts(); renderSales();
      } else if (page === 'shop_customer.html' && typeof renderOrders === 'function') {
        // customer: catalog + my orders (so a status change by the admin shows up at once)
        const [p, o] = await Promise.all([getJson('/api/shop/products'), getJson('/api/shop/orders')]);
        PRODUCTS = p; orders = o;
        renderChips(); renderCatalog(); renderOrders();
      } else {
        // admin pages: reuse the refresh they already have (api-bridge.js and sales-admin.js listen for these)
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      }
      window.dispatchEvent(new CustomEvent('triplee:change'));
    } catch (e) {
      console.warn('[live] refresh failed:', e.message);
    } finally {
      busy = false;
      if (again && !document.hidden) { again = false; schedule(); }
    }
  }
  // several changes close together = one refresh
  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 250); }

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('change', schedule);
    es.onopen = () => { if (wasDown) { wasDown = false; schedule(); } };   // catch up on anything missed while offline
    es.onerror = () => { wasDown = true; };                                // the browser reconnects by itself
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && again) { again = false; schedule(); } });

  connect();
})();
