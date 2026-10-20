/* reports-tabs.js — Finance > Reports: one tab per question, so the page is not one long scroll.
     Summary             headline numbers + two charts
     Sales               sales overview, top sellers, sales transactions, cash shifts, collections
     Inventory           totals and trends: stock in / out, materials, production, returns, low stock, stock value
     Stock Movement Log  the ONE detailed list: every stock in / out entry (the Inventory tab only adds up these same entries)
   The tabs only show / hide blocks that already exist (the rules are in reports-sales.css), so every report keeps
   working and the Report Period above stays shared by all of them. Printing always prints every tab. */
(function () {
  'use strict';
  var KEY = 'tripleE.reportsTab', TABS = ['summary', 'sales', 'inventory', 'movements'];
  // which tab each report lives on (used by the summary boxes, which jump straight to a report)
  var HOME = { repChartsGrid: 'summary', repStatCards: 'summary', repSalesRoot: 'sales', repTopRoot: 'sales', repSalesTxnPanel: 'sales',
    reportCashPanel: 'sales', reportLedgerPanel: 'sales', repLowRoot: 'inventory', repInvRoot: 'inventory', repStockDetail: 'inventory',
    ivOverview: 'inventory', ivMaterials: 'inventory', ivReturns: 'inventory', ivMovements: 'movements', repMovementPanel: 'movements' };

  function init() {
    var page = document.getElementById('reports'), bar = document.getElementById('repTabs');
    if (!page || !bar) return;
    var buttons = Array.prototype.slice.call(bar.querySelectorAll('.rep-tab'));

    function show(name, focus) {
      if (TABS.indexOf(name) < 0) name = 'summary';
      var changed = page.dataset.rtab !== name;
      page.dataset.rtab = name;
      buttons.forEach(function (b) {
        var on = b.dataset.rtab === name;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      try { sessionStorage.setItem(KEY, name); } catch (e) { /* storage blocked */ }
      if (changed) document.dispatchEvent(new CustomEvent('tripleE:reportstab', { detail: { tab: name } }));
    }

    bar.addEventListener('click', function (e) { var b = e.target.closest('.rep-tab'); if (b) show(b.dataset.rtab); });
    bar.addEventListener('keydown', function (e) {                 // arrow keys move between tabs
      var i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      var k = e.key, n = k === 'ArrowRight' ? i + 1 : k === 'ArrowLeft' ? i - 1 : k === 'Home' ? 0 : k === 'End' ? buttons.length - 1 : -1;
      if (n < 0) return;
      e.preventDefault(); show(buttons[(n + buttons.length) % buttons.length].dataset.rtab, true);
    });

    window.TripleEReportsTab = { show: show, current: function () { return page.dataset.rtab; }, homeOf: function (id) { return HOME[id] || null; } };
    var saved = null; try { saved = sessionStorage.getItem(KEY); } catch (e) { /* ignore */ }
    show(saved || 'summary');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
