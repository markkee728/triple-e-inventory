/* reports-jump.js — Finance > Reports (one scrollable page).
   1. Every element with data-jump="<id>" (the summary cards, the highlight cards, the chips in each section banner)
      scrolls to that report and flashes it, so the card and the table match.
   2. A small "Back to top" button appears once the Report Period panel is scrolled out of view.
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
    const el = $(id); if (!el) return;
    // a report inside a wrapper (e.g. repSalesRoot) is highlighted through its first panel
    const target = el.firstElementChild && /^rep.*Root$/.test(id) ? el.firstElementChild : el;
    el.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' });
    flash(target);
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  window.TripleEReportJump = jump;

  function init() {
    const top = $('repSummaryTop'), page = $('reports');
    if (!top || !page) return;
    page.addEventListener('click', (e) => {
      const b = e.target.closest('[data-jump]'); if (!b || !page.contains(b)) return;
      e.preventDefault(); jump(b.dataset.jump);
    });

    const back = document.createElement('button');
    back.type = 'button'; back.id = 'repBackTop'; back.className = 'rep-backtop'; back.hidden = true;
    back.innerHTML = '<span aria-hidden="true">&uarr;</span> Back to top';
    back.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: reduce() ? 'auto' : 'smooth' }); });
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
