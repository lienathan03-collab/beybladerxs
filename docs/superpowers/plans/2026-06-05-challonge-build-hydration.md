# Challonge Build Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every normal match slot (solo, DE, and team) carry the player's submitted Bey builds, whether builds are submitted before or after a Challonge sync, without ever destroying recorded scoring state.

**Architecture:** Introduce one pure helper, `reconcileMatchSlotBuilds(slot, submittedBuildNames)`, that reconciles a match slot's per-build scoring objects against a player's submitted build *names* by slot index — creating missing build objects, renaming existing ones, preserving `finishes`/`deployed`/`win`, and trimming only unscored trailing extras. Route the broken Challonge-import path, the build-submission path, and the (already-working) manual creation paths through this single helper so build hydration has exactly one source of truth.

**Tech Stack:** Vanilla JS embedded in `eventmanager.html`; `node:test` + `node:vm` unit tests that extract function source between comment markers.

## Post-Implementation Review Amendments

The final reviewed implementation includes two safeguards beyond the original task plan:

- Reconciliation matches existing scoring objects by exact build identity before using slot-index fallback for true renames. This prevents interior blank submissions from moving finishes onto the wrong build or creating duplicates.
- `submitBuilds()` captures an immutable pre-fetch build snapshot, then restores and reapplies it after merging the latest server state. A stale server response therefore cannot overwrite names the admin just submitted.

---

## Root-Cause Analysis

`buildsState[key]` is a **flat array of build-name strings** (padded to 3, may contain `''`), keyed by `entryId` for solo entries and by player name for team members. A match slot's `builds` is a **different shape**: an array of `{ build, finishes:[], deployed:false }` scoring objects. Build *names* live in `buildsState`; *scoring state* lives in the match slot. The two are bridged at slot-creation time.

