# Double Entry (DE) — Design Spec
**Date:** 2026-05-26 (revision 3)
**Scope:** Solo events only. Team events unchanged.

---

## 1. Goal

Allow a player to hold two independent tournament slots in one solo event:
- **Main slot:** `Ken`
- **Double Entry slot:** `Ken (DE)`

Both slots participate separately in the bracket (separate builds, separate matches), but all recorded statistics aggregate under the single canonical player `Ken`. `Ken (DE)` never appears in `bladerStats`, rankings, or profiles.

---

## 2. Rules

1. DE is available in all solo events by default. It is never created automatically.
2. A DE slot can exist only after a main solo entry exists.
3. Maximum per solo participant: one main slot plus one DE slot.
4. Account players can add/remove their own DE using `sessionToken`.
5. Admin can add/remove DE for any solo main entry, including no-account walk-in players.
6. Admin creates DE from an existing roster entry located by index or `entryId` — never by typing a name.
7. No DE behavior applies to team events.
8. `Ken` vs `Ken (DE)` is blocked in EventManager — no match created, no stats recorded. Challonge advancement is handled manually.

---

## 3. Data Schema

### 3.1 New solo joiner shape

```json
{
  "entryId":      "550e8400-e29b-41d4-a716-446655440000",
  "entryType":    "main",
  "username":     "ken",
  "name":         "Ken",
  "displayLabel": "Ken",
  "joinedAt":     "2026-01-01T00:00:00.000Z",
  "manualAdd":    false
}
```

### 3.2 DE slot shape

```json
{
  "entryId":       "661f9511-f30c-52e5-b827-557766551111",
  "entryType":     "double",
  "sourceEntryId": "550e8400-e29b-41d4-a716-446655440000",
  "username":      "ken",
  "name":          "Ken",
  "displayLabel":  "Ken (DE)",
  "joinedAt":      "2026-01-01T00:01:00.000Z",
  "manualAdd":     false
}
```

### 3.3 No-account walk-in with DE

```json
{ "entryId": "aaa...", "entryType": "main",   "username": null, "name": "WalkIn", "displayLabel": "WalkIn",      "manualAdd": true }
{ "entryId": "bbb...", "entryType": "double",  "username": null, "name": "WalkIn", "displayLabel": "WalkIn (DE)", "manualAdd": true, "sourceEntryId": "aaa..." }
```

### 3.4 Field reference

| Field | Purpose |
|---|---|
| `entryId` | Stable UUID. Server-generated. Primary key for builds, match participants, and DE linkage. Never supplied by client. |
| `entryType` | `"main"` or `"double"`. Absent on legacy joiners and team joiners (treated as `"main"` at read time). |
| `sourceEntryId` | DE only. Points to the main entry's `entryId`. |
| `name` | Canonical stats owner. Always `account.displayName \|\| username` for account players. Never `"Ken (DE)"`. The `beyResults[].player` field is always set to `name`, never to `displayLabel`. |
| `displayLabel` | Event-only display string: `name` for main; `name + " (DE)"` for double. Used for roster cards and match labels in EventManager. Never used as a stats key. |

No `buildsRegistered` field is stored on joiners. Removal safety is enforced at removal time by inspecting live event data within the same event (see §4.6).

### 3.5 Active event data stored on the event object

`/api/beyresults` stores active EventManager data — builds and match results — directly on each event object in the events KV, before finalization into season archives. The event object shape during an active tournament is:

```json
{
  "id": "event-abc",
  "name": "...",
  "type": "solo",
  "joiners": [...],
  "builds": {
    "<entryId>":          ["Build A", "Build B", "Build C"],
    "<legacyPlayerName>": ["Build D"]
  },
  "beyResults": [
    { "player": "Ken", "entryId": "uuid", "entryType": "main", "displayLabel": "Ken", "round": 1, ... },
    { "player": "Ken", "entryId": "uuid2", "entryType": "double", "displayLabel": "Ken (DE)", "round": 1, ... }
  ]
}
```

`builds` keys are either `entryId` UUIDs (new entries) or legacy player-name strings. `beyResults[].player` is always the canonical name. Removal safety inspection reads these fields on the target event only — no cross-event or cross-season inspection.

### 3.6 Backward compatibility

Legacy joiners without `entryId` are treated as `entryType: "main"` implicitly everywhere in the UI and in read paths. No immediate migration runs.

