const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'eventmanager.html'),
  'utf8'
);

function extractBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  const end = html.indexOf(endNeedle, start);
  assert.notEqual(start, -1, `Missing source marker: ${startNeedle}`);
  assert.notEqual(end, -1, `Missing source marker: ${endNeedle}`);
  return html.slice(start, end);
}

test('live sync indicator starts hidden before an event is selected', () => {
  const match = html.match(/<span id="live-indicator" style="([^"]*)"/);
  assert.ok(match, 'live indicator markup must exist');

  const displayDeclarations = match[1]
    .split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith('display:'));

  assert.deepEqual(displayDeclarations, ['display:none']);
});

function loadQueueHelpers(context) {
  const start = html.indexOf('let _createMatchSaveQueue');
  const end = html.indexOf('function startLiveSync', start);
  assert.notEqual(start, -1, 'Missing ordered automatic match-save queue');
  assert.notEqual(end, -1, 'Missing end marker for automatic match-save helpers');
  vm.runInContext(html.slice(start, end), context);
}

function loadMergeHelper(context) {
  vm.runInContext(
    extractBetween('function mergeIncomingMatches', '// SUBMIT MATCH'),
    context
  );
}

function loadMatchesHelper(context) {
  const start = html.indexOf('function loadMatchesFromResults()');
  const end   = html.indexOf('function flattenMatchesToResults()', start);
  assert.notEqual(start, -1, 'Missing loadMatchesFromResults source marker');
  assert.notEqual(end,   -1, 'Missing flattenMatchesToResults end marker');
  vm.runInContext(html.slice(start, end), context);
}

function createContext(matchesState) {
  const context = {
    buildsState: {},
    currentEvent: { id: 'evt-test' },
    adminUser: 'admin',
    adminPass: 'secret',
    dirty: true,
    matchesState,
    resultsState: [],
    _matchIdCounter: 20,
    _lastSyncHash: '',
    _syncPaused: false,
    _activeLiveMatchSid: null,
    fetch: async () => ({ ok: true, json: async () => ({ success: true }) }),
    flattenMatchesToResults() {
      context.resultsState = context.matchesState.flatMap(m => [
        { ...m.p1, round: m.round, _matchSid: m._sid },
        { ...m.p2, round: m.round, _matchSid: m._sid }
      ]);
    },
    playerKey(player) { return player; },
    slotKey(player) { return player.entryId || player.player; },
    showToast() {},
    console,
    Promise,
    JSON,
    Set,
    Array,
    Object
  };
  context._soloSid = (round, p1, p2, idx) =>
    `${round}|${p1.entryId || p1.player}|${p2.entryId || p2.player}|${idx}`;
  context._teamSid = (round, t1, t2, idx) => `${round}|T|${t1}|${t2}|${idx}`;
  vm.createContext(context);
  return context;
}