**Bug A — import path never hydrates ([eventmanager.html:3712-3723](../../../eventmanager.html#L3712)).**
`challongeEntryToMatchSlot()` builds the slot with `builds: full.builds || []`, where `full` comes from `getPlayers()`. But `getPlayers()` ([eventmanager.html:2495-2520](../../../eventmanager.html#L2495)) returns `{ name, displayLabel, entryId, entryType, team }` — it **never attaches `builds`**. So `full.builds` is always `undefined` → `[]`. Every imported solo slot is empty. The working manual path `nmSelectPlayer()` ([eventmanager.html:4254-4261](../../../eventmanager.html#L4254)) instead reads `buildsState[slotKey(p)]` and maps to `{ build, finishes:[], deployed:false }`. This is the "builds first, then sync → empty arrays" failure.

**Bug B — submit can rename but never create ([eventmanager.html:3014-3072](../../../eventmanager.html#L3014)).**
`submitBuilds()` iterates `m[side].builds.forEach(...)` / `member.builds.forEach(...)` to copy renamed names into matches. When a slot's `builds` is `[]` (e.g. imported empty, or the player had no builds when the match was created), the `forEach` body never runs, so no build objects are ever created. This is the "sync first, then submit builds → still empty" failure.

**Bug C — team import copies un-hydrated joiner members ([eventmanager.html:3742-3762](../../../eventmanager.html#L3742)).**
The team branch deep-copies the raw joiner: `team1: JSON.parse(JSON.stringify(t1))`. Joiner members are `{ displayName }` only (created at [eventmanager.html:2796](../../../eventmanager.html#L2796)) — no `player` field, no `builds`. The manual team path `nmSelectTeam()` ([eventmanager.html:4097-4100](../../../eventmanager.html#L4097)) maps members to `{ player, builds:[…] }` hydrated from `buildsState`. The import path skips that mapping entirely.

**Load / flatten / merge are NOT the culprits.** `flattenMatchesToResults()` ([eventmanager.html:3278-3279](../../../eventmanager.html#L3278)) persists whatever `m.p1.builds` holds; `loadMatchesFromResults()` ([eventmanager.html:3233-3234](../../../eventmanager.html#L3233)) and `mergeIncomingMatches()` ([eventmanager.html:7536-7537](../../../eventmanager.html#L7536)) restore `builds: p1.builds || []` from server rows. They faithfully round-trip whatever was written. Once Bugs A–C write correct builds, these paths preserve them. The dirty-branch build merge ([eventmanager.html:7626](../../../eventmanager.html#L7626)) only updates `buildsState` (names), never wipes match slots. **Therefore the fix is confined to slot creation (import + manual) and build submission. We add a regression test proving the load/merge paths preserve hydrated builds, but change no code there.**

## Data-Authority Rules

- **Build names** are owned by `buildsState[key]`. Resolution key: `slot.entryId || playerKey(slot.player)` for solo/DE slots; `playerKey(member.player)` for team members. Main vs. DE entries with the same name resolve to **different `entryId` keys**, so their builds never mix.
- **Scoring state** (`finishes`, `deployed`, `win`, `dePoints`, `submitted`, `_sid`, `_challonge*`, `division`) is owned by the match slot / match object. `reconcileMatchSlotBuilds` **only** ever writes `slot.builds[i].build` (rename) or pushes a fresh `{ build, finishes:[], deployed:false }` (create). It never touches scoring fields.
- **Server rows** remain authoritative for the submitted result payload on the non-dirty full-replace path (unchanged). Reconciliation is applied at creation and submission only — never inside load/merge — so server-recorded finishes are never overwritten by a name-only source.
- **Blank handling:** reconciliation indexes against the **non-blank** name list (`names.filter(n => n.trim() !== '')`), matching how `nmSelectPlayer`/`nmSelectTeam` already `.filter(Boolean)` before creating slots. Interior padding blanks in `buildsState` are ignored.
- **Shrink/remove behavior (confirmed):** *preserve recorded results*. When the submitted list is shorter than the slot's `builds`, trim trailing extras from the end **only while they carry no recorded results**; stop at the first extra that has `finishes.length` or `deployed === true` (keep it and everything before it). A removed build that was never scored disappears; a removed build that already has finishes is retained so no recorded data is silently lost.

## Risks & Edge Cases

- **Indexing change in `submitBuilds`.** The current rename loops index `buildsState[key]` *unfiltered*; the helper indexes the *filtered* list. For build lists with interior blanks this changes which name lands on which slot — but the new behavior matches `nmSelectPlayer` (the creation source of truth), so it is a correctness fix, not a regression. Covered by an explicit interior-blank test.
- **Idempotency.** Repeated sync + submit must not duplicate build objects. The helper writes by index and only pushes when `slot.builds[i]` is absent, so re-running is a no-op for already-correct slots. Explicitly tested.
- **DE self-matches.** These remain no-stats (`_deSelfMatch`/`_noStats` unchanged) but still carry mapped build data — the established model (manual DE self-matches built via `nmSelectPlayer` already hold builds). Reconciliation treats their slots like any normal slot; only `flatten`'s `_noStats`/`dePoints` handling marks them no-stats. No change there.
- **Team member key has no `entryId`.** Team members resolve by `playerKey(member.player)` (name). This is unchanged from `submitBuilds`/`nmSelectTeam` today.
- **`submitBuilds` is DOM/fetch-heavy** and not directly unit-testable. We extract its inner reconciliation into a pure, testable `applySubmittedBuildsToMatches()` that operates on the `matchesState`/`buildsState` globals, and `submitBuilds` calls it. Manual DOM paths (`nmSelectPlayer`/`nmSelectTeam`) are routed through the helper but verified via the helper's own unit tests plus a manual-verification checklist step, since they require a DOM.

## Files

- **Modify** `eventmanager.html`:
  - Add `reconcileMatchSlotBuilds` inside a new `// === BUILD-RECONCILE START/END ===` marker block (placed just before `challongeEntryToMatchSlot`, ~line 3712).
  - Add `applySubmittedBuildsToMatches` inside a new `// === SUBMIT-APPLY START/END ===` marker block (placed just before `submitBuilds`, ~line 3004).
  - Rewrite `challongeEntryToMatchSlot` ([3712-3723](../../../eventmanager.html#L3712)) to hydrate via the helper.
  - Rewrite the team branch of `challongeImportOpenMatches` ([3742-3762](../../../eventmanager.html#L3742)) to hydrate members via the helper.
  - Replace the two inline rename loops in `submitBuilds` ([3014-3040](../../../eventmanager.html#L3014) and [3050-3072](../../../eventmanager.html#L3050)) with calls to `applySubmittedBuildsToMatches`.
  - Route `nmSelectPlayer` ([4254-4261](../../../eventmanager.html#L4254)) and `nmSelectTeam` ([4097-4100](../../../eventmanager.html#L4097)) member hydration through the helper.
- **Create** `tests/challonge-build-hydration.test.js`: unit tests for the helper, the import slot, the submit-apply pass, and a load/flatten round-trip.

Run the full suite after every task with:

```
node --test "tests/*.test.js"
```

Baseline before any change: **105 passing, 0 failing.**

---

### Task 1: `reconcileMatchSlotBuilds` helper

**Files:**
- Modify: `eventmanager.html` (add BUILD-RECONCILE marker block before `function challongeEntryToMatchSlot`, ~line 3712)
- Test: `tests/challonge-build-hydration.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/challonge-build-hydration.test.js` with:

```js
// tests/challonge-build-hydration.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function sliceBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  const end = html.indexOf(endNeedle, start);
  assert.notEqual(start, -1, `Missing source marker: ${startNeedle}`);
  assert.notEqual(end, -1, `Missing source marker: ${endNeedle}`);
  return html.slice(start, end);
}

function loadReconcile() {
  const ctx = { JSON, Array };
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  return ctx.reconcileMatchSlotBuilds;
}

test('reconcile: creates build objects on an empty slot from submitted names', () => {
  const reconcile = loadReconcile();
  const slot = { player: 'Ken', builds: [] };
  reconcile(slot, ['Dragoon', 'Dranzer', 'Draciel']);
  assert.equal(slot.builds.length, 3);
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer', 'Draciel']);
  assert.deepEqual(slot.builds[0], { build: 'Dragoon', finishes: [], deployed: false });
});

test('reconcile: renames existing build by slot index, preserving finishes & deployed', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [
    { build: 'OldA', finishes: ['S', 'O'], deployed: true },
    { build: 'OldB', finishes: ['L'], deployed: false },
  ] };
  reconcile(slot, ['NewA', 'NewB']);
  assert.equal(slot.builds.length, 2);
  assert.deepEqual(slot.builds[0], { build: 'NewA', finishes: ['S', 'O'], deployed: true });
  assert.deepEqual(slot.builds[1], { build: 'NewB', finishes: ['L'], deployed: false });
});

test('reconcile: ignores interior blank / padding names (filtered indexing)', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [] };
  reconcile(slot, ['Dragoon', '', '  ', 'Dranzer']);
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
});

test('reconcile: trims trailing UNSCORED extras but KEEPS scored extras (preserve results)', () => {
  const reconcile = loadReconcile();
  // names shrink from 3 -> 1; slot[1] has finishes (scored), slot[2] is unscored
  const slot = { builds: [
    { build: 'A', finishes: [], deployed: false },
    { build: 'B', finishes: ['O'], deployed: false }, // recorded result
    { build: 'C', finishes: [], deployed: false },     // unscored trailing
  ] };
  reconcile(slot, ['A']);
  // C (unscored, trailing) dropped; B (scored) retained; A renamed/kept
  assert.equal(slot.builds.length, 2);
  assert.deepEqual(slot.builds.map(b => b.build), ['A', 'B']);
  assert.deepEqual(slot.builds[1].finishes, ['O']);
});

test('reconcile: deployed-only trailing extra is preserved', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [
    { build: 'A', finishes: [], deployed: false },
    { build: 'B', finishes: [], deployed: true }, // deployed but no finishes
  ] };
  reconcile(slot, ['A']);
  assert.equal(slot.builds.length, 2);
  assert.equal(slot.builds[1].deployed, true);
});

test('reconcile: idempotent — repeated calls create no duplicates', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [] };
  reconcile(slot, ['Dragoon', 'Dranzer']);
  reconcile(slot, ['Dragoon', 'Dranzer']);
  reconcile(slot, ['Dragoon', 'Dranzer']);
  assert.equal(slot.builds.length, 2);
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
});

test('reconcile: empty submitted list leaves an empty slot empty', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [] };
  reconcile(slot, []);
  assert.deepEqual(slot.builds, []);
});

test('reconcile: missing builds array is initialised', () => {
  const reconcile = loadReconcile();
  const slot = { player: 'Ken' };
  reconcile(slot, ['Dragoon']);
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: FAIL — `Missing source marker: // === BUILD-RECONCILE START ===` (the marker block does not exist yet).

- [ ] **Step 3: Add the helper**

In `eventmanager.html`, immediately before `function challongeEntryToMatchSlot(ref) {` (~line 3712), insert:

```js
// === BUILD-RECONCILE START ===
// Single source of truth for populating a match slot's per-build scoring objects
// from a player's submitted build NAMES.
//   slot                : { builds: [{ build, finishes, deployed, ... }] }  (mutated in place)
//   submittedBuildNames : flat array of name strings from buildsState[key]
//                         (may contain '' / whitespace padding — ignored)
// Reconciles by slot index against the NON-BLANK name list:
//   - existing slot i -> rename: slot.builds[i].build = names[i]  (finishes/deployed/win preserved)
//   - missing  slot i -> create: push { build: names[i], finishes: [], deployed: false }
//   - extra trailing builds beyond names -> drop from the end ONLY while unscored;
//     stop at the first extra carrying recorded results (finishes.length or deployed).
// Never writes any scoring field. Returns the slot for chaining.
function reconcileMatchSlotBuilds(slot, submittedBuildNames) {
  if (!slot) return slot;
  if (!Array.isArray(slot.builds)) slot.builds = [];
  const names = (submittedBuildNames || []).filter(
    n => typeof n === 'string' && n.trim() !== ''
  );
  for (let i = 0; i < names.length; i++) {
    if (slot.builds[i]) {
      slot.builds[i].build = names[i];
    } else {
      slot.builds[i] = { build: names[i], finishes: [], deployed: false };
    }
  }
  // Preserve recorded results: trim trailing extras only while they are unscored.
  for (let i = slot.builds.length - 1; i >= names.length; i--) {
    const extra = slot.builds[i];
    const hasResults = !!(extra && (((extra.finishes || []).length) || extra.deployed));
    if (hasResults) break;
    slot.builds.pop();
  }
  return slot;
}
// === BUILD-RECONCILE END ===
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full suite**

Run: `node --test "tests/*.test.js"`
Expected: PASS — 105 prior + 8 new = 113 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add eventmanager.html tests/challonge-build-hydration.test.js
git commit -m "feat: reconcileMatchSlotBuilds helper for slot build hydration"
```

---

### Task 2: Hydrate solo Challonge-import slots (`challongeEntryToMatchSlot`)

**Files:**
- Modify: `eventmanager.html:3712-3723` (`challongeEntryToMatchSlot`)
- Test: `tests/challonge-build-hydration.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/challonge-build-hydration.test.js`:

```js
function loadChallongeSlot(ctxExtras) {
  const ctx = Object.assign({ JSON, Array }, ctxExtras);
  vm.createContext(ctx);
  // reconcile helper first (challongeEntryToMatchSlot depends on it)
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  vm.runInContext(
    sliceBetween('function challongeEntryToMatchSlot(ref)', 'async function challongeImportOpenMatches'),
    ctx
  );
  return ctx;
}

test('challongeEntryToMatchSlot: builds submitted BEFORE sync hydrate the slot by entryId', () => {
  const ctx = loadChallongeSlot({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['Dragoon', 'Dranzer', 'Draciel'] },
    getPlayers: () => [
      { name: 'Ken', displayLabel: 'Ken', entryId: 'e-ken', entryType: 'main' },
    ],
  });
  const slot = vm.runInContext(
    `challongeEntryToMatchSlot({ entryId: 'e-ken', name: 'Ken' })`, ctx
  );
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer', 'Draciel']);
  assert.deepEqual(slot.builds[0], { build: 'Dragoon', finishes: [], deployed: false });
  assert.equal(slot.entryId, 'e-ken');
  assert.equal(slot.player, 'Ken');
});

test('challongeEntryToMatchSlot: main vs DE same name resolve by SEPARATE entryId keys', () => {
  const ctx = loadChallongeSlot({
    playerKey: (name) => name,
    buildsState: {
      'e-lien-1': ['MainA', 'MainB'],
      'e-lien-2': ['DeA', 'DeB'],
    },
    getPlayers: () => [
      { name: 'Lienathan', displayLabel: 'Lienathan 1', entryId: 'e-lien-1', entryType: 'main' },
      { name: 'Lienathan', displayLabel: 'Lienathan 2', entryId: 'e-lien-2', entryType: 'double' },
    ],
  });
  const main = vm.runInContext(`challongeEntryToMatchSlot({ entryId: 'e-lien-1', name: 'Lienathan' })`, ctx);
  const de   = vm.runInContext(`challongeEntryToMatchSlot({ entryId: 'e-lien-2', name: 'Lienathan' })`, ctx);
  assert.deepEqual(main.builds.map(b => b.build), ['MainA', 'MainB']);
  assert.deepEqual(de.builds.map(b => b.build), ['DeA', 'DeB']);
});

test('challongeEntryToMatchSlot: no submitted builds yields an empty (not undefined) builds array', () => {
  const ctx = loadChallongeSlot({
    playerKey: (name) => name,
    buildsState: {},
    getPlayers: () => [{ name: 'Mia', displayLabel: 'Mia', entryId: 'e-mia', entryType: 'main' }],
  });
  const slot = vm.runInContext(`challongeEntryToMatchSlot({ entryId: 'e-mia', name: 'Mia' })`, ctx);
  assert.deepEqual(slot.builds, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: FAIL — the two hydration tests fail with `slot.builds` empty (`[]`), because the current `challongeEntryToMatchSlot` reads `full.builds` which is `undefined`. (The third test already passes.)

- [ ] **Step 3: Rewrite `challongeEntryToMatchSlot`**

Replace `eventmanager.html:3712-3723` with:

```js
function challongeEntryToMatchSlot(ref) {
  if (!ref) return null;
  const players = getPlayers();
  const full = players.find(p => ref.entryId ? p.entryId === ref.entryId : p.name === ref.name) || ref;
  const name = full.name || full.player || '';
  const key = full.entryId || playerKey(name);
  const slot = {
    player: name,
    entryId: full.entryId || null,
    entryType: full.entryType || 'main',
    displayLabel: full.displayLabel || name,
    builds: [],
  };
  reconcileMatchSlotBuilds(slot, buildsState[key] || []);
  return JSON.parse(JSON.stringify(slot));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: PASS (3 new tests for this task, plus Task 1's 8).

- [ ] **Step 5: Run the full suite**

Run: `node --test "tests/*.test.js"`
Expected: PASS — 116 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add eventmanager.html tests/challonge-build-hydration.test.js
git commit -m "fix: hydrate solo Challonge-import slots from buildsState (Bug A)"
```

---

### Task 3: Submit-build reconciliation pass (`applySubmittedBuildsToMatches` + `submitBuilds`)

This fixes "sync first, then submit builds" (Bug B). We extract the reconciliation into a pure, testable function and call it from `submitBuilds`.

**Files:**
- Modify: `eventmanager.html` (add SUBMIT-APPLY marker block before `submitBuilds`, ~line 3004)
- Modify: `eventmanager.html:3014-3040` and `eventmanager.html:3050-3072` (`submitBuilds` inline loops)
- Test: `tests/challonge-build-hydration.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/challonge-build-hydration.test.js`:

```js
function loadSubmitApply(ctxExtras) {
  const ctx = Object.assign({ JSON, Array, Object }, ctxExtras);
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  vm.runInContext(
    sliceBetween('// === SUBMIT-APPLY START ===', '// === SUBMIT-APPLY END ==='),
    ctx
  );
  return ctx;
}

test('applySubmittedBuildsToMatches: populates a previously EMPTY solo slot (sync-before-submit)', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['Dragoon', 'Dranzer'], 'e-mia': ['Driger'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Ken', entryId: 'e-ken', builds: [] }, // imported empty
      p2: { player: 'Mia', entryId: 'e-mia', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].p1.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
  assert.deepEqual(ctx.matchesState[0].p2.builds.map(b => b.build), ['Driger']);
});

test('applySubmittedBuildsToMatches: renames existing builds, preserving finishes/deployed', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['NewA', 'NewB'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Ken', entryId: 'e-ken', builds: [
        { build: 'OldA', finishes: ['S'], deployed: true },
        { build: 'OldB', finishes: [], deployed: false },
      ] },
      p2: { player: 'Mia', entryId: 'e-mia', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].p1.builds[0], { build: 'NewA', finishes: ['S'], deployed: true });
  assert.equal(ctx.matchesState[0].p1.builds[1].build, 'NewB');
});

test('applySubmittedBuildsToMatches: solo slot keyed by entryId, not name', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    // Same display name, different entryId -> must not mix
    buildsState: { 'e-lien-1': ['MainA'], 'e-lien-2': ['DeA'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Lienathan', entryId: 'e-lien-1', builds: [] },
      p2: { player: 'Lienathan', entryId: 'e-lien-2', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].p1.builds.map(b => b.build), ['MainA']);
  assert.deepEqual(ctx.matchesState[0].p2.builds.map(b => b.build), ['DeA']);
});

test('applySubmittedBuildsToMatches: team members receive their submitted builds (keyed by name)', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'Alice': ['A1', 'A2'], 'Bob': ['B1'] },
    matchesState: [{
      round: 'R1', isTeamMatch: true,
      team1: { teamName: 'T1', members: [{ player: 'Alice', builds: [] }] },
      team2: { teamName: 'T2', members: [{ player: 'Bob', builds: [] }] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].team1.members[0].builds.map(b => b.build), ['A1', 'A2']);
  assert.deepEqual(ctx.matchesState[0].team2.members[0].builds.map(b => b.build), ['B1']);
});

test('applySubmittedBuildsToMatches: idempotent across repeated submit passes', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['Dragoon', 'Dranzer'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Ken', entryId: 'e-ken', builds: [] },
      p2: { player: 'Mia', entryId: 'e-mia', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.equal(ctx.matchesState[0].p1.builds.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: FAIL — `Missing source marker: // === SUBMIT-APPLY START ===`.

- [ ] **Step 3: Add `applySubmittedBuildsToMatches`**

In `eventmanager.html`, immediately before `async function submitBuilds() {` (~line 3004), insert:

```js
// === SUBMIT-APPLY START ===
// Copy submitted build NAMES into every match slot, creating missing build
// objects and renaming existing ones while preserving scoring state. Operates
// on the matchesState / buildsState globals. Solo slots key by entryId
// (falling back to name); team members key by name.
function applySubmittedBuildsToMatches() {
  for (const m of matchesState) {
    if (m.isTeamMatch) {
      for (const teamKey of ['team1', 'team2']) {
        if (!m[teamKey]) continue;
        for (const member of m[teamKey].members) {
          reconcileMatchSlotBuilds(member, buildsState[playerKey(member.player)] || []);
        }
      }
    } else {
      for (const side of ['p1', 'p2']) {
        if (!m[side]) continue;
        const key = m[side].entryId || playerKey(m[side].player);
        reconcileMatchSlotBuilds(m[side], buildsState[key] || []);
      }
    }
  }
}
// === SUBMIT-APPLY END ===
```

- [ ] **Step 4: Replace the first inline loop in `submitBuilds`**

Replace `eventmanager.html:3014-3040` (the `for (const m of matchesState) { … }` block that ends just before `flattenMatchesToResults();`) with:

```js
    // Propagate submitted build names into all existing matches by slot index.
    // Creates missing build objects (e.g. Challonge-imported empty slots) and
    // renames existing ones; finishes/deployed/win are preserved.
    applySubmittedBuildsToMatches();
```

- [ ] **Step 5: Replace the post-merge inline loop in `submitBuilds`**

Replace `eventmanager.html:3050-3072` (the second `for (const m of matchesState) { … }` block, between `mergeIncomingMatches(...)` and the following `flattenMatchesToResults();`) with:

```js
      // Re-apply after merge (merge may have overwritten local slot data).
      applySubmittedBuildsToMatches();
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: PASS (5 new tests for this task).

- [ ] **Step 7: Run the full suite**

Run: `node --test "tests/*.test.js"`
Expected: PASS — 121 passing, 0 failing.

- [ ] **Step 8: Commit**

```bash
git add eventmanager.html tests/challonge-build-hydration.test.js
git commit -m "fix: submitBuilds creates missing match build slots via reconcile (Bug B)"
```

---

### Task 4: Hydrate team Challonge-import members (`challongeImportOpenMatches` team branch)

This fixes Bug C. The team import currently deep-copies raw joiners whose members lack `player`/`builds`.

**Files:**
- Modify: `eventmanager.html:3742-3762` (team branch of `challongeImportOpenMatches`)
- Test: covered by Task 3's team test plus a focused conversion test below.

- [ ] **Step 1: Write the failing test**

Append to `tests/challonge-build-hydration.test.js`:

```js
// The team-import conversion mirrors nmSelectTeam: each joiner member
// { displayName } becomes { player, builds:[…] } hydrated from buildsState by name.
function loadTeamConvert(ctxExtras) {
  const ctx = Object.assign({ JSON, Array }, ctxExtras);
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  vm.runInContext(
    sliceBetween('function challongeJoinerTeamToMatchTeam(joiner)', '// === TEAM-CONVERT END ==='),
    ctx
  );
  return ctx;
}

test('challongeJoinerTeamToMatchTeam: maps joiner members to hydrated {player, builds}', () => {
  const ctx = loadTeamConvert({
    playerKey: (name) => name,
    buildsState: { 'Alice': ['A1', 'A2'], 'Bob': ['B1'] },
  });
  const team = vm.runInContext(
    `challongeJoinerTeamToMatchTeam({ teamName: 'Dragons', members: [{ displayName: 'Alice' }, { displayName: 'Bob' }] })`,
    ctx
  );
  assert.equal(team.teamName, 'Dragons');
  assert.equal(team.members.length, 2);
  assert.equal(team.members[0].player, 'Alice');
  assert.deepEqual(team.members[0].builds.map(b => b.build), ['A1', 'A2']);
  assert.deepEqual(team.members[1].builds.map(b => b.build), ['B1']);
});

test('challongeJoinerTeamToMatchTeam: string members and missing builds are handled', () => {
  const ctx = loadTeamConvert({ playerKey: (name) => name, buildsState: {} });
  const team = vm.runInContext(
    `challongeJoinerTeamToMatchTeam({ teamName: 'X', members: ['Solo'] })`, ctx
  );
  assert.equal(team.members[0].player, 'Solo');
  assert.deepEqual(team.members[0].builds, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: FAIL — `Missing source marker: function challongeJoinerTeamToMatchTeam(joiner)`.

- [ ] **Step 3: Add the team-conversion helper**

In `eventmanager.html`, immediately before `async function challongeImportOpenMatches() {` (~line 3725), insert:

```js
// === TEAM-CONVERT START ===
// Convert a roster joiner (team) into a match team with hydrated member builds.
// Joiner members are { displayName } (or bare strings); match members need
// { player, builds:[{build,finishes,deployed}] } keyed by name from buildsState.
function challongeJoinerTeamToMatchTeam(joiner) {
  const members = (joiner.members || []).map(m => {
    const name = (typeof m === 'object') ? (m.displayName || m.player || '') : m;
    const slot = { player: name, builds: [] };
    reconcileMatchSlotBuilds(slot, buildsState[playerKey(name)] || []);
    return slot;
  });
  return { teamName: joiner.teamName, members };
}
// === TEAM-CONVERT END ===
```

- [ ] **Step 4: Rewrite the team branch of `challongeImportOpenMatches`**

Replace `eventmanager.html:3749-3762` (the `matchesState.push({ … })` block inside `if (isTeam) { … }`) with:

```js
        const mt1 = challongeJoinerTeamToMatchTeam(t1);
        const mt2 = challongeJoinerTeamToMatchTeam(t2);
        matchesState.push({
          id: _matchIdCounter++,
          _sid: _teamSid(item.round, t1.teamName, t2.teamName, teamPairCount),
          _pendingServerSave: true,
          _challongeMatchId: item.challongeMatchId,
          division: currentEvent.challongeGroupMap?.[item.groupId] ?? null,
          round: item.round,
          isTeamMatch: true,
          team1: mt1,
          team2: mt2,
          p1: JSON.parse(JSON.stringify(mt1.members[0] || { player: t1.teamName, builds: [] })),
          p2: JSON.parse(JSON.stringify(mt2.members[0] || { player: t2.teamName, builds: [] })),
          collapsed: false,
        });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: PASS (2 new tests).

- [ ] **Step 6: Run the full suite**

Run: `node --test "tests/*.test.js"`
Expected: PASS — 123 passing, 0 failing.

- [ ] **Step 7: Commit**

```bash
git add eventmanager.html tests/challonge-build-hydration.test.js
git commit -m "fix: hydrate team Challonge-import members from buildsState (Bug C)"
```

---

### Task 5: Route manual creation paths through the helper (single source of truth)

`nmSelectPlayer` and `nmSelectTeam` already hydrate correctly but with bespoke inline code. Route them through `reconcileMatchSlotBuilds` so there is exactly one hydration algorithm. These functions touch the DOM and are verified by the helper's unit tests plus the manual-verification step; no new automated test is added (a DOM harness is out of scope and would not increase confidence beyond Task 1).

**Files:**
- Modify: `eventmanager.html:4254-4261` (`nmSelectPlayer`)
- Modify: `eventmanager.html:4097-4100` (`nmSelectTeam`)

- [ ] **Step 1: Reroute `nmSelectPlayer` hydration**

Replace `eventmanager.html:4254-4261` (the `const builds = …` line through the `const playerData = { … };` object) with:

```js
  const playerData = {
    player: p.name,
    entryId: p.entryId || null,
    entryType: p.entryType || 'main',
    displayLabel: p.displayLabel || p.name,
    builds: []
  };
  reconcileMatchSlotBuilds(playerData, buildsState[slotKey(p)] || []);
  const builds = playerData.builds.map(b => b.build);
```

(`builds` is still used below for the preview text at [eventmanager.html:4270-4271](../../../eventmanager.html#L4270); deriving it from `playerData.builds` keeps that unchanged.)

- [ ] **Step 2: Reroute `nmSelectTeam` member hydration**

Replace `eventmanager.html:4097-4100` (the `const teamData = { teamName, members: orderedNames.map(...) };` block) with:

```js
  const teamData = { teamName, members: orderedNames.map(name => {
    const slot = { player: name, builds: [] };
    reconcileMatchSlotBuilds(slot, buildsState[playerKey(name)] || []);
    return slot;
  })};
```

- [ ] **Step 3: Run the full suite**

Run: `node --test "tests/*.test.js"`
Expected: PASS — 123 passing, 0 failing (no behavior change; refactor only).

- [ ] **Step 4: Commit**

```bash
git add eventmanager.html
git commit -m "refactor: manual match creation hydrates builds via reconcile helper"
```

---

### Task 6: Round-trip regression — flatten/load and non-dirty live-sync preserve hydrated builds

Proves the load/save/live-sync paths preserve the now-correct builds (no code change here — guards against future regressions).

**Files:**
- Test: `tests/challonge-build-hydration.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/challonge-build-hydration.test.js`:

```js
function loadFlattenAndLoad() {
  const ctx = {
    JSON, Array, Object, Set, console,
    resultsState: [],
    matchesState: [],
    _matchIdCounter: 1,
    calcPoints: () => 0,
    autoCheckWin() {}, autoCheckDeWin() {}, autoCheckTeamWin() {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('function flattenMatchesToResults()', '// LIVE-PUSH PATCH HELPERS (start)'),
    ctx
  );
  vm.runInContext(
    sliceBetween('function loadMatchesFromResults()', 'function flattenMatchesToResults()'),
    ctx
  );
  return ctx;
}

test('round-trip: flatten then load preserves solo build names, finishes and deployed', () => {
  const ctx = loadFlattenAndLoad();
  ctx.matchesState = [{
    id: 1, _sid: 'R1|e-ken|e-mia|0', round: 'R1',
    p1: { player: 'Ken', entryId: 'e-ken', builds: [
      { build: 'Dragoon', finishes: ['S'], deployed: true },
      { build: 'Dranzer', finishes: [], deployed: false },
    ] },
    p2: { player: 'Mia', entryId: 'e-mia', builds: [
      { build: 'Driger', finishes: ['O'], deployed: false },
    ] },
  }];
  vm.runInContext('flattenMatchesToResults()', ctx);
  // server row builds carry the scoring objects intact
  assert.deepEqual(ctx.resultsState[0].builds[0], { build: 'Dragoon', finishes: ['S'], deployed: true });
  // reload from the flattened rows
  vm.runInContext('loadMatchesFromResults()', ctx);
  const m = ctx.matchesState[0];
  assert.deepEqual(m.p1.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
  assert.deepEqual(m.p1.builds[0].finishes, ['S']);
  assert.equal(m.p1.builds[0].deployed, true);
  assert.deepEqual(m.p2.builds.map(b => b.build), ['Driger']);
});

test('round-trip: non-dirty full-replace merge keeps server-hydrated builds', () => {
  // mergeIncomingMatches (non-dirty path) builds slots from server rows that
  // already carry hydrated build objects -> they must survive the replace.
  const ctx = {
    JSON, Array, Object, Set, console,
    dirty: false,
    matchesState: [],
    resultsState: [],
    _matchIdCounter: 5,
    _activeLiveMatchSid: null,
    flattenMatchesToResults() {},
    playerKey: (n) => n,
    slotKey: (p) => p.entryId || p.player,
    isDeSelfMatch: () => false,
    _soloSid: (r, p1, p2, i) => `${r}|${p1.entryId || p1.player}|${p2.entryId || p2.player}|${i}`,
    _teamSid: (r, a, b, i) => `${r}|T|${a}|${b}|${i}`,
  };
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('function mergeIncomingMatches', '// SUBMIT MATCH'),
    ctx
  );
  const serverResults = [
    { player: 'Ken', entryId: 'e-ken', round: 'R1', _matchSid: 'R1|e-ken|e-mia|0',
      builds: [{ build: 'Dragoon', finishes: ['S'], deployed: true }] },
    { player: 'Mia', entryId: 'e-mia', round: 'R1', _matchSid: 'R1|e-ken|e-mia|0',
      builds: [{ build: 'Driger', finishes: [], deployed: false }] },
  ];
  vm.runInContext(
    `mergeIncomingMatches({}, ${JSON.stringify(serverResults)})`, ctx
  );
  assert.equal(ctx.matchesState.length, 1);
  assert.deepEqual(ctx.matchesState[0].p1.builds.map(b => b.build), ['Dragoon']);
  assert.deepEqual(ctx.matchesState[0].p1.builds[0].finishes, ['S']);
});
```

- [ ] **Step 2: Run tests to verify behavior**

Run: `node --test "tests/challonge-build-hydration.test.js"`
Expected: PASS — these assert existing (correct) load/merge behavior. If either FAILS, a load/merge path is dropping build objects and must be investigated before proceeding (it should not, per the root-cause analysis).

- [ ] **Step 3: Run the full suite**

Run: `node --test "tests/*.test.js"`
Expected: PASS — 125 passing, 0 failing.

- [ ] **Step 4: Commit**

```bash
git add tests/challonge-build-hydration.test.js
git commit -m "test: round-trip + non-dirty sync preserve hydrated match builds"
```

---

### Task 7: Manual end-to-end verification

Automated tests cover the pure logic; this step confirms the two real-world orderings in the running app.

- [ ] **Step 1: Builds-before-sync.** In a Challonge-linked event: enter builds for two mapped players on the Bey Builds tab and Submit Builds. Run a Challonge sync. Open the imported solo match — confirm both players' builds appear with correct names and no finishes/deployed set.
- [ ] **Step 2: Sync-before-builds.** In a fresh Challonge-linked event: run a sync first (imported match shows no builds). Then enter builds for both players and Submit Builds. Confirm the previously-empty match now shows the submitted builds.
- [ ] **Step 3: DE separation.** With a Double Entry player (same name, main + DE), give the main and DE different builds. Confirm each imported slot shows its own builds, not the other's.
- [ ] **Step 4: Team match.** Repeat Step 1 for a 3v3 event and confirm every team member's builds populate.
- [ ] **Step 5: Reload + live sync.** Reload the page and confirm builds persist. With a second device/tab open (non-dirty), confirm a live-sync poll keeps the populated builds.

- [ ] **Step 6: Final full-suite run**

Run: `node --test "tests/*.test.js"`
Expected: PASS — 125 passing, 0 failing.

---

## Self-Review

- **Spec coverage:** Bug A → Task 2; Bug B → Task 3; Bug C → Task 4; preserve finishes/deployed → Task 1 (rename) + Task 3 tests; rename by slot index → Task 1/Task 3; main vs DE separate `entryId` → Task 2/Task 3; team members → Task 3/Task 4; save/reload/non-dirty live-sync → Task 6; idempotent / no duplicate slots → Task 1/Task 3; blank/removed slots defined → Task 1 (filtered indexing + preserve-results trim); `node --test "tests/*.test.js"` → every task. All required regression tests are present.
- **Type consistency:** `reconcileMatchSlotBuilds(slot, submittedBuildNames)`, `applySubmittedBuildsToMatches()`, and `challongeJoinerTeamToMatchTeam(joiner)` are referenced with identical names/signatures across tasks and tests. Slot shape `{ build, finishes:[], deployed:false }` is consistent throughout.
- **Authority rules:** the helper only writes `slot.builds[i].build` or pushes new objects; no scoring field is touched in any task. Load/merge code is unchanged — only proven by Task 6.
- **No placeholders:** every code/test step contains complete code and exact commands with expected counts (baseline 105 → 113 → 116 → 121 → 123 → 123 → 125).
