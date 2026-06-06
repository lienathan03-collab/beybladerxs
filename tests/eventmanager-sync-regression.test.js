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
    localStorage: makeLocalStorage(),
    crypto: { randomUUID: (() => { let n = 0; return () => 'queue-op-' + (++n); })() },
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
    syncFingerprint(builds, results) { return JSON.stringify([builds, results]); },
    buildMatchPatchBody(eventId, match) {
      return {
        body: {
          adminUsername: context.adminUser,
          adminPassword: context.adminPass,
          eventId,
          builds: {},
          beyResults: [
            { ...match.p1, round: match.round, _matchSid: match._sid },
            { ...match.p2, round: match.round, _matchSid: match._sid }
          ],
          mergeMode: true
        }
      };
    },
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
  context.isDeSelfMatch = function(p1, p2) {
    if (!p1 || !p2) return false;
    const id1 = p1.entryId; const id2 = p2.entryId;
    if (!id1 || !id2 || id1 === id2) return false;
    const n1 = String(p1.player || '').toLowerCase();
    const n2 = String(p2.player || '').toLowerCase();
    return n1 !== '' && n1 === n2;
  };
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

test('failed automatic creation save stays in the outbox and reports deferred persistence', async () => {
  const match = makePendingMatch(1, '1');
  const context = createContext([match]);
  context.fetch = async () => ({
    ok: false,
    json: async () => ({ error: 'temporary failure' })
  });

  loadQueueHelpers(context);
  const saved = await vm.runInContext('queueCreatedMatchSave()', context);

  assert.equal(saved, false);
  const ops = context.loadOutbox('evt-test');
  assert.equal(ops.length, 1, 'failed creation must remain queued for retry');
  assert.equal(ops[0].matchSid, match._sid);
  assert.equal(match._pendingServerSave, true);
});

test('successful automatic creation save clears its retry outbox entry', async () => {
  const match = makePendingMatch(1, '1');
  const context = createContext([match]);
  const toasts = [];
  context.showToast = (message) => toasts.push(message);
  context.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ success: true, beyResults: request.beyResults })
    };
  };

  loadQueueHelpers(context);
  const saved = await vm.runInContext('queueCreatedMatchSave()', context);

  assert.equal(saved, true, toasts.join('\n'));
  assert.equal(context.loadOutbox('evt-test').length, 0);
  assert.equal(match._pendingServerSave, undefined);
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
  const saved = await vm.runInContext('queueCreatedMatchSave()', context);

  assert.equal(saved, false, 'an unconfirmed 200 response must stay queued for retry');
  assert.equal(context.loadOutbox('evt-test').length, 1);
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

test('auto-submit: scoring changes after Challonge success make the match reportable again', () => {
  const ms = soloMatch(true, false);
  ms[0]._challongeMatchId = 123;
  ms[0]._challongePushState = 'ok';
  const c = autoCtx(ms);
  loadAutoSubmit(c);

  vm.runInContext('evaluateAutoSubmit(1)', c);

  assert.equal(ms[0]._challongePushState, undefined);
});

