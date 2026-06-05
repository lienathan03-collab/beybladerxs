# DE Self-Match Sync Dedupe + Lightning Scoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Challonge sync idempotent (re-syncing imports 0 duplicates, post-DE-fix imports only the 1 missing match), persist `_challongeMatchId` through save/load/live-sync, give DE self-matches a click-then-Done lightning modal that submits/pushes exactly once, and safely de-duplicate the user's current 43-match event back to 22.

**Architecture:** Two independent fixes in `eventmanager.html` (single-file app). (A) Dedup/persistence: carry `_challongeMatchId` (+ `_challongePushState`, `division`) onto the flattened server rows, rehydrate it everywhere matches are rebuilt, and add a signature fallback so legacy matches without the id still dedupe. (B) DE scoring: a scratch-state modal opened by a ⚡ button; score taps only mutate scratch; Done validates one winner then routes through the existing `submitMatch` → `challongeReportMatch` path (push-once guard already exists). Plus a one-time `dedupeChallongeImports()` cleanup tool.

**Tech Stack:** Vanilla JS in `eventmanager.html`; Node's built-in `node:test` + `vm` harness (`tests/eventmanager-sync-regression.test.js`, `tests/challonge-import.test.js`); Cloudflare DO/KV merge (`workers/bey-state-do/src/merge.js`) already preserves arbitrary row fields via `{ ...e }`.

---

## 1. Root Cause Analysis — duplicate sync (43 matches)

`_challongeMatchId` lives only on the in-memory `matchesState` object. It is **never written to the flat `resultsState` rows** that get saved to the server, and is **never read back** when matches are reconstructed. There are three reconstruction/serialization points, and all three drop it:

1. **Write path — [`flattenMatchesToResults()`](eventmanager.html:3210) (rows at :3242-3243) and [`flattenSingleMatch()`](eventmanager.html:3251) (rows at :3272-3273).** The solo rows emit `entryId, entryType, displayLabel, round, builds, pointsTotal, win, _submitted, _matchSid, _noStats, dePoints` — **no `_challongeMatchId`, no `_challongePushState`, no `division`.** So the instant a match is saved (every `markDirty`/queued PUT/live push), the dedup id is absent from persisted data.

2. **Read path — [`loadMatchesFromResults()`](eventmanager.html:3130) (rebuild at :3193-3205).** Rebuilds each match from rows but does not read `_challongeMatchId` back (it *does* rebuild `_deSelfMatch` from `_noStats` and `dePoints`, so DE typing survives — but the Challonge id does not).

3. **Live-sync path — [`mergeIncomingMatches()`](eventmanager.html:7245).** Reconstructs `serverMatches` from rows (solo at :7294-7299) and, in the **non-dirty full-replace** branch (:7387-7393), *replaces* `matchesState` with those reconstructed objects. They carry **no `_challongeMatchId`** — and, as a separate latent bug, **no `dePoints` and no `_deSelfMatch`** (line :7296-7297 omits them), so a poll can also silently corrupt a DE self-match.

**Why the user saw 43:** `alreadyImported()` ([:3440](eventmanager.html:3440)) only checks `m._challongeMatchId === id`. By the time the user re-clicked Sync, their 21 matches had been through at least one save/load and/or one full-replace poll, so every match had `_challongeMatchId === undefined`. `buildImportPlan` ([:3444](eventmanager.html:3444)) therefore saw 0 already-imported, marked all 22 Challonge matches `reason: 'create'`, and appended them → 21 + 22 = **43**. The DE fix (`reason: 'de-self'`) is unrelated to the duplication; it only explains why the original count was 21 (the DE match had previously been skipped) vs Challonge's 22.

**Confirmed safe foundation:** the server merge ([`mergeBeyResults`](workers/bey-state-do/src/merge.js:158) / [`computeSidsForEntries`](workers/bey-state-do/src/merge.js:42)) copies whole row objects with `{ ...e }` and groups by `_matchSid`, so any extra field we add to a row **round-trips through the server untouched.** No worker/API changes are needed for persistence.

## 2. Design — dedupe + persistence fix

