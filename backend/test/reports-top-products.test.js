'use strict';
/* test/reports-top-products.test.js — Top-Selling Products SQL (reports-core.js) against hand-worked sample records.
   Run:  node --no-warnings test/reports-top-products.test.js                                                          */
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const core = require('../reports-core');

const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE products (product_id INTEGER PRIMARY KEY, sku TEXT, department TEXT, unit_cost REAL DEFAULT 0);
CREATE TABLE pos_sales (sale_id INTEGER PRIMARY KEY, receipt_no TEXT, status TEXT, method TEXT, total REAL, delivery_fee REAL DEFAULT 0, cash_shift_id INT, created_at TEXT);
CREATE TABLE pos_sale_items (item_id INTEGER PRIMARY KEY, sale_id INT, sku TEXT, name TEXT, unit TEXT, qty REAL, price REAL);
CREATE TABLE pos_return_requests (return_id INTEGER PRIMARY KEY, sale_id INT, amount REAL, status TEXT, refund_method TEXT, refund_shift_id INT, restock INT, created_at TEXT, decided_at TEXT);
CREATE TABLE pos_return_items (return_item_id INTEGER PRIMARY KEY, return_id INT, sale_item_id INT, qty REAL, amount REAL);
CREATE TABLE orders (order_id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, payment_method TEXT, payment_status TEXT, total REAL, delivery_fee REAL DEFAULT 0, paid_amount REAL DEFAULT 0, paid_at TEXT, created_at TEXT, cash_shift_id INT);
CREATE TABLE order_items (item_id INTEGER PRIMARY KEY, order_id INT, sku TEXT, name TEXT, unit TEXT, qty REAL, price REAL);
CREATE TABLE order_refund_requests (request_id INTEGER PRIMARY KEY, order_id INT, amount REAL, status TEXT, restocked INT, created_at TEXT, decided_at TEXT);
CREATE TABLE payments (payment_id INTEGER PRIMARY KEY, paid_for TEXT, order_id INT, quote_id INT, direction TEXT, amount REAL, method TEXT, purpose TEXT, request_id TEXT, cash_shift_id INT, created_at TEXT);
CREATE TABLE quote_requests (quote_id INTEGER PRIMARY KEY, quote_no TEXT, converted_order_id INT, handover_sale_id INT, created_at TEXT);
`);
const ins = (t, o) => db.prepare(`INSERT INTO ${t} (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`).run(...Object.values(o));
for (const [sku, cost] of [['A', 100], ['B', 0], ['C', 0], ['D', 0]]) ins('products', { sku, department: 'Finished Goods', unit_cost: cost });
const item = (t, id, parent, sku, qty, price) => ins(t, { item_id: id, [t === 'pos_sale_items' ? 'sale_id' : 'order_id']: parent, sku, name: 'Product ' + sku, unit: 'pc', qty, price });

// POS
ins('pos_sales', { sale_id: 1, receipt_no: 'R1', status: 'Completed', method: 'Cash', total: 1000, created_at: '2026-10-10 02:00:00' });
item('pos_sale_items', 1, 1, 'A', 2, 300); item('pos_sale_items', 2, 1, 'B', 1, 400);
ins('pos_sales', { sale_id: 2, receipt_no: 'R2', status: 'Completed', method: 'Card', total: 500, created_at: '2026-10-10 03:00:00' });
item('pos_sale_items', 3, 2, 'A', 1, 300); item('pos_sale_items', 4, 2, 'C', 1, 200);
ins('pos_return_requests', { return_id: 1, sale_id: 2, amount: 200, status: 'approved', created_at: '2026-10-10 05:00:00' });
ins('pos_return_items', { return_id: 1, sale_item_id: 4, qty: 1, amount: 200 });                       // product C fully returned
ins('pos_return_requests', { return_id: 2, sale_id: 1, amount: 400, status: 'rejected', created_at: '2026-10-10 06:00:00' });
ins('pos_return_items', { return_id: 2, sale_item_id: 2, qty: 1, amount: 400 });                       // rejected: ignored
ins('pos_sales', { sale_id: 3, receipt_no: 'R3', status: 'Voided', method: 'Cash', total: 1500, created_at: '2026-10-11 02:00:00' });
item('pos_sale_items', 5, 3, 'A', 5, 300);                                                              // voided: ignored
// Online
ins('orders', { order_id: 1, order_no: 'O1', status: 'Delivered', payment_method: 'Xendit', payment_status: 'paid', total: 2000, paid_at: '2026-10-11 01:00:00', created_at: '2026-10-09 01:00:00' });
ins('payments', { payment_id: 1, paid_for: 'order', order_id: 1, direction: 'in', amount: 2000, method: 'Xendit', purpose: 'initial', created_at: '2026-10-11 01:00:00' });
item('order_items', 1, 1, 'B', 4, 400); item('order_items', 2, 1, 'C', 2, 200);
ins('orders', { order_id: 2, order_no: 'O2', status: 'Delivered', payment_method: 'Cash on Delivery', payment_status: 'unpaid', total: 3000, created_at: '2026-10-10 01:00:00' });
item('order_items', 3, 2, 'A', 10, 300);                                                                // unpaid: ignored
ins('orders', { order_id: 5, order_no: 'O5', status: 'Delivered', payment_method: 'Xendit', payment_status: 'paid', total: 1200, paid_at: '2026-10-10 04:00:00', created_at: '2026-10-10 03:00:00' });
ins('order_refund_requests', { request_id: 1, order_id: 5, amount: 1200, status: 'approved', created_at: '2026-10-10 08:00:00' });
item('order_items', 4, 5, 'B', 3, 400);                                                                 // fully refunded: 0 units, 0 revenue
ins('orders', { order_id: 7, order_no: 'O7', status: 'Delivered', payment_method: 'Xendit', payment_status: 'paid', total: 1000, paid_at: '2026-10-12 02:00:00', created_at: '2026-10-12 01:00:00' });
ins('order_refund_requests', { request_id: 2, order_id: 7, amount: 250, status: 'approved', created_at: '2026-10-12 05:00:00' });
item('order_items', 5, 7, 'D', 2, 500);                                                                 // 25% refunded: 2 units, 750

const q = async (sql, params) => db.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...(params || []));
let passed = 0; const ok = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const P = { from: '2026-10-10', to: '2026-10-12' };

(async () => {
  const t = await core.topProducts(q, core.LITE, P);
  console.log('Top-Selling Products, 10-12 Oct 2026');
  const by = Object.fromEntries(t.rows.map((r) => [r.sku, r]));
  ok('Ranking by revenue: B 2000, A 900, D 750, C 400', () => assert.deepEqual(t.rows.map((r) => [r.rank, r.sku, r.revenue]), [[1, 'B', 2000], [2, 'A', 900], [3, 'D', 750], [4, 'C', 400]]));
  ok('Units: B 5 (1 POS + 4 online), A 3, D 2, C 2', () => assert.deepEqual(['B', 'A', 'D', 'C'].map((k) => by[k].units), [5, 3, 2, 2]));
  ok('B is combined across channels: 1 POS + 4 online, one row, not two', () => assert.deepEqual([by.B.posUnits, by.B.onlineUnits, by.B.posRevenue, by.B.onlineRevenue], [1, 4, 400, 1600]));
  ok('Voided POS sale, unpaid online order and rejected return do not change anything', () => assert.deepEqual([by.A.units, by.A.revenue], [3, 900]));
  ok('POS return removes the returned units (C: POS 0, only online 2 remain)', () => assert.deepEqual([by.C.posUnits, by.C.onlineUnits], [0, 2]));
  ok('Fully refunded online order contributes 0 units and 0 revenue (B)', () => assert.equal(by.B.onlineUnits, 4));
  ok('Partly refunded order keeps its units, revenue reduced by the refund share (D 1000 -> 750)', () => assert.deepEqual([by.D.units, by.D.revenue], [2, 750]));
  ok('Totals: 4 products, revenue 4050, 12 units, shares sum to ~100%', () => { assert.deepEqual([t.totals.products, t.totals.revenue, t.totals.units], [4, 4050, 12]); assert.ok(Math.abs(t.rows.reduce((n, r) => n + r.sharePct, 0) - 100) < 0.1); });
  const o = await core.salesOverview(q, core.LITE, P);
  ok('Product revenue total equals Sales Overview net sales (4050): the two reports never double count', () => assert.equal(o.kpis.netSales, t.totals.revenue));
  ok('Estimated profit only where a cost is recorded (A: 900 - 3 x 100 = 600; B has no cost -> null)', () => assert.deepEqual([by.A.estProfit, by.B.estProfit], [600, null]));
  const u = await core.topProducts(q, core.LITE, { ...P, sort: 'units' });
  ok('Sort by units: B, A, then D before C on the revenue tie-break', () => assert.deepEqual(u.rows.map((r) => r.sku), ['B', 'A', 'D', 'C']));
  const pos = await core.topProducts(q, core.LITE, { ...P, channel: 'pos' });
  ok('POS only: A 3 / 900 and B 1 / 400 (C fully returned is dropped)', () => assert.deepEqual(pos.rows.map((r) => [r.sku, r.units, r.revenue]), [['B', 1, 400], ['A', 3, 900]].sort((a, b) => b[2] - a[2])));
  const on = await core.topProducts(q, core.LITE, { ...P, channel: 'online' });
  ok('Online only: B 4 / 1600, D 2 / 750, C 2 / 400', () => assert.deepEqual(on.rows.map((r) => [r.sku, r.units, r.revenue]), [['B', 4, 1600], ['D', 2, 750], ['C', 2, 400]]));
  const one = await core.topProducts(q, core.LITE, { from: '2026-10-12', to: '2026-10-12' });
  ok('Date filter (Manila): 12 Oct only -> online D (paid 12 Oct)', () => assert.deepEqual(one.rows.map((r) => r.sku), ['D']));
  const lim = await core.topProducts(q, core.LITE, { ...P, limit: 2 });
  ok('Limit 2 returns 2 rows, flags truncated, totals still cover all products', () => assert.deepEqual([lim.rows.length, lim.truncated, lim.totals.products], [2, true, 4]));
  console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}`);
})();
