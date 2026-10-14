/* shop-extras.js — extras for a metal-products shop:
     1. Request a quote           customer form -> Finance (list, reply, close)
     2. Minimum order             products.min_order_qty (set by Finance in the product form), enforced on online orders
     3. Back-in-stock alerts      customer taps "Notify me" on an out-of-stock item; an email goes out when stock returns
     4. Verified reviews          only customers whose order is Delivered / Picked Up; Finance can hide a review

   Mounted in server.js:   require('./shop-extras')({ app, pool, auth, wrap, tx, audit, ValidationError, str });
   Like the other modules it creates its own tables on start (safe to run every time); 006_shop_extras.sql is the same
   thing for running by hand.  pos-shop.js calls app.locals.shopExtras.decorate / checkMinimums, and both fail soft:
   if these tables could not be created, the shop and the POS keep working without the extras. */
const mailer = require('./mailer');
const makeOrderMail = require('./order-mail');
const { escapeHtml: esc } = mailer;

const FINAL_STATUS = ['Delivered', 'Picked Up'];
const MOBILE_RE = /^(\+63|0)9\d{9}$/;
const NAME_RE = /^[\p{L}][\p{L}\p{M}\s.,'\u2019-]*$/u;
const MAX_OPEN_QUOTES = 5;           // a customer can have this many un-answered requests at once
const BACK_IN_STOCK_DAYS = 7;        // how long the "Back in stock" tag shows for a customer who asked to be told

module.exports = function mountShopExtras({ app, pool, auth, wrap, tx, audit, ValidationError, str }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const { shopInfo } = makeOrderMail(pool);
  const baseUrl = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ms = (d) => (d ? new Date(d).getTime() : undefined);

  /* ---------------- schema ---------------- */
  const ready = (async () => {
    try {
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order_qty NUMERIC(14,2) NOT NULL DEFAULT 1 CHECK (min_order_qty > 0)');
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS quote_no_seq START 1001`);
      await pool.query(`CREATE TABLE IF NOT EXISTS quote_requests (
        quote_id      BIGSERIAL PRIMARY KEY,
        quote_no      TEXT UNIQUE NOT NULL DEFAULT ('QR-' || nextval('quote_no_seq')),
        customer_id   INT NOT NULL REFERENCES users(user_id),
        contact_name  TEXT NOT NULL,
        phone         TEXT NOT NULL,
        product_sku   TEXT,
        product_name  TEXT,
        quantity      TEXT NOT NULL,
        details       TEXT NOT NULL,
        needed_by     DATE,
        fulfillment   TEXT CHECK (fulfillment IN ('Delivery','Pickup')),
        area          TEXT,
        status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','quoted','closed')),
        quoted_amount NUMERIC(14,2) CHECK (quoted_amount >= 0),
        reply_note    TEXT,
        handled_by    INT REFERENCES users(user_id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quote_requests (customer_id, created_at DESC)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_quotes_status ON quote_requests (status, created_at DESC)');
      // walk-in customers logged at the POS have no shop account
      await pool.query('ALTER TABLE quote_requests ALTER COLUMN customer_id DROP NOT NULL');
      await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'shop'`);
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(user_id)');
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_alerts (
        alert_id    BIGSERIAL PRIMARY KEY,
        user_id     INT NOT NULL REFERENCES users(user_id),
        product_id  INT NOT NULL REFERENCES products(product_id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        notified_at TIMESTAMPTZ,
        UNIQUE (user_id, product_id))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS product_reviews (
        review_id     BIGSERIAL PRIMARY KEY,
        product_id    INT NOT NULL REFERENCES products(product_id),
        user_id       INT NOT NULL REFERENCES users(user_id),
        order_id      BIGINT NOT NULL,
        rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        body          TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
        hidden_by     INT REFERENCES users(user_id),
        hidden_at     TIMESTAMPTZ,
        hidden_reason TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, product_id))`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews (product_id, status, created_at DESC)');
      console.log('[shop] quotes / reviews / stock alerts schema ready');
    } catch (err) { console.warn('[shop] could not prepare the quotes / reviews / stock alerts schema:', err.message); }
  })();
  const whenReady = (req, res, next) => { ready.then(() => next(), next); };
  ['/api/shop/quotes', '/api/shop/reviews', '/api/shop/my-reviews', '/api/shop/stock-alerts', '/api/finance/quotes', '/api/finance/reviews', '/api/pos/quotes']
    .forEach((p) => app.use(p, whenReady));

  /* ---------------- mail (never blocks or fails a request) ---------------- */
  async function send(to, subject, lines, tag) {
    try {
      if (!to) return;
      const text = lines.join('\n');
      const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">' +
        lines.map((l) => (l ? '<p style="margin:0 0 10px">' + esc(l) + '</p>' : '')).join('') + '</div>';
      const r = await mailer.sendMail({ to, subject, html, text, tag });
      if (!r.sent) console.warn(`[mail] "${subject}" not sent: ${r.reason}`);
    } catch (err) { console.error(`[mail] "${subject}" failed:`, err.message); }
  }
  const signoff = () => { const i = shopInfo() || {}; return ['', 'Triple E Metal Products', [i.phone, i.email].filter(Boolean).join(' \u00B7 ')]; };

  /* =====================================================
     1. Request a quote
  ===================================================== */
  const quoteJson = (q) => ({
    id: q.quote_no, status: q.status, product: q.product_name || undefined, sku: q.product_sku || undefined,
    quantity: q.quantity, details: q.details, neededBy: q.needed_by ? String(q.needed_by).slice(0, 10) : undefined,
    fulfillment: q.fulfillment || undefined, area: q.area || undefined,
    quotedAmount: q.quoted_amount == null ? undefined : +q.quoted_amount, replyNote: q.reply_note || undefined,
    source: q.source || 'shop', createdAt: ms(q.created_at), updatedAt: ms(q.updated_at)
  });

  // Checks a quote request body (shop customer or POS walk-in) and returns the clean values, or throws a field error.
  async function readQuote(b, { fallbackName, userId }) {
    const contactName = str(b.contactName) || fallbackName;
    if (!contactName) throw bad('contactName', 'Enter the customer\u2019s name');
    if (contactName.length < 2 || contactName.length > 80 || !NAME_RE.test(contactName)) throw bad('contactName', 'Enter your full name (letters only)');
    const phone = str(b.phone).replace(/[\s().-]/g, '');
    if (!phone) throw bad('phone', 'Enter your mobile number so we can reach you');
    if (!MOBILE_RE.test(phone)) throw bad('phone', 'Enter a valid mobile number, e.g. 0917 123 4567');
    const quantity = str(b.quantity);
    if (!quantity) throw bad('quantity', 'Tell us how much you need, e.g. 200 sheets');
    if (quantity.length > 60) throw bad('quantity', 'Please keep the quantity short, e.g. 200 sheets');
    if (!(parseFloat(quantity.replace(/,/g, '').match(/\d+(\.\d+)?/) || [0])[0] > 0)) throw bad('quantity', 'Start with a number greater than 0, e.g. 200 sheets');
    const details = str(b.details);
    if (details.length < 10 || details.length > 2000) throw bad('details', 'Describe what you need (sizes, thickness, finish) in at least 10 characters');
    let neededBy = null;
    if (str(b.neededBy)) {
      const d = str(b.neededBy);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw bad('neededBy', 'Choose a valid date');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });      // YYYY-MM-DD in Philippine time
      const limit = new Date(Date.parse(today) + 730 * 86400000).toISOString().slice(0, 10);
      if (d < today) throw bad('neededBy', 'The date cannot be in the past');
      if (d > limit) throw bad('neededBy', 'Choose a date within the next 2 years');
      neededBy = d;
    }

    // delivery or pickup is required; delivery needs an address (a saved one, or the city and barangay typed in)
    const fulfillment = str(b.fulfillment);
    if (!['Delivery', 'Pickup'].includes(fulfillment)) throw bad('fulfillment', 'Choose delivery or pickup');
    let area = null;
    if (fulfillment === 'Delivery') {
      if (userId && b.addressId !== undefined && b.addressId !== null && b.addressId !== '') {
        const id = Number(b.addressId);
        if (!Number.isInteger(id)) throw bad('address', 'Choose where it should be delivered');
        const a = (await pool.query('SELECT * FROM customer_addresses WHERE address_id = $1 AND user_id = $2', [id, userId])).rows[0];
        if (!a) throw bad('address', 'That saved address was not found. Please choose another');
        area = [a.address_line, a.barangay && (/^(brgy|barangay)/i.test(a.barangay) ? a.barangay : 'Brgy. ' + a.barangay), a.city, a.province, a.zip_code].filter(Boolean).join(', ');
      } else {
        const city = str(b.city), barangay = str(b.barangay), street = str(b.street);
        if (city.length < 2 || city.length > 60 || !/\p{L}/u.test(city)) throw bad('city', 'Enter the city or municipality');
        if (barangay.length < 2 || barangay.length > 60 || !/\p{L}/u.test(barangay)) throw bad('barangay', 'Enter the barangay');
        if (street && (street.length < 5 || street.length > 100)) throw bad('street', 'Enter the house no. and street (5 to 100 characters), or leave it empty');
        area = [street, /^(brgy|barangay)/i.test(barangay) ? barangay : 'Brgy. ' + barangay, city].filter(Boolean).join(', ');
      }
      area = area.slice(0, 250);
    }

    let sku = null, productName = str(b.productName).slice(0, 120) || null;
    if (str(b.sku)) {
      const p = (await pool.query(`SELECT sku, name FROM products WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [str(b.sku).toUpperCase()])).rows[0];
      if (!p) throw bad('sku', 'That product is not available');
      sku = p.sku; productName = p.name;
    } else if (!productName || productName.length < 3) throw bad('productName', 'Tell us what you need (at least 3 characters)');
    return { contactName, phone, quantity, details, neededBy, fulfillment, area, sku, productName };
  }

  app.post('/api/shop/quotes', auth('customer'), wrap(async (req, res) => {
    const { contactName, phone, quantity, details, neededBy, fulfillment, area, sku, productName } = await readQuote(req.body || {}, { fallbackName: req.user.name, userId: req.user.id });
    const open = (await pool.query(`SELECT count(*)::int AS n FROM quote_requests WHERE customer_id = $1 AND status = 'new'`, [req.user.id])).rows[0].n;
    if (open >= MAX_OPEN_QUOTES) throw bad('quote', `You already have ${open} requests waiting for an answer. Please wait for our reply first`);

    const row = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO quote_requests (customer_id, contact_name, phone, product_sku, product_name, quantity, details, needed_by, fulfillment, area)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.id, contactName, phone, sku, productName, quantity, details, neededBy, fulfillment, area]);
      await audit(client, req.user, 'Record added', `Quote request ${r.rows[0].quote_no}${productName ? ' \u2014 ' + productName : ''} (${quantity})`);
      return r.rows[0];
    });
    res.status(201).json(quoteJson(row));

    // email: a copy to the customer and a heads-up to Finance (fire-and-forget)
    (async () => {
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [req.user.id])).rows[0];
      await send(u && u.email, `We received your quote request ${row.quote_no}`, [
        `Hi ${contactName},`, `Thank you for your request. We will send you a quote soon.`, '',
        `Reference: ${row.quote_no}`, `Item: ${productName || 'See details'}`, `Quantity: ${quantity}`, ...signoff()], 'quote-received');
      const to = process.env.QUOTE_EMAIL || (shopInfo() || {}).email;
      if (to) await send(to, `New quote request ${row.quote_no} from ${contactName}`, [
        `Customer: ${contactName} (${phone})`, `Item: ${productName || 'See details'}`, `Quantity: ${quantity}`,
        neededBy ? `Needed by: ${neededBy}` : '', `Receive by: ${fulfillment}${area ? ' \u00B7 ' + area : ''}`, '', details, '',
        `Open Finance > Quote Requests${baseUrl() ? ' at ' + baseUrl() + '/Finance_Inventory.html' : ''} to reply.`], 'quote-new');
      else console.warn('[shop] new quote request ' + row.quote_no + ' saved. Set QUOTE_EMAIL or SHOP_EMAIL in .env to get an email for each request');
    })().catch((e) => console.error('[mail] quote emails failed:', e.message));
  }));

  app.get('/api/shop/quotes', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM quote_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json(rows.map(quoteJson));
  }));

  /* ---- walk-in customers: the cashier logs the request, Finance prices it, the cashier tells the customer ---- */
  const MAX_OPEN_POS_QUOTES = 50;
  app.post('/api/pos/quotes', auth('cashier'), wrap(async (req, res) => {
    const { contactName, phone, quantity, details, neededBy, fulfillment, area, sku, productName } = await readQuote(req.body || {}, { fallbackName: '', userId: null });
    const open = (await pool.query(`SELECT count(*)::int AS n FROM quote_requests WHERE source = 'pos' AND status = 'new'`)).rows[0].n;
    if (open >= MAX_OPEN_POS_QUOTES) throw bad('quote', 'There are too many walk-in requests waiting for Finance. Please ask Finance to answer them first');
    const row = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO quote_requests (customer_id, source, created_by, contact_name, phone, product_sku, product_name, quantity, details, needed_by, fulfillment, area)
         VALUES (NULL,'pos',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.id, contactName, phone, sku, productName, quantity, details, neededBy, fulfillment, area]);
      await audit(client, req.user, 'Record added', `Walk-in quote request ${r.rows[0].quote_no}${productName ? ' \u2014 ' + productName : ''} (${quantity}) for ${contactName}`);
      return r.rows[0];
    });
    res.status(201).json({ ...quoteJson(row), customer: row.contact_name, phone: row.phone });
    (async () => {
      const to = process.env.QUOTE_EMAIL || (shopInfo() || {}).email;
      if (!to) return;
      await send(to, `Walk-in quote request ${row.quote_no} from ${contactName}`, [
        `Walk-in customer: ${contactName} (${phone}) \u2014 logged at the counter by ${req.user.name || 'a cashier'}`, `Item: ${productName || 'See details'}`, `Quantity: ${quantity}`,
        neededBy ? `Needed by: ${neededBy}` : '', `Receive by: ${fulfillment}${area ? ' \u00B7 ' + area : ''}`, '', details, '',
        `This customer has no online account. Open Finance > Quote Requests to price it, then the cashier or Finance calls them.`], 'quote-new');
    })().catch((e) => console.error('[mail] walk-in quote email failed:', e.message));
  }));

  // everything logged at the counter, newest first, so any cashier can answer "did my quote come back?"
  app.get('/api/pos/quotes', auth('cashier'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT q.*, c.full_name AS created_by_name FROM quote_requests q LEFT JOIN users c ON c.user_id = q.created_by
        WHERE q.source = 'pos' ORDER BY (q.status = 'quoted') DESC, q.created_at DESC LIMIT 60`);
    res.json(rows.map((q) => ({ ...quoteJson(q), customer: q.contact_name, phone: q.phone, loggedBy: q.created_by_name || undefined })));
  }));

  app.get('/api/finance/quotes', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT q.*, u.email AS customer_email, h.full_name AS handled_by_name
         FROM quote_requests q LEFT JOIN users u ON u.user_id = q.customer_id LEFT JOIN users h ON h.user_id = q.handled_by
        ORDER BY (q.status = 'new') DESC, q.created_at DESC LIMIT 300`);
    res.json(rows.map((q) => ({ ...quoteJson(q), customer: q.contact_name, phone: q.phone, email: q.customer_email, handledBy: q.handled_by_name || undefined })));
  }));

  app.post('/api/finance/quotes/:no', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const status = str(b.status), note = str(b.note);
    if (!['new', 'quoted', 'closed'].includes(status)) throw bad('status', 'Choose a status');
    if (note.length > 1500) throw bad('note', 'The note is too long (max 1500 characters)');
    let amount = null;
    if (b.amount !== undefined && b.amount !== null && String(b.amount).trim() !== '') {
      amount = Number(String(b.amount).replace(/[,\u20B1\s]/g, ''));
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) throw bad('amount', 'Enter a valid amount');
      amount = Math.round(amount * 100) / 100;
    }
    if (status === 'quoted' && note.length < 5) throw bad('note', 'Write the quote or reply for the customer (at least 5 characters)');
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      const r = await client.query(
        `UPDATE quote_requests SET status = $2, reply_note = $3, quoted_amount = $4, handled_by = $5, updated_at = now() WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, status, note || cur.reply_note, amount !== null ? amount : cur.quoted_amount, req.user.id]);
      await audit(client, req.user, 'Record edited', `Quote request ${cur.quote_no} marked ${status}${amount !== null ? ' (' + peso(amount) + ')' : ''}`);
      return r.rows[0];
    });
    res.json({ ok: true });
    if (status !== 'new' && note) (async () => {
      if (!q.customer_id) return;                       // walk-in from the POS: Finance replies by phone
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      await send(u && u.email, status === 'quoted' ? `Your quote ${q.quote_no} is ready` : `Update on your quote request ${q.quote_no}`, [
        `Hi ${q.contact_name},`, status === 'quoted' ? 'Here is our reply to your quote request.' : 'We have an update on your quote request.', '',
        ...(q.quoted_amount != null ? [`Quoted amount: ${peso(q.quoted_amount)}`] : []), q.reply_note, ...signoff()], 'quote-reply');
    })().catch((e) => console.error('[mail] quote reply failed:', e.message));
  }));

  /* =====================================================
     2. Minimum order
  ===================================================== */
  // items = rows from loadSellable (product_id, name, unit, qty, on_hand). The minimum never exceeds what is in stock,
  // so a customer can always buy the last few units.
  async function checkMinimums(client, items) {
    try {
      await ready;
      const { rows } = await client.query('SELECT product_id, min_order_qty FROM products WHERE product_id = ANY($1)', [items.map((i) => i.product_id)]);
      const min = new Map(rows.map((r) => [r.product_id, +r.min_order_qty]));
      for (const i of items) {
        const m = Math.min(min.get(i.product_id) || 1, +i.on_hand);
        if (+i.qty < m) throw bad('items', `${i.name}: the minimum order is ${m} ${i.unit}`);
      }
    } catch (err) { if (err instanceof ValidationError) throw err; console.warn('[shop] minimum order check skipped:', err.message); }
  }

  /* =====================================================
     3. Back-in-stock alerts
  ===================================================== */
  app.get('/api/shop/stock-alerts', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.sku FROM stock_alerts a JOIN products p ON p.product_id = a.product_id WHERE a.user_id = $1 AND a.notified_at IS NULL`, [req.user.id]);
    res.json(rows.map((r) => r.sku));
  }));
  app.post('/api/shop/stock-alerts', auth('customer'), wrap(async (req, res) => {
    const p = (await pool.query(
      `SELECT product_id, name, on_hand FROM products WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived AND selling_price > 0 AND shop_visible = TRUE`,
      [str(req.body && req.body.sku).toUpperCase()])).rows[0];
    if (!p) throw bad('sku', 'That product is not available');
    if (+p.on_hand > 0) throw bad('sku', `${p.name} is in stock right now`);
    await pool.query(
      `INSERT INTO stock_alerts (user_id, product_id) VALUES ($1,$2)
       ON CONFLICT (user_id, product_id) DO UPDATE SET notified_at = NULL, created_at = now()`, [req.user.id, p.product_id]);
    res.status(201).json({ ok: true });
  }));
  app.delete('/api/shop/stock-alerts/:sku', auth('customer'), wrap(async (req, res) => {
    await pool.query(
      `DELETE FROM stock_alerts WHERE user_id = $1 AND product_id IN (SELECT product_id FROM products WHERE upper(sku) = $2)`,
      [req.user.id, String(req.params.sku).toUpperCase()]);
    res.json({ ok: true });
  }));

  // Claims every waiting alert whose product is available again (the UPDATE claims them, so two server instances never send twice).
  let lastCheck = 0, checking = false;
  async function checkAlerts() {
    if (checking) return;
    checking = true; lastCheck = Date.now();
    try {
      await ready;
      const { rows } = await pool.query(
        `UPDATE stock_alerts SET notified_at = now()
          WHERE alert_id IN (SELECT a.alert_id FROM stock_alerts a JOIN products p ON p.product_id = a.product_id
                              WHERE a.notified_at IS NULL AND p.on_hand > 0
                                AND NOT p.is_archived AND p.shop_visible FOR UPDATE OF a SKIP LOCKED)
        RETURNING user_id, product_id`);
      for (const r of rows) {
        const x = (await pool.query(
          `SELECT u.email, u.full_name, p.name, p.unit, p.selling_price FROM users u, products p WHERE u.user_id = $1 AND p.product_id = $2`,
          [r.user_id, r.product_id])).rows[0];
        if (x) await send(x.email, `${x.name} is back in stock`, [
          `Hi ${x.full_name},`, `Good news: ${x.name} is available again at ${peso(x.selling_price)} per ${x.unit}.`,
          'Stock can run out quickly, so order soon.', baseUrl() ? `Shop: ${baseUrl()}/Shop_Customer.html` : '', ...signoff()], 'back-in-stock');
      }
      if (rows.length) console.log(`[shop] sent ${rows.length} back-in-stock email(s)`);
    } catch (err) { console.warn('[shop] back-in-stock check failed:', err.message); }
    finally { checking = false; }
  }
  setInterval(checkAlerts, 60 * 1000).unref();   // also runs when the shop is opened (below), because Cloud Run may sleep between visits

  /* =====================================================
     4. Reviews
  ===================================================== */
  const maskName = (n) => { const p = String(n || '').trim().split(/\s+/).filter(Boolean); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : (p[0] || 'Customer'); };
  const productBySku = async (sku) => (await pool.query(
    `SELECT product_id, sku, name FROM products WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [String(sku).toUpperCase()])).rows[0];
  // The order that lets this customer review this product: delivered / picked up, and it contains the product.
  const eligibleOrder = async (userId, productId) => (await pool.query(
    `SELECT o.order_id, o.order_no FROM orders o JOIN order_items i ON i.order_id = o.order_id
      WHERE o.customer_id = $1 AND i.product_id = $2 AND o.status = ANY($3)
      ORDER BY o.status_updated_at DESC NULLS LAST, o.order_id DESC LIMIT 1`, [userId, productId, FINAL_STATUS])).rows[0];

  app.get('/api/shop/my-reviews', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.sku, r.rating, r.status FROM product_reviews r JOIN products p ON p.product_id = r.product_id WHERE r.user_id = $1`, [req.user.id]);
    res.json(rows);
  }));

  app.get('/api/shop/reviews/:sku', auth('customer', 'finance'), wrap(async (req, res) => {
    const p = await productBySku(req.params.sku);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const [{ rows: list }, { rows: agg }] = await Promise.all([
      pool.query(`SELECT r.review_id, r.rating, r.body, r.created_at, r.user_id, u.full_name
                    FROM product_reviews r JOIN users u ON u.user_id = r.user_id
                   WHERE r.product_id = $1 AND r.status = 'visible' ORDER BY r.created_at DESC LIMIT 100`, [p.product_id]),
      pool.query(`SELECT rating, count(*)::int AS n FROM product_reviews WHERE product_id = $1 AND status = 'visible' GROUP BY rating`, [p.product_id])]);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let count = 0, sum = 0;
    for (const a of agg) { dist[a.rating] = a.n; count += a.n; sum += a.rating * a.n; }
    const out = {
      summary: { average: count ? Math.round((sum / count) * 10) / 10 : 0, count, distribution: dist },
      reviews: list.map((r) => ({ id: Number(r.review_id), rating: r.rating, body: r.body, author: maskName(r.full_name), createdAt: ms(r.created_at), mine: r.user_id === req.user.id })),
      canReview: false, reviewed: false
    };
    if (req.user.role === 'customer') {
      const mine = (await pool.query('SELECT status FROM product_reviews WHERE user_id = $1 AND product_id = $2', [req.user.id, p.product_id])).rows[0];
      out.reviewed = !!mine; out.myReviewHidden = !!mine && mine.status === 'hidden';
      out.canReview = !mine && !!(await eligibleOrder(req.user.id, p.product_id));
    }
    res.json(out);
  }));

  app.post('/api/shop/reviews', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const p = await productBySku(str(b.sku));
    if (!p) throw bad('sku', 'Product not found');
    const rating = Number(b.rating), body = str(b.body);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('rating', 'Choose 1 to 5 stars');
    if (body.length > 1000) throw bad('body', 'Your review is too long (max 1000 characters)');
    const order = await eligibleOrder(req.user.id, p.product_id);
    if (!order) throw bad('sku', 'You can review a product after your order with it is Delivered or Picked Up');
    const r = await pool.query(
      `INSERT INTO product_reviews (product_id, user_id, order_id, rating, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, product_id) DO NOTHING RETURNING review_id`,
      [p.product_id, req.user.id, order.order_id, rating, body]);
    if (!r.rowCount) throw bad('sku', 'You have already reviewed this product');
    res.status(201).json({ ok: true });
  }));

  // Finance: see every review (visible and hidden), hide or restore one.
  app.get('/api/finance/reviews', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.review_id, r.rating, r.body, r.status, r.created_at, r.hidden_at, r.hidden_reason, p.sku, p.name AS product, u.full_name, u.email, o.order_no, h.full_name AS hidden_by_name
         FROM product_reviews r JOIN products p ON p.product_id = r.product_id JOIN users u ON u.user_id = r.user_id
         LEFT JOIN orders o ON o.order_id = r.order_id LEFT JOIN users h ON h.user_id = r.hidden_by
        ORDER BY r.created_at DESC LIMIT 500`);
    res.json(rows.map((r) => ({ id: Number(r.review_id), rating: r.rating, body: r.body, status: r.status, product: r.product, sku: r.sku,
      customer: r.full_name, email: r.email, orderNo: r.order_no || undefined, createdAt: ms(r.created_at),
      hiddenAt: ms(r.hidden_at), hiddenReason: r.hidden_reason || undefined, hiddenBy: r.hidden_by_name || undefined })));
  }));
  app.post('/api/finance/reviews/:id/visibility', auth('finance'), wrap(async (req, res) => {
    const hide = !!(req.body && req.body.hidden), reason = str(req.body && req.body.reason);
    if (hide && reason.length < 3) throw bad('reason', 'Write a short reason for hiding this review');
    if (reason.length > 300) throw bad('reason', 'The reason is too long (max 300 characters)');
    if (!/^\d{1,15}$/.test(req.params.id)) throw bad('id', 'Review not found');
    await tx(async (client) => {
      const r = await client.query(
        `UPDATE product_reviews SET status = $2, hidden_by = $3, hidden_at = $4, hidden_reason = $5 WHERE review_id = $1
         RETURNING review_id, product_id`,
        [req.params.id, hide ? 'hidden' : 'visible', hide ? req.user.id : null, hide ? new Date() : null, hide ? reason : null]);
      if (!r.rowCount) throw bad('id', 'Review not found');
      await audit(client, req.user, 'Record edited', `Review #${r.rows[0].review_id} ${hide ? 'hidden' : 'restored'}${hide ? ' \u2014 ' + reason : ''}`);
    });
    res.json({ ok: true });
  }));

  /* =====================================================
     Used by pos-shop.js: adds min order, rating and alert info to the shop catalog
  ===================================================== */
  async function decorate(rows, user) {
    if (user && Date.now() - lastCheck > 60 * 1000) checkAlerts();        // fire-and-forget
    try {
      await ready;
      const [ex, al] = await Promise.all([
        pool.query(`SELECT p.sku, p.min_order_qty, r.avg, r.cnt
                      FROM products p LEFT JOIN (SELECT product_id, ROUND(AVG(rating)::numeric, 1) AS avg, COUNT(*)::int AS cnt
                                                   FROM product_reviews WHERE status = 'visible' GROUP BY product_id) r ON r.product_id = p.product_id
                     WHERE p.department = 'Finished Goods'`),
        user ? pool.query(`SELECT p.sku, a.notified_at FROM stock_alerts a JOIN products p ON p.product_id = a.product_id WHERE a.user_id = $1`, [user.id]) : { rows: [] }]);
      const by = new Map(ex.rows.map((r) => [r.sku.toUpperCase(), r]));
      const alerts = new Map(al.rows.map((r) => [r.sku.toUpperCase(), r.notified_at]));
      for (const p of rows) {
        const k = String(p.sku).toUpperCase(), r = by.get(k), a = alerts.get(k);
        const min = r ? +r.min_order_qty : 1;
        p.minOrder = p.available > 0 ? Math.min(min, p.available) : min;   // never more than what is in stock
        p.rating = r && r.avg != null ? +r.avg : 0;
        p.reviewCount = r && r.cnt ? r.cnt : 0;
        p.notifyMe = alerts.has(k) && !a;
        p.backInStock = !!a && p.available > 0 && Date.now() - new Date(a).getTime() < BACK_IN_STOCK_DAYS * 86400000;
      }
    } catch (err) { console.warn('[shop] could not add min-order / rating info to the catalog:', err.message); }
    return rows;
  }

  app.locals.shopExtras = { decorate, checkMinimums };
};
