# Live Scoring — Always-Live Event Manager

**Date:** 2026-06-03
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude

## Problem

The event manager currently behaves like each phone holds its own copy of a
match. Individual score taps (O / X) stay local on the scoring phone until a
**winner** is detected (the 4s auto-submit countdown) or the judge presses
**Submit**. Only then does the result reach the server and propagate to other
devices. localStorage drafts are restored on reload and treated as a source of
truth, which reinforces the "local save per phone" feel.

The user wants it to behave like a live broadcast: **every action goes live on
its own.** Create a match → it appears on all phones within a few seconds.
Click O on a live match → every phone shows the score within a few seconds.
Delete a match → it disappears everywhere within a few seconds. No phone should
depend on its own local copy as the truth; the server is always authoritative.
localStorage should exist only as an offline safety buffer that auto-pushes when
the connection returns.

## Goals

- Each scoring mutation (O/X tap, finish-type change) pushes to the server on
  its own, without waiting for a winner.
- In-progress (not-yet-submitted) scores propagate to **all** phones via the
  existing live-sync poll, so a tap shows up everywhere within ~3s.
- localStorage is repurposed as an **offline outbox**: it holds changes the
  server has not yet acknowledged, and is cleared once the server echoes them
  back. It is never restored as a competing "truth" while online.
- When a phone reconnects after losing internet, any queued un-pushed scores
  flush to the server automatically.
- Must stay on the Cloudflare **free** tier. No paid plan, no new paid service.

## Non-Goals

- Replacing the 3s polling with WebSockets (a possible future "instant" upgrade,
  Approach B — out of scope here).
- Multi-judge simultaneous editing of the **same** match with field-level merge.
  We use last-write-wins per match (see Conflict Handling).
- Changing the winner auto-submit feature — it continues to work unchanged on
  top of the new live-push.

## Current Architecture (as built)

- **Authoritative store:** SQLite-backed Durable Object `BeyStateDO`
  (`workers/bey-state-do`), reached through the Pages Function at
  `/api/beyresults`. Free-tier eligible.
- **Live sync:** `doLiveSync()` polls `GET /api/beyresults?eventId=…` every 3s
  (`startLiveSync`, `eventmanager.html:6149`), fingerprints the payload, and
  calls `mergeIncomingMatches()` to fold in changes.
- **Push path:** `submitMatch(mid)` (`eventmanager.html:6410`) does
  fetch-latest → `mergeIncomingMatches` → build merge-PUT body
  (`buildMergePutBody`) → `PUT /api/beyresults`, with conflict detection. It
  marks the match `submitted = true`. Triggered by manual Submit or winner
  auto-submit.
- **Create push:** `queueCreatedMatchSave()` (`eventmanager.html:6092`) already
  pushes new matches immediately, serialized through `_createMatchSaveQueue`.
- **Delete push:** `removeMatch()` (`eventmanager.html:4031`) already pushes the
  deletion immediately and records it in `_pendingDeletedSids`.
- **Merge guard:** `mergeIncomingMatches()` (`eventmanager.html:6230`). When
  `dirty` is true it adds new server matches and adopts server payload **only
  for submitted matches** (`sm.submitted || local.submitted`). In-progress
  scores from the server are NOT adopted today.
- **Edit pause:** `_syncPaused` is set true during active edits (inline bey-name
  edit, modal open, submit, queued create) so a poll can't overwrite mid-action.
- **Local save:** `localAutoSave()` / `localLoadDraft()` (`eventmanager.html:2407`)
  store per-event drafts (`rxs_em_draft_<id>`) and restore on reload.
- **Network UI:** `updateNetworkStatus()` (`eventmanager.html:7155`) shows
  "OFFLINE — SAVING LOCALLY"; `online`/`offline` listeners
  (`eventmanager.html:7188`) currently only update the indicator — no re-push.

## Design (Approach A — Live per-match push)

### 1. Debounced live-push on every score change

Add `pushMatchLive(match)` — a lightweight push that persists a single match's
**current** state to the server WITHOUT setting `submitted = true`. It reuses
`flattenMatchesToResults()` + `buildMergePutBody()` + `PUT /api/beyresults`
(merge mode), exactly like `submitMatch` but without the submitted flag and
without the "no winner yet?" confirm.

Hook it into the scoring mutation points in Live Mode (the O/X tap handler and
finish-type change, around `lmRender` / `lmUpdateScoreBar`,
`eventmanager.html:5175`+). After a mutation:

- Mark an `_inFlightMatchSid` / per-match "active editing" marker so merge knows
  not to clobber this match while the judge is still tapping.
- Schedule `pushMatchLive` after an ~800ms debounce keyed by match sid. Rapid
  O-O-O taps coalesce into one push (request-count control for free tier).
- The push runs serialized through the existing `_createMatchSaveQueue`-style
  queue so concurrent pushes don't race.

The winner auto-submit countdown is unchanged; if it fires, `submitMatch`
supersedes the live-push (it already calls `_clearAutoSubmitTimer`).