**Lazy upgrade rule (server-enforced):** When DE is first added for a legacy main joiner (one that lacks `entryId`), the server assigns `crypto.randomUUID()` to that joiner, sets `entryType: "main"` and `displayLabel: j.name`, and persists this update to the events KV — all within the same request that creates the DE. The DE's `sourceEntryId` then points to the freshly assigned `entryId`. The upgrade is permanent.

Legacy joiners that never receive a DE remain name-keyed in build state. `slotKey()` (§6.1) handles both transparently.

### 3.7 EventManager manual roster entries

EventManager's `rosterAddPlayer()` currently creates a local-only `{ displayName, type: "solo" }` object and saves the entire event. This path is replaced: organizer-added solo players must be routed through `PUT /api/events?action=admin_add`, which assigns canonical `name`, `displayLabel`, `entryType: "main"`, and a server-generated `entryId`. EventManager merges the returned entry into its local event state rather than constructing a joiner locally. This makes all EventManager-added players immediately DE-eligible.

---

## 4. API — `functions/api/events.js`

### 4.1 Action table

| Action | Auth | Change |
|---|---|---|
| `join` | sessionToken | Updated: adds `entryId`, `entryType: "main"`, `displayLabel` to created joiner. |
| `unjoin` | sessionToken | Updated: cascades to remove DE if present. Blocked if `event.builds` or `event.beyResults` on the same event references any affected `entryId` or canonical name (§4.6). |
| `team_join` | sessionToken | Unchanged. |
| `de_add` | sessionToken | New. Lazy-upgrades legacy main joiner if needed, then adds DE slot. |
| `de_remove` | sessionToken | New. Removes only the DE slot. Blocked if live event data references the DE `entryId` (§4.6). |
| `admin_add` | adminCredentials | Updated: adds `entryId`, `entryType: "main"`, `displayLabel`. Used by both index.html and EventManager roster path. |
| `admin_add_de` | adminCredentials | New. Locates main entry by `joinerIdx` (primary, works for legacy) or `sourceEntryId` (if already assigned). Lazy-upgrades entry if needed, then creates DE in one KV save. |
| `admin_remove` | adminCredentials | Updated: cascade-removes linked DE when a main is removed. Inspects live event data; requires `force: true` to override if builds/results exist. Never deletes stored `beyResults` rows (§4.6). |

### 4.2 `de_add` logic (player)

```
1. verifySession → get account
2. Confirm event.type !== '3v3' → 400 "DE not available for team events"
3. Find main joiner: j.username === username AND (j.entryType === 'main' OR !j.entryType)
   → 404 "Join the event first before adding a Double Entry"
4. If that joiner lacks entryId (lazy upgrade):
   a. j.entryId = crypto.randomUUID(), j.entryType = "main", j.displayLabel = j.name
   b. Persist updated event.joiners to KV within this request
5. Check: no joiner where j.username === username AND j.entryType === 'double'
   → 409 "Double Entry already exists"
6. name = account.displayName || username  (never from request body)
7. Push DE joiner: { entryId: randomUUID(), entryType: "double", sourceEntryId: main.entryId,
   username, name, displayLabel: name + " (DE)", joinedAt: now, manualAdd: false }
8. Save
```

### 4.3 `unjoin` cascade logic (updated)

```
1. verifySession
2. Collect all joiners where j.username === username
3. Inspect the same event's event.builds and event.beyResults (§4.6):
   - event.builds: check for any key matching an affected entryId with non-empty value
   - event.beyResults: check for any row where r.entryId matches, or (legacy) r.player === canonical name
   → If found: 403 "Match preparation has started. Contact the admin to be removed."
4. Remove all collected joiners from event.joiners (removes main + DE in one pass)
5. Save
```

### 4.4 `de_remove` logic (player)

```
1. verifySession
2. Find DE joiner: j.username === username AND j.entryType === 'double'
   → 404 "No Double Entry found"
3. Inspect event.builds and event.beyResults for the DE entryId (§4.6):
   → If found: 403 "Builds are registered. Contact the admin."
4. Remove only the DE joiner, save
```

### 4.5 `admin_add_de` logic

Admin locates the main entry by `joinerIdx` (works for all entries including legacy with no `entryId`) or by `sourceEntryId` (for entries that already have one). `joinerIdx` is the primary locator; `sourceEntryId` is an optional additional validation.

