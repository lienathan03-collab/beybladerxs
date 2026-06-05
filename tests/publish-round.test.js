// tests/publish-round.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function loadPublish(matchesState, fetchImpl, reportImpl) {
  const ctx = {
    matchesState, JSON, Array, Object, Promise, console,
    currentEvent: { id: 'e1', challongeTournamentId: 't1', challongeMissing: false },
    buildsState: {}, resultsState: [],
    adminUser: 'a', adminPass: 'p',
    dirty: true,
    _lastSyncHash: '',
    fetch: fetchImpl,
    showToast() {},
    renderResults() {}, renderRoundPublishBar() {},
    markDirty() {},
    flattenMatchesToResults() {},
    getMatchSidSnapshot: () => new Set(),
    buildMergePutBody: (eid, b, r) => ({ body: { eventId: eid }, deletedSnapshot: [] }),
    clearAckedDeletedSids() {},
    confirmPendingMatchesSaved() {},
    sidsFromServerPayload: () => new Set(),
    syncFingerprint: () => 'h',
    matchHasDecisiveWinner(m) { const a=!!(m.p1&&m.p1.win),b=!!(m.p2&&m.p2.win); return a!==b; },
    challongeReportMatch: reportImpl,
  };
  ctx.roundPublishStats = function (round) {
    const inRound = matchesState.filter(m => m.round === round && m._challongeMatchId);
    let decisive=0, ready=0, published=0, failed=0, pending=0;
    for (const m of inRound) {
      const d = ctx.matchHasDecisiveWinner(m);
      if (d) decisive++;
      if (m._challongePushState==='ok') published++;
      else if (m._challongePushState==='error') failed++;
      else if (m._challongePushState==='pending') pending++;
      else if (m.submitted && d) ready++;
    }
    const publishableTotal = inRound.length;
    const complete = publishableTotal>0 && decisive===publishableTotal;
    return { round, publishableTotal, decisive, ready, published, failed, pending, complete, canPublish: complete && ready>0 && pending===0 };
  };
  vm.createContext(ctx);
  const start = html.indexOf('// === ROUND-PUBLISH START ===');
  const end = html.indexOf('// === ROUND-PUBLISH END ===', start);
  assert.notEqual(start, -1, 'Missing ROUND-PUBLISH markers');
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

const okFetch = async () => ({ ok: true, json: async () => ({ success: true, beyResults: [] }) });
const m = (id, win, extra) => {
  extra = extra || {};
  return { id, _sid: 's'+id, round: 'R1', _challongeMatchId: 'c'+id,
    submitted: true, p1: win==='p1'?{win:true}:{}, p2: win==='p2'?{win:true}:{}, ...extra };
};

test('incomplete round refuses to publish', async () => {
  const calls = [];
  const ctx = loadPublish(
    [ m(1,'p1'), { id:2,_sid:'s2',round:'R1',_challongeMatchId:'c2',submitted:false,p1:{},p2:{} } ],
    okFetch,
    async (match) => { calls.push(match.id); });
  await vm.runInContext('publishRoundToChallonge("R1")', ctx);
  assert.deepEqual(calls, [], 'no match should be pushed for an incomplete round');
});

test('complete round publishes each match exactly once', async () => {
  const calls = [];
  const ctx = loadPublish(
    [ m(1,'p1'), m(2,'p2') ],
    okFetch,
    async (match) => { calls.push(match.id); match._challongePushState = 'ok'; });
  await vm.runInContext('publishRoundToChallonge("R1")', ctx);
  assert.deepEqual(calls.sort(), [1,2]);
});

test('already-ok matches are not re-pushed', async () => {
  const calls = [];
  const ctx = loadPublish(
    [ m(1,'p1',{ _challongePushState:'ok' }), m(2,'p2') ],
    okFetch,
    async (match) => { calls.push(match.id); match._challongePushState = 'ok'; });
  await vm.runInContext('publishRoundToChallonge("R1")', ctx);
  assert.deepEqual(calls, [2], 'only the unpublished match is pushed');
});

test('retryRoundFailures pushes only error matches', async () => {
  const calls = [];
  const ctx = loadPublish(
    [ m(1,'p1',{ _challongePushState:'ok' }), m(2,'p2',{ _challongePushState:'error' }) ],
    okFetch,
    async (match) => { calls.push(match.id); match._challongePushState = 'ok'; });
  await vm.runInContext('retryRoundFailures("R1")', ctx);
  assert.deepEqual(calls, [2]);
});

test('publish persists state to Cloudflare (one PUT)', async () => {
  let puts = 0;
  const fetchImpl = async (url, opts) => {
    if (opts && opts.method === 'PUT') puts++;
    return { ok: true, json: async () => ({ success: true, beyResults: [] }) };
  };
  const ctx = loadPublish([ m(1,'p1') ], fetchImpl,
    async (match) => { match._challongePushState = 'ok'; });
  await vm.runInContext('publishRoundToChallonge("R1")', ctx);
  assert.ok(puts >= 1, 'must persist publish state to Cloudflare at least once');
});