test('auto-submit: scoring changes clear stale pending and error Challonge states', () => {
  for (const state of ['pending', 'error']) {
    const ms = soloMatch(true, false);
    ms[0]._challongeMatchId = 123;
    ms[0]._challongePushState = state;
    const c = autoCtx(ms);
    loadAutoSubmit(c);

    vm.runInContext('evaluateAutoSubmit(1)', c);

    assert.equal(ms[0]._challongePushState, undefined, `${state} must be invalidated`);
  }
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

test('merge does NOT clobber a just-finalized match whose live push is still un-acked (outbox op pending)', () => {
  // Repro of the live-scoring data-loss bug. The judge finishes a match and taps
  // Done; closeLiveMode() clears _activeLiveMatchSid, but the final per-match
  // live-push is still queued/in-flight (its outbox op has not been acked by the
  // server). A 3s sync poll — or submitMatch's own internal merge — then reads a
  // STALE server snapshot that lacks the just-entered finishes. Without a guard
  // the merge overwrites the fresh local 5-0 with the stale server 0-0, which the
  // judge sees as an erased score / "no winner", a missing 2nd fight, or the right
  // winner with the wrong points (when the stale snapshot was an earlier push).
  const local = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', entryId: 'a', builds: [{ finishes: ['O', 'O', 'S'] }], win: true },
    p2: { player: 'b', entryId: 'b', builds: [{ finishes: ['L', 'L', 'L'] }], win: false },
    submitted: false };
  const context = createContext([local]);
  context._activeLiveMatchSid = null;     // live mode already closed (Done tapped)
  context.localStorage = makeLocalStorage();
  context.crypto = { randomUUID: (() => { let n = 0; return () => 'op-' + (++n); })() };
  loadOutboxHelpers(context);
  loadMergeHelper(context);

  // The final live-push for this match is still pending (not yet acked).
  context.enqueueOutboxOp('R1|a|b|0', { eventId: 'evt-test', beyResults: [] });

  // Stale server snapshot: the finishes for this match haven't landed yet.
  const staleServer = [
    { player: 'a', entryId: 'a', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' },
    { player: 'b', entryId: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' }
  ];
  context.mergeIncomingMatches({}, staleServer);

  const m = context.matchesState.find(x => x._sid === 'R1|a|b|0');
  assert.deepEqual(m.p1.builds, [{ finishes: ['O', 'O', 'S'] }], 'pending local score preserved');
  assert.equal(m.p1.win, true, 'winner preserved while the live push is un-acked');
});

test('full-replace merge preserves a match whose live push is still un-acked', () => {
  const local = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', entryId: 'a', builds: [{ finishes: ['O', 'O', 'S'] }], win: true },
    p2: { player: 'b', entryId: 'b', builds: [{ finishes: ['L', 'L', 'L'] }], win: false },
    submitted: false };
  const context = createContext([local]);
  context.dirty = false;
  context.localStorage = makeLocalStorage();
  context.crypto = { randomUUID: (() => { let n = 0; return () => 'op-' + (++n); })() };
  loadOutboxHelpers(context);
  loadMergeHelper(context);

  context.enqueueOutboxOp('R1|a|b|0', { eventId: 'evt-test', beyResults: [] });
  context.mergeIncomingMatches({}, [
    { player: 'a', entryId: 'a', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' },
    { player: 'b', entryId: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' }
  ]);

  assert.equal(context.matchesState[0], local, 'full replace keeps the protected local match object');
  assert.deepEqual(context.matchesState[0].p1.builds, [{ finishes: ['O', 'O', 'S'] }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SCORING — debounced per-match live push (Task 4)
// ─────────────────────────────────────────────────────────────────────────────

function loadLivePush(context) {
  vm.runInContext(
    extractBetween('// LIVE PUSH ENGINE (start)', '// LIVE PUSH ENGINE (end)'),
    context
  );
}

function loadCloseLiveMode(context) {
  vm.runInContext(
    extractBetween('function closeLiveMode()', 'function lmBackdropClick'),
    context
  );
}

test('scheduleLivePush coalesces rapid calls into one push after the debounce', async () => {
  let puts = 0;
  const match = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', builds: [{ finishes: ['O'] }], win: false },
    p2: { player: 'b', builds: [], win: false } };
  const context = vm.createContext({
    setTimeout, clearTimeout,
    matchesState: [match],
    buildsState: {},
    currentEvent: { id: 'evt-1' },
    adminUser: 'admin', adminPass: 'secret',
    _concurrencyMode: 'durable-object',
    navigator: { onLine: true },
    calcPoints: () => 1, autoCheckWin() {}, autoCheckTeamWin() {},
    enqueueOutboxOp: () => ({ opId: 'op-1' }),
    dropOutboxOp() {}, confirmOutboxAcked() {},
    sidsFromServerPayload: () => new Set(['R1|a|b|0']),
    LIVE_PUSH_DEBOUNCE_MS: 20,
    Promise,
    fetch: async () => { puts++; return { ok: true, headers: { get: () => 'durable-object' }, json: async () => ({ beyResults: [{ _matchSid: 'R1|a|b|0' }] }) }; }
  });
  loadPatchHelpers(context);
  loadLivePush(context);

  context.scheduleLivePush(1);
  context.scheduleLivePush(1);
  context.scheduleLivePush(1);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(puts, 1, 'three rapid taps -> one PUT');
});

test('scheduleLivePush enqueues the un-acked-write marker synchronously, before the debounce fires', () => {
  // Closes the post-Done gap: the outbox op (the marker the merge uses to refuse
  // stale-server overwrites) must exist the instant a push is scheduled — not only
  // 800ms later when pushMatchLive runs. Otherwise a sync poll landing in the
  // debounce window can clobber the just-scored 5-0 with an earlier 4-0 push.
  const match = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', builds: [{ finishes: ['O', 'O', 'S'] }], win: true },
    p2: { player: 'b', builds: [{ finishes: ['L', 'L', 'L'] }], win: false } };
  const context = vm.createContext({
    setTimeout, clearTimeout,
    localStorage: makeLocalStorage(),
    matchesState: [match],
    buildsState: {},
    currentEvent: { id: 'evt-1' },
    adminUser: 'admin', adminPass: 'secret',
    _concurrencyMode: 'durable-object',
    navigator: { onLine: true },
    crypto: { randomUUID: (() => { let n = 0; return () => 'op-' + (++n); })() },
    calcPoints: (builds) => (builds || []).reduce((n, b) =>
      n + (b.finishes || []).filter(f => f !== 'L').length, 0),
    autoCheckWin() {}, autoCheckTeamWin() {},
    LIVE_PUSH_DEBOUNCE_MS: 5, // short, so the debounced PUT resolves instead of dangling
    Promise,
    fetch: async () => ({ ok: true, headers: { get: () => 'durable-object' }, json: async () => ({ beyResults: [] }) })
  });
  loadPatchHelpers(context);
  loadOutboxHelpers(context);
  loadLivePush(context);

  context.scheduleLivePush(1);

  // No await — assert the marker exists synchronously, before any timer fires.
  const ops = context.loadOutbox('evt-1');
  assert.equal(ops.length, 1, 'outbox op enqueued immediately on schedule');
  assert.equal(ops[0].matchSid, 'R1|a|b|0', 'marker tracks the scored match');
});

test('an older live-push ack does not clear a newer outbox write for the same match', async () => {
  let releaseFirstPush;
  let firstRequest;
  const match = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', builds: [{ finishes: ['O'] }], win: false },
    p2: { player: 'b', builds: [], win: false } };
  const context = vm.createContext({
    setTimeout, clearTimeout,
    localStorage: makeLocalStorage(),
    matchesState: [match],
    buildsState: {},
    currentEvent: { id: 'evt-1' },
    adminUser: 'admin', adminPass: 'secret',
    _concurrencyMode: 'durable-object',
    navigator: { onLine: true },
    crypto: { randomUUID: (() => { let n = 0; return () => 'op-' + (++n); })() },
    calcPoints: (builds) => (builds || []).reduce((n, b) =>
      n + (b.finishes || []).filter(f => f !== 'L').length, 0),
    autoCheckWin() {}, autoCheckTeamWin() {},
    sidsFromServerPayload: (rows) => new Set((rows || []).map(r => r._matchSid)),
    Promise,
    fetch: async (_url, init) => {
      firstRequest = JSON.parse(init.body);
      await new Promise(resolve => { releaseFirstPush = resolve; });
      return { ok: true, headers: { get: () => 'durable-object' },
        json: async () => ({ beyResults: firstRequest.beyResults }) };
    }
  });
  loadPatchHelpers(context);
  loadOutboxHelpers(context);
  loadLivePush(context);

  const firstPush = context.pushMatchLive(match);
  await new Promise(resolve => setImmediate(resolve));

  match.p1.builds[0].finishes.push('S');
  const { body: newerBody } = context.buildMatchPatchBody('evt-1', match);
  const newerOp = context.enqueueOutboxOp(match._sid, newerBody);

  releaseFirstPush();
  await firstPush;

  const ops = context.loadOutbox('evt-1');
  assert.equal(ops.length, 1, 'the newer un-acked write must remain protected');
  assert.equal(ops[0].opId, newerOp.opId, 'only the exact acknowledged op may be removed');
  assert.equal(JSON.stringify(ops[0].payload.beyResults[0].builds[0].finishes), '["O","S"]');
});

test('closeLiveMode schedules a live push for partially-scored state', () => {
  const scheduled = [];
  const target = { id: 17, _sid: 'R1|a|b|0' };
  const element = { style: {}, classList: { remove() {} } };
  const context = vm.createContext({
    lmState: { match: target },
    _activeLiveMatchSid: target._sid,
    _editingBeyToken: null,
    _syncPaused: false,
    lmSyncSoloProxyToReal: () => target,
    flattenMatchesToResults() {},
    markDirty() {},
    scheduleLivePush: (mid) => scheduled.push(mid),
    renderResults() {},
    document: {
      body: { style: {} },
      getElementById: () => element
    },
    lmRemoveLandscape() {}
  });
  loadCloseLiveMode(context);

  context.closeLiveMode();

  assert.deepEqual(scheduled, [17]);
  assert.equal(context.lmState, null);
  assert.equal(context._activeLiveMatchSid, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SCORING — reconnect flush (Task 5)
// ─────────────────────────────────────────────────────────────────────────────

test('flushOutbox pushes every queued op and clears acked ones', async () => {
  const sent = [];
  const ls = makeLocalStorage();
  const context = vm.createContext({
    setTimeout, clearTimeout,
    localStorage: ls,
    currentEvent: { id: 'evt-1' },
    adminUser: 'admin', adminPass: 'secret',
    _concurrencyMode: 'durable-object',
    navigator: { onLine: true },
    Promise,
    crypto: { randomUUID: (() => { let n = 0; return () => 'op-' + (++n); })() },
    sidsFromServerPayload: (rows) => new Set((rows || []).map(r => r._matchSid)),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.beyResults[0]._matchSid);
      return { ok: true, headers: { get: () => 'durable-object' },
        json: async () => ({ beyResults: body.beyResults }) };
    }
  });
  loadOutboxHelpers(context);
  loadLivePush(context);

  context.enqueueOutboxOp('R1|a|b|0', { eventId: 'evt-1', beyResults: [{ _matchSid: 'R1|a|b|0' }] });
  context.enqueueOutboxOp('R1|c|d|0', { eventId: 'evt-1', beyResults: [{ _matchSid: 'R1|c|d|0' }] });

  await context.flushOutbox();
  assert.deepEqual(sent.sort(), ['R1|a|b|0', 'R1|c|d|0']);
  assert.equal(context.loadOutbox('evt-1').length, 0, 'acked ops cleared');
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SCORING — concurrency-mode detection + gating (Task 6)
// ─────────────────────────────────────────────────────────────────────────────

function loadConcurrencyHelpers(context) {
  vm.runInContext(
    extractBetween('// CONCURRENCY GATE (start)', '// CONCURRENCY GATE (end)'),
    context
  );
}

test('best-effort-kv header disables live push; durable-object enables it', () => {
  const warnings = [];
  const context = vm.createContext({
    document: { getElementById: () => null },
    showToast: (msg) => warnings.push(msg)
  });
  loadConcurrencyHelpers(context);

  context.applyConcurrencyHeader({ headers: { get: () => 'best-effort-kv' } });
  assert.equal(vm.runInContext('_concurrencyMode', context), 'best-effort-kv');
  assert.equal(context.liveScoringAllowed(), false);

  context.applyConcurrencyHeader({ headers: { get: () => 'durable-object' } });
  assert.equal(vm.runInContext('_concurrencyMode', context), 'durable-object');
  assert.equal(context.liveScoringAllowed(), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SCORING — Finalize becomes archive/stats only (Task 7)
// ─────────────────────────────────────────────────────────────────────────────

test('Finalize (saveAll) flushes the outbox and does not full-event PUT', () => {
  const start = html.indexOf('async function saveAll()');
  const end = html.indexOf('async function', start + 10);
  const src = html.slice(start, end);
  assert.ok(/flushOutbox\(\)/.test(src), 'saveAll must flush the outbox');
  assert.ok(!/buildMergePutBody\(/.test(src), 'saveAll must not build a full-event PUT body');
  assert.ok(/archiveBeyResultsToGamedata\(\)/.test(src), 'saveAll still archives');
  assert.ok(/syncBladerStats\(\)/.test(src), 'saveAll still syncs stats');
});

// Score-affecting paths must feed the same live-push hook. The hook lives at
// the start of evaluateAutoSubmit(), so calling it schedules the match-level
// live patch even when no winner has been reached yet.
function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `Missing function ${name}`);
  assert.notEqual(end, -1, `Missing next function ${nextName}`);
  return html.slice(start, end);
}

test('manual win toggles schedule live push through evaluateAutoSubmit', () => {
  assert.match(
    functionSource('mToggleWin', 'mToggleDeploy'),
    /evaluateAutoSubmit\(mid\)/,
    'solo manual win toggle must live-push the changed match'
  );
  assert.match(
    functionSource('mToggleTeamWin', 'mToggleTeamDeploy'),
    /evaluateAutoSubmit\(mid\)/,
    'team manual win toggle must live-push the changed match'
  );
});

test('live-mode finish and undo schedule in-progress live push before Done', () => {
  assert.match(
    functionSource('lmApplyFinish', 'lmUpdateScoreBar'),
    /lmScheduleLivePushForState\(\)/,
    'each live-mode finish tap must push in-progress scoring'
  );
  assert.match(
    functionSource('lmUndo', 'lmSetScoringSideAndHighlight'),
    /lmScheduleLivePushForState\(\)/,
    'live-mode undo must push the reverted in-progress score'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// DE SELF-MATCH — flatten, reload, stats exclusion
// ─────────────────────────────────────────────────────────────────────────────

// Load _soloSid/_teamSid, loadMatchesFromResults, flattenMatchesToResults,
// flattenSingleMatch, buildMatchPatchBody, autoCheckTeamWin, soloThreshold,
// autoCheckWin, autoCheckDeWin (new).
//
// Starts from _soloSid (NOT from calcPoints) so the 'let matchesState = []'
// declaration between them is never loaded — the context property takes effect.
// calcPoints is provided as a context stub; FINISH_PTS is supplied inline.
function loadFlattenHelpers(context) {
  const start = html.indexOf('function _soloSid(round, p1, p2, instanceIdx)');
  const end   = html.indexOf('// === CHALLONGE-HELPERS START ===');
  assert.notEqual(start, -1, 'Missing _soloSid source');
  assert.notEqual(end,   -1, 'Missing CHALLONGE-HELPERS START marker');
  vm.runInContext(html.slice(start, end), context);
}

// Load _normalizePlayerName, _resolveBladerKey, archiveBeyResultsToGamedata, syncBladerStats.
function loadStatsHelpers(context) {
  const start = html.indexOf('function _normalizePlayerName(raw)');
  const end   = html.indexOf('let _toastTimer;');
  assert.notEqual(start, -1, 'Missing _normalizePlayerName source');
  assert.notEqual(end,   -1, 'Missing _toastTimer end marker');
  vm.runInContext(html.slice(start, end), context);
}

function deMatchContext() {
  const ctx = vm.createContext({
    matchesState: [],
    resultsState: [],
    _matchIdCounter: 1,
    // calcPoints stub — FINISH_PTS lives earlier in the file, avoid loading the let declarations
    calcPoints: (builds) => (builds || []).reduce((n, b) =>
      n + (b.finishes || []).reduce((s, f) => s + ({S:1,O:2,E:3,B:2}[f]||0), 0), 0),
    buildsState: {},
    adminUser: 'admin', adminPass: 'secret',
    currentEvent: { id: 'evt-1' },
    console, JSON, Math, Object, Set, Array, String, Promise
  });
  return ctx;
}

test('flattenMatchesToResults: _deSelfMatch rows carry _noStats:true and no auto-win by points', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);

  // A DE match where p1 has been awarded the win (dePoints = 4 = threshold for R1)
  // and p2 has 2 dePoints. No Beyblade finishes on either side.
  ctx.matchesState = [{
    id: 1, _sid: 'R1|eL1|eL2|0', round: 'R1', _deSelfMatch: true,
    p1: { player: 'Lienathan', entryId: 'eL1', displayLabel: 'Lienathan 1', builds: [], dePoints: 4 },
    p2: { player: 'Lienathan', entryId: 'eL2', displayLabel: 'Lienathan 2', builds: [], dePoints: 2 },
    submitted: true
  }];

  vm.runInContext('flattenMatchesToResults()', ctx);

  assert.equal(ctx.resultsState.length, 2, 'two rows emitted');
  assert.equal(ctx.resultsState[0]._noStats, true,  'p1 row must carry _noStats');
  assert.equal(ctx.resultsState[1]._noStats, true,  'p2 row must carry _noStats');
  assert.equal(ctx.resultsState[0].dePoints, 4, 'p1 dePoints must be persisted');
  assert.equal(ctx.resultsState[1].dePoints, 2, 'p2 dePoints must be persisted');

  // Win must be derived from dePoints (4 >= threshold 4), not from finishes
  assert.equal(ctx.resultsState[0].win, true,  'p1 wins (dePoints hit threshold)');
  assert.equal(ctx.resultsState[1].win, false, 'p2 loses');

  const patchRows = vm.runInContext('flattenSingleMatch(matchesState[0])', ctx);
  assert.equal(patchRows[0].dePoints, 4, 'match-level live push must persist p1 dePoints');
  assert.equal(patchRows[1].dePoints, 2, 'match-level live push must persist p2 dePoints');
});

test('flattenMatchesToResults: normal match (no _deSelfMatch) rows do NOT carry _noStats', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);

  ctx.matchesState = [{
    id: 2, _sid: 'R1|eA|eB|0', round: 'R1',
    p1: { player: 'Ken', entryId: 'eA', builds: [], win: true  },
    p2: { player: 'Mia', entryId: 'eB', builds: [], win: false },
    submitted: false
  }];

  vm.runInContext('flattenMatchesToResults()', ctx);

  assert.equal(ctx.resultsState[0]._noStats, undefined, 'normal match must not carry _noStats');
  assert.equal(ctx.resultsState[1]._noStats, undefined);
});

test('loadMatchesFromResults: _noStats rows rebuild match with _deSelfMatch:true', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);

  ctx.resultsState = [
    { player: 'Lienathan', entryId: 'eL1', entryType: 'main',   displayLabel: 'Lienathan 1',
      round: 'R1', builds: [], win: true,  dePoints: 4, _noStats: true, _submitted: true, _matchSid: 'R1|eL1|eL2|0' },
    { player: 'Lienathan', entryId: 'eL2', entryType: 'double', displayLabel: 'Lienathan 2',
      round: 'R1', builds: [], win: false, dePoints: 1, _noStats: true, _submitted: true, _matchSid: 'R1|eL1|eL2|0' },
  ];

  vm.runInContext('loadMatchesFromResults()', ctx);

  assert.equal(ctx.matchesState.length, 1, 'one match loaded');
  assert.equal(ctx.matchesState[0]._deSelfMatch, true, '_deSelfMatch must be rehydrated from _noStats rows');
  assert.equal(ctx.matchesState[0]._sid, 'R1|eL1|eL2|0');
  assert.equal(ctx.matchesState[0].p1.dePoints, 4, 'p1 dePoints must rehydrate');
  assert.equal(ctx.matchesState[0].p2.dePoints, 1, 'p2 dePoints must rehydrate');

  vm.runInContext('flattenMatchesToResults()', ctx);
  assert.equal(ctx.resultsState[0].win, true, 'reload then flatten must preserve the DE winner');
  assert.equal(ctx.resultsState[1].win, false, 'reload then flatten must preserve the DE loser');
});

test('syncBladerStats: _noStats entries do not affect wins, losses, or matchesPlayed', async () => {
  const putBodies = [];
  const ctx = vm.createContext({
    currentEvent: { id: 'evt-1', season: 's3' },
    resultsState: [
      // DE self-match rows — must be ignored by stats
      { player: 'Lienathan', round: 'R1', builds: [], win: true,  _submitted: true, _noStats: true },
      { player: 'Lienathan', round: 'R1', builds: [], win: false, _submitted: true, _noStats: true },
      // Normal match rows — must be counted
      { player: 'Ken', round: 'R1', builds: [], win: true,  _submitted: true },
      { player: 'Mia', round: 'R1', builds: [], win: false, _submitted: true },
    ],
    buildsState: {},
    adminUser: 'admin', adminPass: 'secret',
    fetch: async (url, opts) => {
      if (opts && opts.method === 'PUT') {
        putBodies.push(JSON.parse(opts.body).payload);
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ bladerStats: {}, eventSnapshots: {} }) };
    },
    console, JSON, Math, Object, Set, Array, String, Promise
  });
  loadStatsHelpers(ctx);

  await vm.runInContext('syncBladerStats()', ctx);

  assert.equal(putBodies.length, 1, 'one PUT must have been made');
  const bs = putBodies[0].bladerStats;

  // Lienathan's DE match must not pollute stats
  assert.ok(!bs['Lienathan'] || (
    !(bs['Lienathan'].wins || 0) && !(bs['Lienathan'].losses || 0) && !(bs['Lienathan'].matchesPlayed || 0)
  ), 'Lienathan _noStats entries must not be counted');

  // Normal players must be counted correctly
  assert.equal((bs['Ken'] || {}).wins,         1, 'Ken must have 1 win');
  assert.equal((bs['Mia'] || {}).losses,       1, 'Mia must have 1 loss');
  assert.equal((bs['Ken'] || {}).matchesPlayed, 1);
  assert.equal((bs['Mia'] || {}).matchesPlayed, 1);
});

test('archiveBeyResultsToGamedata: _noStats entries are excluded from the archive', async () => {
  const putBodies = [];
  const ctx = vm.createContext({
    currentEvent: { id: 'evt-1', season: 's3', title: 'Test Event', date: '2026-01-01' },
    resultsState: [
      { player: 'Lienathan', round: 'R1', builds: [], win: true,  _submitted: true, _noStats: true },
      { player: 'Lienathan', round: 'R1', builds: [], win: false, _submitted: true, _noStats: true },
      { player: 'Ken', round: 'R1', builds: [], win: true,  _submitted: true },
      { player: 'Mia', round: 'R1', builds: [], win: false, _submitted: true },
    ],
    buildsState: {},
    adminUser: 'admin', adminPass: 'secret',
    fetch: async (url, opts) => {
      if (opts && opts.method === 'PUT') {
        putBodies.push(JSON.parse(opts.body).payload);
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ archivedBeyResults: [], bladerStats: {} }) };
    },
    console, JSON, Math, Object, Set, Array, String, Promise
  });
  loadStatsHelpers(ctx);

  await vm.runInContext('archiveBeyResultsToGamedata()', ctx);

  assert.equal(putBodies.length, 1);
  const archived = putBodies[0].archivedBeyResults[0].beyResults;
  assert.ok(archived.every(r => !r._noStats), '_noStats rows must not appear in archive');
  assert.ok(archived.some(r => r.player === 'Ken'), 'normal rows must be archived');
  assert.ok(!archived.some(r => r.player === 'Lienathan'), 'DE rows must not be archived');
});

test('challongeReportMatch uses dePoints for _deSelfMatch score (source check)', () => {
  const start = html.indexOf('async function challongeReportMatch(');
  assert.notEqual(start, -1, 'challongeReportMatch must exist');
  const end = html.indexOf('\nasync function ', start + 1);
  const src = html.slice(start, end);
  assert.ok(src.includes('_deSelfMatch'), 'challongeReportMatch must branch on _deSelfMatch');
  assert.ok(src.includes('dePoints'),     'challongeReportMatch must use dePoints for DE matches');
});

test('importPreview allows DE self-match JSON but still excludes true same-entry duplicates', () => {
  const elements = {
    'import-json-text': {
      value: JSON.stringify([
        {
          _sid: 'R1|eL1|eL2|0', round: 'R1',
          p1: { player: 'Lienathan', entryId: 'eL1', displayLabel: 'Lienathan 1' },
          p2: { player: 'Lienathan', entryId: 'eL2', displayLabel: 'Lienathan 2' },
        },
        {
          _sid: 'R1|eBad|eBad|0', round: 'R1',
          p1: { player: 'Bad Same', entryId: 'eBad' },
          p2: { player: 'Bad Same', entryId: 'eBad' },
        },
      ])
    },
    'import-error': { textContent: '' },
    'import-preview': { textContent: '', innerHTML: '' },
  };
  const ctx = vm.createContext({
    matchesState: [],
    VALID_ROUNDS: new Set(['R1','R2','R3','R4','R5','R6','R7','TC','QF','SF','F']),
    document: { getElementById: id => elements[id] },
    escHtml: value => String(value ?? ''),
    console, JSON, Set, Array, String
  });

  vm.runInContext(extractBetween('// === CHALLONGE-HELPERS START ===', '// === CHALLONGE-HELPERS END ==='), ctx);
  const start = html.indexOf('let _importParsed = null');
  const end = html.indexOf('async function importCommit', start);
  assert.notEqual(start, -1, 'Missing import state marker');
  assert.notEqual(end, -1, 'Missing importCommit marker');
  vm.runInContext(html.slice(start, end), ctx);

  vm.runInContext('importPreview()', ctx);
  const parsed = vm.runInContext('_importParsed', ctx);
  assert.equal(parsed.newMatches.length, 1);
  assert.equal(parsed.newMatches[0]._deSelfMatch, true, 'DE JSON import must stamp _deSelfMatch');
  assert.equal(parsed.newMatches[0].p1.entryId, 'eL1');
  assert.match(elements['import-preview'].innerHTML, /1 invalid same-owner match/);
});

test('flattenMatchesToResults: _challongeMatchId persisted on both solo rows', () => {
  const ctx = deMatchContext(); loadFlattenHelpers(ctx);
  ctx.matchesState = [{
    id: 1, _sid: 'R1|eA|eB|0', round: 'R1',
    _challongeMatchId: 555, _challongePushState: 'ok', division: 'Div A', _challongeGroupId: 99,
    p1: { player: 'Ken', entryId: 'eA', builds: [], win: true },
    p2: { player: 'Mia', entryId: 'eB', builds: [], win: false },
    submitted: false
  }];
  vm.runInContext('flattenMatchesToResults()', ctx);
  assert.equal(ctx.resultsState[0]._challongeMatchId, 555, 'p1 row must carry _challongeMatchId');
  assert.equal(ctx.resultsState[1]._challongeMatchId, 555, 'p2 row must carry _challongeMatchId');
  assert.equal(ctx.resultsState[0]._challongePushState, 'ok');
  assert.equal(ctx.resultsState[0].division, 'Div A');
  assert.equal(ctx.resultsState[0]._challongeGroupId, 99);
});

test('flattenSingleMatch: _challongeMatchId persisted on both solo rows', () => {
  const ctx = deMatchContext(); loadFlattenHelpers(ctx);
  const match = {
    id: 2, _sid: 'R1|eC|eD|0', round: 'R1',
    _challongeMatchId: 777, _challongePushState: 'pending',
    p1: { player: 'Amy', entryId: 'eC', builds: [], win: false },
    p2: { player: 'Bob', entryId: 'eD', builds: [], win: true },
    submitted: false
  };
  ctx.matchesState = [match];
  const rows = vm.runInContext('flattenSingleMatch(matchesState[0])', ctx);
  assert.equal(rows[0]._challongeMatchId, 777, 'p1 row must carry _challongeMatchId');
  assert.equal(rows[1]._challongeMatchId, 777, 'p2 row must carry _challongeMatchId');
  assert.equal(rows[0]._challongePushState, 'pending');
});

test('flattenMatchesToResults: solo row with no _challongeMatchId does not emit the field', () => {
  const ctx = deMatchContext(); loadFlattenHelpers(ctx);
  ctx.matchesState = [{
    id: 3, _sid: 'R1|eE|eF|0', round: 'R1',
    p1: { player: 'X', entryId: 'eE', builds: [], win: false },
    p2: { player: 'Y', entryId: 'eF', builds: [], win: false },
    submitted: false
  }];
  vm.runInContext('flattenMatchesToResults()', ctx);
  assert.equal(ctx.resultsState[0]._challongeMatchId, undefined, 'absent field must not appear');
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2 — rehydrate Challonge id + DE dePoints through load and live-sync
// ─────────────────────────────────────────────────────────────────────────────

test('loadMatchesFromResults: _challongeMatchId rehydrated from solo rows', () => {
  const ctx = deMatchContext(); loadFlattenHelpers(ctx);
  ctx.resultsState = [
    { player: 'Ken', entryId: 'eA', round: 'R1', builds: [], win: true,
      _matchSid: 'R1|eA|eB|0', _challongeMatchId: 555, _challongePushState: 'ok', division: 'Div A' },
    { player: 'Mia', entryId: 'eB', round: 'R1', builds: [], win: false,
      _matchSid: 'R1|eA|eB|0', _challongeMatchId: 555, _challongePushState: 'ok', division: 'Div A' },
  ];
  vm.runInContext('loadMatchesFromResults()', ctx);
  assert.equal(ctx.matchesState.length, 1);
  assert.equal(ctx.matchesState[0]._challongeMatchId, 555, '_challongeMatchId must rehydrate');
  assert.equal(ctx.matchesState[0]._challongePushState, 'ok');
  assert.equal(ctx.matchesState[0].division, 'Div A');
});

test('mergeIncomingMatches: full-replace preserves _challongeMatchId and DE dePoints from rows', () => {
  const context = createContext([]);
  loadMergeHelper(context);
  context.dirty = false;
  context.mergeIncomingMatches(
    {},
    [
      { player: 'Lienathan', entryId: 'eL1', round: 'R1', builds: [], win: true,
        _matchSid: 'R1|eL1|eL2|0', _challongeMatchId: 777, _challongePushState: 'ok',
        _noStats: true, dePoints: 4, _submitted: true },
      { player: 'Lienathan', entryId: 'eL2', round: 'R1', builds: [], win: false,
        _matchSid: 'R1|eL1|eL2|0', _challongeMatchId: 777, _challongePushState: 'ok',
        _noStats: true, dePoints: 1, _submitted: true }
    ]
  );
  assert.equal(context.matchesState.length, 1, 'one match rebuilt');
  assert.equal(context.matchesState[0]._challongeMatchId, 777, '_challongeMatchId must survive merge');
  assert.equal(context.matchesState[0]._challongePushState, 'ok');
  assert.equal(context.matchesState[0]._deSelfMatch, true, '_deSelfMatch must be set from _noStats rows');
  assert.equal(context.matchesState[0].p1.dePoints, 4, 'p1 dePoints must survive merge');
  assert.equal(context.matchesState[0].p2.dePoints, 1, 'p2 dePoints must survive merge');
});

test('mergeIncomingMatches: team full-replace preserves Challonge metadata from anchor row', () => {
  const context = createContext([]);
  loadMergeHelper(context);
  context.dirty = false;
  context.mergeIncomingMatches(
    {},
    [
      { player: 'A1', team: 'Alpha', round: 'R1', builds: [], win: true,
        _matchSid: 'R1|T|Alpha|Beta|0', _challongeMatchId: 888,
        _challongePushState: 'ok', division: 'Group A', _challongeGroupId: 12 },
      { player: 'A2', team: 'Alpha', round: 'R1', builds: [], win: false,
        _matchSid: 'R1|T|Alpha|Beta|0' },
      { player: 'B1', team: 'Beta', round: 'R1', builds: [], win: false,
        _matchSid: 'R1|T|Alpha|Beta|0' },
      { player: 'B2', team: 'Beta', round: 'R1', builds: [], win: true,
        _matchSid: 'R1|T|Alpha|Beta|0' },
    ]
  );

  assert.equal(context.matchesState.length, 1);
  assert.equal(context.matchesState[0]._challongeMatchId, 888);
  assert.equal(context.matchesState[0]._challongePushState, 'ok');
  assert.equal(context.matchesState[0].division, 'Group A');
  assert.equal(context.matchesState[0]._challongeGroupId, 12);
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 4 — autoCheckDeWin: higher dePoints wins, tie = no winner
// ─────────────────────────────────────────────────────────────────────────────

test('autoCheckDeWin: higher dePoints wins (2 vs 4 → p2 wins)', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  ctx._m = {
    round: 'R1', _deSelfMatch: true,
    p1: { player: 'L', entryId: 'eL1', builds: [], dePoints: 2 },
    p2: { player: 'L', entryId: 'eL2', builds: [], dePoints: 4 },
  };
  vm.runInContext('autoCheckDeWin(_m)', ctx);
  assert.equal(ctx._m.p1.win, false, 'p1 (2pts) must lose');
  assert.equal(ctx._m.p2.win, true,  'p2 (4pts) must win');
});

test('autoCheckDeWin: equal dePoints → no winner (tie)', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  ctx._m = {
    round: 'R1', _deSelfMatch: true,
    p1: { player: 'L', entryId: 'eL1', builds: [], dePoints: 3 },
    p2: { player: 'L', entryId: 'eL2', builds: [], dePoints: 3 },
  };
  vm.runInContext('autoCheckDeWin(_m)', ctx);
  assert.equal(ctx._m.p1.win, false, 'tie → no winner');
  assert.equal(ctx._m.p2.win, false);
});

test('autoCheckDeWin: 4 vs 2 → p1 wins (backward compat)', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  ctx._m = {
    round: 'R1', _deSelfMatch: true,
    p1: { player: 'L', entryId: 'eL1', builds: [], dePoints: 4 },
    p2: { player: 'L', entryId: 'eL2', builds: [], dePoints: 2 },
  };
  vm.runInContext('autoCheckDeWin(_m)', ctx);
  assert.equal(ctx._m.p1.win, true);
  assert.equal(ctx._m.p2.win, false);
});

test('autoCheckDeWin: 0 vs 0 → no winner', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  ctx._m = {
    round: 'R1', _deSelfMatch: true,
    p1: { player: 'L', entryId: 'eL1', builds: [] },
    p2: { player: 'L', entryId: 'eL2', builds: [] },
  };
  vm.runInContext('autoCheckDeWin(_m)', ctx);
  assert.equal(ctx._m.p1.win, false);
  assert.equal(ctx._m.p2.win, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 5 — DE self-match lightning score modal
// ─────────────────────────────────────────────────────────────────────────────

test('deScorePick: updates scratch state only, does not call flatten or markDirty', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  // Set up _deScore and a match
  vm.runInContext(`
    var _deScore = { mid: 1, p1: null, p2: null };
    matchesState = [{
      id: 1, _sid: 'R1|eL1|eL2|0', round: 'R1', _deSelfMatch: true,
      p1: { player: 'Lienathan', entryId: 'eL1', displayLabel: 'Lienathan 1', builds: [] },
      p2: { player: 'Lienathan', entryId: 'eL2', displayLabel: 'Lienathan 2', builds: [] },
      submitted: false
    }];
    var flattenCalled = 0;
    var markDirtyCalled = 0;
    // Stub renderDeScoreModal so it doesn't error
    function renderDeScoreModal() {}
  `, ctx);
  // Override flatten and markDirty to track calls
  ctx.flattenMatchesToResults = () => { ctx._flattenCalled = (ctx._flattenCalled || 0) + 1; };
  ctx.markDirty = () => { ctx._markDirtyCalled = (ctx._markDirtyCalled || 0) + 1; };
  // Load deScorePick — it's defined near renderDeSelfMatchCard; extract it
  const htmlSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const startMarker = 'function deScorePick(';
  const endMarker = 'function deScoreDone(';
  const start = htmlSrc.indexOf(startMarker);
  const end = htmlSrc.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'deScorePick must exist');
  vm.runInContext(htmlSrc.slice(start, end), ctx);
  vm.runInContext('deScorePick("p1", 2)', ctx);
  assert.equal(ctx._deScore.p1, 2, 'scratch state must update');
  assert.equal(ctx._flattenCalled || 0, 0, 'flattenMatchesToResults must NOT be called');
  assert.equal(ctx._markDirtyCalled || 0, 0, 'markDirty must NOT be called');
  assert.equal(ctx._deScore.p2, null, 'p2 not touched');
});

test('deScoreDone validation: rejects null scores and tie', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  const htmlSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'eventmanager.html'), 'utf8');
  // Extract deScoreDone + closeDeSelfScore + _deScore
  const startMarker = 'let _deScore =';
  const endMarker = '// ── Helper: get play order';
  const start = htmlSrc.indexOf(startMarker);
  const end = htmlSrc.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'DE score state must exist');
  vm.runInContext(htmlSrc.slice(start, end), ctx);

  // Stub DOM and dependencies
  const errMessages = [];
  ctx.document = {
    getElementById: (id) => ({
      textContent: '',
      set textContent(v) { if (id === 'de-score-error') errMessages.push(v); },
      style: { display: '' }
    })
  };
  ctx.flattenMatchesToResults = () => {};
  ctx.submitMatch = async () => {};
  ctx.matchesState = [{
    id: 99, round: 'R1', _deSelfMatch: true,
    p1: { player: 'L', entryId: 'eL1', displayLabel: 'L1', builds: [] },
    p2: { player: 'L', entryId: 'eL2', displayLabel: 'L2', builds: [] },
    submitted: false
  }];

  // Test 1: null scores → error
  vm.runInContext('_deScore = { mid: 99, p1: null, p2: null }', ctx);
  vm.runInContext('deScoreDone()', ctx);
  assert.ok(errMessages.some(m => m.includes('select') || m.includes('score')),
    'null scores must produce an error message');

  // Test 2: tie → error
  vm.runInContext('_deScore = { mid: 99, p1: 3, p2: 3 }', ctx);
  vm.runInContext('deScoreDone()', ctx);
  assert.ok(errMessages.some(m => m.toLowerCase().includes('tie') || m.includes('differ')),
    'tied scores must produce an error message');
});

