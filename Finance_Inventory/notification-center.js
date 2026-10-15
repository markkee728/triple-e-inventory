/* Shared Notification Center (bell, dropdown, history page) for Finance, Cashier, and Customer. */
(function () {
  'use strict';

  var CATS = [
    { id: '', label: 'All' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'production', label: 'Production' },
    { id: 'orders', label: 'Orders' },
    { id: 'payment', label: 'Payments' },
    { id: 'delivery', label: 'Delivery' },
    { id: 'pos', label: 'POS' }
  ];
  var LABELS = { inventory: 'Inventory', production: 'Production', orders: 'Orders', payment: 'Payment', delivery: 'Delivery', pos: 'POS', system: 'System' };
  var PAGE_LIMIT = 40;
  var pollTimer = null;
  var dropOpen = false;
  var pageCat = '';
  var pageUnread = false;
  var pageOffset = 0;
  var pageTotal = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fileOf(href) {
    try { return decodeURIComponent((new URL(href, location.href).pathname.split('/').pop() || '')); }
    catch (e) { return ''; }
  }
  function hashOf(href) {
    try { return (new URL(href, location.href).hash || '').replace(/^#/, ''); }
    catch (e) { return String(href || '').split('#')[1] || ''; }
  }

  async function api(path, opts) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}));
    if (res.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function go(link) {
    if (!link) return;
    var target = fileOf(link);
    var here = decodeURIComponent((location.pathname.split('/').pop() || ''));
    var hash = hashOf(link);
    if (target && target !== here) { location.href = link; return; }
    if (hash) {
      if (typeof window.navigateToPage === 'function' && document.getElementById(hash)) window.navigateToPage(hash);
      else if (typeof window.showPage === 'function') window.showPage(hash);
      else if (typeof window.show === 'function') window.show(hash);
      else location.hash = hash;
    }
  }

  function itemHtml(n, compact) {
    var cls = 'nc-item' + (n.isRead ? '' : ' unread') + (n.severity === 'critical' ? ' critical' : n.severity === 'warn' ? ' warn' : '');
    var resolved = n.isResolved ? '<span class="nc-tag">Resolved</span>' : '';
    return '<button type="button" class="' + cls + '" data-nc-id="' + n.id + '" data-nc-link="' + esc(n.link || '') + '">' +
      '<span class="nc-dot"></span><span>' +
      '<span class="nc-meta"><span class="nc-cat">' + esc(LABELS[n.category] || n.category) + '</span>' + resolved +
      '<span class="nc-when">' + esc(n.when || '') + '</span></span>' +
      '<span class="nc-title">' + esc(n.title) + '</span>' +
      (compact ? '' : '<span class="nc-body">' + esc(n.body) + '</span>') +
      '</span></button>';
  }

  function setCount(n) {
    var el = $('ncCount');
    if (!el) return;
    setStat(n);
    if (!n) { el.hidden = true; el.textContent = '0'; return; }
    el.hidden = false;
    el.textContent = n > 99 ? '99+' : String(n);
  }

  function setStat(n) {
    var v = $('ncStatValue'), foot = $('ncStatFoot');
    if (v) v.textContent = String(n || 0);
    if (foot) foot.textContent = n ? 'Open the Notification Center to review' : 'You are all caught up';
  }

  async function refreshCount() {
    try {
      var d = await api('/notifications/unread-count');
      setCount(d.unread || 0);
    } catch (e) { /* stay quiet if the API is down */ }
  }

  async function loadDrop() {
    var list = $('ncDropList');
    if (!list) return;
    list.innerHTML = '<div class="nc-empty">Loading…</div>';
    try {
      var d = await api('/notifications?limit=8');
      setCount(d.unread || 0);
      if (!d.items.length) { list.innerHTML = '<div class="nc-empty">No notifications yet.</div>'; return; }
      list.innerHTML = d.items.map(function (n) { return itemHtml(n, true); }).join('');
    } catch (e) {
      list.innerHTML = '<div class="nc-empty">Could not load notifications.</div>';
    }
  }

  async function loadPage(reset) {
    var host = $('ncPageList');
    if (!host) return;
    if (reset) { pageOffset = 0; host.innerHTML = ''; }
    var q = '?limit=' + PAGE_LIMIT + '&offset=' + pageOffset;
    if (pageCat) q += '&category=' + encodeURIComponent(pageCat);
    if (pageUnread) q += '&unread=1';
    try {
      var d = await api('/notifications' + q);
      pageTotal = d.total || 0;
      setCount(d.unread || 0);
      var sub = $('ncPageSub');
      if (sub) sub.textContent = (d.unread ? d.unread + ' unread · ' : '') + d.total + ' in your history';
      if (!d.items.length && pageOffset === 0) {
        host.innerHTML = '<div class="nc-empty">Nothing in this filter yet.</div>';
      } else {
        host.insertAdjacentHTML('beforeend', d.items.map(function (n) { return itemHtml(n, false); }).join(''));
      }
      pageOffset += d.items.length;
      var more = $('ncMore');
      if (more) more.hidden = d.items.length < PAGE_LIMIT;
      var role = d.role;
      if (role) document.querySelectorAll('[data-nc-roles]').forEach(function (chip) {
        var allow = (chip.getAttribute('data-nc-roles') || '').split(',');
        chip.hidden = allow.length && allow.indexOf(role) < 0;
      });
    } catch (e) {
      if (!pageOffset) host.innerHTML = '<div class="nc-empty">Could not load notifications.</div>';
    }
  }

  async function markRead(id) {
    try { await api('/notifications/' + id + '/read', { method: 'POST', body: '{}' }); }
    catch (e) { /* still follow the link */ }
  }
  async function markAll() {
    await api('/notifications/read-all', { method: 'POST', body: '{}' });
    setCount(0);
    document.querySelectorAll('.nc-item.unread').forEach(function (el) { el.classList.remove('unread'); });
  }

  function setDrop(open) {
    var drop = $('ncDrop'), bell = $('ncBell');
    dropOpen = !!open;
    if (drop) drop.classList.toggle('open', dropOpen);
    if (bell) bell.setAttribute('aria-expanded', dropOpen ? 'true' : 'false');
    if (dropOpen) loadDrop();
  }

  function onItemClick(el) {
    var id = el.getAttribute('data-nc-id');
    var link = el.getAttribute('data-nc-link') || '';
    setDrop(false);
    Promise.resolve(id ? markRead(id) : null).then(function () {
      refreshCount();
      if (el.closest('#ncPageList')) el.classList.remove('unread');
      go(link);
    });
  }

  function bind() {
    var bell = $('ncBell');
    if (!bell) return;
    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      setDrop(!dropOpen);
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#ncWrap')) setDrop(false);
      if (!e.target.closest('#userMenuWrap')) {
        var ud = $('userDropdown');
        if (ud) ud.classList.remove('open');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setDrop(false);
    });
    document.addEventListener('click', function (e) {
      var item = e.target.closest('[data-nc-id]');
      if (item) { e.preventDefault(); onItemClick(item); }
      if (e.target.closest('#ncViewAll')) {
        e.preventDefault(); setDrop(false);
        go('#' + ($('notifications') ? 'notifications' : ($('page-notifications') ? 'notifications' : 'notifications')));
        if (typeof window.showPage === 'function' && $('page-notifications')) window.showPage('notifications');
        else if (typeof window.show === 'function' && $('notifications')) window.show('notifications');
        else if (typeof window.navigateToPage === 'function' && $('notifications')) window.navigateToPage('notifications');
      }
      if (e.target.closest('#ncMarkAll') || e.target.closest('#ncPageMarkAll')) {
        e.preventDefault();
        markAll().then(function () { loadDrop(); if ($('ncPageList')) loadPage(true); }).catch(function () {});
      }
    });
    var stat = $('ncStatCard');
    if (stat) {
      var openStat = function () { window.NotificationCenter.openPage(); };
      stat.style.cursor = 'pointer';
      stat.addEventListener('click', openStat);
      stat.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStat(); } });
    }
    document.querySelectorAll('[data-nc-cat]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        pageCat = chip.getAttribute('data-nc-cat') || '';
        document.querySelectorAll('[data-nc-cat]').forEach(function (c) { c.classList.toggle('on', c === chip); });
        loadPage(true);
      });
    });
    var unreadBtn = $('ncUnreadOnly');
    if (unreadBtn) unreadBtn.addEventListener('click', function () {
      pageUnread = !pageUnread;
      unreadBtn.classList.toggle('on', pageUnread);
      unreadBtn.textContent = pageUnread ? 'Unread only' : 'All statuses';
      loadPage(true);
    });
    var more = $('ncMore');
    if (more) more.addEventListener('click', function () { loadPage(false); });

    document.addEventListener('visibilitychange', function () { if (!document.hidden) { refreshCount(); if (dropOpen) loadDrop(); } });
    pollTimer = setInterval(function () {
      if (!document.hidden) refreshCount();
    }, 15000);
    refreshCount();
    if ($('ncPageList')) loadPage(true);
    var h = hashOf(location.href);
    if (h && typeof window.navigateToPage !== 'function') setTimeout(function () {
      if (typeof window.showPage === 'function' && $('page-' + h)) window.showPage(h);
      else if (typeof window.show === 'function' && $(h)) window.show(h);
    }, 150);
  }

  window.NotificationCenter = {
    mount: bind,
    refresh: refreshCount,
    openPage: function () {
      if (typeof window.navigateToPage === 'function' && $('notifications')) window.navigateToPage('notifications');
      else if (typeof window.showPage === 'function') window.showPage('notifications');
      else if (typeof window.show === 'function') window.show('notifications');
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
