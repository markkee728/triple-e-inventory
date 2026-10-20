/* reports-jump.js — Finance > Reports.
   1. Every summary box at the top (it opens the tab its report is on, then scrolls to it) (data-jump="<section id>") scrolls to its own report and flashes it, so the box and the table match.
   2. A small "Back to summary" button appears once the Report Period / boxes are scrolled out of view.
   The dates themselves are not handled here: the Report Period panel is the one range, shared through
   window.TripleEReportRange and the 'tripleE:reportrange' event (see api-bridge.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function flash(el) {
    el.classList.remove('rep-flash'); void el.offsetWidth;            // restart the animation if it was just used
    el.classList.add('rep-flash');
    setTimeout(() => el.classList.remove('rep-flash'), 1800);
  }
  function jump(id) {
    // the report may sit on another tab: open that tab first, then scroll once it is visible
    const T = window.TripleEReportsTab, home = T && T.homeOf(id);
    if (home && T.current() !== home) { T.show(home); requestAnimationFrame(() => jump(id)); return; }
    const el = $(id); if (!el) return;
    // a report inside a wrapper (e.g. repSalesRoot) is highlighted through its first panel
    const target = el.firstElementChild && /^rep.*Root$/.test(id) ? el.firstElementChild : el;
    el.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' });
    flash(target);
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function init() {
    const cards = $('repStatCards'), top = $('repSummaryTop'), page = $('reports');
    if (!cards || !top || !page) return;
    cards.addEventListener('click', (e) => { const b = e.target.closest('[data-jump]'); if (b) jump(b.dataset.jump); });

    const back = document.createElement('button');
    back.type = 'button'; back.id = 'repBackTop'; back.className = 'rep-backtop'; back.hidden = true;
    back.innerHTML = '<span aria-hidden="true">&uarr;</span> Period &amp; summary';
    back.addEventListener('click', () => { top.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' }); });
    document.body.appendChild(back);

    let visible = true;
    const sync = () => { back.hidden = visible || !page.classList.contains('active-page'); };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((en) => { visible = en[0].isIntersecting; sync(); }, { threshold: 0 }).observe(top);
    } else { back.hidden = true; }
    new MutationObserver(sync).observe(page, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
