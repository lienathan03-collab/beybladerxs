// tests/challonge-import.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

test('resolveChallongeTarget: named account from CHALLONGE_ACCOUNTS', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_ACCOUNTS: JSON.stringify({
      lienathanS2: { proxyUrl: 'https://proxy.example/s2', key: 'KEY2' },
    }),
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
  };
  const t = resolveChallongeTarget(env, { account: 'lienathanS2' });
  assert.equal(t.proxyUrl, 'https://proxy.example/s2');
  assert.equal(t.key, 'KEY2');
});

test('resolveChallongeTarget: custom key overrides account', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = { CHALLONGE_PROXY_URL: 'https://proxy.example/default' };
  const t = resolveChallongeTarget(env, { customKey: 'ABC123' });
  assert.equal(t.key, 'ABC123');
  assert.equal(t.proxyUrl, 'https://proxy.example/default');
});

test('resolveChallongeTarget: unknown account returns null proxyUrl', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_ACCOUNTS: JSON.stringify({
      lienathanS2: { proxyUrl: 'https://proxy.example/s2', key: 'KEY2' },
    }),
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
  };
  const t = resolveChallongeTarget(env, { account: 'nonexistent' });
  assert.equal(t.proxyUrl, null);
});

test('resolveChallongeTarget: falls back to season URLs', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
    CHALLONGE_PROXY_URL_S3: 'https://proxy.example/s3',
  };
  assert.equal(resolveChallongeTarget(env, { season: '3' }).proxyUrl, 'https://proxy.example/s3');
  assert.equal(resolveChallongeTarget(env, { season: '2' }).proxyUrl, 'https://proxy.example/default');
});
