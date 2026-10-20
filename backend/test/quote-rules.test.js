/* quote-rules.test.js — the "do the details match?" rules of a quotation request.
     1. a custom item says what KIND it is (sheet / pipe / fitting / fabricated part) and size, thickness and unit must fit that kind
     2. the chosen MATERIAL decides which finish / thickness / cutting are allowed
     3. finished goods (catalog products) are sold by pcs: the quote is in the product's unit, and the product form only accepts pcs
   Runs the real shop-extras.js over HTTP against test/desk-browser-harness.js (in-memory SQL double).   node test/quote-rules.test.js */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const PORT = Number(process.env.HARNESS_PORT || 8911), BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); } };

async function start() {
  const child = spawn(process.execPath, [path.join(__dirname, 'desk-browser-harness.js'), String(PORT)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (b) => err.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { if ((await fetch(BASE + '/api/shop/info')).ok) return child; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('harness did not start: ' + err.join(''));
}
async function call(role, method, p, body) {
  await fetch(BASE + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (b) => call('cashier', 'POST', '/api/pos/quotes', Object.assign({ contactName: 'Walk-in Buyer', phone: '0917 123 4567', fulfillment: 'Pickup', flexibleDate: true }, b));
const custom = (over, specs) => Object.assign({ productName: 'Custom metal item', itemType: 'Sheet / plate', quantity: 10, quantityUnit: 'sheets',
  specs: Object.assign({ material: 'Stainless Steel 304', size: '4 x 8 ft', thickness: '1.5 mm', finish: 'Satin / Brushed', service: 'Cut to size' }, specs || {}) }, over || {});
const fieldOf = (r) => (r.body && r.body.fields ? Object.keys(r.body.fields)[0] : null);
const msgOf = (r) => (r.body && (r.body.fields ? Object.values(r.body.fields)[0] : r.body.error)) || '';

async function main() {
  const child = await start();
  try {
    console.log('\n1. the form downloads the rules (one table for page and server)');
    const o = (await call('cashier', 'GET', '/api/pos/quote-options')).body;
    ok('item types are offered', Array.isArray(o.itemTypes) && o.itemTypes.length === 4, o.itemTypes);
    ok('a sheet always needs a thickness (no "Not applicable")', !o.matrix['Sheet / plate']['Aluminum'].thickness.includes('Not applicable'));
    ok('a sheet only offers sheet sizes', o.matrix['Sheet / plate'][''].size.every((s) => /ft$/.test(s)) && o.matrix['Sheet / plate'][''].size.length === 4);
    ok('a pipe only offers inch sizes', o.matrix['Pipe / tube'][''].size.every((s) => /"$/.test(s)));
    ok('a fitting has no thickness and cannot be cut or bent', JSON.stringify(o.matrix['Fitting / valve']['Brass'].thickness) === '["Not applicable"]' && JSON.stringify(o.matrix['Fitting / valve']['Brass'].service) === '["None (as is)","Drilling / punching"]', o.matrix['Fitting / valve']['Brass']);
    ok('aluminum is not offered chrome plating', !o.matrix['Sheet / plate']['Aluminum'].finish.includes('Chrome Plated'));
    ok('stainless is not offered galvanizing', !o.matrix['Pipe / tube']['Stainless Steel 316'].finish.includes('Galvanized'));
    ok('"Not sure (advise me)" keeps every finish', o.matrix['Sheet / plate']['Not sure (advise me)'].finish.length === o.finish.length);
    ok('every item type has a default unit that it also allows', o.itemTypes.every((t) => o.itemRules[t].units.includes(o.itemRules[t].unit)));

    console.log('\n2. a correct custom request is accepted and remembers its item type');
    const good = await post(custom());
    ok('sheet / stainless 304 / 4 x 8 ft / 1.5 mm / satin / cut to size, 10 sheets', good.status === 201, good.body);
    ok('the quantity is saved with its unit', good.body && good.body.quantity === '10 sheets', good.body && good.body.quantity);
    ok('the details start with the item type', good.body && /^Item type: Sheet \/ plate\nMaterial: Stainless Steel 304/.test(good.body.details), good.body && good.body.details);
    ok('a typed cut size is accepted when it is width x length', (await post(custom({}, { size: '600 x 900 mm' }))).status === 201);
    ok('a pipe in lengths with a pipe size and no wall thickness', (await post(custom({ itemType: 'Pipe / tube', quantityUnit: 'lengths' }, { size: '2"', thickness: 'Not applicable', service: 'Cut and bend' }))).status === 201);
    ok('a fitting by the piece', (await post(custom({ itemType: 'Fitting / valve', quantityUnit: 'pcs' }, { material: 'Brass', size: '3/4"', thickness: 'Not applicable', finish: 'Polished', service: 'None (as is)' }))).status === 201);
    ok('a fabricated part with typed dimensions, by the piece', (await post(custom({ itemType: 'Fabricated part', quantityUnit: 'pcs' }, { size: '300 x 200 mm', thickness: '3.0 mm' }))).status === 201);

    console.log('\n3. the item type has to match the size, thickness and unit');
    let r = await post(custom({ itemType: undefined }));
    ok('a custom item without an item type is refused', r.status === 400 && fieldOf(r) === 'itemType', r.body);
    r = await post(custom({ itemType: 'Spaceship' }));
    ok('an unknown item type is refused', r.status === 400 && fieldOf(r) === 'itemType', r.body);
    r = await post(custom({}, { size: '3/4"' }));
    ok('a sheet cannot have a pipe size', r.status === 400 && fieldOf(r) === 'size' && /sheet/.test(msgOf(r)), r.body);
    r = await post(custom({}, { size: 'Not applicable' }));
    ok('a sheet cannot have "Not applicable" as its size', r.status === 400 && fieldOf(r) === 'size', r.body);
    r = await post(custom({}, { size: '2 inch' }));
    ok('a typed sheet size must be width x length', r.status === 400 && fieldOf(r) === 'size' && /width x length/.test(msgOf(r)), r.body);
    r = await post(custom({}, { thickness: 'Not applicable' }));
    ok('a sheet cannot have "Not applicable" as its thickness', r.status === 400 && fieldOf(r) === 'thickness' && /needs a thickness/.test(msgOf(r)), r.body);
    r = await post(custom({ quantityUnit: 'lengths' }));
    ok('a sheet is not quoted in lengths', r.status === 400 && fieldOf(r) === 'quantity' && /sheets, pcs or kg/.test(msgOf(r)), r.body);
    r = await post(custom({ itemType: 'Pipe / tube', quantityUnit: 'lengths' }, { size: '4 x 8 ft', thickness: 'Not applicable' }));
    ok('a pipe cannot have a sheet size', r.status === 400 && fieldOf(r) === 'size', r.body);
    r = await post(custom({ itemType: 'Pipe / tube', quantityUnit: 'sheets' }, { size: '2"', thickness: 'Not applicable' }));
    ok('a pipe is not quoted in sheets', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    r = await post(custom({ itemType: 'Fitting / valve', quantityUnit: 'pcs' }, { material: 'Brass', size: '3/4"', thickness: '1.5 mm', finish: 'Polished', service: 'None (as is)' }));
    ok('a fitting has no sheet thickness', r.status === 400 && fieldOf(r) === 'thickness', r.body);
    r = await post(custom({ itemType: 'Fitting / valve', quantityUnit: 'pcs' }, { material: 'Brass', size: '3/4"', thickness: 'Not applicable', finish: 'Polished', service: 'Cut to size' }));
    ok('a fitting is not cut to size', r.status === 400 && fieldOf(r) === 'service', r.body);
    r = await post(custom({ itemType: 'Fitting / valve', quantityUnit: 'kg' }, { material: 'Brass', size: '3/4"', thickness: 'Not applicable', finish: 'Polished', service: 'None (as is)' }));
    ok('a fitting is not quoted by the kilo', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    r = await post(custom({ itemType: 'Fabricated part', quantityUnit: 'sheets' }, { size: '300 x 200 mm' }));
    ok('a fabricated part is sold by the piece, not by the sheet', r.status === 400 && fieldOf(r) === 'quantity' && /pcs or sets/.test(msgOf(r)), r.body);

    console.log('\n4. the material has to match the finish, thickness and cutting');
    r = await post(custom({}, { material: 'Aluminum', finish: 'Chrome Plated' }));
    ok('aluminum cannot be chrome plated', r.status === 400 && fieldOf(r) === 'finish' && /Aluminum/.test(msgOf(r)), r.body);
    r = await post(custom({}, { material: 'Stainless Steel 316', finish: 'Galvanized' }));
    ok('stainless cannot be galvanized', r.status === 400 && fieldOf(r) === 'finish', r.body);
    r = await post(custom({}, { material: 'Cast Iron', size: '4 x 8 ft', thickness: '9.0 mm', finish: 'Painted', service: 'Cut and bend' }));
    ok('cast iron cannot be bent', r.status === 400 && fieldOf(r) === 'service' && /Cast Iron/.test(msgOf(r)), r.body);
    r = await post(custom({}, { material: 'Brass', thickness: '12.0 mm', finish: 'Polished' }));
    ok('brass sheet is not made 12 mm thick', r.status === 400 && fieldOf(r) === 'thickness' && /Brass/.test(msgOf(r)), r.body);
    ok('the same 12 mm is fine for stainless', (await post(custom({}, { thickness: '12.0 mm' }))).status === 201);
    ok('"Not sure (advise me)" is allowed with any finish', (await post(custom({}, { material: 'Not sure (advise me)', finish: 'Chrome Plated' }))).status === 201);

    console.log('\n5. finished goods (catalog products) are sold by pcs');
    const cat = (over) => ({ sku: 'BF-ELB-034', quantity: 50, quantityUnit: 'pcs', ...over });
    r = await post(cat());
    ok('a catalog finished good is quoted in pcs', r.status === 201 && r.body.quantity === '50 pcs', r.body);
    ok('a catalog product needs no item type', r.status === 201 && !/Item type/.test(r.body.details), r.body && r.body.details);
    r = await post(cat({ quantityUnit: 'kg' }));
    ok('a catalog finished good cannot be quoted in kg', r.status === 400 && fieldOf(r) === 'quantity' && /sold by pcs/.test(msgOf(r)), r.body);
    r = await post(cat({ quantityUnit: 'sheets' }));
    ok('... nor in sheets', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    r = await post(cat({ quantityUnit: undefined }));
    ok('... and the unit cannot be left out', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    r = await post(cat({ quantity: 2.5 }));
    ok('pieces are whole numbers', r.status === 400 && fieldOf(r) === 'quantity' && /whole number/.test(msgOf(r)), r.body);
    r = await post(cat({ itemType: 'Sheet / plate', specs: { material: 'Aluminum', finish: 'Chrome Plated' } }));
    ok('the product record decides the details: what the browser sent is ignored', r.status === 201 && /Finish: Not specified/.test(r.body.details) && /Cutting \/ bending: None \(as is\)/.test(r.body.details) && !/Item type/.test(r.body.details), r.body && r.body.details);

    console.log('\n6. the product form only accepts pcs for a finished good (validateProduct in server.js)');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('cannot find ' + from); return src.slice(a, b); };
    const code = [cut('class ValidationError', 'const DEPARTMENTS'), cut('const DEPARTMENTS', 'const NEEDS_SUPPLIER'), cut('const UNITS', '\n', ), ''].join('\n') +
      cut('const str = ', 'const EMAIL_RE') + cut('function validateProduct', 'function validateSupplier') + '\nthis.validateProduct = validateProduct; this.ValidationError = ValidationError;';
    const sb = {}; vm.runInNewContext(code, sb);
    const prod = (over) => Object.assign({ sku: 'FG-TEST-01', name: 'Test piece', department: 'Finished Goods', category: 'Forged Brass Products', unit: 'pcs', unitCost: 10, listPrice: 20, onHand: 1, location: 'FG-1', reorderAuto: true }, over);
    const tryProduct = (b) => { try { return { v: sb.validateProduct(b, { creating: true }) }; } catch (e) { return { fields: e.fields }; } };
    ok('a finished good in pcs is accepted', !!tryProduct(prod()).v);
    let t = tryProduct(prod({ unit: 'kg' }));
    ok('a finished good in kg is refused', t.fields && /sold by the piece/.test(t.fields.unit), t);
    ok('a finished good in sheet is refused', !!(tryProduct(prod({ unit: 'sheet' })).fields || {}).unit);
    ok('a raw material is still allowed in kg', !!tryProduct(prod({ department: 'Raw Materials', unit: 'kg', listPrice: undefined })).v);
    ok('a finishing supply is still allowed in liters', !!tryProduct(prod({ department: 'Finishing Supplies', unit: 'liter', listPrice: undefined })).v);
  } finally { child.kill(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
