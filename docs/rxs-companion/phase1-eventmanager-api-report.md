# Phase 1 — Event Manager API / Integration Report

**Scope:** Document the existing Event Manager backend the native "RXS Camera + Scorer"
companion must integrate with: authentication, events, matches/identity, scoring rules,
submission, live sync, and offline sync. **No mobile code built.** Read-only inspection.

Backend = Cloudflare Pages Functions (`functions/api/*`) over **KV** (`BEYBLADE_KV`) with an
optional **Durable Object** (`BEY_STATE_DO`, `workers/bey-state-do`) that makes per-event
writes atomic. Same-origin web app; no separate API host.

---

## 1. Authentication — TWO separate systems

| | Admin (Event Manager / judge) | Player |
|---|---|---|
| Endpoint | `POST /api/login` | `POST /api/player-login` |
| Credentials | `{username, password}` checked vs **env vars** `ADMIN_USERNAME/PASSWORD` (+ optional `ADMIN2_*`) | `{username, passwordHash}` (client pre-hashes); verified (PBKDF2) vs KV `accounts` |
| Returns | `{success, user}` — **no token** | `{success, sessionToken, account}` |
| Session | **None.** Creds are **re-sent in the body of every write** | KV `session:<token>`, 30-day TTL, `tokenVersion`; verify via `POST /api/player-login?action=verify {username, sessionToken}` |

**Critical for the app:** *Scoring writes are admin-only and authenticated by sending
`adminUsername` + `adminPassword` in every `PUT` body* (`beyresults.js:174-184`,
`events.js` admin actions). There is **no per-judge token** for scoring. The companion must
hold admin credentials to submit scores. `GET` is **public/unauthenticated**.
→ See Risks (shared secret on N judge devices).

CORS: `_middleware.js` rewrites `Access-Control-Allow-Origin` to the site origin or an
allow-listed `Origin` (`ALLOWED_ORIGINS` env). A **native app sends no browser `Origin`**, so
CORS does not gate it — but a custom origin can be allow-listed if ever needed.

---

## 2. Events

- `GET /api/events` → `{events:[...]}` — full public blob incl. `joiners`. (`events.js:109`)
- `GET /api/beyresults` (no `eventId`) → `{events:[{eventId,eventTitle,season,date,beyResults,builds}]}` (`beyresults.js:141`)
- Event object fields used here: `id`, `title`, `season`, `date`, `type` (`'3v3'` for team, else solo), `joiners[]`, `beyResults[]`, `builds{}`, plus Challonge metadata.
- `joiners[]` entry: `{entryId, entryType:'main'|'double', username|null, name, displayLabel, ...}`; teams: `{type:'team', teamName, members:[{username,displayName}]}`.

**App flow:** list events via `GET /api/events`, let judge pick event, then read live match
state via `GET /api/beyresults?eventId=…` (below).

---

## 3. Matches & identity (the contract the app MUST reuse)

State is a **flat `beyResults[]` array of per-player rows**, not match objects. A match =
the rows sharing a `_matchSid`.

**Solo row** (`flattenMatchesToResults`, `eventmanager.html:3314`):
```
{ player, entryId?, entryType?, displayLabel?, round, builds, pointsTotal, win,
  _submitted?, _matchSid, _noStats?, dePoints?, division?, _challonge* ? }
```
**Team row** adds `team` (team name); first team1 row carries `_playOrder`, `division`, `_challonge*`.

- `builds` (in a row) = **array of build objects each with `finishes:[…]`** = the scoring data.
- top-level `builds{}` map = **player → array of build-name strings** (roster names), shallow-merged server-side.

**`_matchSid` formats** (`merge.js:24-30`, mirrored in client `_sid`):
- Solo: `` `${round}|${p1.entryId||p1.player}|${p2.entryId||p2.player}|${idx}` ``
- Team: `` `${round}|T|${t1}|${t2}|${idx}` ``
- Manual/orphan: `` `MANUAL|${entryId||player}` `` / `` `MANUAL|${round}|…` ``

Server `computeSidsForEntries` reconstructs sids by **positional pairing** if the client omits
them; the client supplies its own `_sid`. **The app must use identical sid formats** so its
writes merge with web/other judges instead of duplicating matches.

`round` values seen: `R1…`, `TC`, `QF`, `SF`, `F`, `MANUAL`.

---

## 4. Scoring rules (replicate exactly)

Finish codes & points — `FINISH_PTS = { S:1, O:2, E:3, B:2, L:0 }` (`eventmanager.html:2231`):

| Code | Finish | Pts |
|---|---|---|
| S | Spin | 1 |
| O | Over | 2 |
| B | Burst | 2 |
| E | Extreme | 3 |
| L | Loss | 0 |

