# Compact Mobile Match Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bulky Match Results cards in `eventmanager.html` with a compact, mobile-first match list whose collapsed rows expand into the existing detailed body, and make manual match creation jump straight into Live Scoring while imports/reloads/live-sync stay collapsed.

**Architecture:** Keep the existing expanded card bodies (`renderPlayerSide`, `renderTeamMemberSide`, the DE body) untouched and redesign only the **header row** into a dense two-line matchup with one prominent ⚡ button and an overflow `⋯` menu for secondary actions. A new pure routing helper (`manualMatchScoringTarget`) plus a thin dispatcher (`openManualMatchScoring`) drive the "open Live Scoring after manual create" behavior; collapse defaults are corrected so only manual creation opens scoring. All new/changed logic is wrapped in `// === MARKER START/END ===` comments so the existing `vm`-slice test harness can exercise it.

**Tech Stack:** Single-file vanilla JS/HTML/CSS (`eventmanager.html`, 8578 lines). Tests: Node's built-in `node:test` + `node:vm`, run with `node --test "tests/*.test.js"`. No build step, no framework.

## Post-Implementation Review Amendments

The final reviewed implementation also:

- Explicitly hides `.mc2-menu[hidden]`; the base flex rule otherwise overrides the browser's native hidden styling and makes every overflow menu appear open.
- Uses icon-only visual status chips at phone widths while retaining full `aria-label` and desktop text, preserving space for both player names at 320px.
- Supports Enter/Space on the match row and keeps overflow-trigger `aria-expanded` synchronized when another menu, outside click, or Escape closes it.

---

## 1. Critique of the Current Mobile Layout

The collapsed card header (`renderMatchCard` `eventmanager.html:4739`, mirrored in `renderDeSelfMatchCard:4790` and `renderTeamMatchCard:4967`) is a single `.match-card-header` flex row that crams in: a round badge, the VS label (`flex:1`), a result summary, a Challonge push chip, the submit area (a full-text **⬆ Submit** / **↩ Unsubmit** / **⏳ Auto-submit Ns · Cancel** button), a full-text **✕ Remove** button, and a collapse caret — plus a separate `.live-btn ⚡` cell on the right.

Concrete problems:

1. **Header wraps into a wall of buttons on mobile.** At ≤600px the responsive rules (`eventmanager.html:1475-1480`) set `flex-wrap:wrap` and push the VS label to its own full-width line (`order:1`), so the round badge, summary, Submit, Remove, and caret each fight for space on the remaining lines. Every match becomes 3–4 stacked rows tall before it's even expanded.
2. **Text buttons dominate.** "⬆ Submit", "↩ Unsubmit", "✕ Remove", and the long auto-submit countdown label are all text at 9–10px. They out-weigh the actual matchup information.
3. **Destructive action is trivially mis-tappable.** **✕ Remove** sits inline, the same size and weight as Submit, directly in the tap zone.
4. **Heavy borders/padding everywhere.** `.match-card`, `.match-card-header`, the DE "🪙 DE · NO BATTLE" pill, every `.match-build-row`, and per-side dividers all carry 1px borders and 6–10px padding, compounding the visual bulk.
5. **Inconsistent visual language across card types.** Solo, DE self-match, and team cards each hand-roll their header with inline `style="..."` strings (e.g. the DE pill at `:4800`), so spacing, font sizes, and colors drift between them.
6. **Two competing tap targets in one row.** The header toggles collapse; the adjacent `.live-btn` opens scoring. On a narrow screen they sit millimeters apart with no clear hierarchy.
7. **Color is used as outlines, not identity.** Nearly every control has a colored border (gold Submit, red Remove, blue live), so nothing stands out — the eye has no single anchor.

Net effect: a list of 10 matches is an exhausting vertical scroll of near-identical button-walls, and the one action a judge actually needs mid-tournament (start scoring) is no more prominent than Remove.

## 2. Proposed Designs & Trade-offs

### Option A — Compact single-row + overflow menu (brief's option 1)
One line: `[R1] Name1 vs Name2  ·  status  ⚡  ⋯`. All secondary actions hidden behind `⋯`.
- **Pros:** Densest possible; shortest list.
- **Cons:** At 320px a single row can't hold two long names + status + two buttons without truncating names to uselessness. Fails the "names must stay readable, may wrap to two lines" requirement.

### Option B — Strict two-line bracket card (brief's option 2)
Names stacked vertically (Name1 over Name2) with a right-side ⚡, status inline.
- **Pros:** Very readable names; bracket aesthetic matches the inspiration screenshots.
- **Cons:** Stacked names + winner/score per line pull toward re-implementing a mini scoreboard, duplicating what the expanded body already shows. More body-rework, higher regression risk against the existing expand/score flow.

### Option C — Hybrid: compact header row that expands the existing body (brief's option 3 + option 2 density) — **RECOMMENDED**
A compact header (round badge · `Name1 / VS / Name2` allowed to wrap to two lines · status chip · ⚡ · `⋯`) that, when tapped, expands the **existing** `renderPlayerSide` / team / DE body verbatim. Secondary actions (Submit, Unsubmit, Remove, retry) live in the `⋯` menu.
- **Pros:** Lowest regression risk — the entire scoring/build/expanded UI is reused unchanged; only the header markup + CSS change. Names get a real two-line budget. One obvious ⚡. Destructive Remove is guarded behind `⋯`. One shared header component serves solo, DE, and team cards, fixing the visual-drift problem.
- **Cons:** Slightly more JS than inline icons (menu open/close, outside-tap close, keyboard handling).

**Recommendation: Option C.** It directly satisfies the brief's stated preference (a two-line matchup with one obvious lightning button, cleaner and smaller), reuses the most code, and isolates risk to the header. The `⋯` overflow keeps the collapsed row clean and makes Remove harder to trigger accidentally.

## 3. Recommended Layout — Wireframes

### Collapsed (default) — phone ~375px

```
┌────────────────────────────────────────────┐
│ ▸ R1   Kenji Watanabe        ·pending·  ⚡ ⋯ │
│        VS                                    │
│        Maximilian Brandt                     │
└────────────────────────────────────────────┘
```

- `▸` caret (left) signals expandable.
- Round badge inline with the caret.
- Names occupy the flexible middle column and may wrap to two lines; "VS" sits between them.
- Status chip (`pending` / `WIN` / `2-1` / `pushed` / `auto-submit 3s`) is compact, right-aligned before the buttons.
- ⚡ = always-visible primary (open Live Scoring / DE score / team live).
- `⋯` = overflow menu trigger. Both live in a tap-isolated action group (`event.stopPropagation()`).

### Collapsed with overflow menu open