function makePendingMatch(id, suffix) {
  return {
    id,
    _sid: `R1|A${suffix}|B${suffix}|0`,
    _pendingServerSave: true,
    round: 'R1',
    p1: { player: `A${suffix}`, builds: [] },
    p2: { player: `B${suffix}`, builds: [] },
    submitted: false
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Existing regression coverage (kept and updated for server-observed confirm).
// ─────────────────────────────────────────────────────────────────────────────

test('live sync preserves a newly-created match until the server confirms it', () => {
  const context = createContext([makePendingMatch(1, '1')]);
  loadMergeHelper(context);

  vm.runInContext('mergeIncomingMatches({}, [])', context);

  assert.equal(context.matchesState.length, 1);
  assert.equal(context.matchesState[0]._pendingServerSave, true);
});

test('live sync does NOT wipe a pending match even when dirty is false (non-dirty full-replace path)', () => {
  // Reproduces the multi-device data-loss report: a locally-created match that
  // the server has not echoed back yet must survive a full-replace live-sync,
  // not just the dirty-branch sync. dirty can be false here (e.g. a Finalize
  // cleared it while a concurrent write meant the server response didn't echo
  // this device's sid).
  const context = createContext([makePendingMatch(1, '1')]);
  context.dirty = false;
  loadMergeHelper(context);

  // Server returns no entries for this event — the pending match isn't there yet.
  vm.runInContext('mergeIncomingMatches({}, [])', context);

  assert.equal(context.matchesState.length, 1,
    'non-dirty full-replace must not delete an unconfirmed pending match');
  assert.equal(context.matchesState[0]._pendingServerSave, true,
    'the pending flag must remain set until the server confirms the sid');
});

test('automatic creation saves are serialized so the latest list is persisted last', async () => {
  const context = createContext([makePendingMatch(1, '1')]);
  const requestRowCounts = [];
  let releaseFirstRequest;

  context.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requestRowCounts.push(request.beyResults.length);
    if (requestRowCounts.length === 1) {
      await new Promise(resolve => { releaseFirstRequest = resolve; });
    }
    // Echo back the body as the merged state so observation-based confirm works.
    return { ok: true, json: async () => ({ success: true, beyResults: request.beyResults }) };
  };

  loadQueueHelpers(context);

  const firstSave = vm.runInContext('queueCreatedMatchSave()', context);
  await new Promise(resolve => setImmediate(resolve));
  context.matchesState.push(makePendingMatch(2, '2'));
  const secondSave = vm.runInContext('queueCreatedMatchSave()', context);

  releaseFirstRequest();
  await Promise.all([firstSave, secondSave]);

  assert.deepEqual(requestRowCounts, [2, 4]);
  assert.equal(context.matchesState.some(match => match._pendingServerSave), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 1 — _pendingServerSave must not be cleared just because the local
// PUT returned 200 OK. The match's sid has to be visible in the server's
// merged response (or in a later GET) before the protection can be lifted.
// ─────────────────────────────────────────────────────────────────────────────

test('Finding 1: stale PUT response (no beyResults) does NOT clear pending flag', async () => {
  const context = createContext([makePendingMatch(1, '1')]);
  context.fetch = async () => ({
    ok: true,
    // Server replied "success" but didn't echo the match — simulates a
    // concurrent writer's overwrite or a legacy server without merge mode.
    json: async () => ({ success: true })
  });

  loadQueueHelpers(context);
  await vm.runInContext('queueCreatedMatchSave()', context);

  assert.equal(context.matchesState[0]._pendingServerSave, true,
    'pending flag must remain set until a server response confirms the sid');
});

test('Finding 1: stale live-sync after a non-confirming PUT does NOT delete the match', async () => {
  const context = createContext([makePendingMatch(1, '1')]);
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, beyResults: [] }) // stale empty echo
  });

  loadQueueHelpers(context);
  await vm.runInContext('queueCreatedMatchSave()', context);

  // A subsequent stale live-sync poll (server returns no entries for this event)
  // must not nuke the local match — it's still pending acknowledgement.
  loadMergeHelper(context);
  vm.runInContext('mergeIncomingMatches({}, [])', context);

  assert.equal(context.matchesState.length, 1);
  assert.equal(context.matchesState[0]._pendingServerSave, true);
});

test('dirty live-sync does NOT remove a locally scored match before auto-submit saves it', () => {
  const localMatch = {
    id: 1,
    _sid: 'R1|A|B|0',
    round: 'R1',
    p1: { player: 'A', builds: [{ build: 'Alpha', finishes: ['S'] }], win: true },
    p2: { player: 'B', builds: [{ build: 'Beta', finishes: [] }], win: false },
    submitted: false
  };
  const context = createContext([localMatch]);
  context.dirty = true;
  loadMergeHelper(context);

  vm.runInContext('mergeIncomingMatches({}, [])', context);

  assert.equal(context.matchesState.length, 1,
    'a stale server poll must not make a local Done/autosubmit-pending match disappear');
  assert.equal(context.matchesState[0]._sid, 'R1|A|B|0');
  assert.equal(context.matchesState[0].p1.win, true,
    'the locally scored result must remain available for auto-submit/finalize');
});

