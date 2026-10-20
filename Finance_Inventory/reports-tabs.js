/* reports-tabs.js — Finance > Reports: ONE scrollable page, with a sticky section bar.
     Highlights   the numbers and facts that matter most
     Sales        sales overview, top sellers, sales transactions, cash shifts, receivables
     Inventory    low stock, stock in / out, materials, production, returns, stock value
     Movement Log the detailed record behind the inventory totals (one row per entry)
   Every report is always on the page. The bar only (1) scrolls to a section when clicked, (2) highlights the section you
   are reading as you scroll, and (3) shows the Report Period that every section follows. */
(function () {
  'use strict';
  var reduce = function () { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; };

  function init() {
    var page = document.getElementById('reports'), bar = document.getElementById('repTabs');
    if (!page || !bar) return;
    var buttons = Array.prototype.slice.call(bar.querySelectorAll('.rep-tab'));
    var current = 'summary', ticking = false;

    // .content has overflow:auto, which would make it (not the window) the scroll box a sticky bar sticks to.
    // While Reports is open, let the window scroll instead so the bar stays under the top bar.
    var host = page.closest('.content');
    // html/body are height:100%, so the body would end one screen down and the sticky sidebar would scroll away with it:
    // let the document grow while Reports is open (rep-scroll), so the sidebar stays pinned.
    function syncHost() {
      var on = page.classList.contains('active-page');
      if (host) host.classList.toggle('rep-content', on);
      document.documentElement.classList.toggle('rep-scroll', on);
    }

    // sticky bar sits just under the top bar: measure it so it never hides behind it
    function measure() {
      var tb = document.querySelector('.topbar'), h = tb ? tb.getBoundingClientRect().height : 0;
      var navH = bar.getBoundingClientRect().height || 56;
      page.style.setProperty('--rep-sticky', Math.round(h) + 'px');
      page.style.setProperty('--rep-offset', Math.round(h + navH + 14) + 'px');   // scroll-margin for jump targets
    }

    function mark(name) {
      if (name === current) return;
      current = name;
      buttons.forEach(function (b) {
        var on = b.dataset.rtab === name;
        b.classList.toggle('active', on);
        if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
        if (on && bar.scrollWidth > bar.clientWidth) { try { b.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) { /* ignore */ } }
      });
    }

    function spy() {
      ticking = false;
      if (!page.classList.contains('active-page')) return;
      var offset = (parseInt(page.style.getPropertyValue('--rep-offset'), 10) || 120) + 10, found = buttons[0].dataset.rtab;
      buttons.forEach(function (b) {
        var el = document.getElementById(b.dataset.target);
        if (el && el.getBoundingClientRect().top <= offset) found = b.dataset.rtab;
      });
      // at the very bottom of the page the last section is the one being read
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) found = buttons[buttons.length - 1].dataset.rtab;
      mark(found);
    }
    function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }

    function go(name) {
      var b = buttons.filter(function (x) { return x.dataset.rtab === name; })[0]; if (!b) return;
      var el = document.getElementById(b.dataset.target); if (!el) return;
      mark(name);
      el.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' });
    }

    bar.addEventListener('click', function (e) { var b = e.target.closest('.rep-tab'); if (b) go(b.dataset.rtab); });

    // which Report Period the whole page is showing, kept visible in the bar
    var period = document.getElementById('repNavPeriod');
    function paintPeriod() {
      if (!period) return;
      var label = '';
      try { var r = window.TripleEReportRange && window.TripleEReportRange.get(); label = r && (r.label || (r.from && r.to ? (r.from === r.to ? r.from : r.from + ' to ' + r.to) : '')); } catch (e) { /* ignore */ }
      if (!label) { var pill = document.getElementById('dateShowingPill'); label = pill ? pill.textContent.replace(/^\s*Showing\s*/i, '').trim() : ''; }
      period.textContent = label || '\u2014';
    }
    window.addEventListener('tripleE:reportrange', paintPeriod);
    var pill = document.getElementById('dateShowingPill');
    if (pill && 'MutationObserver' in window) new MutationObserver(paintPeriod).observe(pill, { childList: true, characterData: true, subtree: true });

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () { measure(); onScroll(); });
    if ('MutationObserver' in window) new MutationObserver(function () { syncHost(); if (page.classList.contains('active-page')) { measure(); paintPeriod(); onScroll(); } }).observe(page, { attributes: true, attributeFilter: ['class'] });

    // kept so older code that asks "which tab / where does this report live" still works: everything is on one page now
    window.TripleEReportsTab = { show: go, current: function () { return current; }, homeOf: function () { return null; } };
    syncHost(); measure(); paintPeriod(); spy();
    setTimeout(function () { measure(); paintPeriod(); }, 600);   // after fonts / the first data load
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
