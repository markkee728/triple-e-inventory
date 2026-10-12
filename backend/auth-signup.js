/* Sign-up routes.

   Customers  : sign up directly on the sign-in page (no code).             POST /api/signup/customer
   Staff      : an admin (finance) invites them by email; the email holds a
                one-time sign-up link, sent through Mailgun (mailer.js).     POST /api/invitations ...
                The link opens Login_Inventory.html?invite=<token>           GET/POST /api/signup/invite/:token

   Only a SHA-256 hash of the invite token is stored, so a copy of the database cannot be used to sign up.
   A link works once, expires (INVITE_TTL_HOURS, default 72) and is replaced when the admin resends it. */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mailer = require('./mailer');

const INVITE_TTL_HOURS = Math.min(Math.max(Number(process.env.INVITE_TTL_HOURS) || 72, 1), 24 * 14);
const INVITE_ROLES = { finance: 'Finance-Admin Officer', cashier: 'Sales Staff / Cashier' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const NAME_RE = /^[\p{L}][\p{L}\p{M}\s.'’-]*$/u;
const BAD_LINK = 'This sign-up link is invalid or has expired. Ask your administrator to send a new one.';

module.exports = function ({ app, pool, auth, wrap, tx, audit, ValidationError, str, text, EMAIL_FORMAT, phoneError, assertEmailDomain, TZ }) {

  /* ---------- helpers ---------- */
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

  // very small per-IP limiter for the public routes (resets when the server restarts)
  const hits = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const key = name + ':' + req.ip, now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    next();
  };

  function passwordProblem(pw) {
    if (typeof pw !== 'string' || !pw) return 'Choose a password';
    if (pw.length < 8) return 'Password must be at least 8 characters';
    if (pw.length > 200) return 'Password is too long';
    if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw))
      return 'Password needs an uppercase letter, a lowercase letter, a number and a symbol';
    return '';
  }

  function personFields(e, b) {
    const name = text(e, 'name', b.name, 'Full name', { min: 2, max: 100 });
    if (name && !e.name && !NAME_RE.test(name)) e.name = 'Full name can only have letters, spaces, . \' and -';
    const phone = text(e, 'phone', b.phone, 'Phone number', { min: 7, max: 30 });
    if (phone && !e.phone) { const m = phoneError(phone); if (m) e.phone = m; }
    return { name, phone };
  }

  // username is required by the users table; build one from the email and make it unique
  async function makeUsername(client, email) {
    let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24);
    if (base.length < 3) base = (base + 'user').slice(0, 24);
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : base.slice(0, 24) + Math.floor(100 + Math.random() * 9000);
      const taken = await client.query('SELECT 1 FROM users WHERE username = $1', [candidate]);
      if (!taken.rowCount) return candidate;
    }
    return base + crypto.randomBytes(3).toString('hex');
  }

  async function createUser(client, { name, email, phone, hash, roleKey }) {
    const taken = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (taken.rowCount) throw new ValidationError({ email: 'That email already has an account. Try signing in instead.' });
    const username = await makeUsername(client, email);
    try {
      const r = await client.query(
        `INSERT INTO users (full_name, username, email, password_hash, role_id, phone)
         VALUES ($1,$2,$3,$4,(SELECT role_id FROM roles WHERE role_key = $5),$6)
         RETURNING user_id`, [name, username, email, hash, roleKey, phone]);
      return r.rows[0].user_id;
    } catch (err) {
      if (err.code === '23505') throw new ValidationError({ email: 'That email already has an account. Try signing in instead.' });
      throw err;
    }
  }

  /* =====================================================
     Database: make the invitations table fit link-based invites (safe to run every time)
  ===================================================== */
  (async function ensureInvitationColumns() {
    try {
      await pool.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invitations' AND column_name = 'code') THEN
          ALTER TABLE invitations ALTER COLUMN code DROP NOT NULL;   -- the old 6-digit code is no longer used
        END IF; END $$`);
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS token_hash TEXT');
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS full_name TEXT');
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NOT NULL DEFAULT now()');
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_key ON invitations (token_hash)');
    } catch (err) { console.warn('[db] could not check the invitations columns:', err.message); }
  })();

  /* =====================================================
     CUSTOMERS — direct sign-up, no code
  ===================================================== */
  app.post('/api/signup/customer', limit('signup', 10, 60 * 60 * 1000), wrap(async (req, res) => {
    const b = req.body || {};
    const e = {};
    const { name, phone } = personFields(e, b);
    const email = str(b.email).toLowerCase();
    if (!email) e.email = 'Email is required';
    else if (email.length > 254 || !EMAIL_FORMAT.test(email)) e.email = 'Enter a valid email address';
    const pw = passwordProblem(b.password);
    if (pw) e.password = pw;
    if (Object.keys(e).length) throw new ValidationError(e);
    await assertEmailDomain(email);                         // the address must be able to receive mail

    const hash = await bcrypt.hash(b.password, 12);
    await tx(async (client) => {
      const id = await createUser(client, { name, email, phone, hash, roleKey: 'customer' });
      await audit(client, { id, name, roleLabel: 'Customer' }, 'Account created', 'Customer signed up');
    });
    res.status(201).json({ ok: true });
  }));

  /* =====================================================
     STAFF — admin sends an invite link by email
  ===================================================== */
  const baseUrl = (req) => (process.env.APP_BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  const linkFor = (req, token) => baseUrl(req) + '/Login_Inventory.html?invite=' + token;

  async function sendInvite(req, { email, name, roleKey, token }) {
    return mailer.sendCashierInvite({
      to: email, recipientName: name, roleLabel: INVITE_ROLES[roleKey], inviterName: req.user.name,
      signupUrl: linkFor(req, token), expiresHours: INVITE_TTL_HOURS
    });
  }
  const mailNote = (r) => r.sent ? '' : 'The invitation was saved, but the email could not be sent (' + r.reason + '). Use Resend once this is fixed.';

  // invite a new team member
  app.post('/api/invitations', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const e = {};
    const name = text(e, 'name', b.name, 'Full name', { min: 2, max: 100 });
    if (name && !e.name && !NAME_RE.test(name)) e.name = 'Full name can only have letters, spaces, . \' and -';
    const email = str(b.email).toLowerCase();
    if (!email) e.email = 'Email is required';
    else if (email.length > 254 || !EMAIL_FORMAT.test(email)) e.email = 'Enter a valid email address';
    const roleKey = str(b.role);
    if (!INVITE_ROLES[roleKey]) e.role = 'Choose a role';
    if (Object.keys(e).length) throw new ValidationError(e);
    await assertEmailDomain(email);

    const token = newToken();
    const id = await tx(async (client) => {
      if ((await client.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount)
        throw new ValidationError({ email: 'That email already has an account' });
      // a newer invite replaces any older unused one for the same email
      await client.query('UPDATE invitations SET revoked_at = now() WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL', [email]);
      const r = await client.query(
        `INSERT INTO invitations (email, full_name, role_id, token_hash, expires_at, created_by)
         VALUES ($1,$2,(SELECT role_id FROM roles WHERE role_key = $3),$4, now() + ($5 || ' hours')::interval, $6)
         RETURNING invitation_id`, [email, name, roleKey, hashToken(token), String(INVITE_TTL_HOURS), req.user.id]);
      await audit(client, req.user, 'Record added', `Invitation sent to ${email} (${INVITE_ROLES[roleKey]})`);
      return r.rows[0].invitation_id;
    });
    const sent = await sendInvite(req, { email, name, roleKey, token });
    res.status(201).json({ id, emailSent: sent.sent, message: mailNote(sent) });
  }));

  // pending invitations (not used, not cancelled)
  app.get('/api/invitations', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT i.invitation_id, i.email, i.full_name, r.role_key, r.label, i.expires_at < now() AS expired,
              to_char(i.sent_at AT TIME ZONE $1, 'YYYY-MM-DD HH12:MI AM') AS sent_at
         FROM invitations i JOIN roles r USING (role_id)
        WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.token_hash IS NOT NULL
        ORDER BY i.sent_at DESC`, [TZ]);
    res.json(rows.map((i) => ({ id: i.invitation_id, name: i.full_name || '', email: i.email, role: i.label,
      roleKey: i.role_key, sent: i.sent_at, status: i.expired ? 'expired' : 'pending' })));
  }));

  // send a fresh link (the old one stops working)
  app.post('/api/invitations/:id/resend', auth('finance'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Invitation not found' });
    const token = newToken();
    const inv = await tx(async (client) => {
      const r = await client.query(
        `SELECT i.email, i.full_name, r.role_key FROM invitations i JOIN roles r USING (role_id)
          WHERE i.invitation_id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL FOR UPDATE OF i`, [id]);
      if (!r.rowCount) throw new ValidationError({ invitation: 'That invitation is no longer pending' });
      if ((await client.query('SELECT 1 FROM users WHERE email = $1', [r.rows[0].email])).rowCount)
        throw new ValidationError({ invitation: 'That email already has an account' });
      await client.query(
        `UPDATE invitations SET token_hash = $2, expires_at = now() + ($3 || ' hours')::interval, sent_at = now() WHERE invitation_id = $1`,
        [id, hashToken(token), String(INVITE_TTL_HOURS)]);
      await audit(client, req.user, 'Record edited', `Invitation re-sent to ${r.rows[0].email}`);
      return r.rows[0];
    });
    const sent = await sendInvite(req, { email: inv.email, name: inv.full_name, roleKey: inv.role_key, token });
    res.json({ emailSent: sent.sent, message: mailNote(sent) });
  }));

  // cancel an invitation
  app.delete('/api/invitations/:id', auth('finance'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Invitation not found' });
    const r = await pool.query(
      'UPDATE invitations SET revoked_at = now() WHERE invitation_id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING email', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'That invitation is no longer pending' });
    await audit(pool, req.user, 'Record edited', `Invitation cancelled for ${r.rows[0].email}`);
    res.json({ ok: true });
  }));

  /* ---------- the person opening the link (public) ---------- */
  const PENDING_SQL = `SELECT i.invitation_id, i.email, i.full_name, r.role_key, r.label
      FROM invitations i JOIN roles r USING (role_id)
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`;

  app.get('/api/signup/invite/:token', limit('invite-look', 30, 15 * 60 * 1000), wrap(async (req, res) => {
    if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: BAD_LINK });
    const { rows } = await pool.query(PENDING_SQL, [hashToken(req.params.token)]);
    const i = rows[0];
    if (!i) return res.status(404).json({ error: BAD_LINK });
    res.json({ name: i.full_name || '', email: i.email, role: i.role_key, roleLabel: i.label,
      department: i.role_key === 'finance' ? 'Finance' : 'Sales' });
  }));

  app.post('/api/signup/invite/:token', limit('invite-accept', 15, 15 * 60 * 1000), wrap(async (req, res) => {
    if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: BAD_LINK });
    const b = req.body || {};
    const e = {};
    const { name, phone } = personFields(e, b);
    const pw = passwordProblem(b.password);
    if (pw) e.password = pw;
    if (Object.keys(e).length) throw new ValidationError(e);

    const hash = await bcrypt.hash(b.password, 12);
    const roleKey = await tx(async (client) => {
      const r = await client.query(PENDING_SQL + ' FOR UPDATE OF i', [hashToken(req.params.token)]);
      const i = r.rows[0];
      if (!i) { const err = new Error('bad link'); err.badLink = true; throw err; }
      const id = await createUser(client, { name, email: i.email, phone, hash, roleKey: i.role_key });
      await client.query('UPDATE invitations SET used_at = now() WHERE invitation_id = $1', [i.invitation_id]);
      await audit(client, { id, name, roleLabel: i.label }, 'Account created', 'Signed up from an invitation link');
      return i.role_key;
    }).catch((err) => { if (err.badLink) return null; throw err; });
    if (!roleKey) return res.status(404).json({ error: BAD_LINK });
    res.status(201).json({ ok: true, role: roleKey });
  }));
};