test('deScoreDone valid: writes dePoints and win to match, calls submitMatch once', () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  const htmlSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const startMarker = 'let _deScore =';
  const endMarker = '// ── Helper: get play order';
  const start = htmlSrc.indexOf(startMarker);
  const end = htmlSrc.indexOf(endMarker, start);
  vm.runInContext(htmlSrc.slice(start, end), ctx);

  let submitCalls = 0;
  ctx.flattenMatchesToResults = () => {};
  ctx.submitMatch = async (id) => { submitCalls++; return; };
  ctx.invalidateChallongePushState = () => {};
  ctx.document = {
    getElementById: () => ({
      textContent: '', set textContent(v) {}, style: { display: '' }
    })
  };
  ctx.matchesState = [{
    id: 99, round: 'R1', _deSelfMatch: true,
    p1: { player: 'L', entryId: 'eL1', displayLabel: 'L1', builds: [], dePoints: null },
    p2: { player: 'L', entryId: 'eL2', displayLabel: 'L2', builds: [], dePoints: null },
    submitted: false
  }];
  vm.runInContext('_deScore = { mid: 99, p1: 2, p2: 4 }', ctx);
  // Run async deScoreDone (resolves immediately since submitMatch is a stub)
  const result = vm.runInContext('deScoreDone()', ctx);
  // Drain microtasks
  return (result || Promise.resolve()).then ? (result || Promise.resolve()).then(() => {
    assert.equal(ctx.matchesState[0].p1.dePoints, 2, 'p1 dePoints must be written');
    assert.equal(ctx.matchesState[0].p2.dePoints, 4, 'p2 dePoints must be written');
    assert.equal(ctx.matchesState[0].p1.win, false, 'p1 must lose (lower score)');
    assert.equal(ctx.matchesState[0].p2.win, true,  'p2 must win (higher score)');
    assert.equal(submitCalls, 1, 'submitMatch must be called exactly once');
  }) : Promise.resolve();
});