```
┌────────────────────────────────────────────┐
│ ▸ R1   Kenji Watanabe        ·pending·  ⚡ ⋯ │
│        VS                          ┌─────────┴──┐
│        Maximilian Brandt           │ ⬆ Submit   │
│                                    │ ↩ Unsubmit │
│                                    │ ⟳ Retry push│
│                                    │ ✕ Remove   │  (red, last)
│                                    └────────────┘
└────────────────────────────────────────────┘
```

Menu items render conditionally (Submit XOR Unsubmit XOR Auto-submit-cancel; Retry only when push state is `error`; Remove always, visually separated and red).

### Expanded (after tap) — unchanged body

```
┌────────────────────────────────────────────┐
│ ▾ R1   Kenji Watanabe        ·pending·  ⚡ ⋯ │
│        VS  Maximilian Brandt                 │
├──────────────────────┬─────────────────────┤
│ KENJI WATANABE  [3/4]│ MAX BRANDT     [1/4] │
│  Dragoon   [+Finish] │  Dranzer  [+Finish]  │  ← existing renderPlayerSide
│  PTS              3  │  PTS             1   │
└──────────────────────┴─────────────────────┘
```

The body below the header is exactly today's `renderPlayerSide` (solo), per-slot team rows (team), or DE coin-toss summary (DE) — no changes.

## 4. Responsive & Interaction Specifications

### Breakpoints
| Width | Behavior |
|---|---|
| **~320px** | Single column. Names get the full middle column and wrap to **two lines max** (`-webkit-line-clamp:2` with ellipsis). ⚡ and `⋯` shrink to 40px min touch targets but stay on the header line (never wrap below names). Round badge 8px. |
| **375–430px** (common phones) | Single column. Names usually one line each side of VS; wrap to two when long. ⚡/`⋯` at 44px. |
| **601–900px** (tablet) | Single column (existing `@media (max-width:900px)` keeps one column), but header gets slightly more horizontal padding; names rarely wrap. |
| **>900px** (desktop) | Two-column masonry as today (`renderResults` `:4707`). Same compact header, just roomier padding and a hover affordance on the row (hover is an enhancement only — never required). |

### Interaction requirements
- **Touch targets:** ⚡, `⋯`, and every overflow-menu item are **≥40px** tall (≥44px at 375px+). `min-height`/`min-width` enforced in CSS.
- **Long names:** middle column is `min-width:0` so flex truncation works; names use a 2-line clamp, never `overflow-x` scroll. The opponent name is always visible (each side has its own clamp; neither can hide the other).
- **Team / member names:** team card header shows team names with the same 2-line clamp; expanded body still lists members as today.
- **No hover dependency:** ⚡ and `⋯` are always visible and operable by tap. Desktop hover only adds a subtle background, never reveals controls.
- **Nested-tap safety:** the action group (`⚡`/`⋯`) and the open menu wrap in `onclick="event.stopPropagation()"` so tapping them never toggles collapse. Conversely the menu's own buttons call their action then close the menu, and also `stopPropagation`.
- **Keyboard / a11y:** ⚡ and `⋯` are real `<button>`s with `aria-label` ("Open live scoring", "More actions") and `title` tooltips. The menu uses `aria-expanded` on the trigger and is dismissable with `Escape`. Menu items keep descriptive labels ("Submit", "Unsubmit", "Remove match").
- **Destructive guard:** Remove is never on the collapsed row; it's the last, red, visually separated item in `⋯`, and still routes through the existing `removeMatch()` `confirm()` dialog.
- **State preservation:** submitted, pending, Challonge push (`ok`/`pending`/`error`), winner, score, and auto-submit-countdown states all render inside the compact header (status chip + menu), driven by the existing `challongePushChipHtml` and `submitAreaHtml` logic refactored into menu/chip form.

## 5. Exact Functions & CSS Areas to Modify

**JavaScript (`eventmanager.html`):**
- `createMatch()` `:4325` — set created match `collapsed:true`; capture the pushed match; after `await queueCreatedMatchSave()`, open scoring via the new dispatcher with fallback.
- `challongeImportOpenMatches()` `:3757` — change `collapsed:false` → `collapsed:true` at `:3795` (team) and `:3816` (solo). Must NOT open scoring.
- `submitMatch` `:7769` — change `toSubmit.collapsed = false` → `true` (stay collapsed on submit).
- `loadMatchesFromResults()` `:3131` (`:3173`,`:3213`) — already `collapsed:true`; add a regression test, no code change.
- `mergeIncomingMatches()` `:7508` (`:7649`,`:7674`,`:8053`) — already `collapsed:true`; add a regression test, no code change.
- `renderMatchCard()` `:4716`, `renderDeSelfMatchCard()` `:4771`, `renderTeamMatchCard()` `:4935` — replace header markup with the shared compact header.
- `submitAreaHtml()` `:4587` and `challongePushChipHtml()` `:4570` — refactor into (a) a status-chip string for the collapsed row and (b) menu-item strings for the overflow menu.
- **New helpers** (pure, marker-wrapped): `manualMatchScoringTarget(match)`, `openManualMatchScoring(match, fnTable)`, `matchStatusChipHtml(match)`, `matchOverflowMenuHtml(match)`, `compactMatchHeaderHtml(match, {name1, name2, vsGlyph})`, and the menu toggler `toggleMatchMenu(mid, ev)`.

**CSS (`eventmanager.html`):**
- Add a new `/* ── COMPACT MATCH CARDS (mc2) ── */` block near the existing `/* ── MATCH CARDS ── */` (`:356`): `.mc2-row`, `.mc2-round`, `.mc2-names`, `.mc2-vs`, `.mc2-name`, `.mc2-status`, `.mc2-actions`, `.mc2-live`, `.mc2-more`, `.mc2-menu`, `.mc2-menu-item`, `.mc2-menu-item.danger`, `.mc2-caret`.
- Update the mobile `@media (max-width:600px)` match-card rules (`:1475-1485`) to target `.mc2-*` (replace the wrap-to-multiple-rows hack with the new two-line names + fixed action group).
- Keep `.match-card-body`, `.match-player-side`, `.match-build-*`, `.round-win-badge`, `.match-pts-*`, `.live-btn` (the in-body PTS live affordance) as-is.

## 6. Risks & Accessibility Considerations