```
1. Verify admin credentials
2. Confirm event.type !== '3v3' → 400
3. Locate main entry:
   a. If body.joinerIdx is provided: target = event.joiners[body.joinerIdx]
      → 400 if out of range
      → 400 if target.entryType === 'double' ("Cannot add DE to a DE entry")
      → 400 if target.type === 'team' ("Cannot add DE to a team entry")
   b. If body.sourceEntryId is also provided and target already has entryId:
      validate target.entryId === body.sourceEntryId → 400 on mismatch ("Index/ID mismatch")
4. Check no existing joiner has sourceEntryId === target.entryId (if target has one) → 409 "DE already exists"
5. Also check no existing DE shares the same username (if target.username) → 409
6. If target lacks entryId (lazy upgrade):
   a. target.entryId = crypto.randomUUID(), target.entryType = "main"
   b. target.displayLabel = target.name (if absent)
7. Inherit: username = target.username, name = target.name
8. displayLabel = target.name + " (DE)"
9. entryId = crypto.randomUUID()
10. Push DE joiner { entryId, entryType: "double", sourceEntryId: target.entryId,
    username, name, displayLabel, joinedAt: now, manualAdd: target.manualAdd }
11. Single KV save (upgrade + DE creation in one write)
```

### 4.6 Removal safety — live event inspection

Removal endpoints inspect **only the current event** — never other events, other seasons, or lifetime stats.

**What is inspected (both player and admin paths):**

1. **`event.builds`** — check if `event.builds[entryId]` exists and has at least one non-empty build string. For legacy entries with no entryId, check `event.builds[name]`.
2. **`event.beyResults`** — check for any row where `r.entryId === entryId` (new entries) or `r.player === name` and no `r.entryId` is present (legacy rows). Scoped to this eventId only.

**Player-initiated removal (`unjoin`, `de_remove`):**
- If any build or result found within this event: 403 with descriptive message. Removal rejected entirely.

**Admin removal (`admin_remove`):**
- If builds or results found and `force` is absent or false: 409 "Builds or results exist for this entry. Send force: true to remove the roster entry only."
- If `force: true`: remove only the joiner entry/entries from `event.joiners`. `event.builds` and `event.beyResults` rows are **never deleted** — they remain as historical records.
- Cascade: if removed entry is `entryType: "main"` (or legacy without `entryType`), also remove any DE joiner whose `sourceEntryId` matches the removed `entryId`. Apply the same force/block logic to the DE.

---

## 5. `index.html`

### 5.1 Player join state

```
getPlayerJoinState(ev) → 'none' | 'main' | 'main+de'
```

Replaces the current `isPlayerJoined()` boolean for solo events. Team events still use the boolean path unchanged.

### 5.2 Join area UI states (solo)

```
'none'    → "⚡ Join This Event"
'main'    → "✅ Joined"  [Add Double Entry]  [Unjoin]
'main+de' → "✅ Joined + DE"  [Remove DE]  [Unjoin]
```

Unjoin when DE exists: confirm dialog — "This will remove both your entry and your Double Entry. Continue?"

### 5.3 Joiners list rendering

Display: `j.displayLabel ?? j.name`

DE entries render a `[DE]` badge as a `<span>` with content set via `textContent` (never raw innerHTML interpolation).

### 5.4 Admin controls (solo events only)

- Each joiner row stores `data-joiner-idx` (array index) and `data-entry-id` (entryId, if present).
- Beside each main entry: **"+ DE"** button. On confirm, sends `{ joinerIdx, sourceEntryId: entryId || undefined }` to `admin_add_de`. No user-supplied name.
- Beside each DE entry: remove-by-index button. If server returns 409 (builds/results exist), UI shows "Builds or results exist — force remove?" On second confirm, resends with `force: true`. Match data is not deleted.
- Team entries: no DE controls shown.

### 5.5 XSS safety

- `displayLabel` and `name` always written via `textContent` or `escHtml()`
- `entryId` and `joinerIdx` passed only as `data-*` attributes or JSON body fields, never interpolated into `onclick` strings
- All admin confirm prompts built with DOM node construction

---

## 6. `eventmanager.html`

### 6.1 `slotKey()` helper

```js
function slotKey(j) {
  return j.entryId ?? j.name;
}
```

Used for build storage and slot identity throughout EventManager. Legacy events (no `entryId`) continue working via name fallback with no behavioral change.

### 6.2 `getPlayers()` update

Returns full joiner objects, one per slot, deduplicated by `slotKey`. Each object: `{ entryId, entryType, sourceEntryId, name, displayLabel, username, manualAdd }`. Team member extraction unchanged.

