// check-payments.js — READ-ONLY check of why "Payment summary" / "Cash shifts" look empty.
// Run from the backend folder:   node check-payments.js
// It only runs SELECT statements. Nothing is changed in your database.
require('dotenv').config();
const { Pool } = require('pg');

const TZ = 'Asia/Manila';
const pool = new Pool(require('./db-config')());

const notes = [];
const line = (t = '') => console.log(t);
const head = (t) => { line(); line('=== ' + t + ' ==='); };
async function step(title, fn) {
  head(title);
  try { return await fn(); }
  catch (e) { line('  FAILED: ' + e.message); notes.push(title + ' -> ' + e.message); return null; }
}
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const show = (rows, empty) => { if (!rows.length) line('  ' + (empty || '(no rows)')); else console.table(rows); };

(async () => {
  const today = (await q("SELECT (now() AT TIME ZONE $1)::date::text AS d", [TZ]))[0].d;
  const monthStart = today.slice(0, 8) + '01';

  await step('1. Which database is this?', async () => {
    const r = (await q('SELECT current_database() AS db, now() AS server_time'))[0];
    line('  database: ' + r.db + '   |   today in Manila: ' + today);
    line('  (if this is NOT the database your website uses, that is the problem)');
  });

  await step('2. Do the needed tables and columns exist?', async () => {
    const want = [['pos_sales', 'cash_shift_id'], ['pos_sales', 'status'], ['pos_sales', 'method'], ['pos_sales', 'total'],
      ['pos_cash_shifts', 'closing_breakdown'], ['pos_cash_shifts', 'opened_at'], ['pos_cash_movements', 'kind'],
      ['orders', 'payment_method'], ['orders', 'status'], ['orders', 'total'], ['order_refund_requests', 'amount']];
    const have = new Set((await q("SELECT table_name||'.'||column_name AS c FROM information_schema.columns WHERE table_schema='public'")).map((r) => r.c));
    show(want.map(([t, c]) => ({ table_column: t + '.' + c, exists: have.has(t + '.' + c) ? 'yes' : 'MISSING' })));
    want.filter(([t, c]) => !have.has(t + '.' + c)).forEach(([t, c]) => notes.push('Missing ' + t + '.' + c + ' (start the backend once with the new cash-shifts.js so it creates it)'));
  });

  await step('3. POS sales in the database (all time)', async () => {
    const rows = await q(`SELECT method, status, COUNT(*)::int AS sales, COALESCE(SUM(total),0)::float8 AS total,
        MIN((created_at AT TIME ZONE $1)::date)::text AS first_day, MAX((created_at AT TIME ZONE $1)::date)::text AS last_day
      FROM pos_sales GROUP BY method, status ORDER BY method, status`, [TZ]);
    show(rows, 'pos_sales is EMPTY — no walk-in sale has been saved yet, so POS numbers will be zero.');
    if (!rows.length) notes.push('pos_sales has no rows: make a sale in the POS first.');
  });

  await step('4. Online orders in the database (all time)', async () => {
    const rows = await q(`SELECT payment_method AS method, status, COUNT(*)::int AS orders, COALESCE(SUM(total),0)::float8 AS total,
        MIN((created_at AT TIME ZONE $1)::date)::text AS first_day, MAX((created_at AT TIME ZONE $1)::date)::text AS last_day
      FROM orders GROUP BY payment_method, status ORDER BY payment_method, status`, [TZ]);
    show(rows, 'orders is EMPTY — no online order has been placed yet.');
    const pend = rows.filter((r) => r.status === 'Pending Confirmation').reduce((n, r) => n + r.orders, 0);
    if (pend) notes.push(pend + ' online order(s) are still "Pending Confirmation": they show as "Awaiting", not "Collected", until Finance clicks Confirm payment.');
  });

  await step('5. Cash shifts (all time)', async () => {
    const rows = await q(`SELECT shift_id, cashier_name, (opened_at AT TIME ZONE $1)::text AS opened, (closed_at AT TIME ZONE $1)::text AS closed, opening_cash::float8 AS opening, closing_cash::float8 AS closing
      FROM pos_cash_shifts ORDER BY opened_at DESC LIMIT 15`, [TZ]);
    show(rows, 'pos_cash_shifts is EMPTY — no cashier has opened a shift, so the Cash Shifts table has nothing to list.');
    if (!rows.length) notes.push('No cash shift has ever been opened. In the POS, open the "Cash Shift" page and press Open Cash Shift.');
  });

  await step('6. POS sales NOT attached to any shift', async () => {
    const r = (await q(`SELECT COUNT(*) FILTER (WHERE cash_shift_id IS NULL)::int AS no_shift, COUNT(*)::int AS all_sales FROM pos_sales`))[0];
    line('  sales without a shift: ' + r.no_shift + ' of ' + r.all_sales);
    if (r.no_shift) notes.push(r.no_shift + ' POS sale(s) were made without an open shift. They still count in Payment Summary but never in Cash Shifts totals.');
  });

  // ---- the exact queries the Payment Summary panel runs (this month, then all time) ----
  const posSql = `SELECT method, COUNT(*) FILTER (WHERE status<>'Voided')::int AS count,
      COALESCE(SUM(total) FILTER (WHERE status<>'Voided'),0)::float8 AS total,
      COUNT(*) FILTER (WHERE status='Voided')::int AS voided
    FROM pos_sales WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date GROUP BY method ORDER BY method`;
  const onSql = `SELECT o.payment_method AS method,
      COUNT(*) FILTER (WHERE o.status NOT IN ('Pending Confirmation','Cancelled'))::int AS paid_orders,
      COALESCE(SUM(o.total) FILTER (WHERE o.status NOT IN ('Pending Confirmation','Cancelled')),0)::float8 AS collected,
      COUNT(*) FILTER (WHERE o.status='Pending Confirmation')::int AS awaiting_count,
      COUNT(*) FILTER (WHERE o.status='Cancelled')::int AS cancelled
    FROM orders o WHERE (o.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date GROUP BY o.payment_method ORDER BY o.payment_method`;
  for (const [label, f, t] of [['this month (' + monthStart + ' to ' + today + ')', monthStart, today], ['ALL TIME', '2000-01-01', '2100-01-01']]) {
    await step('7. Payment Summary query — POS, ' + label, async () => show(await q(posSql, [TZ, f, t]), 'No POS rows in this range.'));
    await step('8. Payment Summary query — online, ' + label, async () => show(await q(onSql, [TZ, f, t]), 'No online rows in this range.'));
  }

  await step('9. Refund table readable?', async () => {
    const r = (await q('SELECT COUNT(*)::int AS n FROM order_refund_requests'))[0];
    line('  refund requests: ' + r.n);
  });

  head('WHAT TO DO');
  if (!notes.length) line('  Every query ran and the data is there. If the page is still empty, open the page, press F12 > Network,\n  press Refresh, click the request called "report" and send me its Status and Response.');
  else notes.forEach((n, i) => line('  ' + (i + 1) + '. ' + n));
  await pool.end();
})().catch(async (e) => { console.error('Could not connect: ' + e.message + '\nCheck DATABASE_URL in backend/.env'); try { await pool.end(); } catch (_) {} process.exit(1); });
