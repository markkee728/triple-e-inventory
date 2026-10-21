/* quote-fields-ui.test.js — drives the REAL Finance_Inventory/quote-fields.js in a simulated browser, with the REAL options table
   that shop-extras.js serves, and checks that what the dropdowns offer follows the item type (die-cast part / forged part / fitting),
   the material (aluminum ADC12 / A380, brass C37700 / C36000) and the finished-goods = pcs rule.
   The browser is jsdom if it is installed (test-only tool, not an app dependency:  npm i --no-save jsdom),
   otherwise Playwright's Chromium. The checks themselves (phaseA / phaseB) are identical for both.   node test/quote-fields-ui.test.js */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let JSDOM = null, playwright = null;
try { ({ JSDOM } = require('jsdom')); } catch { try { ({ JSDOM } = require(path.join(process.env.JSDOM_DIR || '/home/claude/jsd', 'node_modules', 'jsdom'))); } catch {} }
if (!JSDOM) { for (const d of ['playwright', process.env.PLAYWRIGHT_DIR || '/home/claude/.npm-global/lib/node_modules/playwright']) { try { playwright = require(d); break; } catch {} } }
if (!JSDOM && !playwright) { console.log('No simulated browser found: run  npm i --no-save jsdom  first'); process.exit(2); }

const PORT = Number(process.env.HARNESS_PORT || 8912), BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
const report = (rows) => rows.forEach(([label, cond, detail]) => { if (cond) { passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); } });