test('deScoreDone valid: invalidates a previous successful Challonge push before resubmitting', async () => {
  const ctx = deMatchContext();
  loadFlattenHelpers(ctx);
  const htmlSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const start = htmlSrc.indexOf('let _deScore =');
  const end = htmlSrc.indexOf('// ── Helper: get play order', start);
  vm.runInContext(htmlSrc.slice(start, end), ctx);

  let invalidated = 0;
  ctx.invalidateChallongePushState = (match) => {
    invalidated++;
    delete match._challongePushState;
  };
  ctx.flattenMatchesToResults = () => {};
  ctx.submitMatch = async () => {};
  ctx.document = {
    getElementById: () => ({
      textContent: '', set textContent(v) {}, style: { display: '' }
    })
  };
  ctx.matchesState = [{
    id: 101, round: 'R1', _deSelfMatch: true, _challongeMatchId: 500, _challongePushState: 'ok',
    p1: { player: 'L', entryId: 'eL1', builds: [], dePoints: 4, win: true },
    p2: { player: 'L', entryId: 'eL2', builds: [], dePoints: 1, win: false },
    submitted: false
  }];
  vm.runInContext('_deScore = { mid: 101, p1: 2, p2: 4 }', ctx);

  await vm.runInContext('deScoreDone()', ctx);

  assert.equal(invalidated, 1);
  assert.equal(ctx.matchesState[0]._challongePushState, undefined);
});