test('Finding 1: confirming PUT response (sid echoed) clears the pending flag', async () => {
  const context = createContext([makePendingMatch(1, '1')]);
  context.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    // Server merged and is returning our sid back.
    return { ok: true, json: async () => ({ success: true, beyResults: request.beyResults }) };
  };

  loadQueueHelpers(context);
  await vm.runInContext('queueCreatedMatchSave()', context);

  assert.equal(context.matchesState[0]._pendingServerSave, undefined,
    'pending flag should clear once the sid appears in authoritative server data');
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 2 — switching events while queued saves are in flight must NOT
// silently drop the later event-A save. The captured payload has to land on
// the server regardless of the UI's current event.
// ─────────────────────────────────────────────────────────────────────────────

test('Finding 2: switching events during two queued saves still PUTs both to the original event', async () => {
  const context = createContext([makePendingMatch(1, '1')]);
  context.currentEvent = { id: 'evt-A' };

  const requests = [];
  let releaseFirst;
  context.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ eventId: request.eventId, rowCount: request.beyResults.length });
    if (requests.length === 1) {
      await new Promise(resolve => { releaseFirst = resolve; });
    }
    return { ok: true, json: async () => ({ success: true, beyResults: request.beyResults }) };
  };

  loadQueueHelpers(context);

  // 1. First queued save for event A (blocked).
  const firstSave = vm.runInContext('queueCreatedMatchSave()', context);
  await new Promise(resolve => setImmediate(resolve));

  // 2. Add a second match and queue a second save — also for event A.
  context.matchesState.push(makePendingMatch(2, '2'));
  const secondSave = vm.runInContext('queueCreatedMatchSave()', context);

  // 3. User switches to event B BEFORE the first PUT releases.
  context.currentEvent = { id: 'evt-B' };

  // 4. Release the first PUT.
  releaseFirst();
  await Promise.all([firstSave, secondSave]);

  // 5. Both PUTs must have gone to event A. The second save would have been
  //    silently dropped under the old "if (currentEvent.id !== eventId) return"
  //    guard inside the queued then-block.
  assert.equal(requests.length, 2, 'both queued saves must reach the network');
  assert.equal(requests[0].eventId, 'evt-A');
  assert.equal(requests[1].eventId, 'evt-A');
  assert.equal(requests[0].rowCount, 2);
  assert.equal(requests[1].rowCount, 4);
});

test('Finding 2: confirmation against the new event does NOT happen after switching', async () => {
  const context = createContext([makePendingMatch(1, '1')]);
  context.currentEvent = { id: 'evt-A' };

  let releaseFirst;
  context.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (!releaseFirst) {
      await new Promise(resolve => { releaseFirst = resolve; });
    }
    return { ok: true, json: async () => ({ success: true, beyResults: request.beyResults }) };
  };

  loadQueueHelpers(context);
  const save = vm.runInContext('queueCreatedMatchSave()', context);
  await new Promise(resolve => setImmediate(resolve));

  // Simulate event switch: a totally fresh matchesState for event B.
  context.currentEvent = { id: 'evt-B' };
  const eventBMatch = { id: 99, _sid: 'R1|B|C|0', _pendingServerSave: true, round: 'R1',
    p1: { player: 'B', builds: [] }, p2: { player: 'C', builds: [] }, submitted: false };
  context.matchesState = [eventBMatch];
  const initialHash = context._lastSyncHash;

  releaseFirst();
  await save;

  // The queued save SHOULD have PUT event-A's payload (verified in the test
  // above). But its confirmation step must NOT have touched event B's state.
  assert.equal(eventBMatch._pendingServerSave, true,
    'event-B match must remain pending — old event ack cannot reach into the new event');
  assert.equal(context._lastSyncHash, initialHash,
    'event-B sync hash must not be overwritten by an event-A ack');
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-side merge — the underlying conflict-safe write strategy. These tests
// exercise the merge logic directly so that "client B writes without seeing
// client A's match" cannot truncate the array.
// ─────────────────────────────────────────────────────────────────────────────

test('server merge: client B writing without seeing A\'s match preserves both', async () => {
  const mod = await import('../functions/api/beyresults.js');
  const existing = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] }
  ];
  const incoming = [
    { player: 'Bob',  round: 'R1', _matchSid: 'R1|Bob|Dave|0', builds: [] },
    { player: 'Dave', round: 'R1', _matchSid: 'R1|Bob|Dave|0', builds: [] }
  ];

  const merged = mod.mergeBeyResults(existing, incoming, []);
  const sids = new Set(merged.map(e => e._matchSid));
  assert.equal(sids.size, 2);
  assert.ok(sids.has('R1|Alice|Carol|0'), 'concurrent client A match preserved');
  assert.ok(sids.has('R1|Bob|Dave|0'),   'incoming client B match added');
  assert.equal(merged.length, 4);
});

