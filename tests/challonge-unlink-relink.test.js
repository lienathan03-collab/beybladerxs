// tests/challonge-unlink-relink.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function loadLink(currentEvent) {
  const saved = [];
  const ctx = {
    JSON, Array, Object, Promise, console,
    currentEvent,
    buildsState: { alice: ['Dragoon'] },
    matchesState: [{ id: 1, _challongeMatchId: 'c1', submitted: true, p1: { win: true } }],
    saveChallongeMetadata: async (patch, msg) => {
      saved.push({ patch, msg });
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete currentEvent[key];
        else currentEvent[key] = value;
      }
    },
    renderChallongeLinkedStatus() {},
    challongeConnect: async () => { ctx._connected = true; },
    renderResults() {}, renderRoundPublishBar() {},
    showToast() {},
    confirm: () => true,
  };
  vm.createContext(ctx);
  const s = html.indexOf('// === CHALLONGE-UNLINK-RELINK START ===');
  const e = html.indexOf('// === CHALLONGE-UNLINK-RELINK END ===', s);
  assert.notEqual(s, -1, 'Missing CHALLONGE-UNLINK-RELINK markers');
  vm.runInContext(html.slice(s, e), ctx);
  ctx._saved = saved;
  return ctx;
}

test('unlink removes only Challonge metadata, keeps builds/matches/scores', async () => {
  const ev = {
    id: 'e1', challongeTournamentId: 't1', challongeAccount: 'acct',
    challongeCustomKey: 'k', challongeParticipantMap: { 1: {} },
    challongeGroupMap: { g: 'A' }, challongeMissing: true,
    builds: { alice: ['Dragoon'] }, beyResults: [{ player: 'alice' }],
  };
  const ctx = loadLink(ev);
  await vm.runInContext('challongeUnlink()', ctx);
  assert.equal(ev.challongeTournamentId, undefined);
  assert.equal(ev.challongeAccount, undefined);
  assert.equal(ev.challongeCustomKey, undefined);
  assert.equal(ev.challongeParticipantMap, undefined);
  assert.equal(ev.challongeGroupMap, undefined);
  assert.equal(ev.challongeMissing, undefined);
  // tournament data untouched
  assert.deepEqual(ev.builds, { alice: ['Dragoon'] });
  assert.deepEqual(ev.beyResults, [{ player: 'alice' }]);
  assert.equal(ctx.matchesState.length, 1, 'imported match NOT deleted on unlink');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._saved[0].patch)), {
    challongeTournamentId: null,
    challongeAccount: null,
    challongeCustomKey: null,
    challongeParticipantMap: null,
    challongeGroupMap: null,
    challongeMissing: null,
  });
});

test('relink clears missing flag and reopens connection', async () => {
  const ev = { id: 'e1', challongeTournamentId: 't1', challongeMissing: true };
  const ctx = loadLink(ev);
  await vm.runInContext('challongeRelink()', ctx);
  assert.equal(ev.challongeMissing, false);
  assert.equal(ctx._connected, true, 'challongeConnect re-invoked');
});