test('renderDeSelfMatchCard: summary shows the selected score instead of the round maximum', () => {
  const ctx = {
    soloThreshold: () => 4,
    escHtml: value => String(value),
    challongePushChipHtml: () => '',
    submitAreaHtml: () => '',
    _autoSubmit: null,
  };
  vm.createContext(ctx);
  // Widen the slice to include matchStatusChipHtml, matchOverflowMenuHtml, and
  // compactMatchHeaderHtml which are all called by renderDeSelfMatchCard.
  const start = html.indexOf('function matchStatusChipHtml(');
  const end = html.indexOf('function mSelectDeWinner(', start);
  vm.runInContext(html.slice(start, end), ctx);

  // Use collapsed:false so the expanded body with score is rendered.
  const rendered = ctx.renderDeSelfMatchCard({
    id: 1, round: 'R1', collapsed: false,
    p1: { player: 'Alpha', dePoints: 3, win: true },
    p2: { player: 'Beta', dePoints: 2, win: false },
  });
  // The expanded body shows "<p1Label> ADV ... <p1pts>–<p2pts>" using the actual
  // dePoints values. Assert the actual points (3 and 2) appear and the round
  // maximum (4) does NOT appear as the leading score.
  assert.match(rendered, /3[–\-]2/);
  assert.doesNotMatch(rendered, /4[–\-]2/);
});

