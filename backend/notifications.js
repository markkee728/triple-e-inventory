/* In-app Notification Center.
   One row per recipient. Customers only ever receive rows for their own user_id.
   Low-stock uses a partial unique index on (user_id, dedupe_key) while unresolved so the same
   SKU does not spam; restocking resolves the row and the next drop can alert again. */

module.exports = function ({ app, pool, auth, wrap, TZ }) {
  let schemaReady = null;

  const ensure = () => schemaReady || (schemaReady = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
      notification_id BIGSERIAL PRIMARY KEY,
      user_id         INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      role_key        TEXT NOT NULL,
      category        TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      link            TEXT,
      entity_type     TEXT,
      entity_id       TEXT,
      dedupe_key      TEXT,
      severity        TEXT NOT NULL DEFAULT 'info',
      is_read         BOOLEAN NOT NULL DEFAULT FALSE,
      read_at         TIMESTAMPTZ,
      is_resolved     BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at     TIMESTAMPTZ,
      meta            JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications (user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id) WHERE NOT is_read`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_open_dedupe
      ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND NOT is_resolved`);
  })().catch((e) => { schemaReady = null; throw e; }));

  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function roleUserIds(roleKey) {
    const { rows } = await pool.query(
      `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE r.role_key = $1 AND u.status = 'active'`, [roleKey]);
    return rows.map((r) => r.user_id);
  }

  async function insertFor(userIds, n, roleKey) {
    if (!userIds.length) return 0;
    await ensure();
    const title = String(n.title || '').slice(0, 180);
    const body = String(n.body || '').slice(0, 2000);
    if (!title || !body) return 0;
    const category = String(n.category || 'system').slice(0, 40);
    const link = n.link ? String(n.link).slice(0, 300) : null;
    const entityType = n.entityType ? String(n.entityType).slice(0, 40) : null;
    const entityId = n.entityId != null ? String(n.entityId).slice(0, 80) : null;
    const dedupe = n.dedupeKey ? String(n.dedupeKey).slice(0, 160) : null;
    const severity = ['info', 'warn', 'critical'].includes(n.severity) ? n.severity : 'info';
    const meta = n.meta ? JSON.stringify(n.meta) : null;
    let added = 0;
    for (const uid of userIds) {
      try {
        const r = await pool.query(
          `INSERT INTO notifications
             (user_id, role_key, category, title, body, link, entity_type, entity_id, dedupe_key, severity, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
           ON CONFLICT (user_id, dedupe_key) WHERE (dedupe_key IS NOT NULL AND NOT is_resolved) DO NOTHING
           RETURNING notification_id`,
          [uid, roleKey, category, title, body, link, entityType, entityId, dedupe, severity, meta]);
        if (r.rowCount) added++;
      } catch (err) {
        console.warn('[notify] insert failed for user ' + uid + ':', err.message);
      }
    }
    return added;
  }

  async function notifyRole(roleKey, n) {
    try {
      const ids = await roleUserIds(roleKey);
      return await insertFor(ids, n, roleKey);
    } catch (err) {
      console.warn('[notify] role ' + roleKey + ':', err.message);
      return 0;
    }
  }

  async function notifyUser(userId, n, roleKey) {
    try {
      if (!userId) return 0;
      let role = roleKey;
      if (!role) {
        const { rows } = await pool.query(
          `SELECT r.role_key FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`, [userId]);
        role = rows[0] && rows[0].role_key;
      }
      if (!role) return 0;
      return await insertFor([userId], n, role);
    } catch (err) {
      console.warn('[notify] user ' + userId + ':', err.message);
      return 0;
    }
  }

  async function notifyLowStock(items) {
    if (!items || !items.length) return 0;
    let n = 0;
    for (const i of items) {
      const out = +i.on_hand <= 0;
      n += await notifyRole('finance', {
        category: 'inventory',
        title: out ? 'Out of stock: ' + i.name : 'Low stock: ' + i.name,
        body: (i.department ? i.department + ' \u00B7 ' : '') + i.sku + ' \u2014 ' +
          (out ? 'OUT OF STOCK' : (Number(i.on_hand) + (i.unit ? ' ' + i.unit : '') + ' on hand')) +
          ', reorder at ' + Number(i.reorder_level) + (i.unit ? ' ' + i.unit : '') +
          '. Open Inventory Monitoring or Stock In / Out to replenish.',
        link: 'Finance_Inventory.html#inventory',
        entityType: 'product',
        entityId: String(i.product_id),
        dedupeKey: 'low_stock:' + i.product_id,
        severity: out ? 'critical' : 'warn',
        meta: { sku: i.sku, department: i.department }
      });
    }
    return n;
  }

  async function resolveLowStock(productIds) {
    if (!productIds || !productIds.length) return 0;
    try {
      await ensure();
      const keys = productIds.map((id) => 'low_stock:' + id);
      const r = await pool.query(
        `UPDATE notifications SET is_resolved = TRUE, resolved_at = now()
          WHERE NOT is_resolved AND dedupe_key = ANY($1)`, [keys]);
      return r.rowCount;
    } catch (err) {
      console.warn('[notify] resolve low stock:', err.message);
      return 0;
    }
  }

  async function notifyProduction(rec) {
    if (!rec || rec.duplicate) return 0;
    const mats = [].concat(rec.rawMaterials || [], rec.finishingSupplies || [])
      .filter((i) => Number(i.actual) > 0)
      .map((i) => i.name + ' \u2212' + Number(i.actual) + ' ' + i.unit);
    return notifyRole('finance', {
      category: 'production',
      title: 'Production stock-in confirmed',
      body: rec.ref + ': Finished Goods stock-in +' + rec.quantity + ' ' + rec.unit + ' of ' + rec.product +
        (mats.length ? '. Deducted: ' + mats.join(', ') : '.') +
        ' Raw Materials and Finishing Supplies were posted as Stock Out (Used in production).',
      link: 'Finance_Inventory.html#stockflow',
      entityType: 'production',
      entityId: rec.ref,
      dedupeKey: 'production:' + rec.ref,
      severity: 'info'
    });
  }

  function orderSpecs(o, ev, extra) {
    const no = o.order_no;
    const amount = extra && extra.amount != null ? peso(extra.amount) : peso(o.total);
    const reason = extra && extra.reason ? String(extra.reason) : '';
    const note = extra && extra.note ? String(extra.note) : '';
    const shop = 'Shop_Customer.html#orders';
    const sales = 'Finance_Inventory.html#sales';
    const map = {
      placed: {
        customer: { category: 'orders', title: 'Order confirmation',
          body: 'We received order ' + no + ' for ' + peso(o.total) + ' (' + o.fulfillment + ', ' + o.payment_method + ').' },
        finance: { category: 'orders', title: 'New customer order',
          body: no + ' — ' + (o.full_name || 'Customer') + ' placed a ' + o.fulfillment + ' order for ' + peso(o.total) + ' (' + o.payment_method + ').' }
      },
      Paid: {
        customer: { category: 'payment', title: 'Payment confirmed',
          body: 'Order ' + no + ' is confirmed. Payment of ' + peso(o.total) + ' is recorded and we will start packing next.' },
        finance: { category: 'payment', title: 'Order payment confirmed',
          body: no + ' is now Paid (' + peso(o.total) + ', ' + o.payment_method + '). Stock is reserved.' }
      },
      Packed: {
        customer: { category: 'delivery', title: 'Order packed',
          body: 'Order ' + no + ' is packed' + (o.fulfillment === 'Delivery' ? ' and waiting for the delivery run.' : '. We will tell you when it is ready for pickup.') },
        finance: { category: 'delivery', title: 'Order packed', body: no + ' was marked Packed.' }
      },
      'Out for Delivery': {
        customer: { category: 'delivery', title: 'Out for delivery',
          body: 'Order ' + no + ' is out for delivery. Please keep your phone nearby.' },
        finance: { category: 'delivery', title: 'Order out for delivery', body: no + ' is out for delivery.' }
      },
      'Ready for Pickup': {
        customer: { category: 'delivery', title: 'Ready for pickup',
          body: 'Order ' + no + ' is ready for pickup. Please bring your order number and a valid ID.' },
        finance: { category: 'delivery', title: 'Order ready for pickup', body: no + ' is ready for pickup.' }
      },
      Delivered: {
        customer: { category: 'delivery', title: 'Order delivered',
          body: 'Order ' + no + ' was delivered' + (o.received_by ? ' (received by ' + o.received_by + ')' : '') + '.' },
        finance: { category: 'delivery', title: 'Order delivered', body: no + ' was marked Delivered.' }
      },
      'Picked Up': {
        customer: { category: 'delivery', title: 'Order picked up',
          body: 'Order ' + no + ' was picked up' + (o.received_by ? ' by ' + o.received_by : '') + '.' },
        finance: { category: 'delivery', title: 'Order picked up', body: no + ' was marked Picked Up.' }
      },
      Cancelled: {
        customer: { category: 'orders', title: 'Cancellation approved',
          body: 'Order ' + no + ' was cancelled' + (reason ? ': ' + reason : '.') },
        finance: { category: 'orders', title: 'Order cancelled',
          body: no + ' was cancelled' + (reason ? ': ' + reason : '.') }
      },
      cancel_declined: {
        customer: { category: 'orders', title: 'Cancellation declined',
          body: 'We could not cancel order ' + no + '. It is still being processed.', severity: 'warn' }
      },
      refund_approved: {
        customer: { category: 'payment', title: 'Refund approved',
          body: 'A refund of ' + amount + ' for order ' + no + ' was approved.' + (note ? ' Note: ' + note : '') }
      },
      refund_declined: {
        customer: { category: 'payment', title: 'Refund declined',
          body: 'The refund request for order ' + no + ' was declined.' + (note ? ' Reason: ' + note : ''), severity: 'warn' }
      }
    };
    const spec = map[ev];
    if (!spec) return null;
    const base = { entityType: 'order', entityId: no, dedupeKey: 'ord:' + ev + ':' + no };
    return {
      customer: spec.customer ? Object.assign({ link: shop, severity: spec.customer.severity || 'info' }, base, spec.customer) : null,
      finance: spec.finance ? Object.assign({ link: sales, severity: spec.finance.severity || 'info' }, base, spec.finance, { dedupeKey: 'ordfin:' + ev + ':' + no }) : null
    };
  }

  async function notifyOrder(o, ev, extra) {
    const spec = orderSpecs(o, ev, extra);
    if (!spec) return 0;
    let n = 0;
    if (spec.customer && o.customer_id) n += await notifyUser(o.customer_id, spec.customer, 'customer');
    if (spec.finance) n += await notifyRole('finance', spec.finance);
    return n;
  }

  function shape(r) {
    return {
      id: Number(r.notification_id),
      category: r.category,
      title: r.title,
      body: r.body,
      link: r.link || '',
      entityType: r.entity_type || undefined,
      entityId: r.entity_id || undefined,
      severity: r.severity,
      isRead: r.is_read,
      isResolved: r.is_resolved,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      when: r.when_label,
      meta: r.meta || undefined
    };
  }

  app.get('/api/notifications', auth(), wrap(async (req, res) => {
    await ensure();
    const unread = String(req.query.unread || '') === '1';
    const category = String(req.query.category || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 5000);
    const args = [req.user.id, TZ];
    let where = 'user_id = $1';
    if (unread) where += ' AND NOT is_read';
    if (category) { args.push(category); where += ' AND category = $' + args.length; }
    const countArgs = args.slice();
    args.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT notification_id, category, title, body, link, entity_type, entity_id, severity,
              is_read, is_resolved, created_at, meta,
              to_char(created_at AT TIME ZONE $2, 'Mon DD, YYYY HH12:MI AM') AS when_label
         FROM notifications WHERE ` + where + `
         ORDER BY created_at DESC, notification_id DESC
         LIMIT $` + (args.length - 1) + ` OFFSET $` + args.length,
      args);
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n,
              (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1 AND NOT is_read) AS unread
         FROM notifications WHERE ` + where,
      countArgs);
    res.json({
      items: rows.map(shape),
      total: count.rows[0].n,
      unread: count.rows[0].unread,
      role: req.user.role
    });
  }));

  app.get('/api/notifications/unread-count', auth(), wrap(async (req, res) => {
    await ensure();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read`, [req.user.id]);
    res.json({ unread: rows[0].n });
  }));

  app.post('/api/notifications/:id/read', auth(), wrap(async (req, res) => {
    await ensure();
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'Not found' });
    const r = await pool.query(
      `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, now())
        WHERE notification_id = $1 AND user_id = $2 RETURNING notification_id`,
      [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));

  app.post('/api/notifications/read-all', auth(), wrap(async (req, res) => {
    await ensure();
    const r = await pool.query(
      `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, now())
        WHERE user_id = $1 AND NOT is_read`, [req.user.id]);
    res.json({ ok: true, updated: r.rowCount });
  }));

  return { notifyRole, notifyUser, notifyLowStock, resolveLowStock, notifyProduction, notifyOrder, peso, ensure };
};
