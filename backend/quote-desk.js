/* quote-desk.js — the Cashier Quotation Desk read/write API that the redesigned POS workspace talks to.

   shop-extras.js already owns the quotation life-cycle (create, clarify, price, approve, respond, pay, fulfil).
   This module only adds what the desk screen needs on top of it, without changing those routes:
     • GET    /api/pos/quote-desk                     full-width list: search, status/source filters, sorting, pagination, facet counts
     • GET    /api/pos/quote-desk/:no                 one quotation in full, with its whole clarification history and attachments
     • POST   /api/pos/quote-desk/:no/attachments     reference drawing / product photo (JPG, PNG, WEBP or PDF, max 5 MB, 3 per quote)
     • GET    /api/pos/quote-desk/:no/attachments/:id  serve the file bytes
     • DELETE /api/pos/quote-desk/:no/attachments/:id  remove one
     • POST   /api/pos/quote-desk/:no/convert         accepted quotation -> order (online customer) or POS hand-off (walk-in)

   Files live in PostgreSQL as BYTEA, exactly like the proof-of-delivery photos in order-delivery.js, so nothing is written to the
   Cloud Run container's disk (which is ephemeral) and there is no extra bucket to secure.

   Mounted in server.js:  require('./quote-desk')({ app, pool, auth, wrap, tx, audit, ValidationError, str, validateShipTo, formatShipTo });
*/
const express = require('express');

const MAX_FILES = 3;
const MAX_FILE_BYTES = '5mb';
const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const PAGE_SIZES = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;
const REQUEST_ID_RE = /^[a-zA-Z0-9-]{12,100}$/;

