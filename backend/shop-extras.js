/* shop-extras.js — extras for a metal-products shop:
     1. Request a quote           customer form -> Finance replies with a price -> customer accepts / declines
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
      // quote flow: months instead of a date, dropdown choices, reply details, customer answer
      for (const c of ['needed_months INT CHECK (needed_months BETWEEN 1 AND 24)', 'specs JSONB', 'lead_time TEXT', 'valid_until DATE', 'responded_at TIMESTAMPTZ', 'response_note TEXT',
                       'paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0', "payments JSONB NOT NULL DEFAULT '[]'::jsonb", "progress JSONB NOT NULL DEFAULT '[]'::jsonb", 'received_by TEXT'])
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ' + c);
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_status_check' AND pg_get_constraintdef(oid) LIKE '%preparing%') THEN
          ALTER TABLE quote_requests DROP CONSTRAINT IF EXISTS quote_requests_status_check;
          ALTER TABLE quote_requests ADD CONSTRAINT quote_requests_status_check CHECK (status IN ('new','quoted','accepted','declined','preparing','ready','completed','closed'));
        END IF; END $$`);
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
     Flow:  customer (shop) or cashier (walk-in) sends a request  ->  status 'new'
            Finance replies with an amount, lead time and validity  ->  'quoted'
            customer accepts / declines (or asks for a new quote)    ->  'accepted' / 'declined' / back to 'new'
            accepted quote:  Finance records payments and moves it  ->  'preparing' -> 'ready' (Ready for Pickup / Out for Delivery)
                             -> 'completed' (Picked Up / Delivered; needs the receiver's name and the balance paid)
            Finance can close (cancel) a quote at any step before it is completed  ->  'closed'
  ===================================================== */
  const QUOTE_OPTIONS = {
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18, 24],                 // "needed within" (months from today, no calendar date)
    units: ['pcs', 'sheets', 'lengths', 'boxes', 'sets', 'kg', 'linear m', 'rolls', 'bundles'],
    material: ['Brass', 'Bronze', 'Copper', 'Stainless Steel 304', 'Stainless Steel 316', 'Carbon Steel', 'Galvanized Steel', 'Aluminum', 'Cast Iron', 'Not sure (advise me)'],
    size: ['1/4"', '3/8"', '1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '2-1/2"', '3"', '4"', '3 x 6 ft', '4 x 8 ft', '4 x 10 ft', '5 x 10 ft', 'Not applicable'],
    thickness: ['0.4 mm', '0.5 mm', '0.6 mm', '0.8 mm', '1.0 mm', '1.2 mm', '1.5 mm', '2.0 mm', '2.5 mm', '3.0 mm', '4.5 mm', '6.0 mm', '9.0 mm', '12.0 mm', 'Not applicable'],
    finish: ['Polished', 'Satin / Brushed', 'Matte', 'Powder Coated', 'Galvanized', 'Chrome Plated', 'Painted', 'Raw / Unfinished', 'Not sure (advise me)'],
    service: ['None (as is)', 'Cut to size', 'Bending', 'Cut and bend', 'Drilling / punching', 'Welding / fabrication'],
    customAllowed: ['size', 'thickness'],                                    // these two also accept a typed value ("Other...")
    leadTimes: ['1 to 3 working days', '1 week', '2 weeks', '3 weeks', '1 month', '2 months', '3 months', '4 to 6 months'],
    validDays: [3, 7, 14, 30],
    payMethods: ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Credit / debit card']
  };
  const SPEC_LABEL = { material: 'Material', size: 'Size', thickness: 'Thickness', finish: 'Finish', service: 'Cutting / bending' };
  const CUSTOM_RE = /^[\p{L}\p{N}\s.,x\u00D7\-"'\/()+*]+$/u;
  const todayPH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const dateStr = (d) => {                                                  // pg gives DATE columns as JS dates
    if (!d) return undefined;
    if (typeof d === 'string') return d.slice(0, 10);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const QFLOW = ['accepted', 'preparing', 'ready', 'completed'];             // what happens after the customer accepts
  const stepLabel = (st, f) => ({ new: 'Waiting for reply', quoted: 'Quote ready', accepted: 'Accepted', declined: 'Declined', preparing: 'Preparing',
    ready: f === 'Delivery' ? 'Out for Delivery' : 'Ready for Pickup', completed: f === 'Delivery' ? 'Delivered' : 'Picked Up', closed: 'Closed' })[st] || st;
  const quoteJson = (q) => {
    const validUntil = dateStr(q.valid_until), total = q.quoted_amount == null ? null : +q.quoted_amount, paid = +q.paid_amount || 0;
    const at = QFLOW.indexOf(q.status), next = at >= 0 && at < QFLOW.length - 1 ? QFLOW[at + 1] : null;
    const progress = [];
    if (at >= 0 && q.responded_at) progress.push({ status: 'accepted', label: 'Accepted', at: ms(q.responded_at) });
    (Array.isArray(q.progress) ? q.progress : []).forEach((e) => progress.push({ status: e.s, label: stepLabel(e.s, q.fulfillment), at: e.at, note: e.note || undefined }));
    return {
      id: q.quote_no, status: q.status, statusLabel: stepLabel(q.status, q.fulfillment), product: q.product_name || undefined, sku: q.product_sku || undefined,
      quantity: q.quantity, details: q.details, specs: q.specs || undefined,
      neededMonths: q.needed_months || undefined, neededBy: dateStr(q.needed_by),          // neededBy only exists on requests made before the months field
      fulfillment: q.fulfillment || undefined, area: q.area || undefined,
      quotedAmount: total == null ? undefined : total, replyNote: q.reply_note || undefined,
      leadTime: q.lead_time || undefined, validUntil,
      expired: q.status === 'quoted' && !!validUntil && validUntil < todayPH(),
      respondedAt: ms(q.responded_at), responseNote: q.response_note || undefined,
      paidAmount: paid, balance: total == null ? undefined : Math.max(0, round2(total - paid)),
      payments: (Array.isArray(q.payments) ? q.payments : []).map((p) => ({ amount: p.amount, method: p.method, note: p.note || undefined, at: p.at })),
      progress, next: next || undefined, nextLabel: next ? stepLabel(next, q.fulfillment) : undefined, receivedBy: q.received_by || undefined,
      source: q.source || 'shop', createdAt: ms(q.created_at), updatedAt: ms(q.updated_at)
    };
  };
  const nc = () => app.locals.notifications;                                   // in-app notification center (fails soft)
  const pingFinance = (n) => (nc() ? nc().notifyRole('finance', n) : null);
  const pingUser = (id, n, role) => (nc() && id ? nc().notifyUser(id, n, role) : null);

  app.get('/api/shop/quote-options', auth('customer'), (req, res) => res.json(QUOTE_OPTIONS));
  app.get('/api/pos/quote-options', auth('cashier'), (req, res) => res.json(QUOTE_OPTIONS));
  app.get('/api/finance/quote-options', auth('finance'), (req, res) => res.json(QUOTE_OPTIONS));

  // Checks a quote request body (shop customer or POS walk-in) and returns the clean values, or throws a field error.
  async function readQuote(b, { fallbackName, userId }) {
    const contactName = str(b.contactName) || fallbackName;
    if (!contactName) throw bad('contactName', 'Enter the customer\u2019s name');
    if (contactName.length < 2 || contactName.length > 80 || !NAME_RE.test(contactName)) throw bad('contactName', 'Enter your full name (letters only)');
    const phone = str(b.phone).replace(/[\s().-]/g, '');
    if (!phone) throw bad('phone', 'Enter your mobile number so we can reach you');
    if (!MOBILE_RE.test(phone)) throw bad('phone', 'Enter a valid mobile number, e.g. 0917 123 4567');

    // the product (or a described custom item)
    let sku = null, productName = str(b.productName).slice(0, 120) || null, productUnit = '';
    if (str(b.sku)) {
      const p = (await pool.query(`SELECT sku, name, unit FROM products WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [str(b.sku).toUpperCase()])).rows[0];
      if (!p) throw bad('sku', 'That product is not available');
      sku = p.sku; productName = p.name; productUnit = String(p.unit || '').toLowerCase();
    } else if (!productName || productName.length < 3) throw bad('productName', 'Tell us what you need (at least 3 characters)');

    // amount required: a number plus a unit from the list (or the product's own unit)
    const raw = String(b.quantity == null ? '' : b.quantity).replace(/,/g, '').trim();
    const qty = Number(raw);
    if (!raw) throw bad('quantity', 'Enter how much you need');
    if (!Number.isFinite(qty) || qty <= 0) throw bad('quantity', 'Enter a number greater than 0');
    if (qty > 1000000 || Math.abs(Math.round(qty * 100) - qty * 100) > 1e-6) throw bad('quantity', 'Enter a quantity up to 1,000,000 with at most 2 decimals');
    const unit = str(b.quantityUnit).toLowerCase();
    if (!QUOTE_OPTIONS.units.includes(unit) && !(unit && unit === productUnit)) throw bad('quantity', 'Choose the unit (pcs, sheets, lengths...)');
    const quantity = qty.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + unit;

    // how soon: whole months from today, picked from a list (no calendar date, so nothing in the past can be chosen)
    const neededMonths = Number(b.neededMonths);
    if (!Number.isInteger(neededMonths) || !QUOTE_OPTIONS.months.includes(neededMonths)) throw bad('neededMonths', 'Choose how many months from now you need it');

    // sizes and details: every one is a dropdown; size and thickness can also be typed in
    const inSpecs = b.specs && typeof b.specs === 'object' && !Array.isArray(b.specs) ? b.specs : {};
    const specs = {};
    for (const key of Object.keys(SPEC_LABEL)) {
      const v = str(inSpecs[key]);
      if (!v) throw bad(key, 'Choose the ' + SPEC_LABEL[key].toLowerCase());
      if (!QUOTE_OPTIONS[key].includes(v)) {
        if (!QUOTE_OPTIONS.customAllowed.includes(key)) throw bad(key, 'Choose the ' + SPEC_LABEL[key].toLowerCase() + ' from the list');
        if (v.length < 2 || v.length > 40 || !/\d/.test(v) || !CUSTOM_RE.test(v)) throw bad(key, 'Type the ' + SPEC_LABEL[key].toLowerCase() + ' with its number, e.g. ' + (key === 'size' ? '600 x 900 mm' : '1.8 mm'));
      }
      specs[key] = v;
    }
    const notes = str(b.notes);
    if (notes.length > 1000) throw bad('notes', 'Please keep the extra notes under 1,000 characters');
    if (notes) specs.notes = notes;
    const details = Object.keys(SPEC_LABEL).map((k) => SPEC_LABEL[k] + ': ' + specs[k]).concat(notes ? ['Notes: ' + notes] : []).join('\n');

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
    return { contactName, phone, quantity, details, specs, neededMonths, fulfillment, area, sku, productName };
  }

  const INSERT_COLS = 'contact_name, phone, product_sku, product_name, quantity, details, specs, needed_months, fulfillment, area';
  const insertVals = (v) => [v.contactName, v.phone, v.sku, v.productName, v.quantity, v.details, JSON.stringify(v.specs), v.neededMonths, v.fulfillment, v.area];
  const financeTo = () => process.env.QUOTE_EMAIL || (shopInfo() || {}).email;
  const needText = (m) => m + (m === 1 ? ' month' : ' months');

  app.post('/api/shop/quotes', auth('customer'), wrap(async (req, res) => {
    const v = await readQuote(req.body || {}, { fallbackName: req.user.name, userId: req.user.id });
    const open = (await pool.query(`SELECT count(*)::int AS n FROM quote_requests WHERE customer_id = $1 AND status = 'new'`, [req.user.id])).rows[0].n;
    if (open >= MAX_OPEN_QUOTES) throw bad('quote', `You already have ${open} requests waiting for an answer. Please wait for our reply first`);

    const row = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO quote_requests (customer_id, ${INSERT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
        [req.user.id, ...insertVals(v)]);
      await audit(client, req.user, 'Record added', `Quote request ${r.rows[0].quote_no}${v.productName ? ' \u2014 ' + v.productName : ''} (${v.quantity})`);
      return r.rows[0];
    });
    res.status(201).json(quoteJson(row));

    // email: a copy to the customer and a heads-up to Finance (fire-and-forget)
    (async () => {
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [req.user.id])).rows[0];
      await send(u && u.email, `We received your quote request ${row.quote_no}`, [
        `Hi ${v.contactName},`, `Thank you for your request. We will send you a quote soon.`, '',
        `Reference: ${row.quote_no}`, `Item: ${v.productName || 'See details'}`, `Quantity: ${v.quantity}`, `Needed within: ${needText(v.neededMonths)}`, ...signoff()], 'quote-received');
      const to = financeTo();
      if (to) await send(to, `New quote request ${row.quote_no} from ${v.contactName}`, [
        `Customer: ${v.contactName} (${v.phone})`, `Item: ${v.productName || 'See details'}`, `Quantity: ${v.quantity}`,
        `Needed within: ${needText(v.neededMonths)}`, `Receive by: ${v.fulfillment}${v.area ? ' \u00B7 ' + v.area : ''}`, '', v.details, '',
        `Open Finance > Quote Requests${baseUrl() ? ' at ' + baseUrl() + '/Finance_Inventory.html' : ''} to reply.`], 'quote-new');
      else console.warn('[shop] new quote request ' + row.quote_no + ' saved. Set QUOTE_EMAIL or SHOP_EMAIL in .env to get an email for each request');
    })().catch((e) => console.error('[mail] quote emails failed:', e.message));
  }));

  app.get('/api/shop/quotes', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM quote_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json(rows.map(quoteJson));
  }));

  /* After Finance replies, the customer (or the cashier for a walk-in) answers the quote:
       accept  -> status 'accepted'  (Finance is told and follows up on payment / pickup / delivery)
       decline -> status 'declined'
       renew   -> status 'new'       (the price expired or no longer fits: ask Finance for a fresh quote) */
  async function respondToQuote(req, res, { where, params, who }) {
    const action = str((req.body || {}).action), note = str((req.body || {}).note);
    if (!['accept', 'decline', 'renew'].includes(action)) throw bad('action', 'Choose accept, decline or ask for a new quote');
    if (note.length > 500) throw bad('note', 'Please keep the note under 500 characters');
    const next = { accept: 'accepted', decline: 'declined', renew: 'new' }[action];
    const q = await tx(async (client) => {
      const cur = (await client.query(`SELECT * FROM quote_requests WHERE quote_no = $1 AND ${where} FOR UPDATE`, [req.params.no, ...params])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (cur.status !== 'quoted') throw bad('status', cur.status === 'new' ? 'This request has not been answered yet' : 'This quote was already answered or closed');
      const vu = dateStr(cur.valid_until);
      if (action === 'accept' && vu && vu < todayPH()) throw bad('status', 'This quote has expired. Ask for a new quote instead');
      const r = await client.query(
        `UPDATE quote_requests SET status = $2, responded_at = now(), response_note = $3, updated_at = now() WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, next, note || null]);
      await audit(client, req.user, 'Record edited', `Quote request ${cur.quote_no} ${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'sent back for a new quote'} by ${who}`);
      return r.rows[0];
    });
    res.json({ ok: true, status: q.status });
    Promise.resolve(pingFinance({ category: 'orders', title: action === 'accept' ? 'Quote accepted' : action === 'decline' ? 'Quote declined' : 'New quote requested',
      body: `${q.contact_name} ${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'asked for a new quote on'} ${q.quote_no}` + (q.quoted_amount != null ? ' (' + peso(q.quoted_amount) + ')' : '') + '.',
      link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no })).catch(() => {});
    (async () => {
      const to = financeTo(); if (!to) return;
      const verb = action === 'accept' ? 'ACCEPTED' : action === 'decline' ? 'declined' : 'is asking for a new quote on';
      await send(to, `Quote ${q.quote_no} ${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'needs a new quote'}`, [
        `${q.contact_name} (${q.phone}) ${verb} quote ${q.quote_no}.`, `Item: ${q.product_name || 'See details'} \u00B7 ${q.quantity}`,
        ...(q.quoted_amount != null ? [`Quoted amount: ${peso(q.quoted_amount)}`] : []), ...(note ? ['', `Note: ${note}`] : []), '',
        action === 'accept' ? `Next: open Finance > Quote Requests, record the payment and move it to Preparing.` : 'Open Finance > Quote Requests to see it.'], 'quote-response');
    })().catch((e) => console.error('[mail] quote response failed:', e.message));
  }

  app.post('/api/shop/quotes/:no/respond', auth('customer'), wrap((req, res) => respondToQuote(req, res, { where: 'customer_id = $2', params: [req.user.id], who: 'the customer' })));

  /* ---- walk-in customers: the cashier logs the request, Finance prices it, the cashier tells the customer and records the answer ---- */
  const MAX_OPEN_POS_QUOTES = 50;
  app.post('/api/pos/quotes', auth('cashier'), wrap(async (req, res) => {
    const v = await readQuote(req.body || {}, { fallbackName: '', userId: null });
    const open = (await pool.query(`SELECT count(*)::int AS n FROM quote_requests WHERE source = 'pos' AND status = 'new'`)).rows[0].n;
    if (open >= MAX_OPEN_POS_QUOTES) throw bad('quote', 'There are too many walk-in requests waiting for Finance. Please ask Finance to answer them first');
    const row = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO quote_requests (customer_id, source, created_by, ${INSERT_COLS}) VALUES (NULL,'pos',$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
        [req.user.id, ...insertVals(v)]);
      await audit(client, req.user, 'Record added', `Walk-in quote request ${r.rows[0].quote_no}${v.productName ? ' \u2014 ' + v.productName : ''} (${v.quantity}) for ${v.contactName}`);
      return r.rows[0];
    });
    res.status(201).json({ ...quoteJson(row), customer: row.contact_name, phone: row.phone });
    (async () => {
      const to = financeTo();
      if (!to) return;
      await send(to, `Walk-in quote request ${row.quote_no} from ${v.contactName}`, [
        `Walk-in customer: ${v.contactName} (${v.phone}) \u2014 logged at the counter by ${req.user.name || 'a cashier'}`, `Item: ${v.productName || 'See details'}`, `Quantity: ${v.quantity}`,
        `Needed within: ${needText(v.neededMonths)}`, `Receive by: ${v.fulfillment}${v.area ? ' \u00B7 ' + v.area : ''}`, '', v.details, '',
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

  app.post('/api/pos/quotes/:no/respond', auth('cashier'), wrap((req, res) => respondToQuote(req, res, { where: `source = 'pos'`, params: [], who: 'the cashier (walk-in customer)' })));

  app.get('/api/finance/quotes', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT q.*, u.email AS customer_email, h.full_name AS handled_by_name
         FROM quote_requests q LEFT JOIN users u ON u.user_id = q.customer_id LEFT JOIN users h ON h.user_id = q.handled_by
        ORDER BY (q.status IN ('new','accepted','preparing','ready')) DESC, q.created_at DESC LIMIT 300`);
    res.json(rows.map((q) => ({ ...quoteJson(q), customer: q.contact_name, phone: q.phone, email: q.customer_email, handledBy: q.handled_by_name || undefined })));
  }));

  // Finance: send the quote (amount is required), close a request, or reopen it
  app.post('/api/finance/quotes/:no', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const status = str(b.status), note = str(b.note);
    if (!['new', 'quoted', 'closed'].includes(status)) throw bad('status', 'Choose a status');
    if (note.length > 1500) throw bad('note', 'The note is too long (max 1500 characters)');
    if (note && note.length < 5) throw bad('note', 'Write at least 5 characters, or leave the note empty');
    let amount = null, leadTime = null, validUntil = null;
    if (status === 'quoted') {
      const raw = String(b.amount == null ? '' : b.amount).replace(/[,\u20B1\s]/g, '');
      if (!raw) throw bad('amount', 'Enter the quoted amount');
      amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw bad('amount', 'Enter a valid amount greater than 0');
      amount = Math.round(amount * 100) / 100;
      leadTime = str(b.leadTime);
      if (!QUOTE_OPTIONS.leadTimes.includes(leadTime)) throw bad('leadTime', 'Choose how long it will take to make or prepare');
      const days = Number(b.validDays);
      if (!QUOTE_OPTIONS.validDays.includes(days)) throw bad('validDays', 'Choose how long the price is valid');
      validUntil = addDays(todayPH(), days);
    }
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (cur.status === 'completed') throw bad('status', 'This quote is already completed and cannot be changed');
      const started = ['preparing', 'ready'].includes(cur.status) || (cur.status === 'accepted' && +cur.paid_amount > 0);
      if (started && status !== 'closed') throw bad('status', 'Work or payment has already started on this quote. You can only move it forward or close it');
      if (status === 'closed' && +cur.paid_amount > 0 && note.length < 5) throw bad('note', 'Payments were received. Write a note about the refund or how it was settled');
      const quoting = status === 'quoted';
      const r = await client.query(
        `UPDATE quote_requests SET status = $2, reply_note = $3, quoted_amount = $4, lead_time = $5, valid_until = $6, handled_by = $7,
                responded_at = CASE WHEN $2 IN ('quoted','new') THEN NULL ELSE responded_at END,
                response_note = CASE WHEN $2 IN ('quoted','new') THEN NULL ELSE response_note END, updated_at = now() WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, status, quoting ? (note || null) : (note || cur.reply_note), quoting ? amount : cur.quoted_amount,
         quoting ? leadTime : cur.lead_time, quoting ? validUntil : cur.valid_until, req.user.id]);
      await audit(client, req.user, 'Record edited', `Quote request ${cur.quote_no} marked ${status}${quoting ? ' (' + peso(amount) + ')' : ''}`);
      return r.rows[0];
    });
    res.json({ ok: true });
    if (status !== 'new') (async () => {
      if (!q.customer_id) return;                       // walk-in from the POS: the cashier / Finance tells them by phone
      if (status === 'closed' && !note) return;
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      if (status === 'quoted') await send(u && u.email, `Your quote ${q.quote_no} is ready`, [
        `Hi ${q.contact_name},`, 'Here is our quote for your request.', '',
        `Item: ${q.product_name || 'See details'} \u00B7 ${q.quantity}`, `Quoted amount: ${peso(q.quoted_amount)}`, `Ready in: ${q.lead_time}`, `Price valid until: ${dateStr(q.valid_until)}`,
        ...(q.reply_note ? ['', q.reply_note] : []), '',
        `To go ahead, open Request a Quote in your account and tap Accept${baseUrl() ? ' (' + baseUrl() + '/Shop_Customer.html)' : ''}. You can also decline it or ask for a new quote there.`, ...signoff()], 'quote-reply');
      else await send(u && u.email, `Update on your quote request ${q.quote_no}`, [`Hi ${q.contact_name},`, 'We have an update on your quote request.', '', q.reply_note, ...signoff()], 'quote-reply');
    })().catch((e) => console.error('[mail] quote reply failed:', e.message));
  }));

  /* ---- after acceptance: payments and the pickup / delivery steps (Finance) ---- */
  const msgFor = (q, st) => {
    const f = q.fulfillment, bal = Math.max(0, round2(+q.quoted_amount - (+q.paid_amount || 0))), shop = (shopInfo() || {}).address;
    const owe = bal > 0 ? ` Balance to pay ${f === 'Delivery' ? 'on delivery' : 'at pickup'}: ${peso(bal)}.` : ' Your quote is fully paid.';
    if (st === 'preparing') return { title: 'We started on your order', body: `${q.quote_no} is now being prepared.${q.lead_time ? ' Estimated time: ' + q.lead_time + '.' : ''}` };
    if (st === 'ready') return f === 'Delivery'
      ? { title: 'Your order is out for delivery', body: `${q.quote_no} is on its way${q.area ? ' to ' + q.area : ''}.${owe}` }
      : { title: 'Your order is ready for pickup', body: `${q.quote_no} is ready${shop ? ' at ' + shop : ' at our shop'}.${owe}` };
    return { title: f === 'Delivery' ? 'Your order was delivered' : 'Your order was picked up', body: `${q.quote_no} is complete. Thank you for ordering from Triple E Metal Products.` };
  };

  app.post('/api/finance/quotes/:no/step', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const target = str(b.status), note = str(b.note), receivedBy = str(b.receivedBy);
    if (note.length > 200) throw bad('note', 'The note must be 200 characters or fewer');
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      const at = QFLOW.indexOf(cur.status);
      if (at < 0) throw bad('status', 'Only an accepted quote can move to the next step');
      const next = QFLOW[at + 1];
      if (!next) throw bad('status', 'This quote is already completed');
      if (target !== next) throw bad('status', `The next step is "${stepLabel(next, cur.fulfillment)}". Steps cannot be skipped or moved backwards`);
      if (next === 'completed') {
        if (receivedBy.length < 2 || receivedBy.length > 80) throw bad('receivedBy', `Enter the name of the person who ${cur.fulfillment === 'Delivery' ? 'received' : 'picked up'} the order (2 to 80 characters)`);
        const owed = round2(+cur.quoted_amount - (+cur.paid_amount || 0));
        if (owed > 0.004) throw bad('payment', `The balance of ${peso(owed)} is not paid yet. Record the payment first`);
      }
      const entry = { s: next, at: Date.now(), note: [next === 'completed' ? 'Received by ' + receivedBy : '', note].filter(Boolean).join(' - ') || undefined };
      const r = await client.query(
        `UPDATE quote_requests SET status = $2, received_by = COALESCE($3, received_by), progress = COALESCE(progress, '[]'::jsonb) || $4::jsonb, handled_by = $5, updated_at = now()
          WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, next, next === 'completed' ? receivedBy : null, JSON.stringify([entry]), req.user.id]);
      await audit(client, req.user, 'Record edited', `Quote ${cur.quote_no} moved from ${stepLabel(cur.status, cur.fulfillment)} to ${stepLabel(next, cur.fulfillment)}`);
      return r.rows[0];
    });
    res.json({ ok: true, status: q.status });
    const m = msgFor(q, q.status);
    Promise.resolve(pingUser(q.customer_id, { category: 'delivery', title: m.title, body: m.body, link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
    if (q.source === 'pos') Promise.resolve(pingUser(q.created_by, { category: 'pos', title: 'Walk-in quote: ' + stepLabel(q.status, q.fulfillment), body: `${q.quote_no} for ${q.contact_name}. ` + (q.status === 'ready' ? 'Tell the customer it is ready.' : ''), link: 'POS_Cashier.html', entityType: 'quote', entityId: q.quote_no }, 'cashier')).catch(() => {});
    (async () => {
      if (!q.customer_id) return;
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      await send(u && u.email, `${m.title} (${q.quote_no})`, [`Hi ${q.contact_name},`, m.body, ...signoff()], 'quote-step');
    })().catch((e) => console.error('[mail] quote step failed:', e.message));
  }));

  app.post('/api/finance/quotes/:no/payment', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const raw = String(b.amount == null ? '' : b.amount).replace(/[,\u20B1\s]/g, ''), method = str(b.method), note = str(b.note);
    if (!raw) throw bad('amount', 'Enter the amount received');
    let amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw bad('amount', 'Enter a valid amount greater than 0');
    amount = round2(amount);
    if (!QUOTE_OPTIONS.payMethods.includes(method)) throw bad('method', 'Choose how it was paid');
    if (note.length > 100) throw bad('note', 'The note must be 100 characters or fewer');
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (!['accepted', 'preparing', 'ready'].includes(cur.status)) throw bad('status', 'Payments can only be recorded on an accepted quote that is not completed yet');
      const balance = round2(+cur.quoted_amount - (+cur.paid_amount || 0));
      if (amount > balance + 0.004) throw bad('amount', `The balance is only ${peso(balance)}`);
      const pays = (Array.isArray(cur.payments) ? cur.payments : []).concat([{ amount, method, note: note || undefined, at: Date.now() }]);
      const r = await client.query('UPDATE quote_requests SET paid_amount = $2, payments = $3::jsonb, handled_by = $4, updated_at = now() WHERE quote_id = $1 RETURNING *',
        [cur.quote_id, round2((+cur.paid_amount || 0) + amount), JSON.stringify(pays), req.user.id]);
      await audit(client, req.user, 'Record edited', `Quote ${cur.quote_no}: payment of ${peso(amount)} received (${method})`);
      return r.rows[0];
    });
    res.json({ ok: true, paidAmount: +q.paid_amount, balance: Math.max(0, round2(+q.quoted_amount - +q.paid_amount)) });
    const bal = Math.max(0, round2(+q.quoted_amount - +q.paid_amount));
    const body = `Payment of ${peso(amount)} received for ${q.quote_no}. ` + (bal > 0 ? `Balance: ${peso(bal)}.` : 'Fully paid.');
    Promise.resolve(pingUser(q.customer_id, { category: 'payment', title: 'Payment received', body, link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
    (async () => {
      if (!q.customer_id) return;
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      await send(u && u.email, `Payment received for ${q.quote_no}`, [`Hi ${q.contact_name},`, body, ...signoff()], 'quote-payment');
    })().catch((e) => console.error('[mail] quote payment failed:', e.message));
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