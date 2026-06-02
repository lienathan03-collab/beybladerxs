# Always-Live Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the event manager push every score change to the server on its own (match-level patch), propagate in-progress scores to all phones, keep localStorage only as an idempotent offline outbox that auto-flushes on reconnect, gate live scoring on the atomic Durable Object path, and turn Finalize into archive/stats-only.

**Architecture:** Client-side change in `eventmanager.html` plus tests. Each score mutation calls a debounced `scheduleLivePush(mid)` (hooked once inside `evaluateAutoSubmit`). The debounce flushes a **match-level patch** (`buildMatchPatchBody`) — only the changed `matchSid`'s rows — through the existing merge-mode `PUT /api/beyresults`. The server's `mergeBeyResults`/DO `merge.js` already preserve matches absent from an incoming subset, so no server code changes; an integration test locks that in. The live-sync merge is extended to adopt in-progress (non-submitted) scores for matches the local phone is not actively editing. localStorage becomes an outbox of idempotent ops (`clientId`+`opId`) flushed on `online` and on each poll tick. Finalize drops its full-event PUT.

**Tech Stack:** Vanilla JS in `eventmanager.html`; Cloudflare Pages Functions (`functions/api/beyresults.js`) + SQLite Durable Object (`workers/bey-state-do`); tests via Node's built-in runner (`node --test`), loading HTML regions with `vm.runInContext`.

---

## File Structure

- **Modify** `eventmanager.html`:
  - New helpers (near `flattenMatchesToResults`, ~line 3096): `flattenSingleMatch(match)`, `buildMatchPatchBody(eventId, match)`.
  - New outbox module (near `_createMatchSaveQueue`, ~line 6025): `getClientId()`, `enqueueOutboxOp()`, `loadOutbox()`, `saveOutbox()`, `dropOutboxForSid()`, `confirmOutboxAcked()`.
  - New live-push (near auto-submit engine, ~line 3668): `scheduleLivePush(mid)`, `pushMatchLive(match)`, `flushOutbox()`.
  - Hook: one line at top of `evaluateAutoSubmit` (~line 3620).
  - Merge change: in-progress adoption in `mergeIncomingMatches` dirty branch (~line 6312) guarded by `_activeLiveMatchSid`.
  - Concurrency gating: `_concurrencyMode`, header read in `doLiveSync` + push paths, banner + live-push disable (~`doLiveSync` 6192, `updateNetworkStatus` 7155).
  - Reconnect: extend `online` listener (~line 7188) + periodic flush in `doLiveSync` (~line 6207).
  - Finalize rewrite: `saveAll` (~line 6755) drops full PUT, flushes outbox, then archives/stats.
- **Modify** `tests/eventmanager-sync-regression.test.js`: unit tests for patch body, in-progress adoption, outbox idempotency, concurrency gating.
- **Modify** `tests/integration/do-integration.test.js`: match-level patch round-trip preserving other matches.

**Run all tests:** `node --test tests/eventmanager-sync-regression.test.js` and `node --test tests/integration/do-integration.test.js` (Node ≥ 22).

---

## Task 1: Match-level patch body

**Files:**
- Modify: `eventmanager.html` (insert after `flattenMatchesToResults`, line 3129)
- Test: `tests/eventmanager-sync-regression.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/eventmanager-sync-regression.test.js`:

```javascript
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
  // Only matchA's rows are present
  const sids = new Set(body.beyResults.map(r => r._matchSid));
  assert.deepEqual([...sids], ['R1|a|b|0']);
  assert.equal(body.beyResults.length, 2); // p1 + p2 of matchA only
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: FAIL — `extractBetween` throws "Missing source marker: // LIVE-PUSH PATCH HELPERS (start)".

- [ ] **Step 3: Write minimal implementation**

In `eventmanager.html`, insert immediately after the closing `}` of `flattenMatchesToResults` (line 3129):

```javascript
// LIVE-PUSH PATCH HELPERS (start)
// Flatten ONE match to its server rows (mirrors flattenMatchesToResults per-match
// logic) so we can PUT just this match without touching any other match.
function flattenSingleMatch(match) {
  const rows = [];
  if (!match) return rows;
  if (!match.isTeamMatch) autoCheckWin(match); else autoCheckTeamWin(match);
  const sid = match._sid || undefined;
  if (match.isTeamMatch) {
    let firstT1 = true;
    for (const member of (match.team1 ? match.team1.members : [])) {
      const entry = { player: member.player, round: match.round, builds: member.builds, pointsTotal: calcPoints(member.builds), win: member.win, team: match.team1.teamName, _matchSid: sid };
      if (firstT1) { if (match._playOrder) entry._playOrder = match._playOrder; firstT1 = false; }
      if (match.submitted) entry._submitted = true;
      rows.push(entry);
    }
    for (const member of (match.team2 ? match.team2.members : [])) {
      const entry = { player: member.player, round: match.round, builds: member.builds, pointsTotal: calcPoints(member.builds), win: member.win, team: match.team2.teamName, _matchSid: sid };
      if (match.submitted) entry._submitted = true;
      rows.push(entry);
    }
  } else {
    if (match.p1) rows.push({ player: match.p1.player, entryId: match.p1.entryId || undefined, entryType: match.p1.entryType || undefined, displayLabel: match.p1.displayLabel || undefined, round: match.round, builds: match.p1.builds, pointsTotal: calcPoints(match.p1.builds), win: match.p1.win, _submitted: match.submitted || undefined, _matchSid: sid });
    if (match.p2) rows.push({ player: match.p2.player, entryId: match.p2.entryId || undefined, entryType: match.p2.entryType || undefined, displayLabel: match.p2.displayLabel || undefined, round: match.round, builds: match.p2.builds, pointsTotal: calcPoints(match.p2.builds), win: match.p2.win, _submitted: match.submitted || undefined, _matchSid: sid });
  }
  return rows;
}

// Merge-mode PUT body carrying ONLY this match's rows. No deletedSids here —
// deletions go through removeMatch's own immediate push, never the live-push.
function buildMatchPatchBody(eventId, match) {
  const beyResults = flattenSingleMatch(match);
  // Include only builds keys this match's players reference (shallow-merged server-side).
  const builds = {};
  for (const row of beyResults) {
    if (row.player && buildsState && Object.prototype.hasOwnProperty.call(buildsState, row.player)) {
      builds[row.player] = buildsState[row.player];
    }
  }
  return {
    body: { adminUsername: adminUser, adminPassword: adminPass, eventId, builds, beyResults, mergeMode: true }
  };
}
// LIVE-PUSH PATCH HELPERS (end)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/eventmanager-sync-regression.test.js
git commit -m "feat: match-level patch body for live scoring push" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Idempotent offline outbox

**Files:**
- Modify: `eventmanager.html` (insert after `getEventDeletedSids`, ~line 6037)
- Test: `tests/eventmanager-sync-regression.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/eventmanager-sync-regression.test.js`:

```javascript
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

  // ack by sid clears it
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: FAIL — "Missing source marker: // LIVE OUTBOX (start)".

- [ ] **Step 3: Write minimal implementation**

In `eventmanager.html`, insert after the `getEventDeletedSids` function (line 6037):

```javascript
// LIVE OUTBOX (start)
// Idempotent per-device queue of un-acked match patches. Keyed by eventId in
// localStorage. Each op: { eventId, matchSid, clientId, opId, payload, createdAt }.
// Only the LATEST op per matchSid is retained (older ones are superseded).
function _uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function getClientId() {
  let id = null;
  try { id = localStorage.getItem('rxs_client_id'); } catch (e) {}
  if (!id) { id = _uuid(); try { localStorage.setItem('rxs_client_id', id); } catch (e) {} }
  return id;
}

function _outboxKey(eventId) { return 'rxs_outbox_' + eventId; }

