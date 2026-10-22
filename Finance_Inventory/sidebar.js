/* sidebar.js — behaviour of the left menu in Finance_Inventory.html (the styling is in sidebar.css).
     - Inventory / Sales / Admin headers open and close their section (the chevron turns, aria-expanded follows)
     - the section that holds the current page opens by itself, now and whenever the page changes
     - a closed section that holds the current page shows a small blue dot
     - "Collapse" shrinks the menu to an icon rail on desktop (html.sb-rail); both choices are remembered
   Load it last, after script.js and api-bridge.js:  <script src="sidebar.js?v=2"></script> */
(function () {
  'use strict';

  var OPEN_KEY = 'tripleE.navOpen';        // JSON array of group names the person left open
  var RAIL_KEY = 'tripleE.sidebarRail';    // "1" = icon rail (the page head script reads the same key)
  var side = document.getElementById('sidebar');
  if (!side) return;
  var groups = Array.prototype.slice.call(side.querySelectorAll('.nav-group[data-group]'));

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage blocked: still works, just not remembered */ } }

  /* ---------- sections ---------- */
  var openSet = [];
  try { var saved = JSON.parse(read(OPEN_KEY) || '[]'); if (Array.isArray(saved)) openSet = saved.filter(function (n) { return typeof n === 'string'; }); } catch (e) { openSet = []; }

  function toggleOf(g) { return g.querySelector('.nav-group-toggle'); }
  function setOpen(g, open, remember) {
    g.classList.toggle('open', open);
    var t = toggleOf(g); if (t) t.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (remember) {
      var name = g.getAttribute('data-group'), at = openSet.indexOf(name);
      if (open && at < 0) openSet.push(name);
      if (!open && at >= 0) openSet.splice(at, 1);
      write(OPEN_KEY, JSON.stringify(openSet));
    }
    marker(g);
  }
  // the blue "you are in here" dot on a closed header (a red count set by another script is left alone)
  function marker(g) {
    var ind = g.querySelector('.ngt-ind'); if (!ind || ind.classList.contains('attn')) return;
    var here = g.classList.contains('has-active') && !g.classList.contains('open');
    ind.classList.toggle('here', here); ind.hidden = !here;
  }
  function syncActive(openIt) {
    groups.forEach(function (g) {
      var has = !!g.querySelector('.nav-item.active');
      g.classList.toggle('has-active', has);
      if (has && openIt && !g.classList.contains('open')) setOpen(g, true, true);
      else marker(g);
    });
  }

  groups.forEach(function (g) {
    var t = toggleOf(g); if (!t) return;
    setOpen(g, openSet.indexOf(g.getAttribute('data-group')) >= 0, false);
    t.addEventListener('click', function () { setOpen(g, !g.classList.contains('open'), true); });
  });
  syncActive(true);

  // the current page changes (menu click, Back button, a link in a notification): open the section it lives in
  var last = '';
  function activeId() { var a = side.querySelector('.nav-item.active'); return a ? (a.getAttribute('data-page') || '') : ''; }
  last = activeId();
  new MutationObserver(function () {
    var now = activeId(); if (now === last) return;
    last = now; syncActive(true);
  }).observe(side, { attributes: true, attributeFilter: ['class'], subtree: true });

  /* ---------- icon rail ---------- */
  var rail = document.getElementById('railToggle');
  function paintRail() {
    if (!rail) return;
    var on = document.documentElement.classList.contains('sb-rail');
    rail.setAttribute('aria-pressed', on ? 'true' : 'false');
    rail.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
    var label = rail.querySelector('.rail-toggle-text'); if (label) label.textContent = on ? 'Expand' : 'Collapse';
  }
  if (rail) {
    rail.addEventListener('click', function () {
      var on = document.documentElement.classList.toggle('sb-rail');
      write(RAIL_KEY, on ? '1' : '0'); paintRail();
    });
    paintRail();
  }
  // the page starts with animations off so the saved layout does not slide in; switch them on after the first paint
  requestAnimationFrame(function () { requestAnimationFrame(function () { document.documentElement.classList.remove('sb-noanim'); }); });
})();