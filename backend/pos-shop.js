const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const FG = 'Finished Goods';
// Units sold by measure (weight / length / volume) may be typed with up to 2 decimals; everything else (sheet, pcs, box...) is whole numbers only.
const MEASURED_UNIT = /^(kg|g|tonne|ton|lb|m|meter|metre|ft|foot|feet|liter|litre|l|linear m|linear meter|linear metre|lm)s?$/i;
const isMeasured = (unit) => MEASURED_UNIT.test(String(unit || '').trim());
const OVERRIDE_MINUTES = 10;     // how long a supervisor approval stays valid at the counter
const VAT_RATE = 0.12;
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE) || 150;
const ONLINE_METHODS = ['Online Banking', 'E-Wallet', 'Card', 'Xendit'];
// Order life-cycle. An order can only move one step forward; the last step ends it.
const FLOW = {
  Delivery: ['Pending Confirmation', 'Paid', 'Packed', 'Out for Delivery', 'Delivered'],
  Pickup:   ['Pending Confirmation', 'Paid', 'Packed', 'Ready for Pickup', 'Picked Up']
};
const FINAL_STATUS = ['Delivered', 'Picked Up'];
const ADMIN_CANCELLABLE = ['Pending Confirmation', 'Paid', 'Packed'];   // once it is out for delivery / ready for pickup it can no longer be cancelled
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Refunds: a customer can ask for one after the order is Delivered / Picked Up, within this many days.
const REFUND_WINDOW_DAYS = Number(process.env.REFUND_WINDOW_DAYS) || 7;
const REFUND_REASONS = {
  damaged: 'Damaged or defective',
  wrong_item: 'Wrong item received',
  not_as_described: 'Not as described',
  missing_items: 'Missing items',
  other: 'Other'
};
// Cancellations: the customer picks a reason. Cancelling soon after ordering (and before we pack it) is approved on the spot;
// after that window the shop decides. Change the window with CANCEL_AUTO_HOURS in .env (default 24 hours).
const CANCEL_AUTO_HOURS = Number(process.env.CANCEL_AUTO_HOURS) || 24;
const CANCEL_REASONS = {
  changed_mind: 'Changed my mind',
  ordered_by_mistake: 'Ordered by mistake',
  wrong_item_or_qty: 'Wrong item or quantity',
  found_better_price: 'Found a better price',
  too_slow: 'Delivery or pickup will take too long',
  wrong_details: 'Wrong address or contact details',
  payment_problem: 'Problem with payment',
  other: 'Other'
};
// Cashier asks Finance to void a receipt: pick a reason; "Other" needs a written explanation.
const VOID_REASONS = {
  wrong_item: 'Wrong item or quantity rung up',
  wrong_price: 'Wrong price',
  changed_mind: 'Customer changed their mind',
  payment_problem: 'Payment problem',
  duplicate: 'Duplicate sale',
  other: 'Other'
};
// Partial returns at the counter: the customer brings back some of the items on a receipt. The cashier requests it, Finance approves.
const RETURN_REASONS = {
  damaged: 'Damaged or defective',
  wrong_item: 'Wrong item given',
  not_as_described: 'Not as described',
  changed_mind: 'Customer changed their mind',
  other: 'Other'
};
const RETURN_WINDOW_DAYS = Number(process.env.POS_RETURN_WINDOW_DAYS) || 7;   // how long after the sale items can still be returned
const CUSTOMER_CANCELLABLE =['Pending Confirmation', 'Paid'];   // once we start packing, only the shop can cancel

const makeOrderMail = require('./order-mail');

