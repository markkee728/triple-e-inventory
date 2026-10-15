/* sidebar.js — behaviour for the collapsible sidebar (Finance_Inventory.html)
   Loaded last. It never changes which page opens; it only reacts to the existing
   .nav-item buttons / navigateToPage() and keeps the matching section open.

   - Section headers (.nav-group-toggle) expand / collapse their links; choices are remembered.
   - The section that contains the current page opens automatically (also after refresh / back button).
   - A collapsed section shows a red count when a link inside it has an alert badge, or a blue dot when
     it holds the current page.
   - "Collapse" button (or the [ key) turns the sidebar into an icon rail on desktop; links get tooltips.
*/
(function () {
  'use strict';

  var side = document.getElementById('sidebar');
  if (!side) return;

  var root = document.documentElement;
  var GROUPS_KEY = 'tripleE.navGroups';     // { inventory: true, sales: false, ... } = what the person chose
  var RAIL_KEY = 'tripleE.sidebarRail';     // "1" = icon rail
  var BADGES = '.sa-nav-badge, .ra-badge, .sx-badge, .nav-alert';
  var DESKTOP = window.matchMedia('(min-width: 1025px)');

  /* ---------- storage (may be blocked) ---------- */
  function load() { try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) || {}; } catch (e) { return {}; } }
  function save(map) { try { localStorage.setItem(GROUPS_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ } }
  var prefs = load();

  /* ---------- helpers ---------- */
  var groups = Array.prototype.slice.call(side.querySelectorAll('.nav-group[data-group]'));

  // visible name of a link without its count badge (used for tooltips and the top-bar title)
  function labelOf(item) {
    if (item.dataset && item.dataset.title) return item.dataset.title;
    var c = item.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll(BADGES + ', svg, .dot, .nav-symbol'), function (n) { n.remove(); });
    return c.textContent.replace(/\s+/g, ' ').trim();
  }
  window.sidebarLabelOf = labelOf;          // api-bridge.js uses this for the top-bar title when present

  function setOpen(group, open, remember) {
    group.classList.toggle('open', open);
    var t = group.querySelector('.nav-group-toggle');
    if (t) t.setAttribute('aria-expanded', String(open));
    if (remember) { prefs[group.dataset.group] = open; save(prefs); }
  }

  /* ---------- indicators on collapsed headers ---------- */
  function paintIndicators() {
    var active = side.querySelector('.nav-item.active');
    groups.forEach(function (g) {
      var total = 0;
      Array.prototype.forEach.call(g.querySelectorAll(BADGES), function (b) {
        var n = parseInt(b.textContent, 10);
        total += isNaN(n) ? 1 : n;
      });
      var ind = g.querySelector('.ngt-ind');
      if (!ind) return;
      var here = !!(active && g.contains(active));
      g.classList.toggle('has-active', here);
      if (total > 0) {
        ind.className = 'ngt-ind attn';
        ind.textContent = total > 99 ? '99+' : String(total);
        ind.title = total + ' item' + (total === 1 ? '' : 's') + ' need attention';
        ind.hidden = false;
      } else if (here) {
        ind.className = 'ngt-ind here';
        ind.textContent = '';
        ind.removeAttribute('title');
        ind.hidden = false;
      } else {
        ind.hidden = true;
      }
    });
  }

  /* ---------- open the section for the current page ---------- */
  var lastActive = null;
  function syncActive() {
    var active = side.querySelector('.nav-item.active');
    paintIndicators();
    if (!active || active === lastActive) return;
    lastActive = active;
    var g = active.closest('.nav-group[data-group]');
    if (g && !g.classList.contains('open')) setOpen(g, true, false);
  }

  /* ---------- section headers ---------- */
  side.addEventListener('click', function (e) {
    var t = e.target.closest('.nav-group-toggle');
    if (!t || !side.contains(t)) return;
    var g = t.closest('.nav-group');
    setOpen(g, !g.classList.contains('open'), true);
  });

  /* ---------- icon rail ---------- */
  var railBtn = document.getElementById('railToggle');
  function railOn() { return root.classList.contains('sb-rail'); }
  function setRail(on, remember) {
    root.classList.toggle('sb-rail', on);
    if (railBtn) {
      railBtn.setAttribute('aria-pressed', String(on));
      railBtn.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
      var txt = railBtn.querySelector('.rail-toggle-text');
      if (txt) txt.textContent = on ? 'Expand' : 'Collapse';
    }
    hideTip();
    if (remember) { try { localStorage.setItem(RAIL_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ } }
  }
  if (railBtn) railBtn.addEventListener('click', function () { setRail(!railOn(), true); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey || !DESKTOP.matches) return;
    var el = document.activeElement, tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
    e.preventDefault();
    setRail(!railOn(), true);
  });

  /* ---------- tooltips while in rail mode ---------- */
  var tip = document.createElement('div');
  tip.className = 'sb-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  function showTip(el) {
    if (!railOn() || !DESKTOP.matches) return;
    var text = el.classList.contains('rail-toggle') ? el.getAttribute('aria-label') : labelOf(el);
    if (!text) return;
    tip.textContent = text;
    var r = el.getBoundingClientRect();
    tip.style.left = (r.right + 10) + 'px';
    tip.style.top = (r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
    tip.classList.add('show');
  }
  function hideTip() { tip.classList.remove('show'); }

  side.addEventListener('mouseover', function (e) { var el = e.target.closest('.nav-item, .rail-toggle'); if (el) showTip(el); });
  side.addEventListener('mouseout', function (e) { if (e.target.closest('.nav-item, .rail-toggle')) hideTip(); });
  side.addEventListener('focusin', function (e) { var el = e.target.closest('.nav-item, .rail-toggle'); if (el && el.matches(':focus-visible')) showTip(el); });
  side.addEventListener('focusout', hideTip);
  side.addEventListener('click', hideTip);
  var navEl = side.querySelector('nav');
  if (navEl) navEl.addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', hideTip);

  /* ---------- watch for page changes and badge updates ---------- */
  // links get .active from script.js; other scripts add / remove count badges and inject links (e.g. Stock Count)
  var mo = new MutationObserver(function () { syncActive(); });
  Array.prototype.forEach.call(side.querySelectorAll('.nav-items, .nav-top'), function (box) {
    mo.observe(box, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  });

  /* ---------- start ---------- */
  groups.forEach(function (g) { setOpen(g, prefs[g.dataset.group] === true, false); });
  setRail(railOn(), false);                 // sync the button label with the class set in <head>
  syncActive();
  // allow animations only after the first paint, so nothing slides on page load
  requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.remove('sb-noanim'); }); });
})();
