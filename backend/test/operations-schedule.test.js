'use strict';
/* test/operations-schedule.test.js — Verifies Operations & Delivery Schedule board for Finance.
   Run: node --no-warnings --test backend/test/operations-schedule.test.js
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('Operations Schedule - frontend assets exist and are valid', () => {
  assert.ok(fs.existsSync('Finance_Inventory/operations-schedule.js'), 'JS exists');
  assert.ok(fs.existsSync('Finance_Inventory/operations-schedule.css'), 'CSS exists');

  const jsContent = fs.readFileSync('Finance_Inventory/operations-schedule.js', 'utf8');
  assert.ok(jsContent.includes('window.OperationsSchedule'), 'Exports OperationsSchedule on window');
  assert.ok(jsContent.includes('/api/inventory/automation/delivery-schedules'), 'Queries delivery schedules');
  assert.ok(jsContent.includes('/api/inventory/automation/production-plans'), 'Queries production plans');
  assert.ok(jsContent.includes('data-receive-sched'), 'Provides Receive Stock action');
  assert.ok(jsContent.includes('data-run-plan'), 'Provides Run Production action');
});

test('Operations Schedule - Finance_Inventory.html loads operations-schedule files without touching sidebar', () => {
  const html = fs.readFileSync('Finance_Inventory/Finance_Inventory.html', 'utf8');
  assert.ok(html.includes('operations-schedule.css'), 'CSS linked in HTML');
  assert.ok(html.includes('operations-schedule.js'), 'JS loaded in HTML');
  // Confirm sidebar nav is unchanged
  assert.ok(html.includes('id="navl-inventory"'), 'Sidebar inventory section intact');
  assert.ok(html.includes('id="navl-admin"'), 'Sidebar admin section intact');
});

test('Operations Schedule - backend routes for individual schedule receive and plan execution exist', () => {
  const server = fs.readFileSync('backend/server.js', 'utf8');
  assert.ok(server.includes('/api/inventory/automation/delivery-schedules/:id/receive'), 'Receive schedule endpoint mounted');
  assert.ok(server.includes('/api/inventory/automation/production-plans/:id/execute'), 'Execute plan endpoint mounted');
});

