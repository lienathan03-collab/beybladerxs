# Challonge ↔ EventManager Sync

**Date:** 2026-06-04
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude

## Problem

At a live event, matches are created in `eventmanager.html` by hand. A co-judge
opens the New Match modal, searches both players, creates the card, finds it in a
long list, taps the ⚡ lightning to go live, then scores. Separately, the same
pairings already exist in **Challonge** (the bracket software that randomly pairs
players each round), and after a match is scored someone **re-enters the result in
Challonge** so it will generate the next round.

This is double work and it is slow:

- With ~70 players, a Swiss round is ~35 matches. Creating each by hand, across 4
  stadiums and multiple judges, is the bottleneck.
- After scoring in eventmanager, results are re-typed into Challonge to advance the
  bracket — manual, error-prone, and the thing gating the next round.
- New cards land at the **bottom** of a long list, so judges scroll to find the
  match for the players at their stadium.

The user wants Challonge and eventmanager connected so pairings flow **in**
automatically and final scores flow **back out** automatically — closing the loop
so Challonge generates the next round on its own.

## Goals

- Link an eventmanager event to **one** Challonge tournament via a Settings tab.
- **Map once, up front:** resolve every Challonge participant to a roster entry
  (solo) or roster team (3v3) at link time, so every imported match already has
  the right players/teams **and** their decks.
- **Import (read):** auto-poll Challonge and create match cards for every `open`
  pairing; a whole Swiss round (~35) lands in one pull. Manual "Sync" button as a
  fallback.
- Imported matches are **normal, fully editable** cards. The manual **"New Match"**
  button is unchanged.
- **Find-my-match:** a search/filter above the cards (by **division + round +
  player name**) so a judge instantly narrows 35+ cards to theirs.
- **Write-back (write):** when a match is finalized in eventmanager, push its result
  to Challonge (score + winner), which completes the round and triggers the next
  one — auto-imported back in. Each card shows a push-status chip.
- **Per-event Challonge account**, hybrid key handling (pick a named server-side
  account, or a custom key stored on the event).
- Multi-judge safe: imported matches replicate through the existing live-push path.
- Stay on the Cloudflare **free** tier; no new paid service.

## Non-Goals

- Linking **multiple** Challonge tournaments to one event. Divisions come from a
  single tournament's **group stage**, not separate tournaments.
- 3v3 **Double Entry** (DE does not exist in team play).
- Adaptive poll cadence ("speed up when few matches remain") — steady interval is
  enough; can add later.
- Replacing the manual New Match flow — it stays as the fallback/override.
- Editing the Challonge bracket structure from eventmanager (we only read pairings
  and write match results).

## Current Architecture (relevant pieces)

- **Challonge proxy (read-only):** Pages Function `functions/api/challonge.js`
  forwards to an external Vercel proxy (`env.CHALLONGE_PROXY_URL` /
  `CHALLONGE_PROXY_URL_S3`, chosen by `?season=`). Supports `action=list`,
  `action=participants&tournament_id=…`, `action=matches&tournament_id=…`.
  CORS allows **GET, OPTIONS only** — there is **no write path** today
  (`functions/api/challonge.js:3`, `:33-38`).
- **Challonge match shape** (proven in `index.html:3253`): each entry is
  `{ match: { id, player1_id, player2_id, winner_id, state, round, scores_csv,
  group_id, … } }`. `state` is `pending | open | complete`. `scores_csv` stores
  the higher score first.
- **Participant → player mapping** already done on the public site
  (`index.html:3244-3248`): match participant `display_name`/`name` to a roster
  player.
- **Roster entries:** `getPlayers()` yields
  `{ name, displayLabel, entryId, entryType: 'main' | 'double', team, builds }`,
  deduped by `entryId`; DE is `entryType: 'double'` with its own `builds`
  (`eventmanager.html:2372-2399`).
- **Teams (3v3):** `currentEvent.joiners` entries of `type:'team'` with `teamName`
  and `members` (`eventmanager.html:3271-3275`).
- **Match creation:** `createMatch()` pushes a match onto `matchesState` with a
  stable `_sid`, calls `flattenMatchesToResults()` + `markDirty()` + a queued
  live-push save (`eventmanager.html:3528-3603`).