test('server merge: legacy entries without _matchSid get sids computed positionally', async () => {
  const mod = await import('../functions/api/beyresults.js');
  // Pre-migration data: no _matchSid on existing.
  const existing = [
    { player: 'Alice', round: 'R1', builds: [] },
    { player: 'Carol', round: 'R1', builds: [] }
  ];
  const incoming = [
    { player: 'Bob',  round: 'R1', _matchSid: 'R1|Bob|Dave|0', builds: [] },
    { player: 'Dave', round: 'R1', _matchSid: 'R1|Bob|Dave|0', builds: [] }
  ];

  const merged = mod.mergeBeyResults(existing, incoming, []);
  // Both legacy and new entries survive; legacy is identified as its own match
  // ("R1|Alice|Carol|0") by positional pairing, so it doesn't collide with the
  // incoming sid and doesn't get duplicated.
  const sids = new Set(merged.map(e => e._matchSid));
  assert.ok(sids.has('R1|Alice|Carol|0'));
  assert.ok(sids.has('R1|Bob|Dave|0'));
  assert.equal(merged.length, 4);
});

test('server merge: deletedSids removes a match across writers', async () => {
  const mod = await import('../functions/api/beyresults.js');
  const existing = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Bob',   round: 'R1', _matchSid: 'R1|Bob|Dave|0',    builds: [] },
    { player: 'Dave',  round: 'R1', _matchSid: 'R1|Bob|Dave|0',    builds: [] }
  ];
  // Client B PUTs with NO entries but tombstones Alice|Carol.
  const merged = mod.mergeBeyResults(existing, [], ['R1|Alice|Carol|0']);
  // Check client-visible result (tombstones are stripped before sending to clients).
  const visible = mod.stripTombstonesForResponse(merged);
  const sids = new Set(visible.map(e => e._matchSid));
  assert.ok(!sids.has('R1|Alice|Carol|0'), 'deleted sid must not survive merge');
  assert.ok(sids.has('R1|Bob|Dave|0'),      'non-deleted matches preserved');
  assert.equal(visible.length, 2, 'only the surviving match entries are visible');
  // Internal storage retains the tombstone so a stale client can\'t resurrect it.
  assert.ok(merged.some(e => e._tombstone && e._matchSid === 'R1|Alice|Carol|0'),
    'tombstone must be retained in the stored array');
});

test('server merge: updates replace existing entries for the same sid', async () => {
  const mod = await import('../functions/api/beyresults.js');
  const existing = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', win: false, builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', win: false, builds: [] }
  ];
  const incoming = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', win: true,  builds: [{ build: 'X' }] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', win: false, builds: [] }
  ];
  const merged = mod.mergeBeyResults(existing, incoming, []);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].win, true, 'incoming update wins for matching sid');
  assert.deepEqual(merged[0].builds, [{ build: 'X' }]);
});

test('server merge: mergeBuilds preserves keys only on one side', async () => {
  const mod = await import('../functions/api/beyresults.js');
  const merged = mod.mergeBuilds(
    { Alice: ['BuildA'], Carol: ['BuildC'] },
    { Bob: ['BuildB'], Alice: ['BuildA-updated'] }
  );
  assert.deepEqual(merged, {
    Alice: ['BuildA-updated'], // incoming wins
    Carol: ['BuildC'],          // existing preserved (client B didn't know)
    Bob:   ['BuildB']           // new from incoming
  });
});

test('server merge: deletedSids in the same payload as incoming wins over re-adding', async () => {
  const mod = await import('../functions/api/beyresults.js');
  const existing = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] }
  ];
  // Pathological client that both sends the match and lists it as deleted —
  // deletion is authoritative so the user's intent to remove wins.
  const incoming = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] }
  ];
  const merged = mod.mergeBeyResults(existing, incoming, ['R1|Alice|Carol|0']);
  // Client should see an empty list (deletion wins over re-add).
  const visible = mod.stripTombstonesForResponse(merged);
  assert.equal(visible.length, 0, 'deleted match must not be visible even when re-sent');
  // Tombstone must be retained in storage.
  assert.ok(merged.some(e => e._tombstone && e._matchSid === 'R1|Alice|Carol|0'),
    'tombstone must be stored to block future stale resurrections');
});

// ─────────────────────────────────────────────────────────────────────────────
// Tombstone persistence — tombstones must be stored server-side so a stale
// client cannot resurrect a deleted match on a later write.
// ─────────────────────────────────────────────────────────────────────────────

