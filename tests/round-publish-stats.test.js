// tests/round-publish-stats.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function loadStats(matchesState) {
  const ctx = { matchesState, JSON, Array, Object,
    calcPoints: () => 0,
    matchHasDecisiveWinner(m) {
      if (!m) return false;
      const p1 = !!(m.p1 && m.p1.win), p2 = !!(m.p2 && m.p2.win);
      return p1 !== p2;
    },
  };
  vm.createContext(ctx);
  const start = html.indexOf('// === ROUND-PUBLISH-STATS START ===');
  const end = html.indexOf('// === ROUND-PUBLISH-STATS END ===', start);
  assert.notEqual(start, -1, 'Missing ROUND-PUBLISH-STATS markers');
  vm.runInContext(html.slice(start, end), ctx);
  return ctx.roundPublishStats;
}

const cm = (id, sid) => ({ id, _sid: sid, round: 'R1', _challongeMatchId: 'c' + id });

test('counts decisive, ready, published, failed, pending', () => {
  const roundPublishStats = loadStats([
    { ...cm(1), submitted: true, p1: { win: true }, p2: {} },
    { ...cm(2), submitted: true, p1: { win: true }, p2: {}, _challongePushState: 'ok' },
    { ...cm(3), submitted: true, p1: { win: true }, p2: {}, _challongePushState: 'error' },
    { ...cm(4), submitted: true, p1: { win: true }, p2: {}, _challongePushState: 'pending' },
    { ...cm(5), submitted: false, p1: {}, p2: {} },
  ]);
  const s = roundPublishStats('R1');
  assert.equal(s.publishableTotal, 5);
  assert.equal(s.decisive, 4);
  assert.equal(s.ready, 1);
  assert.equal(s.published, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.complete, false);
  assert.equal(s.canPublish, false);
});

test('complete round with all ready can publish', () => {
  const roundPublishStats = loadStats([
    { ...cm(1), submitted: true, p1: { win: true }, p2: {} },
    { ...cm(2), submitted: true, p1: {}, p2: { win: true } },
  ]);
  const s = roundPublishStats('R1');
  assert.equal(s.complete, true);
  assert.equal(s.ready, 2);
  assert.equal(s.canPublish, true);
});

test('matches without a challonge id are excluded from publishableTotal', () => {
  const roundPublishStats = loadStats([
    { id: 9, _sid: 's9', round: 'R1', submitted: true, p1: { win: true }, p2: {} },
  ]);
  const s = roundPublishStats('R1');
  assert.equal(s.publishableTotal, 0);
  assert.equal(s.canPublish, false);
});