**Principle:** persist the id on the rows, rehydrate it everywhere, and add a content-signature fallback so legacy/pre-fix matches (including the user's current data) dedupe even with no id.

**2a. Persist on write.** In `flattenMatchesToResults` and `flattenSingleMatch`, add to **both** solo rows (mirroring how `dePoints`/`_noStats` are placed on both) and to the **first team1 row** (mirroring `_playOrder`):
`_challongeMatchId: m._challongeMatchId || undefined`, `_challongePushState: m._challongePushState || undefined`, `division: m.division || undefined`, `_challongeGroupId: m._challongeGroupId || undefined`.

**2b. Rehydrate on read.** In `loadMatchesFromResults` (solo + team) and `mergeIncomingMatches` (solo + team reconstruction **and** the full-replace `newState` map), copy those four fields back from the anchor row onto the rebuilt match (`p1._challongeMatchId || p2._challongeMatchId` for solo; first team1 entry for team). While here, fix the pre-existing live-sync bug: the solo reconstruction in `mergeIncomingMatches` (:7296-7297) must also carry `dePoints` and set `_deSelfMatch` (e.g. `_noStats || isDeSelfMatch(p1,p2)`), matching `loadMatchesFromResults`. Also preserve `_challongePushState`/`_challongeMatchId`/`_deSelfMatch` on the existing match in both merge branches so a poll never wipes a live push chip.

**2c. Signature fallback in `buildImportPlan`.** A Challonge match is "already imported" if **either** an existing match has the same `_challongeMatchId` **or** an existing match has the same signature. Add a pure helper (inside the `CHALLONGE-HELPERS` markers so it is unit-testable):

```js
function challongeImportSignature(round, ref1, ref2, isTeam) {
  const a = isTeam ? (ref1 && ref1.teamName) : (ref1 && ref1.entryId);
  const b = isTeam ? (ref2 && ref2.teamName) : (ref2 && ref2.entryId);
  const lo = String(a) < String(b) ? a : b;   // order-independent
  const hi = String(a) < String(b) ? b : a;
  return `${round}|${lo}|${hi}`;
}
function existingMatchSignature(m) {
  if (m.isTeamMatch) return challongeImportSignature(m.round, m.team1, m.team2, true);
  return challongeImportSignature(m.round, m.p1, m.p2, false);
}
```

`buildImportPlan` builds a `Set` of existing signatures **once** and, for any Challonge match not matched by id, checks the signature set before emitting `reason:'create'|'de-self'`. To avoid over-suppressing a legitimate same-round rematch, the set is a **multiset/count** consumed one slot per import (decrement on use); only signatures with a remaining count > 0 suppress. This keeps the existing `soloPairCount` rematch behavior intact while killing accidental duplicates.

**Result:** sync twice → 0 dupes (id match after first fix; signature match for legacy data). Sync after the DE fix on the user's current (pre-fix) data → the 21 already-present pairings match by signature and are skipped; only the missing DE self-match has no signature match → imported once.

## 3. Design — DE lightning score modal

**Recommendation on max score:** use `soloThreshold(round)` (R/QF/TC = 1–4, **SF = 1–5, F = 1–7**), not fixed 1–4. The DE self-match is a coin-toss standing in for a real best-of set, so the cap should equal that round's best-of target; fixing it at 4 would make a 5-point SF or 7-point final un-enterable and would disagree with how normal solo wins are computed for those rounds.

**Recommendation on winner rule:** relax `autoCheckDeWin` ([:3354](eventmanager.html:3354)) from "winner must reach threshold" to **"higher `dePoints` wins; equal → no winner."** This (a) matches the user's stated validation ("exactly one winner / no tie") and their literal example (`2` vs `4` → the `4` side wins), (b) supports any picked pair like `5`–`3` in SF, and (c) is backward-compatible: the inline path and the existing regression test (`dePoints 4 vs 2 → p1 wins`, [test:1019](tests/eventmanager-sync-regression.test.js:1019)) still pass because higher still wins. *(Considered and rejected: keep the strict `>= threshold` rule and force the winner column to `threshold`. Rejected — it adds friction, blocks valid-looking picks like 3–2, and contradicts the user's "higher wins / no tie" framing.)*