test('server merge: tombstones persist in stored array but are stripped for client response', async () => {
  const mod = await import('../functions/api/beyresults.js');
  const existing = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] }
  ];
  // Delete the match — tombstone should be written to storage.
  const merged = mod.mergeBeyResults(existing, [], ['R1|Alice|Carol|0']);
  assert.ok(
    merged.some(e => e._tombstone && e._matchSid === 'R1|Alice|Carol|0'),
    'tombstone must be retained in the stored beyResults array'
  );
  // But the client should never see tombstone entries.
  const forResponse = mod.stripTombstonesForResponse(merged);
  assert.equal(forResponse.length, 0, 'tombstones must be stripped from client response');
});

test('server merge: stale writer cannot resurrect a deleted match across sequential merges', async () => {
  const mod = await import('../functions/api/beyresults.js');
  const existing = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] }
  ];
  // Step 1: client A deletes the match — tombstone stored on server.
  const afterDelete = mod.mergeBeyResults(existing, [], ['R1|Alice|Carol|0']);

  // Step 2: stale client B (never saw the deletion) PUTs with Alice|Carol
  // still in its beyResults. The server must reject the resurrection.
  const staleIncoming = [
    { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
    { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] }
  ];
  const afterStaleWrite = mod.mergeBeyResults(afterDelete, staleIncoming, []);
  const forResponse = mod.stripTombstonesForResponse(afterStaleWrite);
  assert.equal(forResponse.length, 0, 'tombstone must block stale client resurrection');
});

// ─────────────────────────────────────────────────────────────────────────────
// SID drift — loadMatchesFromResults must respect persisted _matchSid so that
// deleting the first of two identical A-vs-B matches does not cause the
// surviving second (sid '...|1') to reload as '...|0' on next render.
// ─────────────────────────────────────────────────────────────────────────────

