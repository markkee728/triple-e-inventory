/* auth-middleware.js — session verification + role-based access control (OWASP A01 Broken Access Control, A07 Authentication Failures).

   const { auth, forgetAccountCheck, revocation } = require('./auth-middleware')(pool);
   app.get('/api/x', auth('finance'), handler);      // only finance
   app.get('/api/y', auth(), handler);               // any signed-in user

   Order of checks (the 403 happens BEFORE any database work):
     1. signed session cookie (JWT) is valid        -> else 401
     2. the role in the token is allowed for route  -> else 403 Forbidden
     3. the account is still active, its role is unchanged and its session has not been revoked
        (one small cached query)                    -> else 401 ACCOUNT_DISABLED

   Session revocation: users.token_version (db/025). The session carries the number it was issued with (tv). A password change or
   reset calls revocation.bump(), after which every older session — on every other device — is refused on its next request. */
const jwt = require('jsonwebtoken');

const ACCOUNT_CHECK_MS = 10000;

module.exports = function createAuth(pool) {
  const accountCheck = new Map();                     // user_id -> { ok, at }

  // db/025 adds users.token_version; the server also adds it at start-up so the app works before the migration is run by hand.
  // If it cannot be added, sessions simply cannot be revoked (everything else keeps working).
  const tvReady = Promise.resolve()
    .then(() => pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0'))
    .then(() => true, (e) => { console.warn('[auth] session revocation is OFF (users.token_version missing and could not be added):', e.message); return false; });

  // A disabled account (or one whose role changed, or whose sessions were revoked) loses access on its next request, not when its 8-hour cookie runs out.
  // The cache is keyed by user AND session number: an old session being refused must never make the user's new session look invalid.
  const cacheKey = (user) => user.id + ':' + (Number(user.tv) || 0);
  async function accountStillValid(user) {
    const key = cacheKey(user);
    const hit = accountCheck.get(key);
    if (hit && Date.now() - hit.at < ACCOUNT_CHECK_MS) return hit.ok;
    try {
      const withTv = await tvReady;
      const r = (await pool.query(`SELECT u.status, r.role_key${withTv ? ', u.token_version' : ''} FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1`, [user.id])).rows[0];
      // a session made before token_version existed carries no tv: it counts as version 0
      const ok = !!r && r.status === 'active' && r.role_key === user.role && (!withTv || (Number(user.tv) || 0) === (Number(r.token_version) || 0));
      accountCheck.set(key, { ok, at: Date.now() });
      if (accountCheck.size > 5000) accountCheck.clear();
      return ok;
    } catch (e) {
      console.error('[auth] could not check the account, allowing the signed session:', e.message);
      return true;                                    // a database hiccup must not sign everybody out
    }
  }

  const forgetAccountCheck = (id) => { const prefix = Number(id) + ':'; for (const k of accountCheck.keys()) if (k.startsWith(prefix)) accountCheck.delete(k); };

  const revocation = {
    ready: tvReady,
    /* Inside the password-change transaction: make every older session invalid. Returns the NEW version, which the caller puts into
       the fresh session cookie it hands back to the person who just changed the password (so they stay signed in on this device). */
    async bump(client, userId) {
      if (!(await tvReady)) return 0;
      const r = await client.query('UPDATE users SET token_version = token_version + 1 WHERE user_id = $1 RETURNING token_version', [userId]);
      return r.rows[0] ? Number(r.rows[0].token_version) : 0;
    }
  };

  function auth(...allowed) {
    return (req, res, next) => {
      try {
        req.user = jwt.verify(req.cookies.session, process.env.JWT_SECRET);
      } catch { return res.status(401).json({ error: 'Not signed in' }); }
      if (allowed.length && !allowed.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
      accountStillValid(req.user).then((ok) => {
        if (ok) return next();
        res.clearCookie('session');
        res.status(401).json({ code: 'ACCOUNT_DISABLED', error: 'This account is disabled or was changed. Please sign in again.' });
      }, next);
    };
  }

  return { auth, forgetAccountCheck, revocation };
};
