'use strict';
/* reports.js — Finance Reports API (step 1: Sales Overview).
   Every figure is computed in SQL by reports-core.js; this file only checks who is asking, validates the dates,
   runs the migration, and sends the result (JSON or CSV). Financial reports are for the Finance-Admin role only.

   Mounted from server.js:   require('./reports')({ app, pool, auth, wrap, TZ });                                   */
const fs = require('fs');
const path = require('path');
const core = require('./reports-core');

module.exports = function mountReports({ app, pool, auth, wrap }) {
  const q = async (sql, params) => (await pool.query(sql, params || [])).rows;
  const opts = { hasLedger: true, hasPaidAt: true };

  // Runs db/021_reporting.sql (idempotent), then checks which optional pieces exist so the queries never reference a missing one.
  const ready = (async () => {
    try { await pool.query(fs.readFileSync(path.join(__dirname, 'db', '021_reporting.sql'), 'utf8')); }
    catch (err) { console.warn('[reports] could not run 021_reporting.sql:', err.message); }
    try {
      const has = async (sql) => (await pool.query(sql)).rows.length > 0;
      opts.hasPaidAt = await has(`SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'paid_at'`);
      opts.hasLedger = await has(`SELECT 1 FROM information_schema.tables WHERE table_name = 'payments'`);
    } catch (err) { console.warn('[reports] schema check failed:', err.message); }
  })();

  // Reads from, to and grain from the query string. Returns null (and answers 400) when something is wrong.
  function range(req, res) {
    const r = core.checkRange(req.query.from, req.query.to);
    if (r.error) { res.status(400).json({ error: r.error }); return null; }
    const grain = ['day', 'week', 'month', 'year'].includes(req.query.grain) ? req.query.grain : undefined;
    return { from: r.from, to: r.to, grain, channel: req.query.channel, sort: req.query.sort, limit: req.query.limit };
  }

  app.get('/api/reports/sales-overview', auth('finance'), wrap(async (req, res) => {
    const p = range(req, res); if (!p) return;
    await ready;
    res.set('Cache-Control', 'no-store');
    res.json(await core.salesOverview(q, core.PG, p, opts));
  }));

  app.get('/api/reports/top-products', auth('finance'), wrap(async (req, res) => {
    const p = range(req, res); if (!p) return;
    await ready;
    res.set('Cache-Control', 'no-store');
    res.json(await core.topProducts(q, core.PG, p, opts));
  }));

  /* ---------- CSV export ---------- */
  // Text cells that start with = + - @ could run as a formula in Excel, so they get a leading apostrophe.
  const cell = (v) => {
    if (typeof v === 'number') return String(v);
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const line = (...c) => c.map(cell).join(',');

  app.get('/api/reports/sales-overview.csv', auth('finance'), wrap(async (req, res) => {
    const p = range(req, res); if (!p) return;
    await ready;
    const d = await core.salesOverview(q, core.PG, p, opts);
    const out = [
      line('Triple E - Sales Overview'), line('Period (Philippine time)', d.range.from, 'to', d.range.to), '',
      line('Summary'), line('Gross sales', d.kpis.grossSales), line('Refunds', d.kpis.refunds), line('Net sales', d.kpis.netSales),
      line('Completed transactions', d.kpis.transactions), line('Average sale', d.kpis.avgSale), line('Delivery fees (included)', d.kpis.deliveryFees),
      line('Previous period net sales', d.kpis.previousNetSales), '',
      line('Channel', 'Transactions', 'Gross', 'Refunds', 'Net'),
      ...d.channels.map((c) => line(c.channel, c.count, c.gross, c.refunds, c.net)), '',
      line('Payment method', 'Channel', 'Transactions', 'Gross', 'Refunds', 'Net'),
      ...d.methods.map((m) => line(m.method, m.channel, m.count, m.gross, m.refunds, m.net)), '',
      line('Status', 'Channel', 'Transactions', 'Amount'),
      ...d.statuses.map((s) => line(s.label, s.channel, s.count, s.amount)), '',
      line('Period', 'Transactions', 'POS net', 'Online net', 'Total net'),
      ...d.trend.map((b) => line(b.label, b.count, b.pos, b.online, b.net))
    ];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="sales-overview_${d.range.from}_to_${d.range.to}.csv"` });
    res.send('\uFEFF' + out.join('\r\n') + '\r\n');
  }));

  app.get('/api/reports/top-products.csv', auth('finance'), wrap(async (req, res) => {
    const p = range(req, res); if (!p) return;
    p.limit = 200;
    await ready;
    const d = await core.topProducts(q, core.PG, p, opts);
    const out = [
      line('Triple E - Top-Selling Products'), line('Period (Philippine time)', d.range.from, 'to', d.range.to),
      line('Channel', d.channel === 'all' ? 'POS + Online' : d.channel === 'pos' ? 'POS only' : 'Online only'), line('Ranked by', d.sort === 'units' ? 'Units sold' : 'Revenue'), '',
      line('Rank', 'SKU', 'Product', 'Unit', 'Units sold', 'Revenue', 'Share of revenue %', 'Avg price', 'POS units', 'POS revenue', 'Online units', 'Online revenue', 'Transactions', 'Estimated profit'),
      ...d.rows.map((r) => line(r.rank, r.sku, r.name, r.unit, r.units, r.revenue, r.sharePct, r.avgPrice, r.posUnits, r.posRevenue, r.onlineUnits, r.onlineRevenue, r.transactions, r.estProfit == null ? '' : r.estProfit)),
      line('Total', '', '', '', d.totals.units, d.totals.revenue)
    ];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="top-products_${d.range.from}_to_${d.range.to}.csv"` });
    res.send('\uFEFF' + out.join('\r\n') + '\r\n');
  }));
};