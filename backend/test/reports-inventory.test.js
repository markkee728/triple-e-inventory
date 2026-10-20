'use strict';
/* test/reports-inventory.test.js — Inventory Reports SQL (reports-core.js) against hand-worked sample records.
   Run:  node --no-warnings test/reports-inventory.test.js                                                          */
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const core = require('../reports-core');

const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE users (user_id INTEGER PRIMARY KEY, full_name TEXT);
CREATE TABLE products (product_id INTEGER PRIMARY KEY, sku TEXT, name TEXT, unit TEXT, department TEXT, unit_cost REAL DEFAULT 0);
CREATE TABLE stock_movements (movement_id INTEGER PRIMARY KEY, ref TEXT, product_id INT, movement_type TEXT, reason TEXT, quantity REAL, unit_cost REAL, note TEXT, handled_by INT, created_at TEXT);
CREATE TABLE production_records (production_id INTEGER PRIMARY KEY, product_sku TEXT, product_name TEXT, unit TEXT, quantity REAL, created_at TEXT);
CREATE TABLE production_items (item_id INTEGER PRIMARY KEY, production_id INT, material_sku TEXT, material_name TEXT, unit TEXT, calculated_qty REAL, actual_qty REAL);
CREATE TABLE pos_return_requests (return_id INTEGER PRIMARY KEY, sale_id INT, amount REAL, status TEXT, restock INT, created_at TEXT, decided_at TEXT);
CREATE TABLE order_refund_requests (request_id INTEGER PRIMARY KEY, order_id INT, amount REAL, status TEXT, restocked INT, created_at TEXT, decided_at TEXT);
`);
const ins = (t, o) => db.prepare(`INSERT INTO ${t} (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`).run(...Object.values(o));
ins('users', { user_id: 1, full_name: 'Maria Finance' });
ins('products', { product_id: 1, sku: 'RM-1', name: 'Steel sheet', unit: 'kg', department: 'Raw Materials', unit_cost: 10 });
ins('products', { product_id: 2, sku: 'FS-1', name: 'Paint', unit: 'L', department: 'Finishing Supplies', unit_cost: 5 });
ins('products', { product_id: 3, sku: 'FG-1', name: 'Gate', unit: 'pc', department: 'Finished Goods', unit_cost: 100 });
let n = 0;
const mv = (pid, type, reason, qty, cost, at, extra) => ins('stock_movements', { movement_id: ++n, ref: 'MV-' + (8000 + n), product_id: pid, movement_type: type, reason, quantity: qty, unit_cost: cost, handled_by: 1, created_at: at, ...(extra || {}) });
mv(1, 'in', 'supplier_receipt', 100, 10, '2026-10-10 02:00:00');                    // 1  +1000
mv(1, 'out', 'production_use', 40, 10, '2026-10-10 03:00:00');                      // 2  -400
mv(2, 'out', 'production_use', 20, 5, '2026-10-11 02:00:00');                       // 3  -100
mv(3, 'in', 'produced_batch', 10, 100, '2026-10-10 04:00:00');                      // 4  +1000
mv(3, 'out', 'sale', 3, 100, '2026-10-11 03:00:00');                                // 5  -300
mv(3, 'out', 'online_order', 2, 100, '2026-10-11 04:00:00');                        // 6  -200
mv(3, 'in', 'return', 1, 100, '2026-10-12 02:00:00');                               // 7  +100 POS return restocked
mv(1, 'out', 'damaged', 5, 10, '2026-10-11 05:00:00');                              // 8  -50
mv(1, 'in', 'count_correction_up', 2, 10, '2026-10-12 03:00:00');                   // 9  +20
mv(1, 'out', 'count_correction_down', 1, 10, '2026-10-12 04:00:00');                // 10 -10
mv(3, 'in', 'refund', 1, 100, '2026-10-12 05:00:00');                               // 11 +100 cancelled online order restocked
mv(1, 'in', 'supplier_receipt', 999, 10, '2026-10-01 02:00:00');                    // 12 outside the range
mv(1, 'out', 'lost_missing', 2, null, '2026-10-11 06:00:00');                       // 13 -20 (no cost on the movement: product cost 10 is used)
mv(1, 'in', 'supplier_receipt', 10, 10, '2026-10-09 17:00:00');                     // 14 = 01:00 on Oct 10 in Manila -> inside, +100
mv(1, 'in', 'supplier_receipt', 777, 10, '2026-10-12 17:00:00');                    // 15 = 01:00 on Oct 13 in Manila -> outside
ins('production_records', { production_id: 1, product_sku: 'FG-1', product_name: 'Gate', unit: 'pc', quantity: 10, created_at: '2026-10-10 04:00:00' });
ins('production_items', { item_id: 1, production_id: 1, material_sku: 'RM-1', material_name: 'Steel sheet', unit: 'kg', calculated_qty: 40, actual_qty: 40 });
ins('production_items', { item_id: 2, production_id: 1, material_sku: 'FS-1', material_name: 'Paint', unit: 'L', calculated_qty: 18, actual_qty: 20 });
ins('pos_return_requests', { return_id: 1, sale_id: 1, amount: 200, status: 'approved', restock: 1, created_at: '2026-10-12 01:00:00', decided_at: '2026-10-12 02:00:00' });
ins('pos_return_requests', { return_id: 2, sale_id: 1, amount: 500, status: 'pending', restock: null, created_at: '2026-10-12 01:00:00' });
ins('order_refund_requests', { request_id: 1, order_id: 1, amount: 300, status: 'approved', restocked: 1, created_at: '2026-10-12 03:00:00', decided_at: '2026-10-12 05:00:00' });

const q = async (sql, params) => db.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...(params || []));
let passed = 0; const ok = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const R = { from: '2026-10-10', to: '2026-10-12' };

(async () => {
  const r = await core.inventoryReport(q, core.LITE, { ...R, pageSize: 10 });
  console.log('Inventory report, 10-12 Oct 2026 (Asia/Manila)');
  const g = (name, type) => (r.groups.find((x) => x.group === name && x.type === type) || {}).value;
  ok('Totals at cost: stock in 2320, stock out 1080, 13 movements (Manila day edges respected, out-of-range rows ignored)', () => assert.deepEqual([r.totals.inValue, r.totals.outValue, r.totals.movements], [2320, 1080, 13]));
  ok('Supplier receipts in = 1100 (incl. the 01:00 Manila-time one on Oct 10)', () => assert.equal(g('Supplier receipts', 'in'), 1100));
  ok('Finished goods produced = 1000; returns and restocking = 200 (POS return 100 + cancelled-order restock 100)', () => assert.deepEqual([g('Finished goods produced', 'in'), g('Returns and restocking', 'in')], [1000, 200]));
  ok('Stock adjustments: +20 up, -10 down, kept apart', () => assert.deepEqual([g('Stock adjustments', 'in'), g('Stock adjustments', 'out')], [20, 10]));
  ok('Sales out 500, material consumption out 500, losses and write-offs out 70 (damaged 50 + lost 20 using the product cost)', () => assert.deepEqual([g('Sales', 'out'), g('Material consumption', 'out'), g('Losses and write-offs', 'out')], [500, 500, 70]));
  ok('Nothing falls into "Other" (every reason in the ledger is classified)', () => assert.equal(r.groups.some((x) => x.group === 'Other'), false));
  ok('By department: Raw in 1120 / out 480, Finishing out 100, Finished Goods in 1200 / out 500', () => {
    const d = Object.fromEntries(r.departments.map((x) => [x.department, x]));
    assert.deepEqual([d['Raw Materials'].inValue, d['Raw Materials'].outValue, d['Finishing Supplies'].outValue, d['Finished Goods'].inValue, d['Finished Goods'].outValue], [1120, 480, 100, 1200, 500]); });
  ok('Daily trend adds up to the totals (in 2320, out 1080)', () => assert.deepEqual([r.trend.reduce((a, b) => a + b.in, 0), r.trend.reduce((a, b) => a + b.out, 0)], [2320, 1080]));
  ok('Trend by Manila day: Oct 10 in 2100 / out 400; Oct 11 out 670; Oct 12 in 220 / out 10', () => {
    const t = Object.fromEntries(r.trend.map((x) => [x.key, x])); assert.deepEqual([t['2026-10-10'].in, t['2026-10-10'].out, t['2026-10-11'].out, t['2026-10-12'].in, t['2026-10-12'].out], [2100, 400, 670, 220, 10]); });
  ok('Material consumption: Steel 40 kg = 400, Paint 20 L = 100 (largest value first)', () => assert.deepEqual(r.consumption.map((x) => [x.sku, x.qty, x.value]), [['RM-1', 40, 400], ['FS-1', 20, 100]]));
  ok('Finished goods production: 1 batch, 10 units of FG-1', () => assert.deepEqual([r.production.batches, r.production.units, r.production.products[0].sku], [1, 10, 'FG-1']));
  ok('Planned vs actual material use: steel on plan, paint +2 L over', () => assert.deepEqual(r.materialUsage.map((x) => [x.sku, x.planned, x.actual, x.variance]), [['FS-1', 18, 20, 2], ['RM-1', 40, 40, 0]]));
  ok('Returns: POS 1 approved (200, restocked), online refund 1 approved (300, restocked); pending ignored', () => assert.deepEqual(r.returns.map((x) => [x.source, x.count, x.amount, x.restocked]), [['POS return', 1, 200, 1], ['Online refund', 1, 300, 1]]));
  ok('Movement list is paged: 13 rows = 2 pages of 10, newest first', () => assert.deepEqual([r.movements.total, r.movements.pages, r.movements.rows.length, r.movements.rows[0].ref], [13, 2, 10, 'MV-8011']));
  const all = await core.inventoryReport(q, core.LITE, { ...R, pageSize: 200 });
  ok('Movement row value = qty x cost (lost/missing 2 x product cost 10 = 20)', () => assert.equal(all.movements.rows.find((x) => x.reason === 'lost_missing').value, 20));
  const out = await core.inventoryReport(q, core.LITE, { ...R, type: 'out', pageSize: 200 });
  ok('Filter stock out: 7 movements', () => assert.equal(out.movements.total, 7));
  const adj = await core.inventoryReport(q, core.LITE, { ...R, group: 'Stock adjustments', pageSize: 200 });
  ok('Filter "Stock adjustments": the 2 count corrections', () => assert.deepEqual(adj.movements.rows.map((x) => x.reason).sort(), ['count_correction_down', 'count_correction_up']));
  const fg = await core.inventoryReport(q, core.LITE, { ...R, dept: 'Finished Goods', pageSize: 200 });
  ok('Filter department Finished Goods: 5 movements', () => assert.equal(fg.movements.total, 5));
  const s = await core.inventoryReport(q, core.LITE, { ...R, q: 'rm-1', pageSize: 200 });
  ok('Search by SKU: the 7 Steel movements in range', () => assert.equal(s.movements.total, 7));
  const pct = await core.inventoryReport(q, core.LITE, { ...R, q: '%', pageSize: 200 });
  ok('Search text "%" is taken literally (no match), not as a wildcard', () => assert.equal(pct.movements.total, 0));
  const ref = await core.inventoryReport(q, core.LITE, { ...R, q: 'mv-8005', pageSize: 200 });
  ok('Search by movement reference', () => assert.deepEqual(ref.movements.rows.map((x) => x.ref), ['MV-8005']));
  console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}`);
})();