test('client: loadMatchesFromResults uses persisted _matchSid instead of positional index', () => {
  const context = createContext([]);
  // Two identical A-vs-B matches existed; the first ('...|0') was deleted.
  // The server now returns only the surviving second match, tagged with '...|1'.
  context.resultsState = [
    { player: 'A', round: 'R1', builds: [], _matchSid: 'R1|A|B|1' },
    { player: 'B', round: 'R1', builds: [], _matchSid: 'R1|A|B|1' }
  ];
  loadMatchesHelper(context);
  vm.runInContext('loadMatchesFromResults()', context);

  assert.equal(context.matchesState.length, 1, 'exactly one match loaded');
  assert.equal(
    context.matchesState[0]._sid, 'R1|A|B|1',
    'must use persisted _matchSid (..)|1) not positionally recomputed (..)|0)'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-event deletion isolation — a pending deletion from event A must never
// appear in an event B PUT body. Matches in different events can share the
// same sid key (same players, round, instance index) and the unscoped Set
// would silently delete a live match in the new event.
// ─────────────────────────────────────────────────────────────────────────────

test('client: pending deletions from event A do not appear in event-B PUT body', () => {
  const context = createContext([]);
  context.currentEvent = { id: 'evt-A' };
  loadQueueHelpers(context);

  // Simulate a match deletion that happened while the user was on event A.
  vm.runInContext("getEventDeletedSids('evt-A').add('R1|X|Y|0')", context);

  // Build a PUT body for event B — the event-A deletion must NOT be included.
  const result = vm.runInContext("buildMergePutBody('evt-B', {}, [])", context);

  assert.ok(
    !result.body.deletedSids.includes('R1|X|Y|0'),
    'event-A deletion must not appear in event-B PUT body'
  );
  assert.deepEqual(
    result.body.deletedSids, [],
    'event-B deletedSids must be empty when no event-B deletions exist'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-submit on winner detection. When a local scoring action leaves a match
// with one decisive winner, a short cancelable countdown arms and then fires
// the existing submitMatch(). It must NOT arm without a winner, when the toggle
// is off, or for an already-submitted match — and re-evaluating after the
// winner is removed must cancel it.
// ─────────────────────────────────────────────────────────────────────────────

function loadAutoSubmit(context) {
  vm.runInContext(
    extractBetween('// ─── AUTO-SUBMIT ENGINE (start)', '// ─── AUTO-SUBMIT ENGINE (end)'),
    context
  );
}

function autoCtx(matchesState) {
  const intervals = [];
  const context = {
    matchesState,
    calcPoints(builds) {
      let pts = 0;
      for (const b of (builds || [])) {
        for (const f of (b.finishes || [])) {
          if (f !== 'L') pts += ({ S: 1, O: 2, E: 3, B: 2 })[f] || 0;
        }
      }
      return pts;
    },
    setInterval(fn) { const id = intervals.length + 1; intervals.push({ id, fn }); return id; },
    clearInterval() {},
    renderResults() { context._renders = (context._renders || 0) + 1; },
    submitMatch(mid) { (context._submitted = context._submitted || []).push(mid); },
    console, JSON, Set, Array, Object
  };
  context.__intervals = intervals;
  vm.createContext(context);
  return context;
}

function soloMatch(winA, winB) {
  return [{ id: 1, round: 'R1',
    p1: { player: 'A', win: winA, builds: [] },
    p2: { player: 'B', win: winB, builds: [] } }];
}

test('auto-submit: solo match with exactly one winner arms a 4s countdown', () => {
  const c = autoCtx(soloMatch(true, false));
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  const t = vm.runInContext('_autoSubmit.timers[1]', c);
  assert.ok(t, 'timer must be armed for a decided match');
  assert.equal(t.remaining, 4);
});

test('auto-submit: no winner (both pending) does NOT arm', () => {
  const c = autoCtx(soloMatch(false, false));
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.equal(vm.runInContext('_autoSubmit.timers[1]', c), undefined);
});

test('auto-submit: both sides marked win is NOT decisive, does not arm', () => {
  const c = autoCtx(soloMatch(true, true));
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.equal(vm.runInContext('_autoSubmit.timers[1]', c), undefined);
});

test('auto-submit: an already-submitted match never arms', () => {
  const ms = soloMatch(true, false);
  ms[0].submitted = true;
  const c = autoCtx(ms);
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.equal(vm.runInContext('_autoSubmit.timers[1]', c), undefined);
});

test('auto-submit: toggle off prevents arming and cancels running timers', () => {
  const c = autoCtx(soloMatch(true, false));
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.ok(vm.runInContext('_autoSubmit.timers[1]', c), 'armed while enabled');
  vm.runInContext('setAutoSubmitEnabled(false)', c);
  assert.equal(vm.runInContext('_autoSubmit.timers[1]', c), undefined, 'turning off cancels it');
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.equal(vm.runInContext('_autoSubmit.timers[1]', c), undefined, 'cannot re-arm while off');
});

test('auto-submit: re-evaluating after the winner is removed cancels the countdown', () => {
  const ms = soloMatch(true, false);
  const c = autoCtx(ms);
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.ok(vm.runInContext('_autoSubmit.timers[1]', c));
  ms[0].p1.win = false; // judge un-scored the deciding finish
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.equal(vm.runInContext('_autoSubmit.timers[1]', c), undefined);
});

test('auto-submit: countdown fires submitMatch once it reaches zero', () => {
  const c = autoCtx(soloMatch(true, false));
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  const tick = c.__intervals[0].fn;
  tick(); tick(); tick(); tick(); // 4 → 3 → 2 → 1 → fire
  assert.deepEqual(c._submitted, [1], 'submitMatch must fire exactly once');
  assert.equal(vm.runInContext('_autoSubmit.timers[1]', c), undefined, 'timer cleared after firing');
});

test('auto-submit: team topcut match arms when a team reaches 2 individual wins', () => {
  const ms = [{ id: 1, round: 'SF', isTeamMatch: true,
    team1: { members: [{ win: true, builds: [] }, { win: true, builds: [] }, { win: false, builds: [] }] },
    team2: { members: [{ win: false, builds: [] }, { win: false, builds: [] }, { win: false, builds: [] }] } }];
  const c = autoCtx(ms);
  loadAutoSubmit(c);
  vm.runInContext('evaluateAutoSubmit(1)', c);
  assert.ok(vm.runInContext('_autoSubmit.timers[1]', c), 'topcut team with 2 wins must arm');
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SCORING — match-level patch body (Task 1)
// ─────────────────────────────────────────────────────────────────────────────

function loadPatchHelpers(context) {
  vm.runInContext(
    extractBetween('// LIVE-PUSH PATCH HELPERS (start)', '// LIVE-PUSH PATCH HELPERS (end)'),
    context
  );
}

test('buildMatchPatchBody emits only the target match rows in merge mode', () => {
  const matchA = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', builds: [{ finishes: ['O'] }], win: false },
    p2: { player: 'b', builds: [], win: false } };
  const matchB = { id: 2, _sid: 'R1|c|d|0', round: 'R1',
    p1: { player: 'c', builds: [], win: false },
    p2: { player: 'd', builds: [], win: false } };
  const context = vm.createContext({
    matchesState: [matchA, matchB],
    buildsState: {},
    adminUser: 'admin', adminPass: 'secret',
    calcPoints: (builds) => (builds || []).reduce((n, b) =>
      n + (b.finishes || []).filter(f => f !== 'L').length, 0),
    autoCheckWin() {}, autoCheckTeamWin() {}
  });
  loadPatchHelpers(context);
  const { body } = context.buildMatchPatchBody('evt-1', matchA);

  assert.equal(body.eventId, 'evt-1');
  assert.equal(body.mergeMode, true);
  const sids = new Set(body.beyResults.map(r => r._matchSid));
  assert.deepEqual([...sids], ['R1|a|b|0']);
  assert.equal(body.beyResults.length, 2); // p1 + p2 of matchA only
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SCORING — idempotent offline outbox (Task 2)
// ─────────────────────────────────────────────────────────────────────────────

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}

function loadOutboxHelpers(context) {
  vm.runInContext(
    extractBetween('// LIVE OUTBOX (start)', '// LIVE OUTBOX (end)'),
    context
  );
}

test('outbox supersedes older op for the same matchSid and is idempotent by opId', () => {
  const context = vm.createContext({
    localStorage: makeLocalStorage(),
    currentEvent: { id: 'evt-1' },
    crypto: { randomUUID: (() => { let n = 0; return () => 'op-' + (++n); })() }
  });
  loadOutboxHelpers(context);

  context.enqueueOutboxOp('R1|a|b|0', { eventId: 'evt-1', beyResults: [{ _matchSid: 'R1|a|b|0', win: false }] });
  context.enqueueOutboxOp('R1|a|b|0', { eventId: 'evt-1', beyResults: [{ _matchSid: 'R1|a|b|0', win: true }] });
  context.enqueueOutboxOp('R1|c|d|0', { eventId: 'evt-1', beyResults: [{ _matchSid: 'R1|c|d|0', win: false }] });

  const ops = context.loadOutbox('evt-1');
  assert.equal(ops.length, 2, 'only latest op per sid is kept');
  const aOp = ops.find(o => o.matchSid === 'R1|a|b|0');
  assert.equal(aOp.payload.beyResults[0].win, true, 'newest payload wins');

  context.confirmOutboxAcked('evt-1', new Set(['R1|a|b|0']));
  assert.equal(context.loadOutbox('evt-1').length, 1);
});

test('getClientId is stable across calls', () => {
  const context = vm.createContext({
    localStorage: makeLocalStorage(),
    crypto: { randomUUID: (() => { let n = 0; return () => 'cid-' + (++n); })() }
  });
  loadOutboxHelpers(context);
  assert.equal(context.getClientId(), context.getClientId());
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SCORING — in-progress score adoption in merge (Task 3)
// ─────────────────────────────────────────────────────────────────────────────

test('merge adopts in-progress (non-submitted) server score for a non-active match', () => {
  const local = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', entryId: 'a', builds: [], win: false },
    p2: { player: 'b', entryId: 'b', builds: [], win: false },
    submitted: false };
  const context = createContext([local]);
  context._activeLiveMatchSid = null;       // not actively editing this match
  loadMergeHelper(context);

  const serverResults = [
    { player: 'a', entryId: 'a', round: 'R1', builds: [{ finishes: ['O'] }], win: false, _matchSid: 'R1|a|b|0' },
    { player: 'b', entryId: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' }
  ];
  context.mergeIncomingMatches({}, serverResults);

  const m = context.matchesState.find(x => x._sid === 'R1|a|b|0');
  assert.deepEqual(m.p1.builds, [{ finishes: ['O'] }], 'in-progress score adopted');
});

test('merge does NOT clobber the actively-edited match', () => {
  const local = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', entryId: 'a', builds: [{ finishes: ['O', 'O'] }], win: false },
    p2: { player: 'b', entryId: 'b', builds: [], win: false },
    submitted: false };
  const context = createContext([local]);
  context._activeLiveMatchSid = 'R1|a|b|0'; // judge is scoring this match right now
  loadMergeHelper(context);

  const serverResults = [
    { player: 'a', entryId: 'a', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' },
    { player: 'b', entryId: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' }
  ];
  context.mergeIncomingMatches({}, serverResults);

  const m = context.matchesState.find(x => x._sid === 'R1|a|b|0');
  assert.deepEqual(m.p1.builds, [{ finishes: ['O', 'O'] }], 'local edits preserved');
});