- **Regression in scoring/sync flows.** Mitigation: the expanded body and all scoring entry points are untouched; changes are header markup + collapse flags. The existing suites (`challonge-import`, `eventmanager-sync-regression`, `challonge-build-hydration`) must stay green and are run in the final task.
- **Auto-open firing for non-manual paths.** Mitigation: routing lives only in `createMatch` after its own `await`; imports/merge/load never call the dispatcher. A dedicated test asserts import creates collapsed matches and never invokes a scoring fn.
- **Persistence race before scoring.** `queueCreatedMatchSave()` assigns the `_sid` synchronously and never throws (it catches + toasts on failure), so awaiting it guarantees the match is persisted-or-safely-queued before scoring opens. The dispatcher runs after the await.
- **DE self-match mis-routed to normal Live Scoring.** Mitigation: `manualMatchScoringTarget` checks `_deSelfMatch` → `openDeSelfScore` before the solo branch; covered by test.
- **Overflow menu trapping focus / not closing.** Mitigation: `Escape` and outside-tap close it; only one menu open at a time (toggling closes others); trigger carries `aria-expanded`.
- **Accidental collapse toggle from a nested control.** Mitigation: action group + menu `stopPropagation`; covered by a test that simulates a click on a nested button and asserts `collapsed` is unchanged.
- **Color-only state cues.** Mitigation: every state also carries a glyph/text (✓, ⚠, ⟳, WIN, score), so it's not conveyed by color alone (WCAG 1.4.1).
- **Touch target minimums.** Enforced via CSS `min-height`/`min-width`; verified with `preview_inspect` in the verification task.

---

## Implementation Tasks

> Test harness note: tests load `eventmanager.html` as text and `vm.runInContext` a **slice** between marker comments, stubbing globals. New pure logic MUST be wrapped in `// === NAME START ===` / `// === NAME END ===` markers. Follow the pattern in `tests/challonge-build-hydration.test.js` (`sliceBetween`).

### Task 1: Fix collapse defaults — Challonge imports stay collapsed

**Files:**
- Modify: `eventmanager.html:3795` and `eventmanager.html:3816`
- Test: `tests/compact-match-cards.test.js` (create)

- [ ] **Step 1: Write the failing test**

```js
// tests/compact-match-cards.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function bodyOf(fnSignature, endNeedle) {
  const start = html.indexOf(fnSignature);
  assert.notEqual(start, -1, `Missing ${fnSignature}`);
  const end = html.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing end needle after ${fnSignature}`);
  return html.slice(start, end);
}