/* ---- the checks. They run INSIDE the page (w = window), so they must not use anything from this file ---- */
function phaseMount(w, options) { w.QuoteFields.mount(w.document.getElementById('host'), { prefix: 'q', options }); }
function phaseA(w, options) {
  const out = [], ok = (label, cond, detail) => out.push([label, !!cond, detail]), title = (t) => out.push(['\n' + t, null]);
  const $ = (id) => w.document.getElementById(id);
  const vals = (id) => [...$(id).options].map((o) => o.value).filter((v) => v && v !== '__other__');
  const pick = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event('change', { bubbles: true })); };
  const has = (id, v) => vals(id).includes(v);
  const canType = (id) => [...$(id).options].some((o) => o.value === '__other__');
  const units = () => [...$('qUnit').options].map((o) => o.value).join('|');
  // typed values go into small boxes now: length / width / height + unit for a part, a number + unit for a pipe, a number in mm for a wall
  const fill = (id, v) => { const e = $(id); if (!e) return; e.value = v; e.dispatchEvent(new w.Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const blurBox = (k) => { $('qX_' + k).dispatchEvent(new w.FocusEvent('focusout', { bubbles: true, relatedTarget: null })); return $('qE_' + k).textContent; };
  const typeDims = (L, W, H, u) => { pick('qS_size', '__other__'); fill('qXL_size', L); fill('qXW_size', W); fill('qXH_size', H || ''); fill('qXU_size', u || 'mm'); return blurBox('size'); };
  const typePipe = (v, u) => { pick('qS_size', '__other__'); fill('qXL_size', v); fill('qXU_size', u); return blurBox('size'); };
  const typeThick = (t) => { pick('qS_thickness', '__other__'); fill('qXL_thickness', t); return blurBox('thickness'); };

  title('1. item type first');
  ok('the form asks for the kind of item: die-cast, forged, fitting', !!$('qS_itemType') && vals('qS_itemType').join('|') === 'Die-cast part|Forged part|Fitting / valve', vals('qS_itemType'));
  ok('before an item type is chosen only aluminum and brass grades exist', vals('qS_material').join('|') === 'Aluminum ADC12|Aluminum A380|Brass C37700|Brass C36000|Not sure (advise me)', vals('qS_material'));
  let v = w.QuoteFields.validate('q');
  ok('a custom item cannot be submitted without one', !v.ok && /kind of item/.test($('qE_itemType').textContent) && v.focus === 'qS_itemType', $('qE_itemType').textContent);

  title('2. die-cast part: aluminum only, dimensions typed, counted in pcs');
  pick('qS_itemType', 'Die-cast part');
  ok('only aluminum grades are offered', vals('qS_material').join('|') === 'Aluminum ADC12|Aluminum A380|Not sure (advise me)', vals('qS_material'));
  ok('a part offers size ranges by its longest side, up to 1000 mm', vals('qS_size').length === 4 && /up to 50 mm/.test(vals('qS_size')[0]) && /1000 mm/.test(vals('qS_size')[3]), vals('qS_size'));
  ok('"Exact dimensions" opens length / width / height boxes with a unit', (pick('qS_size', '__other__'), !$('qX_size').hidden && !!$('qXL_size') && !!$('qXW_size') && !!$('qXH_size') && [...$('qXU_size').options].map((o) => o.value).join('|') === 'mm|cm|in'));
  ok('the unit list is pcs / sets and defaults to pcs', units() === 'pcs|sets' && $('qUnit').value === 'pcs', units());
  ok('a length alone is not enough: the width is asked for', /width/.test(typeDims('100', '')), $('qE_size').textContent);
  ok('letters are not dimensions', /number/.test(typeDims('abc', '60')) || $('qXL_size').value === '', $('qE_size').textContent);
  ok('100 x 60 x 40 mm is accepted and sent in that form', typeDims('100', '60', '40', 'mm') === '' && $('qC_size').value === '100 x 60 x 40 mm', $('qC_size').value);
  ok('the height can be left out, and cm works', typeDims('12', '6', '', 'cm') === '' && $('qC_size').value === '12 x 6 cm', $('qC_size').value);
  ok('a part longer than 1000 mm goes to staff', /1000 mm/.test(typeDims('1200', '60', '40', 'mm')), $('qE_size').textContent);
  typeDims('100', '60', '40', 'mm');
  ok('"Not applicable" stays available as the wall thickness (optional)', has('qS_thickness', 'Not applicable'));

  title('3. the material narrows finish and wall thickness');
  pick('qS_material', 'Aluminum ADC12');
  ok('aluminum has no chrome / nickel plating or brushing, but is blasted and coated', !has('qS_finish', 'Chrome Plated') && !has('qS_finish', 'Nickel Plated') && !has('qS_finish', 'Satin / Brushed') && has('qS_finish', 'Powder Coated') && has('qS_finish', 'Shot Blasted') && has('qS_finish', 'Chromate Conversion'), vals('qS_finish'));
  ok('aluminum walls stop at 6 mm in the list', has('qS_thickness', '2.5 mm') && has('qS_thickness', '6.0 mm') && !has('qS_thickness', '12.0 mm'), vals('qS_thickness'));
  ok('secondary work for a casting: none / deburring / drilling / CNC', vals('qS_service').join('|') === 'None (as is)|Deburring|Drilling / tapping|CNC machining', vals('qS_service'));
  ok('a typed wall above the range is refused with the range', /1 to 8 mm/.test(typeThick('9 mm')), $('qE_thickness').textContent);
  ok('a typed wall must be a number', /number/.test(typeThick('2..2')) || $('qXL_thickness').value === '2..2', $('qE_thickness').textContent);
  ok('2.2 mm is accepted', typeThick('2.2') === '' && $('qC_thickness').value === '2.2 mm', $('qC_thickness').value);
  pick('qS_finish', 'Powder Coated'); pick('qS_material', 'Aluminum A380');
  ok('A380 takes the same finish: the choice stays', $('qS_finish').value === 'Powder Coated' && $('qCleared').hidden, $('qCleared').textContent);

  title('3b. changing the item type drops what no longer fits');
  pick('qS_itemType', 'Forged part');
  ok('the aluminum grade is cleared and the message says so', $('qS_material').value === '' && /Material/.test($('qCleared').textContent) && /Aluminum A380/.test($('qCleared').textContent) && !$('qCleared').hidden, $('qCleared').textContent);
  ok('the powder coat goes too (brass cannot take it)', $('qS_finish').value === '' && /Powder Coated/.test($('qCleared').textContent), $('qCleared').textContent);
  ok('only brass grades are offered now', vals('qS_material').join('|') === 'Brass C37700|Brass C36000|Not sure (advise me)', vals('qS_material'));
  pick('qS_material', 'Brass C37700');
  ok('brass offers polishing, brushing and plating, not powder coat or blasting', has('qS_finish', 'Polished') && has('qS_finish', 'Satin / Brushed') && has('qS_finish', 'Nickel Plated') && has('qS_finish', 'Chrome Plated') && !has('qS_finish', 'Powder Coated') && !has('qS_finish', 'Shot Blasted'), vals('qS_finish'));
  ok('a forged brass wall can be 12 mm', has('qS_thickness', '12.0 mm'), vals('qS_thickness'));
  ok('forged part secondary work includes threading', has('qS_service', 'Threading (BSP / NPT)'), vals('qS_service'));
  pick('qS_material', 'Not sure (advise me)');
  ok('"Not sure (advise me)" leaves every finish of that item type open, no more', vals('qS_finish').join('|') === options.matrix['Forged part'][''].finish.filter((x) => x).join('|') && !has('qS_finish', 'Powder Coated'), vals('qS_finish'));

  title('4. fitting / valve');
  pick('qS_itemType', 'Fitting / valve');
  ok('a part size was typed before: switching to a fitting clears it and says why', $('qS_size').value === '' && /measured differently/.test($('qCleared').textContent), $('qCleared').textContent);
  ok('the "not sure" choice survives the change of item type (it fits)', $('qS_material').value === 'Not sure (advise me)', $('qS_material').value);
  pick('qS_material', 'Brass C36000');
  ok('a fitting offers pipe sizes 1/4" to 2" only', vals('qS_size').join('|') === '1/4"|3/8"|1/2"|3/4"|1"|1-1/4"|1-1/2"|2"' && !has('qS_size', '2-1/2"'), vals('qS_size'));
  ok('a fitting has "Not applicable" as its only thickness, picked for you, and cannot type one', vals('qS_thickness').join('|') === 'Not applicable' && $('qS_thickness').value === 'Not applicable' && !canType('qS_thickness'), vals('qS_thickness'));
  ok('a fitting is not CNC machined online', vals('qS_service').join('|') === 'None (as is)|Deburring|Drilling / tapping|Threading (BSP / NPT)', vals('qS_service'));
  ok('it is sold by pcs / sets / boxes and defaults to pcs', units() === 'pcs|sets|boxes' && $('qUnit').value === 'pcs', units());
  ok('a fitting\'s typed size is one pipe size with in / mm', typePipe('25', 'mm') === '' && $('qC_size').value === '25 mm' && [...$('qXU_size').options].map((o) => o.value).join('|') === 'mm|in', $('qC_size').value);
  ok('a typed size that is already in the list is sent back to the list', /choose 1" from the list/.test(typePipe('1', 'in')), $('qE_size').textContent);
  ok('a fitting above 2" goes to staff', /up to 2"/.test(typePipe('3', 'in')), $('qE_size').textContent);

  title('5. the browser sends what the server accepts');
  $('qQty').value = '19'; ok('the form refuses 19 (minimum order 20) before sending', w.QuoteFields.validate('q').ok === false && /minimum order/.test($('qE_quantity').textContent), $('qE_quantity').textContent);
  pick('qS_size', '3/4"'); pick('qS_finish', 'Polished'); pick('qS_service', 'Threading (BSP / NPT)');
  $('qQty').value = '200';
  const body = w.QuoteFields.read('q');
  ok('read() carries the item type, the unit and the specs', body.itemType === 'Fitting / valve' && body.quantityUnit === 'pcs' && body.specs.material === 'Brass C36000' && body.specs.size === '3/4"', body);
  return { out, body };
}
async function phaseLink(w) {
  const out = [], ok = (label, cond, detail) => out.push([label, !!cond, detail]), title = (t) => out.push(['\n' + t, null]);
  const $ = (id) => w.document.getElementById(id);
  const wait = (ms) => new Promise((r) => w.setTimeout(r, ms));
  const say = async (t) => { $('qItem').value = t; $('qItem').dispatchEvent(new w.Event('input', { bubbles: true })); await wait(400); };
  const offTypes = () => [...$('qS_itemType').options].filter((o) => o.disabled).map((o) => o.value);
  title('5b. the description and the item type are connected');
  w.QuoteFields.reset('q');
  ok('before the item type, material and sizes wait for it', $('qS_material').disabled && $('qS_size').disabled && /item type first/.test($('qS_size').options[0].textContent));
  ok('only "choose the item type" is asked until then', w.QuoteFields.validate('q').ok === false && !$('qE_material').textContent && !$('qE_size').textContent && !!$('qE_itemType').textContent);
  await say('brass');
  ok('"brass" switches off die-cast parts (aluminum) and keeps forged parts and fittings', offTypes().join('|') === 'Die-cast part' && $('qS_itemType').value === '', offTypes());
  ok('…and says why', /Forged part or Fitting/.test($('qNarrow').textContent), $('qNarrow').textContent);
  await say('brass valve');
  ok('"brass valve" picks Fitting / valve for them', $('qS_itemType').value === 'Fitting / valve' && !$('qS_material').disabled, $('qS_itemType').value);
  ok('…and only brass grades and pipe sizes follow', [...$('qS_material').options].filter((o) => /Aluminum/.test(o.value)).length === 0 && [...$('qS_size').options].some((o) => o.value === '3/4"'));
  await say('aluminum valve');
  ok('"aluminum valve" is something we do not make, and the note says so', /do not make/.test($('qNarrow').textContent), $('qNarrow').textContent);
  await say('aluminum housing');
  ok('"aluminum housing" picks Die-cast part', $('qS_itemType').value === 'Die-cast part', $('qS_itemType').value);
  $('qNarrow').querySelector('[data-showall]').click(); await wait(50);
  ok('"Show all item types" turns every type back on', offTypes().length === 0, offTypes());
  $('qItem').value = ''; w.QuoteFields.reset('q');
  $('qS_itemType').value = 'Fitting / valve'; $('qS_itemType').dispatchEvent(new w.Event('change', { bubbles: true }));   // phase B starts from a fitting, as before
  return { out };
}
function phaseB(w, options) {
  const out = [], ok = (label, cond, detail) => out.push([label, !!cond, detail]), title = (t) => out.push(['\n' + t, null]);
  const $ = (id) => w.document.getElementById(id);
  const units = () => [...$('qUnit').options].map((o) => o.value).join('|');
  title('6. a ready-made catalog product (finished good) is sold by pcs');
  w.QuoteFields.autofill('q', { material: 'Brass', size: '3/4 in' }); w.QuoteFields.setUnit('q', 'pcs');
  ok('the item type is hidden: nothing to choose', $('qTypeWrap').hidden === true);
  ok('the unit is locked to pcs', $('qUnit').value === 'pcs' && $('qUnit').disabled === true);
  ok('the form needs no item type', w.QuoteFields.validate('q').ok === false ? !/kind of item/.test($('qE_itemType').textContent) : true);
  ok('read() sends no item type for a catalog product', w.QuoteFields.read('q').itemType === undefined);
  $('qItem').value = 'ADC12 Motor Housing'; w.QuoteFields.autofill('q', {});
  ok('a grade in the product name locks the exact material', $('qS_material').value === 'Aluminum ADC12' && $('qS_material').disabled === true, $('qS_material').value);
  $('qItem').value = 'Brass Forged Elbow 3/4"'; w.QuoteFields.autofill('q', {});
  ok('a name that only says "brass" locks "Brass" (the grade is set on the product record)', $('qS_material').value === 'Brass', $('qS_material').value);
  $('qItem').value = 'Motor Housing'; w.QuoteFields.autofill('q', {});
  ok('a name with no material says "Not specified"', $('qS_material').value === 'Not specified', $('qS_material').value);
  ok('secondary work of a ready-made item is "None (as is)"', $('qS_service').value === 'None (as is)', $('qS_service').value);
  $('qItem').value = '';
  w.QuoteFields.autofill('q', null);
  ok('choosing "Other / custom product" brings the item type and its unit list back', $('qTypeWrap').hidden === false && $('qUnit').disabled === false && $('qS_itemType').value === 'Fitting / valve' && units() === 'pcs|sets|boxes' && $('qUnit').value === 'pcs', units());
  w.QuoteFields.reset('q');
  ok('reset puts every unit back and no item type is chosen', $('qS_itemType').value === '' && [...$('qUnit').options].length === options.units.length);
  return { out };
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'desk-browser-harness.js'), String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  let browser = null;
  try {
    for (let i = 0; i < 75; i++) { try { if ((await fetch(BASE + '/api/shop/info')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    await fetch(BASE + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'cashier' }) });
    const options = await (await fetch(BASE + '/api/pos/quote-options')).json();
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'Finance_Inventory', 'quote-fields.js'), 'utf8');
    const html = '<!doctype html><body><div id="host"></div><input id="qItem"></body>';
    let run;                                                       // run(fn) -> the result of fn(window, options) inside the page
    if (JSDOM) {
      const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }).window;
      w.eval(script); run = async (fn) => fn(w, options);
    } else {
      const launch = async (opts) => playwright.chromium.launch(opts);
      try { browser = await launch({}); } catch { browser = await launch({ executablePath: '/opt/pw-browsers/chromium' }); }
      const page = await browser.newPage(); await page.setContent(html); await page.addScriptTag({ content: script });
      run = (fn) => page.evaluate(`(${fn.toString()})(window, ${JSON.stringify(options)})`);
    }
    await run(phaseMount);
    const a = await run(phaseA);
    a.out.forEach((row) => (row[1] === null ? console.log(row[0]) : report([row])));
    // the server accepts exactly what the form built
    const res = await (await fetch(BASE + '/api/pos/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ contactName: 'Walk-in Buyer', phone: '0917 123 4567', productName: 'Brass elbow', fulfillment: 'Pickup', flexibleDate: true }, a.body)) })).json();
    report([['the server accepts exactly what the form built', res.quantity === '200 pcs' && /Item type: Fitting \/ valve/.test(res.details || '') && /Material: Brass C36000/.test(res.details || ''), res]]);
    const l = await run(phaseLink);
    l.out.forEach((row) => (row[1] === null ? console.log(row[0]) : report([row])));
    const b = await run(phaseB);
    b.out.forEach((row) => (row[1] === null ? console.log(row[0]) : report([row])));
  } finally { if (browser) await browser.close(); child.kill(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