- **Go live:** `openLiveModeSolo(mid, side)` (`:4548`) and
  `openLiveMode(mid, teamKey, memberIdx)` (`:4588`) open the live scoring overlay
  for a match id. Commit is `lmCommitAndClose()` (`:5678`); close is
  `closeLiveMode()` (`:4714`).
- **Live sync / multi-judge:** `startLiveSync()` polls `/api/beyresults` and folds
  in changes; imported matches must funnel through the same `createMatch`/save path
  so all judges receive them.
- **Round filter:** existing pill row `#round-filter-row` + `setRoundFilter()` /
  `renderRoundFilter()` (`eventmanager.html:1696`, `:3608-3617`).
- **Same-owner rule:** solo `Ken vs Ken (DE)` matches are intentionally **not**
  recorded in eventmanager — DE advancement is recorded in Challonge
  (`eventmanager.html:6934`, `:6953`).

## Design

### 1. Challonge Settings tab (per-event, hybrid keys)

- New tab/panel in eventmanager: **"Challonge Sync"**, with a live connection-status
  indicator (mirror the `connected`/`error` style at `index.html:914`).
- **Account picker:** choose from named, server-side accounts. The Pages Function
  is extended from two fixed URLs to a **named map** of accounts (e.g. env
  `CHALLONGE_ACCOUNTS` JSON, or `CHALLONGE_PROXY_URL_<NAME>` convention), each
  resolving to a proxy URL + key kept server-side.
- **Optional custom key:** a "use a custom API key for this event" field for one-off
  accounts. Stored on the event record (`currentEvent.challongeCustomKey`), clearly
  flagged in the UI as a stored secret. Passed to the Function over HTTPS; the
  Function uses it instead of a named account.
- Selection is **per-event**: `currentEvent.challongeAccount` (named) **or**
  `currentEvent.challongeCustomKey` (custom), persisted with the event.
- **Tournament link:** after an account is chosen, `action=list` populates a
  dropdown; the chosen tournament is saved as `currentEvent.challongeTournamentId`.

### 2. Connect & map once

On connect, fetch `action=participants` and build a saved
`participantId → { entryId | teamName }` map stored on the event
(`currentEvent.challongeParticipantMap`).

**Solo events** (`currentEvent.type !== '3v3'`):
- Auto-match each participant `display_name`/`name` to a roster entry:
  exact → case-insensitive → **trailing-number (DE) rule**. `"Lienathan 1"` → that
  person's `main` entry; `"Lienathan 2"` → their `double` entry. Base name is the
  string minus a trailing ` <n>`.
- A **one-time mapping screen** lists only unmatched participants, each with a
  dropdown of roster entries to resolve by hand.

**3v3 events** (`currentEvent.type === '3v3'`):
- Each participant is a **team**; auto-match participant name → roster `teamName`
  (exact → case-insensitive). No DE.
- Same one-time mapping screen for unmatched teams.

**Divisions (3v3 group stage):** if the tournament has a group stage, participants
carry `group_player_ids` and matches carry `group_id`. Build a
`group_id → divisionLabel` map (fetch group/group-stage data; fall back to
"Group 1/2" if Challonge has no human label). Solo events have no group layer.

### 3. Phase 1 — Import pairings (read)

- **Trigger:** background poll every ~20–30s while an event is linked, **plus** a
  manual **"Sync from Challonge"** button. (Independent of the existing
  `/api/beyresults` live-sync; this one hits `action=matches`.)
- **Selection:** import every match with `state === 'open'`. In Swiss, an entire
  round flips to `open` together, so one pull yields the whole round.
- **Dedup:** store `challongeMatchId` on each created match. Never create one that
  already exists; on re-poll, only add new `open` matches.
- **Creation:** build the match through the same path `createMatch()` uses:
  - Solo → `{ p1, p2 }` from the mapped roster entries (carry `entryId`,
    `entryType`, `displayLabel`, `builds`).
  - 3v3 → `{ isTeamMatch:true, team1, team2 }` from the mapped roster teams.
  - Set `round = "R" + match.round` (Swiss is linear: R1, R2, R3…).
  - Tag `_challongeMatchId`, `_challongeGroupId`/`division` (3v3), `_pendingServerSave`.
  - Funnel through `flattenMatchesToResults()` + `markDirty()` + the queued
    live-push save so all judges receive it.
