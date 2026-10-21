/* stock-count.js — physical inventory (stock count), Finance only.
   Flow:  start a count (all products or one department)  ->  the system quantities are frozen as a snapshot
          ->  type what was really counted on the shelves  ->  review the differences  ->  post.
   Posting writes one Stock In / Stock Out line per difference (reason "Stock count correction"), so the movement log,
   audit log and reports all show it. The tables are created automatically the first time the server starts. */

const DEPARTMENTS = ['Raw Materials', 'Finished Goods', 'Finishing Supplies'];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

module.exports = function mount({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });

  async function ensureSchema() {
    try {
      await pool.query('CREATE SEQUENCE IF NOT EXISTS stock_count_seq START 1');
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_counts (
        count_id    BIGSERIAL PRIMARY KEY,
        count_no    TEXT UNIQUE NOT NULL DEFAULT ('SC-' || lpad(nextval('stock_count_seq')::text, 4, '0')),
        scope       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','cancelled')),
        note        TEXT,
        created_by  INT REFERENCES users(user_id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_by   INT REFERENCES users(user_id),
        closed_at   TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_count_lines (
        line_id     BIGSERIAL PRIMARY KEY,
        count_id    BIGINT NOT NULL REFERENCES stock_counts(count_id) ON DELETE CASCADE,
        product_id  INT NOT NULL REFERENCES products(product_id),
        system_qty  NUMERIC(14,2) NOT NULL,
        counted_qty NUMERIC(14,2) CHECK (counted_qty >= 0),
        unit_cost   NUMERIC(12,2) NOT NULL DEFAULT 0,
        note        TEXT,
        UNIQUE (count_id, product_id))`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_one_open_stock_count ON stock_counts ((status)) WHERE status = \'open\'');
      // weekly schedule: the system starts a count by itself on the chosen day (see weeklyCount below)
      await pool.query('ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS scheduled BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_count_schedule (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        weekday INT NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
        scope TEXT NOT NULL DEFAULT '',
        due_days INT NOT NULL DEFAULT 2 CHECK (due_days BETWEEN 1 AND 6),
        last_run DATE,
        updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('INSERT INTO stock_count_schedule (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    } catch (err) { console.warn('[db] could not prepare the stock count tables:', err.message); }
  }
  const ready = ensureSchema();

  const countJson = (c) => ({
    id: String(c.count_id), no: c.count_no, scope: c.scope, status: c.status, note: c.note || undefined, scheduled: !!c.scheduled,
    createdBy: c.created_by_name || (c.scheduled ? 'System (weekly schedule)' : '\u2014'), closedBy: c.closed_by_name || undefined,
    createdAt: new Date(c.created_at).getTime(), closedAt: c.closed_at ? new Date(c.closed_at).getTime() : undefined,
    lines: +c.lines, counted: +c.counted, differences: +c.differences, netValue: round2(+c.net_value || 0)
  });
  // one query that gives every count with its totals (value of differences = qty difference x cost at the time of the count)
  const SUMMARY_SQL = `
    SELECT c.*, cu.full_name AS created_by_name, xu.full_name AS closed_by_name,
           COUNT(l.line_id) AS lines,
           COUNT(l.counted_qty) AS counted,
           COUNT(*) FILTER (WHERE l.counted_qty IS NOT NULL AND l.counted_qty <> l.system_qty) AS differences,
           COALESCE(SUM((l.counted_qty - l.system_qty) * l.unit_cost) FILTER (WHERE l.counted_qty IS NOT NULL), 0) AS net_value
      FROM stock_counts c
      LEFT JOIN stock_count_lines l USING (count_id)
      LEFT JOIN users cu ON cu.user_id = c.created_by
      LEFT JOIN users xu ON xu.user_id = c.closed_by`;

  const lineJson = (l) => ({
    sku: l.sku, name: l.name, unit: l.unit, department: l.department, location: l.location || '',
    systemQty: +l.system_qty, countedQty: l.counted_qty === null ? null : +l.counted_qty,
    unitCost: +l.unit_cost, note: l.note || '', onHandNow: +l.on_hand
  });
  async function loadCount(client, id) {
    if (!/^\d+$/.test(String(id))) throw bad('id', 'Stock count not found');
    const { rows } = await client.query(SUMMARY_SQL + ' WHERE c.count_id = $1 GROUP BY c.count_id, cu.full_name, xu.full_name', [id]);
    if (!rows.length) throw bad('id', 'Stock count not found');
    return rows[0];
  }

  // (the schedule routes come before /:id so "schedule" is not read as a count id)
  app.get('/api/stock-counts/schedule', auth('finance'), wrap(async (req, res) => res.json(await schedule())));
  app.put('/api/stock-counts/schedule', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, wd = Number(b.weekday), due = Number(b.dueDays), scope = str(b.scope);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw bad('weekday', 'Choose the day of the week');
    if (!Number.isInteger(due) || due < 1 || due > 6) throw bad('dueDays', 'Choose 1 to 6 days to finish the count');
    if (scope && !DEPARTMENTS.includes(scope)) throw bad('scope', 'Choose a department from the list');
    await pool.query('UPDATE stock_count_schedule SET enabled = $1, weekday = $2, scope = $3, due_days = $4, updated_by = $5, updated_at = now() WHERE id = 1',
      [b.enabled !== false, wd, scope, due, req.user.id]);
    await audit(pool, req.user, 'Record edited', `Weekly stock count: ${b.enabled === false ? 'switched off' : 'every ' + DAYS[wd] + ', ' + (scope || 'all departments') + ', post within ' + due + ' day(s)'}`);
    res.json(await schedule());
  }));

  app.get('/api/stock-counts', auth('finance'), wrap(async (req, res) => {
    await ready;
    const { rows } = await pool.query(SUMMARY_SQL + ' GROUP BY c.count_id, cu.full_name, xu.full_name ORDER BY c.created_at DESC LIMIT 100');
    res.json(rows.map(countJson));
  }));

  app.post('/api/stock-counts', auth('finance'), wrap(async (req, res) => {
    await ready;
    const dept = str((req.body || {}).department);
    if (dept && !DEPARTMENTS.includes(dept)) throw bad('department', 'Choose a department from the list');
    const note = str((req.body || {}).note).slice(0, 300);
    const id = await tx(async (client) => {
      const open = await client.query(`SELECT count_no FROM stock_counts WHERE status = 'open' LIMIT 1`);
      if (open.rowCount) throw bad('department', `Count ${open.rows[0].count_no} is still open. Finish or cancel it before starting a new one.`);
      const c = await client.query(`INSERT INTO stock_counts (scope, note, created_by) VALUES ($1,$2,$3) RETURNING count_id, count_no`,
        [dept || 'All departments', note || null, req.user.id]);
      const ins = await client.query(
        `INSERT INTO stock_count_lines (count_id, product_id, system_qty, unit_cost)
         SELECT $1, product_id, on_hand, unit_cost FROM products
          WHERE NOT is_archived AND ($2::text = '' OR department = $2) ORDER BY product_id`, [c.rows[0].count_id, dept]);
      if (!ins.rowCount) throw bad('department', 'There are no products to count in that department');
      await audit(client, req.user, 'Record added', `Stock count ${c.rows[0].count_no} started — ${dept || 'all departments'}, ${ins.rowCount} product(s)`);
      return c.rows[0].count_id;
    });
    res.status(201).json({ id: String(id) });
  }));

  app.get('/api/stock-counts/:id', auth('finance'), wrap(async (req, res) => {
    await ready;
    const c = await loadCount(pool, req.params.id);
    const { rows } = await pool.query(
      `SELECT p.sku, p.name, p.unit, p.department, p.location, p.on_hand, l.system_qty, l.counted_qty, l.unit_cost, l.note
         FROM stock_count_lines l JOIN products p USING (product_id)
        WHERE l.count_id = $1 ORDER BY p.department, p.name`, [req.params.id]);
    res.json({ ...countJson(c), items: rows.map(lineJson) });
  }));

  // Save what has been counted so far (can be called many times while the count is open). Blank = not counted yet.
  app.put('/api/stock-counts/:id/lines', auth('finance'), wrap(async (req, res) => {
    await ready;
    const lines = (req.body || {}).lines;
    if (!Array.isArray(lines) || !lines.length) throw bad('lines', 'Nothing to save');
    if (lines.length > 5000) throw bad('lines', 'Too many lines in one save');
    await tx(async (client) => {
      const c = await client.query('SELECT status FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id]);
      if (!c.rowCount) throw bad('id', 'Stock count not found');
      if (c.rows[0].status !== 'open') throw bad('id', 'This count is closed and can no longer be changed');
      for (const l of lines) {
        const sku = str(l && l.sku).toUpperCase();
        if (!sku) throw bad('lines', 'Every line needs a SKU');
        let qty = null;
        if (l.countedQty !== null && l.countedQty !== undefined && l.countedQty !== '') {
          qty = Number(l.countedQty);
          if (!Number.isFinite(qty) || qty < 0 || qty > 1e8) throw bad('lines', `Counted quantity for ${sku} must be 0 or more`);
          if (round2(qty) !== qty) throw bad('lines', `Counted quantity for ${sku} can have at most 2 decimal places`);
        }
        const note = str(l.note).slice(0, 200) || null;
        const r = await client.query(
          `UPDATE stock_count_lines SET counted_qty = $3, note = $4
            WHERE count_id = $1 AND product_id = (SELECT product_id FROM products WHERE upper(sku) = $2)`, [req.params.id, sku, qty, note]);
        if (!r.rowCount) throw bad('lines', `${sku} is not part of this count`);
      }
    });
    res.json({ ok: true });
  }));

  // Post: every counted line that differs from the snapshot becomes a Stock In / Stock Out entry.
  // The difference (counted - snapshot) is applied on top of the stock right now, so sales made while counting are not lost.
  app.post('/api/stock-counts/:id/post', auth('finance'), wrap(async (req, res) => {
    await ready;
    const result = await tx(async (client) => {
      const c = await client.query('SELECT count_id, count_no, status FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id]);
      if (!c.rowCount) throw bad('id', 'Stock count not found');
      if (c.rows[0].status !== 'open') throw bad('id', 'This count was already closed');
      const { rows } = await client.query(
        `SELECT l.product_id, l.system_qty, l.counted_qty, l.unit_cost, l.note, p.sku, p.name, p.unit, p.on_hand
           FROM stock_count_lines l JOIN products p USING (product_id)
          WHERE l.count_id = $1 ORDER BY l.product_id FOR UPDATE OF p`, [req.params.id]);
      const counted = rows.filter(r => r.counted_qty !== null);
      if (!counted.length) throw bad('lines', 'Enter at least one counted quantity before posting');
      let up = 0, down = 0, net = 0;
      const changes = counted.map(r => ({ ...r, diff: round2(+r.counted_qty - +r.system_qty) })).filter(r => r.diff !== 0);
      for (const r of changes)      // check everything first so nothing is half-posted
        if (r.diff < 0 && +r.on_hand < -r.diff)
          throw bad('lines', `${r.name}: the count is ${-r.diff} ${r.unit} lower than the system, but only ${+r.on_hand} ${r.unit} is on hand now. Recount it or check recent sales.`);
      for (const r of changes) {
        const isUp = r.diff > 0;
        await client.query(
          `INSERT INTO stock_movements (product_id, movement_type, reason, quantity, handled_by, note, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [r.product_id, isUp ? 'in' : 'out', isUp ? 'count_correction_up' : 'count_correction_down', Math.abs(r.diff), req.user.id,
           `Stock count ${c.rows[0].count_no}: counted ${+r.counted_qty}, system had ${+r.system_qty}` + (r.note ? ` — ${r.note}` : ''), +r.unit_cost]);   // cost saved when the count started
        isUp ? up++ : down++; net += r.diff * +r.unit_cost;
      }
      await client.query(`UPDATE stock_counts SET status = 'posted', closed_by = $2, closed_at = now() WHERE count_id = $1`, [req.params.id, req.user.id]);
      await audit(client, req.user, 'Record edited',
        `Stock count ${c.rows[0].count_no} posted — ${counted.length} counted, ${up} increased, ${down} decreased, net value ${round2(net)}`);
      return { no: c.rows[0].count_no, counted: counted.length, increased: up, decreased: down, unchanged: counted.length - changes.length, netValue: round2(net) };
    });
    res.json(result);
  }));

  app.post('/api/stock-counts/:id/cancel', auth('finance'), wrap(async (req, res) => {
    await ready;
    await tx(async (client) => {
      const c = await client.query('SELECT count_no, status FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id]);
      if (!c.rowCount) throw bad('id', 'Stock count not found');
      if (c.rows[0].status !== 'open') throw bad('id', 'Only an open count can be cancelled');
      await client.query(`UPDATE stock_counts SET status = 'cancelled', closed_by = $2, closed_at = now() WHERE count_id = $1`, [req.params.id, req.user.id]);
      await audit(client, req.user, 'Record edited', `Stock count ${c.rows[0].count_no} cancelled — no stock was changed`);
    });
    res.json({ ok: true });
  }));

  /* ---------- weekly scheduled count ----------
     Every week on the chosen day (Monday by default), once the store opens (BUSINESS_OPEN, 8:00 AM), the automation starts a
     count of the chosen departments, so nobody has to remember. Finance is told it is ready, reminded if it is not posted
     within due_days, and told if last week's count is still open on count day (then no second count is started). */
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const OPEN_MIN = (() => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(process.env.BUSINESS_OPEN || '')); return m ? +m[1] * 60 + +m[2] : 8 * 60; })();
  const tz = TZ || 'Asia/Manila';
  function today() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: p.year + '-' + p.month + '-' + p.day, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: (+p.hour % 24) * 60 + +p.minute };
  }
  const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  async function schedule(db) {
    await ready;
    // last_run as text: a DATE read as a JS Date shifts a day with the server time zone
    const r = (await (db || pool).query(`SELECT s.*, s.last_run::text AS last_run, u.full_name AS updated_by_name FROM stock_count_schedule s LEFT JOIN users u ON u.user_id = s.updated_by WHERE id = 1`)).rows[0] || {};
    const t = today();
    let ahead = ((r.weekday == null ? 1 : r.weekday) - t.weekday + 7) % 7;
    const ranToday = r.last_run && String(r.last_run instanceof Date ? r.last_run.toISOString().slice(0, 10) : r.last_run).slice(0, 10) === t.date;
    if (ahead === 0 && (ranToday || t.minutes >= OPEN_MIN + 24 * 60)) ahead = 7;
    return { enabled: r.enabled !== false, weekday: r.weekday == null ? 1 : r.weekday, day: DAYS[r.weekday == null ? 1 : r.weekday],
      scope: r.scope || '', scopeLabel: r.scope || 'All departments', dueDays: r.due_days || 2,
      lastRun: r.last_run ? String(r.last_run instanceof Date ? r.last_run.toISOString().slice(0, 10) : r.last_run).slice(0, 10) : null,
      nextRun: r.enabled === false ? null : (ahead === 0 && ranToday ? addDays(t.date, 7) : addDays(t.date, ahead)),
      startsAt: OPEN_MIN, updatedBy: r.updated_by_name || null };
  }
  async function weeklyCount() {
    await ready;
    const nc = app.locals.notifications, out = { started: null, reminded: 0 };
    const s = await schedule(), t = today();
    // reminder: a scheduled count still open after its due days
    const late = (await pool.query(`SELECT count_id, count_no, created_at FROM stock_counts WHERE status = 'open' AND scheduled
                                      AND created_at < now() - ($1 || ' days')::interval`, [String(s.dueDays)])).rows;
    for (const c of late) if (nc) out.reminded += await nc.notifyRole('finance', { category: 'inventory', severity: 'warn', title: 'Weekly stock count ' + c.count_no + ' is overdue',
      body: c.count_no + ' was started on ' + new Date(c.created_at).toLocaleDateString('en-PH', { timeZone: tz, month: 'short', day: 'numeric' }) + ' and is not posted yet. Finish counting and post it.',
      link: 'Finance_Inventory.html#stockflow', entityType: 'stock_count', entityId: c.count_no, dedupeKey: 'sc-late:' + c.count_id + ':' + t.date });
    if (!s.enabled || t.weekday !== s.weekday || t.minutes < OPEN_MIN || s.lastRun === t.date) return out;
    const res = await tx(async (client) => {
      const lock = await client.query('UPDATE stock_count_schedule SET last_run = $1 WHERE id = 1 AND (last_run IS DISTINCT FROM $1::date) RETURNING id', [t.date]);
      if (!lock.rowCount) return null;                                    // another server already did it today
      const open = (await client.query(`SELECT count_no FROM stock_counts WHERE status = 'open' LIMIT 1`)).rows[0];
      if (open) return { blocked: open.count_no };
      const c = await client.query(`INSERT INTO stock_counts (scope, note, created_by, scheduled) VALUES ($1, $2, NULL, TRUE) RETURNING count_id, count_no`,
        [s.scope || 'All departments', 'Weekly scheduled count (' + DAYS[s.weekday] + ')']);
      const ins = await client.query(`INSERT INTO stock_count_lines (count_id, product_id, system_qty, unit_cost)
         SELECT $1, product_id, on_hand, unit_cost FROM products WHERE NOT is_archived AND ($2::text = '' OR department = $2) ORDER BY product_id`, [c.rows[0].count_id, s.scope]);
      if (!ins.rowCount) { await client.query('DELETE FROM stock_counts WHERE count_id = $1', [c.rows[0].count_id]); return { empty: true }; }
      await audit(client, { id: null, name: 'System', role: 'system' }, 'Record added', `Stock count ${c.rows[0].count_no} started automatically (weekly schedule) — ${s.scopeLabel}, ${ins.rowCount} product(s)`);
      return { no: c.rows[0].count_no, lines: ins.rowCount };
    });
    if (!res) return out;
    if (nc && res.no) await nc.notifyRole('finance', { category: 'inventory', severity: 'info', title: 'Weekly stock count ' + res.no + ' is ready',
      body: 'Today is count day. ' + res.no + ' lists ' + res.lines + ' product(s) (' + s.scopeLabel + '). Count the shelves and post it within ' + s.dueDays + ' day(s).',
      link: 'Finance_Inventory.html#stockflow', entityType: 'stock_count', entityId: res.no, dedupeKey: 'sc-start:' + res.no });
    if (nc && res.blocked) await nc.notifyRole('finance', { category: 'inventory', severity: 'warn', title: 'Count day, but ' + res.blocked + ' is still open',
      body: 'The weekly stock count could not start because ' + res.blocked + ' is still open. Post or cancel it, then start a new count.',
      link: 'Finance_Inventory.html#stockflow', entityType: 'stock_count', entityId: res.blocked, dedupeKey: 'sc-blocked:' + t.date });
    out.started = res.no || null; out.blocked = res.blocked || null;
    return out;
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'weekly-stock-count', run: weeklyCount });
};
