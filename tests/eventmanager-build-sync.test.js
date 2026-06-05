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

test('doLiveSync source fingerprints builds, not just beyResults', () => {
  const start = html.indexOf('async function doLiveSync()');
  const end = html.indexOf('function mergeIncomingMatches', start);
  const src = html.slice(start, end);
  // The hash must be derived from syncFingerprint over builds+results,
  // never from JSON.stringify(incoming) alone.
  assert.ok(/syncFingerprint\(\s*data\.builds/.test(src),
    'doLiveSync must fingerprint data.builds via syncFingerprint');
  assert.ok(!/const hash = JSON\.stringify\(incoming\)/.test(src),
    'doLiveSync must not fingerprint beyResults alone');
});

// ---- Task 3: mergeIncomingMatches build-only change detection ----

function loadMerge(matchesState, opts) {
  opts = opts || {};
  const ctx = {
    buildsState: opts.buildsState || {},
    currentEvent: { id: 'e1' },
    dirty: typeof opts.dirty === 'boolean' ? opts.dirty : true,
    matchesState: matchesState,
    resultsState: [],
    _matchIdCounter: 1,
    _activeLiveMatchSid: null,
    playerKey: function(p) { return p; },
    slotKey: function(s) { return s.entryId || s.player; },
    isDeSelfMatch: function() { return false; },
    flattenMatchesToResults: function() {},
    JSON: JSON, Set: Set, Array: Array, Object: Object, console: console,
  };
  ctx._soloSid = function(r, p1, p2, i) { return r + '|' + (p1.entryId||p1.player) + '|' + (p2.entryId||p2.player) + '|' + i; };
  ctx._teamSid = function(r, t1, t2, i) { return r + '|T|' + t1 + '|' + t2 + '|' + i; };
  vm.createContext(ctx);
  const start = html.indexOf('function mergeIncomingMatches');
  const end = html.indexOf('// SUBMIT MATCH', start);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

test('build-only server update returns changed=true with zero matches (non-dirty)', () => {
  const ctx = loadMerge([], { dirty: false, buildsState: {} });
  const changed = vm.runInContext('mergeIncomingMatches({ alice: ["Dragoon"] }, [])', ctx);
  assert.equal(changed, true, 'a new server build with zero matches must report changed');
  assert.equal(JSON.stringify(ctx.buildsState.alice), JSON.stringify(['Dragoon']));
});

test('identical builds and zero matches returns falsy', () => {
  const ctx = loadMerge([], { dirty: false, buildsState: { alice: ['Dragoon'] } });
  const changed = vm.runInContext('mergeIncomingMatches({ alice: ["Dragoon"] }, [])', ctx);
  assert.ok(!changed, 'no real change must not report changed');
});

test('dirty branch adds an absent server build key with zero matches', () => {
  const ctx = loadMerge([], { dirty: true, buildsState: {} });
  const changed = vm.runInContext('mergeIncomingMatches({ bob: ["Dranzer"] }, [])', ctx);
  assert.equal(changed, true);
  assert.equal(JSON.stringify(ctx.buildsState.bob), JSON.stringify(['Dranzer']));
});