module.exports = function mount({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ, validateShipTo, formatShipTo }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const { notify, shopInfo } = makeOrderMail(pool);   // customer emails (never block or fail an order)

  // Adds what the Sales Transactions page needs (safe to run every time the server starts).
  async function ensureSalesSchema() {
    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS received_by TEXT');
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ');
      await pool.query(`CREATE TABLE IF NOT EXISTS order_status_history (
        history_id  BIGSERIAL PRIMARY KEY,
        order_id    BIGINT NOT NULL REFERENCES orders(order_id),
        from_status TEXT,
        to_status   TEXT NOT NULL,
        changed_by  INT REFERENCES users(user_id),
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history (order_id, created_at)');
      // make sure the status column accepts every step of the flow (an older CHECK may only know a few)
      await pool.query(`DO $$
        DECLARE c record;
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'orders'::regclass AND conname = 'orders_status_flow_check') THEN
            FOR c IN SELECT conname FROM pg_constraint
                      WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
            LOOP
              EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c.conname);
            END LOOP;
            ALTER TABLE orders ADD CONSTRAINT orders_status_flow_check CHECK (status IN
              ('Pending Confirmation','Paid','Packed','Out for Delivery','Ready for Pickup','Delivered','Picked Up','Cancelled'));
          END IF;
        END $$`);
      await pool.query(`CREATE TABLE IF NOT EXISTS order_cancel_requests (
        request_id   BIGSERIAL PRIMARY KEY,
        order_id     BIGINT NOT NULL REFERENCES orders(order_id),
        reason       TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        requested_by INT REFERENCES users(user_id),
        decided_by   INT REFERENCES users(user_id),
        decided_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('ALTER TABLE order_cancel_requests ADD COLUMN IF NOT EXISTS reason_code TEXT');
      await pool.query('ALTER TABLE order_cancel_requests ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query('ALTER TABLE order_cancel_requests ALTER COLUMN decided_by DROP NOT NULL').catch(() => {});   // instant cancellations have no staff member
    } catch (err) { console.warn('[db] could not prepare the sales tables:', err.message); }
  }
  ensureSalesSchema();

  // Xendit invoice metadata. Payment is only confirmed by the signed server callback.
  async function ensureXenditSchema() {
    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS xendit_invoice_id TEXT');
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS xendit_external_id TEXT');
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'");
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_xendit_invoice ON orders (xendit_invoice_id) WHERE xendit_invoice_id IS NOT NULL');
    } catch (err) { console.warn('[db] could not prepare Xendit columns:', err.message); }
  }
  ensureXenditSchema();

  const xenditBaseUrl = 'https://api.xendit.co';
  const xenditAuth = () => {
    const key = process.env.XENDIT_SECRET_KEY;
    if (!key) throw new Error('XENDIT_SECRET_KEY is not configured');
    return 'Basic ' + Buffer.from(key + ':').toString('base64');
  };
  async function xenditRequest(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: { Authorization: xenditAuth(), 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.message || 'Xendit request failed');
      err.status = response.status;
      throw err;
    }
    return data;
  }

  // Cashier hosted-checkout requests. A pending request is NOT a sale or stock movement.
  async function ensurePosPayments() {
    await pool.query(`CREATE TABLE IF NOT EXISTS pos_xendit_payments (
      payment_id BIGSERIAL PRIMARY KEY, cashier_id INT NOT NULL REFERENCES users(user_id),
      cashier_name TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE,
      invoice_id TEXT UNIQUE, checkout_url TEXT, amount NUMERIC(12,2) NOT NULL,
      items JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      sale_id BIGINT, error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  }
  const posPaymentsReady = ensurePosPayments().catch(e => { console.error('[db] POS Xendit schema:', e.message); throw e; });
  app.post('/api/pos/xendit-checkout', auth('cashier'), wrap(async (req, res) => {
    await posPaymentsReady;
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && /^[a-zA-Z0-9-]{12,100}$/.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'Sale request identifier is required. Refresh the POS page.');
    const lines = readLines(b.items);
    // Override prices are deliberately rejected here until approved override handling is implemented.
    if ((b.items || []).some(i => i && i.price !== undefined)) throw bad('items', 'Xendit checkout currently requires standard catalog prices');
    const items = await loadSellable(pool, lines, { lock: false });
    const amount = round2(items.reduce((sum, i) => sum + lineCents(i.price, i.qty), 0) / 100);
    if (!Number.isFinite(amount) || amount <= 0) throw bad('amount', 'Invalid checkout total');
    const crypto = require('crypto');
    const externalId = 'triplee-pos-' + crypto.randomUUID();
    const snapshot = items.map(i => ({ sku: i.sku, qty: i.qty, price: i.price }));
    const created = await pool.query(`INSERT INTO pos_xendit_payments (cashier_id,cashier_name,external_id,amount,items)
      VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING payment_id`, [req.user.id,req.user.name,externalId,amount,JSON.stringify(snapshot)]);
    const id = created.rows[0].payment_id;
    try {
      const base = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
      if (!base || !/^https?:\/\//.test(base)) throw new Error('APP_BASE_URL must be a valid frontend URL');
      const invoice = await xenditRequest(`${xenditBaseUrl}/v2/invoices`, { method:'POST', body: {
        external_id:externalId, amount, currency:'PHP', description:`Triple-E cashier payment ${id}`,
        success_redirect_url:`${base}/POS_Cashier.html?payment=return`,
        failure_redirect_url:`${base}/POS_Cashier.html?payment=failed`
      }});
      await pool.query(`UPDATE pos_xendit_payments SET invoice_id=$1,checkout_url=$2 WHERE payment_id=$3`, [invoice.id,invoice.invoice_url,id]);
      res.status(201).json({ paymentId:id, checkoutUrl:invoice.invoice_url, amount, status:'pending' });
    } catch(e) {
      await pool.query(`UPDATE pos_xendit_payments SET status='error',error_message=$1 WHERE payment_id=$2`, [String(e.message).slice(0,400),id]);
      throw e;
    }
  }));
  app.get('/api/pos/xendit-payments/:id', auth('cashier'), wrap(async (req,res) => {
    await posPaymentsReady;
    const sel = () => pool.query(`SELECT payment_id,status,amount,checkout_url,sale_id,error_message,invoice_id,external_id
      FROM pos_xendit_payments WHERE payment_id=$1 AND cashier_id=$2`, [req.params.id,req.user.id]);
    let {rows} = await sel();
    let checkError;
    if (!rows.length) return res.status(404).json({error:'Payment not found'});
    // Do not rely only on Xendit's callback (it cannot reach a local/offline server): ask Xendit for the invoice itself.
    if (rows[0].status === 'pending' && rows[0].invoice_id) {
      try {
        const inv = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(rows[0].invoice_id)}`);
        const st = inv.status === 'SETTLED' ? 'PAID' : inv.status;
        if (st === 'PAID' || st === 'EXPIRED') {
          await handlePosXenditWebhook({ ...inv, status: st }, rows[0].external_id, rows[0].invoice_id);
          ({rows} = await sel());
        }
      } catch (e) { checkError = e.message; console.warn('[xendit] POS status check failed:', e.message); }
    }
    const { invoice_id, external_id, ...out } = rows[0];
    res.json(checkError ? { ...out, checkError } : out);
  }));
  async function handlePosXenditWebhook(event, externalId, invoiceId) {
    await posPaymentsReady;
    const {rows} = await pool.query('SELECT payment_id FROM pos_xendit_payments WHERE external_id=$1 AND invoice_id=$2', [externalId,invoiceId]);
    if (!rows.length) return false;
    await tx(async client => {
      const {rows: locked} = await client.query('SELECT * FROM pos_xendit_payments WHERE payment_id=$1 FOR UPDATE', [rows[0].payment_id]);
      const p = locked[0];
      if (p.status === 'paid') return;
      if (event.status === 'EXPIRED' && p.status === 'pending') {
        await client.query("UPDATE pos_xendit_payments SET status='expired' WHERE payment_id=$1",[p.payment_id]); return;
      }
      if ((event.status === 'SETTLED' ? 'PAID' : event.status) !== 'PAID') return;
      if (Math.round(Number(event.paid_amount ?? event.amount)*100) !== Math.round(Number(p.amount)*100) || event.currency && event.currency !== 'PHP')
        throw new Error('POS Xendit paid amount/currency mismatch');
      const lines = readLines(p.items.map(i=>({sku:i.sku,qty:i.qty})));   // loadSellable needs the SKU -> qty Map that readLines builds (a plain array here caused "is not iterable")
      const items = await loadSellable(client,lines,{lock:true});
      const currentTotal = round2(items.reduce((sum,i)=>sum+lineCents(i.price,i.qty),0)/100);
      if (Math.round(currentTotal*100)!==Math.round(Number(p.amount)*100)) {
        await client.query("UPDATE pos_xendit_payments SET status='review',error_message='Price changed after payment; manual reconciliation required' WHERE payment_id=$1",[p.payment_id]);
        return;
      }
      const vat = round2(currentTotal * VAT_RATE / (1+VAT_RATE));
      const {rows:sales} = await client.query(`INSERT INTO pos_sales
        (cashier_id,cashier_name,method,total,vat,tendered,change_given,card_ref)
        VALUES ($1,$2,'Xendit',$3,$4,NULL,NULL,$5) RETURNING *`,
        [p.cashier_id,p.cashier_name,currentTotal,vat,invoiceId]);
      const sale = sales[0];
      for(const i of items) {
        await client.query(`INSERT INTO pos_sale_items (sale_id,product_id,sku,name,unit,qty,price,list_price,override_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)`,[sale.sale_id,i.product_id,i.sku,i.name,i.unit,i.qty,i.price,i.price]);
        await postMovement(client,{productId:i.product_id,type:'out',reason:'sale',qty:i.qty,userId:p.cashier_id,sourceType:'pos_sale',sourceId:sale.sale_id,note:sale.receipt_no});
      }
      await client.query("UPDATE pos_xendit_payments SET status='paid',sale_id=$1 WHERE payment_id=$2",[sale.sale_id,p.payment_id]);
    });
    return true;
  }

  // Customer starts hosted checkout for an order they own. The total always comes from PostgreSQL.
  app.post('/api/shop/orders/:no/xendit-checkout', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT order_id, order_no, total, status, payment_method, payment_status, xendit_invoice_id, xendit_external_id FROM orders WHERE order_no = $1 AND customer_id = $2',
      [req.params.no, req.user.id]);
    if (!rows.length) throw bad('order', 'Order not found');
    const o = rows[0];
    if (o.payment_method !== 'Xendit') throw bad('payment', 'This order was not placed with Xendit');
    if (o.payment_status === 'paid' || o.status !== 'Pending Confirmation') throw bad('payment', 'This order is no longer awaiting payment');
    if (o.xendit_invoice_id) {
      try {
        const existing = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(o.xendit_invoice_id)}`);
        if (existing.status === 'PENDING' && existing.invoice_url) return res.json({ checkoutUrl: existing.invoice_url });
      } catch (_) { /* create a replacement invoice below if the previous one is unavailable */ }
    }
    const externalId = o.xendit_external_id || `triplee-${o.order_no}-${o.order_id}`;
    const base = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
    if (!base) throw bad('config', 'Set APP_BASE_URL to the public HTTPS address of this application');
    const invoice = await xenditRequest(`${xenditBaseUrl}/v2/invoices`, {
      method: 'POST',
      body: {
        external_id: externalId,
        amount: Number(o.total),
        currency: 'PHP',
        description: `Triple-E Metal Products order ${o.order_no}`,
        success_redirect_url: `${base}/Shop_Customer.html?payment=return`,
        failure_redirect_url: `${base}/Shop_Customer.html?payment=failed`,
        invoice_duration: 86400
      }
    });
    await pool.query('UPDATE orders SET xendit_invoice_id = $1, xendit_external_id = $2, payment_status = $3 WHERE order_id = $4',
      [invoice.id, externalId, 'pending', o.order_id]);
    res.json({ checkoutUrl: invoice.invoice_url });
  }));

  async function applyShopInvoice(o, event, invoiceId) {
    if ((event.status === 'PAID' || event.status === 'SETTLED') && Number(event.paid_amount ?? event.amount) === Number(o.total) && o.payment_status !== 'paid' && o.status === 'Pending Confirmation') {
      let confirmed = false;
      await tx(async (client) => {
        const locked = await client.query('SELECT * FROM orders WHERE order_id = $1 FOR UPDATE', [o.order_id]);
        const current = locked.rows[0];
        if (!current || current.payment_status === 'paid' || current.status !== 'Pending Confirmation') return;
        await confirmOrder(client, current, { id: null, name: 'Xendit Webhook', roleLabel: 'System' }, `Xendit invoice ${invoiceId} paid`);
        await client.query("UPDATE orders SET payment_status = 'paid' WHERE order_id = $1", [current.order_id]);
        confirmed = true;
      });
      if (confirmed) notify(o.order_no, 'Paid');
    } else if (event.status === 'EXPIRED' && o.payment_status !== 'paid') {
      await pool.query("UPDATE orders SET payment_status = 'expired' WHERE order_id = $1 AND payment_status <> 'paid'", [o.order_id]);
    }
  }

  // The customer's page calls this after paying: ask Xendit directly, so the order is saved even if the callback never arrives.
  app.post('/api/shop/orders/:no/verify-payment', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE order_no = $1 AND customer_id = $2', [req.params.no, req.user.id]);
    if (!rows.length) throw bad('order', 'Order not found');
    const o = rows[0];
    if (o.payment_method === 'Xendit' && o.xendit_invoice_id && o.payment_status !== 'paid') {
      try {
        const inv = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(o.xendit_invoice_id)}`);
        await applyShopInvoice(o, inv, o.xendit_invoice_id);
      } catch (e) { console.warn('[xendit] order payment check failed:', e.message); }
    }
    const cur = await pool.query('SELECT status, payment_status FROM orders WHERE order_id = $1', [o.order_id]);
    res.json({ status: cur.rows[0].status, paymentStatus: cur.rows[0].payment_status });
  }));

  // Xendit calls this endpoint directly. Never trust the browser redirect as payment proof.
  app.post('/api/payments/xendit/webhook', wrap(async (req, res) => {
    const expected = process.env.XENDIT_CALLBACK_TOKEN;
    const supplied = req.get('x-callback-token');
    if (!expected || !supplied || supplied !== expected) return res.status(401).json({ error: 'Invalid callback token' });
    const event = req.body || {};
    const externalId = str(event.external_id);
    const invoiceId = str(event.id);
    if (!externalId || !invoiceId) return res.status(400).json({ error: 'Missing invoice identifiers' });
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE xendit_external_id = $1 AND xendit_invoice_id = $2 LIMIT 1', [externalId, invoiceId]);
    if (!rows.length) { await handlePosXenditWebhook(event, externalId, invoiceId); return res.json({received:true}); }
    await applyShopInvoice(rows[0], event, invoiceId);
    res.json({ received: true });
  }));

  // POS sales remember the request id of each sale (stops a double-click or retry from saving the same sale twice).
  // No migration created this column, so without it every POS sale failed with "Server error". Safe to run every time the server starts.
  const posSalesReady = (async () => {
    try {
      await pool.query('ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS request_id TEXT');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sales_cashier_request ON pos_sales (cashier_id, request_id) WHERE request_id IS NOT NULL');
      // online-payment sales are saved with method 'Xendit' (shown as "Online payment"): make sure the method column accepts it
      await pool.query(`DO $$
        DECLARE c record;
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pos_sales'::regclass AND conname = 'pos_sales_method_flow_check') THEN
            FOR c IN SELECT conname FROM pg_constraint
                      WHERE conrelid = 'pos_sales'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%method%'
            LOOP
              EXECUTE format('ALTER TABLE pos_sales DROP CONSTRAINT %I', c.conname);
            END LOOP;
            ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_method_flow_check CHECK (method IN ('Cash','Card','Xendit'));
          END IF;
        END $$`);
      // earlier online payments were saved as 'Card': relabel the ones that really came from a paid Xendit invoice
      await posPaymentsReady.catch(() => {});
      await pool.query(`UPDATE pos_sales SET method = 'Xendit'
        WHERE method = 'Card' AND card_ref IN (SELECT invoice_id FROM pos_xendit_payments WHERE status = 'paid' AND invoice_id IS NOT NULL)`);
    } catch (err) { console.warn('[db] could not prepare pos_sales.request_id:', err.message); }
  })();

  // Price overrides at the counter: keep the list price and who approved the change (safe to run every time the server starts).
  async function ensurePosOverrideSchema() {
    try {
      await pool.query('ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS list_price NUMERIC(12,2)');
      await pool.query('ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS override_by INT REFERENCES users(user_id)');
    } catch (err) { console.warn('[db] could not prepare the price-override columns:', err.message); }
  }
  ensurePosOverrideSchema();

  // Customer refund requests (one per order). Safe to run every time the server starts.
  async function ensureRefundSchema() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS order_refund_requests (
        request_id    BIGSERIAL PRIMARY KEY,
        order_id      BIGINT NOT NULL REFERENCES orders(order_id),
        reason_code   TEXT NOT NULL,
        details       TEXT NOT NULL,
        amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        requested_by  INT REFERENCES users(user_id),
        decided_by    INT REFERENCES users(user_id),
        decision_note TEXT,
        restocked     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at    TIMESTAMPTZ)`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_one_per_order ON order_refund_requests (order_id)');
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_refund_status ON order_refund_requests (status, created_at)`);
    } catch (err) { console.warn('[db] could not prepare the refund table:', err.message); }
  }
  ensureRefundSchema();

  // Partial returns of POS sales (safe to run every time the server starts).
  // The two shift columns are plain numbers (no foreign key) because the cash shift table is created by cash-shifts.js, which starts after this file.
  const posReturnsReady = (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS pos_return_requests (
        return_id          BIGSERIAL PRIMARY KEY,
        sale_id            BIGINT NOT NULL REFERENCES pos_sales(sale_id),
        reason             TEXT NOT NULL,
        amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        refund_method      TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        restock            BOOLEAN,
        requested_by       INT REFERENCES users(user_id),
        requested_shift_id BIGINT,
        refund_shift_id    BIGINT,
        decided_by         INT REFERENCES users(user_id),
        decision_note      TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at         TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS pos_return_items (
        return_item_id BIGSERIAL PRIMARY KEY,
        return_id      BIGINT NOT NULL REFERENCES pos_return_requests(return_id),
        sale_item_id   BIGINT NOT NULL REFERENCES pos_sale_items(item_id),
        product_id     INT REFERENCES products(product_id),
        qty            NUMERIC(14,2) NOT NULL CHECK (qty > 0),
        unit_price     NUMERIC(12,2) NOT NULL,
        amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0))`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_sale ON pos_return_requests (sale_id, status)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_status ON pos_return_requests (status, created_at)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_refund_shift ON pos_return_requests (refund_shift_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_items_return ON pos_return_items (return_id)');
    } catch (err) { console.warn('[db] could not prepare the POS return tables:', err.message); }
  })();
  app.locals.posReturnsReady = posReturnsReady;   // cash-shifts.js waits for this before it reads the tables

  // Structured delivery address on orders + each customer's saved addresses (safe to run every time the server starts).
  async function ensureAddressSchema() {
    try {
      for (const col of ['recipient_name', 'address_line', 'landmark', 'barangay', 'city', 'province', 'region', 'zip_code'])
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${col} TEXT`);
      await pool.query(`CREATE TABLE IF NOT EXISTS customer_addresses (
        address_id     BIGSERIAL PRIMARY KEY,
        user_id        INT NOT NULL REFERENCES users(user_id),
        label          TEXT NOT NULL DEFAULT 'Home',
        recipient_name TEXT NOT NULL,
        phone          TEXT NOT NULL,
        address_line   TEXT NOT NULL,
        landmark       TEXT,
        barangay       TEXT NOT NULL,
        city           TEXT NOT NULL,
        province       TEXT NOT NULL,
        region         TEXT NOT NULL,
        zip_code       TEXT NOT NULL,
        is_default     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_cust_addr_user ON customer_addresses (user_id)');
    } catch (err) { console.warn('[db] could not prepare the address tables:', err.message); }
  }
  const addressSchemaReady = ensureAddressSchema();

  /* ---------- shared helpers ---------- */
  const CATALOG_SQL = `
    SELECT p.sku, p.name, COALESCE(c.name, 'Uncategorized') AS category, p.grade, p.form, p.unit,
           p.selling_price, p.on_hand, p.reorder_level, p.shop_description, p.shop_specs,
           (SELECT image_url FROM shop_product_images WHERE product_id=p.product_id ORDER BY sort_order,image_id LIMIT 1) AS image_url
      FROM products p LEFT JOIN categories c USING (category_id)
     WHERE p.department = $1 AND NOT p.is_archived AND p.selling_price > 0 AND p.shop_visible = TRUE
     ORDER BY COALESCE(c.name, 'Uncategorized'), p.name`;
  const catalogJson = (r) => ({
    sku: r.sku, name: r.name, category: r.category, unit: r.unit,
    spec: [r.grade, r.form].filter(Boolean).join(' · '),
    description: r.shop_description || '', specs: r.shop_specs || {}, image: r.image_url || null,
    price: +r.selling_price, available: +r.on_hand, low: +r.reorder_level, fractional: isMeasured(r.unit)
  });
  async function catalog() {
    const { rows } = await pool.query(CATALOG_SQL, [FG]);
    return rows.map(catalogJson);
  }

  // [{sku, qty}] -> Map(sku -> qty); merges duplicates, rejects junk
  function readLines(items) {
    if (!Array.isArray(items) || !items.length) throw bad('items', 'Add at least one product');
    if (items.length > 100) throw bad('items', 'Too many lines in one transaction');
    const m = new Map();
    for (const it of items) {
      const sku = str(it && it.sku).toUpperCase();
      const qty = Number(it && it.qty);
      if (!sku) throw bad('items', 'Every line needs a SKU');
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6 || Math.round(qty * 100) !== qty * 100)
        throw bad('items', `Invalid quantity for ${sku}`);
      m.set(sku, round2((m.get(sku) || 0) + qty));
    }
    return m;
  }

  // Loads the sellable finished-goods rows for these SKUs (sorted by id so concurrent sales lock in the same order).
  async function loadSellable(client, lines, { lock }) {
    const { rows } = await client.query(
      `SELECT product_id, sku, name, unit, selling_price, on_hand
         FROM products
        WHERE upper(sku) = ANY($1) AND department = $2 AND NOT is_archived AND selling_price > 0 AND shop_visible = TRUE
        ORDER BY product_id ${lock ? 'FOR UPDATE' : ''}`, [[...lines.keys()], FG]);
    const bySku = new Map(rows.map(r => [r.sku.toUpperCase(), r]));
    const out = [];
    for (const [sku, qty] of lines) {
      const p = bySku.get(sku);
      if (!p) throw bad('items', `${sku} is not available for sale`);
      if (!isMeasured(p.unit) && !Number.isInteger(qty)) throw bad('items', `${p.name} is sold in whole ${p.unit} only`);
      if (+p.on_hand < qty) throw bad('items', `Only ${+p.on_hand} ${p.unit} of ${p.name} in stock`);
      out.push({ ...p, qty, price: +p.selling_price });
    }
    return out;
  }

  async function postMovement(client, { productId, type, reason, qty, userId, sourceType, sourceId, note }) {
    await client.query(
      `INSERT INTO stock_movements (product_id, movement_type, reason, quantity, handled_by, source_type, source_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [productId, type, reason, qty, userId, sourceType, sourceId, note || null]);
  }

  const logStatus = (client, orderId, from, to, userId, note) => client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
    [orderId, from, to, userId, note || null]);

  // Payment confirmed -> take the goods out of stock (checked under a row lock so two admins cannot oversell).
  async function confirmOrder(client, o, user, note) {
    const { rows: lines } = await client.query(
      `SELECT i.product_id, i.qty, p.name, p.unit, p.on_hand
         FROM order_items i JOIN products p ON p.product_id = i.product_id
        WHERE i.order_id = $1 ORDER BY i.product_id FOR UPDATE OF p`, [o.order_id]);
    for (const l of lines)
      if (+l.on_hand < +l.qty) throw bad('stock', `Not enough stock for ${l.name}: ${+l.on_hand} ${l.unit} on hand, this order needs ${+l.qty}`);
    for (const l of lines) await postMovement(client, { productId: l.product_id, type: 'out', reason: 'online_order', qty: +l.qty,
      userId: user.id, sourceType: 'order', sourceId: o.order_id, note: o.order_no });
    await client.query(`UPDATE orders SET status = 'Paid', stock_deducted = TRUE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
    await logStatus(client, o.order_id, o.status, 'Paid', user.id, ['Payment confirmed — stock deducted', note].filter(Boolean).join(' — '));
    await audit(client, user, 'Record edited', `Order ${o.order_no} confirmed and paid — stock deducted`);
  }

  const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* =====================================================
     POS — cashier
  ===================================================== */
  app.get('/api/pos/products', auth('cashier'), wrap(async (req, res) => res.json(await catalog())));

  // ret = returnInfo() result for the sales being sent (optional). total / vat stay as originally charged;
  // refunded is the money already given back, so the till shows total - refunded as the real sale.
  const saleJson = (s, items, ret) => {
    const rs = ret && ret.sales.get(String(s.sale_id));
    return {
      id: String(s.sale_id), receiptNo: s.receipt_no, total: +s.total, vat: +s.vat, method: s.method,
      tendered: s.tendered === null ? undefined : +s.tendered, change: s.change_given === null ? undefined : +s.change_given,
      cardRef: s.card_ref || undefined, cashierName: s.cashier_name, createdAt: new Date(s.created_at).getTime(), status: s.status,
      refunded: rs ? rs.refunded : 0, returnPending: !!(rs && rs.pending),
      items: items.map(i => {
        const r = ret && ret.items.get(String(i.item_id)) || { approved: 0, pending: 0 };
        return { itemId: i.item_id === undefined ? undefined : String(i.item_id), sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price,
          returnedQty: r.approved, pendingReturnQty: r.pending, fractional: isMeasured(i.unit),
          listPrice: i.list_price !== null && i.list_price !== undefined && +i.list_price !== +i.price ? +i.list_price : undefined };
      })
    };
  };

  // How much of each sale line has been returned (approved) or is waiting for Finance (pending), plus per-sale refund totals.
  async function returnInfo(db, saleIds) {
    const out = { items: new Map(), sales: new Map() };
    if (!saleIds.length) return out;
    await posReturnsReady;
    const { rows } = await db.query(
      `SELECT ri.sale_item_id, r.status, SUM(ri.qty)::float8 AS qty FROM pos_return_items ri JOIN pos_return_requests r USING (return_id)
        WHERE r.sale_id = ANY($1) AND r.status IN ('pending','approved') GROUP BY ri.sale_item_id, r.status`, [saleIds]);
    for (const x of rows) {
      const k = String(x.sale_item_id), cur = out.items.get(k) || { approved: 0, pending: 0 };
      cur[x.status] = round2(cur[x.status] + x.qty); out.items.set(k, cur);
    }
    const sm = await db.query(
      `SELECT sale_id, COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)::float8 AS refunded, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM pos_return_requests WHERE sale_id = ANY($1) AND status IN ('pending','approved') GROUP BY sale_id`, [saleIds]);
    for (const x of sm.rows) out.sales.set(String(x.sale_id), { refunded: x.refunded, pending: x.pending });
    return out;
  }

  // A line total in whole centavos: price (centavos) x qty (hundredths). Integer maths so the till and the server always agree.
  const lineCents = (price, qty) => Math.round(Math.round(price * 100) * Math.round(qty * 100) / 100);

  // Supervisor approval for negotiated prices: a finance user types their own login at the counter. The password is checked once and
  // never kept; the cashier's screen only gets a short-lived signed token that is good for price overrides on this cashier's sales.
  const approvalFails = new Map();            // cashier id -> { n, until }   (stops guessing a supervisor's password at the till)
  app.post('/api/pos/override-approval', auth('cashier'), wrap(async (req, res) => {
    const f = approvalFails.get(req.user.id);
    if (f && f.until > Date.now()) throw bad('approval', 'Too many wrong attempts. Try again in a few minutes.');
    const email = str(req.body && req.body.email).toLowerCase();
    const password = req.body && req.body.password;
    if (!email || typeof password !== 'string' || !password || password.length > 200) throw bad('approval', 'Enter the supervisor email and password');
    const { rows } = await pool.query(
      `SELECT u.user_id, u.full_name, u.password_hash, u.status, r.role_key FROM users u JOIN roles r USING (role_id) WHERE u.email = $1`, [email]);
    const u = rows[0];
    const ok = !!u && u.status === 'active' && u.role_key === 'finance' && await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      const n = ((f && f.until <= Date.now() ? 0 : f && f.n) || 0) + 1;
      approvalFails.set(req.user.id, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
      await audit(pool, req.user, 'Price override refused', 'Supervisor approval failed at the counter');
      throw bad('approval', 'Those supervisor details are not valid. Only a finance account can approve a price change.');
    }
    approvalFails.delete(req.user.id);
    const token = jwt.sign({ purpose: 'price_override', cashier: req.user.id, approver: u.user_id, approverName: u.full_name },
      process.env.JWT_SECRET, { expiresIn: OVERRIDE_MINUTES + 'm' });
    await audit(pool, req.user, 'Price override approved', `Approved by ${u.full_name} (valid ${OVERRIDE_MINUTES} min)`);
    res.json({ token, approver: u.full_name, expiresAt: Date.now() + OVERRIDE_MINUTES * 60000 });
  }));

  app.post('/api/pos/sales', auth('cashier'), wrap(async (req, res) => {
    await posSalesReady;
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && /^[a-zA-Z0-9-]{12,100}$/.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'Sale request identifier is required. Refresh the POS page.');
    const lines = readLines(b.items);
    const method = str(b.method);
    if (!['Cash', 'Card'].includes(method)) throw bad('method', 'Choose Cash or Card');

    // negotiated prices: {sku, qty, price} lines need a valid supervisor approval token
    const overrides = new Map();
    for (const it of b.items) {
      if (it && it.price === undefined) continue;
      const sku = str(it.sku).toUpperCase(), price = Number(it.price);
      if (!Number.isFinite(price) || price <= 0 || price > 1e7 || Math.round(price * 100) !== price * 100) throw bad('items', `Invalid price for ${sku}`);
      if (overrides.has(sku) || b.items.filter(x => str(x && x.sku).toUpperCase() === sku).length > 1) throw bad('items', `${sku} appears twice with a changed price`);
      overrides.set(sku, price);
    }
    let approval = null;
    if (overrides.size) {
      try { approval = jwt.verify(String(b.approvalToken || ''), process.env.JWT_SECRET); } catch (e) { approval = null; }
      if (!approval || approval.purpose !== 'price_override' || approval.cashier !== req.user.id)
        throw bad('approval', 'Price change needs a supervisor approval (it may have expired — ask them to approve again)');
    }

    const sale = await tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [73001, req.user.id]);
      const prior = await client.query('SELECT * FROM pos_sales WHERE cashier_id=$1 AND request_id=$2', [req.user.id, requestId]);
      if (prior.rowCount) {
        const it = await client.query('SELECT * FROM pos_sale_items WHERE sale_id=$1 ORDER BY item_id', [prior.rows[0].sale_id]);
        return saleJson(prior.rows[0], it.rows);
      }
      const shiftResult = await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL FOR UPDATE', [req.user.id]);
      if (!shiftResult.rowCount) throw bad('cashShift', 'Open your Cash Shift before completing a sale.');
      const cashShiftId = shiftResult.rows[0].shift_id;
      const items = await loadSellable(client, lines, { lock: true });
      const changed = [];
      for (const i of items) {
        const o = overrides.get(i.sku.toUpperCase());
        i.list_price = i.price;
        if (o !== undefined && o !== i.price) { changed.push(`${i.sku} ${peso(i.price)} to ${peso(o)}`); i.price = o; i.override_by = approval.approver; }
      }
      const total = items.reduce((n, i) => n + lineCents(i.price, i.qty), 0) / 100;
      let tendered = null, change = null, cardRef = null;
      if (method === 'Cash') {
        tendered = round2(Number(b.tendered));
        if (!Number.isFinite(tendered) || tendered < total) throw bad('tendered', 'Cash received is less than the total');
        if (tendered > 10000000) throw bad('tendered', 'Cash received is too large');
        change = round2(tendered - total);
      } else {
        // Card / phone payment: the customer pays exactly the total from their own phone, so there is no tendered amount or change; only the payment reference is kept.
        cardRef = str(b.cardRef).toUpperCase();
        if (!/^[A-Z0-9-]{4,30}$/.test(cardRef)) throw bad('cardRef', 'Reference number must be 4-30 letters, numbers or dashes');
        const dup = await client.query(`SELECT receipt_no FROM pos_sales WHERE method = 'Card' AND card_ref = $1 AND status <> 'Voided' LIMIT 1`, [cardRef]);
        if (dup.rowCount) throw bad('cardRef', `Reference ${cardRef} was already used on receipt ${dup.rows[0].receipt_no}`);
      }
      const vat = round2(total * VAT_RATE / (1 + VAT_RATE));
      const ins = await client.query(
        `INSERT INTO pos_sales (cashier_id, cashier_name, method, total, vat, tendered, change_given, card_ref, cash_shift_id, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.id, req.user.name, method, total, vat, tendered, change, cardRef, cashShiftId, requestId]);
      const s = ins.rows[0];
      for (const i of items) {
        const li = await client.query(
          `INSERT INTO pos_sale_items (sale_id, product_id, sku, name, unit, qty, price, list_price, override_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING item_id`,
          [s.sale_id, i.product_id, i.sku, i.name, i.unit, i.qty, i.price, i.list_price, i.override_by || null]);
        i.item_id = li.rows[0].item_id;
        await postMovement(client, { productId: i.product_id, type: 'out', reason: 'sale', qty: i.qty, userId: req.user.id,
          sourceType: 'pos_sale', sourceId: s.sale_id, note: s.receipt_no });
      }
      await audit(client, req.user, 'Record added', `POS sale ${s.receipt_no} — ${peso(total)} (${method}), ${items.length} line(s)`
        + (changed.length ? ` · price override approved by ${approval.approverName}: ${changed.join(', ')}` : ''));
      return saleJson(s, items);
    });
    res.status(201).json(sale);
  }));

  // Today's sales (Manila time). Finance may pass ?date=YYYY-MM-DD for a daily summary.
  app.get('/api/pos/sales', auth('cashier', 'finance'), wrap(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') && req.user.role === 'finance' ? req.query.date : null;
    const { rows: sales } = await pool.query(
      `SELECT * FROM pos_sales
        WHERE (created_at AT TIME ZONE $1)::date = COALESCE($2::date, (now() AT TIME ZONE $1)::date)
        ORDER BY created_at DESC`, [TZ, date]);
    const { rows: items } = sales.length
      ? await pool.query('SELECT * FROM pos_sale_items WHERE sale_id = ANY($1) ORDER BY item_id', [sales.map(s => s.sale_id)])
      : { rows: [] };
    const ret = await returnInfo(pool, sales.map(s => s.sale_id));
    res.json(sales.map(s => saleJson(s, items.filter(i => i.sale_id === s.sale_id), ret)));
  }));

  // Find an older receipt by its number (the list above only shows today), so a customer can bring items back on a later day.
  app.get('/api/pos/sales/lookup', auth('cashier'), wrap(async (req, res) => {
    const no = str(req.query.receipt).toUpperCase();
    if (!/^[A-Z0-9-]{3,30}$/.test(no)) throw bad('receipt', 'Enter the receipt number printed on the receipt');
    const sr = await pool.query('SELECT * FROM pos_sales WHERE upper(receipt_no) = $1', [no]);
    if (!sr.rowCount) throw bad('receipt', 'No receipt with that number');
    const s = sr.rows[0];
    const { rows: items } = await pool.query('SELECT * FROM pos_sale_items WHERE sale_id = $1 ORDER BY item_id', [s.sale_id]);
    res.json(saleJson(s, items, await returnInfo(pool, [s.sale_id])));
  }));

  app.post('/api/pos/sales/:id/void-request', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {}, code = str(b.reason), details = str(b.details);
    if (!VOID_REASONS[code]) throw bad('reason', 'Choose the reason for the void');
    if (code === 'other' && details.length < 5) throw bad('details', 'Please explain the reason (at least 5 characters)');
    if (details.length > 300) throw bad('details', 'Please keep the details under 300 characters');
    const reason = VOID_REASONS[code] + (details ? ' \u2014 ' + details : '');
    if (!/^\d{1,18}$/.test(req.params.id)) throw bad('id', 'Sale not found');
    await posReturnsReady;
    await tx(async (client) => {
      const r = await client.query('SELECT sale_id, receipt_no, status FROM pos_sales WHERE sale_id = $1 FOR UPDATE', [req.params.id]);
      if (!r.rowCount) throw bad('id', 'Sale not found');
      if (r.rows[0].status !== 'Completed') throw bad('id', 'This sale already has a void request or is voided');
      // a void puts every item back in stock and removes the whole sale, which would count returned items twice
      const rt = await client.query(`SELECT 1 FROM pos_return_requests WHERE sale_id = $1 AND status IN ('pending','approved') LIMIT 1`, [r.rows[0].sale_id]);
      if (rt.rowCount) throw bad('id', 'Some items of this sale were already returned (or a return is waiting for Finance), so it cannot be voided. Return the remaining items instead.');
      await client.query('INSERT INTO void_requests (sale_id, reason, requested_by) VALUES ($1,$2,$3)', [r.rows[0].sale_id, reason, req.user.id]);
      await client.query(`UPDATE pos_sales SET status = 'Void Pending' WHERE sale_id = $1`, [r.rows[0].sale_id]);
      await audit(client, req.user, 'Record edited', `Void requested for ${r.rows[0].receipt_no}: ${reason}`);
    });
    res.status(201).json({ ok: true });
  }));

  /* ---------- finance: decide void requests ---------- */
  app.get('/api/pos/void-requests', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT v.request_id, v.reason, v.status, s.receipt_no, s.total, s.cashier_name,
              to_char(v.created_at AT TIME ZONE $1, 'YYYY-MM-DD HH12:MI AM') AS requested_at
         FROM void_requests v JOIN pos_sales s USING (sale_id)
        WHERE v.status = 'pending' ORDER BY v.created_at`, [TZ]);
    res.json(rows.map(r => ({ id: r.request_id, receiptNo: r.receipt_no, total: +r.total, cashier: r.cashier_name, reason: r.reason, requestedAt: r.requested_at })));
  }));

  app.post('/api/pos/void-requests/:id/decision', auth('finance'), wrap(async (req, res) => {
    const approve = (req.body || {}).approve === true;
    await tx(async (client) => {
      const r = await client.query(
        `SELECT v.request_id, v.sale_id, s.receipt_no FROM void_requests v JOIN pos_sales s USING (sale_id)
          WHERE v.request_id = $1 AND v.status = 'pending' FOR UPDATE OF v, s`, [req.params.id]);
      if (!r.rowCount) throw bad('id', 'No pending void request with that id');
      const { sale_id, receipt_no } = r.rows[0];
      if (approve) {
        const { rows: items } = await client.query('SELECT product_id, qty FROM pos_sale_items WHERE sale_id = $1 ORDER BY product_id', [sale_id]);
        for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'return', qty: +i.qty,
          userId: req.user.id, sourceType: 'pos_sale', sourceId: sale_id, note: `Void of ${receipt_no}` });
      }
      await client.query(`UPDATE pos_sales SET status = $2 WHERE sale_id = $1`, [sale_id, approve ? 'Voided' : 'Completed']);
      await client.query(`UPDATE void_requests SET status = $2, decided_by = $3, decided_at = now() WHERE request_id = $1`,
        [r.rows[0].request_id, approve ? 'approved' : 'rejected', req.user.id]);
      await audit(client, req.user, 'Record edited', `Void ${approve ? 'approved' : 'rejected'} for ${receipt_no}${approve ? ' — stock restored' : ''}`);
    });
    res.json({ ok: true });
  }));

  /* ---------- partial returns: cashier requests, Finance approves ---------- */
  const lineText = (rows) => rows.map(i => `${+i.qty} ${i.unit} ${i.name}`).join(', ');

  app.post('/api/pos/sales/:id/return-request', auth('cashier'), wrap(async (req, res) => {
    await posReturnsReady;
    const b = req.body || {}, code = str(b.reason), details = str(b.details);
    if (!RETURN_REASONS[code]) throw bad('reason', 'Choose the reason for the return');
    if (code === 'other' && details.length < 5) throw bad('details', 'Please explain the reason (at least 5 characters)');
    if (details.length > 300) throw bad('details', 'Please keep the details under 300 characters');
    if (!/^\d{1,18}$/.test(req.params.id)) throw bad('id', 'Sale not found');
    if (!Array.isArray(b.items) || !b.items.length) throw bad('items', 'Choose at least one item to return');
    if (b.items.length > 100) throw bad('items', 'Too many lines in one return');
    const want = new Map();                       // sale item id -> quantity to return
    for (const it of b.items) {
      const id = str(it && it.itemId), qty = Number(it && it.qty);
      if (!/^\d{1,18}$/.test(id)) throw bad('items', 'One of the items is not valid');
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6 || Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-6) throw bad('items', 'Enter a valid quantity to return');
      want.set(id, round2((want.get(id) || 0) + qty));
    }
    const reason = RETURN_REASONS[code] + (details ? ' — ' + details : '');

    const result = await tx(async (client) => {
      const sr = await client.query('SELECT sale_id, receipt_no, status, method, created_at FROM pos_sales WHERE sale_id = $1 FOR UPDATE', [req.params.id]);
      if (!sr.rowCount) throw bad('id', 'Sale not found');
      const sale = sr.rows[0];
      if (sale.status !== 'Completed') throw bad('id', sale.status === 'Voided' ? 'This sale was voided, so nothing can be returned' : 'This sale has a void request waiting for Finance, so items cannot be returned');
      if (Date.now() - new Date(sale.created_at).getTime() > RETURN_WINDOW_DAYS * 86400000)
        throw bad('id', `Items can only be returned within ${RETURN_WINDOW_DAYS} days of the sale`);
      const pend = await client.query(`SELECT 1 FROM pos_return_requests WHERE sale_id = $1 AND status = 'pending'`, [sale.sale_id]);
      if (pend.rowCount) throw bad('id', 'This sale already has a return waiting for Finance. Wait for the decision before sending another');
      let shiftId = null;
      if (sale.method === 'Cash') {               // a cash refund comes out of this cashier's drawer, so a shift must be open
        const sh = await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id = $1 AND closed_at IS NULL', [req.user.id]);
        if (!sh.rowCount) throw bad('cashShift', 'Open your Cash Shift first. A cash refund is paid from your drawer.');
        shiftId = sh.rows[0].shift_id;
      }
      const { rows: lines } = await client.query('SELECT item_id, product_id, sku, name, unit, qty, price FROM pos_sale_items WHERE sale_id = $1 ORDER BY item_id', [sale.sale_id]);
      const ret = await returnInfo(client, [sale.sale_id]);
      const chosen = [];
      let cents = 0;
      for (const [id, qty] of want) {
        const line = lines.find(l => String(l.item_id) === id);
        if (!line) throw bad('items', 'One of the items is not on this receipt');
        const done = ret.items.get(id) || { approved: 0, pending: 0 };
        const left = round2(+line.qty - done.approved - done.pending);
        if (qty > left + 1e-9) throw bad('items', left <= 0 ? `${line.name} was already returned` : `Only ${left} ${line.unit} of ${line.name} can still be returned`);
        if (!isMeasured(line.unit) && !Number.isInteger(qty)) throw bad('items', `${line.name} is sold in whole ${line.unit} only`);
        const amount = lineCents(+line.price, qty) / 100;
        cents += Math.round(amount * 100);
        chosen.push({ ...line, qty, amount });
      }
      if (!cents) throw bad('items', 'These items have no value to refund');
      const amount = cents / 100;
      const ins = await client.query(
        `INSERT INTO pos_return_requests (sale_id, reason, amount, refund_method, requested_by, requested_shift_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING return_id`,
        [sale.sale_id, reason, amount, sale.method, req.user.id, shiftId]);
      const returnId = ins.rows[0].return_id;
      for (const c of chosen)
        await client.query(`INSERT INTO pos_return_items (return_id, sale_item_id, product_id, qty, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [returnId, c.item_id, c.product_id, c.qty, c.price, c.amount]);
      await audit(client, req.user, 'Return', `Return RT-${returnId} requested for ${sale.receipt_no}: ${lineText(chosen)} — refund ${peso(amount)} (${sale.method === 'Cash' ? 'cash from drawer' : 'to the original payment'}). ${reason}`);
      return { id: Number(returnId), returnNo: 'RT-' + returnId, amount };
    });
    res.status(201).json(result);
  }));

  const returnJson = (r, items) => ({
    id: Number(r.return_id), returnNo: 'RT-' + r.return_id, status: r.status, reason: r.reason, amount: +r.amount, refundMethod: r.refund_method,
    restock: r.restock === null ? undefined : !!r.restock, note: r.decision_note || undefined, requestedBy: r.requested_by_name || undefined,
    requestedAt: new Date(r.created_at).getTime(), decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : undefined,
    items: items.map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, amount: +i.amount }))
  });

  app.get('/api/pos/return-requests', auth('finance'), wrap(async (req, res) => {
    await posReturnsReady;
    const { rows } = await pool.query(
      `SELECT r.*, s.receipt_no, s.cashier_name, u.full_name AS requested_by_name
         FROM pos_return_requests r JOIN pos_sales s USING (sale_id) LEFT JOIN users u ON u.user_id = r.requested_by
        WHERE r.status = 'pending' ORDER BY r.created_at`);
    const { rows: items } = rows.length ? await pool.query(
      `SELECT ri.return_id, ri.qty, ri.amount, i.sku, i.name, i.unit FROM pos_return_items ri JOIN pos_sale_items i ON i.item_id = ri.sale_item_id
        WHERE ri.return_id = ANY($1) ORDER BY ri.return_item_id`, [rows.map(r => r.return_id)]) : { rows: [] };
    res.json(rows.map(r => ({ ...returnJson(r, items.filter(i => String(i.return_id) === String(r.return_id))), receiptNo: r.receipt_no })));
  }));

  app.post('/api/pos/return-requests/:id/decision', auth('finance'), wrap(async (req, res) => {
    await posReturnsReady;
    const b = req.body || {}, approve = b.approve === true, note = str(b.note);
    const restock = b.restock === undefined ? true : b.restock === true;     // damaged goods can be refunded without going back on the shelf
    if (note.length > 200) throw bad('note', 'The note must be 200 characters or fewer');
    if (!approve && note.length < 5) throw bad('note', 'Please tell the cashier why the return is rejected (at least 5 characters)');
    if (!/^\d{1,18}$/.test(req.params.id)) throw bad('id', 'No pending return with that id');
    await tx(async (client) => {
      const r = await client.query(
        `SELECT r.*, s.receipt_no, s.status AS sale_status, s.method, u.full_name AS requester
           FROM pos_return_requests r JOIN pos_sales s USING (sale_id) LEFT JOIN users u ON u.user_id = r.requested_by
          WHERE r.return_id = $1 AND r.status = 'pending' FOR UPDATE OF r, s`, [req.params.id]);
      if (!r.rowCount) throw bad('id', 'No pending return with that id');
      const ret = r.rows[0], no = 'RT-' + ret.return_id;
      const { rows: items } = await client.query(
        `SELECT ri.product_id, ri.qty, ri.amount, i.sku, i.name, i.unit FROM pos_return_items ri JOIN pos_sale_items i ON i.item_id = ri.sale_item_id
          WHERE ri.return_id = $1 ORDER BY ri.product_id`, [ret.return_id]);
      let shiftId = null;
      if (approve) {
        if (ret.sale_status !== 'Completed') throw bad('id', 'This sale is no longer completed, so the return cannot be approved');
        if (ret.method === 'Cash') {              // the refund is paid from the requesting cashier's open drawer, so it must reduce that shift's expected cash
          const sh = await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id = $1 AND closed_at IS NULL FOR UPDATE', [ret.requested_by]);
          if (!sh.rowCount) throw bad('id', `${ret.requester || 'The cashier'} has no open cash shift, so the cash refund cannot be recorded. Ask them to open a Cash Shift, then approve again`);
          shiftId = sh.rows[0].shift_id;
        }
        if (restock) for (const i of items)
          if (i.product_id) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'return', qty: +i.qty, userId: req.user.id,
            sourceType: 'pos_sale', sourceId: ret.sale_id, note: `Return ${no} of ${ret.receipt_no}` });
      }
      await client.query(
        `UPDATE pos_return_requests SET status = $2, restock = $3, refund_shift_id = $4, decided_by = $5, decision_note = $6, decided_at = now() WHERE return_id = $1`,
        [ret.return_id, approve ? 'approved' : 'rejected', approve ? restock : null, shiftId, req.user.id, note || null]);
      await audit(client, req.user, 'Return', approve
        ? `Return ${no} approved for ${ret.receipt_no}: ${lineText(items)} — refund ${peso(ret.amount)} (${ret.method === 'Cash' ? 'cash, from ' + ret.requester + "'s shift #" + shiftId : 'to the original payment method'}), ${restock ? 'stock restored' : 'not put back in stock'}${note ? '. ' + note : ''}`
        : `Return ${no} rejected for ${ret.receipt_no}: ${note}`);
    });
    res.json({ ok: true });
  }));

  /* =====================================================
     SHOP — customer
  ===================================================== */
  app.get('/api/shop/products', auth('customer'), wrap(async (req, res) => {
    const rows = await catalog();
    // adds minimum order, star rating and "notify me" info (shop-extras.js); the catalog still works if that module is off
    res.json(app.locals.shopExtras ? await app.locals.shopExtras.decorate(rows, req.user) : rows);
  }));
  app.get('/api/shop/config', auth('customer'), (req, res) => res.json({ deliveryFee: DELIVERY_FEE, refundWindowDays: REFUND_WINDOW_DAYS, cancelAutoHours: CANCEL_AUTO_HOURS, cancelReasons: CANCEL_REASONS, info: shopInfo() }));
  // Public: the Help page (delivery, refunds, contact) can be read without signing in. Nothing secret is in here.
  app.get('/api/shop/info', (req, res) => res.json({ deliveryFee: DELIVERY_FEE, refundWindowDays: REFUND_WINDOW_DAYS, cancelAutoHours: CANCEL_AUTO_HOURS, cancelReasons: CANCEL_REASONS, info: shopInfo() }));

  /* ---------- refunds (shared by the customer and finance routes) ---------- */
  // (request_id is BIGSERIAL, which pg returns as text, hence Number())
  const refundJson = (r) => r ? ({
    id: Number(r.request_id), status: r.status, reason: r.reason_code, reasonLabel: REFUND_REASONS[r.reason_code] || r.reason_code,
    details: r.details, amount: +r.amount, decisionNote: r.decision_note || undefined, restocked: !!r.restocked,
    requestedAt: new Date(r.created_at).getTime(), decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : undefined
  }) : null;
  async function refundsFor(ids) {
    if (!ids.length) return new Map();
    const { rows } = await pool.query('SELECT * FROM order_refund_requests WHERE order_id = ANY($1)', [ids]);
    return new Map(rows.map(r => [String(r.order_id), r]));   // keyed as text: order_id may be INT or BIGINT depending on the table
  }
  // the last moment a refund can be requested (the order must be closed: Delivered / Picked Up)
  const refundDeadline = (o) => new Date(o.status_updated_at || o.created_at).getTime() + REFUND_WINDOW_DAYS * 86400000;

  // until this moment a customer can cancel and it is approved immediately
  const instantUntil = (o) => new Date(o.created_at).getTime() + CANCEL_AUTO_HOURS * 3600000;

  const orderJson = (o, items, cancelPending, refund) => ({
    id: o.order_no, createdAt: new Date(o.created_at).getTime(), fulfillment: o.fulfillment, address: o.address || undefined,
    shipTo: o.fulfillment === 'Delivery' && o.city ? { recipient: o.recipient_name, addressLine: o.address_line, landmark: o.landmark || undefined,
      barangay: o.barangay, city: o.city, province: o.province, region: o.region, zip: o.zip_code } : undefined,
    phone: o.phone, method: o.payment_method, subtotal: +o.subtotal, deliveryFee: +o.delivery_fee, total: +o.total, status: o.status, paymentStatus: o.payment_status || 'unpaid',
    cancelRequested: !!cancelPending,
    cancellable: CUSTOMER_CANCELLABLE.includes(o.status) && !cancelPending,
    cancelInstant: CUSTOMER_CANCELLABLE.includes(o.status) && !cancelPending && Date.now() <= instantUntil(o),
    cancelInstantUntil: CUSTOMER_CANCELLABLE.includes(o.status) ? instantUntil(o) : undefined,
    cancelAutoHours: CANCEL_AUTO_HOURS,
    refund: refundJson(refund),
    refundEligible: FINAL_STATUS.includes(o.status) && !refund && Date.now() <= refundDeadline(o),
    refundDeadline: FINAL_STATUS.includes(o.status) ? refundDeadline(o) : undefined,
    refundWindowDays: REFUND_WINDOW_DAYS,
    items: items.map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price }))
  });

  app.get('/api/shop/orders', auth('customer'), wrap(async (req, res) => {
    const { rows: orders } = await pool.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    if (!orders.length) return res.json([]);
    const ids = orders.map(o => o.order_id);
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]);
    const { rows: cr } = await pool.query(`SELECT DISTINCT order_id FROM order_cancel_requests WHERE order_id = ANY($1) AND status = 'pending'`, [ids]);
    const pending = new Set(cr.map(r => r.order_id));
    const refunds = await refundsFor(ids);
    res.json(orders.map(o => orderJson(o, items.filter(i => i.order_id === o.order_id), pending.has(o.order_id), refunds.get(String(o.order_id)))));
  }));

  /* ---------- address book (max 5 saved addresses per customer) ---------- */
  const MAX_ADDRESSES = 5;
  const LABELS = ['Home', 'Work', 'Other'];
  const mobileOf = (v) => str(v).replace(/[\s().-]/g, '');
  const MOBILE_RE = /^(\+63|0)9\d{9}$/;
  const addrJson = (r) => ({
    id: Number(r.address_id), label: r.label, recipient: r.recipient_name, phone: r.phone, addressLine: r.address_line,
    landmark: r.landmark || '', barangay: r.barangay, city: r.city, province: r.province, region: r.region, zip: r.zip_code,
    isDefault: !!r.is_default,
    fullAddress: formatShipTo({ addressLine: r.address_line, barangay: r.barangay, city: r.city, province: r.province, zip: r.zip_code })
  });
  const readLabel = (v) => { const l = str(v) || 'Home'; if (!LABELS.includes(l)) throw bad('label', 'Choose Home, Work or Other'); return l; };
  const readMobile = (v) => { const p = mobileOf(v); if (!MOBILE_RE.test(p)) throw bad('phone', 'Enter a valid mobile number, e.g. 0917 123 4567'); return p; };

  async function insertAddress(client, userId, ship, phone, label, makeDefault) {
    await client.query('SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE', [userId]);     // serialises concurrent saves by the same customer
    const n = (await client.query('SELECT count(*)::int AS n FROM customer_addresses WHERE user_id = $1', [userId])).rows[0].n;
    if (n >= MAX_ADDRESSES) throw bad('address', `You can save up to ${MAX_ADDRESSES} addresses. Delete one first`);
    const isDefault = makeDefault || n === 0;
    if (isDefault) await client.query('UPDATE customer_addresses SET is_default = FALSE WHERE user_id = $1', [userId]);
    const r = await client.query(
      `INSERT INTO customer_addresses (user_id, label, recipient_name, phone, address_line, landmark, barangay, city, province, region, zip_code, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, label, ship.recipient, phone, ship.addressLine, ship.landmark || null, ship.barangay, ship.city, ship.province, ship.region, ship.zip, isDefault]);
    return r.rows[0];
  }

  app.get('/api/shop/addresses', auth('customer'), wrap(async (req, res) => {
    await addressSchemaReady;
    const { rows } = await pool.query('SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.user.id]);
    res.json(rows.map(addrJson));
  }));

  app.post('/api/shop/addresses', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const label = readLabel(b.label), phone = readMobile(b.phone);
    const ship = await validateShipTo(b);
    const row = await tx(async (client) => insertAddress(client, req.user.id, ship, phone, label, b.isDefault === true));
    res.status(201).json(addrJson(row));
  }));

  app.put('/api/shop/addresses/:id', auth('customer'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw bad('id', 'Address not found');
    const b = req.body || {};
    const label = readLabel(b.label), phone = readMobile(b.phone);
    const ship = await validateShipTo(b);
    const row = await tx(async (client) => {
      const cur = await client.query('SELECT * FROM customer_addresses WHERE address_id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id]);
      if (!cur.rowCount) throw bad('id', 'Address not found');
      const makeDefault = b.isDefault === true || (cur.rows[0].is_default && b.isDefault !== false);
      if (makeDefault) await client.query('UPDATE customer_addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
      const r = await client.query(
        `UPDATE customer_addresses SET label=$3, recipient_name=$4, phone=$5, address_line=$6, landmark=$7, barangay=$8, city=$9,
                province=$10, region=$11, zip_code=$12, is_default=$13 WHERE address_id=$1 AND user_id=$2 RETURNING *`,
        [id, req.user.id, label, ship.recipient, phone, ship.addressLine, ship.landmark || null, ship.barangay, ship.city, ship.province, ship.region, ship.zip, makeDefault]);
      return r.rows[0];
    });
    res.json(addrJson(row));
  }));

  app.post('/api/shop/addresses/:id/default', auth('customer'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const cur = await client.query('SELECT 1 FROM customer_addresses WHERE address_id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id]);
      if (!cur.rowCount) throw bad('id', 'Address not found');
      await client.query('UPDATE customer_addresses SET is_default = (address_id = $1) WHERE user_id = $2', [id, req.user.id]);
    });
    res.json({ ok: true });
  }));

  app.delete('/api/shop/addresses/:id', auth('customer'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const del = await client.query('DELETE FROM customer_addresses WHERE address_id = $1 AND user_id = $2 RETURNING is_default', [id, req.user.id]);
      if (!del.rowCount) throw bad('id', 'Address not found');
      if (del.rows[0].is_default)       // keep one default: promote the newest remaining address
        await client.query(`UPDATE customer_addresses SET is_default = TRUE WHERE address_id =
          (SELECT address_id FROM customer_addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`, [req.user.id]);
    });
    res.json({ ok: true });
  }));

  app.post('/api/shop/orders', auth('customer'), wrap(async (req, res) => {
    await addressSchemaReady;
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && /^[a-zA-Z0-9-]{12,100}$/.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'Sale request identifier is required. Refresh the POS page.');
    const lines = readLines(b.items);
    const fulfillment = str(b.fulfillment);
    if (!['Delivery', 'Pickup'].includes(fulfillment)) throw bad('fulfillment', 'Choose Delivery or Pickup');
    const cashMethod = fulfillment === 'Delivery' ? 'Cash on Delivery' : 'Cash on Pickup';
    const method = str(b.method);
    if (![...ONLINE_METHODS, cashMethod].includes(method)) throw bad('method', 'Choose a valid payment method');
    const phone = readMobile(b.phone);
    // Delivery needs a full structured address (street line + region / province / city / barangay / ZIP, checked against PSGC + the ZIP list)
    const ship = fulfillment === 'Delivery' ? await validateShipTo(b.shipTo || {}) : null;
    const saveLabel = ship && b.saveAddress === true ? readLabel(b.addressLabel) : null;

    const order = await tx(async (client) => {
      // No stock lock here: stock is only deducted when Finance confirms the order. This just refuses what is clearly unavailable.
      const items = await loadSellable(client, lines, { lock: false });
      if (app.locals.shopExtras) await app.locals.shopExtras.checkMinimums(client, items);   // minimum order per product
      const subtotal = round2(items.reduce((n, i) => n + i.price * i.qty, 0));
      const fee = fulfillment === 'Delivery' ? DELIVERY_FEE : 0;
      const ins = await client.query(
        `INSERT INTO orders (customer_id, fulfillment, address, phone, payment_method, subtotal, delivery_fee, total,
                             recipient_name, address_line, landmark, barangay, city, province, region, zip_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [req.user.id, fulfillment, ship ? ship.fullAddress + (ship.landmark ? ` (Landmark: ${ship.landmark})` : '') : null, phone, method, subtotal, fee, round2(subtotal + fee),
         ship && ship.recipient, ship && ship.addressLine, ship && ship.landmark || null, ship && ship.barangay, ship && ship.city, ship && ship.province, ship && ship.region, ship && ship.zip]);
      const o = ins.rows[0];
      for (const i of items) await client.query(
        `INSERT INTO order_items (order_id, product_id, sku, name, unit, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.order_id, i.product_id, i.sku, i.name, i.unit, i.qty, i.price]);
      // optional: remember this address for next time (skipped silently when the address book is full)
      if (saveLabel) {
        try { await client.query('SAVEPOINT save_addr'); await insertAddress(client, req.user.id, ship, phone, saveLabel, b.makeDefault === true); }
        catch (err) { if (!(err instanceof ValidationError)) throw err; await client.query('ROLLBACK TO SAVEPOINT save_addr'); }
      }
      await audit(client, req.user, 'Record added', `Online order ${o.order_no} — ${peso(o.total)} (${method}, ${fulfillment})`);
      return orderJson(o, items, false, null);
    });
    res.status(201).json(order);
    notify(order.id, 'placed');
  }));

  app.post('/api/shop/orders/:no/cancel-request', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const code = str(b.reason), details = str(b.details);
    if (!CANCEL_REASONS[code]) throw bad('reason', 'Choose the reason for cancelling');
    if (code === 'other' && details.length < 5) throw bad('details', 'Please tell us the reason (at least 5 characters)');
    if (details.length > 300) throw bad('details', 'Please keep the details under 300 characters');
    const reason = CANCEL_REASONS[code] + (details ? ' \u2014 ' + details : '');
    let instant = false;
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 AND customer_id = $2 FOR UPDATE', [req.params.no, req.user.id]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (o.status === 'Cancelled') throw bad('id', 'This order is already cancelled');
      if (!CUSTOMER_CANCELLABLE.includes(o.status)) throw bad('id', 'We are already preparing or have finished this order, so it can no longer be cancelled here. Please contact us if you need help');
      const dup = await client.query(`SELECT 1 FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`, [o.order_id]);
      if (dup.rowCount) throw bad('id', 'You already asked to cancel this order. Our team is reviewing it');
      instant = Date.now() <= instantUntil(o);
      if (instant) {
        // inside the free-cancel window: cancelled right away, stock goes back if it was already taken
        if (o.stock_deducted) {
          const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
          for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'refund', qty: +i.qty,
            userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Cancelled ${o.order_no}` });
        }
        await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
        await client.query(`INSERT INTO order_cancel_requests (order_id, reason, reason_code, requested_by, status, auto_approved, decided_at) VALUES ($1,$2,$3,$4,'approved',TRUE,now())`,
          [o.order_id, reason, code, req.user.id]);
        await logStatus(client, o.order_id, o.status, 'Cancelled', req.user.id, 'Cancelled by customer: ' + reason);
        await audit(client, req.user, 'Record edited', `Order ${o.order_no} cancelled by the customer (within ${CANCEL_AUTO_HOURS} h): ${reason}${o.stock_deducted ? ' \u2014 stock restored, refund to original payment method due' : ''}`);
      } else {
        await client.query('INSERT INTO order_cancel_requests (order_id, reason, reason_code, requested_by) VALUES ($1,$2,$3,$4)', [o.order_id, reason, code, req.user.id]);
        await audit(client, req.user, 'Record edited', `Cancellation requested for ${o.order_no}: ${reason}`);
      }
    });
    res.status(201).json({ ok: true, cancelled: instant });
    if (instant) notify(req.params.no, 'Cancelled', { reason });
  }));

  // Customer asks for a refund on a finished order (Delivered / Picked Up) inside the refund window. One request per order.
  app.post('/api/shop/orders/:no/refund-request', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const code = str(b.reason), details = str(b.details);
    if (!REFUND_REASONS[code]) throw bad('reason', 'Choose the reason for your refund request');
    if (details.length < 5 || details.length > 300) throw bad('details', 'Please describe the problem (5 to 300 characters)');
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 AND customer_id = $2 FOR UPDATE', [req.params.no, req.user.id]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (!FINAL_STATUS.includes(o.status))
        throw bad('id', 'You can ask for a refund once the order is delivered or picked up. Before that, you can request a cancellation instead');
      const dup = await client.query('SELECT 1 FROM order_refund_requests WHERE order_id = $1', [o.order_id]);
      if (dup.rowCount) throw bad('id', 'A refund request was already sent for this order');
      if (Date.now() > refundDeadline(o)) throw bad('id', `The ${REFUND_WINDOW_DAYS}-day refund period for this order has ended`);
      await client.query(
        `INSERT INTO order_refund_requests (order_id, reason_code, details, amount, requested_by) VALUES ($1,$2,$3,$4,$5)`,
        [o.order_id, code, details, o.total, req.user.id]);
      await audit(client, req.user, 'Record edited', `Refund requested for ${o.order_no} (${peso(o.total)}): ${REFUND_REASONS[code]} — ${details}`);
    });
    res.status(201).json({ ok: true });
  }));

  /* ---------- finance: confirm orders, decide cancellations ---------- */
  app.get('/api/orders', auth('finance'), wrap(async (req, res) => {
    const { rows: orders } = await pool.query(
      `SELECT o.*, u.full_name AS customer, u.phone AS customer_phone, u.email AS customer_email FROM orders o JOIN users u ON u.user_id = o.customer_id ORDER BY o.created_at DESC LIMIT 200`);
    const ids = orders.map(o => o.order_id);
    const { rows: items } = ids.length ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]) : { rows: [] };
    const { rows: cr } = ids.length ? await pool.query(`SELECT DISTINCT order_id FROM order_cancel_requests WHERE order_id = ANY($1) AND status = 'pending'`, [ids]) : { rows: [] };
    const pending = new Set(cr.map(r => r.order_id));
    const refunds = await refundsFor(ids);
    res.json(orders.map(o => {
      const flow = FLOW[o.fulfillment] || [], at = flow.indexOf(o.status);
      return { ...orderJson(o, items.filter(i => i.order_id === o.order_id), pending.has(o.order_id), refunds.get(String(o.order_id))), customer: o.customer,
        // account owner (read live from the account) and, for Delivery, the recipient saved on the order
        customerPhone: o.customer_phone || undefined, customerEmail: o.customer_email || undefined,
        recipient: o.fulfillment === 'Delivery' ? (o.recipient_name || undefined) : undefined,
        recipientPhone: o.fulfillment === 'Delivery' ? o.phone : undefined,
        flow,                                                            // the steps this order goes through (Delivery or Pickup)
        next: at >= 0 && at < flow.length - 1 ? flow[at + 1] : null,     // the one step Finance can do next
        canCancel: ADMIN_CANCELLABLE.includes(o.status) };
    }));
  }));

  // Confirm = payment received (online: gateway confirmed / COD: cash collected). Posts the stock-out.
  app.post('/api/orders/:no/confirm', auth('finance'), wrap(async (req, res) => {
    await tx(async (client) => {
      const r = await client.query(`SELECT * FROM orders WHERE order_no = $1 FOR UPDATE`, [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (o.status !== 'Pending Confirmation') throw bad('id', `Order is already ${o.status}`);
      await confirmOrder(client, o, req.user);
    });
    res.json({ ok: true });
    notify(req.params.no, 'Paid');
  }));

  app.post('/api/orders/:no/cancel-decision', auth('finance'), wrap(async (req, res) => {
    const approve = (req.body || {}).approve === true;
    await tx(async (client) => {
      const r = await client.query(`SELECT * FROM orders WHERE order_no = $1 FOR UPDATE`, [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      const q = await client.query(`SELECT request_id FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending' FOR UPDATE`, [o.order_id]);
      if (!q.rowCount) throw bad('id', 'There is no pending cancellation request for this order');
      if (approve) {
        if (!['Pending Confirmation', 'Paid'].includes(o.status)) throw bad('id', 'This order is already packed, so it cannot be cancelled');
        if (o.stock_deducted) {
          const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
          for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'refund', qty: +i.qty,
            userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Cancelled ${o.order_no}` });
        }
        await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
        await logStatus(client, o.order_id, o.status, 'Cancelled', req.user.id, 'Customer cancellation approved');
      }
      await client.query(`UPDATE order_cancel_requests SET status = $2, decided_by = $3, decided_at = now() WHERE request_id = $1`,
        [q.rows[0].request_id, approve ? 'approved' : 'rejected', req.user.id]);
      await audit(client, req.user, 'Record edited', `Cancellation ${approve ? 'approved' : 'rejected'} for ${o.order_no}${approve && o.stock_deducted ? ' — stock restored, refund to original payment method due' : ''}`);
    });
    res.json({ ok: true });
    notify(req.params.no, approve ? 'Cancelled' : 'cancel_declined');
  }));
  /* ---------- finance: review refund requests ---------- */
  app.get('/api/refund-requests', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.*, o.order_no, o.total AS order_total, o.fulfillment, o.payment_method, o.phone, o.status AS order_status,
              u.full_name AS customer, du.full_name AS decided_by_name
         FROM order_refund_requests r
         JOIN orders o ON o.order_id = r.order_id
         LEFT JOIN users u ON u.user_id = o.customer_id
         LEFT JOIN users du ON du.user_id = r.decided_by
        ORDER BY (r.status = 'pending') DESC, COALESCE(r.decided_at, r.created_at) DESC
        LIMIT 100`);
    const ids = rows.map(r => r.order_id);
    const { rows: items } = ids.length ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]) : { rows: [] };
    res.json(rows.map(r => ({
      ...refundJson(r), orderNo: r.order_no, customer: r.customer || 'Customer', phone: r.phone, fulfillment: r.fulfillment,
      method: r.payment_method, orderTotal: +r.order_total, orderStatus: r.order_status, decidedBy: r.decided_by_name || undefined,
      items: items.filter(i => String(i.order_id) === String(r.order_id)).map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price }))
    })));
  }));

  // Approve (optionally put the goods back in stock and refund less than the full total) or reject (a reason is required).
  app.post('/api/orders/:no/refund-decision', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const approve = b.approve === true, restock = b.restock === true, note = str(b.note);
    if (note.length > 300) throw bad('note', 'The note must be 300 characters or fewer');
    if (!approve && note.length < 5) throw bad('note', 'Tell the customer why the request is declined (at least 5 characters)');
    let refundAmount = 0;
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      const q = await client.query(`SELECT * FROM order_refund_requests WHERE order_id = $1 AND status = 'pending' FOR UPDATE`, [o.order_id]);
      if (!q.rowCount) throw bad('id', 'There is no pending refund request for this order');
      let amount = +q.rows[0].amount;
      refundAmount = amount;
      if (approve && b.amount !== undefined && b.amount !== null && b.amount !== '') {
        amount = Number(b.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > +o.total || round2(amount) !== amount)
          throw bad('amount', `Enter a refund amount between ${peso(0.01)} and ${peso(o.total)}`);
        refundAmount = amount;
      }
      if (approve && restock) {
        if (!o.stock_deducted) throw bad('restock', 'Stock was never taken out for this order, so there is nothing to put back');
        const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
        for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'return', qty: +i.qty,
          userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Refund of ${o.order_no}` });
      }
      await client.query(
        `UPDATE order_refund_requests SET status = $2, amount = $3, restocked = $4, decision_note = $5, decided_by = $6, decided_at = now() WHERE request_id = $1`,
        [q.rows[0].request_id, approve ? 'approved' : 'rejected', amount, approve && restock, note || null, req.user.id]);
      await logStatus(client, o.order_id, o.status, o.status, req.user.id,
        approve ? `Refund approved — ${peso(amount)}${restock ? ', items back in stock' : ''}${note ? ' — ' + note : ''}` : `Refund declined — ${note}`);
      await audit(client, req.user, 'Record edited',
        approve ? `Refund approved for ${o.order_no} — ${peso(amount)} due to the customer's original payment method${restock ? '; stock restored' : ''}`
                : `Refund declined for ${o.order_no}: ${note}`);
    });
    res.json({ ok: true });
    notify(req.params.no, approve ? 'refund_approved' : 'refund_declined', { note, amount: refundAmount });
  }));

  /* =====================================================
     SALES TRANSACTIONS (admin) — every POS sale and every online order in one list
  ===================================================== */
  const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { (m.get(r[key]) || m.set(r[key], []).get(r[key])).push(r); } return m; };
  const lineJson = (i) => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price, cost: +i.cost });
  const money = (lines) => {
    const revenue = round2(lines.reduce((n, i) => n + i.qty * i.price, 0));
    const cost = round2(lines.reduce((n, i) => n + i.qty * i.cost, 0));
    return { revenue, cost, profit: round2(revenue - cost) };
  };

  app.get('/api/sales', auth('finance'), wrap(async (req, res) => {
    const [pos, ord] = await Promise.all([
      pool.query('SELECT * FROM pos_sales ORDER BY created_at DESC LIMIT 500'),
      pool.query(`SELECT o.*, u.full_name AS customer FROM orders o LEFT JOIN users u ON u.user_id = o.customer_id ORDER BY o.created_at DESC LIMIT 500`)]);
    const posIds = pos.rows.map(s => s.sale_id), ordIds = ord.rows.map(o => o.order_id);
    const q = (sql, ids) => (ids.length ? pool.query(sql, [ids]) : Promise.resolve({ rows: [] }));
    const refundBy = await refundsFor(ordIds);
    await posReturnsReady;
    const [posItems, ordItems, voids, cancels, hist, posReturns, posReturnLines] = await Promise.all([
      q(`SELECT i.sale_id, i.item_id, i.sku, i.name, i.unit, i.qty, i.price, COALESCE(p.unit_cost, 0) AS cost
           FROM pos_sale_items i LEFT JOIN products p ON p.product_id = i.product_id WHERE i.sale_id = ANY($1) ORDER BY i.item_id`, posIds),
      q(`SELECT i.order_id, i.sku, i.name, i.unit, i.qty, i.price, COALESCE(p.unit_cost, 0) AS cost
           FROM order_items i LEFT JOIN products p ON p.product_id = i.product_id WHERE i.order_id = ANY($1) ORDER BY i.item_id`, ordIds),
      q(`SELECT request_id, sale_id, reason FROM void_requests WHERE status = 'pending' AND sale_id = ANY($1)`, posIds),
      q(`SELECT order_id, reason FROM order_cancel_requests WHERE status = 'pending' AND order_id = ANY($1)`, ordIds),
      q(`SELECT h.order_id, h.from_status, h.to_status, h.note, h.created_at, u.full_name AS changed_by_name
           FROM order_status_history h LEFT JOIN users u ON u.user_id = h.changed_by
          WHERE h.order_id = ANY($1) ORDER BY h.created_at, h.history_id`, ordIds),
      q(`SELECT r.*, u.full_name AS requested_by_name FROM pos_return_requests r LEFT JOIN users u ON u.user_id = r.requested_by
          WHERE r.sale_id = ANY($1) ORDER BY r.created_at, r.return_id`, posIds),
      q(`SELECT ri.return_id, ri.sale_item_id, ri.qty, ri.amount, i.sku, i.name, i.unit FROM pos_return_items ri
           JOIN pos_sale_items i ON i.item_id = ri.sale_item_id JOIN pos_return_requests r ON r.return_id = ri.return_id
          WHERE r.sale_id = ANY($1) ORDER BY ri.return_item_id`, posIds)]);
    const retLinesBy = groupBy(posReturnLines.rows, 'return_id'), retBySale = groupBy(posReturns.rows, 'sale_id');
    const pItems = groupBy(posItems.rows, 'sale_id'), oItems = groupBy(ordItems.rows, 'order_id');
    const voidBy = new Map(voids.rows.map(v => [v.sale_id, v])), cancelBy = new Map(cancels.rows.map(c => [c.order_id, c]));
    const histBy = groupBy(hist.rows, 'order_id');

    const out = [];
    for (const s of pos.rows) {
      const v = voidBy.get(s.sale_id), rets = (retBySale.get(s.sale_id) || []).map(r => returnJson(r, retLinesBy.get(r.return_id) || []));
      // Items, total and profit are what the shop actually kept: lines already returned (approved) are taken off, so reports stay correct.
      const gone = new Map();
      for (const r of retBySale.get(s.sale_id) || []) if (r.status === 'approved')
        for (const l of retLinesBy.get(r.return_id) || []) gone.set(String(l.sale_item_id), round2((gone.get(String(l.sale_item_id)) || 0) + +l.qty));
      const refunded = round2(rets.filter(r => r.status === 'approved').reduce((n, r) => n + r.amount, 0));
      const kept = (pItems.get(s.sale_id) || []).map(i => ({ ...i, qty: round2(+i.qty - (gone.get(String(i.item_id)) || 0)) })).filter(i => i.qty > 0);
      const items = kept.map(lineJson);
      const net = round2(+s.total - refunded);
      const pending = rets.find(r => r.status === 'pending');
      out.push({
        source: 'POS', ref: s.receipt_no, createdAt: new Date(s.created_at).getTime(), customer: 'Walk-in customer', fulfillment: 'Walk-in',
        method: s.method, subtotal: net, deliveryFee: 0, total: net, vat: refunded ? round2(net * VAT_RATE / (1 + VAT_RATE)) : +s.vat, status: s.status, cashier: s.cashier_name,
        tendered: s.tendered === null ? undefined : +s.tendered, change: s.change_given === null ? undefined : +s.change_given, cardRef: s.card_ref || undefined,
        items, ...money(items), next: null, canCancel: false, history: [],
        originalTotal: +s.total, refunded, returns: rets, returnRequest: pending || null,
        voidRequest: v ? { id: v.request_id, reason: v.reason } : null
      });
    }
    for (const o of ord.rows) {
      const items = (oItems.get(o.order_id) || []).map(lineJson), c = cancelBy.get(o.order_id), flow = FLOW[o.fulfillment] || [];
      const at = flow.indexOf(o.status);
      out.push({
        source: 'Shop', ref: o.order_no, createdAt: new Date(o.created_at).getTime(), customer: o.customer || 'Customer', phone: o.phone,
        address: o.address || undefined, fulfillment: o.fulfillment, method: o.payment_method, subtotal: +o.subtotal, deliveryFee: +o.delivery_fee,
        total: +o.total, status: o.status, receivedBy: o.received_by || undefined, items, ...money(items),
        next: at >= 0 && at < flow.length - 1 ? flow[at + 1] : null,
        canCancel: ADMIN_CANCELLABLE.includes(o.status),
        cancelRequest: c ? { reason: c.reason } : null,
        refund: refundJson(refundBy.get(String(o.order_id))),
        history: (histBy.get(o.order_id) || []).map(h => ({ from: h.from_status, to: h.to_status, note: h.note || undefined, by: h.changed_by_name || 'System', at: new Date(h.created_at).getTime() }))
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ flow: FLOW, sales: out });
  }));

  // Move an online order one step forward: Paid -> Packed -> Out for Delivery / Ready for Pickup -> Delivered / Picked Up.
  app.post('/api/orders/:no/status', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const target = str(b.status), note = str(b.note), receivedBy = str(b.receivedBy);
    if (!target) throw bad('status', 'Choose the new status');
    if (note.length > 200) throw bad('note', 'The note must be 200 characters or fewer');
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0], flow = FLOW[o.fulfillment];
      if (!flow) throw bad('id', 'This order has no delivery or pickup type, so its status cannot be changed');
      if (o.status === 'Cancelled') throw bad('status', 'This order was cancelled and can no longer be changed');
      if (FINAL_STATUS.includes(o.status)) throw bad('status', `This order is already ${o.status} and is closed`);
      const at = flow.indexOf(o.status);
      if (at < 0) throw bad('status', `The current status "${o.status}" is not recognised`);
      const pend = await client.query(`SELECT 1 FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`, [o.order_id]);
      if (pend.rowCount) throw bad('status', 'The customer asked to cancel this order. Approve or reject that request first');
      const next = flow[at + 1];
      if (target !== next) throw bad('status', flow.includes(target)
        ? `The next step for this order is "${next}". Steps cannot be skipped or moved backwards`
        : `"${target}" is not a ${o.fulfillment.toLowerCase()} status`);
      if (FINAL_STATUS.includes(target) && (receivedBy.length < 2 || receivedBy.length > 80))
        throw bad('receivedBy', `Enter the name of the person who ${o.fulfillment === 'Delivery' ? 'received' : 'picked up'} the order (2–80 characters)`);

      if (target === 'Paid') await confirmOrder(client, o, req.user, note);   // also deducts stock and writes its own history line
      else {
        if (!o.stock_deducted) throw bad('status', 'Stock has not been deducted for this order. Contact the system administrator');
        await client.query('UPDATE orders SET status = $2, status_updated_at = now(), received_by = COALESCE($3, received_by) WHERE order_id = $1',
          [o.order_id, target, FINAL_STATUS.includes(target) ? receivedBy : null]);
        await logStatus(client, o.order_id, o.status, target, req.user.id, FINAL_STATUS.includes(target) ? [`Received by ${receivedBy}`, note].filter(Boolean).join(' — ') : note);
        await audit(client, req.user, 'Record edited', `Order ${o.order_no} moved from ${o.status} to ${target}`);
      }
    });
    res.json({ ok: true });
    notify(req.params.no, target);
  }));

  // Admin cancels an order directly (reason required). Stock goes back if it was already deducted.
  app.post('/api/orders/:no/cancel', auth('finance'), wrap(async (req, res) => {
    const reason = str((req.body || {}).reason);
    if (reason.length < 5 || reason.length > 300) throw bad('reason', 'Please explain why (5 to 300 characters)');
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (o.status === 'Cancelled') throw bad('id', 'This order is already cancelled');
      if (FINAL_STATUS.includes(o.status)) throw bad('id', `This order was already ${o.status.toLowerCase()}, so it cannot be cancelled. Handle it as a return instead`);
      if (!ADMIN_CANCELLABLE.includes(o.status)) throw bad('id', `An order that is "${o.status}" can no longer be cancelled`);
      if (o.stock_deducted) {
        const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
        for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'refund', qty: +i.qty,
          userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Cancelled ${o.order_no}` });
      }
      await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
      await client.query(`UPDATE order_cancel_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE order_id = $1 AND status = 'pending'`, [o.order_id, req.user.id]);
      await logStatus(client, o.order_id, o.status, 'Cancelled', req.user.id, reason);
      await audit(client, req.user, 'Record edited', `Order ${o.order_no} cancelled by admin: ${reason}${o.stock_deducted ? ' — stock restored, refund to original payment method due' : ''}`);
    });
    res.json({ ok: true });
    notify(req.params.no, 'Cancelled', { reason });
  }));
};