- **Same-owner skip:** if a solo pairing resolves to the same owner on both sides
  (`Lienathan 1` vs `Lienathan 2`), **do not** create the card — consistent with the
  existing rule (`eventmanager.html:6934`).
- **Unmapped safety net:** if a pairing references a participant missing from the
  map, create the card but flag it `⚠ pick player` for on-the-spot resolution.
- **Find-my-match filter:** extend the existing filter row to filter by
  **division** (3v3), **round**, and a **player/team name search box**. Imported
  cards otherwise render and behave exactly like manual ones (editable, go-live).

### 4. Phase 2 — Score write-back (write)

- **Trigger:** on match finalize in eventmanager (`lmCommitAndClose()` and the
  auto-submit commit path).
- **Payload:** map eventmanager points → Challonge `scores_csv` (`"<win>-<lose>"`,
  higher first) and set `winner_id` from the participant map.
- **Transport:** a new **secured write route** on `functions/api/challonge.js`
  (e.g. `action=report`, method `PUT`) that the Vercel proxy must forward as a
  Challonge `PUT .../matches/{id}.json`. **Dependency:** the current proxy is
  GET-only; this needs a proxy route that accepts writes. **Verify proxy write
  access before building Phase 2.** If unavailable, Phase 2 is blocked; Phase 1 is
  unaffected.
- **Visibility:** each card shows a status chip — `✓ pushed to Challonge` /
  `⚠ push failed — retry`. Failures retry on the next poll; never silent.
- **Loop:** a successful write completes the Challonge match → Challonge generates
  the next round → Phase 1 import picks it up automatically.

## Data Model Changes

On `currentEvent`:
- `challongeAccount: string | null` — named server-side account.
- `challongeCustomKey: string | null` — per-event custom key (flagged secret).
- `challongeTournamentId: string | null`.
- `challongeParticipantMap: { [participantId]: { entryId?: string, teamName?: string } }`.
- `challongeGroupMap?: { [groupId]: string }` — division labels (3v3).

On each match in `matchesState` / results rows:
- `_challongeMatchId: number | null` — dedup + write-back target.
- `_challongeGroupId?: number` and/or `division?: string` (3v3).
- `_challongePushState?: 'pending' | 'ok' | 'error'` (Phase 2).

## Edge Cases & Safeguards

- **Same-owner solo pairing:** skip creation (DE advancement lives in Challonge).
- **Participant not in map:** card created with `⚠ pick player`.
- **Re-poll:** idempotent via `_challongeMatchId`; no duplicates.
- **Match edited after import:** edits are local/normal; write-back uses the final
  committed result, not intermediate edits.
- **Account/key wrong or revoked:** Settings tab status shows `error`; import/poll
  no-ops rather than throwing.
- **Offline:** poll simply skips while `navigator.onLine === false`, like existing
  sync; resumes on reconnect.
- **Write-back failure:** card chip shows `⚠ retry`; retried on next poll; bracket
  never advanced on an unconfirmed push.

## Testing

- **Unit:** name-matcher incl. DE trailing-number rule (solo) and team-name match
  (3v3); `round → "R{N}"`; dedup by `_challongeMatchId`; points → `scores_csv` +
  `winner_id`; same-owner skip; group_id → division.
- **Integration:** mock Challonge `participants`/`matches` payloads →
  - all `open` matches import once; decks/teams attach; same-owner skipped;
  - re-poll adds only new matches, no duplicates;
  - unmapped participant yields a flagged card;
  - (Phase 2) finalize pushes the correct `scores_csv`/`winner_id` to the right
    participant; failure surfaces a retry chip.
- **Manual live check:** link a real test tournament, confirm a round imports,
  score one match, confirm write-back completes it in Challonge and the next round
  auto-imports.

## Build Order

1. **Phase 1 (read):** Settings tab + account/tournament link → map-once screen →
   poll + manual sync → import (dedup, round map, same-owner skip, group/division)
   → search/filter.
2. **Phase 2 (write):** verify proxy write access → write route → finalize hook →
   points→Challonge mapping → status chips → closed-loop live check.