**UI / flow:**
- Add a `⚡` `live-btn` to the DE self-match card header in [`renderDeSelfMatchCard`](eventmanager.html:4567), styled like the normal solo card's button ([:4550](eventmanager.html:4550)), `onclick="openDeSelfScore(${mid})"`.
- **Remove the inline scoring controls** (`mSelectDeWinner` buttons + `mSetDeLoserPoints` input, :4620-4630) from the card body — these are what call `evaluateAutoSubmit` on every change and cause the repeated-submit behavior. The card body becomes a read-only summary (`NameX ADV n–m` / `select scores`). Keep `challongePushChipHtml` + `submitAreaHtml` (so after Done it shows the push chip and `↩ Unsubmit`).
- New static modal `#de-self-score-modal` (added near the other modals) with two columns (Name 1 / Name 2), each rendering buttons `1..soloThreshold(round)`, plus **Done** and **Cancel**.
- New scratch state: `let _deScore = { mid: null, p1: null, p2: null };`
- `openDeSelfScore(mid)`: load match, set `_deScore` from existing `dePoints` (or null), build the two button rows up to `soloThreshold(match.round)`, show modal. **Does not mutate the match.**
- `deScorePick(side, value)`: `_deScore[side] = value`; re-highlight buttons only. **No flatten, no markDirty, no submit, no push.**
- `deScoreDone()`: validate `_deScore.p1 != null && _deScore.p2 != null && _deScore.p1 !== _deScore.p2` (else inline error, return). Write `match.p1.dePoints/_deScore.p1`, `match.p2.dePoints/_deScore.p2`, `match._deSelfMatch = true`, set wins via higher value, `flattenMatchesToResults()`, close modal, then `await submitMatch(mid)`. `submitMatch` already persists once and calls `challongeReportMatch(toSubmit)` at its end ([:7515](eventmanager.html:7515)); `challongeReportMatch` already no-ops when `_challongePushState` is `pending`/`ok` ([:3801](eventmanager.html:3801)), so Challonge is reported **once** with `scores_csv` higher-first and the correct `winner_id` (e.g. `2` vs `4` → `4-2`, winner = side 2), via the existing [`eventPointsToScoresCsv`](eventmanager.html:3468) + [`challongeReportMatch`](eventmanager.html:3767) which already special-cases `_deSelfMatch` to use `dePoints` ([:3791](eventmanager.html:3791)).
- `_noStats` already flows from `_deSelfMatch` through flatten and is already excluded from leaderboard ([syncBladerStats:7974](eventmanager.html:7974)) and archive ([:7901](eventmanager.html:7901)) — **no win/loss/stats/archive impact, no Beyblade finishes, confirmed by existing tests** ([:1069](tests/eventmanager-sync-regression.test.js:1069), [:1111](tests/eventmanager-sync-regression.test.js:1111)). No changes needed there.
- **Normal live scoring is untouched** — `openLiveModeSolo`/`openLiveMode`/`lmCommitAndClose`/auto-submit engine are not modified.

## 4. Cleanup / migration plan for the current 43-match event

Each imported match has a distinct `_sid` (the pair-count index differs: original = idx 0, re-import = idx 1), so deleting a duplicate **cannot** tombstone the original. The 22 re-imports are the unsubmitted/unscored copies; the originals hold the user's scoring. Plan: a **one-time, confirm-gated** `dedupeChallongeImports()` tool added to the Challonge tab.

Algorithm:
1. Group `matchesState` by `existingMatchSignature(m)`.
2. For each group of size > 1:
   - `scored(m)` = `m.submitted` OR any `win` OR any `dePoints > 0` OR any finish in any build.
   - Keep **all** scored matches (never delete real results). Among the **unscored** copies, keep one only if the group has no scored member (so the pairing still exists), and mark the remaining unscored copies for removal.
