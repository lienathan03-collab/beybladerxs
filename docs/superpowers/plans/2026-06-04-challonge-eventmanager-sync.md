# Challonge ↔ EventManager Sync — Implementation Plan (Phase 1: Import/Read)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link an eventmanager event to a Challonge tournament, map participants to roster entries/teams once, and auto-import each Swiss round's pairings as normal editable match cards — with a division/round/name filter so judges find their match fast.

**Architecture:** All UI/logic lives inline in `eventmanager.html` (single-file app) plus the Cloudflare Pages Function `functions/api/challonge.js`. Pure, testable helpers are written between **stable source-marker comments** so the existing test harness can extract them with `vm` (see `tests/eventmanager-sync-regression.test.js`). Imported matches funnel through the **same** `createMatch()` → `flattenMatchesToResults()` → queued live-push path as manual matches, so multi-judge sync and persistence work unchanged.

**Tech Stack:** Vanilla JS in `eventmanager.html`; Cloudflare Pages Functions (ESM) for `/api/challonge`; Node built-in test runner (`node --test`) with `node:assert/strict` and `node:vm`.

**Spec:** `docs/superpowers/specs/2026-06-04-challonge-eventmanager-sync-design.md`

**Scope note:** This plan covers **Phase 1 (read/import)** only — it is independently shippable. **Phase 2 (score write-back to Challonge)** is deferred to its own plan because it requires verifying that the external Vercel proxy (`CHALLONGE_PROXY_URL`) will accept a write/PUT route — an external dependency that cannot be coded until confirmed. See the final section.

---

## Conventions used by this plan

- **Source markers:** every pure helper block is wrapped in
  `// === CHALLONGE-HELPERS START ===` … `// === CHALLONGE-HELPERS END ===`
  inside `eventmanager.html`. Tests extract the slice between these markers and run
  it in a `vm` context (mirrors `loadQueueHelpers` in the existing test file).
- **Test command:** `node --test tests/challonge-import.test.js` (Windows PowerShell
  or bash both fine).
- **Commit after every task.** Keep helpers pure (no DOM access) so they stay testable.

---

## File Structure

- **Create:** `tests/challonge-import.test.js` — unit tests for all pure helpers.
- **Modify:** `functions/api/challonge.js` — add named-account + custom-key
  resolution (pure exported `resolveChallongeTarget`).
- **Modify:** `eventmanager.html` — add the `CHALLONGE-HELPERS` block (pure logic),
  the Settings/Connect UI, the map-once screen, the poll/import engine, and the
  division/round/name filter.

---

## Task 1: Server — named-account + custom-key resolution

**Files:**
- Modify: `functions/api/challonge.js:13-24` (the season→URL block)
- Test: `tests/challonge-import.test.js`

Today the Function picks a proxy URL from two fixed env vars by `?season=`. We add a
pure `resolveChallongeTarget(env, params)` that supports: (a) a named account from a
JSON env map `CHALLONGE_ACCOUNTS`, (b) a per-request custom key, falling back to (c)
the existing season URLs. The key/url stay server-side except the custom key, which
the client sends over HTTPS.

- [ ] **Step 1: Write the failing test**

```js
// tests/challonge-import.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

test('resolveChallongeTarget: named account from CHALLONGE_ACCOUNTS', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_ACCOUNTS: JSON.stringify({
      lienathanS2: { proxyUrl: 'https://proxy.example/s2', key: 'KEY2' },
    }),
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
  };
  const t = resolveChallongeTarget(env, { account: 'lienathanS2' });
  assert.equal(t.proxyUrl, 'https://proxy.example/s2');
  assert.equal(t.key, 'KEY2');
});

test('resolveChallongeTarget: custom key overrides account', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = { CHALLONGE_PROXY_URL: 'https://proxy.example/default' };
  const t = resolveChallongeTarget(env, { customKey: 'ABC123' });
  assert.equal(t.key, 'ABC123');
  assert.equal(t.proxyUrl, 'https://proxy.example/default');
});

test('resolveChallongeTarget: falls back to season URLs', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
    CHALLONGE_PROXY_URL_S3: 'https://proxy.example/s3',
  };
  assert.equal(resolveChallongeTarget(env, { season: '3' }).proxyUrl, 'https://proxy.example/s3');
  assert.equal(resolveChallongeTarget(env, { season: '2' }).proxyUrl, 'https://proxy.example/default');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/challonge-import.test.js`
Expected: FAIL — `resolveChallongeTarget` is not exported.

- [ ] **Step 3: Add the pure resolver to `functions/api/challonge.js`**

Add near the top of the file (after the `CORS_HEADERS` const), exported:

```js
export function resolveChallongeTarget(env, params) {
  const { account, customKey, season } = params || {};
  // (a) named account from JSON env map
  if (account && env.CHALLONGE_ACCOUNTS) {
    let map = {};
    try { map = JSON.parse(env.CHALLONGE_ACCOUNTS); } catch (e) { map = {}; }
    const acc = map[account];
    if (acc && acc.proxyUrl) {
      return { proxyUrl: acc.proxyUrl, key: customKey || acc.key || null };
    }
  }
  // (c) season fallback (existing behaviour)
  const proxyUrl = season === '3'
    ? (env.CHALLONGE_PROXY_URL_S3 || env.CHALLONGE_PROXY_URL)
    : env.CHALLONGE_PROXY_URL;
  // (b) custom key with the default proxy
  return { proxyUrl: proxyUrl || null, key: customKey || null };
}
```

- [ ] **Step 4: Wire `onRequest` to use it**

Replace the existing season→`PROXY_URL` block (`functions/api/challonge.js:13-24`) with:

```js
const reqUrl = new URL(request.url);
const target = resolveChallongeTarget(env, {
  account:   reqUrl.searchParams.get('account')   || undefined,
  customKey: reqUrl.searchParams.get('customKey') || undefined,
  season:    reqUrl.searchParams.get('season')    || '2',
});
const PROXY_URL = target.proxyUrl;

if (!PROXY_URL) {
  return new Response(
    JSON.stringify({ error: 'No Challonge proxy resolved (account/season not configured).' }),
    { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
}
```