/* Magic-number check, same idea as sniff() in order-delivery.js: the declared content type is never trusted. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-' && Number(buf[5]) >= 45) return 'application/pdf';
  return null;
}

/* "200 pcs" / "12.5 linear m" as readQuote() stores them -> { qty, unit } */
function splitQuantity(text) {
  const m = /^([\d,.]+)\s+(.+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const qty = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(qty) && qty > 0 ? { qty, unit: m[2] } : null;
}

module.exports = function mountQuoteDesk({ app, pool, auth, wrap, tx, audit, ValidationError, str, validateShipTo, formatShipTo }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const todayPH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const dateStr = (d) => (!d ? undefined : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const ms = (d) => (d ? new Date(d).getTime() : undefined);
  const nc = () => app.locals.notifications;
  const pingFinance = (n) => (nc() ? nc().notifyRole('finance', n) : null);

  /* ---------------- schema (runs on every start, nothing is dropped) ---------------- */
  const ready = (async () => {
    try {
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_order_id BIGINT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_note TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS convert_request_id TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS handover_sale_id BIGINT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS handover_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS contact_email TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS company_name TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS flexible_date BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query(`CREATE TABLE IF NOT EXISTS quote_attachments (
        attachment_id BIGSERIAL PRIMARY KEY,
        quote_id      BIGINT NOT NULL REFERENCES quote_requests(quote_id) ON DELETE CASCADE,
        file_name     TEXT NOT NULL,
        mime          TEXT NOT NULL,
        size_bytes    INT  NOT NULL,
        data          BYTEA NOT NULL,
        uploaded_by   INT  REFERENCES users(user_id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_quote_attachments ON quote_attachments (quote_id, attachment_id)');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_convert_request ON quote_requests (convert_request_id) WHERE convert_request_id IS NOT NULL');
      console.log('[quote-desk] attachment / conversion columns ready');
    } catch (err) { console.warn('[quote-desk] could not prepare the quotation desk tables:', err.message); }
  })();
  app.use('/api/pos/quote-desk', (req, res, next) => { ready.then(() => next(), next); });

  /* ---------------- the list ---------------- */
  // Only these columns can be sorted on; anything else is refused rather than interpolated.
  const SORTS = {
    created: 'q.created_at', needed: "COALESCE(q.needed_by, (current_date + interval '100 year'))", reference: 'q.quote_no',
    customer: 'q.contact_name', product: 'q.product_name', amount: 'COALESCE(q.quoted_amount, q.proposed_amount)',
    status: `CASE q.status WHEN 'new' THEN 0 WHEN 'awaiting_details' THEN 0 WHEN 'pending_approval' THEN 1 WHEN 'quoted' THEN 2
              WHEN 'accepted' THEN 3 WHEN 'preparing' THEN 4 WHEN 'ready' THEN 5 WHEN 'completed' THEN 6 ELSE 7 END`
  };
  const FILTERS = {
    open: ["q.status IN ('new','awaiting_details')"],
    approval: ["q.status = 'pending_approval'"],
    quoted: ["q.status = 'quoted'"],
    active: ["q.status IN ('accepted','preparing','ready')"],
    done: ["q.status IN ('completed','declined','closed')"],
    all: []
  };
  const SOURCES = { shop: ["q.source = 'shop'"], pos: ["q.source = 'pos'"], all: [] };
  const labelFor = (st, f, expired) => ({
    new: 'Pending Cashier Review', awaiting_details: 'Awaiting Customer Details', pending_approval: 'Awaiting Finance Approval',
    quoted: expired ? 'Quote Expired' : 'Quote Ready', accepted: 'Accepted', declined: 'Declined', closed: 'Closed',
    preparing: 'Preparing', ready: f === 'Delivery' ? 'Out for Delivery' : 'Ready for Pickup',
    completed: f === 'Delivery' ? 'Delivered' : 'Picked Up'
  })[st] || st;

  // null (never undefined) so every column key survives JSON and the table always has something to render
  const money = (v) => (v == null || !Number.isFinite(Number(v)) ? null : round2(Number(v)));
  const briefJson = (q) => {
    const total = q.quoted_amount == null ? null : round2(+q.quoted_amount), expired = q.status === 'quoted' && !!dateStr(q.valid_until) && dateStr(q.valid_until) < todayPH();
    return {
      id: q.quote_no, customer: q.contact_name, phone: q.phone, product: q.product_name || 'Custom item', sku: q.product_sku || null,
      quantity: q.quantity, specs: q.specs || null, neededBy: dateStr(q.needed_by) || null, neededMonths: q.needed_months || null,
      flexibleDate: q.flexible_date === true, company: q.company_name || null,
      fulfillment: q.fulfillment || null, area: q.area || null, source: q.source || 'shop', requestDate: ms(q.created_at),
      amount: money(total), proposedAmount: money(q.proposed_amount), leadTime: q.lead_time || null,
      validUntil: dateStr(q.valid_until) || null, expired, status: q.status, statusLabel: labelFor(q.status, q.fulfillment, expired),
      paidAmount: money(q.paid_amount), balance: total == null ? null : Math.max(0, round2(total - (+q.paid_amount || 0))),
      clarificationStatus: q.clarification_status || null, attachmentCount: Number(q.attachment_count) || 0,
      orderNo: q.order_no || null, converted: !!q.converted_order_id, handoverAt: ms(q.handover_at) || null, createdBy: q.created_by_name || null
    };
  };
  const detailJson = (q, clarifications, attachments, notes) => ({
    ...briefJson(q),
    details: q.details, replyNote: q.reply_note || null, approvalReason: q.approval_reason || null,
    contactEmail: q.contact_email || null,
    responseNote: q.response_note || null, respondedAt: ms(q.responded_at) || null, email: q.customer_email || null,
    customerId: q.customer_id || null, handledBy: q.handled_by_name || null, updatedAt: ms(q.updated_at),
    payments: Array.isArray(q.payments) ? q.payments : [], progress: Array.isArray(q.progress) ? q.progress : [],
    receivedBy: q.received_by || undefined, payMethod: q.pay_method || undefined,
    clarifications: clarifications.map((c) => ({
      id: c.clarification_id, fields: c.fields, message: c.message, responseDue: dateStr(c.response_due), status: c.status,
      response: c.response || undefined, submittedSpecs: c.submitted_specs || undefined, askedBy: c.asked_by_name || undefined,
      createdAt: ms(c.created_at), answeredAt: ms(c.answered_at)
    })),
    attachments: attachments.map((a) => ({ id: Number(a.attachment_id), name: a.file_name, mime: a.mime, sizeBytes: Number(a.size_bytes), url: `/api/pos/quote-desk/${encodeURIComponent(q.quote_no)}/attachments/${a.attachment_id}`, uploadedBy: a.uploaded_by_name || undefined, createdAt: ms(a.created_at) })),
    notes
  });

  const SEARCHABLE = 'LOWER(CONCAT(q.quote_no, \' \', q.contact_name, \' \', q.phone, \' \', COALESCE(q.product_name, \'\')))';

  app.get('/api/pos/quote-desk', auth('cashier'), wrap(async (req, res) => {
    const g = (k, d) => String(req.query[k] == null ? '' : req.query[k]).trim() || d || '';
    const filter = FILTERS[g('status', 'all').toLowerCase()] ? g('status', 'all').toLowerCase() : 'all';
    const source = SOURCES[g('source', 'all').toLowerCase()] ? g('source', 'all').toLowerCase() : 'all';
    const sortKey = SORTS[g('sort', 'created')] ? g('sort', 'created') : 'created';
    const dir = g('dir', 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1) | 0);
    const sizeRaw = Number(req.query.pageSize);
    const pageSize = PAGE_SIZES.includes(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE;
    const term = g('q').toLowerCase().replace(/[^\S]+/g, ' ');
    const mine = g('mine').toLowerCase() === 'true';

    const where = ['1=1'], params = [];
    SOURCES[source].forEach((c) => where.push(c));
    if (mine) { params.push(req.user.id); where.push(`q.created_by = $${params.length}`); }
    if (term) { params.push('%' + term.replace(/[%_]/g, (c) => '\\' + c) + '%'); where.push(`${SEARCHABLE} LIKE $${params.length} ESCAPE '\\'`); }
    const clauseBase = where.join(' AND ');                       // search + source only, so the chips can show what else is waiting
    const clause = where.concat(FILTERS[filter]).join(' AND ');   // plus the status chip the cashier picked

    const [pageRows, facetRows, totals, baseTotals] = await Promise.all([
      pool.query(
        `SELECT q.*, c.full_name AS created_by_name, h.full_name AS handled_by_name, cu.email AS customer_email, o.order_no,
                (SELECT count(*) FROM quote_attachments a WHERE a.quote_id = q.quote_id) AS attachment_count,
                (SELECT k.status FROM quote_clarifications k WHERE k.quote_id = q.quote_id AND k.status = 'awaiting_customer' LIMIT 1) AS clarification_status
           FROM quote_requests q
           LEFT JOIN users c ON c.user_id = q.created_by
           LEFT JOIN users h ON h.user_id = q.handled_by
           LEFT JOIN users cu ON cu.user_id = q.customer_id
           LEFT JOIN orders o ON o.order_id = q.converted_order_id
          WHERE ${clause}
          ORDER BY ${SORTS[sortKey]} ${dir}, q.quote_id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize]),
      pool.query(
        `SELECT q.status, count(*)::int AS n FROM quote_requests q
          WHERE ${SOURCES[source].length ? SOURCES[source].join(' AND ') : '1=1'}
          GROUP BY q.status`),
      pool.query(`SELECT count(*)::int AS n FROM quote_requests q WHERE ${clause}`, params),
      pool.query(`SELECT count(*)::int AS n FROM quote_requests q WHERE ${clauseBase}`, params)
    ]);

    const counts = { all: baseTotals.rows[0].n, open: 0, approval: 0, quoted: 0, active: 0, done: 0 };
    facetRows.rows.forEach((r) => {
      if (['new', 'awaiting_details'].includes(r.status)) counts.open += r.n;
      else if (r.status === 'pending_approval') counts.approval += r.n;
      else if (r.status === 'quoted') counts.quoted += r.n;
      else if (['accepted', 'preparing', 'ready'].includes(r.status)) counts.active += r.n;
      else if (['completed', 'declined', 'closed'].includes(r.status)) counts.done += r.n;
    });
    res.json({
      rows: pageRows.rows.map(briefJson), page, pageSize, total: totals.rows[0].n,
      pageCount: Math.max(1, Math.ceil(totals.rows[0].n / pageSize)), counts,
      sort: sortKey, dir: dir.toLowerCase(), filter, source
    });
  }));

  app.get('/api/pos/quote-desk/:no', auth('cashier'), wrap(async (req, res) => {
    const no = str(req.params.no).slice(0, 40);
    const q = (await pool.query(
      `SELECT q.*, c.full_name AS created_by_name, h.full_name AS handled_by_name, cu.email AS customer_email, o.order_no, o.status AS order_status, o.payment_status
         FROM quote_requests q
         LEFT JOIN users c ON c.user_id = q.created_by
         LEFT JOIN users h ON h.user_id = q.handled_by
         LEFT JOIN users cu ON cu.user_id = q.customer_id
         LEFT JOIN orders o ON o.order_id = q.converted_order_id
        WHERE q.quote_no = $1`, [no])).rows[0];
    if (!q) throw bad('id', 'Quotation not found');
    const { rows: clar } = await pool.query(
      `SELECT k.*, u.full_name AS asked_by_name FROM quote_clarifications k LEFT JOIN users u ON u.user_id = k.created_by
        WHERE k.quote_id = $1 ORDER BY k.created_at DESC`, [q.quote_id]);
    const { rows: files } = await pool.query(
      `SELECT a.attachment_id, a.file_name, a.mime, a.size_bytes, a.uploaded_by, a.created_at, u.full_name AS uploaded_by_name
         FROM quote_attachments a LEFT JOIN users u ON u.user_id = a.uploaded_by
        WHERE a.quote_id = $1 ORDER BY a.attachment_id`, [q.quote_id]);
    const { rows: log } = await pool.query(
      `SELECT action, detail, user_name, role_label, occurred_at FROM audit_log
        WHERE detail LIKE '%' || $1 || '%' ORDER BY occurred_at DESC LIMIT 25`, [no]);
    res.json(detailJson(q, clar, files, log.map((l) => ({ at: ms(l.occurred_at), action: l.action, detail: l.detail, by: `${l.user_name || 'System'} (${l.role_label || ''})` }))));
  }));

  /* ---------------- attachments ---------------- */
  const photoUpload = express.raw({ type: FILE_TYPES, limit: MAX_FILE_BYTES });
  async function loadQuoteForFile(client, no) {
    const q = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [no])).rows[0];
    if (!q) throw bad('id', 'Quotation not found');
    if (['completed', 'closed', 'declined'].includes(q.status)) throw bad('status', 'A finished quotation can no longer be changed');
    return q;
  }
  const fileNameOf = (raw) => {
    const n = String(raw || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 120);
    return n || 'reference';
  };

  app.post('/api/pos/quote-desk/:no/attachments', auth('cashier'), photoUpload, wrap(async (req, res) => {
    const mime = sniff(req.body);
    if (!mime) throw bad('attachment', 'Choose a JPG, PNG, WEBP image or a PDF (max 5 MB)');
    const id = await tx(async (client) => {
      const q = await loadQuoteForFile(client, req.params.no);
      const n = await client.query('SELECT count(*)::int AS n FROM quote_attachments WHERE quote_id = $1', [q.quote_id]);
      if (n.rows[0].n >= MAX_FILES) throw bad('attachment', `A quotation can have up to ${MAX_FILES} reference files. Remove one first`);
      const ins = await client.query(
        `INSERT INTO quote_attachments (quote_id, file_name, mime, size_bytes, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING attachment_id`,
        [q.quote_id, fileNameOf(req.query.name), mime, req.body.length, req.body, req.user.id]);
      await client.query('UPDATE quote_requests SET updated_at = now() WHERE quote_id = $1', [q.quote_id]);
      await audit(client, req.user, 'Record edited', `Reference file added to quote ${q.quote_no}`);
      return Number(ins.rows[0].attachment_id);
    });
    res.status(201).json({ id });
  }));

  // Cashier or Finance can read the file; the query is keyed on the quote reference so one quote's id cannot leak another's.
  app.get('/api/pos/quote-desk/:no/attachments/:id', auth('cashier', 'finance'), wrap(async (req, res) => {
    if (!/^\d{1,12}$/.test(String(req.params.id))) throw bad('attachment', 'File not found');
    const r = await pool.query(
      `SELECT a.mime, a.data, a.file_name FROM quote_attachments a JOIN quote_requests q ON q.quote_id = a.quote_id
        WHERE a.attachment_id = $1 AND q.quote_no = $2`, [Number(req.params.id), req.params.no]);
    if (!r.rowCount) throw bad('attachment', 'File not found');
    res.setHeader('Content-Type', r.rows[0].mime);
    res.setHeader('Content-Disposition', 'inline; filename="' + String(r.rows[0].file_name).replace(/["\r\n]/g, '') + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(r.rows[0].data);
  }));

  app.delete('/api/pos/quote-desk/:no/attachments/:id', auth('cashier'), wrap(async (req, res) => {
    if (!/^\d{1,12}$/.test(String(req.params.id))) throw bad('attachment', 'File not found');
    await tx(async (client) => {
      const q = await loadQuoteForFile(client, req.params.no);
      const del = await client.query('DELETE FROM quote_attachments WHERE attachment_id = $1 AND quote_id = $2', [Number(req.params.id), q.quote_id]);
      if (!del.rowCount) throw bad('attachment', 'File not found');
      await audit(client, req.user, 'Record edited', `Reference file removed from quote ${q.quote_no}`);
    });
    res.json({ ok: true });
  }));

  /* ---------------- accepted quotation -> order / POS transaction ----------------
     Exactly once: the same requestId retried returns the order that was already made; a second click with a fresh
     requestId is still refused once converted_order_id is set. Stock is only checked here, never taken out: goods leave
     inventory in the existing order-confirm / POS-sale paths, and the order is created unpaid. */
  app.post('/api/pos/quote-desk/:no/convert', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && REQUEST_ID_RE.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'A conversion identifier is required. Refresh the page and try again.');
    const out = await tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [74120, req.user.id]);
      const q = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!q) throw bad('id', 'Quotation not found');
      if (q.converted_order_id) {                                   // already converted: hand back the same order
        const o = (await client.query('SELECT order_no, total, status FROM orders WHERE order_id = $1', [q.converted_order_id])).rows[0];
        return { kind: 'order', duplicate: true, orderNo: o && o.order_no, total: o ? +o.total : null };
      }
      if (q.status !== 'accepted') throw bad('status', 'Only a quotation the customer accepted can be converted');
      if (q.quoted_amount == null) throw bad('amount', 'This quotation has no approved price yet');
      if (!q.product_sku) throw bad('product', 'This is a custom item with no catalog product. Finance records it as a production order instead');
      const qv = splitQuantity(q.quantity);
      if (!qv) throw bad('quantity', 'The quoted quantity could not be read. Contact Finance');

      if (q.source === 'pos' || !q.customer_id) {                   // walk-in: the counter rings it up as a normal POS sale
        const p = (await client.query(
          `SELECT product_id, sku, name, unit, selling_price, on_hand FROM products
            WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [q.product_sku.toUpperCase()])).rows[0];
        if (!p) throw bad('product', 'That catalog product is no longer sold at the counter');
        if (+p.on_hand < qv.qty) throw bad('stock', `Only ${+p.on_hand} ${p.unit} of ${p.name} are in stock`);
        const hand = (await client.query(
          `UPDATE quote_requests SET handover_at = now(), updated_at = now() WHERE quote_id = $1 AND handover_at IS NULL RETURNING handover_at`,
          [q.quote_id])).rows[0];
        if (!hand) throw bad('status', 'This quotation was already handed to the counter. Finish that sale or void it first');
        await audit(client, req.user, 'Record added', `Quote ${q.quote_no} handed to the POS terminal (${qv.qty} ${qv.unit} of ${p.sku})`);
        return { kind: 'pos', sku: p.sku, name: p.name, unit: p.unit, qty: qv.qty, unitPrice: round2(+q.quoted_amount / qv.qty), stock: +p.on_hand, customer: q.contact_name, phone: q.phone, quoteNo: q.quote_no };
      }

      const p = (await client.query(
        `SELECT product_id, sku, name, unit, selling_price, on_hand, shop_visible FROM products
          WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [q.product_sku.toUpperCase()])).rows[0];
      if (!p) throw bad('product', 'That catalog product is no longer available');
      if (+p.on_hand < qv.qty) throw bad('stock', `Only ${+p.on_hand} ${p.unit} of ${p.name} are in stock. Ask the customer to adjust the quantity`);

      // an order needs the payment method and, for delivery, a structured address
      const method = q.pay_method === 'Xendit' ? 'Xendit' : (q.fulfillment === 'Delivery' ? 'Cash on Delivery' : 'Cash on Pickup');
      let ship = null;
      if (q.fulfillment === 'Delivery') {
        ship = await buildShipTo(client, q, b.shipTo || {});
      }
      const ins = await client.query(
        `INSERT INTO orders (customer_id, fulfillment, address, phone, payment_method, subtotal, delivery_fee, total,
                             recipient_name, address_line, landmark, barangay, city, province, region, zip_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [q.customer_id, q.fulfillment, ship ? ship.fullAddress : (q.area || null), q.phone, method, +q.quoted_amount, 0, +q.quoted_amount,
         ship && ship.recipient, ship && ship.addressLine, ship && ship.landmark || null, ship && ship.barangay, ship && ship.city,
         ship && ship.province, ship && ship.region, ship && ship.zip]);
      const o = ins.rows[0];
      await client.query(
        `INSERT INTO order_items (order_id, product_id, sku, name, unit, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.order_id, p.product_id, p.sku, p.name, p.unit, qv.qty, round2(+q.quoted_amount / qv.qty)]);
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
        [o.order_id, o.status, o.status, req.user.id, `Created from accepted quotation ${q.quote_no} (${peso(q.quoted_amount)})`]);
      await client.query(
        `UPDATE quote_requests SET converted_order_id = $2, converted_at = now(), convert_request_id = $3, converted_note = $4, updated_at = now() WHERE quote_id = $1`,
        [q.quote_id, o.order_id, requestId, `Converted by ${req.user.name || 'cashier'}`]);
      await audit(client, req.user, 'Record added', `Quote ${q.quote_no} converted to order ${o.order_no} (${qv.qty} ${qv.unit} of ${p.sku}, ${peso(q.quoted_amount)})`);
      return { kind: 'order', orderNo: o.order_no, total: +o.total, status: o.status, method, customerId: q.customer_id, quoteNo: q.quote_no, duplicate: false };
    });
    res.json(out);
    if (out.kind === 'order' && !out.duplicate) {
      Promise.resolve(pingFinance({ category: 'orders', title: 'Quotation converted to an order', body: `${out.quoteNo} is now order ${out.orderNo} (${peso(out.total)}), waiting for the normal payment and stock steps.`, link: 'Finance_Inventory.html#orders', entityType: 'order', entityId: out.orderNo })).catch(() => {});
    }
  }));

  /* Delivery orders need the structured Philippine address the shop uses. The quotation only stored a single text line, so
     the cashier confirms the parts in the convert dialog; anything already saved on the quote is offered first. */
  async function buildShipTo(client, q, typed) {
    const from = {
      recipient: str(typed.recipient) || str(q.contact_name), phone: str(typed.phone) || str(q.phone),
      addressLine: str(typed.addressLine), landmark: str(typed.landmark) || undefined,
      barangay: str(typed.barangay), city: str(typed.city), province: str(typed.province), region: str(typed.region), zip: str(typed.zip)
    };
    if (!validateShipTo) throw bad('address', 'Delivery details could not be checked right now. Convert this quote from the Online Orders screen');
    try {
      const ship = await validateShipTo(from);
      ship.fullAddress = formatShipTo ? formatShipTo(ship) : [ship.addressLine, ship.barangay, ship.city, ship.province, ship.zip].filter(Boolean).join(', ');
      return ship;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw bad('address', 'Enter the full delivery address (region, province, city, barangay, ZIP) before converting');
    }
  }

  /* Called by the POS sale when a cashier rings up a handed-over walk-in quote: keeps the reference and refuses a second
     link, so one quote can never cover two receipts. */
  app.locals.quoteDesk = {
    linkSale: async (client, quoteNo, saleId) => {
      const q = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [quoteNo])).rows[0];
      if (!q) throw bad('quote', 'That quotation reference was not found');
      if (q.handover_sale_id && Number(q.handover_sale_id) !== Number(saleId)) throw bad('quote', 'This quotation was already used on another receipt');
      await client.query('UPDATE quote_requests SET handover_sale_id = $2, updated_at = now() WHERE quote_id = $1', [q.quote_id, saleId]);
      return q;
    },
    ready
  };

  return { ready, briefJson, detailJson, splitQuantity, sniff, labelFor };
};
