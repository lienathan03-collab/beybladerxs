// tests/eventmanager-build-sync.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function loadFingerprint() {
  const start = html.indexOf('// === SYNC-FINGERPRINT START ===');
  const end = html.indexOf('// === SYNC-FINGERPRINT END ===', start);
  assert.notEqual(start, -1, 'Missing SYNC-FINGERPRINT START marker');
  assert.notEqual(end, -1, 'Missing SYNC-FINGERPRINT END marker');
  const ctx = { JSON, Object, Array };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx.syncFingerprint;
}

test('syncFingerprint changes when builds change even if results are identical', () => {
  const syncFingerprint = loadFingerprint();
  const results = [];
  const a = syncFingerprint({ alice: ['x'] }, results);
  const b = syncFingerprint({ alice: ['x', 'y'] }, results);
  assert.notEqual(a, b, 'build change must alter the fingerprint');
});

test('syncFingerprint is stable across build-key ordering', () => {
  const syncFingerprint = loadFingerprint();
  const a = syncFingerprint({ alice: ['x'], bob: ['y'] }, []);
  const b = syncFingerprint({ bob: ['y'], alice: ['x'] }, []);
  assert.equal(a, b, 'key order must not change the fingerprint');
});

test('syncFingerprint changes when results change', () => {
  const syncFingerprint = loadFingerprint();
  const a = syncFingerprint({}, [{ player: 'a', round: 'R1' }]);
  const b = syncFingerprint({}, [{ player: 'b', round: 'R1' }]);
  assert.notEqual(a, b);
});
