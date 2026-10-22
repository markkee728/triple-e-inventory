/* security.test.js — proves the hardening in security.js works (OWASP Top 10:2025 A01, A02, A04, A07, A09).
   No database needed.   node test/security.test.js      (or: node --test test/security.test.js)
   Evidence for tests T-03 (headers), T-04 (cookie), T-10 (rate limit), T-14 (no cache) and the CSRF origin check. */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const security = require('../security');

function start(limits, env) {
  Object.assign(process.env, env || {});
  const app = express();
  security.mount({ app, pool: null, limits });
  app.use(express.json());
  app.get('/page', (req, res) => res.send('ok'));
  app.get('/api/data', (req, res) => res.json({ ok: true }));
  app.post('/api/data', (req, res) => res.json({ saved: true }));
  app.post('/api/auth/login', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/forgot/send', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => { const server = app.listen(0, () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port })); });
}

test('security headers are on every response', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 });
  const r = await fetch(base + '/page');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  const csp = r.headers.get('content-security-policy');
  for (const part of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) assert.ok(csp.includes(part), part);
  assert.equal(r.headers.get('x-powered-by'), null);
  server.close();
});

test('HSTS is sent in production only', async () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const a = await start({ general: 1000, auth: 1000 });
  assert.match((await fetch(a.base + '/page')).headers.get('strict-transport-security'), /max-age=31536000/);
  a.server.close();
  process.env.NODE_ENV = 'development';
  const b = await start({ general: 1000, auth: 1000 });
  assert.equal((await fetch(b.base + '/page')).headers.get('strict-transport-security'), null);
  b.server.close();
  process.env.NODE_ENV = old;
});

test('API responses are never cached', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 });
  assert.equal((await fetch(base + '/api/data')).headers.get('cache-control'), 'no-store');
  server.close();
});

test('a state-changing request from another site is blocked (CSRF)', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 });
  const evil = await fetch(base + '/api/data', { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(evil.status, 403);
  const same = await fetch(base + '/api/data', { method: 'POST', headers: { Origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(same.status, 200);
  const none = await fetch(base + '/api/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 200, 'server-to-server calls without an Origin still work');
  const badRef = await fetch(base + '/api/data', { method: 'POST', headers: { Referer: 'https://evil.example/x', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(badRef.status, 403);
  const read = await fetch(base + '/api/data', { headers: { Origin: 'https://evil.example' } });
  assert.equal(read.status, 200, 'reading is not blocked by the origin check');
  server.close();
});

test('ALLOWED_ORIGINS lets a listed host through', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 }, { ALLOWED_ORIGINS: 'shop.example.com' });
  const r = await fetch(base + '/api/data', { method: 'POST', headers: { Origin: 'https://shop.example.com', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  delete process.env.ALLOWED_ORIGINS;
  server.close();
});

test('the general rate limit answers 429 with Retry-After', async () => {
  const { server, base } = await start({ general: 3, auth: 1000 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(base + '/api/data')).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const r = await fetch(base + '/api/data');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await fetch(base + '/page')).status, 200, 'pages outside /api are not limited');
  server.close();
});

test('sign-in and OTP routes have a stricter limit than the rest of the API', async () => {
  const { server, base } = await start({ general: 1000, auth: 2 });
  const post = (p) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
  assert.deepEqual([await post('/api/auth/login'), await post('/api/auth/login'), await post('/api/auth/login')], [200, 200, 429]);
  assert.equal(await post('/api/auth/forgot/send'), 429, 'the limit is shared across the sensitive routes');
  assert.equal(await post('/api/data'), 200, 'ordinary routes are not affected');
  server.close();
});

test('the session cookie is Secure in production unless switched off on purpose', () => {
  const keep = { n: process.env.NODE_ENV, c: process.env.COOKIE_SECURE };
  process.env.NODE_ENV = 'production'; delete process.env.COOKIE_SECURE;
  assert.equal(security.cookieSecure(), true);
  process.env.COOKIE_SECURE = 'false'; assert.equal(security.cookieSecure(), false);
  process.env.NODE_ENV = 'development'; delete process.env.COOKIE_SECURE;
  assert.equal(security.cookieSecure(), false);
  process.env.COOKIE_SECURE = 'true'; assert.equal(security.cookieSecure(), true);
  if (keep.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = keep.n;
  if (keep.c === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = keep.c;
});

test('the audit log trigger SQL refuses UPDATE and DELETE', () => {
  assert.match(security.AUDIT_SQL, /BEFORE UPDATE OR DELETE ON audit_log/);
  assert.match(security.AUDIT_SQL, /RAISE EXCEPTION 'audit_log is append-only/);
});