function loadOutbox(eventId) {
  try {
    const raw = localStorage.getItem(_outboxKey(eventId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveOutbox(eventId, ops) {
  try { localStorage.setItem(_outboxKey(eventId), JSON.stringify(ops)); } catch (e) {}
}

function enqueueOutboxOp(matchSid, payload) {
  if (!currentEvent || !matchSid) return null;
  const eventId = currentEvent.id;
  const ops = loadOutbox(eventId).filter(o => o.matchSid !== matchSid); // supersede
  const op = { eventId, matchSid, clientId: getClientId(), opId: _uuid(), payload, createdAt: Date.now() };
  ops.push(op);
  saveOutbox(eventId, ops);
  return op;
}

function dropOutboxOp(eventId, opId) {
  saveOutbox(eventId, loadOutbox(eventId).filter(o => o.opId !== opId));
}

// Clear ops whose matchSid the server has confirmed it holds.
function confirmOutboxAcked(eventId, observedSids) {
  if (!observedSids || !observedSids.size) return;
  saveOutbox(eventId, loadOutbox(eventId).filter(o => !observedSids.has(o.matchSid)));
}
// LIVE OUTBOX (end)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/eventmanager-sync-regression.test.js
git commit -m "feat: idempotent localStorage outbox for live scoring" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: In-progress score adoption in merge

**Files:**
- Modify: `eventmanager.html` — declare `_activeLiveMatchSid` (near `_syncPaused`, line 6022) and change the dirty-branch adoption condition in `mergeIncomingMatches` (line 6312)
- Test: `tests/eventmanager-sync-regression.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/eventmanager-sync-regression.test.js` (reuses existing `loadMergeHelper`/`createContext` infra at top of file):

```javascript
test('merge adopts in-progress (non-submitted) server score for a non-active match', () => {
  const local = { id: 1, _sid: 'R1|a|b|0', round: 'R1',
    p1: { player: 'a', entryId: 'a', builds: [], win: false },
    p2: { player: 'b', entryId: 'b', builds: [], win: false },
    submitted: false };
  const context = createContext([local]);
  context._activeLiveMatchSid = null;       // not actively editing this match
  loadMergeHelper(context);

  // Server reports an in-progress O for player a, NOT submitted.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: FAIL — first test fails (in-progress score not adopted; current code only adopts when `sm.submitted || local.submitted`).

- [ ] **Step 3: Write minimal implementation**

3a. Add the active-match marker next to `_syncPaused` (line 6022). Change:

```javascript
let _syncPaused     = false; // pause during active user edits
```
to:
```javascript
let _syncPaused     = false; // pause during active user edits
let _activeLiveMatchSid = null; // sid of the match the judge is currently scoring; never overwritten by sync
```

3b. In `mergeIncomingMatches`, the dirty branch currently reads (line 6312):

```javascript
          if (local._pendingServerSave) delete local._pendingServerSave;
          if (sm.submitted || local.submitted) {
```

Replace that `if` condition so in-progress scores are also adopted, except for the match being actively scored:

```javascript
          if (local._pendingServerSave) delete local._pendingServerSave;
          const isActive = _activeLiveMatchSid && sm._sid === _activeLiveMatchSid;
          if (!isActive && (sm.submitted || local.submitted ||
              JSON.stringify({ p1: sm.p1, p2: sm.p2, team1: sm.team1, team2: sm.team2 }) !==
              JSON.stringify({ p1: local.p1, p2: local.p2, team1: local.team1, team2: local.team2 }))) {
```

This keeps the existing submitted-adoption, adds non-submitted score adoption when server differs, and skips the actively-edited match entirely.

- [ ] **Step 4: Wire `_activeLiveMatchSid` set/clear into Live Mode**

The marker must actually be set while a judge is scoring and cleared on exit, or
the guard never engages in the running app. `lmState.match` is the active match
(`_soloRef` for the 1v1 solo proxy).

4a. At the top of `lmApplyFinish` (line 4599), set the marker on every finish tap.
Change:
```javascript
function lmApplyFinish(type) {
  if (!lmState) return;
```
to:
```javascript
function lmApplyFinish(type) {
  if (!lmState) return;
  {
    const _am = (lmState.match._isSolo && lmState.match._soloRef) ? lmState.match._soloRef : lmState.match;
    _activeLiveMatchSid = _am && _am._sid ? _am._sid : null;
  }
```

4b. Clear it when live mode closes. In `closeLiveMode` (line 4543), add as the
very first line inside the function body:
```javascript
function closeLiveMode() {
  _activeLiveMatchSid = null;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: PASS (both new tests and all pre-existing tests).

- [ ] **Step 6: Commit**

```bash
git add eventmanager.html tests/eventmanager-sync-regression.test.js
git commit -m "feat: propagate in-progress scores via sync, protect active match" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Debounced live-push + hook into scoring

**Files:**
- Modify: `eventmanager.html` — add `pushMatchLive`/`scheduleLivePush` after the auto-submit engine (line 3668); hook `scheduleLivePush` at top of `evaluateAutoSubmit` (line 3620)
- Test: `tests/eventmanager-sync-regression.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/eventmanager-sync-regression.test.js`:

```javascript
function loadLivePush(context) {
  vm.runInContext(
    extractBetween('// LIVE PUSH ENGINE (start)', '// LIVE PUSH ENGINE (end)'),
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
    fetch: async () => { puts++; return { ok: true, headers: { get: () => 'durable-object' }, json: async () => ({ beyResults: [{ _matchSid: 'R1|a|b|0' }] }) }; }
  });
  // patch + outbox helpers the engine calls:
  loadPatchHelpers(context);
  loadLivePush(context);

  context.scheduleLivePush(1);
  context.scheduleLivePush(1);
  context.scheduleLivePush(1);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(puts, 1, 'three rapid taps -> one PUT');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: FAIL — "Missing source marker: // LIVE PUSH ENGINE (start)".

- [ ] **Step 3: Write minimal implementation**

3a. Insert after the auto-submit engine end marker (`// ─── AUTO-SUBMIT ENGINE (end)`, line 3668):

```javascript
// LIVE PUSH ENGINE (start)
// Per-tap live push: debounce per match, then PUT only that match's rows.
// Skips when offline or when the server path is not the atomic DO (best-effort-kv).
const LIVE_PUSH_DEBOUNCE_MS = 800;
let _livePushTimers = {};      // mid -> timeout id
let _livePushQueue = Promise.resolve(); // serialize concurrent pushes

function scheduleLivePush(mid) {
  if (typeof _concurrencyMode !== 'undefined' && _concurrencyMode === 'best-effort-kv') return;
  if (_livePushTimers[mid]) clearTimeout(_livePushTimers[mid]);
  _livePushTimers[mid] = setTimeout(() => {
    delete _livePushTimers[mid];
    const match = matchesState.find(m => m.id === mid);
    if (match) pushMatchLive(match);
  }, (typeof LIVE_PUSH_DEBOUNCE_MS !== 'undefined' ? LIVE_PUSH_DEBOUNCE_MS : 800));
}

// Persist one match's current (non-submitted) state. Always enqueues to the
// outbox first so a failed/offline push is retried later; clears the op on ack.
async function pushMatchLive(match) {
  if (!currentEvent || !match || !match._sid) return;
  const eventId = currentEvent.id;
  const { body } = buildMatchPatchBody(eventId, match);
  const op = enqueueOutboxOp(match._sid, body);
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return; // stays queued
  _livePushQueue = _livePushQueue.catch(() => {}).then(async () => {
    const res = await fetch('/api/beyresults', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (typeof applyConcurrencyHeader === 'function') applyConcurrencyHeader(res);
    let data = {}; try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || 'live push failed');
    const acked = sidsFromServerPayload(data.beyResults);
    if (acked && acked.has(match._sid)) { if (op) dropOutboxOp(eventId, op.opId); }
    confirmOutboxAcked(eventId, acked);
  });
  try { await _livePushQueue; } catch (e) { /* op stays in outbox for retry */ }
}
// LIVE PUSH ENGINE (end)
```

3b. Hook the push at the top of `evaluateAutoSubmit` (line 3620). Change:

```javascript
function evaluateAutoSubmit(mid) {
  _clearAutoSubmitTimer(mid);
```
to:
```javascript
function evaluateAutoSubmit(mid) {
  if (typeof scheduleLivePush === 'function') scheduleLivePush(mid); // live-push every scoring change
  _clearAutoSubmitTimer(mid);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/eventmanager-sync-regression.test.js
git commit -m "feat: debounced per-match live push hooked into scoring" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Reconnect flush

**Files:**
- Modify: `eventmanager.html` — add `flushOutbox()` inside the LIVE PUSH ENGINE block; wire into `online` listener (line 7188) and periodic flush in `doLiveSync` (after the early returns, ~line 6199)
- Test: `tests/eventmanager-sync-regression.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/eventmanager-sync-regression.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: FAIL — `context.flushOutbox is not a function`.

- [ ] **Step 3: Write minimal implementation**

3a. Inside the LIVE PUSH ENGINE block, before `// LIVE PUSH ENGINE (end)`, add:

```javascript
// Push every queued op for the current event (called on reconnect + each poll).
async function flushOutbox() {
  if (!currentEvent) return;
  if (typeof _concurrencyMode !== 'undefined' && _concurrencyMode === 'best-effort-kv') return;
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return;
  const eventId = currentEvent.id;
  const ops = loadOutbox(eventId);
  for (const op of ops) {
    try {
      const res = await fetch('/api/beyresults', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op.payload)
      });
      if (typeof applyConcurrencyHeader === 'function') applyConcurrencyHeader(res);
      let data = {}; try { data = await res.json(); } catch (e) {}
      if (!res.ok) continue; // leave queued for next attempt
      const acked = sidsFromServerPayload(data.beyResults);
      if (acked && acked.has(op.matchSid)) dropOutboxOp(eventId, op.opId);
    } catch (e) { /* leave queued */ }
  }
}
```

3b. Wire reconnect into the `online` listener (line 7188). Change:

```javascript
window.addEventListener('online',  updateNetworkStatus);
```
to:
```javascript
window.addEventListener('online',  () => { updateNetworkStatus(); if (typeof flushOutbox === 'function') flushOutbox(); });
```

3c. Add a periodic flush inside `doLiveSync`, immediately after `if (!currentEvent || _syncPaused) return;` (line 6193):

```javascript
  if (!currentEvent || _syncPaused) return;
  // Opportunistic outbox drain in case the 'online' event was missed (mobile).
  if (typeof flushOutbox === 'function' && loadOutbox(currentEvent.id).length) { flushOutbox(); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/eventmanager-sync-regression.test.js
git commit -m "feat: auto-flush outbox on reconnect and on poll tick" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Concurrency-mode detection + UI gating

**Files:**
- Modify: `eventmanager.html` — add `_concurrencyMode` + `applyConcurrencyHeader` (near `_syncPaused`, line 6022/6024); call it in `doLiveSync` after the GET (line 6201); add banner in `updateNetworkStatus` or a dedicated indicator
- Test: `tests/eventmanager-sync-regression.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/eventmanager-sync-regression.test.js`:

```javascript
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
  assert.equal(context._concurrencyMode, 'best-effort-kv');
  assert.equal(context.liveScoringAllowed(), false);

  context.applyConcurrencyHeader({ headers: { get: () => 'durable-object' } });
  assert.equal(context._concurrencyMode, 'durable-object');
  assert.equal(context.liveScoringAllowed(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: FAIL — "Missing source marker: // CONCURRENCY GATE (start)".

- [ ] **Step 3: Write minimal implementation**

3a. Insert the gate block right after the `_activeLiveMatchSid` declaration (added in Task 3, line ~6023):

```javascript
// CONCURRENCY GATE (start)
let _concurrencyMode = 'unknown'; // 'durable-object' | 'best-effort-kv' | 'unknown'
function liveScoringAllowed() { return _concurrencyMode !== 'best-effort-kv'; }
function applyConcurrencyHeader(res) {
  try {
    const v = res && res.headers && res.headers.get && res.headers.get('X-BEY-CONCURRENCY');
    if (v === 'durable-object' || v === 'best-effort-kv') {
      const changed = v !== _concurrencyMode;
      _concurrencyMode = v;
      if (changed && typeof renderConcurrencyBanner === 'function') renderConcurrencyBanner();
    }
  } catch (e) {}
}
function renderConcurrencyBanner() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('concurrency-warning');
  if (_concurrencyMode === 'best-effort-kv') {
    if (typeof showToast === 'function') showToast('⚠ Live multi-phone scoring is OFF: server is in best-effort-kv mode (Durable Object not bound). Scores may be lost if judges score at the same time. Use one device or enable the DO binding.', 'error');
  }
}
// CONCURRENCY GATE (end)
```

3b. In `doLiveSync`, after `const res = await fetch(...GET...)` succeeds (line 6201), record the header. Change:

```javascript
    const res = await fetch(`/api/beyresults?eventId=${currentEvent.id}&_t=${Date.now()}`);
    if (!res.ok) throw new Error('fetch failed');
```
to:
```javascript
    const res = await fetch(`/api/beyresults?eventId=${currentEvent.id}&_t=${Date.now()}`);
    applyConcurrencyHeader(res);
    if (!res.ok) throw new Error('fetch failed');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/eventmanager-sync-regression.test.js
git commit -m "feat: detect X-BEY-CONCURRENCY and gate live scoring on DO path" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Finalize becomes archive/stats only

**Files:**
- Modify: `eventmanager.html` — `saveAll` (line 6755)
- Test: `tests/eventmanager-sync-regression.test.js`

- [ ] **Step 1: Write the failing test**

`saveAll` touches DOM/network heavily, so assert the source no longer issues a full-event PUT and now flushes the outbox. Add to `tests/eventmanager-sync-regression.test.js`:

```javascript
test('Finalize (saveAll) flushes the outbox and does not full-event PUT', () => {
  const start = html.indexOf('async function saveAll()');
  const end = html.indexOf('async function', start + 10);
  const src = html.slice(start, end);
  assert.ok(/flushOutbox\(\)/.test(src), 'saveAll must flush the outbox');
  assert.ok(!/buildMergePutBody\(/.test(src), 'saveAll must not build a full-event PUT body');
  assert.ok(/archiveBeyResultsToGamedata\(\)/.test(src), 'saveAll still archives');
  assert.ok(/syncBladerStats\(\)/.test(src), 'saveAll still syncs stats');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: FAIL — `saveAll` currently calls `buildMergePutBody` and lacks `flushOutbox`.

- [ ] **Step 3: Write minimal implementation**

In `saveAll` (line 6755), replace the merge-before-save + full PUT block (lines 6773–6805, from `// ── MERGE-BEFORE-SAVE` through the `confirmPendingMatchesSaved(...)`/`_lastSyncHash` updates, ending right before `// 2. Archive`) with an outbox flush:

```javascript
  try {
    // Live score data is already server-backed by the per-match live push.
    // Finalize no longer does a whole-event PUT (that reintroduced stale
    // overwrite risk). Ensure any not-yet-pushed scores reach the server first.
    await flushOutbox();
    // Pull the now-current server state so the archive reflects all devices.
    const latestRes = await fetch(`/api/beyresults?eventId=${currentEvent.id}&_t=${Date.now()}`);
    if (latestRes.ok) {
      applyConcurrencyHeader(latestRes);
      const latestData = await latestRes.json();
      mergeIncomingMatches(latestData.builds || {}, latestData.beyResults || []);
      _lastSyncHash = JSON.stringify(latestData.beyResults || []);
      flattenMatchesToResults();
    }
```

Leave the rest of `saveAll` from `// 2. Archive bey results` onward unchanged (`archiveBeyResultsToGamedata()`, `syncBladerStats()`, `dirty = false`, `localClearDraft(...)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/eventmanager-sync-regression.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/eventmanager-sync-regression.test.js
git commit -m "refactor: Finalize flushes outbox + archives, no full-event PUT" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Integration — match-level patch round-trips through the DO

**Files:**
- Modify: `tests/integration/do-integration.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that PUTs only one match's rows and asserts the other match survives. Use the existing `makeDO`/`makeDOBinding` helpers and the real merge path. Add:

```javascript
test('match-level patch PUT preserves other matches (non-submitted live push)', async () => {
  const do1 = await makeDO();
  const env = { BEY_STATE_DO: makeDOBinding(do1) };
  const mod = await import('../../functions/api/beyresults.js');
  const onRequest = mod.onRequestPut || mod.onRequest;

  const put = (body) => onRequest({
    request: new Request('https://x/api/beyresults', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }),
    env
  });

  // Seed two matches in one merge PUT.
  await put({ adminUsername: 'admin', adminPassword: 'secret', eventId: 'e1', mergeMode: true, builds: {},
    beyResults: [
      { player: 'a', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' },
      { player: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' },
      { player: 'c', round: 'R1', builds: [], win: false, _matchSid: 'R1|c|d|0' },
      { player: 'd', round: 'R1', builds: [], win: false, _matchSid: 'R1|c|d|0' }
    ] });

  // Live push: ONLY match A's rows, with an in-progress O, not submitted.
  await put({ adminUsername: 'admin', adminPassword: 'secret', eventId: 'e1', mergeMode: true, builds: {},
    beyResults: [
      { player: 'a', round: 'R1', builds: [{ finishes: ['O'] }], win: false, _matchSid: 'R1|a|b|0' },
      { player: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' }
    ] });

  const getRes = await onRequest({
    request: new Request('https://x/api/beyresults?eventId=e1', { method: 'GET' }), env
  });
  const data = await getRes.json();
  const sids = new Set(data.beyResults.map(r => r._matchSid));
  assert.ok(sids.has('R1|c|d|0'), 'match C/D preserved by subset patch');
  const aRow = data.beyResults.find(r => r._matchSid === 'R1|a|b|0' && r.player === 'a');
  assert.deepEqual(aRow.builds, [{ finishes: ['O'] }], 'patch applied to match A');
});
```

(If `onRequest`/`onRequestPut`/GET dispatch differs, mirror the dispatch already used by the other tests in this file — read the top of `do-integration.test.js` for the exact handler-invocation helper and reuse it.)

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node --test tests/integration/do-integration.test.js`
Expected: PASS (server already supports subset merge). If it FAILS, the DO `merge.js` is dropping absent sids — fix `mergeBeyResults` to retain existing groups not present in `incoming` (it already does at lines 201–210), then re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/do-integration.test.js
git commit -m "test: match-level patch preserves other matches through the DO" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual verification (after all tasks)

- [ ] Two phones, same event. On phone A open a live match, tap O. Within ~3s phone B's card shows the score. Tap X / more finishes — each propagates.
- [ ] On phone A, enable airplane mode mid-match; confirm "OFFLINE — SAVING LOCALLY". Tap a few finishes. Re-enable; confirm the queued scores push and phone B updates.
- [ ] Delete a match on A; confirm it disappears on B within ~3s (existing behavior, unregressed).
- [ ] Let a winner be reached; confirm the 4s auto-submit still fires and marks submitted on all devices.
- [ ] Finalize; confirm leaderboard/archive reflect submitted matches and no errors.
- [ ] (Optional) Temporarily unbind the DO and confirm the best-effort-kv warning appears and per-tap live push is suppressed.

## Self-Review notes

- **Spec coverage:** §1 patch → Task 1/8; §2 in-progress propagation → Task 3; §3 outbox idempotency → Task 2; §4 reconnect flush → Task 5; §5 LWW server-order (DO single-threaded, no client clock used in merge) → guaranteed by Task 8 path + Task 3 not using timestamps; §6 DO-required gating → Task 6; §7 Finalize → Task 7.
- **Type consistency:** `_concurrencyMode`, `liveScoringAllowed`, `applyConcurrencyHeader`, `scheduleLivePush`, `pushMatchLive`, `flushOutbox`, `enqueueOutboxOp`/`loadOutbox`/`dropOutboxOp`/`confirmOutboxAcked`, `buildMatchPatchBody`/`flattenSingleMatch`, `_activeLiveMatchSid` are used consistently across tasks and tests.
- **Active-match marker:** `_activeLiveMatchSid` is set on each finish tap (`lmApplyFinish`) and cleared in `closeLiveMode` — Task 3 Step 4. This is what makes the merge guard engage in the running app.
```
