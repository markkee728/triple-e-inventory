'use strict';
/* test/reports-low-stock.test.js — Low-Stock report SQL (reports-core.js) against hand-worked sample records.
   Run:  node --no-warnings test/reports-low-stock.test.js
   Also proves the report is READ-ONLY: it never writes to low_stock_alerts (so it cannot create notifications). */
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const core = require('../reports-core');

const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE categories (category_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE suppliers (supplier_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE products (product_id INTEGER PRIMARY KEY, sku TEXT, name TEXT, department TEXT, category_id INT, unit TEXT, on_hand REAL, reorder_level REAL, unit_cost REAL DEFAULT 0, location TEXT, is_archived INT DEFAULT 0);
CREATE TABLE product_suppliers (product_id INT, supplier_id INT, is_primary INT);
CREATE TABLE stock_movements (movement_id INTEGER PRIMARY KEY, product_id INT, movement_type TEXT, reason TEXT, quantity REAL, created_at TEXT);
CREATE TABLE low_stock_alerts (product_id INTEGER PRIMARY KEY, alerted_at TEXT, on_hand REAL);
`);
const ins = (t, o) => db.prepare(`INSERT INTO ${t} (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`).run(...Object.values(o));
ins('categories', { category_id: 1, name: 'Steel' }); ins('suppliers', { supplier_id: 1, name: 'Acme Steel' });
const P = (id, sku, dept, on, lvl, cost, extra) => ins('products', { product_id: id, sku, name: 'Item ' + sku, department: dept, category_id: 1, unit: 'pc', on_hand: on, reorder_level: lvl, unit_cost: cost, ...(extra || {}) });
P(1, 'RM-1', 'Raw Materials', 0, 10, 5);          // out        shortage 10  cost 50
P(2, 'RM-2', 'Raw Materials', 5, 10, 20);         // low        shortage 5   cost 100
P(3, 'RM-3', 'Raw Materials', 10, 10, 0);         // low (exactly at level)  shortage 0
P(4, 'FS-1', 'Finishing Supplies', 11, 10, 3);    // watch (within 20% above)
P(5, 'FS-2', 'Finishing Supplies', 50, 10, 3);    // ok
P(6, 'FG-1', 'Finished Goods', 3, 0, 80);         // no reorder level set
P(7, 'FG-2', 'Finished Goods', 2, 5, 80, { is_archived: 1 });   // archived: never reported
P(8, 'FG-3', 'Finished Goods', 4, 8, 100);        // low        shortage 4   cost 400
ins('product_suppliers', { product_id: 2, supplier_id: 1, is_primary: 1 });
ins('stock_movements', { movement_id: 1, product_id: 2, movement_type: 'out', reason: 'production_use', quantity: 30, created_at: '2026-10-01 00:00:00' });  // inside 30 days
ins('stock_movements', { movement_id: 2, product_id: 2, movement_type: 'out', reason: 'production_use', quantity: 100, created_at: '2026-08-01 00:00:00' }); // too old
ins('stock_movements', { movement_id: 3, product_id: 2, movement_type: 'in', reason: 'supplier_receipt', quantity: 40, created_at: '2026-09-25 00:00:00' }); // 'in' is not usage
ins('low_stock_alerts', { product_id: 1, alerted_at: '2026-10-15 00:00:00', on_hand: 0 });
ins('low_stock_alerts', { product_id: 2, alerted_at: '2026-10-15 00:00:00', on_hand: 5 });

const q = async (sql, params) => db.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...(params || []));
const alertsBefore = JSON.stringify(db.prepare('SELECT * FROM low_stock_alerts ORDER BY product_id').all());
const O = { hasAlerts: true }, S = { since: '2026-09-20 00:00:00' };
let passed = 0; const ok = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

(async () => {
  const r = await core.lowStock(q, core.LITE, { ...S }, O);
  console.log('Low-Stock report');
  ok('Default view = needs attention (out + low): RM-1, RM-2, FG-3, RM-3, most urgent first', () => assert.deepEqual(r.rows.map((x) => x.sku), ['RM-1', 'RM-2', 'FG-3', 'RM-3']));
  ok('Archived product is never listed or counted (7 active products)', () => assert.equal(r.summary.total, 7));
  ok('Summary: 1 out, 3 low, 1 watch, 1 ok, 1 no reorder level, 4 need attention', () => assert.deepEqual([r.summary.out, r.summary.low, r.summary.watch, r.summary.ok, r.summary.no_level, r.summary.needAttention], [1, 3, 1, 1, 1, 4]));
  ok('Same rule as the alert email: need-attention = on_hand <= reorder_level with a level set', () => {
    const rule = db.prepare('SELECT COUNT(*) n FROM products WHERE NOT is_archived AND reorder_level > 0 AND on_hand <= reorder_level').get().n; assert.equal(r.summary.needAttention, rule); });
  ok('Shortage = reorder level - on hand (RM-1 10, RM-2 5, FG-3 4, RM-3 0 because it sits exactly at its level)', () => assert.deepEqual(r.rows.map((x) => x.shortage), [10, 5, 4, 0]));
  ok('Statuses: out / low / low / low', () => assert.deepEqual(r.rows.map((x) => x.status), ['out', 'low', 'low', 'low']));
  ok('Restock cost = shortage x unit cost: 50 + 100 + 400 + 0 = 550', () => assert.equal(r.summary.restockCost, 550));
  ok('Department split: Raw Materials 1 out + 2 low, Finished Goods 1 low + 1 no level', () => {
    const d = Object.fromEntries(r.summary.byDepartment.map((x) => [x.department, x]));
    assert.deepEqual([d['Raw Materials'].out, d['Raw Materials'].low, d['Finished Goods'].low, d['Finished Goods'].no_level, d['Finishing Supplies'].watch], [1, 2, 1, 1, 1]); });
  ok('Usage over 30 days counts only stock OUT inside the window (RM-2 = 30, so 1/day -> 5 days of cover)', () => {
    const x = r.rows.find((y) => y.sku === 'RM-2'); assert.deepEqual([x.usedLast30Days, x.daysOfCover, x.supplier, x.coveragePct], [30, 5, 'Acme Steel', 50]); });
  ok('"Notified" shows what the Notification Center already knows (RM-1, RM-2 yes; FG-3 not yet)', () => assert.deepEqual(r.rows.map((x) => x.notified), [true, true, false, false]));
  const raw = await core.lowStock(q, core.LITE, { ...S, dept: 'Raw Materials', status: 'all' }, O);
  ok('Department filter + all statuses: only the 3 Raw Materials', () => assert.deepEqual(raw.rows.map((x) => x.sku).sort(), ['RM-1', 'RM-2', 'RM-3']));
  ok('Summary cards ignore the table filters (still describe the whole catalogue)', () => assert.equal(raw.summary.total, 7));
  const w = await core.lowStock(q, core.LITE, { ...S, status: 'watch' }, O);
  ok('Status filter "watch": FS-1 only (11 on hand vs level 10)', () => assert.deepEqual(w.rows.map((x) => x.sku), ['FS-1']));
  const nl = await core.lowStock(q, core.LITE, { ...S, status: 'no_level' }, O);
  ok('Status filter "no reorder level": FG-1', () => assert.deepEqual(nl.rows.map((x) => x.sku), ['FG-1']));
  const s = await core.lowStock(q, core.LITE, { ...S, status: 'all', q: 'fg-' }, O);
  ok('Search matches SKU, case-insensitive, never returns the archived FG-2', () => assert.deepEqual(s.rows.map((x) => x.sku).sort(), ['FG-1', 'FG-3']));
  const byName = await core.lowStock(q, core.LITE, { ...S, sort: 'name', dir: 'asc' }, O);
  ok('Sort by name A-Z', () => assert.deepEqual(byName.rows.map((x) => x.name), ['Item FG-3', 'Item RM-1', 'Item RM-2', 'Item RM-3']));
  const byOn = await core.lowStock(q, core.LITE, { ...S, sort: 'on_hand', dir: 'asc' }, O);
  ok('Sort by on hand, lowest first', () => assert.deepEqual(byOn.rows.map((x) => x.onHand), [0, 4, 5, 10]));
  const noA = await core.lowStock(q, core.LITE, { ...S }, { hasAlerts: false });
  ok('Works when the alerts table does not exist yet (notified = false, no error)', () => assert.deepEqual(noA.rows.map((x) => x.notified), [false, false, false, false]));
  ok('READ-ONLY: the report did not add, change or remove any alert row, so it cannot create duplicate notifications', () => assert.equal(JSON.stringify(db.prepare('SELECT * FROM low_stock_alerts ORDER BY product_id').all()), alertsBefore));
  console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}`);
})();