test('challongeImportOpenMatches pushes collapsed matches (solo + team)', () => {
  const body = bodyOf('async function challongeImportOpenMatches()', '\nlet _challongePollTimer');
  // Every collapsed: literal in the import builder must be true.
  const flags = [...body.matchAll(/collapsed:\s*(true|false)/g)].map(m => m[1]);
  assert.ok(flags.length >= 2, 'expected at least the solo + team push sites');
  assert.ok(flags.every(f => f === 'true'),
    `imported matches must be collapsed; found: ${flags.join(', ')}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="collapsed matches" "tests/compact-match-cards.test.js"`
Expected: FAIL — found `false, false` (the two current import sites).

- [ ] **Step 3: Make the change**

In `eventmanager.html`, both inside `challongeImportOpenMatches`:
- `:3795` change `          collapsed: false,` → `          collapsed: true,`
- `:3816` change `          collapsed: false,` → `          collapsed: true,`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="collapsed matches" "tests/compact-match-cards.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "fix: Challonge-imported matches stay collapsed"
```

### Task 2: Regression-lock collapse defaults for load + merge

**Files:**
- Test: `tests/compact-match-cards.test.js` (append)
- No production change (asserts existing behavior).

- [ ] **Step 1: Write the failing test**

```js
test('loadMatchesFromResults builds matches collapsed', () => {
  const body = bodyOf('function loadMatchesFromResults()', 'function flattenMatchesToResults()');
  const flags = [...body.matchAll(/collapsed:\s*(true|false)/g)].map(m => m[1]);
  assert.ok(flags.length >= 1, 'expected collapse flags in loader');
  assert.ok(flags.every(f => f === 'true'), `loaded matches must be collapsed; got ${flags}`);
});

test('mergeIncomingMatches adds server matches collapsed', () => {
  const body = bodyOf('function mergeIncomingMatches(', '// SUBMIT MATCH');
  // New-from-server and full-replace-fallback must default collapsed true.
  assert.match(body, /sm\.collapsed\s*=\s*true/);
  assert.match(body, /sm\.collapsed\s*=\s*existing\s*\?\s*existing\.collapsed\s*:\s*true/);
});
```

- [ ] **Step 2: Run test to verify it passes immediately (characterization test)**

Run: `node --test --test-name-pattern="collapsed|server matches collapsed" "tests/compact-match-cards.test.js"`
Expected: PASS (these lock current correct behavior at `:3173/:3213/:7649/:7674`).

- [ ] **Step 3: Commit**

```bash
git add tests/compact-match-cards.test.js
git commit -m "test: lock collapsed-by-default for load + merge paths"
```

### Task 3: Submitting a match keeps it collapsed

**Files:**
- Modify: `eventmanager.html:7769`
- Test: `tests/compact-match-cards.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
test('submitMatch leaves the match collapsed (does not auto-expand)', () => {
  // Slice the submit routine (submitMatch:7712 → unsubmitMatch:7813) and assert
  // the collapse line is true, not false.
  const body = bodyOf('async function submitMatch(mid)', 'async function unsubmitMatch(mid)');
  assert.match(body, /toSubmit\.collapsed\s*=\s*true/,
    'submitting should keep the compact row collapsed');
  assert.doesNotMatch(body, /toSubmit\.collapsed\s*=\s*false/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="leaves the match collapsed" "tests/compact-match-cards.test.js"`
Expected: FAIL — current source has `toSubmit.collapsed = false`.

- [ ] **Step 3: Make the change**

`eventmanager.html:7769` change `    toSubmit.collapsed = false;` → `    toSubmit.collapsed = true;`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="leaves the match collapsed" "tests/compact-match-cards.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: submitting a match keeps the compact row collapsed"
```

### Task 4: Pure routing helper `manualMatchScoringTarget`

**Files:**
- Modify: `eventmanager.html` — add marker-wrapped helper just above `createMatch()` (`:4325`)
- Test: `tests/compact-match-cards.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
const vm = require('node:vm');

function loadManualOpen() {
  const start = html.indexOf('// === MANUAL-OPEN-ROUTE START ===');
  const end = html.indexOf('// === MANUAL-OPEN-ROUTE END ===');
  assert.notEqual(start, -1, 'Missing MANUAL-OPEN-ROUTE START marker');
  assert.notEqual(end, -1, 'Missing MANUAL-OPEN-ROUTE END marker');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

test('manualMatchScoringTarget routes a solo match to openLiveModeSolo', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.deepEqual(manualMatchScoringTarget({ id: 7 }),
    { fn: 'openLiveModeSolo', args: [7, 'p1'] });
});

test('manualMatchScoringTarget routes a team match to openLiveMode', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.deepEqual(manualMatchScoringTarget({ id: 9, isTeamMatch: true }),
    { fn: 'openLiveMode', args: [9, 'team1', 0] });
});

test('manualMatchScoringTarget routes a DE self-match to openDeSelfScore', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.deepEqual(manualMatchScoringTarget({ id: 4, _deSelfMatch: true }),
    { fn: 'openDeSelfScore', args: [4] });
  // DE flag wins even though the match is otherwise solo-shaped:
  assert.equal(manualMatchScoringTarget({ id: 4, _deSelfMatch: true }).fn, 'openDeSelfScore');
});

test('manualMatchScoringTarget returns null for a missing match', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.equal(manualMatchScoringTarget(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="manualMatchScoringTarget" "tests/compact-match-cards.test.js"`
Expected: FAIL — "Missing MANUAL-OPEN-ROUTE START marker".

- [ ] **Step 3: Add the helper**

Insert immediately above `async function createMatch() {` at `eventmanager.html:4325`:

```js
// === MANUAL-OPEN-ROUTE START ===
// Pure routing: given a just-created match, decide which scoring entry point
// to open. DE self-matches have no Beyblade battle, so they route to their own
// coin-toss modal before the generic solo path. Team matches use the 3v3 engine.
function manualMatchScoringTarget(match) {
  if (!match) return null;
  if (match.isTeamMatch) return { fn: 'openLiveMode', args: [match.id, 'team1', 0] };
  if (match._deSelfMatch) return { fn: 'openDeSelfScore', args: [match.id] };
  return { fn: 'openLiveModeSolo', args: [match.id, 'p1'] };
}

// Thin dispatcher: looks the target fn up in fnTable (defaults to globalThis) and
// invokes it. Returns true on a clean call, false if no match, no fn, or it threw
// — the caller uses false to fall back to a visible collapsed match + error toast.
function openManualMatchScoring(match, fnTable) {
  const target = manualMatchScoringTarget(match);
  if (!target) return false;
  const table = fnTable || (typeof globalThis !== 'undefined' ? globalThis : {});
  const fn = table[target.fn];
  if (typeof fn !== 'function') return false;
  try { fn.apply(null, target.args); return true; }
  catch (e) { if (typeof console !== 'undefined') console.error('openManualMatchScoring failed:', e); return false; }
}
// === MANUAL-OPEN-ROUTE END ===

```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="manualMatchScoringTarget" "tests/compact-match-cards.test.js"`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: add pure manual-match scoring route resolver"
```

### Task 5: Dispatcher invokes exactly one entry point, with fallback

**Files:**
- Test: `tests/compact-match-cards.test.js` (append) — exercises `openManualMatchScoring` added in Task 4.

- [ ] **Step 1: Write the failing test**

```js
test('openManualMatchScoring calls the solo entry point exactly once', () => {
  const { openManualMatchScoring } = loadManualOpen();
  const calls = [];
  const table = {
    openLiveModeSolo: (...a) => calls.push(['solo', a]),
    openLiveMode:     (...a) => calls.push(['team', a]),
    openDeSelfScore:  (...a) => calls.push(['de', a]),
  };
  const ok = openManualMatchScoring({ id: 3 }, table);
  assert.equal(ok, true);
  assert.deepEqual(calls, [['solo', [3, 'p1']]]);
});

test('openManualMatchScoring routes team + DE without touching solo', () => {
  const { openManualMatchScoring } = loadManualOpen();
  const calls = [];
  const table = {
    openLiveModeSolo: () => calls.push('solo'),
    openLiveMode:     () => calls.push('team'),
    openDeSelfScore:  () => calls.push('de'),
  };
  openManualMatchScoring({ id: 1, isTeamMatch: true }, table);
  openManualMatchScoring({ id: 2, _deSelfMatch: true }, table);
  assert.deepEqual(calls, ['team', 'de']);
});

test('openManualMatchScoring returns false when the entry point throws', () => {
  const { openManualMatchScoring } = loadManualOpen();
  const table = { openLiveModeSolo: () => { throw new Error('modal boom'); } };
  assert.equal(openManualMatchScoring({ id: 5 }, table), false);
});

test('openManualMatchScoring returns false when the fn is missing', () => {
  const { openManualMatchScoring } = loadManualOpen();
  assert.equal(openManualMatchScoring({ id: 6 }, {}), false);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test --test-name-pattern="openManualMatchScoring" "tests/compact-match-cards.test.js"`
Expected: PASS (4 tests — the helper already exists from Task 4).

- [ ] **Step 3: Commit**

```bash
git add tests/compact-match-cards.test.js
git commit -m "test: dispatcher invokes one entry point once, fails safe"
```

### Task 6: Manual create opens scoring after persistence; imports never do

**Files:**
- Modify: `eventmanager.html` — `createMatch()` `:4340-4406`
- Test: `tests/compact-match-cards.test.js` (append) — source-level assertions on `createMatch`.

> Why source-level: `createMatch` awaits real network/DOM helpers that are impractical to stub in `vm`. We unit-test the routing/dispatcher (Tasks 4–5) and assert `createMatch`'s wiring + ordering textually.

- [ ] **Step 1: Write the failing test**

```js
test('createMatch creates matches collapsed and opens scoring after the save await', () => {
  const body = bodyOf('async function createMatch()', '// ROUND FILTER');
  // (a) created matches are collapsed
  const flags = [...body.matchAll(/collapsed:\s*(true|false)/g)].map(m => m[1]);
  assert.ok(flags.length >= 2 && flags.every(f => f === 'true'),
    `manual matches must be created collapsed; got ${flags}`);
  // (b) it captures the created match and opens scoring via the dispatcher
  assert.match(body, /openManualMatchScoring\s*\(/);
  // (c) ordering: the await of the save queue comes BEFORE opening scoring
  const awaitIdx = body.indexOf('await queueCreatedMatchSave()');
  const openIdx  = body.indexOf('openManualMatchScoring');
  assert.ok(awaitIdx !== -1 && openIdx !== -1 && awaitIdx < openIdx,
    'must persist/queue before opening scoring');
});

test('challongeImportOpenMatches does NOT open scoring', () => {
  const body = bodyOf('async function challongeImportOpenMatches()', '\nlet _challongePollTimer');
  assert.doesNotMatch(body, /openManualMatchScoring|openLiveModeSolo|openLiveMode\(|openDeSelfScore/,
    'imports must never auto-open scoring');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="createMatch creates matches collapsed" "tests/compact-match-cards.test.js"`
Expected: FAIL — `createMatch` currently uses `collapsed: false` and has no `openManualMatchScoring`.

- [ ] **Step 3: Implement the change**

In `createMatch()`:
1. Change both `collapsed: false` (`:4350` team, `:4380` solo) → `collapsed: true`.
2. Capture the pushed match. Replace each `matchesState.push({ ... })` with assigning to a local, e.g. wrap as:
```js
   const _created = { /* ...existing object literal... */ collapsed: true };
   matchesState.push(_created);
```
   (Do this for both the team and solo branches; declare `let _created = null;` before the `if (is3v3)`.)
3. After `await queueCreatedMatchSave();` at the end of the function, append:
```js
  // Manual creation only: jump straight into the right scoring flow once the
  // match is persisted-or-safely-queued. On failure leave the collapsed match
  // visible with a clear error. Imports/reloads/live-sync never reach here.
  if (_created) {
    const opened = openManualMatchScoring(_created);
    if (!opened) {
      showToast('⚠️ Match created — open it from the list to start scoring.', '');
      renderResults();
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="createMatch creates matches collapsed|does NOT open scoring" "tests/compact-match-cards.test.js"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: manual match creation opens Live Scoring after persistence"
```

### Task 7: Compact status chip + overflow menu HTML helpers

**Files:**
- Modify: `eventmanager.html` — add marker-wrapped helpers near `submitAreaHtml` (`:4587`)
- Test: `tests/compact-match-cards.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
function loadHeaderHelpers() {
  const start = html.indexOf('// === MATCH-HEADER-HTML START ===');
  const end = html.indexOf('// === MATCH-HEADER-HTML END ===');
  assert.notEqual(start, -1, 'Missing MATCH-HEADER-HTML START marker');
  assert.notEqual(end, -1, 'Missing MATCH-HEADER-HTML END marker');
  const ctx = {
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

test('matchOverflowMenuHtml shows Submit (not Unsubmit) for a pending match', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const out = matchOverflowMenuHtml({ id: 1, submitted: false });
  assert.match(out, /submitMatch\(1\)/);
  assert.doesNotMatch(out, /unsubmitMatch\(/);
  assert.match(out, /removeMatch\(1\)/);
});

test('matchOverflowMenuHtml shows Unsubmit for a submitted match', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const out = matchOverflowMenuHtml({ id: 2, submitted: true });
  assert.match(out, /unsubmitMatch\(2\)/);
  assert.doesNotMatch(out, /submitMatch\(2\)[^a-zA-Z]/);
});

test('matchOverflowMenuHtml shows a Retry item only on push error', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const err = matchOverflowMenuHtml({ id: 3, _challongeMatchId: 'c', _challongePushState: 'error' });
  assert.match(err, /retry/i);
  const ok = matchOverflowMenuHtml({ id: 3, _challongeMatchId: 'c', _challongePushState: 'ok' });
  assert.doesNotMatch(ok, /retry/i);
});

test('matchOverflowMenuHtml Remove item carries the danger class and stops propagation', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const out = matchOverflowMenuHtml({ id: 9, submitted: false });
  assert.match(out, /class="[^"]*mc2-menu-item[^"]*danger[^"]*"[^>]*removeMatch\(9\)/);
  assert.match(out, /event\.stopPropagation\(\)/);
});

test('matchStatusChipHtml reflects submitted / pending / push states', () => {
  const { matchStatusChipHtml } = loadHeaderHelpers();
  assert.match(matchStatusChipHtml({ id: 1, submitted: true }), /submitted/i);
  assert.match(matchStatusChipHtml({ id: 2, submitted: false }), /pending/i);
  assert.match(
    matchStatusChipHtml({ id: 3, _challongeMatchId: 'c', _challongePushState: 'error' }),
    /retry|failed|⚠/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="matchOverflowMenuHtml|matchStatusChipHtml" "tests/compact-match-cards.test.js"`
Expected: FAIL — "Missing MATCH-HEADER-HTML START marker".

- [ ] **Step 3: Add the helpers**

Insert directly below `submitAreaHtml` (after `:4597`):

```js
// === MATCH-HEADER-HTML START ===
// Compact status chip for the collapsed row. Color is paired with a glyph/text
// so state is never conveyed by color alone (WCAG 1.4.1).
function matchStatusChipHtml(match) {
  if (match._challongeMatchId && match._challongePushState === 'pending')
    return `<span class="mc2-status pend">⟳ pushing…</span>`;
  if (match._challongeMatchId && match._challongePushState === 'error')
    return `<span class="mc2-status err">⚠ retry</span>`;
  if (match.submitted)
    return `<span class="mc2-status ok">✓ submitted${match._challongePushState === 'ok' ? ' · pushed' : ''}</span>`;
  return `<span class="mc2-status">pending</span>`;
}

// Overflow-menu body. Submit XOR Unsubmit (Auto-submit countdown stays inline on
// the row via submitAreaHtml). Retry only when a Challonge push errored. Remove
// is always last, red, and still routes through removeMatch()'s confirm dialog.
function matchOverflowMenuHtml(match) {
  const mid = match.id;
  const items = [];
  if (match.submitted) {
    items.push(`<button class="mc2-menu-item" role="menuitem" onclick="event.stopPropagation();toggleMatchMenu(${mid});unsubmitMatch(${mid})">↩ Unsubmit</button>`);
  } else {
    items.push(`<button class="mc2-menu-item" role="menuitem" onclick="event.stopPropagation();toggleMatchMenu(${mid});submitMatch(${mid})">⬆ Submit</button>`);
  }
  if (match._challongeMatchId && match._challongePushState === 'error') {
    items.push(`<button class="mc2-menu-item" role="menuitem" onclick="event.stopPropagation();toggleMatchMenu(${mid});challongeRetryPush(${mid})">⟳ Retry Challonge push</button>`);
  }
  items.push(`<button class="mc2-menu-item danger" role="menuitem" onclick="event.stopPropagation();toggleMatchMenu(${mid});removeMatch(${mid})">✕ Remove match</button>`);
  return `<div class="mc2-menu" id="mc2-menu-${mid}" role="menu" hidden>${items.join('')}</div>`;
}
// === MATCH-HEADER-HTML END ===
```

Also add a small **per-match** retry wrapper next to the existing `challongeRetryFailedPushes()` (`eventmanager.html:3927`) — today's retry is global-by-error and `challongeReportMatch()` takes a match object, so the menu needs a `mid`-friendly entry point:

```js
// Retry the Challonge push for a single match (overflow-menu entry point).
function challongeRetryPush(mid) {
  const m = (matchesState || []).find(x => x.id === mid);
  if (m && m._challongeMatchId) challongeReportMatch(m);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="matchOverflowMenuHtml|matchStatusChipHtml" "tests/compact-match-cards.test.js"`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: compact status chip + overflow menu HTML helpers"
```

### Task 8: Shared compact header + menu toggler

**Files:**
- Modify: `eventmanager.html` — add `compactMatchHeaderHtml` (marker-wrapped, beside Task 7 helpers) and `toggleMatchMenu` (near `toggleMatchCollapse` `:5203`)
- Test: `tests/compact-match-cards.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
test('compactMatchHeaderHtml renders round, both names, ⚡ and ⋯, with tap isolation', () => {
  const { compactMatchHeaderHtml } = loadHeaderHelpers();
  const out = compactMatchHeaderHtml(
    { id: 8, round: 'R1', submitted: false },
    { name1: 'Kenji Watanabe', name2: 'Maximilian Brandt', liveOnClick: "openLiveModeSolo(8,'p1')" }
  );
  assert.match(out, />R1</);
  assert.match(out, /Kenji Watanabe/);
  assert.match(out, /Maximilian Brandt/);
  assert.match(out, /openLiveModeSolo\(8,'p1'\)/);          // ⚡ wired
  assert.match(out, /toggleMatchMenu\(8/);                   // ⋯ wired
  assert.match(out, /toggleMatchCollapse\(8\)/);             // row toggles collapse
  // action group must stop propagation so ⚡/⋯ never toggle collapse
  assert.match(out, /class="mc2-actions"[^>]*onclick="event\.stopPropagation\(\)"/);
  assert.match(out, /aria-label/);                           // a11y labels present
});

test('compactMatchHeaderHtml escapes hostile names', () => {
  const { compactMatchHeaderHtml } = loadHeaderHelpers();
  const out = compactMatchHeaderHtml(
    { id: 1, round: 'R1' },
    { name1: '<img src=x onerror=alert(1)>', name2: 'B', liveOnClick: "x()" });
  assert.doesNotMatch(out, /<img src=x/);
  assert.match(out, /&lt;img/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="compactMatchHeaderHtml" "tests/compact-match-cards.test.js"`
Expected: FAIL — `compactMatchHeaderHtml` is not defined in the slice.

- [ ] **Step 3: Add the header builder + toggler**

Inside the `MATCH-HEADER-HTML` marker block (so the test's `loadHeaderHelpers` picks it up), append before the END marker:

```js
// Shared collapsed/expanded header row for solo, DE, and team cards. The middle
// names column is min-width:0 so long names clamp to two lines instead of
// pushing ⚡/⋯ off-screen. vsGlyph defaults to "VS" (DE cards pass "↔").
function compactMatchHeaderHtml(match, opts) {
  const mid = match.id;
  const vs = opts.vsGlyph || 'VS';
  const caret = match.collapsed ? '▸' : '▾';
  const live = `<button class="mc2-live" aria-label="Open live scoring" title="Open live scoring" onclick="${opts.liveOnClick}">⚡</button>`;
  const more = `<button class="mc2-more" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" title="More actions" onclick="event.stopPropagation();toggleMatchMenu(${mid})">⋯</button>`;
  const inline = (typeof submitAreaHtml === 'function' && _autoSubmit && _autoSubmit.timers && _autoSubmit.timers[mid])
    ? submitAreaHtml(match) : ''; // keep the live countdown visible on the row
  return `
    <div class="mc2-row" onclick="toggleMatchCollapse(${mid})">
      <span class="mc2-caret" aria-hidden="true">${caret}</span>
      <span class="mc2-round">${escHtml(match.round || '')}</span>
      <div class="mc2-names">
        <span class="mc2-name n1">${escHtml(opts.name1)}</span>
        <span class="mc2-vs">${vs}</span>
        <span class="mc2-name n2">${escHtml(opts.name2)}</span>
      </div>
      ${matchStatusChipHtml(match)}
      <div class="mc2-actions" onclick="event.stopPropagation()">
        ${inline}${live}${more}
      </div>
    </div>
    ${matchOverflowMenuHtml(match)}`;
}
```

Then add the toggler next to `toggleMatchCollapse` at `:5203`:

```js
// Open/close one match's overflow menu; closes any other open menu first.
function toggleMatchMenu(mid, ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  if (typeof document === 'undefined') return;
  document.querySelectorAll('.mc2-menu:not([hidden])').forEach(el => {
    if (el.id !== `mc2-menu-${mid}`) el.hidden = true;
  });
  const menu = document.getElementById(`mc2-menu-${mid}`);
  if (menu) {
    menu.hidden = !menu.hidden;
    const trigger = document.querySelector(`#match-${mid} .mc2-more`);
    if (trigger) trigger.setAttribute('aria-expanded', String(!menu.hidden));
  }
}

// Dismiss menus on outside tap / Escape (registered once).
if (typeof document !== 'undefined' && !window.__mc2MenuDismissBound) {
  window.__mc2MenuDismissBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.mc2-menu, .mc2-more')) return;
    document.querySelectorAll('.mc2-menu:not([hidden])').forEach(el => { el.hidden = true; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.mc2-menu:not([hidden])').forEach(el => { el.hidden = true; });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="compactMatchHeaderHtml" "tests/compact-match-cards.test.js"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: shared compact match header + overflow menu toggler"
```

### Task 9: Compact-card CSS system

**Files:**
- Modify: `eventmanager.html` — add `.mc2-*` block after `/* ── MATCH CARDS ── */` (`:356`); update mobile `@media (max-width:600px)` (`:1475-1485`)
- Test: `tests/compact-match-cards.test.js` (append) — assert the CSS exists with touch-target minimums.

- [ ] **Step 1: Write the failing test**

```js
test('compact card CSS defines touch-target minimums and two-line name clamp', () => {
  // ⚡ and ⋯ are at least 40px; names clamp to 2 lines (no horizontal scroll).
  assert.match(html, /\.mc2-live\s*,?\s*\.mc2-more[^}]*min-height:\s*4[0-9]px/);
  assert.match(html, /\.mc2-name[^}]*-webkit-line-clamp:\s*2/);
  assert.match(html, /\.mc2-names[^}]*min-width:\s*0/);
  assert.match(html, /\.mc2-menu-item\.danger/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="compact card CSS" "tests/compact-match-cards.test.js"`
Expected: FAIL — `.mc2-*` rules don't exist yet.

- [ ] **Step 3: Add the CSS**

After `.match-pts-val.has-pts { ... }` (`:489`), insert:

```css
  /* ── COMPACT MATCH CARDS (mc2) ── */
  .mc2-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; background: var(--surface2);
    cursor: pointer; user-select: none;
  }
  .mc2-caret { color: var(--muted2); font-size: 11px; flex-shrink: 0; }
  .mc2-round {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    padding: 2px 6px; border-radius: 3px; flex-shrink: 0;
    background: rgba(212,175,55,0.12); color: var(--gold);
  }
  .mc2-names {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; line-height: 1.15;
  }
  .mc2-name {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 700;
    font-size: 14px; letter-spacing: .5px;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    overflow: hidden; text-overflow: ellipsis;
  }
  .mc2-name.n1 { color: var(--blue); }
  .mc2-name.n2 { color: var(--gold2); }
  .mc2-vs { font-size: 9px; color: var(--muted2); letter-spacing: 1px; margin: 1px 0; }
  .mc2-status {
    font-family: 'Share Tech Mono', monospace; font-size: 9px;
    color: var(--muted); white-space: nowrap; flex-shrink: 0;
  }
  .mc2-status.ok   { color: var(--green); }
  .mc2-status.err  { color: var(--red); }
  .mc2-status.pend { color: var(--muted); }
  .mc2-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .mc2-live, .mc2-more {
    min-height: 40px; min-width: 40px;
    display: flex; align-items: center; justify-content: center;
    border: none; border-radius: 6px; cursor: pointer; font-size: 16px;
    background: rgba(74,158,255,0.15); color: var(--blue);
    touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  }
  .mc2-more { background: transparent; color: var(--muted2); font-size: 18px; }
  .mc2-menu {
    display: flex; flex-direction: column;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; overflow: hidden; margin: 0 10px 8px;
  }
  .mc2-menu-item {
    text-align: left; background: transparent; border: none;
    color: var(--accent); font-size: 13px; padding: 11px 12px; min-height: 44px;
    cursor: pointer; border-bottom: 1px solid var(--border);
  }
  .mc2-menu-item:last-child { border-bottom: none; }
  .mc2-menu-item.danger { color: var(--red); }
  @media (hover: hover) {
    .mc2-row:hover { background: var(--surface3); }
    .mc2-menu-item:hover { background: var(--surface2); }
  }
```

Then replace the mobile match-header overrides (`:1475-1480`) with compact-aware rules:

```css
    /* COMPACT MATCH CARD — names get two lines, actions stay on the row */
    .mc2-row { gap: 6px; padding: 8px; }
    .mc2-name { font-size: 13px; }
    .mc2-round { font-size: 8px; }
    .mc2-live, .mc2-more { min-height: 44px; min-width: 44px; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="compact card CSS" "tests/compact-match-cards.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: compact match-card CSS system with touch-target minimums"
```

### Task 10: Wire the solo card to the compact header

**Files:**
- Modify: `eventmanager.html` — `renderMatchCard()` header block `:4739-4756`
- Test: `tests/compact-match-cards.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
test('renderMatchCard collapsed solo uses the compact header (no legacy live-btn/Remove text)', () => {
  const body = bodyOf('function renderMatchCard(match)', 'function renderDeSelfMatchCard');
  assert.match(body, /compactMatchHeaderHtml\(/);
  assert.doesNotMatch(body, /✕ Remove/);            // remove text moved to menu
  assert.doesNotMatch(body, /class="btn live-btn"/); // legacy header live button gone
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="renderMatchCard collapsed solo" "tests/compact-match-cards.test.js"`
Expected: FAIL — `renderMatchCard` still emits the legacy header.

- [ ] **Step 3: Replace the solo header**

In `renderMatchCard()` replace the header `<div style="display:flex;...border-bottom...">…</div>` block (the outer flex wrapper containing `.match-card-header` and `.live-btn`, `:4741-4756`) with:

```js
    return `
    <div class="match-card" id="match-${mid}">
      ${compactMatchHeaderHtml(match, {
        name1: p1Label, name2: p2Label, vsGlyph: 'VS',
        liveOnClick: `openLiveModeSolo(${mid},'p1')`
      })}
      ${match.collapsed ? '' : `
      <div class="match-card-body">
        ${renderPlayerSide(match, 'p1', mid)}
        ${match.p2 ? renderPlayerSide(match, 'p2', mid) : ''}
      </div>`}
    </div>`;
```

(`p1Label`/`p2Label`/`summary` computed above stay; `summary` is now surfaced via `matchStatusChipHtml`, so the old `summary` local may be removed if unused — leave it if other code references it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="renderMatchCard collapsed solo" "tests/compact-match-cards.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: solo match card uses compact header"
```

### Task 11: Wire the DE self-match card to the compact header

**Files:**
- Modify: `eventmanager.html` — `renderDeSelfMatchCard()` header `:4790-4808`
- Test: `tests/compact-match-cards.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
test('renderDeSelfMatchCard uses the compact header and routes ⚡ to openDeSelfScore', () => {
  const body = bodyOf('function renderDeSelfMatchCard(match)', 'function mSelectDeWinner');
  assert.match(body, /compactMatchHeaderHtml\(/);
  assert.match(body, /openDeSelfScore\(\$\{mid\}\)/);
  assert.match(body, /vsGlyph:\s*'↔'/);                  // DE uses the ↔ glyph
  assert.doesNotMatch(body, /class="btn live-btn"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="renderDeSelfMatchCard uses the compact" "tests/compact-match-cards.test.js"`
Expected: FAIL.

- [ ] **Step 3: Replace the DE header**

In `renderDeSelfMatchCard()` replace the header wrapper (`:4791-4808`, the `<div style="display:flex...">…<button ... openDeSelfScore>⚡</button></div>`) with:

```js
  return `
  <div class="match-card" id="match-${mid}">
    ${compactMatchHeaderHtml(match, {
      name1: p1Label, name2: p2Label, vsGlyph: '↔',
      liveOnClick: `openDeSelfScore(${mid})`
    })}
    ${match.collapsed ? '' : `
    <div style="padding:12px 14px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
        Coin toss result — tap ⚡ to enter scores. No Beyblade battle.
      </div>
      ${(p1wins || p2wins) ? `
        <div style="font-size:13px">${winnerLine}</div>` : `<div style="font-size:12px;color:var(--muted2)">No scores entered yet.</div>`}
    </div>`}
  </div>`;
```

(The `summary`/`winnerLine` locals above are retained for the expanded body.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="renderDeSelfMatchCard uses the compact" "tests/compact-match-cards.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: DE self-match card uses compact header"
```

### Task 12: Wire the team card to the compact header (collapsed + expanded)

**Files:**
- Modify: `eventmanager.html` — `renderTeamMatchCard()` both header blocks (`:4967-4986` collapsed, `:5006-5022` expanded)
- Test: `tests/compact-match-cards.test.js` (append)

- [ ] **Step 1: Write the failing test**

```js
test('renderTeamMatchCard uses the compact header and routes ⚡ to openLiveMode team1', () => {
  const body = bodyOf('function renderTeamMatchCard(match)', 'function renderTeamMemberSide');
  const count = (body.match(/compactMatchHeaderHtml\(/g) || []).length;
  assert.ok(count >= 2, 'both collapsed and expanded branches use the compact header');
  assert.match(body, /openLiveMode\(\$\{mid\},'team1',0\)/);
  assert.doesNotMatch(body, /class="btn live-btn"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="renderTeamMatchCard uses the compact" "tests/compact-match-cards.test.js"`
Expected: FAIL.

- [ ] **Step 3: Replace both team headers**

Collapsed branch (`:4968-4986`) becomes:

```js
  if (match.collapsed) {
    return `
    <div class="match-card" id="match-${mid}">
      ${compactMatchHeaderHtml(match, {
        name1: t1.teamName, name2: t2.teamName, vsGlyph: 'VS',
        liveOnClick: `openLiveMode(${mid},'team1',0)`
      })}
    </div>`;
  }
```

Expanded branch header (`:5006-5022`, the flex wrapper with `.match-card-header` + `.live-btn`) becomes just:

```js
  return `
  <div class="match-card" id="match-${mid}">
    ${compactMatchHeaderHtml(match, {
      name1: t1.teamName, name2: t2.teamName, vsGlyph: 'VS',
      liveOnClick: `openLiveMode(${mid},'team1',0)`
    })}
    <!-- Team name headers -->
    <div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border)">
```

(leave the rest of the expanded body — team-name sub-headers, per-slot rows, totals — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="renderTeamMatchCard uses the compact" "tests/compact-match-cards.test.js"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add eventmanager.html tests/compact-match-cards.test.js
git commit -m "feat: team match card uses compact header"
```

### Task 13: Nested-action tap safety (collapse not toggled by inner buttons)

**Files:**
- Test: `tests/compact-match-cards.test.js` (append) — source-level guarantee.

- [ ] **Step 1: Write the failing/characterization test**

```js
test('every interactive control inside the compact header stops propagation', () => {
  const { compactMatchHeaderHtml, matchOverflowMenuHtml } = loadHeaderHelpers();
  const header = compactMatchHeaderHtml(
    { id: 5, round: 'R1', submitted: false },
    { name1: 'A', name2: 'B', liveOnClick: "openLiveModeSolo(5,'p1')" });
  const menu = matchOverflowMenuHtml({ id: 5, submitted: false });
  // Only the row itself may call toggleMatchCollapse; the actions wrapper isolates taps.
  assert.match(header, /class="mc2-actions"[^>]*event\.stopPropagation\(\)/);
  // Every menu-item button stops propagation before its action.
  for (const m of menu.matchAll(/<button class="mc2-menu-item[^"]*"[^>]*onclick="([^"]*)"/g)) {
    assert.match(m[1], /^event\.stopPropagation\(\)/, `menu item must stopPropagation first: ${m[1]}`);
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test --test-name-pattern="stops propagation" "tests/compact-match-cards.test.js"`
Expected: PASS (helpers from Tasks 7–8 already satisfy this).

- [ ] **Step 3: Commit**

```bash
git add tests/compact-match-cards.test.js
git commit -m "test: nested header controls never toggle collapse"
```

### Task 14: Full-suite green + manual verification

**Files:**
- No code change unless a regression surfaces.

- [ ] **Step 1: Run the entire suite**

Run: `node --test "tests/*.test.js"`
Expected: ALL PASS — including the pre-existing `challonge-import`, `eventmanager-sync-regression`, and `challonge-build-hydration` suites.

- [ ] **Step 2: Manual browser verification (preview tools)**

Start the preview and verify the observable behavior:
1. Create a solo match → New Match modal closes and Live Scoring opens exactly once; the list behind shows the match collapsed (not expanded). `preview_screenshot`.
2. Create a team match → team Live Scoring (`openLiveMode`) opens.
3. Create a DE self-match (same account, different entry) → DE coin-toss modal opens, not normal Live Scoring.
4. Trigger a Challonge import (or simulate) → matches appear collapsed, no scoring modal opens.
5. Reload the event → all matches collapsed.
6. At a 320px viewport (`preview_resize`), a match with two long names shows both names (two-line clamp), ⚡ and ⋯ still tappable, no horizontal scroll. `preview_inspect` ⚡/⋯ to confirm ≥40px.
7. Open ⋯ → Submit/Remove present; tap outside / Escape closes it; tapping ⋯ does not toggle the card. Submit a match → it stays collapsed with a "submitted" chip.

- [ ] **Step 3: Commit any fixes, then finalize**

```bash
git add -A
git commit -m "test: full compact-match-card suite green + manual verification notes"
```

---

## Self-Review (against the brief)

- **Compact, minimalist rows; collapsed by default** → Tasks 9–12 (compact header) + Tasks 1–3 (collapse defaults). ✓
- **Collapsed prioritizes round/Name1/VS/Name2/status/⚡** → Task 8 `compactMatchHeaderHtml`. ✓
- **Reduce borders/labels; Submit/Remove → icons/overflow** → Tasks 7–9 (`⋯` menu, `.mc2-*`). ✓
- **Destructive action guarded** → Remove is last/red/in-menu, keeps `confirm()` (Task 7). ✓
- **Names two-line at 320px, no horizontal scroll** → `.mc2-name` clamp + `min-width:0` (Task 9), verified Task 14. ✓
- **Color for identity/state, not every outline** → status chip + glyphs (Task 7). ✓
- **Submitted/pending/push/winner/auto-submit states** → `matchStatusChipHtml` + inline `submitAreaHtml` countdown (Tasks 7–8). ✓
- **Expanded body still available** → bodies reused verbatim (Tasks 10–12). ✓
- **Manual create → open Live Scoring once; team/DE routed; imports/reload/sync stay collapsed** → Tasks 1, 4–6. ✓
- **Persistence before scoring** → open after `await queueCreatedMatchSave()` (Task 6). ✓
- **Open-failure leaves match usable** → dispatcher returns false → toast + collapsed match (Tasks 5–6). ✓
- **Nested taps don't toggle collapse** → Task 13. ✓
- **Keyboard/aria/tooltips, no hover dependency** → real buttons + `aria-label`/`aria-expanded`/Escape (Task 8); hover is `@media (hover:hover)` enhancement only (Task 9). ✓
- **DE self-match uses same visual language** → Task 11. ✓
- **Existing tests stay green** → Task 14. ✓

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-05-compact-mobile-match-cards.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task with review between tasks.

**2. Inline Execution** — execute tasks in this session with checkpoints.

Per the original request, implementation is **out of scope for now** — stop here until you decide to proceed.
