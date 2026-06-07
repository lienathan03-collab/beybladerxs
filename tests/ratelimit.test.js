const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const RL = 'file://' + path.join(__dirname, '..', 'workers', 'bey-state-do', 'src', 'ratelimit.js').replace(/\\/g, '/');
const CLIENT = 'file://' + path.join(__dirname, '..', 'functions', 'api', '_shared', 'ratelimit.js').replace(/\\/g, '/');
const LOGIN = 'file://' + path.join(__dirname, '..', 'functions', 'api', 'login.js').replace(/\\/g, '/');

// ── pure decision ─────────────────────────────────────────────────────────────
test('rateLimitDecision: counts within a window, blocks over the limit, resets after', async () => {
  const { rateLimitDecision } = await import(RL);
  const W = 1000, L = 3;
  let s = undefined, now = 1000;
  let d = rateLimitDecision(s, now, L, W); assert.equal(d.allowed, true); assert.equal(d.next.count, 1);
  d = rateLimitDecision(d.next, now + 100, L, W); assert.equal(d.allowed, true); assert.equal(d.next.count, 2);
  d = rateLimitDecision(d.next, now + 200, L, W); assert.equal(d.allowed, true); assert.equal(d.next.count, 3);
  d = rateLimitDecision(d.next, now + 300, L, W); assert.equal(d.allowed, false, '4th in window blocked');
  assert.ok(d.retryAfterMs > 0);
  // After the window elapses, it resets.
  const after = rateLimitDecision(d.next, now + 1001, L, W);
  assert.equal(after.allowed, true);
  assert.equal(after.next.count, 1);
});

// ── client fail-open ──────────────────────────────────────────────────────────
test('checkRateLimit fails open when BEY_STATE_DO is unbound', async () => {
  const { checkRateLimit } = await import(CLIENT);
  const r = await checkRateLimit({}, 'k', 5, 1000);
  assert.equal(r.allowed, true);
});

test('checkRateLimit fails open when the DO throws', async () => {
  const { checkRateLimit } = await import(CLIENT);
  const env = { BEY_STATE_DO: { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error('down'); } }) } };
  const r = await checkRateLimit(env, 'k', 5, 1000);
  assert.equal(r.allowed, true);
});

// ── login.js integration ──────────────────────────────────────────────────────
function fakeDO(status, bodyObj) {
  return {
    idFromName: name => ({ name }),
    get: () => ({ fetch: async () => new Response(JSON.stringify(bodyObj), { status }) })
  };
}

test('login: returns 429 when the limiter denies, before checking credentials', async () => {
  const { onRequest } = await import(LOGIN);
  const env = { BEY_STATE_DO: fakeDO(429, { allowed: false, retryAfterMs: 2000, remaining: 0 }), ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'p' };
  const request = new Request('https://x/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'p' }) });
  const res = await onRequest({ request, env });
  assert.equal(res.status, 429);
  assert.ok(res.headers.get('Retry-After'));
});

test('login: allowed by limiter then validates credentials (200 on correct, 401 on wrong)', async () => {
  const { onRequest } = await import(LOGIN);
  const env = { BEY_STATE_DO: fakeDO(200, { allowed: true, remaining: 9 }), ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'p' };
  const good = await onRequest({ request: new Request('https://x/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'p' }) }), env });
  assert.equal(good.status, 200);
  const bad = await onRequest({ request: new Request('https://x/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'WRONG' }) }), env });
  assert.equal(bad.status, 401);
});