3. Show a `confirm()` dialog **listing exactly** which matches (round + names + sid) will be removed; abort on cancel.
4. Remove via the existing [`removeMatch`](eventmanager.html) path so tombstones + the per-event deleted-sid set propagate and the deletions stick across devices.
5. **Backfill:** after dedup, fetch Challonge `action=matches`, and for each surviving match without `_challongeMatchId`, match by `challongeImportSignature(round, side1Ref, side2Ref)` (using `challongeParticipantMap` → entryId) and stamp `_challongeMatchId` (+ `division`). `flattenMatchesToResults()` + `markDirty()` + `queueCreatedMatchSave()` to persist the now-survivable ids.
6. Re-run Sync → expect **"No new matches"** (all 22 now id-matched).

Fallback if the user prefers not to run the tool: because the signature fallback (2c) is also in `buildImportPlan`, the *next* sync already imports 0 duplicates even before backfill — the tool is for removing the existing 22 extras, not for preventing future ones.

## 5. Test plan (exact regression cases)

Add to `tests/eventmanager-sync-regression.test.js` and `tests/challonge-import.test.js`:

- **Persist:** `flattenMatchesToResults` and `flattenSingleMatch` on a match with `_challongeMatchId: 555` → both solo rows carry `_challongeMatchId: 555`; team match → first team1 row carries it.
- **Rehydrate (load):** `loadMatchesFromResults` from rows carrying `_challongeMatchId: 555` → rebuilt match has `_challongeMatchId === 555`.
- **Rehydrate (merge):** `mergeIncomingMatches` full-replace from server rows with `_challongeMatchId: 555` → surviving match keeps it; and a DE row set (`_noStats`, `dePoints`) → rebuilt match has `_deSelfMatch === true` and both `dePoints` (locks the latent live-sync DE bug).
- **Idempotent by id:** `buildImportPlan` with `matchesState` already holding `_challongeMatchId: 12` → that Challonge match → `skip:true, reason:'duplicate'`.
- **Idempotent by signature (legacy):** `buildImportPlan` where `matchesState` has a match with the same `round` + same two `entryId`s but **no** `_challongeMatchId` → that Challonge match is skipped; the missing DE self-match (no signature match) → `reason:'de-self'`, not skipped. Reproduces the 21→22 scenario: 21 existing pairings suppressed, only the DE imports.
- **No over-suppression:** two distinct Challonge open matches with the same signature (rematch) vs one existing local copy → exactly one is suppressed, one still imports.
- **DE modal — scores don't submit:** stub `submitMatch`/`flattenMatchesToResults`/`scheduleLivePush`; call `deScorePick('p1',2)` then `deScorePick('p2',4)` → none of the stubs were called; `_deScore === {mid, p1:2, p2:4}`.
- **DE modal — Done validation:** `_deScore = {p1:3,p2:3}` → `deScoreDone()` sets an error and does **not** call `submitMatch`. `{p1:2,p2:4}` → calls `submitMatch(mid)` exactly once; match has `p1.dePoints===2, p2.dePoints===4, p2.win===true, p1.win===false, _deSelfMatch===true`.
- **DE winner rule:** `autoCheckDeWin` with `dePoints 2 vs 4` → p2 win; `4 vs 4` → no winner; `4 vs 2` → p1 win (keeps existing [test:1019](tests/eventmanager-sync-regression.test.js:1019) green).
- **Report mapping:** `eventPointsToScoresCsv(2,4,winnerId=p2Id,...)` → `scores_csv` higher-first `"4-2"`, `winner_id === p2Id` (extend existing coverage).
- **Cleanup:** `dedupeChallongeImports` over a group of {scored original, unscored duplicate} → duplicate marked for removal, original kept; group of {two unscored} → exactly one kept.
- **Full regression:** `node --test tests/` must stay green (DE `_noStats` stats/archive tests, SID-drift, tombstone tests).

## 6. Risks & files/functions touched

