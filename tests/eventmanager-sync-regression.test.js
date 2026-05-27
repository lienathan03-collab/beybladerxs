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
