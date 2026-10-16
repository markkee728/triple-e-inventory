/* Phone (SMS) verification for every account (customers, cashiers and finance staff).

   An account must verify BOTH the email (link) and the mobile number (6-digit code) before they can sign in.
   Staff: the emailed invitation link already proves the email (step 1 is done at sign-up), so they only do step 2.
   The steps go in order: 1) the email link, 2) the mobile code. The code is only texted once the email is verified.
   It is texted through sms.js (TextBee). Without TextBee set up in .env, the code is printed in the
   server console instead, so it can still be tested on a developer computer.

   The visitor is not signed in yet, so these routes are opened with a short-lived "pending token"
   (signed with a key derived from JWT_SECRET, valid 30 minutes). The sign-up route and the sign-in route
   hand it out - sign-in only after the password was right. It can never be used as a login session.

     POST /api/auth/verification-status   { token }         -> what is verified so far
     POST /api/auth/phone-otp/send        { token }         -> send / resend the code (60 s apart, 5 per hour)
     POST /api/auth/phone-otp/verify      { token, code }   -> check the code (5 wrong tries, then ask for a new one)

   Only an HMAC of the code is stored, never the code itself. */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sms = require('./sms');

const OTP_TTL_MIN = Math.min(Math.max(Number(process.env.PHONE_OTP_TTL_MIN) || 5, 1), 30);
const RESEND_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;
const MAX_WRONG_TRIES = 5;
const PENDING_TTL = '30m';

