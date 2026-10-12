const FG = 'Finished Goods';
const VAT_RATE = 0.12;
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE) || 150;
const ONLINE_METHODS = ['Online Banking', 'E-Wallet', 'Card'];
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

module.exports = function mount({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ, validateShipTo, formatShipTo }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });

  // Adds what the Sales Transactions page needs (safe to run every time the server starts).
  async function ensureSalesSchema() {
    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS received_by TEXT');
      // cashier alert: a decided void request stays "unseen" until the cashier acknowledges it (old rows default to seen)
      await pool.query('ALTER TABLE void_requests ADD COLUMN IF NOT EXISTS cashier_seen BOOLEAN NOT NULL DEFAULT TRUE');
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
    } catch (err) { console.warn('[db] could not prepare the sales tables:', err.message); }
  }
  ensureSalesSchema();

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
           p.selling_price, p.on_hand, p.reorder_level
      FROM products p LEFT JOIN categories c USING (category_id)
     WHERE p.department = $1 AND NOT p.is_archived AND p.selling_price > 0
     ORDER BY COALESCE(c.name, 'Uncategorized'), p.name`;
  const catalogJson = (r) => ({
    sku: r.sku, name: r.name, category: r.category, unit: r.unit,
    spec: [r.grade, r.form].filter(Boolean).join(' · '),
    price: +r.selling_price, available: +r.on_hand, low: +r.reorder_level
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
        WHERE upper(sku) = ANY($1) AND department = $2 AND NOT is_archived AND selling_price > 0
        ORDER BY product_id ${lock ? 'FOR UPDATE' : ''}`, [[...lines.keys()], FG]);
    const bySku = new Map(rows.map(r => [r.sku.toUpperCase(), r]));
    const out = [];
    for (const [sku, qty] of lines) {
      const p = bySku.get(sku);
      if (!p) throw bad('items', `${sku} is not available for sale`);
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

  const saleJson = (s, items) => ({
    id: String(s.sale_id), receiptNo: s.receipt_no, total: +s.total, vat: +s.vat, method: s.method,
    tendered: s.tendered === null ? undefined : +s.tendered, change: s.change_given === null ? undefined : +s.change_given,
    cardRef: s.card_ref || undefined, cashierName: s.cashier_name, createdAt: new Date(s.created_at).getTime(), status: s.status,
    items: items.map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price }))
  });

  app.post('/api/pos/sales', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {};
    const lines = readLines(b.items);
    const method = str(b.method);
    if (!['Cash', 'Card'].includes(method)) throw bad('method', 'Choose Cash or Card');

    const sale = await tx(async (client) => {
      const items = await loadSellable(client, lines, { lock: true });
      const total = round2(items.reduce((n, i) => n + i.price * i.qty, 0));
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
        `INSERT INTO pos_sales (cashier_id, cashier_name, method, total, vat, tendered, change_given, card_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.id, req.user.name, method, total, vat, tendered, change, cardRef]);
      const s = ins.rows[0];
      for (const i of items) {
        await client.query(
          `INSERT INTO pos_sale_items (sale_id, product_id, sku, name, unit, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [s.sale_id, i.product_id, i.sku, i.name, i.unit, i.qty, i.price]);
        await postMovement(client, { productId: i.product_id, type: 'out', reason: 'sale', qty: i.qty, userId: req.user.id,
          sourceType: 'pos_sale', sourceId: s.sale_id, note: s.receipt_no });
      }
      await audit(client, req.user, 'Record added', `POS sale ${s.receipt_no} — ${peso(total)} (${method}), ${items.length} line(s)`);
      return saleJson(s, items);
    });
    res.status(201).json(sale);
  }));

  // Sales list (Manila time). Default = today. ?date=YYYY-MM-DD shows another day, ?receipt=TEXT searches receipt numbers on any day.
  // Cashiers can look back LOOKBACK_DAYS (so a customer returning with an old receipt can be found); finance has no limit.
  const LOOKBACK_DAYS = Number(process.env.POS_LOOKBACK_DAYS) || 60;
  app.get('/api/pos/sales', auth('cashier', 'finance'), wrap(async (req, res) => {
    const isFinance = req.user.role === 'finance';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    const q = String(req.query.receipt || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);
    const params = [TZ], where = [];
    if (q) { params.push('%' + q + '%'); where.push(`s.receipt_no ILIKE $${params.length}`); }
    else { params.push(date); where.push(`(s.created_at AT TIME ZONE $1)::date = COALESCE($${params.length}::date, (now() AT TIME ZONE $1)::date)`); }
    if (!isFinance) where.push(`(s.created_at AT TIME ZONE $1)::date >= (now() AT TIME ZONE $1)::date - ${LOOKBACK_DAYS}`);
    const { rows: sales } = await pool.query(`SELECT s.* FROM pos_sales s WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 200`, params);
    const { rows: items } = sales.length
      ? await pool.query('SELECT * FROM pos_sale_items WHERE sale_id = ANY($1) ORDER BY item_id', [sales.map(s => s.sale_id)])
      : { rows: [] };
    res.json(sales.map(s => saleJson(s, items.filter(i => i.sale_id === s.sale_id))));
  }));

  app.post('/api/pos/sales/:id/void-request', auth('cashier'), wrap(async (req, res) => {
    const reason = str((req.body || {}).reason);
    if (reason.length < 5 || reason.length > 300) throw bad('reason', 'Please explain why (at least 5 characters)');
    await tx(async (client) => {
      const r = await client.query('SELECT sale_id, receipt_no, status FROM pos_sales WHERE sale_id = $1 FOR UPDATE', [req.params.id]);
      if (!r.rowCount) throw bad('id', 'Sale not found');
      if (r.rows[0].status !== 'Completed') throw bad('id', 'This sale already has a void request or is voided');
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
      await client.query(`UPDATE void_requests SET status = $2, decided_by = $3, decided_at = now(), cashier_seen = FALSE WHERE request_id = $1`,
        [r.rows[0].request_id, approve ? 'approved' : 'rejected', req.user.id]);
      await audit(client, req.user, 'Record edited', `Void ${approve ? 'approved' : 'rejected'} for ${receipt_no}${approve ? ' — stock restored' : ''}`);
    });
    res.json({ ok: true });
  }));

  /* ---------- cashier: alerts for decided void requests ---------- */
  // Decisions on this cashier's own void requests that they have not acknowledged yet.
  app.get('/api/pos/void-notices', auth('cashier'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT v.request_id, v.status, v.reason, s.receipt_no, s.total,
              to_char(v.decided_at AT TIME ZONE $2, 'HH12:MI AM') AS decided_at, u.name AS decided_by_name
         FROM void_requests v JOIN pos_sales s USING (sale_id) LEFT JOIN users u ON u.user_id = v.decided_by
        WHERE v.requested_by = $1 AND v.status IN ('approved','rejected') AND v.cashier_seen = FALSE
        ORDER BY v.decided_at`, [req.user.id, TZ]);
    res.json(rows.map(r => ({ id: r.request_id, receiptNo: r.receipt_no, total: +r.total, approved: r.status === 'approved',
      reason: r.reason, decidedAt: r.decided_at, decidedBy: r.decided_by_name || 'Admin' })));
  }));
  app.post('/api/pos/void-notices/seen', auth('cashier'), wrap(async (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    if (ids.length) await pool.query('UPDATE void_requests SET cashier_seen = TRUE WHERE requested_by = $1 AND request_id = ANY($2)', [req.user.id, ids]);
    res.json({ ok: true });
  }));

  /* =====================================================
     SHOP — customer
  ===================================================== */
  app.get('/api/shop/products', auth('customer'), wrap(async (req, res) => res.json(await catalog())));
  app.get('/api/shop/config', auth('customer'), (req, res) => res.json({ deliveryFee: DELIVERY_FEE, refundWindowDays: REFUND_WINDOW_DAYS }));

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

  const orderJson = (o, items, cancelPending, refund) => ({
    id: o.order_no, createdAt: new Date(o.created_at).getTime(), fulfillment: o.fulfillment, address: o.address || undefined,
    shipTo: o.fulfillment === 'Delivery' && o.city ? { recipient: o.recipient_name, addressLine: o.address_line, landmark: o.landmark || undefined,
      barangay: o.barangay, city: o.city, province: o.province, region: o.region, zip: o.zip_code } : undefined,
    phone: o.phone, method: o.payment_method, subtotal: +o.subtotal, deliveryFee: +o.delivery_fee, total: +o.total, status: o.status,
    cancelRequested: !!cancelPending,
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
  }));

  app.post('/api/shop/orders/:no/cancel-request', auth('customer'), wrap(async (req, res) => {
    const reason = str((req.body || {}).reason);
    if (reason.length < 5 || reason.length > 300) throw bad('reason', 'Please explain why (at least 5 characters)');
    await tx(async (client) => {
      const r = await client.query('SELECT order_id, order_no, status FROM orders WHERE order_no = $1 AND customer_id = $2 FOR UPDATE', [req.params.no, req.user.id]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (!['Pending Confirmation', 'Paid'].includes(o.status)) throw bad('id', 'This order is already packed or finished, so it can no longer be cancelled');
      const dup = await client.query(`SELECT 1 FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`, [o.order_id]);
      if (dup.rowCount) throw bad('id', 'A cancellation request is already waiting for approval');
      await client.query('INSERT INTO order_cancel_requests (order_id, reason, requested_by) VALUES ($1,$2,$3)', [o.order_id, reason, req.user.id]);
      await audit(client, req.user, 'Record edited', `Cancellation requested for ${o.order_no}: ${reason}`);
    });
    res.status(201).json({ ok: true });
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
      `SELECT o.*, u.full_name AS customer FROM orders o JOIN users u ON u.user_id = o.customer_id ORDER BY o.created_at DESC LIMIT 200`);
    const ids = orders.map(o => o.order_id);
    const { rows: items } = ids.length ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]) : { rows: [] };
    const { rows: cr } = ids.length ? await pool.query(`SELECT DISTINCT order_id FROM order_cancel_requests WHERE order_id = ANY($1) AND status = 'pending'`, [ids]) : { rows: [] };
    const pending = new Set(cr.map(r => r.order_id));
    const refunds = await refundsFor(ids);
    res.json(orders.map(o => ({ ...orderJson(o, items.filter(i => i.order_id === o.order_id), pending.has(o.order_id), refunds.get(String(o.order_id))), customer: o.customer })));
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
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      const q = await client.query(`SELECT * FROM order_refund_requests WHERE order_id = $1 AND status = 'pending' FOR UPDATE`, [o.order_id]);
      if (!q.rowCount) throw bad('id', 'There is no pending refund request for this order');
      let amount = +q.rows[0].amount;
      if (approve && b.amount !== undefined && b.amount !== null && b.amount !== '') {
        amount = Number(b.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > +o.total || round2(amount) !== amount)
          throw bad('amount', `Enter a refund amount between ${peso(0.01)} and ${peso(o.total)}`);
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
    const [posItems, ordItems, voids, cancels, hist] = await Promise.all([
      q(`SELECT i.sale_id, i.sku, i.name, i.unit, i.qty, i.price, COALESCE(p.unit_cost, 0) AS cost
           FROM pos_sale_items i LEFT JOIN products p ON p.product_id = i.product_id WHERE i.sale_id = ANY($1) ORDER BY i.item_id`, posIds),
      q(`SELECT i.order_id, i.sku, i.name, i.unit, i.qty, i.price, COALESCE(p.unit_cost, 0) AS cost
           FROM order_items i LEFT JOIN products p ON p.product_id = i.product_id WHERE i.order_id = ANY($1) ORDER BY i.item_id`, ordIds),
      q(`SELECT request_id, sale_id, reason FROM void_requests WHERE status = 'pending' AND sale_id = ANY($1)`, posIds),
      q(`SELECT order_id, reason FROM order_cancel_requests WHERE status = 'pending' AND order_id = ANY($1)`, ordIds),
      q(`SELECT h.order_id, h.from_status, h.to_status, h.note, h.created_at, u.full_name AS changed_by_name
           FROM order_status_history h LEFT JOIN users u ON u.user_id = h.changed_by
          WHERE h.order_id = ANY($1) ORDER BY h.created_at, h.history_id`, ordIds)]);
    const pItems = groupBy(posItems.rows, 'sale_id'), oItems = groupBy(ordItems.rows, 'order_id');
    const voidBy = new Map(voids.rows.map(v => [v.sale_id, v])), cancelBy = new Map(cancels.rows.map(c => [c.order_id, c]));
    const histBy = groupBy(hist.rows, 'order_id');

    const out = [];
    for (const s of pos.rows) {
      const items = (pItems.get(s.sale_id) || []).map(lineJson), v = voidBy.get(s.sale_id);
      out.push({
        source: 'POS', ref: s.receipt_no, createdAt: new Date(s.created_at).getTime(), customer: 'Walk-in customer', fulfillment: 'Walk-in',
        method: s.method, subtotal: +s.total, deliveryFee: 0, total: +s.total, vat: +s.vat, status: s.status, cashier: s.cashier_name,
        tendered: s.tendered === null ? undefined : +s.tendered, change: s.change_given === null ? undefined : +s.change_given, cardRef: s.card_ref || undefined,
        items, ...money(items), next: null, canCancel: false, history: [],
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
  }));
};