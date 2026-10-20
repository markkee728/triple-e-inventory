/* quote-fields-ui.test.js — drives the REAL Finance_Inventory/quote-fields.js in a simulated browser (jsdom), with the REAL options table
   that shop-extras.js serves, and checks that what the dropdowns offer follows the item type, the material and the finished-goods = pcs rule.
   Needs jsdom, which is a test-only tool and not a dependency of the app:   npm i --no-save jsdom   then   node test/quote-fields-ui.test.js */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch { try { ({ JSDOM } = require(path.join(process.env.JSDOM_DIR || '/home/claude/jsd', 'node_modules', 'jsdom'))); } catch { console.log('jsdom is not installed: run  npm i --no-save jsdom  first'); process.exit(2); } }

const PORT = Number(process.env.HARNESS_PORT || 8912), BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); } };

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'desk-browser-harness.js'), String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  try {
    for (let i = 0; i < 75; i++) { try { if ((await fetch(BASE + '/api/shop/info')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    await fetch(BASE + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'cashier' }) });
    const options = await (await fetch(BASE + '/api/pos/quote-options')).json();

    const dom = new JSDOM('<!doctype html><body><div id="host"></div><input id="qItem"></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.eval(fs.readFileSync(path.join(__dirname, '..', '..', 'Finance_Inventory', 'quote-fields.js'), 'utf8'));
    w.QuoteFields.mount(w.document.getElementById('host'), { prefix: 'q', options });
    const $ = (id) => w.document.getElementById(id);
    const vals = (id) => [...$(id).options].map((o) => o.value).filter((v) => v && v !== '__other__');
    const pick = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event('change', { bubbles: true })); };
    const has = (id, v) => vals(id).includes(v);
    const canType = (id) => [...$(id).options].some((o) => o.value === '__other__');

    console.log('\n1. item type first');
    ok('the form asks for the kind of item', !!$('qS_itemType') && vals('qS_itemType').length === 4, vals('qS_itemType'));
    let v = w.QuoteFields.validate('q');
    ok('a custom item cannot be submitted without one', !v.ok && /kind of item/.test($('qE_itemType').textContent) && v.focus === 'qS_itemType', $('qE_itemType').textContent);

    console.log('\n2. sheet: sheet sizes, always a thickness, counted in sheets');
    pick('qS_itemType', 'Sheet / plate');
    ok('only sheet sizes are offered', vals('qS_size').join('|') === '3 x 6 ft|4 x 8 ft|4 x 10 ft|5 x 10 ft', vals('qS_size'));
    ok('no pipe size such as 3/4" is offered', !has('qS_size', '3/4"'));
    ok('"Not applicable" is not a thickness for a sheet', !has('qS_thickness', 'Not applicable'));
    ok('the unit list is sheets / pcs / kg and defaults to sheets', [...$('qUnit').options].map((o) => o.value).join('|') === 'sheets|pcs|kg' && $('qUnit').value === 'sheets', [...$('qUnit').options].map((o) => o.value));
    ok('a custom size can be typed', canType('qS_size'));
    pick('qS_size', '__other__'); $('qC_size').value = '2 inch';
    ok('a typed sheet size must be width x length', w.QuoteFields.validate('q').ok === false && /width x length/.test($('qE_size').textContent), $('qE_size').textContent);
    $('qC_size').value = '600 x 900 mm'; $('qC_size').dispatchEvent(new w.Event('blur'));
    ok('600 x 900 mm is accepted', $('qE_size').textContent === '', $('qE_size').textContent);

    console.log('\n3. the material narrows finish, thickness and cutting');
    pick('qS_material', 'Aluminum');
    ok('aluminum has no chrome plating', !has('qS_finish', 'Chrome Plated') && has('qS_finish', 'Powder Coated'), vals('qS_finish'));
    pick('qS_finish', 'Powder Coated'); pick('qS_material', 'Stainless Steel 304');
    ok('switching to stainless clears the powder coat', $('qS_finish').value === '' && /Powder Coated/.test($('qCleared').textContent) && !$('qCleared').hidden, $('qCleared').textContent);
    ok('stainless offers polished / brushed', has('qS_finish', 'Polished') && has('qS_finish', 'Satin / Brushed') && !has('qS_finish', 'Galvanized'), vals('qS_finish'));
    pick('qS_material', 'Brass');
    ok('brass sheet stops at 6 mm', has('qS_thickness', '6.0 mm') && !has('qS_thickness', '12.0 mm'), vals('qS_thickness'));
    pick('qS_material', 'Cast Iron');
    ok('cast iron is not cut or bent', vals('qS_service').join('|') === 'None (as is)|Drilling / punching', vals('qS_service'));
    pick('qS_material', 'Not sure (advise me)');
    ok('"Not sure (advise me)" leaves everything open', vals('qS_finish').length === options.finish.length, vals('qS_finish').length);

    console.log('\n4. pipe, fitting and fabricated part');
    pick('qS_itemType', 'Pipe / tube');
    ok('a pipe offers inch sizes only', vals('qS_size').every((s) => /"$/.test(s)) && !has('qS_size', '4 x 8 ft'), vals('qS_size'));
    ok('its units are lengths / pcs / linear m / kg', [...$('qUnit').options].map((o) => o.value).join('|') === 'lengths|pcs|linear m|kg' && $('qUnit').value === 'lengths');
    pick('qS_itemType', 'Fitting / valve'); pick('qS_material', 'Brass');
    ok('a fitting has "Not applicable" as its only thickness, picked for you, and cannot type one', vals('qS_thickness').join('|') === 'Not applicable' && $('qS_thickness').value === 'Not applicable' && !canType('qS_thickness'), vals('qS_thickness'));
    ok('a fitting is not cut or bent', vals('qS_service').join('|') === 'None (as is)|Drilling / punching', vals('qS_service'));
    ok('it is sold by pcs / sets / boxes and defaults to pcs', [...$('qUnit').options].map((o) => o.value).join('|') === 'pcs|sets|boxes' && $('qUnit').value === 'pcs');
    pick('qS_itemType', 'Fabricated part');
    ok('a fabricated part is sold by pcs / sets', [...$('qUnit').options].map((o) => o.value).join('|') === 'pcs|sets' && $('qUnit').value === 'pcs');
    ok('a fabricated part types its own dimensions', has('qS_size', 'Not applicable') && canType('qS_size') && !has('qS_size', '4 x 8 ft'));

    console.log('\n5. the browser sends what the server accepts');
    pick('qS_itemType', 'Sheet / plate'); pick('qS_material', 'Stainless Steel 304');
    pick('qS_size', '4 x 8 ft'); pick('qS_thickness', '1.5 mm'); pick('qS_finish', 'Satin / Brushed'); pick('qS_service', 'Cut to size');
    $('qQty').value = '20';
    const body = w.QuoteFields.read('q');
    ok('read() carries the item type and the unit', body.itemType === 'Sheet / plate' && body.quantityUnit === 'sheets' && body.specs.size === '4 x 8 ft', body);
    const res = await (await fetch(BASE + '/api/pos/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ contactName: 'Walk-in Buyer', phone: '0917 123 4567', productName: 'Stainless sheet', fulfillment: 'Pickup', flexibleDate: true }, body)) })).json();
    ok('the server accepts exactly what the form built', res.quantity === '20 sheets' && /Item type: Sheet \/ plate/.test(res.details || ''), res);

    console.log('\n6. a ready-made catalog product (finished good) is sold by pcs');
    w.QuoteFields.autofill('q', { material: 'Brass', size: '3/4 in' }); w.QuoteFields.setUnit('q', 'pcs');
    ok('the item type is hidden: nothing to choose', $('qTypeWrap').hidden === true);
    ok('the unit is locked to pcs', $('qUnit').value === 'pcs' && $('qUnit').disabled === true);
    ok('the form needs no item type', w.QuoteFields.validate('q').ok === false ? !/kind of item/.test($('qE_itemType').textContent) : true);
    ok('read() sends no item type for a catalog product', w.QuoteFields.read('q').itemType === undefined);
    w.QuoteFields.autofill('q', null);
    ok('choosing "Other / custom product" brings the item type and its unit list back', $('qTypeWrap').hidden === false && $('qUnit').disabled === false && $('qS_itemType').value === 'Sheet / plate' && [...$('qUnit').options].map((o) => o.value).join('|') === 'sheets|pcs|kg' && $('qUnit').value === 'sheets', [...$('qUnit').options].map((o) => o.value));
    w.QuoteFields.reset('q');
    ok('reset puts every unit back and no item type is chosen', $('qS_itemType').value === '' && [...$('qUnit').options].length === options.units.length);
  } finally { child.kill(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
