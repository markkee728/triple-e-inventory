/* operations-schedule.js — Automated tracking and planning board for Finance.
   Displays incoming supplier deliveries for Raw Materials & Finishing Supplies
   and scheduled manufacturing runs for Finished Goods with real-time material readiness.
*/
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const B = () => window.TripleEBridge;

  let currentTab = 'deliveries';
  let schedules = [];
  let plans = [];
  let busy = false;

  async function api(path, options) {
    const res = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options));
    if (res.status === 401) {
      window.location.href = 'Login_Inventory.html';
      throw new Error('Not signed in');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Request failed (' + res.status + ')');
    }
    return data;
  }

  function toast(msg, isError) {
    if (B() && typeof B().toast === 'function') {
      B().toast(msg, isError ? 'error' : undefined);
      return;
    }
    const el = document.createElement('div');
    el.className = 'app-toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function mountPanel() {
    const dash = $('dashboard');
    if (!dash || $('opsSchedulePanel')) return;

    const panel = document.createElement('div');
    panel.id = 'opsSchedulePanel';
    panel.className = 'panel ops-panel';
    panel.innerHTML = `
      <div class="panel-head">
        <div>
          <div class="panel-title">Operations & Delivery Schedule</div>
          <div class="panel-sub">Automated tracking for incoming supplier deliveries and finished goods production</div>
        </div>
        <div class="ops-head-actions">
          <div class="ops-tabs" role="tablist">
            <button type="button" class="ops-tab ${currentTab === 'deliveries' ? 'active' : ''}" data-ops-tab="deliveries">
              Incoming Deliveries <span class="ops-tab-count" id="opsDeliveriesCount">0</span>
            </button>
            <button type="button" class="ops-tab ${currentTab === 'plans' ? 'active' : ''}" data-ops-tab="plans">
              Production Planner <span class="ops-tab-count" id="opsPlansCount">0</span>
            </button>
          </div>
          <button type="button" class="btn-secondary ops-btn-refresh" id="opsRefreshBtn" title="Refresh schedule and readiness">Refresh</button>
        </div>
      </div>
      <div id="opsContent" class="ops-content">
        <div class="ops-empty">Loading operations schedule...</div>
      </div>
    `;

    // Insert right before recent movements panel
    const movementsPanel = dash.querySelector('.movements-panel');
    if (movementsPanel) {
      dash.insertBefore(panel, movementsPanel);
    } else {
      dash.appendChild(panel);
    }

    panel.querySelector('.ops-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ops-tab]');
      if (!btn || btn.dataset.opsTab === currentTab) return;
      currentTab = btn.dataset.opsTab;
      panel.querySelectorAll('.ops-tab').forEach((t) => t.classList.toggle('active', t.dataset.opsTab === currentTab));
      render();
    });

    $('opsRefreshBtn').addEventListener('click', () => {
      load(true);
    });

    panel.addEventListener('click', handleAction);
  }

  async function load(showToast) {
    try {
      const [sRes, pRes] = await Promise.all([
        api('/api/inventory/automation/delivery-schedules'),
        api('/api/inventory/automation/production-plans')
      ]);
      schedules = Array.isArray(sRes) ? sRes : [];
      plans = Array.isArray(pRes) ? pRes : [];

      const dCount = $('opsDeliveriesCount');
      if (dCount) dCount.textContent = schedules.length;
      const pCount = $('opsPlansCount');
      if (pCount) pCount.textContent = plans.length;

      render();
      if (showToast) toast('Operations schedule updated');
    } catch (err) {
      console.warn('[ops-schedule] load failed:', err.message);
      const box = $('opsContent');
      if (box) box.innerHTML = '<div class="ops-empty">Could not load schedule: ' + esc(err.message) + '</div>';
    }
  }

  function render() {
    const box = $('opsContent');
    if (!box) return;

    if (currentTab === 'deliveries') {
      renderDeliveries(box);
    } else {
      renderPlans(box);
    }
  }

  function renderDeliveries(box) {
    if (!schedules.length) {
      box.innerHTML = '<div class="ops-empty">No supplier delivery schedules configured.</div>';
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    let html = `
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Expected Date</th>
              <th>Department</th>
              <th>Material</th>
              <th>Quantity</th>
              <th>Supplier</th>
              <th>Frequency</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const s of schedules) {
      const isDue = s.nextDeliveryDate <= todayStr;
      const badge = isDue
        ? '<span class="ops-badge-due">Due Today</span>'
        : '<span class="ops-badge-sched">Scheduled</span>';

      html += `
        <tr>
          <td>${badge}</td>
          <td><b>${esc(s.nextDeliveryDate)}</b></td>
          <td><span class="dim">${esc(s.department)}</span></td>
          <td><strong>${esc(s.productName)}</strong> <div class="dim mono" style="font-size:11.5px">${esc(s.sku)}</div></td>
          <td><b>${num(s.quantity)} ${esc(s.unit)}</b></td>
          <td>${esc(s.supplierName)}</td>
          <td><span class="dim" style="text-transform:capitalize">${esc(s.frequency)}</span></td>
          <td>
            <button type="button" class="btn-primary btn-sm" data-receive-sched="${s.scheduleId}" ${busy ? 'disabled' : ''}>
              Receive Stock
            </button>
          </td>
        </tr>
      `;
    }

    html += `</tbody></table></div>`;
    box.innerHTML = html;
  }

  function renderPlans(box) {
    if (!plans.length) {
      box.innerHTML = '<div class="ops-empty">No periodic production plans configured.</div>';
      return;
    }

    let html = `
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead>
            <tr>
              <th>Readiness</th>
              <th>Target Date</th>
              <th>Finished Good</th>
              <th>Planned Volume</th>
              <th>Materials Needed (BOM)</th>
              <th>Period</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const p of plans) {
      const r = p.readiness || { isReady: false };
      const isReady = r.isReady;

      let readyBadge = '';
      if (isReady) {
        readyBadge = '<span class="ops-badge-ready">Materials Ready</span>';
      } else {
        const shortCount = (r.shortages || []).length;
        const firstShort = (r.shortages && r.shortages[0]) || { name: 'materials missing' };
        readyBadge = `<span class="ops-badge-short" title="${esc(firstShort.name)}">Shortage (${shortCount} item${shortCount === 1 ? '' : 's'})</span>`;
      }

      // Materials chips
      const allMats = [...(r.rawMaterials || []), ...(r.finishingSupplies || [])];
      let matHtml = '<div class="ops-mat-list">';
      if (allMats.length) {
        matHtml += allMats.slice(0, 3).map((m) => {
          const cls = m.isSufficient ? 'ops-mat-chip' : 'ops-mat-chip short';
          return `<span class="${cls}" title="${esc(m.department)}: needs ${num(m.consumedQty)} ${esc(m.unit)}, on hand ${num(m.onHand)}">${esc(m.name)}: <b>${num(m.consumedQty)} ${esc(m.unit)}</b></span>`;
        }).join('');
        if (allMats.length > 3) {
          matHtml += `<span class="dim" style="font-size:11px">+${allMats.length - 3} more</span>`;
        }
      } else {
        matHtml += '<span class="dim">No BOM configured</span>';
      }
      matHtml += '</div>';

      html += `
        <tr>
          <td>${readyBadge}</td>
          <td><b>${esc(p.nextRunDate)}</b></td>
          <td><strong>${esc(p.productName)}</strong> <div class="dim mono" style="font-size:11.5px">${esc(p.sku)}</div></td>
          <td><b>${num(p.targetVolume)} ${esc(p.unit)}</b></td>
          <td>${matHtml}</td>
          <td><span class="dim" style="text-transform:capitalize">${esc(p.period)}</span></td>
          <td>
            ${isReady
              ? `<button type="button" class="btn-primary btn-sm" data-run-plan="${p.planId}" ${busy ? 'disabled' : ''}>Run Production</button>`
              : `<button type="button" class="btn-secondary btn-sm" disabled title="Waiting on material deliveries">Awaiting Stock</button>`
            }
          </td>
        </tr>
      `;
    }

    html += `</tbody></table></div>`;
    box.innerHTML = html;
  }

  async function handleAction(e) {
    const recBtn = e.target.closest('[data-receive-sched]');
    const runBtn = e.target.closest('[data-run-plan]');

    if (recBtn && !busy) {
      const id = recBtn.dataset.receiveSched;
      const s = schedules.find((x) => String(x.scheduleId) === String(id));
      if (!s) return;

      const ok = confirm(`Confirm receiving delivery of ${num(s.quantity)} ${s.unit} of ${s.productName} from ${s.supplierName}?\n\nThis will record a supplier receipt and increment stock immediately.`);
      if (!ok) return;

      busy = true;
      recBtn.disabled = true;
      recBtn.textContent = 'Receiving...';

      try {
        const res = await api(`/api/inventory/automation/delivery-schedules/${id}/receive`, { method: 'POST' });
        toast(`Received ${num(res.quantity)} ${res.unit} of ${res.productName}. New on-hand: ${num(res.newOnHand)} ${res.unit}`);
        if (B() && typeof B().reload === 'function') await B().reload();
        await load(false);
      } catch (err) {
        toast(err.message, true);
      } finally {
        busy = false;
        render();
      }
    }

    if (runBtn && !busy) {
      const id = runBtn.dataset.runPlan;
      const p = plans.find((x) => String(x.planId) === String(id));
      if (!p) return;

      const r = p.readiness || {};
      const rawCount = (r.rawMaterials || []).length;
      const finCount = (r.finishingSupplies || []).length;

      const ok = confirm(`Run periodic production for ${num(p.targetVolume)} ${p.unit} of ${p.productName}?\n\nThis will simultaneously:\n• Deduct ${rawCount} Raw Material(s)\n• Deduct ${finCount} Finishing Supply(ies)\n• Add +${num(p.targetVolume)} ${p.unit} to Finished Goods`);
      if (!ok) return;

      busy = true;
      runBtn.disabled = true;
      runBtn.textContent = 'Processing...';

      try {
        const res = await api(`/api/inventory/automation/production-plans/${id}/execute`, { method: 'POST', body: JSON.stringify({}) });
        toast(`Production ${res.ref} confirmed: manufactured +${num(res.targetVolume)} ${res.finishedGood.unit} of ${res.finishedGood.name}. Materials deducted.`);
        if (B() && typeof B().reload === 'function') await B().reload();
        await load(false);
      } catch (err) {
        toast(err.message, true);
      } finally {
        busy = false;
        render();
      }
    }
  }

  function init() {
    mountPanel();
    load(false);

    // Refresh when navigating to dashboard or when window gains focus
    document.querySelectorAll('[data-page="dashboard"]').forEach((b) => {
      b.addEventListener('click', () => load(false));
    });

    const dashPage = $('dashboard');
    if (dashPage) {
      new MutationObserver(() => {
        if (dashPage.classList.contains('active-page')) load(false);
      }).observe(dashPage, { attributes: true, attributeFilter: ['class'] });
    }

    window.addEventListener('focus', () => {
      const d = $('dashboard');
      if (d && d.classList.contains('active-page')) load(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.OperationsSchedule = { load, render, mountPanel };
})();

