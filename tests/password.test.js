const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const PW = 'file://' + path.join(__dirname, '..', 'functions', 'api', '_shared', 'password.js').replace(/\\/g, '/');
const PLOGIN = 'file://' + path.join(__dirname, '..', 'functions', 'api', 'player-login.js').replace(/\\/g, '/');
const ACCOUNTS = 'file://' + path.join(__dirname, '..', 'functions', 'api', 'accounts.js').replace(/\\/g, '/');

function makeKv(store) {
  return {
    get: async k => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = v; },
    delete: async k => { delete store[k]; },
    _store: store
  };
}

// ── unit ──────────────────────────────────────────────────────────────────────
test('hashPassword produces pbkdf2 format; verify round-trips; wrong fails', async () => {
  const { hashPassword, verifyPassword, isHashed, needsUpgrade } = await import(PW);
  const stored = await hashPassword('clienthash-abc');
  assert.ok(stored.startsWith('pbkdf2$'), 'format');
  assert.equal(isHashed(stored), true);
  assert.equal(needsUpgrade(stored), false);
  assert.equal(await verifyPassword(stored, 'clienthash-abc'), true);
  assert.equal(await verifyPassword(stored, 'wrong'), false);
});

test('legacy bare-hash verifies, and is flagged for upgrade', async () => {
  const { verifyPassword, needsUpgrade } = await import(PW);
  const legacy = 'a'.repeat(64); // looks like an old sha256 hex
  assert.equal(needsUpgrade(legacy), true);
  assert.equal(await verifyPassword(legacy, 'a'.repeat(64)), true);
  assert.equal(await verifyPassword(legacy, 'b'.repeat(64)), false);
});

// ── player-login: transparent upgrade on legacy login ──────────────────────────
test('player-login: legacy account logs in AND is upgraded to pbkdf2 in KV', async () => {
  const { onRequest } = await import(PLOGIN);
  const store = { accounts: JSON.stringify({ bob: { displayName: 'Bob', password: 'legacyhash', tokenVersion: 0 } }) };
  const env = { BEYBLADE_KV: makeKv(store) }; // no BEY_STATE_DO → rate limit fails open
  const req = new Request('https://x/api/player-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'bob', passwordHash: 'legacyhash' })
  });
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.sessionToken, 'session issued');
  const after = JSON.parse(store.accounts);
  assert.ok(after.bob.password.startsWith('pbkdf2$'), 'legacy password upgraded in KV');
  assert.equal(after.bob.tokenVersion, 0, 'tokenVersion NOT bumped on transparent upgrade');
});

test('player-login: pbkdf2 account logs in; wrong hash → 401', async () => {
  const { onRequest } = await import(PLOGIN);
  const { hashPassword } = await import(PW);
  const stored = await hashPassword('secrethash');
  const store = { accounts: JSON.stringify({ amy: { displayName: 'Amy', password: stored, tokenVersion: 0 } }) };
  const env = { BEYBLADE_KV: makeKv(store) };
  const ok = await onRequest({ request: new Request('https://x/api/player-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'amy', passwordHash: 'secrethash' }) }), env });
  assert.equal(ok.status, 200);
  const bad = await onRequest({ request: new Request('https://x/api/player-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'amy', passwordHash: 'nope' }) }), env });
  assert.equal(bad.status, 401);
});

// ── accounts change_password: verifies legacy current, stores pbkdf2 ───────────
test('change_password: verifies legacy current and stores pbkdf2 new', async () => {
  const { onRequest } = await import(ACCOUNTS);
  const { verifyPassword } = await import(PW);
  const store = {
    accounts: JSON.stringify({ cara: { displayName: 'Cara', password: 'oldlegacy', tokenVersion: 0 } }),
    'session:tokC': JSON.stringify({ username: 'cara', tokenVersion: 0 })
  };
  const env = { BEYBLADE_KV: makeKv(store) };
  const req = new Request('https://x/api/accounts?action=change_password', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selfUsername: 'cara', sessionToken: 'tokC', currentPasswordHash: 'oldlegacy', newPasswordHash: 'newhash' })
  });
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 200);
  const after = JSON.parse(store.accounts);
  assert.ok(after.cara.password.startsWith('pbkdf2$'), 'new password stored hashed');
  assert.equal(after.cara.tokenVersion, 1, 'tokenVersion bumped on password change');
  assert.equal(await verifyPassword(after.cara.password, 'newhash'), true);
});
