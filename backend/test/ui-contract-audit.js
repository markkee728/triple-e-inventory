/* UI contract audit (dev tool, run with: node test/ui-contract-audit.js)
   Checks the promises the quotation desk makes against the files it ships in:
   every element id the JS looks up exists in the page, every qd-/pq- class the JS
   renders has a rule in quotes.css, ids are unique, the old two-column layout is
   gone, and no browser dialog is used. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'Finance_Inventory');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function auditDesk() {
  const js = read('quote-desk-ui.js'), html = read('POS_Cashier.html'), css = read('quotes.css'), fields = read('quote-fields.js');
  const ids = new Set();
  for (const m of js.matchAll(/el\('([A-Za-z0-9_]+)'\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) ids.add(m[1]);
  // an id counts as present when the page has it statically, or when the desk / shared widget writes it into the DOM at runtime
  const writtenById = (id) => new RegExp('id="' + id + '"').test(html) || new RegExp('id="' + id + '"').test(js) || new RegExp("\\+ p \\+ '" + id.replace(/^(pq|qd)/, '')).test(fields);
  const runtimeIds = [...ids].filter((id) => !new RegExp('id="' + id + '"').test(html)).sort();
  const stillMissing = runtimeIds.filter((id) => !writtenById(id));
  console.log('desk ids referenced:', ids.size, '| built at runtime:', runtimeIds.join(', ') || 'none');
  console.log('really missing:', stillMissing.length ? stillMissing.join(', ') : 'none');

  const need = ['contactName', 'phone', 'email', 'company', 'productName', 'region', 'province', 'city', 'barangay', 'street'];
  const slots = [...html.matchAll(/id="pqE_([a-zA-Z]+)"/g)].map((m) => m[1]);
  console.log('inline error slots missing:', need.filter((n) => !slots.includes(n)).join(', ') || 'none');
  console.log('fulfilment radios:', (html.match(/name="pqFulfil"/g) || []).length);

  const cls = new Set();
  for (const src of [js, fields]) for (const m of src.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => { if (/^(qd|pq)-/.test(c) && !/[$']/.test(c)) cls.add(c); });
  const noCss = [...cls].filter((c) => !css.includes('.' + c)).sort();
  console.log('classes rendered:', cls.size, '| with no rule in quotes.css:', noCss.length ? noCss.join(', ') : 'none');

  const dupIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) !== i);
  console.log('duplicate ids in POS page:', [...new Set(dupIds)].join(', ') || 'none');
  console.log('old two-column classes left:', ['pq-layout', 'pq-side', 'pq-scroll', 'pq-workspace', 'pq-tabs', 'pqList', 'pqSearch'].filter((c) => html.includes(c)).join(', ') || 'none');
  console.log('native browser dialogs:', /\balert\(|\bconfirm\(|\bprompt\(/.test(js) ? 'FOUND' : 'none');
}

function auditShop() {
  const html = read('Shop_Customer.html'), css = read('quotes.css');
  const staticIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).filter((v) => !v.includes('$'));
  const dupIds = staticIds.filter((v, i, a) => a.indexOf(v) !== i);
  console.log('duplicate ids in shop page:', [...new Set(dupIds)].join(', ') || 'none');
  console.log('shop page loads the shared widget:', /quote-fields\.js/.test(html) ? 'yes' : 'NO');
  console.log('shop page dialog use:', /\balert\(|\bprompt\(/.test(html) ? 'FOUND' : 'none');
  console.log('quotes.css is scoped to #page-quotes:', /#page-quotes/.test(css) ? 'yes' : 'NO');
}

auditDesk();
auditShop();
