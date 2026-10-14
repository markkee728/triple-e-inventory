/* Low-stock alerts: email + text to the Finance team when a product falls to its reorder level.

   A product is "low" when  on_hand <= reorder_level  (and a reorder level is set). The check runs
     - a few seconds after any change made through the API (a sale, an order, stock in/out, a stock count ...),
     - every LOW_STOCK_CHECK_MINUTES minutes (default 15) while the server is running,
     - whenever  POST/GET /api/low-stock/check  is called with the header  x-cron-key: <LOW_STOCK_CRON_KEY>
       (use Cloud Scheduler for this on Cloud Run, so alerts still go out when the server was idle).
   Every product is alerted ONCE per drop: it is remembered in low_stock_alerts and only alerts again after its
   stock has been back above the reorder level. Products that go low at the same time share one email and one text.

   Who is told: every active Finance user (their account email and phone), or the lists below when you set them:
     LOW_STOCK_EMAIL_TO   comma-separated emails      LOW_STOCK_SMS_TO   comma-separated mobile numbers
   Switches:  LOW_STOCK_ALERTS=off (everything)   LOW_STOCK_SMS=off (email only)
   Email uses mailer.js, the text uses sms.js (TextBee). Neither ever breaks a sale or an API call. */
const mailer = require('./mailer');
const sms = require('./sms');
const { escapeHtml: esc } = mailer;

const env = (k) => String(process.env[k] || '').trim();
const off = (k) => env(k).toLowerCase() === 'off';
const num = (n) => String(+Number(n).toFixed(2));            // 5.00 -> "5", 2.5 -> "2.5"