**Risk list:**
- **Over-suppression by signature** could hide a legitimate same-round rematch → mitigated by the count-consuming multiset (only suppress as many as already exist).
- **Touching shared `flatten*`** affects every save/live-push; keep additions `|| undefined` so absent fields don't bloat rows or change existing snapshots/`_lastSyncHash` for non-Challonge events.
- **`mergeIncomingMatches` is the most delicate function** (dirty vs full-replace, active-live-match guard). Add fields without altering control flow; cover with the merge tests above.
- **Relaxing `autoCheckDeWin`** changes DE win derivation — verify the existing DE flatten/stats/archive tests still pass.
- **Cleanup deletes data** → hard-gate behind a `confirm()` that lists exact matches; only ever remove **unscored** copies; rely on distinct `_sid`s so an original is never tombstoned.
- **No worker/API change required**; if that assumption were wrong the persisted id would be stripped — covered by an integration round-trip note (server preserves `{ ...e }`, verified in `merge.js`).

**Files / functions likely touched (all in `eventmanager.html` unless noted):**
- `flattenMatchesToResults` (:3210), `flattenSingleMatch` (:3251) — add id/pushState/division to rows.
- `loadMatchesFromResults` (:3130) — rehydrate fields.
- `mergeIncomingMatches` (:7245) — rehydrate + fix DE `dePoints`/`_deSelfMatch` drop.
- `alreadyImported` (:3440), `buildImportPlan` (:3444) + new `challongeImportSignature`/`existingMatchSignature` (inside `CHALLONGE-HELPERS` markers, :3364-3491).
- `autoCheckDeWin` (:3354) — higher-wins/no-tie.
- `renderDeSelfMatchCard` (:4567), remove inline `mSelectDeWinner`/`mSetDeLoserPoints` usage; new `openDeSelfScore`/`deScorePick`/`deScoreDone` + `#de-self-score-modal` markup + `_deScore` state.
- New `dedupeChallongeImports` + a button in the Challonge Sync tab.
- Tests: `tests/eventmanager-sync-regression.test.js`, `tests/challonge-import.test.js`.
- Read-only confirmation: `workers/bey-state-do/src/merge.js` (no change), `functions/api/challonge.js` (no change).

---

## Task Breakdown (TDD)

### Task 1: Persist `_challongeMatchId` through flatten

**Files:** Modify `eventmanager.html` (`flattenMatchesToResults` :3242-3243, `flattenSingleMatch` :3272-3273); Test `tests/eventmanager-sync-regression.test.js`.

- [ ] **Step 1 — failing test:** assert flattened solo rows carry `_challongeMatchId`.

```js
test('flatten persists _challongeMatchId on both solo rows', () => {
  const ctx = deMatchContext(); loadFlattenHelpers(ctx);
  ctx.matchesState = [{ id:1, _sid:'R1|eA|eB|0', round:'R1', _challongeMatchId:555,
    p1:{player:'Ken',entryId:'eA',builds:[],win:true}, p2:{player:'Mia',entryId:'eB',builds:[],win:false}, submitted:false }];
  vm.runInContext('flattenMatchesToResults()', ctx);
  assert.equal(ctx.resultsState[0]._challongeMatchId, 555);
  assert.equal(ctx.resultsState[1]._challongeMatchId, 555);
});
```

- [ ] **Step 2 — run, expect FAIL** (`undefined !== 555`). Run: `node --test tests/eventmanager-sync-regression.test.js`
- [ ] **Step 3 — implement:** append to both solo rows in both functions: `_challongeMatchId: m._challongeMatchId || undefined, _challongePushState: m._challongePushState || undefined, division: m.division || undefined, _challongeGroupId: m._challongeGroupId || undefined` (use `match.` in `flattenSingleMatch`; for team matches add to the first team1 entry).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `git commit -m "fix: persist _challongeMatchId through flatten"`

### Task 2: Rehydrate on load + merge (and fix DE drop in merge)

**Files:** Modify `eventmanager.html` (`loadMatchesFromResults` :3193-3205; `mergeIncomingMatches` :7294-7299, :7387-7393); Test same file.

- [ ] **Step 1 — failing tests:** (a) `loadMatchesFromResults` rebuilds `_challongeMatchId`; (b) `mergeIncomingMatches` full-replace keeps `_challongeMatchId` and rebuilds DE `dePoints`/`_deSelfMatch`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** in `loadMatchesFromResults` solo + team push, copy the four fields from the anchor row (`p1._challongeMatchId || p2._challongeMatchId`). In `mergeIncomingMatches` solo reconstruction add `dePoints`, `_noStats`→`_deSelfMatch`, and the four Challonge fields; in the full-replace `newState` map and the dirty-branch update, preserve them from `existing`/`local`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `git commit -m "fix: rehydrate Challonge id + DE points through load and live-sync"`

