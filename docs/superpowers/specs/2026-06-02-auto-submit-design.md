# Auto-Submit on Winner Detection — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)

## Problem

In multi-device tournament use, every completed match requires a judge to tap
**⬆ Submit** to record it. Across 4–6 phones this is friction and a source of
forgotten/unsubmitted matches. The app already auto-detects the winner (ticks
the ✓ when a player/team crosses the points threshold) but never records it
automatically.

## Goal

When scoring produces an unambiguous winner, the match records itself after a
short, cancelable countdown — no Submit tap needed — while keeping every
existing safety property (DO-serialized writes, Unsubmit, concurrency
protection).

## Behavior

### Trigger
After any **local** scoring change that leaves a match with exactly one
decisive winner, a 4-second countdown starts on that match card:

```
⏳ Auto-submit 4s · Cancel   (counts 4 → 3 → 2 → 1)
```

"Local scoring change" = the three places the judge mutates a match's finishes:
1. Tap-to-score picker confirm (`pickFinish` end, ~line 4256)
2. Finish removal / un-score (~lines 4016, 4164)
3. Live Mode commit (`lmCommitAndClose`, ~line 5407)

It is **not** triggered from `renderResults` itself, `mergeIncomingMatches`,
event load, or live-sync — so opening an event full of already-won-but-
unsubmitted matches, or receiving another device's win, never mass-submits.

### Decisive-winner rule (`matchHasDecisiveWinner`)
- **Solo:** exactly one of `p1.win` / `p2.win` is true.
- **Team:** mirrors the card's WIN summary —
  - Topcut (TC/QF/SF/F): `max(t1wins, t2wins) >= 2`.
  - Regular (R1–R7): every member has played (`win || pts>0`) **and**
    `t1wins !== t2wins`.

No decisive winner → any running countdown for that match is canceled.

### Cancel / reset (idempotent `evaluateAutoSubmit(mid)`)
`evaluateAutoSubmit(mid)` is called after every local scoring change. It:
1. Clears any existing timer for `mid`.
2. Returns (leaving it canceled) if: toggle off, match already submitted, or no
   decisive winner.
3. Otherwise starts a fresh 4 s countdown.

This makes every score edit "reset" the timer naturally, and an un-score that
removes the winner cancels it. The **Cancel** button calls
`cancelAutoSubmit(mid)`. `unsubmitMatch` and `removeMatch` also cancel.

### Firing
At 0 s the countdown calls the existing `submitMatch(mid)` unchanged — same
fetch-merge-push path, same DO serialization, same `_pendingServerSave`
handling. Auto-submit is purely a UI affordance in front of the existing
submit; it changes no server contract.

### Safety toggle
A `Auto-submit ✓` checkbox in the Match Results toolbar (next to **New
Match**), persisted in `localStorage` (`rxs_autosubmit`, default **ON**). Turning
it off cancels all running countdowns and restores manual **⬆ Submit** buttons.
Per-device so one judge can opt out without affecting others.

### Recoverability
Two escape hatches: **Cancel** during the 4 s, and the existing **↩ Unsubmit**
after it fires.

## Implementation notes

- Centralize the submit/unsubmit/countdown button into one
  `submitAreaHtml(match)` helper, replacing the three duplicated inline blocks
  (solo card 3611–3613, team collapsed 3686–3688, team expanded 3724–3726).
- Countdown state: `_autoSubmit = { enabled, timers: { [mid]: { remaining,
  intervalId } } }`. The per-second tick updates the button text by
  `getElementById('autosubmit-btn-'+mid)` (survives re-renders, which recreate
  the element with the same id).
- Bundle: bump PWA cache so phones pull the new HTML — `APP_VERSION`
  (eventmanager.html:2081) and `CACHE_VERSION` (sw.js:5) `rxs-em-v13 → v14`.
- Also ships with the already-made concurrency fix (non-dirty full-replace
  pending-match protection) on this branch.

## Testing

Node `--test`, mirroring the existing `vm`-based harness:
1. Solo: exactly one winner → `evaluateAutoSubmit` arms a timer.
2. No winner / draw / both below threshold → no timer.
3. Team topcut (2 wins) → arms; regular round decided → arms; tied → no.
4. Cancel stops the timer; toggle OFF → never arms and cancels existing.
5. Un-score that removes the winner cancels the timer.
6. Timer fire calls `submitMatch`.
7. All 47 existing tests stay green.

## Out of scope (YAGNI)

- Configurable countdown duration (fixed 4 s).
- Per-match auto-submit override (global toggle only).
- Server-side changes (none — the submit path is untouched).