- `calcPoints(builds)` = Σ `FINISH_PTS[f]` over each build's `finishes` (excludes `L`) (`:3154`).
- A build is "won" if it has any finish ≠ `L`.
- **Win thresholds:** solo `F`=7, `SF`=5, else 4 (`soloThreshold :3392`); team `F`=7, else 4; team regular rounds always play all 3 for points.
- **Auto-submit:** when a finish makes a side reach threshold, `evaluateAutoSubmit` arms a countdown that calls submit (existing behavior; app reuses the rule, not necessarily the timer).
- DE self-match uses `dePoints` (coin toss), `_noStats:true`.

---

## 5. Submission & live write path

All writes: `PUT /api/beyresults` with `{adminUsername, adminPassword, eventId, builds, beyResults, mergeMode:true, deletedSids?, revivedSids?}`.

- **Live per-tap push** — `pushMatchLive(match)` → `buildMatchPatchBody` (`:3352`): sends **only that match's rows** + only referenced `builds` keys, `mergeMode:true`, **no `_submitted`**, debounced. Subset PUT is safe — server merges by sid, only `deletedSids` tombstones remove a match (`merge.js:158`).
- **Submit** = same path but rows carry `_submitted:true`.
- **Response** echoes merged `{beyResults, builds}` (tombstones stripped) + header **`X-BEY-CONCURRENCY: durable-object | best-effort-kv`**.

**Concurrency:** DO bound → atomic, per-event serialized, last-received-wins per sid. KV-only →
documented racy read-merge-write; response also carries `X-BEY-CONCURRENCY-WARNING`. The web
client treats `best-effort-kv` as "multi-judge live scoring unsafe." **The app must read this
header and apply the same gate.**

---

## 6. Live sync (read)

- Poll `GET /api/beyresults?eventId=<id>&_t=<ms>` (~3 s); DO-authoritative; tombstones stripped; sids annotated.
- Merge adopts server rows per sid; the locally-edited match is protected from being clobbered while actively scored.
- A sid is considered server-acked once it appears in a response payload (`sidsFromServerPayload :8205`).

---

## 7. Offline sync (outbox — replicate this model)

- Storage key `rxs_outbox_<eventId>` (web: localStorage; app: equivalent persistent store).
- Op: `{ eventId, matchSid, clientId, opId, payload, createdAt }` where `payload` = the `buildMatchPatchBody` body. (`enqueueOutboxOp :8176`)
- **One op per `matchSid`** — a new op for the same sid **supersedes** the old.
- `clientId` (stable per device) + `opId` (uuid) make retries idempotent; server LWW by receive order resolves conflicts.
- On reconnect / periodic check → flush all ops (`flushOutbox :8424`); drop an op once its sid is observed in server data (`confirmOutboxAcked :8191`).
- **Recording is independent of all of this** (spec requirement): a failed/queued score push must never interrupt capture.

---

## 8. Integration implications for the native app

1. **Reuse, don't reinvent:** sid formats, row shape, `FINISH_PTS`, thresholds, and the
   outbox op model are the shared contract. Pull them into shared fixtures/models (per the
   architecture's "share data models + scoring rules + test fixtures").
2. **Auth:** app authenticates the judge via `POST /api/login`, then stores admin creds
   securely (Keychain / Keystore) and attaches them to every `PUT`. Watch the shared-secret risk.
3. **Read header `X-BEY-CONCURRENCY`** and gate multi-judge live scoring exactly as the web does.
4. **Match selection:** `GET /api/events` → pick event → `GET /api/beyresults?eventId` → derive
   matches by grouping rows on `_matchSid`.
5. **No backend change is strictly required** for the app to score: the existing
   `beyresults.js` PUT/GET already supports subset merge, tombstones, and offline replay.
   Optional later changes (per-judge tokens, score↔clip metadata endpoint) are noted as future.

---

## Phase 1 close-out

- **Changed files:** this report only (`docs/rxs-companion/phase1-eventmanager-api-report.md`). No code touched.
- **Tests run:** none (inspection-only phase).
- **Risks / open items:**
  - **Shared admin secret** on every judge device (no per-judge identity); `GET` is public. Acceptable for v1, but flag for a future scoped-token endpoint.
  - **Score↔recording link** (timestamps as metadata) has **no existing API**; will be new client-side metadata in Phase 7, stored locally — no backend contract yet.
  - **`best-effort-kv` mode** loses concurrent writes; confirm `BEY_STATE_DO` is bound in production before multi-judge use.
  - Match model is **flat rows keyed by sid**, not match objects — the app's "select a match" must reconstruct from rows.
- **Exact next phase (Phase 2):** build **recorder-only** prototypes (no scoring yet) — iPhone (SwiftUI/AVFoundation→PhotoKit) and Android (Compose/CameraX→MediaStore) — that capture rear-camera video + mic, query real device capabilities, display selected resolution/FPS, and save a clean clip to Photos/Gallery. **Stop for the device test report (Phase 5) before adding scoring.**