module.exports = function (app, pool) {
  let schemaReady = null, running = false, timer = null;

  const ensureSchema = () => schemaReady || (schemaReady = pool.query(
    `CREATE TABLE IF NOT EXISTS low_stock_alerts (
       product_id INT PRIMARY KEY REFERENCES products(product_id) ON DELETE CASCADE,
       alerted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       on_hand    NUMERIC(14,2))`).catch((e) => { schemaReady = null; throw e; }));

  async function recipients() {
    const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
    let emails = list(env('LOW_STOCK_EMAIL_TO')), phones = list(env('LOW_STOCK_SMS_TO'));
    if (!emails.length || !phones.length) {
      const { rows } = await pool.query(
        `SELECT u.email, u.phone FROM users u JOIN roles r ON r.role_id = u.role_id WHERE r.role_key = 'finance' AND u.status = 'active'`);
      if (!emails.length) emails = rows.map((r) => r.email).filter(Boolean);
      if (!phones.length) phones = rows.map((r) => r.phone).filter(Boolean);
    }
    const seen = new Set();
    phones = phones.filter((p) => { const e = sms.toE164(p); if (!e || seen.has(e)) return false; seen.add(e); return true; });
    return { emails: [...new Set(emails.map((e) => e.toLowerCase()))], phones };
  }

  function build(items) {
    const out = items.filter((i) => +i.on_hand <= 0).length;
    const base = env('APP_BASE_URL').replace(/\/$/, '');
    const link = base ? base + '/Finance_Inventory.html' : '';
    const qty = (i) => num(i.on_hand) + (i.unit ? ' ' + i.unit : '');
    const subject = `Low stock alert: ${items.length} item${items.length === 1 ? ' needs' : 's need'} restocking` + (out ? ` (${out} out of stock)` : '');
    const rows = items.map((i) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e1e6ee">${esc(i.sku)}</td>`
      + `<td style="padding:6px 8px;border-bottom:1px solid #e1e6ee">${esc(i.name)}</td>`
      + `<td style="padding:6px 8px;border-bottom:1px solid #e1e6ee;text-align:right;${+i.on_hand <= 0 ? 'color:#b02a2a;font-weight:bold' : ''}">${esc(+i.on_hand <= 0 ? 'OUT' : qty(i))}</td>`
      + `<td style="padding:6px 8px;border-bottom:1px solid #e1e6ee;text-align:right">${esc(num(i.reorder_level))}</td></tr>`).join('');
    const html = `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#1c2430">
<div style="max-width:620px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:10px;padding:28px;border:1px solid #e1e6ee">
<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#1f6fb8;font-weight:bold">Triple E Metal Products</div>
<h1 style="font-size:22px;margin:10px 0 6px">Low stock alert</h1>
<p style="margin:0 0 14px;line-height:1.5">${items.length} product${items.length === 1 ? ' has' : 's have'} reached ${items.length === 1 ? 'its' : 'their'} reorder level${out ? ` (${out} out of stock)` : ''}. Please restock.</p>
<table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="text-align:left;color:#5a6677;font-size:12px;text-transform:uppercase"><th style="padding:6px 8px">SKU</th><th style="padding:6px 8px">Product</th><th style="padding:6px 8px;text-align:right">On hand</th><th style="padding:6px 8px;text-align:right">Reorder at</th></tr>${rows}</table>
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="background:#1f6fb8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-size:14px">Open inventory</a></p>` : ''}
</div><p style="font-size:11.5px;color:#8b95a5;margin:14px 4px">You get this because you are a Finance admin of the Triple E Metal inventory system. Each product is reported once until it has been restocked.</p></div></body></html>`;
    const text = ['Low stock alert', '', ...items.map((i) => `- ${i.sku}  ${i.name}: ${+i.on_hand <= 0 ? 'OUT OF STOCK' : qty(i)} (reorder at ${num(i.reorder_level)})`),
      link ? '\nOpen inventory: ' + link : '', '\nTriple E Metal Products'].filter((x) => x !== '').join('\n');
    // text message: plain characters, at most 3 products, the rest as "+N more"
    const short = items.slice(0, 3).map((i) => `${i.name} ${+i.on_hand <= 0 ? 'OUT' : num(i.on_hand) + ' left'}`).join('; ');
    const message = `Triple E Metal LOW STOCK: ${short}${items.length > 3 ? ` +${items.length - 3} more` : ''}. Please restock.`;
    return { subject, html, text, message };
  }

  async function check() {
    if (off('LOW_STOCK_ALERTS') || running) return { checked: false };
    running = true;
    try {
      await ensureSchema();
      // products that are back above their level (or archived / no level) can alert again next time they drop
      await pool.query(`DELETE FROM low_stock_alerts a USING products p WHERE p.product_id = a.product_id
                          AND (p.on_hand > p.reorder_level OR p.reorder_level <= 0 OR p.is_archived)`);
      // claim the newly low products; if two servers run at once only one of them gets each product
      const claimed = await pool.query(
        `INSERT INTO low_stock_alerts (product_id, on_hand)
         SELECT product_id, on_hand FROM products WHERE NOT is_archived AND reorder_level > 0 AND on_hand <= reorder_level
         ON CONFLICT (product_id) DO NOTHING RETURNING product_id`);
      if (!claimed.rowCount) return { checked: true, alerted: 0 };
      const ids = claimed.rows.map((r) => r.product_id);
      const { rows: items } = await pool.query(
        `SELECT sku, name, unit, on_hand, reorder_level FROM products WHERE product_id = ANY($1)
          ORDER BY (on_hand <= 0) DESC, on_hand / NULLIF(reorder_level, 0), name`, [ids]);
      const to = await recipients();
      const m = build(items);
      let delivered = 0;
      for (const email of to.emails) {
        const r = await mailer.sendMail({ to: email, subject: m.subject, html: m.html, text: m.text, tag: 'low-stock' }).catch((e) => ({ sent: false, reason: e.message }));
        if (r.sent) delivered++; else console.warn(`[low-stock] email to ${email} not sent: ${r.reason}`);
      }
      if (!off('LOW_STOCK_SMS')) for (const phone of to.phones) {
        const r = await sms.sendSms({ to: phone, message: m.message }).catch((e) => ({ sent: false, reason: e.message }));
        if (r.sent) delivered++; else console.warn(`[low-stock] text to ${phone} not sent: ${r.reason}`);
      }
      if (!delivered) {   // nobody could be told: forget the claim so the next check tries again
        await pool.query('DELETE FROM low_stock_alerts WHERE product_id = ANY($1)', [ids]);
        console.warn(`[low-stock] ${items.length} low product(s) found but no alert could be delivered; will retry.`);
        return { checked: true, alerted: 0, retry: true };
      }
      console.log(`[low-stock] alerted ${to.emails.length} email(s) / ${to.phones.length} number(s) about ${items.length} product(s)`);
      return { checked: true, alerted: items.length };
    } catch (err) {
      console.error('[low-stock] check failed:', err.message);
      return { checked: false, error: true };
    } finally { running = false; }
  }

  // a few seconds after any change made through the API (debounced so a busy minute is one check)
  let soon = null;
  const checkSoon = () => { clearTimeout(soon); soon = setTimeout(check, 3000); soon.unref && soon.unref(); };
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !req.path.startsWith('/low-stock')) res.on('finish', checkSoon);
    next();
  });

  // for Cloud Scheduler (or any timer): keeps alerts working when the server has been idle
  const cron = async (req, res) => {
    const key = env('LOW_STOCK_CRON_KEY');
    if (!key || req.get('x-cron-key') !== key) return res.status(404).json({ error: 'Not found' });
    res.json(await check());
  };
  app.get('/api/low-stock/check', cron);
  app.post('/api/low-stock/check', cron);

  const every = Math.max(1, Number(env('LOW_STOCK_CHECK_MINUTES')) || 15) * 60000;
  timer = setInterval(check, every); timer.unref && timer.unref();
  const first = setTimeout(check, 30000); first.unref && first.unref();
  return { check };
};
