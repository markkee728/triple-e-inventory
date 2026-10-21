/* reports-highlights.js — Finance > Reports > "Key highlights" and the live figures in each section banner.
   Reads the same server reports the sections below use (sales overview, top products, low stock), for the shared
   Report Period, and turns them into: four headline cards, a short plain-language "What stands out" list, and the
   small figures shown in the Sales / Inventory / Stock Movement Log banners. Nothing here is calculated twice on the
   client: every total comes from the server; this file only picks, orders and words them. Philippine days. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const int = (n) => Number(n || 0).toLocaleString('en-PH');
  const num = (n) => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 });
  const pct = (n, d) => Number(n).toLocaleString('en-PH', { maximumFractionDigits: d == null ? 1 : d });

  const state = { sales: null, top: null, low: null, err: {}, loading: false, loaded: false, at: 0, seq: 0, timer: null };

  async function getJson(path) {
    const res = await fetch('/api' + path, { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status === 403 ? 'Only Finance-Admin can view financial reports.' : 'Could not load this report.'));
    return data;
  }
  function range() {
    try { const r = window.TripleEReportRange && window.TripleEReportRange.get(); return r && r.from && r.to && !r.invalid && r.from <= r.to ? r : null; } catch (e) { return null; }
  }

  /* ---------- load ---------- */
  async function load() {
    const r = range(); if (!r || !$('repInsights')) return;
    const seq = ++state.seq; state.loading = true; render();
    const q = 'from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    const got = await Promise.allSettled([
      getJson('/reports/sales-overview?' + q),
      getJson('/reports/top-products?' + q + '&channel=all&sort=revenue&limit=5'),
      getJson('/reports/low-stock?dept=all&status=attention&sort=status&q=')
    ]);
    if (seq !== state.seq) return;
    const keys = ['sales', 'top', 'low'];
    state.err = {};
    got.forEach((g, i) => { state[keys[i]] = g.status === 'fulfilled' ? g.value : null; if (g.status !== 'fulfilled') state.err[keys[i]] = (g.reason && g.reason.message) || 'Could not load.'; });
    state.loading = false; state.loaded = true; state.at = Date.now();
    render(); paintBanners();
  }

  /* ---------- small pieces ---------- */
  const GRAIN = { day: 'day', week: 'week', month: 'month', year: 'year' };
  function delta(s) {
    const k = s.kpis, days = s.range.days;
    if (k.netSalesChangePct == null) return '<span class="rep-delta flat">no sales in the previous period</span>';
    const up = k.netSalesChangePct >= 0;
    return '<span class="rep-delta ' + (up ? 'up' : 'down') + '">' + (up ? '\u25B2 ' : '\u25BC ') + pct(Math.abs(k.netSalesChangePct)) + '% vs previous ' + (days === 1 ? 'day' : days + ' days') + '</span>';
  }
  function bars(trend, grain) {
    if (!trend || !trend.length) return '';
    const W = 300, H = 64, n = trend.length, gap = n > 40 ? 0.5 : 2, bw = (W - (n - 1) * gap) / n;
    const max = Math.max.apply(null, trend.map((x) => Math.max(0, x.net)).concat([1]));
    let hi = 0; trend.forEach((x, i) => { if (x.net > trend[hi].net) hi = i; });
    return '<svg class="rep-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Net sales per ' + esc(GRAIN[grain] || 'period') + '">' +
      trend.map((x, i) => {
        const h = Math.max(x.net > 0 ? 2 : 0, Math.max(0, x.net) / max * (H - 4));
        return '<rect class="' + (i === hi && n > 1 && x.net > 0 ? 'hi' : '') + '" x="' + (i * (bw + gap)).toFixed(2) + '" y="' + (H - h).toFixed(2) + '" width="' + bw.toFixed(2) + '" height="' + h.toFixed(2) + '"><title>' + esc(x.label) + ': ' + peso(x.net) + '</title></rect>';
      }).join('') + '</svg>';
  }
  const more = (id, text) => '<button type="button" class="rep-more" data-jump="' + id + '">' + text + ' <span aria-hidden="true">&rsaquo;</span></button>';
  const unavailable = (what, msg) => '<div class="rep-hl-empty"><strong>' + what + ' is not available</strong><span>' + esc(msg) + '</span></div>';

  /* ---------- the four headline cards ---------- */
  function salesCard() {
    const s = state.sales;
    if (!s) return '<article class="rep-hl hero">' + (state.err.sales ? unavailable('Sales', state.err.sales) : '<div class="rep-skel"></div>') + '</article>';
    const k = s.kpis, has = s.statuses.length > 0;
    return '<article class="rep-hl hero"><div class="rep-hl-label">Net sales</div>' +
      '<div class="rep-hl-big">' + peso(k.netSales) + '</div>' +
      (has ? '<div class="rep-hl-line">' + delta(s) + '</div>' +
        bars(s.trend, s.range.grain) +
        '<div class="rep-hl-sub">Gross ' + peso(k.grossSales) + ' \u2212 refunds ' + peso(k.refunds) + ' \u00B7 ' + int(k.transactions) + ' transaction' + (k.transactions === 1 ? '' : 's') + ' \u00B7 average ' + peso(k.avgSale) + '</div>'
        : '<div class="rep-hl-sub">No completed sales between ' + esc(s.range.from) + ' and ' + esc(s.range.to) + '. Try a wider Report Period.</div>') +
      more('repSalesRoot', 'Open sales overview') + '</article>';
  }
  function bestCard() {
    const t = state.top;
    if (!t) return '<article class="rep-hl">' + (state.err.top ? unavailable('Top sellers', state.err.top) : '<div class="rep-skel"></div>') + '</article>';
    const rows = t.rows.slice(0, 3), topRev = rows.length ? Math.max(rows[0].revenue, 1) : 1;
    const body = rows.length ? '<ol class="rep-rank">' + rows.map((r) =>
      '<li><span class="rep-rank-n' + (r.rank === 1 ? ' first' : '') + '">' + r.rank + '</span><div class="rep-rank-main"><div class="rep-rank-top"><span class="rep-rank-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span><b>' + peso(r.revenue) + '</b></div>' +
      '<div class="rep-bar"><i style="width:' + Math.max(3, r.revenue / topRev * 100).toFixed(1) + '%"></i></div>' +
      '<div class="rep-rank-sub">' + num(r.units) + ' sold \u00B7 ' + pct(r.sharePct) + '% of product revenue</div></div></li>').join('') + '</ol>'
      : '<div class="rep-hl-sub">No products were sold in this period.</div>';
    return '<article class="rep-hl"><div class="rep-hl-label">Best sellers</div>' + body + more('repTopRoot', 'See the full ranking') + '</article>';
  }
  function attentionCard() {
    const l = state.low;
    if (!l) return '<article class="rep-hl">' + (state.err.low ? unavailable('Low-stock status', state.err.low) : '<div class="rep-skel"></div>') + '</article>';
    const m = l.summary, n = m.needAttention, rows = l.rows.slice(0, 4);
    const list = rows.length ? '<ul class="rep-alerts">' + rows.map((r) =>
      '<li><span class="rep-pill ' + (r.status === 'out' ? 'bad' : 'warn') + '">' + (r.status === 'out' ? 'Out' : 'Low') + '</span><span class="rep-alert-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span><span class="rep-alert-qty">' + num(r.onHand) + ' / ' + num(r.reorderLevel) + (r.unit ? ' ' + esc(r.unit) : '') + '</span></li>').join('') + '</ul>' +
      (n > rows.length ? '<div class="rep-hl-sub">and ' + int(n - rows.length) + ' more. Quantities show on hand / reorder level.</div>' : '<div class="rep-hl-sub">Quantities show on hand / reorder level.</div>')
      : '<div class="rep-allclear"><span aria-hidden="true">\u2713</span> Every product is at or above its reorder level.</div>';
    return '<article class="rep-hl ' + (n ? 'is-bad' : 'is-good') + '"><div class="rep-hl-label">Needs attention <span class="rep-live"><i></i>live</span></div>' +
      '<div class="rep-hl-big">' + int(n) + '<small>' + (n === 1 ? 'product to restock' : 'products to restock') + '</small></div>' +
      '<div class="rep-hl-line">' + int(m.out) + ' out of stock \u00B7 ' + int(m.low) + ' low' + (n ? ' \u00B7 about ' + peso(m.restockCost) + ' to reach reorder levels' : '') + '</div>' + list + more('repLowRoot', 'Open low-stock report') + '</article>';
  }
  function channelCard() {
    const s = state.sales;
    if (!s) return '<article class="rep-hl">' + (state.err.sales ? unavailable('Sales channels', state.err.sales) : '<div class="rep-skel"></div>') + '</article>';
    const pos = s.channels[0], on = s.channels[1], tot = s.kpis.netSales || 0, o = s.outcome;
    const share = (c) => (tot > 0 ? Math.max(0, c.net) / tot * 100 : 0);
    const body = tot > 0 ? '<div class="rep-split"><i class="pos" style="width:' + share(pos).toFixed(1) + '%"></i><i class="online" style="width:' + share(on).toFixed(1) + '%"></i></div>' +
      '<div class="rep-split-key"><span><i class="pos"></i>POS (counter)<b>' + pct(share(pos)) + '%</b><em>' + peso(pos.net) + '</em></span><span><i class="online"></i>Online (shop)<b>' + pct(share(on)) + '%</b><em>' + peso(on.net) + '</em></span></div>'
      : '<div class="rep-hl-sub">No sales to split between POS and online in this period.</div>';
    return '<article class="rep-hl"><div class="rep-hl-label">Sales channels</div>' + body +
      '<div class="rep-outcome"><span><i class="ok"></i>Completed <b>' + int(o.completed.count) + '</b></span><span><i class="warn"></i>Awaiting payment <b>' + int(o.pending.count) + '</b></span><span><i class="bad"></i>Cancelled <b>' + int(o.cancelled.count) + '</b></span></div>' +
      more('repSalesRoot', 'See payment methods') + '</article>';
  }

  /* ---------- "What stands out" ---------- */
  function facts() {
    const out = [], s = state.sales, t = state.top, l = state.low;
    if (s && s.statuses.length) {
      const k = s.kpis, days = s.range.days, grain = GRAIN[s.range.grain] || 'period';
      if (k.netSalesChangePct != null) {
        const up = k.netSalesChangePct >= 0;
        out.push({ tone: up ? 'good' : 'bad', jump: 'repSalesRoot', html: 'Net sales are <b>' + (up ? 'up ' : 'down ') + pct(Math.abs(k.netSalesChangePct)) + '%</b> compared with the previous ' + (days === 1 ? 'day' : days + ' days') + ', at ' + peso(k.netSales) + '.' });
      } else if (k.netSales > 0) {
        out.push({ tone: 'info', jump: 'repSalesRoot', html: 'Net sales are <b>' + peso(k.netSales) + '</b> from ' + int(k.transactions) + ' transaction' + (k.transactions === 1 ? '' : 's') + '. There were no sales in the previous period to compare with.' });
      }
      const best = s.trend.reduce((a, b) => (a == null || b.net > a.net ? b : a), null);
      if (best && best.net > 0 && s.trend.length > 1) out.push({ tone: 'info', jump: 'repSalesRoot', html: 'Strongest ' + grain + ': <b>' + esc(best.label) + '</b> with ' + peso(best.net) + ' from ' + int(best.count) + ' transaction' + (best.count === 1 ? '' : 's') + '.' });
      const pos = s.channels[0], on = s.channels[1];
      if (k.netSales > 0) { const lead = pos.net >= on.net ? pos : on; out.push({ tone: 'info', jump: 'repSalesRoot', html: '<b>' + (lead.channel === 'POS' ? 'The counter (POS)' : 'The online shop') + '</b> brings in ' + pct(Math.max(0, lead.net) / k.netSales * 100, 0) + '% of net sales.' }); }
      if (k.grossSales > 0 && k.refunds > 0) { const rr = k.refunds / k.grossSales * 100; out.push({ tone: rr >= 5 ? 'warn' : 'info', jump: 'repSalesTxnPanel', html: 'Refunds total <b>' + peso(k.refunds) + '</b>, ' + pct(rr) + '% of gross sales.' + (rr >= 5 ? ' Worth reviewing the reasons.' : '') }); }
      const o = s.outcome;
      if (o.cancelled.count > 0) out.push({ tone: o.cancellationRate >= 10 ? 'warn' : 'info', jump: 'repSalesRoot', html: '<b>' + int(o.cancelled.count) + '</b> sale' + (o.cancelled.count === 1 ? ' was' : 's were') + ' cancelled or voided (' + pct(o.cancellationRate) + '% of decided sales).' });
      if (pos.voidPending > 0) out.push({ tone: 'warn', jump: 'repSalesRoot', html: '<b>' + int(pos.voidPending) + '</b> POS sale' + (pos.voidPending === 1 ? ' is' : 's are') + ' waiting for a void decision. They still count as sales until the void is approved.' });
      if (s.customQuotes && s.customQuotes.received > 0) out.push({ tone: 'info', jump: 'repSalesRoot', html: '<b>' + peso(s.customQuotes.received) + '</b> in custom-quote down payments (' + int(s.customQuotes.quotes) + ' quotation' + (s.customQuotes.quotes === 1 ? '' : 's') + ') was received. It is not in net sales until the quotation becomes an order.' });
    } else if (s) {
      out.push({ tone: 'info', jump: 'repSalesRoot', html: 'No completed sales were recorded in this period. Try a wider Report Period.' });
    }
    if (t && t.rows.length) {
      const r = t.rows[0];
      out.push({ tone: 'good', jump: 'repTopRoot', html: '<b>' + esc(r.name) + '</b> is the top seller: ' + num(r.units) + ' sold for ' + peso(r.revenue) + ' (' + pct(r.sharePct) + '% of product revenue).' });
      const top3 = t.rows.slice(0, 3).reduce((a, x) => a + x.sharePct, 0);
      if (t.rows.length >= 3 && top3 >= 60) out.push({ tone: 'warn', jump: 'repTopRoot', html: 'The top 3 products make up <b>' + pct(top3, 0) + '%</b> of product revenue, so sales are concentrated in a few items.' });
    }
    if (l) {
      const m = l.summary;
      if (m.out > 0) out.push({ tone: 'bad', jump: 'repLowRoot', html: '<b>' + int(m.out) + '</b> product' + (m.out === 1 ? ' is' : 's are') + ' out of stock' + (m.low ? ' and <b>' + int(m.low) + '</b> more ' + (m.low === 1 ? 'is' : 'are') + ' low' : '') + '. Reaching reorder levels would cost about <b>' + peso(m.restockCost) + '</b>.' });
      else if (m.low > 0) out.push({ tone: 'warn', jump: 'repLowRoot', html: '<b>' + int(m.low) + '</b> product' + (m.low === 1 ? ' is' : 's are') + ' below the reorder level. Reaching it would cost about <b>' + peso(m.restockCost) + '</b>.' });
      else out.push({ tone: 'good', jump: 'repLowRoot', html: 'Every product with a reorder level is at or above it. Nothing needs restocking right now.' });
      if (m.watch > 0) out.push({ tone: 'info', jump: 'repLowRoot', html: '<b>' + int(m.watch) + '</b> product' + (m.watch === 1 ? ' is' : 's are') + ' within 20% of the reorder level and may need restocking soon.' });
    }
    const rank = { bad: 0, warn: 1, good: 2, info: 3 };
    return out.map((f, i) => [f, i]).sort((a, b) => (rank[a[0].tone] - rank[b[0].tone]) || (a[1] - b[1])).map((x) => x[0]).slice(0, 8);
  }
  const TAG = { bad: 'Action', warn: 'Watch', good: 'Good', info: 'Note' };
  function factsHtml() {
    const f = facts(); if (!f.length) return '';
    return '<section class="rep-facts" aria-labelledby="repFactsT"><h3 id="repFactsT">What stands out</h3><ul>' + f.map((x) =>
      '<li><button type="button" class="rep-fact ' + x.tone + '"' + (x.jump ? ' data-jump="' + x.jump + '"' : ' tabindex="-1"') + '><span class="rep-tag ' + x.tone + '">' + TAG[x.tone] + '</span><span class="rep-fact-text">' + x.html + '</span>' + (x.jump ? '<span class="rep-fact-go" aria-hidden="true">&rsaquo;</span>' : '') + '</button></li>').join('') + '</ul></section>';
  }

  /* ---------- draw ---------- */
  function render() {
    const host = $('repInsights'); if (!host) return;
    if (!state.loaded && state.loading) { host.innerHTML = '<div class="rep-hl-grid">' + '<article class="rep-hl"><div class="rep-skel"></div></article>'.repeat(4) + '</div>'; return; }
    if (!state.loaded) return;
    if (!state.sales && !state.top && !state.low) {
      const msg = state.err.sales || state.err.top || state.err.low || 'Could not load the highlights.';
      host.innerHTML = '<div class="panel rs-empty"><strong>Could not load the highlights</strong><p>' + esc(msg) + '</p><button type="button" class="btn-secondary" id="repHlRetry">Try again</button></div>'; return;
    }
    host.classList.toggle('is-busy', state.loading);
    host.innerHTML = '<div class="rep-hl-grid">' + salesCard() + bestCard() + attentionCard() + channelCard() + '</div>' + factsHtml();
  }

  /* ---------- the small live figures in the three section banners ---------- */
  const fig = (label, value, tone) => '<div class="rep-fig ' + (tone || '') + '"><span class="rep-fig-l">' + label + '</span><b class="rep-fig-v">' + value + '</b></div>';
  const txt = (id) => { const e = $(id); return e && e.textContent.trim() ? e.textContent.trim() : '\u2014'; };
  function paintBanners() {
    const s = state.sales, l = state.low, a = $('secSalesFigs'), b = $('secInventoryFigs'), c = $('secMovementsFigs');
    if (a) a.innerHTML = s ? fig('Net sales', peso(s.kpis.netSales)) + fig('Transactions', int(s.kpis.transactions)) + fig('Average sale', peso(s.kpis.avgSale)) : fig('Net sales', '\u2014');
    if (b) b.innerHTML = fig('Stock value now', txt('repStockValue')) + (l ? fig('Need restocking', int(l.summary.needAttention), l.summary.needAttention ? 'bad' : 'good') : '') + (l ? fig('Restock cost', peso(l.summary.restockCost)) : '');
    if (c) { const r = range(); c.innerHTML = fig('Entries in period', txt('repMovementsInPeriod')) + (r ? fig('Period', r.label ? esc(r.label) : esc(r.from + (r.from === r.to ? '' : ' to ' + r.to))) : ''); }
  }

  /* ---------- start ---------- */
  function init() {
    const page = $('reports'), host = $('repInsights'); if (!page || !host) return;
    host.addEventListener('click', (e) => { if (e.target.closest('#repHlRetry')) load(); });
    const active = () => page.classList.contains('active-page');
    const schedule = () => { clearTimeout(state.timer); state.timer = setTimeout(() => { if (active() || state.loaded) load(); }, 180); };
    window.addEventListener('tripleE:reportrange', schedule);
    // the stat cards at the top are filled by api-bridge.js: keep the banner figures in step with them
    if ('MutationObserver' in window) {
      const sync = () => paintBanners();
      ['repStockValue', 'repMovementsInPeriod'].forEach((id) => { const e = $(id); if (e) new MutationObserver(sync).observe(e, { childList: true, characterData: true, subtree: true }); });
      new MutationObserver(() => {
        if (!active()) return;
        if (!state.loaded && !state.loading) load();
        else if (Date.now() - state.at > 60000) load();   // coming back after a while: stock may have changed
      }).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    window.TripleEHighlights = { reload: load };
    if (active()) load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