### 2. Propagate in-progress scores in the merge

Extend `mergeIncomingMatches()` so that, for a match the local phone is **not**
actively editing (`_syncPaused` false and the match's sid is not the
active/in-flight one), the server's score state is adopted **even when not
submitted** — not just when `sm.submitted || local.submitted`.

The phone currently scoring a match is protected by:
- `_syncPaused` (whole-poll skip during an active edit), and
- the active-match sid marker (so even outside a paused window, the match being
  tapped is not overwritten by an older server snapshot).

Result: a tap on phone A reaches the server within ~800ms and shows on phones
B/C on their next 3s poll.

### 3. localStorage as offline outbox

Reframe the local draft as an **outbox of un-acked changes**:

- Online: `localAutoSave()` still writes the working state, but entries are
  considered pending only until the server echoes the corresponding sid/state
  back (reusing `confirmPendingMatchesSaved` / `sidsFromServerPayload`). The
  draft is NOT treated as authoritative — server payload always wins in merge.
- Offline: the outbox accumulates the queued match changes; the existing
  "OFFLINE — SAVING LOCALLY" banner communicates this.
- On reload while online: server state is fetched and wins; a local draft is
  only used to recover changes whose sids the server does not yet have.

### 4. Auto-flush on reconnect

Extend the `online` event handler (`eventmanager.html:7188`) to call a new
`flushOutbox()` that pushes every queued/un-acked match to the server. Because
mobile browsers fire `online` unreliably, also run a lightweight periodic flush
check (e.g. piggybacked on `doLiveSync`: if there are un-acked matches and we
are `navigator.onLine`, attempt a flush) so a stuck queue always recovers.

Each flushed match goes through the same `pushMatchLive` / merge-PUT path, so
conflict detection and server-observed acknowledgement apply identically.

### 5. Conflict handling — last-write-wins per match

If two devices push the same match sid close together, the later PUT wins (the
merge-PUT mode on the server already serializes writes per event in the DO).
In normal use one judge owns one match, so contention is rare. We do not
implement field-level merge. `submitMatch` keeps its existing "already submitted
on another device" conflict toast for the submit case.

## Data Flow (score tap, happy path)

1. Judge taps O on phone A → local match state updates, `lmRender` repaints.
2. Active-match marker set for that sid; `pushMatchLive` scheduled (+800ms).
3. Debounce elapses → serialized `PUT /api/beyresults` (merge mode, not
   submitted) → DO persists → response echoes the sid.
4. Outbox entry for that sid cleared on ack.
5. Phones B/C `doLiveSync` poll (≤3s) → payload hash changes →
   `mergeIncomingMatches` adopts the in-progress score (they are not editing it)
   → score appears.

## Offline → online flow

1. Phone A loses internet → `offline` event → banner shows "OFFLINE — SAVING
   LOCALLY". Taps still update local state and accumulate in the outbox; pushes
   fail and stay queued.
2. Internet returns → `online` event (and/or periodic flush check) →
   `flushOutbox()` pushes every queued match → server acks → outbox cleared →
   other phones pick up the changes on their next poll.

## Error Handling

- **Push fails (offline / 5xx):** match stays in the outbox; banner reflects
  offline; periodic flush + `online` event retry. No data loss.
- **Submit conflict:** existing "already submitted on another device" path in
  `submitMatch` is preserved.
- **Reload mid-edit:** server fetch wins; outbox recovers only sids the server
  lacks, preventing a stale local copy from resurrecting deleted/older state.
- **Rapid taps:** debounce coalesces; only the latest state is pushed.

## Cost / Free-Tier Analysis

- DO is SQLite-backed (`new_sqlite_classes`), included on the **free** Workers
  plan. No paid plan required.
- Free Worker request budget ≈ 100k/day. Polling at 3s ≈ 1,200 req/hr/phone;
  an 8-phone, 4-hour event ≈ ~38k requests + bounded writes — under budget.
- The ~800ms debounce caps push volume from rapid scoring so per-event request
  count stays well within free limits.
- No new paid service is introduced. **Free forever at tournament scale.**

## Testing Strategy

- **Unit (merge):** extend `tests/eventmanager-sync-regression.test.js` —
  in-progress (non-submitted) server score is adopted for a match the local
  phone is not editing; the actively-edited match is NOT clobbered while
  `_syncPaused` / active-match marker is set.
- **Outbox/flush:** un-acked match is retained while offline and pushed on
  reconnect; ack clears the outbox entry; a sid echoed by the server clears its
  pending flag.
- **Integration:** `tests/integration/do-integration.test.js` — a non-submitted
  live-push round-trips through the DO and is returned to a second reader.
- **Manual:** two phones, one event — tap O on A, confirm B shows it within ~3s;
  airplane-mode A mid-score, tap, re-enable, confirm the queued score flushes.

## Open Questions

None blocking. Future: Approach B (WebSocket via DO hibernation) for sub-second
updates and lower request count.