(Leave the rest of `onRequest` — the `action` switch and proxy `fetch` — unchanged.
`target.key` is unused for read actions because the proxy holds the key; it becomes
relevant in Phase 2.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/challonge-import.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add functions/api/challonge.js tests/challonge-import.test.js
git commit -m "feat(challonge): named-account + custom-key resolution in proxy function"
```

---

## Task 2: Pure helper — Challonge participant name matching (solo + DE rule)

**Files:**
- Modify: `eventmanager.html` (new `CHALLONGE-HELPERS` block — place it just before
  the `// NEW MATCH MODAL` marker at `eventmanager.html:3244`)
- Test: `tests/challonge-import.test.js`

`matchSoloParticipant(name, players)` resolves a Challonge participant name to a
roster entry. Rule order: exact `displayLabel`/`name` → case-insensitive →
trailing-number DE rule (`"Lienathan 2"` → base "Lienathan", pick the `double`
entry; `"Lienathan 1"` → the `main` entry). `players` is the `getPlayers()` shape:
`{ name, displayLabel, entryId, entryType: 'main'|'double' }`.

- [ ] **Step 1: Write the failing test**

```js
// add to tests/challonge-import.test.js
const fs = require('node:fs');
const vm = require('node:vm');

function loadChallongeHelpers() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const start = html.indexOf('// === CHALLONGE-HELPERS START ===');
  const end = html.indexOf('// === CHALLONGE-HELPERS END ===');
  assert.notEqual(start, -1, 'Missing CHALLONGE-HELPERS START marker');
  assert.notEqual(end, -1, 'Missing CHALLONGE-HELPERS END marker');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

test('matchSoloParticipant: exact and case-insensitive', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  const players = [
    { name: 'Ken', displayLabel: 'Ken', entryId: 'e-ken', entryType: 'main' },
    { name: 'Lienathan', displayLabel: 'Lienathan', entryId: 'e-lien-1', entryType: 'main' },
    { name: 'Lienathan', displayLabel: 'Lienathan (DE)', entryId: 'e-lien-2', entryType: 'double' },
  ];
  assert.equal(matchSoloParticipant('Ken', players).entryId, 'e-ken');
  assert.equal(matchSoloParticipant('ken', players).entryId, 'e-ken');
});

test('matchSoloParticipant: DE trailing-number rule', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  const players = [
    { name: 'Lienathan', displayLabel: 'Lienathan', entryId: 'e-lien-1', entryType: 'main' },
    { name: 'Lienathan', displayLabel: 'Lienathan (DE)', entryId: 'e-lien-2', entryType: 'double' },
  ];
  assert.equal(matchSoloParticipant('Lienathan 1', players).entryId, 'e-lien-1');
  assert.equal(matchSoloParticipant('Lienathan 2', players).entryId, 'e-lien-2');
});

test('matchSoloParticipant: returns null when no match', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  assert.equal(matchSoloParticipant('Nobody', [{ name: 'Ken', displayLabel: 'Ken', entryId: 'e', entryType: 'main' }]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/challonge-import.test.js`
Expected: FAIL — `Missing CHALLONGE-HELPERS START marker`.

- [ ] **Step 3: Add the helper block to `eventmanager.html`**

Insert immediately before the `// NEW MATCH MODAL` block (just above
`eventmanager.html:3244`). Inside a `<script>` region:

```js
// === CHALLONGE-HELPERS START ===
function challongeBaseName(raw) {
  // Strip a trailing " <n>" used for Double Entry, e.g. "Lienathan 2" -> "Lienathan"
  const m = String(raw || '').trim().match(/^(.*?)\s+(\d+)$/);
  return m ? { base: m[1].trim(), num: parseInt(m[2], 10) } : { base: String(raw || '').trim(), num: null };
}

function matchSoloParticipant(rawName, players) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  // exact on displayLabel or name
  let hit = players.find(p => p.displayLabel === name || p.name === name);
  if (hit) return hit;
  // case-insensitive
  const lc = name.toLowerCase();
  hit = players.find(p => (p.displayLabel || '').toLowerCase() === lc || (p.name || '').toLowerCase() === lc);
  if (hit) return hit;
  // DE trailing-number rule
  const { base, num } = challongeBaseName(name);
  if (num != null) {
    const baseLc = base.toLowerCase();
    const sameName = players.filter(p => (p.name || '').toLowerCase() === baseLc);
    if (sameName.length) {
      const wantDouble = num >= 2;
      hit = sameName.find(p => (p.entryType === 'double') === wantDouble);
      return hit || sameName[0];
    }
  }
  return null;
}
// === CHALLONGE-HELPERS END ===
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/challonge-import.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/challonge-import.test.js
git commit -m "feat(challonge): solo participant name matcher with DE rule"
```

---

## Task 3: Pure helper — team matching, round mapping, same-owner skip, dedup

**Files:**
- Modify: `eventmanager.html` (inside the same `CHALLONGE-HELPERS` block)
- Test: `tests/challonge-import.test.js`

Add `matchTeamParticipant(name, teams)`, `challongeRoundLabel(n)`,
`isSameOwnerSolo(p1Entry, p2Entry)`, and `alreadyImported(matchesState, cmId)`.

- [ ] **Step 1: Write the failing test**

```js
test('matchTeamParticipant: exact then case-insensitive', () => {
  const { matchTeamParticipant } = loadChallongeHelpers();
  const teams = [{ teamName: 'Dragon Squad' }, { teamName: 'Phoenix' }];
  assert.equal(matchTeamParticipant('Dragon Squad', teams).teamName, 'Dragon Squad');
  assert.equal(matchTeamParticipant('phoenix', teams).teamName, 'Phoenix');
  assert.equal(matchTeamParticipant('Nope', teams), null);
});

test('challongeRoundLabel maps positive round to R{n}', () => {
  const { challongeRoundLabel } = loadChallongeHelpers();
  assert.equal(challongeRoundLabel(1), 'R1');
  assert.equal(challongeRoundLabel(3), 'R3');
});

test('isSameOwnerSolo true for same base name different entries', () => {
  const { isSameOwnerSolo } = loadChallongeHelpers();
  const a = { name: 'Lienathan', entryId: 'e1', entryType: 'main' };
  const b = { name: 'Lienathan', entryId: 'e2', entryType: 'double' };
  assert.equal(isSameOwnerSolo(a, b), true);
  assert.equal(isSameOwnerSolo(a, { name: 'Ken', entryId: 'e3', entryType: 'main' }), false);
});

test('alreadyImported detects existing challonge match id', () => {
  const { alreadyImported } = loadChallongeHelpers();
  const state = [{ id: 1, _challongeMatchId: 555 }, { id: 2 }];
  assert.equal(alreadyImported(state, 555), true);
  assert.equal(alreadyImported(state, 999), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/challonge-import.test.js`
Expected: FAIL — helpers undefined.

- [ ] **Step 3: Extend the `CHALLONGE-HELPERS` block (before the END marker)**

```js
function matchTeamParticipant(rawName, teams) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  let hit = teams.find(t => t.teamName === name);
  if (hit) return hit;
  const lc = name.toLowerCase();
  return teams.find(t => (t.teamName || '').toLowerCase() === lc) || null;
}

function challongeRoundLabel(n) {
  return 'R' + Number(n);
}

function isSameOwnerSolo(p1Entry, p2Entry) {
  if (!p1Entry || !p2Entry) return false;
  return String(p1Entry.name || '').toLowerCase() === String(p2Entry.name || '').toLowerCase();
}

function alreadyImported(matchesState, challongeMatchId) {
  return (matchesState || []).some(m => m._challongeMatchId === challongeMatchId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/challonge-import.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/challonge-import.test.js
git commit -m "feat(challonge): team match, round label, same-owner, dedup helpers"
```

---

## Task 4: Pure helper — build the import plan from Challonge payloads

**Files:**
- Modify: `eventmanager.html` (CHALLONGE-HELPERS block)
- Test: `tests/challonge-import.test.js`

`buildImportPlan({ matches, pidMap, matchesState, isTeam })` turns raw Challonge
`matches.json` + a `participantId → rosterRef` map into a list of
`{ challongeMatchId, round, groupId, side1Ref, side2Ref, skip, reason }` decisions.
This is the heart of import, fully testable with no DOM/network.

- [ ] **Step 1: Write the failing test**

```js
test('buildImportPlan: imports open matches, skips non-open and duplicates', () => {
  const { buildImportPlan } = loadChallongeHelpers();
  const pidMap = {
    10: { name: 'Ken', entryId: 'eK', entryType: 'main' },
    11: { name: 'Mia', entryId: 'eM', entryType: 'main' },
    12: { name: 'Lienathan', entryId: 'eL1', entryType: 'main' },
    13: { name: 'Lienathan', entryId: 'eL2', entryType: 'double' },
  };
  const matches = [
    { match: { id: 100, state: 'open', round: 1, player1_id: 10, player2_id: 11, group_id: null } },
    { match: { id: 101, state: 'pending', round: 1, player1_id: null, player2_id: null } },
    { match: { id: 102, state: 'open', round: 1, player1_id: 12, player2_id: 13 } }, // same owner
    { match: { id: 103, state: 'open', round: 1, player1_id: 10, player2_id: 11 } }, // dup of existing
  ];
  const matchesState = [{ id: 9, _challongeMatchId: 103 }];
  const plan = buildImportPlan({ matches, pidMap, matchesState, isTeam: false });
  const create = plan.filter(p => !p.skip);
  assert.equal(create.length, 1);
  assert.equal(create[0].challongeMatchId, 100);
  assert.equal(create[0].round, 'R1');
  assert.equal(create[0].side1Ref.entryId, 'eK');
  // 101 skipped (not open), 102 skipped (same owner), 103 skipped (dup)
  assert.equal(plan.find(p => p.challongeMatchId === 102).reason, 'same-owner');
  assert.equal(plan.find(p => p.challongeMatchId === 103).reason, 'duplicate');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/challonge-import.test.js`
Expected: FAIL — `buildImportPlan` undefined.

- [ ] **Step 3: Add `buildImportPlan` to the CHALLONGE-HELPERS block**

```js
function buildImportPlan({ matches, pidMap, matchesState, isTeam }) {
  const plan = [];
  for (const entry of (matches || [])) {
    const m = entry.match || entry;
    const cmId = m.id;
    if (m.state !== 'open') { plan.push({ challongeMatchId: cmId, skip: true, reason: 'not-open' }); continue; }
    if (alreadyImported(matchesState, cmId)) { plan.push({ challongeMatchId: cmId, skip: true, reason: 'duplicate' }); continue; }
    const side1Ref = pidMap[m.player1_id] || null;
    const side2Ref = pidMap[m.player2_id] || null;
    const base = { challongeMatchId: cmId, round: challongeRoundLabel(m.round), groupId: m.group_id || null, side1Ref, side2Ref };
    if (!side1Ref || !side2Ref) { plan.push({ ...base, skip: false, reason: 'unmapped' }); continue; }
    if (!isTeam && isSameOwnerSolo(side1Ref, side2Ref)) { plan.push({ ...base, skip: true, reason: 'same-owner' }); continue; }
    plan.push({ ...base, skip: false, reason: 'create' });
  }
  return plan;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/challonge-import.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/challonge-import.test.js
git commit -m "feat(challonge): buildImportPlan decides create/skip per pairing"
```

---

## Task 5: Event data model + persistence for Challonge settings

**Files:**
- Modify: `eventmanager.html` — wherever `currentEvent` is saved (the event save path
  near `eventmanager.html:2581`, `updatedEvents = allEvents.map(...)`).

Persist the new fields so they survive reload and sync: `challongeAccount`,
`challongeCustomKey`, `challongeTournamentId`, `challongeParticipantMap`,
`challongeGroupMap`. No new test (these ride the existing event save). Verify by
reading the save payload builder.

- [ ] **Step 1: Locate the event-save serializer**

Read `eventmanager.html:2575-2600` and confirm `currentEvent` is saved wholesale
(object spread or direct assignment). If it is, **no field whitelist change is
needed** — arbitrary keys persist. If a field whitelist exists, add the five keys.

- [ ] **Step 2: Add a default initializer**

In the event-load path (near `eventmanager.html:2310`, where `buildsState`/
`resultsState` are hydrated), add:

```js
currentEvent.challongeAccount        = currentEvent.challongeAccount        || null;
currentEvent.challongeCustomKey      = currentEvent.challongeCustomKey      || null;
currentEvent.challongeTournamentId   = currentEvent.challongeTournamentId   || null;
currentEvent.challongeParticipantMap = currentEvent.challongeParticipantMap || {};
currentEvent.challongeGroupMap       = currentEvent.challongeGroupMap       || {};
```

- [ ] **Step 3: Manual verification**

Open eventmanager in a browser, select an event, run in console:
`currentEvent.challongeTournamentId = 'test123'; saveEvent();` then reload and confirm
`currentEvent.challongeTournamentId === 'test123'`. (Use the app's actual save fn name
found in Step 1.)

- [ ] **Step 4: Commit**

```bash
git add eventmanager.html
git commit -m "feat(challonge): persist per-event Challonge settings on the event record"
```

---

## Task 6: Settings tab UI — connect account + pick tournament

**Files:**
- Modify: `eventmanager.html` — add a "Challonge Sync" panel near the Match Results
  header (`eventmanager.html:1670-1702`) and supporting JS.

Build the panel: account `<select>` (named accounts), an optional custom-key
`<input>` (flagged), a **Connect** button that calls `/api/challonge?action=list`
(with `account`/`customKey` params) to populate a tournament `<select>`, a status
chip (`connected`/`error`), and a **Save link** that stores
`currentEvent.challongeTournamentId`.

- [ ] **Step 1: Add the panel markup**

Insert above the round-filter row (`eventmanager.html:1696`):

```html
<!-- Challonge Sync panel -->
<div id="challonge-sync-panel" style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:16px">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <strong style="color:var(--gold)">⚡ Challonge Sync</strong>
    <span id="challonge-conn-status" class="challonge-status" style="margin-left:auto">● Not connected</span>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:end">
    <label style="font-size:12px;color:var(--muted)">Account
      <select id="challonge-account-select" style="display:block"></select>
    </label>
    <label style="font-size:12px;color:var(--muted)">Custom key (optional, stored on event)
      <input id="challonge-custom-key" type="text" placeholder="paste API key" style="display:block">
    </label>
    <button class="btn" onclick="challongeConnect()">Connect</button>
    <label style="font-size:12px;color:var(--muted)">Tournament
      <select id="challonge-tournament-select" style="display:block"></select>
    </label>
    <button class="btn primary" onclick="challongeLinkTournament()">Link</button>
  </div>
</div>
```

- [ ] **Step 2: Add the named-account list + connect logic**

```js
const CHALLONGE_NAMED_ACCOUNTS = ['lienathanS2', 'lienathanS3']; // mirror env CHALLONGE_ACCOUNTS keys

function challongeAccountParams() {
  const account = document.getElementById('challonge-account-select').value || '';
  const customKey = document.getElementById('challonge-custom-key').value.trim();
  const qs = [];
  if (account) qs.push('account=' + encodeURIComponent(account));
  if (customKey) qs.push('customKey=' + encodeURIComponent(customKey));
  if (currentEvent && currentEvent.season) qs.push('season=' + encodeURIComponent(currentEvent.season));
  return qs.join('&');
}

function renderChallongeAccountOptions() {
  const sel = document.getElementById('challonge-account-select');
  sel.innerHTML = '<option value="">— pick account —</option>' +
    CHALLONGE_NAMED_ACCOUNTS.map(a => `<option value="${a}">${a}</option>`).join('');
  if (currentEvent && currentEvent.challongeAccount) sel.value = currentEvent.challongeAccount;
}

async function challongeConnect() {
  const status = document.getElementById('challonge-conn-status');
  status.textContent = '● Connecting…'; status.className = 'challonge-status';
  try {
    const res = await fetch('/api/challonge?action=list&' + challongeAccountParams());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    const tours = Array.isArray(data) ? data : (data.tournaments || data);
    const tsel = document.getElementById('challonge-tournament-select');
    tsel.innerHTML = '<option value="">— pick tournament —</option>' +
      (tours || []).map(t => {
        const tt = t.tournament || t;
        return `<option value="${tt.url || tt.id}">${tt.name} (${tt.url || tt.id})</option>`;
      }).join('');
    if (currentEvent && currentEvent.challongeTournamentId) tsel.value = currentEvent.challongeTournamentId;
    status.textContent = '● Connected'; status.className = 'challonge-status connected';
  } catch (e) {
    status.textContent = '● Error: ' + e.message; status.className = 'challonge-status error';
  }
}

function challongeLinkTournament() {
  const tid = document.getElementById('challonge-tournament-select').value;
  const account = document.getElementById('challonge-account-select').value || null;
  const customKey = document.getElementById('challonge-custom-key').value.trim() || null;
  if (!tid) { showToast('Pick a tournament first.', 'error'); return; }
  currentEvent.challongeTournamentId = tid;
  currentEvent.challongeAccount = account;
  currentEvent.challongeCustomKey = customKey;
  saveEvent(); // use the actual save fn confirmed in Task 5 Step 1
  showToast('⚡ Linked to Challonge tournament.', 'success');
  challongeBuildParticipantMap(); // Task 7
}
```

- [ ] **Step 3: Initialize the panel on event load**

In the event-load path (Task 5 Step 2 location), call `renderChallongeAccountOptions()`.

- [ ] **Step 4: Manual verification**

Open the app, select an event, pick an account, Connect → tournament dropdown
populates; Link → toast shows and `currentEvent.challongeTournamentId` is set.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html
git commit -m "feat(challonge): settings panel to connect account and link tournament"
```

---

## Task 7: Build participant map + one-time mapping screen

**Files:**
- Modify: `eventmanager.html` — `challongeBuildParticipantMap()` and a modal listing
  unmatched participants with roster dropdowns.

Fetch `action=participants`, auto-match each via `matchSoloParticipant` (solo) or
`matchTeamParticipant` (3v3), store resolved refs in
`currentEvent.challongeParticipantMap[participantId]`, and open a mapping modal for
the unmatched ones. Also fetch group data for 3v3 → `challongeGroupMap`.

- [ ] **Step 1: Add the map builder**

```js
async function challongeBuildParticipantMap() {
  if (!currentEvent || !currentEvent.challongeTournamentId) return;
  const isTeam = currentEvent.type === '3v3';
  const res = await fetch(
    '/api/challonge?action=participants&tournament_id=' +
    encodeURIComponent(currentEvent.challongeTournamentId) + '&' + challongeAccountParams()
  );
  const data = await res.json();
  const participants = (Array.isArray(data) ? data : []).map(p => p.participant || p);
  const players = isTeam ? null : getPlayers();
  const teams = isTeam ? (currentEvent.joiners || []).filter(j => j.type === 'team') : null;
  const map = currentEvent.challongeParticipantMap || {};
  const unmatched = [];
  for (const p of participants) {
    if (map[p.id]) continue; // keep prior manual resolutions
    const nm = p.display_name || p.name || '';
    const ref = isTeam ? matchTeamParticipant(nm, teams) : matchSoloParticipant(nm, players);
    if (ref) {
      map[p.id] = isTeam ? { teamName: ref.teamName } : { name: ref.name, entryId: ref.entryId, entryType: ref.entryType, displayLabel: ref.displayLabel };
    } else {
      unmatched.push({ id: p.id, name: nm });
    }
  }
  currentEvent.challongeParticipantMap = map;
  saveEvent();
  if (unmatched.length) openChallongeMappingModal(unmatched, isTeam);
  else showToast('✅ All ' + participants.length + ' participants mapped.', 'success');
}
```

- [ ] **Step 2: Add the mapping modal**

```js
function openChallongeMappingModal(unmatched, isTeam) {
  const options = isTeam
    ? (currentEvent.joiners || []).filter(j => j.type === 'team')
        .map(t => `<option value="${escHtml(t.teamName)}">${escHtml(t.teamName)}</option>`).join('')
    : getPlayers().map(p => `<option value="${escHtml(p.entryId || p.name)}">${escHtml(p.displayLabel || p.name)}</option>`).join('');
  const rows = unmatched.map(u => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <span style="flex:1">${escHtml(u.name)}</span>
      <select data-pid="${u.id}">${'<option value="">— pick —</option>' + options}</select>
    </div>`).join('');
  const wrap = document.createElement('div');
  wrap.id = 'challonge-mapping-modal';
  wrap.style = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:320;display:flex;align-items:center;justify-content:center';
  wrap.innerHTML = `<div style="background:var(--surface);padding:18px;border-radius:12px;max-width:480px;width:92%">
    <h3 style="color:var(--gold)">Map ${unmatched.length} unmatched participant(s)</h3>
    <div style="max-height:50vh;overflow:auto;margin:12px 0">${rows}</div>
    <button class="btn primary" onclick="challongeSaveMapping(${isTeam})" style="width:100%">Save mapping</button>
  </div>`;
  document.body.appendChild(wrap);
}

function challongeSaveMapping(isTeam) {
  const sels = document.querySelectorAll('#challonge-mapping-modal select[data-pid]');
  const map = currentEvent.challongeParticipantMap || {};
  sels.forEach(s => {
    const pid = s.dataset.pid; const val = s.value;
    if (!val) return;
    if (isTeam) { map[pid] = { teamName: val }; }
    else {
      const p = getPlayers().find(x => (x.entryId || x.name) === val);
      if (p) map[pid] = { name: p.name, entryId: p.entryId, entryType: p.entryType, displayLabel: p.displayLabel };
    }
  });
  currentEvent.challongeParticipantMap = map;
  saveEvent();
  document.getElementById('challonge-mapping-modal').remove();
  showToast('✅ Mapping saved.', 'success');
}
```

- [ ] **Step 3: Manual verification**

Link a test tournament whose participant names partly differ from the roster →
the modal shows only the mismatches; saving fills `challongeParticipantMap`.

- [ ] **Step 4: Commit**

```bash
git add eventmanager.html
git commit -m "feat(challonge): build participant map + one-time mapping modal"
```

---

## Task 8: Import engine — create cards through the existing match path

**Files:**
- Modify: `eventmanager.html` — `challongeImportOpenMatches()` consuming
  `buildImportPlan`, reusing `createMatch`'s persistence path.

For each non-skip plan item, build a match object the same shape `createMatch()`
pushes (`eventmanager.html:3543-3578`), set `_challongeMatchId`/`round`/`division`,
push to `matchesState`, then call the shared finalizers **once** at the end.

- [ ] **Step 1: Add the importer**

```js
async function challongeImportOpenMatches() {
  if (!currentEvent || !currentEvent.challongeTournamentId) return 0;
  const isTeam = currentEvent.type === '3v3';
  const res = await fetch(
    '/api/challonge?action=matches&tournament_id=' +
    encodeURIComponent(currentEvent.challongeTournamentId) + '&' + challongeAccountParams()
  );
  const matches = await res.json();
  const pidMap = {};
  Object.entries(currentEvent.challongeParticipantMap || {}).forEach(([pid, ref]) => { pidMap[pid] = ref; });
  const plan = buildImportPlan({ matches, pidMap, matchesState, isTeam });
  let created = 0;
  for (const item of plan) {
    if (item.skip) continue;
    const newId = _matchIdCounter++;
    if (isTeam) {
      const t1 = (currentEvent.joiners || []).find(j => j.type === 'team' && j.teamName === item.side1Ref.teamName);
      const t2 = (currentEvent.joiners || []).find(j => j.type === 'team' && j.teamName === item.side2Ref.teamName);
      if (!t1 || !t2) continue;
      matchesState.push({
        id: newId, _sid: _teamSid(item.round, t1.teamName, t2.teamName, 0),
        _pendingServerSave: true, _challongeMatchId: item.challongeMatchId,
        division: currentEvent.challongeGroupMap?.[item.groupId] || null,
        round: item.round, isTeamMatch: true,
        team1: JSON.parse(JSON.stringify(t1)), team2: JSON.parse(JSON.stringify(t2)),
        p1: { player: t1.teamName, builds: [] }, p2: { player: t2.teamName, builds: [] }, collapsed: false,
      });
    } else {
      const e1 = challongeEntryToMatchSlot(item.side1Ref);
      const e2 = challongeEntryToMatchSlot(item.side2Ref);
      if (!e1 || !e2) continue;
      matchesState.push({
        id: newId, _sid: _soloSid(item.round, e1, e2, 0),
        _pendingServerSave: true, _challongeMatchId: item.challongeMatchId,
        needsPlayerPick: item.reason === 'unmapped' || undefined,
        round: item.round, p1: e1, p2: e2, collapsed: false,
      });
    }
    created++;
  }
  if (created) { flattenMatchesToResults(); markDirty(); renderResults(); await queueCreatedMatchSave(); }
  return created;
}

function challongeEntryToMatchSlot(ref) {
  if (!ref) return null;
  const players = getPlayers();
  const full = players.find(p => ref.entryId ? p.entryId === ref.entryId : p.name === ref.name) || ref;
  return JSON.parse(JSON.stringify({
    player: full.name, entryId: full.entryId || null, entryType: full.entryType || 'main',
    displayLabel: full.displayLabel || full.name, builds: full.builds || [],
  }));
}
```

> **Note for implementer:** confirm the exact arg order of `_soloSid` / `_teamSid`
> against `eventmanager.html:3545` and `:3572` and the slot fields `createMatch`
> stores at `:3575-3577`. Match them exactly so sync dedup (`_sid`) behaves.

- [ ] **Step 2: Manual verification**

With a linked, mapped test tournament, run `await challongeImportOpenMatches()` in the
console → open-state matches appear as cards with correct players/decks; re-running
imports nothing new (dedup).

- [ ] **Step 3: Commit**

```bash
git add eventmanager.html
git commit -m "feat(challonge): import open matches as cards via shared match path"
```

---

## Task 9: Poll loop + manual Sync button

**Files:**
- Modify: `eventmanager.html` — a ~25s interval calling `challongeImportOpenMatches()`
  while linked, and a **Sync from Challonge** button next to **New Match**
  (`eventmanager.html:1680`).

- [ ] **Step 1: Add the manual button**

Next to the New Match button (`eventmanager.html:1680`):

```html
<button class="btn" onclick="challongeManualSync()" title="Pull new pairings from Challonge">🔄 Sync from Challonge</button>
```

- [ ] **Step 2: Add poll + manual handlers**

```js
let _challongePollTimer = null;
async function challongeManualSync() {
  try { const n = await challongeImportOpenMatches(); showToast(n ? `⚡ Imported ${n} match(es).` : 'No new matches.', n ? 'success' : ''); }
  catch (e) { showToast('Sync failed: ' + e.message, 'error'); }
}
function startChallongePoll() {
  if (_challongePollTimer) clearInterval(_challongePollTimer);
  _challongePollTimer = setInterval(() => {
    if (currentEvent && currentEvent.challongeTournamentId && navigator.onLine !== false) {
      challongeImportOpenMatches().catch(() => {});
    }
  }, 25000);
}
function stopChallongePoll() { if (_challongePollTimer) { clearInterval(_challongePollTimer); _challongePollTimer = null; } }
```

- [ ] **Step 3: Start/stop with event lifecycle**

Call `startChallongePoll()` in the event-load path (near Task 5 Step 2) and
`stopChallongePoll()` wherever the event is closed/deselected.

- [ ] **Step 4: Manual verification**

Link a tournament, start it in Challonge so R1 opens → within ~25s cards appear with
no tap; tapping 🔄 forces an immediate pull.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html
git commit -m "feat(challonge): background poll + manual sync button"
```

---

## Task 10: Find-my-match — division + round + name filter

**Files:**
- Modify: `eventmanager.html` — extend `renderRoundFilter()`/`renderResults()`
  (`eventmanager.html:3608-3617`, `:3816-3845`) with a name search box and (3v3)
  division pills.

- [ ] **Step 1: Add a name search input above the cards**

Insert above `#round-filter-row` (`eventmanager.html:1696`):

```html
<input id="match-search" type="text" placeholder="🔍 Search player / team…" oninput="renderResults()"
       style="width:100%;padding:8px;margin-bottom:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)">
```

- [ ] **Step 2: Apply the filters in `renderResults()`**

At the top of `renderResults()` (`eventmanager.html:3820`), after computing
`filtered` by round, add:

```js
const q = (document.getElementById('match-search')?.value || '').trim().toLowerCase();
let filtered2 = filtered;
if (q) {
  filtered2 = filtered2.filter(m => {
    const names = [
      m.p1?.displayLabel, m.p1?.player, m.p2?.displayLabel, m.p2?.player,
      m.team1?.teamName, m.team2?.teamName,
    ].filter(Boolean).join(' ').toLowerCase();
    return names.includes(q);
  });
}
if (activeDivisionFilter && activeDivisionFilter !== 'ALL') {
  filtered2 = filtered2.filter(m => (m.division || null) === activeDivisionFilter);
}
```

Then use `filtered2` instead of `filtered` for the empty-check and the card render.

- [ ] **Step 3: Add division pills for 3v3**

Add `let activeDivisionFilter = 'ALL';` near `activeRoundFilter`, a
`setDivisionFilter(d){ activeDivisionFilter = d; renderResults(); }`, and in
`renderRoundFilter()` render one pill per unique `m.division` (only when the event is
3v3 and any division exists), styled like the round pills.

- [ ] **Step 4: Manual verification**

With imported matches, type a name → list narrows to that player; for a 3v3 group
stage, division pills appear and filter to one group.

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html
git commit -m "feat(challonge): division + round + name filter for the match list"
```

---

## Task 11: Regression sweep + final commit

- [ ] **Step 1:** Run the full test suite.

Run: `node --test tests/`
Expected: all existing + new tests PASS.

- [ ] **Step 2:** Manual end-to-end on a test tournament — link, map, start R1 in
Challonge, confirm auto-import, score a match locally, confirm the card edits and the
existing live-sync still propagate to a second browser.

- [ ] **Step 3:** Commit any fixes.

```bash
git add -A
git commit -m "test(challonge): regression sweep for Phase 1 import"
```

---

## Phase 2 (separate plan, deferred): score write-back to Challonge

**Why deferred:** the live `/api/challonge` proxy is **GET-only**, and the actual
write target is an **external Vercel proxy** we don't control in this repo. Phase 2
cannot be coded until we confirm that proxy will forward a Challonge
`PUT .../matches/{id}.json`. **First step of the Phase 2 plan is to verify/obtain
write access**, then:

1. Add `action=report` (PUT) to `functions/api/challonge.js` using `target.key`.
2. Add a pure helper `eventPointsToScoresCsv(p1pts, p2pts)` → `"<hi>-<lo>"` + winner
   participant id (TDD, same harness).
3. Hook `lmCommitAndClose()` (`eventmanager.html:5678`) + the auto-submit commit to
   call the report endpoint with the match's `_challongeMatchId`.
4. Per-card status chip: `_challongePushState` → `✓ pushed` / `⚠ retry`; retry on the
   next poll.
5. Live closed-loop check: score → Challonge completes the match → next round
   generates → Phase 1 auto-imports it.

---

## Self-Review (completed)

- **Spec coverage:** Settings tab + hybrid keys (Tasks 1, 6) · map-once incl. DE rule
  (Tasks 2, 7) · 3v3 team mapping (Tasks 3, 7, 8) · auto-poll + manual sync (Task 9) ·
  import/dedup/round-map/same-owner skip (Tasks 3, 4, 8) · division/round/name filter
  (Task 10) · write-back (deferred Phase 2). ✔ All Phase 1 spec items mapped.
- **Placeholder scan:** no TBD/TODO; every code step has concrete code. The two
  "confirm exact signature" notes (Tasks 5, 8) point at specific existing lines to
  match, not vague instructions.
- **Type consistency:** `challongeParticipantMap[pid]` shape `{ name, entryId,
  entryType, displayLabel }` (solo) / `{ teamName }` (3v3) is produced in Task 7 and
  consumed identically in Task 8. `_challongeMatchId`, `division`, `round` names match
  across Tasks 3, 4, 8, 10.
