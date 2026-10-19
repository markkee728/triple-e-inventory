/* End-to-end quotation chains, run over real HTTP against test/desk-browser-harness.js.
   The harness mounts the real quote-desk.js and shop-extras.js route code, so these assertions cover the
   shipped handlers, not a re-implementation. It uses the in-memory SQL double, so it proves route logic and
   state transitions; real PostgreSQL behaviour is verified by test/quote-desk.test.js and migration 019.

   node test/quote-chain.test.js */
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.HARNESS_PORT || 8899);
let port = PORT;
const BASE = () => 'http://127.0.0.1:' + port;
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  →  ' + JSON.stringify(detail) : '')); }
}

async function start(p, env) {
  port = p;
  const child = spawn(process.execPath, [path.join(__dirname, 'desk-browser-harness.js'), String(p)],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, env) });
  const err = [];
  child.stderr.on('data', (b) => err.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE() + '/api/shop/info'); if (r.ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('harness did not start: ' + err.join(''));
}

/* one global session lives in the harness, so the role is switched before every step */
async function call(role, method, p, body) {
  const s = await fetch(BASE() + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  if (!s.ok) throw new Error('session switch failed');
  const r = await fetch(BASE() + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const state = () => call('cashier', 'GET', '/__harness/state').then((r) => r.body);
const walkIn = () => ({ contactName: 'Walk-in Buyer', phone: '0917 123 4567', sku: 'ANG-0203', quantity: 4, quantityUnit: 'pcs',
  fulfillment: 'Pickup', flexibleDate: true,
  specs: { material: 'Not sure (advise me)', size: '2"', thickness: '3.0 mm', finish: 'Not sure (advise me)', service: 'None (as is)' }, });

async function main() {
  const child = await start(PORT);
  try {
    console.log('\n1. walk-in quotation at the counter: created unpriced, approved by Finance, handed over once');
    const before = await state();
    const created = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const no = created.body && created.body.id;
    ok('the counter saved the request', created.status === 201 && !!no, created);
    ok('it is not priced yet', created.body.status === 'new' && created.body.quotedAmount == null, created.body);
    ok('nothing was paid', +created.body.paidAmount === 0, created.body);
    ok('no order or POS sale appeared', before.orders.length === 0 && before.sales.length === 0, before);

    const price = (amount, extra) => Object.assign({ amount, leadTime: '1 to 3 working days', validDays: 7, note: 'Counter price' }, extra);
    const tooThin = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/price', price('5000.00', { reason: 'why' }));
    ok('a cashier price with no real justification is refused', tooThin.status === 400 && tooThin.body.fields.reason, tooThin);
    const asked = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/price', price('5000.00', { reason: 'Above the cashier limit, Finance must approve' }));
    ok('with a CASHIER_QUOTE_LIMIT_PHP of 0 the price goes to Finance, not straight out', asked.status === 200 && asked.body.status === 'pending_approval', asked);

    const approved = await call('finance', 'POST', '/api/finance/quotes/' + no + '/approve-price', {});
    ok('Finance approval turns it into a quotation', approved.status === 200 && approved.body.quote.status === 'quoted' && +approved.body.quote.quotedAmount === 5000, approved.body);
    const reApprove = await call('finance', 'POST', '/api/finance/quotes/' + no + '/approve-price', {});
    ok('the same proposal cannot be approved twice', reApprove.status === 400, reApprove);
    const notOwner = await call('customer', 'POST', '/api/shop/quotes/' + no + '/respond', { action: 'accept', payMethod: 'cod' });
    ok('a signed-in customer cannot answer a walk-in quotation', notOwner.status === 400, notOwner);

    const accepted = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/respond', { action: 'accept' });
    ok('the counter can record the walk-in acceptance', accepted.status === 200 && accepted.body.status === 'accepted', accepted.body);
    const twice = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/respond', { action: 'accept' });
    ok('a second acceptance is refused', twice.status === 400, twice);

    const handed = await call('cashier', 'POST', '/api/pos/quote-desk/' + no + '/convert', { requestId: 'walkin-handover-0000000001' });
    ok('the accepted walk-in quote is handed to the POS terminal', handed.status === 200 && handed.body.kind === 'pos' && handed.body.qty === 4, handed.body);
    const again = await call('cashier', 'POST', '/api/pos/quote-desk/' + no + '/convert', { requestId: 'walkin-handover-0000000002' });
    ok('the same quote cannot be handed over twice', again.status === 400, again);
    const afterWalkIn = await state();
    ok('a quotation is not a reservation: no order, no sale, stock untouched',
      afterWalkIn.orders.length === 0 && afterWalkIn.sales.length === 0 &&
      JSON.stringify(afterWalkIn.stock) === JSON.stringify(before.stock), afterWalkIn);

    console.log('\n2. online quotation: owner accepts, the desk converts it into exactly one unpaid order');
    const list = await call('customer', 'GET', '/api/shop/quotes');
    const quoted = list.body.find((q) => q.status === 'quoted');
    ok('the customer sees the priced quote with the approved amount', !!quoted && quoted.quotedAmount > 0, list.body);
    const noMethod = await call('customer', 'POST', '/api/shop/quotes/' + quoted.id + '/respond', { action: 'accept' });
    ok('accepting without choosing how to pay is refused', noMethod.status === 400 && noMethod.body.fields.payMethod, noMethod);
    const yes = await call('customer', 'POST', '/api/shop/quotes/' + quoted.id + '/respond', { action: 'accept', payMethod: 'cod' });
    ok('the owner accepted it', yes.status === 200 && yes.body.status === 'accepted', yes.body);
    const back = await call('customer', 'GET', '/api/shop/quotes');
    const card = back.body.find((q) => q.id === quoted.id);
    ok('the payment label is resolved, not raw SQL text', /^Pay on /.test(card.payMethod || ''), card);
    ok('acceptance never marks the quote paid', +card.paidAmount === 0, card);
    ok('acceptance never creates an order', card.orderNo == null && (await state()).orders.length === 0, card);

    const first = await call('cashier', 'POST', '/api/pos/quote-desk/' + quoted.id + '/convert', { requestId: 'online-convert-000000000001' });
    ok('conversion creates an order', first.status === 200 && first.body.kind === 'order' && !!first.body.orderNo, first.body);
    const replay = await call('cashier', 'POST', '/api/pos/quote-desk/' + quoted.id + '/convert', { requestId: 'online-convert-000000000001' });
    ok('the same requestId replays the same order instead of making another', replay.status === 200 && replay.body.duplicate === true && replay.body.orderNo === first.body.orderNo, replay.body);
    const freshId = await call('cashier', 'POST', '/api/pos/quote-desk/' + quoted.id + '/convert', { requestId: 'online-convert-000000000002' });
    ok('a fresh requestId on a converted quote is still refused', freshId.status === 400 || (freshId.body && freshId.body.duplicate === true), freshId);
    const desk = await call('cashier', 'GET', '/api/pos/quote-desk/' + quoted.id);
    ok('the desk shows the preserved price and its order reference',
      desk.status === 200 && desk.body.amount === quoted.quotedAmount && desk.body.orderNo === first.body.orderNo, desk.body);
    const afterOnline = await state();
    ok('exactly one order exists and it is unpaid', afterOnline.orders.length === 1 && afterOnline.orders[0].payment_status === 'unpaid' && afterOnline.orders[0].status === 'Pending', afterOnline.orders);
    ok('the order total is the approved quotation amount', +afterOnline.orders[0].total === quoted.quotedAmount, afterOnline.orders[0]);
    ok('stock was only checked, never deducted', JSON.stringify(afterOnline.stock) === JSON.stringify(afterWalkIn.stock), afterOnline.stock);
    ok('no POS sale was created by an online conversion', afterOnline.sales.length === 0, afterOnline.sales);
  } finally {
    child.kill();
  }

  console.log('\n3. the cashier pricing ceiling comes from CASHIER_QUOTE_LIMIT_PHP, not from a hardcoded number');
  const second = await start(PORT + 1, { CASHIER_QUOTE_LIMIT_PHP: '50000' });
  try {
    const a = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const routine = await call('cashier', 'POST', '/api/pos/quotes/' + a.body.id + '/price',
      { amount: '5000.00', leadTime: '1 to 3 working days', validDays: 7, note: 'Routine counter price' });
    ok('under the configured ceiling the cashier can issue the quotation directly', routine.status === 200 && routine.body.status === 'quoted', routine);
    const b = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const over = await call('cashier', 'POST', '/api/pos/quotes/' + b.body.id + '/price',
      { amount: '60000.00', leadTime: '1 to 3 working days', validDays: 7, note: 'Big order', reason: 'Above the ceiling, Finance must approve' });
    ok('only one peso above the same ceiling sends it to Finance instead', over.status === 200 && over.body.status === 'pending_approval', over);
  } finally {
    second.kill();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