### 6.3 Manual roster path — `rosterAddPlayer()`

The existing local-only path that creates `{ displayName, type: "solo" }` is replaced. Organizer-added solo players are created by calling `PUT /api/events?action=admin_add`, which returns the server-normalized joiner (with `entryId`, `entryType: "main"`, `name`, `displayLabel`). EventManager merges the returned entry into its local event state. This makes all EventManager-added players immediately DE-eligible.

### 6.4 Build state

```js
buildsState[slotKey(joiner)] = ["Build A", "Build B", "Build C"]
```

`Ken` and `Ken (DE)` have independent build arrays keyed by their respective `entryId` UUIDs. Legacy name-keyed builds remain name-keyed and function identically to today.

**Active event storage:** `event.builds` stored on the event object in the events KV uses `entryId` as key for new entries and legacy player name as key for old entries (see §3.5). `slotKey()` resolves both transparently.

**Archive build-key handling:** On archive/finalization, UUID-keyed build entries are **converted to canonical-name keys** before writing to the season archive. Since both main and DE share `name: "Ken"`, their build usage merges under `"Ken"` in the archive summary, which is the correct aggregate behavior for lifetime stats. Exact per-slot build/match performance is preserved in `beyResults` rows (which carry `entryId` and `displayLabel`). This means index.html archive and build-maintenance consumers require no changes — they continue reading name-keyed archives as today.

### 6.5 Roster cards

Display: `j.displayLabel ?? j.name`. DE entries show a `[DE]` badge. Beside each solo main entry: **"Add DE"** button; on confirm calls `admin_add_de` with `{ joinerIdx, sourceEntryId: j.entryId || undefined }`. Hidden for team members and existing DE entries.

### 6.6 Match participant shape

```js
{
  player:       "Ken",       // canonical name — always j.name, NEVER displayLabel
  entryId:      "uuid",      // slot identity for _sid, dedup, and build lookup
  entryType:    "main",      // or "double"
  displayLabel: "Ken (DE)",  // display-only label for match card; never used as stats key
  builds:       [...]
}
```

`player` is always the canonical `name`. `beyResults[].player` is always set from `participant.player`. Legacy match participants (no `entryId`) use `player` as-is, unchanged.

### 6.7 Ken vs Ken (DE) block

At match creation: if both participants share the same `player` value → block with modal:

> "Ken and Ken (DE) share the same player. Challonge advancement for this pairing is handled manually. This match will not be recorded."

No match object is created. No stats are written.

### 6.8 Stable match IDs (`_sid`) — slot-based

`_sid` must distinguish two slots from the same canonical player. Generation uses `entryId` when present:

```js
function makeSid(round, p1, p2) {
  const side1 = p1.entryId || p1.player;
  const side2 = p2.entryId || p2.player;
  return `r${round}:${side1}:${side2}`;
}
```

Legacy matches (no `entryId`) fall back to player-name-based `_sid`, unchanged.

### 6.9 EventManager persistence paths

All paths that serialize or reload match/build state must carry `entryId`, `entryType`, and `displayLabel` through intact while using canonical `player` for stats:

| Path | Requirement |
|---|---|
| Match save | Serialize full participant object: `player` (canonical), `entryId`, `entryType`, `displayLabel`, `builds`. |
| Match reload | Restore all fields verbatim. Deduplicate by `entryId` when present; player-name fallback for legacy. |
| Live sync merge | Merge by `_sid`. Participant fields reconciled by `entryId` when present; player name for legacy. |
| Unsynced-match matching | Match by `entryId` first; fall back to player-name comparison for legacy rows. |
| Build rename propagation | Update `buildsState[slotKey]` for every slot referencing the renamed build. UUID keys are never renamed as if they were player names. |
| Archive / finalization | Convert UUID build keys → canonical name keys before writing to season archive. Keep `beyResults` rows with `entryId` and `displayLabel` intact for per-match audit. |

### 6.10 Active-event player rename

When a player renames themselves via `player_rename` in `accounts.js`, the rename handler already updates `gamedata_s*` season archives. It must **also** update the events KV: for every event in `event.joiners`, find all entries where `j.username === selfUsername` and update:
- `j.name = newDisplayName`
- `j.displayLabel = newDisplayName` (for main entries)
- `j.displayLabel = newDisplayName + " (DE)"` (for double entries)

This ensures main and DE slots always share the same canonical owner after rename, and the same-owner match block (`player` equality check) continues to work correctly. This update is applied atomically in the same `player_rename` request that updates accounts and season data.