### Task 3: Signature fallback in `buildImportPlan`

**Files:** Modify `eventmanager.html` (`CHALLONGE-HELPERS` block :3364-3491); Test `tests/challonge-import.test.js`.

- [ ] **Step 1 — failing test:** matchesState holds the same round+entryId pair with **no** `_challongeMatchId` → that Challonge match `skip:true`; a same-name different-entryId DE pairing with no local match → `reason:'de-self'`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `challongeImportSignature` + `existingMatchSignature`; in `buildImportPlan` precompute a signature→count map of existing matches and suppress (consume a slot) when no id match but a signature slot remains.
- [ ] **Step 4 — run, expect PASS** (plus the no-over-suppression rematch test).
- [ ] **Step 5 — commit:** `git commit -m "feat: signature fallback dedupe for legacy Challonge imports"`

### Task 4: Relax `autoCheckDeWin` to higher-wins/no-tie

**Files:** Modify `eventmanager.html` (:3354-3362); Test same regression file.

- [ ] **Step 1 — failing test:** `2 vs 4`→p2, `4 vs 4`→none, `4 vs 2`→p1.
- [ ] **Step 2 — run, expect FAIL** (current `2 vs 4` gives no winner since neither <threshold logic picks p2 unless ≥threshold).
- [ ] **Step 3 — implement:** compare `p1pts`/`p2pts`: higher wins, equal → both `win=false`.
- [ ] **Step 4 — run, expect PASS** and confirm existing DE flatten test still green.
- [ ] **Step 5 — commit:** `git commit -m "feat: DE self-match winner is higher coin-toss score"`

### Task 5: DE lightning score modal

**Files:** Modify `eventmanager.html` (modal markup; `renderDeSelfMatchCard` :4567; new `_deScore`, `openDeSelfScore`, `deScorePick`, `deScoreDone`; retire inline `mSelectDeWinner`/`mSetDeLoserPoints` from the card); Test regression file.

- [ ] **Step 1 — failing tests:** score taps don't call submit/flatten; Done rejects a tie; Done with `2/4` sets dePoints+win+`_deSelfMatch` and calls `submitMatch` once.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the modal, the ⚡ button, scratch-state handlers, and Done routing through `submitMatch`; remove inline controls from the card body.
- [ ] **Step 4 — run, expect PASS.** Manual: ⚡ → tap 2 / 4 → Done → one submit, one `✓ pushed to Challonge` chip, `4-2` to Challonge.
- [ ] **Step 5 — commit:** `git commit -m "feat: DE self-match lightning scoring modal (submit once on Done)"`

### Task 6: One-time `dedupeChallongeImports` cleanup tool

**Files:** Modify `eventmanager.html` (new function + Challonge tab button); Test regression file.

- [ ] **Step 1 — failing test:** group {scored, unscored-dup} → only the dup is removed; {unscored, unscored} → one kept.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** grouping by `existingMatchSignature`, scored detection, confirm-gated removal via `removeMatch`, and signature backfill of `_challongeMatchId` from a Challonge fetch.
- [ ] **Step 4 — run, expect PASS.** Manual on the real 43-match event: run tool → confirm list of ~22 → event returns to 22 → re-Sync shows "No new matches".
- [ ] **Step 5 — commit:** `git commit -m "feat: one-time Challonge import de-duplication tool"`

### Task 7: Full regression sweep

- [ ] **Step 1 — run:** `node --test tests/` → all green (DE stats/archive, SID-drift, tombstone, new tests).
- [ ] **Step 2 — manual loop:** link test tournament → import a round → score a normal match (unchanged) → score a DE self-match via modal → re-Sync twice (0 new) → reload page, re-Sync (0 new) confirms persistence.
- [ ] **Step 3 — commit** any test-only fixups.
