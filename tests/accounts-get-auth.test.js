const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const MOD = 'file://' + path.join(__dirname, '..', 'functions', 'api', 'accounts.js').replace(/\\/g, '/');
const accountsBlob = JSON.stringify({
  alice: { displayName: 'Alice', password: 'hash', tokenVersion: 0, aliases: ['Ally'] }
});
function makeKv(store) {
  return {
    get: async k => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = v; },
    delete: async k => { delete store[k]; }
  };
}
const ADMIN = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret' };

test('GET /api/accounts with no auth → 401 (no anonymous enumeration)', async () => {
  const { onRequest } = await import(MOD);
  const env = { BEYBLADE_KV: makeKv({ accounts: accountsBlob }), ...ADMIN };
  const res = await onRequest({ request: new Request('https://x/api/accounts', { method: 'GET' }), env });
  assert.equal(res.status, 401);
});

test('GET with admin headers → 200 and strips password/tokenVersion', async () => {
  const { onRequest } = await import(MOD);
  const env = { BEYBLADE_KV: makeKv({ accounts: accountsBlob }), ...ADMIN };
  const res = await onRequest({
    request: new Request('https://x/api/accounts', { method: 'GET', headers: { 'X-Admin-User': 'admin', 'X-Admin-Pass': 'secret' } }),
    env
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.alice.displayName, 'Alice');
  assert.equal('password' in body.alice, false);
  assert.equal('tokenVersion' in body.alice, false);
});

test('GET with a valid player session → 200', async () => {
  const { onRequest } = await import(MOD);
  const store = { accounts: accountsBlob, 'session:tok1': JSON.stringify({ username: 'alice', tokenVersion: 0 }) };
  const env = { BEYBLADE_KV: makeKv(store), ...ADMIN };
  const res = await onRequest({
    request: new Request('https://x/api/accounts', { method: 'GET', headers: { 'X-Player-User': 'alice', 'X-Player-Session': 'tok1' } }),
    env
  });
  assert.equal(res.status, 200);
});

test('GET with an invalid player session → 401', async () => {
  const { onRequest } = await import(MOD);
  const env = { BEYBLADE_KV: makeKv({ accounts: accountsBlob }), ...ADMIN };
  const res = await onRequest({
    request: new Request('https://x/api/accounts', { method: 'GET', headers: { 'X-Player-User': 'alice', 'X-Player-Session': 'bogus' } }),
    env
  });
  assert.equal(res.status, 401);
});