---

## 7. Results & Rankings

### 7.1 Stats write key

Because `beyResults[].player` is always the canonical `name` (never `"Ken (DE)"`), the stats aggregation path requires no change to its key logic. Both slots write results under `"Ken"` automatically.

```js
const statsKey = result.player;  // always canonical — no substitution needed
```

Optional `result.displayLabel` and `result.entryId` may be present on rows for per-match audit display but are never used as stat keys or `bladerStats` dictionary keys.

### 7.2 Aggregation table

| Stat | Behavior |
|---|---|
| Player win / loss / total | Both slots write `player: "Ken"` → accumulate under single key |
| Win rate | Derived from aggregated totals — correct automatically |
| Beyblade usage / wins / losses | Each slot's actual build credited to `"Ken"`'s build record |
| Ranking position | Based on aggregated totals — correct |
| `bladerStats` keys | Only `"Ken"` ever created. `"Ken (DE)"` never stored. |

### 7.3 Ken vs Ken (DE) result

Blocked at match creation in EventManager — zero stats recorded for that pairing.

### 7.4 Legacy results

Legacy results have no `entryId`, no `displayLabel`, no `entryType`. `result.player` is the canonical name as stored. Stats aggregation is identical to today.

---

## 8. Verification Checklist

1. Account player joins solo event → one main entry with `entryId` and `entryType: "main"` appears.
2. Same player adds DE → roster shows `Ken` and `Ken (DE)`.
3. Same player cannot add a third entry → 409.
4. Player cannot add DE without main → 404.
5. Admin adds walk-in via `admin_add`, then adds DE via `joinerIdx` → both entries appear with linked `sourceEntryId`.
6. Legacy joiner (no `entryId`): admin calls `admin_add_de` with `joinerIdx` → lazy upgrade assigns `entryId` to main and creates DE in one KV write.
7. EventManager `rosterAddPlayer()` routes through `admin_add` → entry gets `entryId`, is immediately DE-eligible.
8. Team event shows no DE controls anywhere.
9. `Ken` and `Ken (DE)` save distinct builds; `_sid` for their matches differs because each uses its own `entryId`.
10. Match between `Ken (DE)` and another player records `player: "Ken"` (canonical) and aggregates under Ken's stats.
11. Attempting `Ken` vs `Ken (DE)` match → blocked by `player` equality check, zero stats.
12. Player unjoin blocked after `event.builds` or `event.beyResults` contains their entryId — scoped to this event only. Other events with the same player are irrelevant.
13. Admin force-remove: joiner entries removed; `event.builds` and `event.beyResults` rows are preserved.
14. Admin removes main → cascade removes DE in the same `admin_remove` call. Requires `force: true` if builds/results exist.
15. Legacy joiners without `entryId` render and function as main entries; build state name-keyed as before.
16. Archive: UUID build keys converted to canonical-name keys; `beyResults` rows retain `entryId` and `displayLabel`.
17. Player renames to "Kenshi" → both main joiner (`name: "Kenshi"`, `displayLabel: "Kenshi"`) and DE joiner (`name: "Kenshi"`, `displayLabel: "Kenshi (DE)"`) updated atomically. Same-owner block still works.
18. Security: no password/tokenVersion exposure, sessionToken required for player DE actions, admin credentials required for admin DE actions, DE labels XSS-safe.

---

## 9. Files Changed

| File | Change summary |
|---|---|
| `functions/api/events.js` | Add `de_add`, `de_remove`, `admin_add_de` actions. Update `join`, `unjoin`, `admin_add`, `admin_remove`. Lazy upgrade in `de_add`/`admin_add_de`. Live event inspection in `unjoin`/`de_remove`/`admin_remove`. |
| `functions/api/accounts.js` | `player_rename` also updates `name`/`displayLabel` on all matching event joiners in the events KV. |
| `index.html` | `getPlayerJoinState()`, join area state machine, DE badge in joiner list, admin `+DE` and force-remove controls (joinerIdx + sourceEntryId). |
| `eventmanager.html` | `slotKey()`, `getPlayers()` full objects, `rosterAddPlayer()` → `admin_add` API path, build keying by `slotKey`, `_sid` uses `entryId \|\| player`, match participant shape with canonical `player`, Ken-vs-Ken block, archive UUID→name key conversion, persistence path updates. |

No changes to: `player-login.js`, `login.js`, `challonge.js`, `beyresults.js`, `data.js`.