module.exports = function ({ app, pool, wrap, tx, audit, str, phoneVerificationOn, emailVerificationOn }) {
  const pendingKey = () => String(process.env.JWT_SECRET) + ':pending-verification';
  const hmac = (userId, code) => crypto.createHmac('sha256', pendingKey()).update(userId + ':' + code).digest('hex');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  const issuePendingToken = (userId) => jwt.sign({ uid: userId, purpose: 'pending-verification' }, pendingKey(), { expiresIn: PENDING_TTL });
  function readPendingToken(token) {
    try {
      const p = jwt.verify(String(token || ''), pendingKey());
      return p && p.purpose === 'pending-verification' && Number.isInteger(p.uid) ? p.uid : null;
    } catch { return null; }
  }
  // An account owes a mobile verification when the feature is on, it has a mobile number, and that number is not confirmed yet.
  // (Accounts with no number - e.g. the first admin made with scripts/create-user.js - are never blocked.)
  const needsPhone = (u) => !!phoneVerificationOn && !!u && !!u.phone && !u.phone_verified_at;
  const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length < 4 ? '' : '+63 *** *** ' + d.slice(-4); };

  // small per-IP limiter (resets on restart)
  const hits = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const key = name + ':' + req.ip, now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    list.push(now); hits.set(key, list);
    next();
  };

  async function ensureSchema() {
    try {
      // accounts that already exist count as verified; only new accounts must verify their phone (backfill runs once, when the column is added)
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'phone_verified_at') THEN
          ALTER TABLE users ADD COLUMN phone_verified_at TIMESTAMPTZ;
          UPDATE users SET phone_verified_at = COALESCE(created_at, now());
        END IF; END $$`);
      await pool.query(`CREATE TABLE IF NOT EXISTS phone_otps (
        otp_id      BIGSERIAL PRIMARY KEY,
        user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        phone       TEXT NOT NULL,
        code_hash   TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        wrong_tries INT NOT NULL DEFAULT 0,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_phone_otps_user ON phone_otps (user_id, created_at DESC)');
    } catch (err) { console.warn('[db] could not prepare the phone verification table:', err.message); }
  }
  const ready = ensureSchema();
  app.locals.phoneReady = ready;

  /* Make and text a new code. Used by the sign-up route and by /phone-otp/send.
     Returns { ok, sent, waitSeconds?, message? }. Any older unused code stops working. */
  async function sendOtp(userId) {
    await ready;
    const u = (await pool.query('SELECT user_id, phone, phone_verified_at, email_verified_at FROM users WHERE user_id = $1', [userId])).rows[0];
    if (u && emailVerificationOn && !u.email_verified_at) return { ok: false, message: 'Verify your email first. The code for your mobile number is sent right after.' };   // step 1 before step 2
    if (!u || !u.phone) return { ok: false, message: 'There is no mobile number on this account.' };
    if (u.phone_verified_at) return { ok: true, sent: false, alreadyVerified: true };

    const recent = (await pool.query(
      `SELECT count(*)::int AS n, max(created_at) AS last,
              (SELECT floor(extract(epoch FROM o.expires_at - now()))::int FROM phone_otps o
                WHERE o.user_id = $1 AND o.used_at IS NULL ORDER BY o.created_at DESC LIMIT 1) AS expires_in
         FROM phone_otps WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [userId])).rows[0];
    if (recent.last) {
      const wait = RESEND_SECONDS - Math.floor((Date.now() - new Date(recent.last).getTime()) / 1000);
      // a code went out a moment ago (e.g. the page was open in two tabs): not an error, the same code is still valid
      if (wait > 0) return { ok: true, sent: false, recent: true, waitSeconds: wait, expiresIn: Math.max(recent.expires_in || 0, 0) };
    }
    if (recent.n >= MAX_SENDS_PER_HOUR) return { ok: false, waitSeconds: 600, message: 'Too many codes were sent. Please try again in about an hour.' };

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query('UPDATE phone_otps SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [userId]);
    await pool.query(
      `INSERT INTO phone_otps (user_id, phone, code_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [userId, u.phone, hmac(userId, code), String(OTP_TTL_MIN)]);

    const r = await sms.sendSms({
      to: u.phone,
      message: `Triple E Metal Products: your verification code is ${code}. It expires in ${OTP_TTL_MIN} minutes. Do not share this code with anyone.`
    });
    if (!r.sent && !sms.isConfigured()) console.log(`[otp] SMS is not set up, so use this code for ${u.phone} while testing: ${code}`);
    return { ok: true, sent: !!r.sent, waitSeconds: RESEND_SECONDS, expiresIn: OTP_TTL_MIN * 60,
      message: r.sent ? '' : 'The text message could not be sent (' + (r.reason || 'unknown reason') + '). Try Resend in a minute.' };
  }
  app.locals.phoneOtp = { sendOtp, issuePendingToken, needsPhone };

  async function statusOf(userId) {
    const u = (await pool.query(
      `SELECT email, phone, (email_verified_at IS NOT NULL) AS email_verified, (phone_verified_at IS NOT NULL) AS phone_verified
         FROM users WHERE user_id = $1 AND status = 'active'`, [userId])).rows[0];
    if (!u) return null;
    return { email: u.email, phoneMasked: maskPhone(u.phone), emailVerified: u.email_verified,
      phoneVerified: !needsPhone({ phone: u.phone, phone_verified_at: u.phone_verified ? 1 : null }),
      canSignIn: u.email_verified && !needsPhone({ phone: u.phone, phone_verified_at: u.phone_verified ? 1 : null }) };
  }

  const BAD_TOKEN = 'This verification session expired. Please sign in again to continue.';

  app.post('/api/auth/verification-status', limit('vstatus', 120, 15 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const uid = readPendingToken(req.body && req.body.token);
    if (!uid) return res.status(401).json({ error: BAD_TOKEN });
    const s = await statusOf(uid);
    if (!s) return res.status(401).json({ error: BAD_TOKEN });
    res.json(s);
  }));

  app.post('/api/auth/phone-otp/send', limit('otp-send', 20, 60 * 60 * 1000), wrap(async (req, res) => {
    const uid = readPendingToken(req.body && req.body.token);
    if (!uid) return res.status(401).json({ error: BAD_TOKEN });
    const r = await sendOtp(uid);
    if (!r.ok) return res.status(r.waitSeconds ? 429 : 400).json({ error: r.message, waitSeconds: r.waitSeconds || 0 });
    res.json({ ok: true, sent: r.sent, recent: !!r.recent, alreadyVerified: !!r.alreadyVerified, waitSeconds: r.waitSeconds || 0, expiresIn: r.expiresIn || 0, message: r.message || '' });
  }));

  app.post('/api/auth/phone-otp/verify', limit('otp-verify', 30, 15 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const uid = readPendingToken(req.body && req.body.token);
    if (!uid) return res.status(401).json({ error: BAD_TOKEN });
    const code = str(req.body && req.body.code);
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });

    const out = await tx(async (client) => {
      const r = await client.query(
        `SELECT o.otp_id, o.code_hash, o.wrong_tries, u.full_name, ro.label
           FROM phone_otps o JOIN users u ON u.user_id = o.user_id JOIN roles ro ON ro.role_id = u.role_id
          WHERE o.user_id = $1 AND o.used_at IS NULL AND o.expires_at > now() AND u.phone = o.phone
          ORDER BY o.created_at DESC LIMIT 1 FOR UPDATE OF o`, [uid]);
      const o = r.rows[0];
      if (!o) return { status: 400, error: 'That code has expired. Tap Resend to get a new one.' };
      if (o.wrong_tries >= MAX_WRONG_TRIES) {
        await client.query('UPDATE phone_otps SET expires_at = now() WHERE otp_id = $1', [o.otp_id]);
        return { status: 400, error: 'Too many wrong tries. Tap Resend to get a new code.' };
      }
      if (!same(o.code_hash, hmac(uid, code))) {
        await client.query('UPDATE phone_otps SET wrong_tries = wrong_tries + 1 WHERE otp_id = $1', [o.otp_id]);
        const left = MAX_WRONG_TRIES - o.wrong_tries - 1;
        return { status: 400, error: left > 0 ? 'Wrong code. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' : 'Too many wrong tries. Tap Resend to get a new code.' };
      }
      await client.query('UPDATE phone_otps SET used_at = now() WHERE otp_id = $1', [o.otp_id]);
      await client.query('UPDATE users SET phone_verified_at = now() WHERE user_id = $1', [uid]);
      await audit(client, { id: uid, name: o.full_name, roleLabel: o.label }, 'Account verified', 'Mobile number verified');
      return { ok: true };
    });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, ...(await statusOf(uid)) });
  }));
};
