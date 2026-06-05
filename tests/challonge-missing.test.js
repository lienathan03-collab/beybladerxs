// tests/challonge-missing.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function loadMissing(extra) {
  extra = extra || {};
  const ctx = {
    JSON, Array, Object, Promise, console,
    currentEvent: extra.currentEvent || { id: 'e1', challongeTournamentId: 't1', builds: { a: ['x'] }, beyResults: [{ player: 'a' }] },
    matchesState: extra.matchesState || [],
    buildsState: extra.buildsState || { a: ['x'] },
    rosterSaveJoiners: async () => {},
    renderChallongeLinkedStatus() {},
    renderResults() {}, renderRoundPublishBar() {},
    showToast() {},
  };
  vm.createContext(ctx);
  const s1 = html.indexOf('// === CHALLONGE-MISSING START ===');
  const e1 = html.indexOf('// === CHALLONGE-MISSING END ===', s1);
  assert.notEqual(s1, -1, 'Missing CHALLONGE-MISSING markers');
  vm.runInContext(html.slice(s1, e1), ctx);
  return ctx;
}

test('isChallongeMissingError detects 404', () => {
  const ctx = loadMissing();
  assert.equal(vm.runInContext('isChallongeMissingError(404, "")', ctx), true);
  assert.equal(vm.runInContext('isChallongeMissingError(403, "")', ctx), false);
});

test('isChallongeMissingError detects "not found" text on any status', () => {
  const ctx = loadMissing();
  assert.equal(vm.runInContext('isChallongeMissingError(422, "Tournament not found")', ctx), true);
});

test('handleChallongeMaybeMissing flips flag and preserves all local data', async () => {
  const ctx = loadMissing({
    matchesState: [{ id: 1, _challongeMatchId: 'c1', p1: { win: true }, submitted: true }],
    buildsState: { alice: ['Dragoon'] },
  });
  await vm.runInContext('handleChallongeMaybeMissing(404, "")', ctx);
  assert.equal(ctx.currentEvent.challongeMissing, true);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.buildsState)), { alice: ['Dragoon'] });
  assert.equal(ctx.matchesState.length, 1);
  assert.equal(ctx.matchesState[0]._challongeMatchId, 'c1', 'imported match not deleted');
  assert.equal(ctx.matchesState[0].submitted, true, 'submitted state preserved');
});

test('handleChallongeMaybeMissing on non-404 does nothing', async () => {
  const ctx = loadMissing();
  const flipped = await vm.runInContext('handleChallongeMaybeMissing(500, "server boom")', ctx);
  assert.equal(flipped, false);
  assert.ok(!ctx.currentEvent.challongeMissing);
});
