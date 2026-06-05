// tests/round-publish-bar.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function loadBar(opts) {
  let captured = '';
  const el = { set innerHTML(v) { captured = v; }, get innerHTML() { return captured; }, style: {} };
  const ctx = {
    matchesState: opts.matchesState, JSON, Array, Object,
    currentEvent: opts.currentEvent,
    activeRoundFilter: opts.activeRoundFilter || 'ALL',
    document: { getElementById: (id) => id === 'round-publish-bar' ? el : null },
    escHtml: s => String(s),
    roundPublishStats: opts.roundPublishStats,
    _publishingRound: opts._publishingRound || null,
  };
  vm.createContext(ctx);
  const start = html.indexOf('// === ROUND-PUBLISH-BAR START ===');
  const end = html.indexOf('// === ROUND-PUBLISH-BAR END ===', start);
  assert.notEqual(start, -1, 'Missing ROUND-PUBLISH-BAR markers');
  vm.runInContext(html.slice(start, end) + '\nrenderRoundPublishBar();', ctx);
  return captured;
}

const statsFor = (map) => (round) => map[round];

test('linked complete round shows an enabled Publish button', () => {
  const out = loadBar({
    matchesState: [{ round: 'R1', _challongeMatchId: 'c1' }],
    currentEvent: { challongeTournamentId: 't1', challongeMissing: false },
    activeRoundFilter: 'R1',
    roundPublishStats: statsFor({ R1: { round:'R1', publishableTotal:8, decisive:8, ready:8, published:0, failed:0, pending:0, complete:true, canPublish:true } }),
  });
  assert.match(out, /Publish R1/);
  assert.ok(!/disabled/.test(out), 'enabled when canPublish');
  assert.match(out, /8\/8 ready/);
});

test('incomplete round disables the button and shows progress', () => {
  const out = loadBar({
    matchesState: [{ round: 'R1', _challongeMatchId: 'c1' }],
    currentEvent: { challongeTournamentId: 't1' },
    activeRoundFilter: 'R1',
    roundPublishStats: statsFor({ R1: { round:'R1', publishableTotal:16, decisive:15, ready:15, published:0, failed:0, pending:0, complete:false, canPublish:false } }),
  });
  assert.match(out, /15\/16 ready/);
  assert.match(out, /disabled/);
});

test('pending on another device disables with in-progress note', () => {
  const out = loadBar({
    matchesState: [{ round: 'R1', _challongeMatchId: 'c1' }],
    currentEvent: { challongeTournamentId: 't1' },
    activeRoundFilter: 'R1',
    roundPublishStats: statsFor({ R1: { round:'R1', publishableTotal:8, decisive:8, ready:0, published:0, failed:0, pending:8, complete:true, canPublish:false } }),
  });
  assert.match(out, /another device/i);
  assert.match(out, /disabled/);
});

test('failures show a Retry button', () => {
  const out = loadBar({
    matchesState: [{ round: 'R1', _challongeMatchId: 'c1' }],
    currentEvent: { challongeTournamentId: 't1' },
    activeRoundFilter: 'R1',
    roundPublishStats: statsFor({ R1: { round:'R1', publishableTotal:8, decisive:8, ready:0, published:6, failed:2, pending:0, complete:true, canPublish:false } }),
  });
  assert.match(out, /Retry R1 failures/);
});

test('unlinked event renders nothing', () => {
  const out = loadBar({
    matchesState: [{ round: 'R1', _challongeMatchId: 'c1' }],
    currentEvent: { challongeTournamentId: null },
    activeRoundFilter: 'R1',
    roundPublishStats: statsFor({}),
  });
  assert.equal(out.trim(), '');
});