test('unsubmitMatch: DE results clear dePoints and invalidate the Challonge push state', async () => {
  const ctx = {
    currentEvent: { id: 'evt-de' },
    matchesState: [{
      id: 77, _sid: 'R1|e1|e2|0', round: 'R1', _deSelfMatch: true,
      _challongeMatchId: 900, _challongePushState: 'ok', submitted: true,
      p1: { player: 'L', entryId: 'e1', builds: [], dePoints: 4, win: true },
      p2: { player: 'L', entryId: 'e2', builds: [], dePoints: 1, win: false },
    }],
    buildsState: {},
    resultsState: [],
    _syncPaused: false,
    _lastSyncHash: '',
    confirm: () => true,
    _clearAutoSubmitTimer() {},
    document: { getElementById: () => null },
    fetch: async (url) => url.includes('_t=')
      ? { ok: true, json: async () => ({ builds: {}, beyResults: [] }) }
      : { ok: true, json: async () => ({ beyResults: [] }) },
    mergeIncomingMatches() {},
    flattenMatchesToResults() {},
    getMatchSidSnapshot: () => new Set(),
    buildMergePutBody: () => ({ body: {}, deletedSnapshot: [] }),
    clearAckedDeletedSids() {},
    sidsFromServerPayload: () => new Set(),
    confirmPendingMatchesSaved() {},
    markDirty() {},
    renderResults() {},
    showToast() {},
    invalidateChallongePushState(match) { delete match._challongePushState; },
    JSON,
    Promise,
    Set,
  };
  vm.createContext(ctx);
  const start = html.indexOf('async function unsubmitMatch(');
  const end = html.indexOf('function exportMatches(', start);
  vm.runInContext(html.slice(start, end), ctx);

  await vm.runInContext('unsubmitMatch(77)', ctx);

  assert.equal(ctx.matchesState[0].p1.dePoints, undefined);
  assert.equal(ctx.matchesState[0].p2.dePoints, undefined);
  assert.equal(ctx.matchesState[0]._challongePushState, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 6 — isMatchScored: correctly identifies scored/unscored matches
// ─────────────────────────────────────────────────────────────────────────────

function loadDedupHelpers(context) {
  const html = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'eventmanager.html'), 'utf8'
  );
  const start = html.indexOf('// DEDUP-HELPERS START');
  const end   = html.indexOf('// DEDUP-HELPERS END', start);
  assert.notEqual(start, -1, 'Missing DEDUP-HELPERS START marker');
  assert.notEqual(end,   -1, 'Missing DEDUP-HELPERS END marker');
  vm.runInContext(html.slice(start, end), context);
}

test('isMatchScored: submitted match is scored', () => {
  const ctx = createContext([]);
  loadDedupHelpers(ctx);
  ctx._m = { id: 1, submitted: true, p1: { builds: [] }, p2: { builds: [] } };
  assert.equal(vm.runInContext('isMatchScored(_m)', ctx), true);
});

test('isMatchScored: match with p1.win is scored', () => {
  const ctx = createContext([]);
  loadDedupHelpers(ctx);
  ctx._m = { id: 2, submitted: false, p1: { win: true, builds: [] }, p2: { builds: [] } };
  assert.equal(vm.runInContext('isMatchScored(_m)', ctx), true);
});

test('isMatchScored: match with dePoints > 0 is scored', () => {
  const ctx = createContext([]);
  loadDedupHelpers(ctx);
  ctx._m = { id: 3, submitted: false, _deSelfMatch: true,
    p1: { builds: [], dePoints: 2 }, p2: { builds: [], dePoints: 0 } };
  assert.equal(vm.runInContext('isMatchScored(_m)', ctx), true);
});

test('isMatchScored: unscored match is not scored', () => {
  const ctx = createContext([]);
  loadDedupHelpers(ctx);
  ctx._m = { id: 4, submitted: false,
    p1: { builds: [{ build: 'X', finishes: [] }] },
    p2: { builds: [] } };
  assert.equal(vm.runInContext('isMatchScored(_m)', ctx), false);
});

test('dedupeChallongeImports: one approval removes duplicates without per-match confirmations', async () => {
  let confirmCalls = 0;
  const ctx = {
    currentEvent: {
      challongeTournamentId: 'tour-1',
      challongeParticipantMap: {},
      type: '1v1',
    },
    matchesState: [
      { id: 1, round: 'R1', _sid: 'one', p1: { player: 'A', entryId: 'a', builds: [] }, p2: { player: 'B', entryId: 'b', builds: [] } },
      { id: 2, round: 'R1', _sid: 'two', p1: { player: 'A', entryId: 'a', builds: [] }, p2: { player: 'B', entryId: 'b', builds: [] } },
    ],
    existingMatchSignature: m => `${m.round}|${m.p1.entryId}|${m.p2.entryId}`,
    fetch: async () => ({ ok: true, json: async () => [] }),
    challongeAccountParams: () => '',
    challongeImportSignature: () => '',
    challongeRoundLabel: round => `R${round}`,
    flattenMatchesToResults() {},
    markDirty() {},
    queueCreatedMatchSave: async () => {},
    showToast() {},
    console,
    Map,
    Object,
    Promise,
  };
  ctx.confirm = () => { confirmCalls++; return true; };
  ctx.removeMatch = async (id, options) => {
    if (!options || !options.skipConfirm) ctx.confirm();
    ctx.matchesState = ctx.matchesState.filter(m => m.id !== id);
    return true;
  };
  vm.createContext(ctx);
  loadDedupHelpers(ctx);

  await vm.runInContext('dedupeChallongeImports()', ctx);

  assert.equal(confirmCalls, 1);
  assert.equal(ctx.matchesState.length, 1);
});

// Finding 3 — doLiveSync must NOT advance _lastSyncHash when mergeIncomingMatches
// deferred a server update because a local match was still protected by an
// un-acked outbox write. If it advances the fingerprint, the next poll sees an
// unchanged server snapshot, short-circuits on the equal hash, and the server's
// winner is never applied — the cross-device "winner doesn't show up" bug.
function loadLiveSyncContext(localMatchesState, serverPayload, outboxSids) {
  const ctx = {
    currentEvent: { id: 'evt-b' },
    _syncPaused: false,
    _syncErrorCount: 0,
    _lastSyncHash: '',
    _activeLiveMatchSid: null,
    _matchIdCounter: 50,
    dirty: false,
    buildsState: {},
    matchesState: localMatchesState,
    resultsState: [],
    // A simple deterministic fingerprint is enough to expose the ordering bug.
    syncFingerprint: (builds, results) => JSON.stringify([results, builds]),
    document: { getElementById: () => null },
    setLiveIndicator() {},
    applyConcurrencyHeader() {},
    fetch: async () => ({ ok: true, json: async () => serverPayload }),
    // Outbox membership = protection. We mutate the returned set between polls.
    loadOutbox: () => [...outboxSids].map(sid => ({ matchSid: sid })),
    showToast() {},
    renderBuilds() {}, renderResults() {}, renderRoundFilter() {},
    playerKey: p => p,
    slotKey: s => (s && (s.entryId || s.player)),
    isDeSelfMatch: () => false,
    flattenMatchesToResults() {
      ctx.resultsState = ctx.matchesState.flatMap(m => [
        { ...m.p1, round: m.round, _matchSid: m._sid },
        { ...m.p2, round: m.round, _matchSid: m._sid },
      ]);
    },
    Date, JSON, Set, Array, Object, Promise, console,
  };
  ctx._soloSid = (round, p1, p2, idx) =>
    `${round}|${p1.entryId || p1.player}|${p2.entryId || p2.player}|${idx}`;
  ctx._teamSid = (round, t1, t2, idx) => `${round}|T|${t1}|${t2}|${idx}`;
  vm.createContext(ctx);
  vm.runInContext(
    extractBetween('async function doLiveSync()', 'function mergeIncomingMatches'),
    ctx
  );
  loadMergeHelper(ctx);
  return ctx;
}

test('Finding 3: a deferred (protected) server winner is applied once protection clears', async () => {
  const sid = 'R1|a|b|0';
  const localMatchesState = [{
    id: 1, _sid: sid, round: 'R1', submitted: false,
    p1: { player: 'a', entryId: 'a', win: false, builds: [] },
    p2: { player: 'b', entryId: 'b', win: false, builds: [] },
  }];
  // Server already has the declared winner (synced from Challonge on device A).
  const serverPayload = {
    builds: {},
    beyResults: [
      { player: 'a', entryId: 'a', round: 'R1', _matchSid: sid, win: true,  _submitted: true, builds: [] },
      { player: 'b', entryId: 'b', round: 'R1', _matchSid: sid, win: false, _submitted: true, builds: [] },
    ],
  };
  const outboxSids = new Set([sid]); // local write still un-acked → protected
  const ctx = loadLiveSyncContext(localMatchesState, serverPayload, outboxSids);

  // Poll 1: protection holds, the server winner is correctly NOT applied yet.
  await vm.runInContext('doLiveSync()', ctx);
  assert.equal(ctx.matchesState[0].submitted, false,
    'poll 1 must not overwrite a protected local match');

  // Protection clears (the local write was acked and drained from the outbox).
  outboxSids.clear();

  // Poll 2: the server snapshot is UNCHANGED. The winner must still land now.
  await vm.runInContext('doLiveSync()', ctx);
  assert.equal(ctx.matchesState[0].submitted, true,
    'poll 2 must apply the server winner once protection clears');
  assert.equal(ctx.matchesState[0].p1.win, true,
    'the declared winner must propagate to this device');
});
