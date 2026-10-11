/* pos-shop.js — POS (cashier) and online shop (customer) routes.
   Mounted from server.js:  require('./pos-shop')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ });

   Rules enforced here (not in the browser):
   - Only products in the "Finished Goods" department, not archived, with a selling price > 0, can be listed or sold.
   - Prices always come from the database; the browser only sends {sku, qty}.
   - Stock changes only through stock_movements (the DB trigger updates products.on_hand and blocks overselling).
   - Cost / margin / supplier data is never sent to cashiers or customers. */

const FG = 'Finished Goods';
const VAT_RATE = 0.12;
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE) || 150;
const ONLINE_METHODS = ['Online Banking', 'E-Wallet', 'Card'];
// Status path for each order type. Finance moves an order one step at a time; the customer sees the same status.
const FLOW = {
  Delivery: ['Pending Confirmation', 'Paid', 'Packed', 'Out for Delivery', 'Delivered'],
  Pickup:   ['Pending Confirmation', 'Paid', 'Packed', 'Ready for Pickup', 'Picked Up']
};
const nextStatus = (o) => { const f = FLOW[o.fulfillment] || []; const i = f.indexOf(o.status); return i >= 0 && i < f.length - 1 ? f[i + 1] : null; };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

module.exports = function mount({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });

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
        tendered = Number(b.tendered);
        if (!Number.isFinite(tendered) || tendered < total) throw bad('tendered', 'Cash received is less than the total');
        change = round2(tendered - total);
      } else {
        cardRef = str(b.cardRef);
        if (cardRef.length < 4 || cardRef.length > 40) throw bad('cardRef', 'Enter the card approval / reference number');
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
      await client.query(`UPDATE void_requests SET status = $2, decided_by = $3, decided_at = now() WHERE request_id = $1`,
        [r.rows[0].request_id, approve ? 'approved' : 'rejected', req.user.id]);
      await audit(client, req.user, 'Record edited', `Void ${approve ? 'approved' : 'rejected'} for ${receipt_no}${approve ? ' — stock restored' : ''}`);
    });
    res.json({ ok: true });
  }));

  /* =====================================================
     SHOP — customer
  ===================================================== */
  app.get('/api/shop/products', auth('customer'), wrap(async (req, res) => res.json(await catalog())));

  const orderJson = (o, items, cancelPending) => ({
    id: o.order_no, createdAt: new Date(o.created_at).getTime(), fulfillment: o.fulfillment, address: o.address || undefined,
    phone: o.phone, method: o.payment_method, subtotal: +o.subtotal, deliveryFee: +o.delivery_fee, total: +o.total, status: o.status,
    cancelRequested: !!cancelPending,
    items: items.map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price }))
  });

  app.get('/api/shop/orders', auth('customer'), wrap(async (req, res) => {
    const { rows: orders } = await pool.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    if (!orders.length) return res.json([]);
    const ids = orders.map(o => o.order_id);
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]);
    const { rows: cr } = await pool.query(`SELECT DISTINCT order_id FROM order_cancel_requests WHERE order_id = ANY($1) AND status = 'pending'`, [ids]);
    const pending = new Set(cr.map(r => r.order_id));
    res.json(orders.map(o => orderJson(o, items.filter(i => i.order_id === o.order_id), pending.has(o.order_id))));
  }));

  app.post('/api/shop/orders', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const lines = readLines(b.items);
    const fulfillment = str(b.fulfillment);
    if (!['Delivery', 'Pickup'].includes(fulfillment)) throw bad('fulfillment', 'Choose Delivery or Pickup');
    const cashMethod = fulfillment === 'Delivery' ? 'Cash on Delivery' : 'Cash on Pickup';
    const method = str(b.method);
    if (![...ONLINE_METHODS, cashMethod].includes(method)) throw bad('method', 'Choose a valid payment method');
    const phone = str(b.phone).replace(/[\s().-]/g, '');
    if (!/^(\+63|0)9\d{9}$/.test(phone)) throw bad('phone', 'Enter a valid mobile number, e.g. 0917 123 4567');
    const address = fulfillment === 'Delivery' ? str(b.address) : null;
    if (fulfillment === 'Delivery' && (address.length < 8 || address.length > 300)) throw bad('address', 'Enter your full delivery address');

    const order = await tx(async (client) => {
      // No stock lock here: stock is only deducted when Finance confirms the order. This just refuses what is clearly unavailable.
      const items = await loadSellable(client, lines, { lock: false });
      const subtotal = round2(items.reduce((n, i) => n + i.price * i.qty, 0));
      const fee = fulfillment === 'Delivery' ? DELIVERY_FEE : 0;
      const ins = await client.query(
        `INSERT INTO orders (customer_id, fulfillment, address, phone, payment_method, subtotal, delivery_fee, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.id, fulfillment, address, phone, method, subtotal, fee, round2(subtotal + fee)]);
      const o = ins.rows[0];
      for (const i of items) await client.query(
        `INSERT INTO order_items (order_id, product_id, sku, name, unit, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.order_id, i.product_id, i.sku, i.name, i.unit, i.qty, i.price]);
      await audit(client, req.user, 'Record added', `Online order ${o.order_no} — ${peso(o.total)} (${method}, ${fulfillment})`);
      return orderJson(o, items, false);
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

  /* ---------- finance: confirm orders, decide cancellations ---------- */
  app.get('/api/orders', auth('finance'), wrap(async (req, res) => {
    const { rows: orders } = await pool.query(
      `SELECT o.*, u.full_name AS customer FROM orders o JOIN users u ON u.user_id = o.customer_id ORDER BY o.created_at DESC LIMIT 200`);
    const ids = orders.map(o => o.order_id);
    const { rows: items } = ids.length ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]) : { rows: [] };
    const { rows: cr } = ids.length ? await pool.query(`SELECT DISTINCT order_id FROM order_cancel_requests WHERE order_id = ANY($1) AND status = 'pending'`, [ids]) : { rows: [] };
    const pending = new Set(cr.map(r => r.order_id));
    res.json(orders.map(o => ({ ...orderJson(o, items.filter(i => i.order_id === o.order_id), pending.has(o.order_id)), customer: o.customer, next: nextStatus(o) })));
  }));

  // Move an order to its next status. Pending Confirmation -> Paid means payment was received (online: gateway confirmed /
  // COD: cash collected) and posts the stock-out. Later steps only change the status the customer sees.
  const advanceOrder = wrap(async (req, res) => {
    const result = await tx(async (client) => {
      const r = await client.query(`SELECT * FROM orders WHERE order_no = $1 FOR UPDATE`, [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      const next = nextStatus(o);
      if (!next) throw bad('id', `Order is already ${o.status}`);
      const asked = str((req.body || {}).status);
      if (asked && asked !== next) throw bad('status', `The next step for this order is "${next}"`);
      const pend = await client.query(`SELECT 1 FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`, [o.order_id]);
      if (pend.rowCount) throw bad('id', 'The customer asked to cancel this order. Approve or reject that request first');
      if (o.status === 'Pending Confirmation') {
        const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
        for (const i of items) await postMovement(client, { productId: i.product_id, type: 'out', reason: 'online_order', qty: +i.qty,
          userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: o.order_no });   // trigger rejects if stock ran out
        await client.query(`UPDATE orders SET status = $2, stock_deducted = TRUE WHERE order_id = $1`, [o.order_id, next]);
      } else {
        await client.query(`UPDATE orders SET status = $2 WHERE order_id = $1`, [o.order_id, next]);
      }
      await audit(client, req.user, 'Record edited', `Order ${o.order_no}: ${o.status} → ${next}${o.status === 'Pending Confirmation' ? ' (stock deducted)' : ''}`);
      return { status: next, next: nextStatus({ ...o, status: next }) };
    });
    res.json(result);
  });
  app.post('/api/orders/:no/advance', auth('finance'), advanceOrder);
  app.post('/api/orders/:no/confirm', auth('finance'), advanceOrder);   // kept for older callers

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
        await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE WHERE order_id = $1`, [o.order_id]);
      }
      await client.query(`UPDATE order_cancel_requests SET status = $2, decided_by = $3, decided_at = now() WHERE request_id = $1`,
        [q.rows[0].request_id, approve ? 'approved' : 'rejected', req.user.id]);
      await audit(client, req.user, 'Record edited', `Cancellation ${approve ? 'approved' : 'rejected'} for ${o.order_no}${approve && o.stock_deducted ? ' — stock restored, refund to original payment method due' : ''}`);
    });
    res.json({ ok: true });
  }));
};
