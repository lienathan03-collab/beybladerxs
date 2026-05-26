# Double Entry (DE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Double Entry (DE) support to solo Beyblade tournament events, allowing one player to hold two independent bracket slots (`Ken` and `Ken (DE)`) while all stats accumulate under the single canonical player `Ken`.

**Architecture:** Three-layer change — (1) `events.js` API gets new actions (`de_add`, `de_remove`, `admin_add_de`) plus updated existing actions with `entryId`/`entryType`/`displayLabel`; (2) `accounts.js` `player_rename` becomes event-aware, updating joiner labels AND unfinalized beyResults; (3) `index.html` and `eventmanager.html` adopt `entryId`-keyed slot identity for builds, matches, autocomplete, sync, and rendering.

**Tech Stack:** Cloudflare Pages Functions (ES modules, edge runtime), Cloudflare KV (`BEYBLADE_KV`), vanilla JS/HTML. No unit test framework — verification is manual browser testing after each commit deployed to Cloudflare Pages.

**Spec:** `docs/superpowers/specs/2026-05-26-double-entry-design.md`

---

## File Map

| File | What changes |
|---|---|
| `functions/api/events.js` | Add `hasLiveData()` helper. Update `join`, `unjoin`, `admin_add`, `admin_remove`. New actions: `de_add`, `de_remove`, `admin_add_de`. |
| `functions/api/accounts.js` | `player_rename` updates `name`/`displayLabel` on event joiners AND updates `beyResults[].player` for unfinalized live results. |
| `index.html` | `getPlayerJoinState()` replaces `isPlayerJoined()`. Join area 3-state machine. `handleDeAdd`, `handleDeRemove`. DE badge in joiner list. `buildSoloJoinerRow()`. `adminAddDE()`. `adminRemoveJoiner()` with force-remove flow. |
| `eventmanager.html` | `slotKey()`. `getPlayers()` returns full joiner objects. `rosterAddPlayer()` → `admin_add` API. `renderBuilds()` uses `slotKey` + `data-key` (which auto-fixes build autocomplete). `submitBuilds()` rename propagation uses `entryId`. `renderRoster()` with DE badge + Add DE button. `adminAddDEFromRoster()`. `_soloSid()` updated to use `entryId`. `nmSelectPlayer()` receives full player object. `nmFilterPlayers` uses `slotKey`. Ken-vs-Ken block. `renderMatchCard` shows `displayLabel`. `flattenMatchesToResults()` / `loadMatchesFromResults()` carry `entryId`/`displayLabel`. `mergeIncomingMatches()` preserves `entryId` and uses updated `_soloSid`. Archive UUID→canonical-name key conversion. |

---

## Task 1: events.js — Add `hasLiveData` helper; update `join` and `admin_add`

**Files:**
- Modify: `functions/api/events.js`

**What to read first:** Lines 1–31 (constants + `verifySession`), lines 230–244 (join push), lines 260–294 (admin_add).

- [ ] **Step 1.1: Add `hasLiveData` helper**

After the line `const TEAM_NAME_RE = /^[a-zA-Z0-9 ._\-]+$/;` and before `async function verifySession`, insert:

```js
// Checks ONLY the target event object — event.builds and event.beyResults — for live data.
// Does NOT read any other KV key (season gamedata, other events).
// Name fallback path is only for legacy entries with no entryId (same-event scope only).
function hasLiveData(event, entryId, name) {
  const builds = event.builds || {};
  if (entryId && builds[entryId] && builds[entryId].some(b => b && b.trim())) return true;
  if (!entryId && builds[name] && builds[name].some(b => b && b.trim())) return true;
  const results = event.beyResults || [];
  if (entryId && results.some(r => r.entryId === entryId)) return true;
  if (!entryId && results.some(r => r.player === name && !r.entryId)) return true;
  return false;
}
```

- [ ] **Step 1.2: Update the `join` action joiner push**

Find (around line 240):
```js
        event.joiners.push({ username, name: playerName, joinedAt: new Date().toISOString() });
```

Replace with:
```js
        event.joiners.push({
          entryId:      crypto.randomUUID(),
          entryType:    'main',
          username,
          name:         playerName,
          displayLabel: playerName,
          joinedAt:     new Date().toISOString()
        });
```

- [ ] **Step 1.3: Update the `admin_add` joiner push**

Find (around line 292):
```js
      event.joiners.push({ username: null, name: name.trim(), joinedAt: new Date().toISOString(), manualAdd: true });
```

Replace with:
```js
      event.joiners.push({
        entryId:      crypto.randomUUID(),
        entryType:    'main',
        username:     null,
        name:         name.trim(),
        displayLabel: name.trim(),
        joinedAt:     new Date().toISOString(),
        manualAdd:    true
      });
```

- [ ] **Step 1.4: Commit**

```bash
git add functions/api/events.js
git commit -m "feat(events): add hasLiveData helper; join and admin_add emit entryId/entryType/displayLabel"
```

- [ ] **Step 1.5: Verify after deploy**

Join a solo event as a logged-in player. Call `GET /api/events` in the browser and inspect the event's `joiners` array. The new entry must have `entryId` (a UUID string), `entryType: "main"`, and `displayLabel` equal to the player's display name. Legacy entries (before this deploy) will lack these fields — that is expected and fine.

---

## Task 2: events.js — Update `unjoin` with cascade removal and live inspection

**Files:**
- Modify: `functions/api/events.js`

**What to read first:** Lines 241–244 (current unjoin handler).

- [ ] **Step 2.1: Replace the unjoin block**

Find the current unjoin handler:
```js
      } else {
        // unjoin — remove by username
        event.joiners = event.joiners.filter(j => j.username !== username);
      }
```

Replace with:
```js
      } else {
        // unjoin — collect all joiners for this user (main + any DE), then inspect live data
        const userJoiners = event.joiners.filter(j => j.username === username);
        for (const j of userJoiners) {
          if (hasLiveData(event, j.entryId || null, j.name || username)) {
            return new Response(
              JSON.stringify({ error: 'Match preparation has started. Contact the admin to be removed.' }),
              { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }
        }
        // Remove all (main + DE) for this user
        const removeEntryIds = new Set(userJoiners.map(j => j.entryId).filter(Boolean));
        event.joiners = event.joiners.filter(j => {
          if (j.entryId && removeEntryIds.has(j.entryId)) return false;
          if (!j.entryId && j.username === username) return false;
          return true;
        });
      }
```

- [ ] **Step 2.2: Commit**

```bash
git add functions/api/events.js
git commit -m "feat(events): unjoin cascades DE removal and blocks on live builds/results"
```

- [ ] **Step 2.3: Verify after deploy**

1. Join a solo event as a player.
2. Unjoin — confirm success.
3. Join again, add a DE slot (via Task 3 after it's deployed), then unjoin — confirm both entries removed in one call.
4. After builds exist on the event (via EventManager), confirm unjoin returns 403 with "Match preparation has started."

---

## Task 3: events.js — New `de_add` and `de_remove` player actions

**Files:**
- Modify: `functions/api/events.js`

**What to read first:** Lines 79–115 (player action routing), lines 152–244 (join/unjoin logic).

- [ ] **Step 3.1: Extend the player-action routing condition**

Find:
```js
    if (action === 'join' || action === 'unjoin' || action === 'team_join') {
```

Change to:
```js
    if (action === 'join' || action === 'unjoin' || action === 'team_join' || action === 'de_add' || action === 'de_remove') {
```

- [ ] **Step 3.2: Add `de_add` handler**

In the action-dispatch block, after the `} else if (action === 'join') {` block (which ends around line 240) and before the `} else {` unjoin block, insert:

```js
      } else if (action === 'de_add') {
        if (event.type === '3v3') {
          return new Response(
            JSON.stringify({ error: 'DE not available for team events.' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        // Find the player's main joiner
        const mainJoiner = event.joiners.find(j =>
          j.username === username && (j.entryType === 'main' || !j.entryType) && j.type !== 'team'
        );
        if (!mainJoiner) {
          return new Response(
            JSON.stringify({ error: 'Join the event first before adding a Double Entry.' }),
            { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        if (event.joiners.find(j => j.username === username && j.entryType === 'double')) {
          return new Response(
            JSON.stringify({ error: 'Double Entry already exists.' }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        // Lazy upgrade: assign entryId to legacy main joiner if missing
        if (!mainJoiner.entryId) {
          mainJoiner.entryId      = crypto.randomUUID();
          mainJoiner.entryType    = 'main';
          mainJoiner.displayLabel = mainJoiner.name;
        }
        const canonicalName = account.displayName || username;
        event.joiners.push({
          entryId:       crypto.randomUUID(),
          entryType:     'double',
          sourceEntryId: mainJoiner.entryId,
          username,
          name:          canonicalName,
          displayLabel:  canonicalName + ' (DE)',
          joinedAt:      new Date().toISOString(),
          manualAdd:     false
        });
```

- [ ] **Step 3.3: Add `de_remove` handler**

After the `de_add` block and before the `} else {` unjoin block, insert:

```js
      } else if (action === 'de_remove') {
        const deJoiner = event.joiners.find(j => j.username === username && j.entryType === 'double');
        if (!deJoiner) {
          return new Response(
            JSON.stringify({ error: 'No Double Entry found.' }),
            { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        if (hasLiveData(event, deJoiner.entryId || null, deJoiner.name)) {
          return new Response(
            JSON.stringify({ error: 'Builds are registered. Contact the admin.' }),
            { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        event.joiners = event.joiners.filter(j => j !== deJoiner);
```

- [ ] **Step 3.4: Commit**

```bash
git add functions/api/events.js
git commit -m "feat(events): add de_add and de_remove player actions with lazy upgrade"
```

- [ ] **Step 3.5: Verify after deploy**

Run in browser console (as a logged-in player who has already joined the event):
```js
await fetch('/api/events?action=de_add', {
  method: 'PUT',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    username: playerSession.username,
    sessionToken: playerSession.sessionToken,
    eventId: 'your-event-id'
  })
}).then(r => r.json()).then(console.log)
```
Expected: `{ success: true, event: { joiners: [..., { entryType: "double", displayLabel: "Name (DE)", ... }] } }`.

Verify `de_remove` similarly. Verify calling `de_add` twice → 409 "Double Entry already exists". Verify calling `de_add` without joining first → 404.

---

## Task 4: events.js — New `admin_add_de` action

**Files:**
- Modify: `functions/api/events.js`

**What to read first:** Lines 260–322 (admin_add + admin_remove structure).

**Locator contract:** `joinerIdx` is the **primary locator** for ALL entries — legacy (no `entryId`) and normalized alike. The server looks up the roster entry by array index, upgrades the main entry atomically (assigns `entryId`, sets `entryType: "main"`), and pushes the new DE joiner — all in one KV save. `sourceEntryId` is an optional cross-validation field: if supplied, the server confirms the indexed entry's `entryId` matches before proceeding. It is never the primary locator.

- [ ] **Step 4.1: Add `admin_add_de` block**

In the PUT handler, after the closing `}` of the `admin_add` block (around line 295) and before the `admin_remove` block, insert the entire `admin_add_de` handler:

```js
    // ── Admin: add DE slot for a main entry ──
    // joinerIdx is the primary locator for both legacy and normalized entries.
    // sourceEntryId (optional) cross-validates the index for already-normalized entries.
    if (action === 'admin_add_de') {
      const { adminUsername, adminPassword, eventId, joinerIdx, sourceEntryId } = body;
      const validU  = env.ADMIN_USERNAME;
      const validP  = env.ADMIN_PASSWORD;
      const valid2U = env.ADMIN2_USERNAME;
      const valid2P = env.ADMIN2_PASSWORD;
      const isAdmin =
        (adminUsername === validU && adminPassword === validP) ||
        (valid2U && adminUsername === valid2U && adminPassword === valid2P);
      if (!isAdmin) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized.' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      if (!eventId || joinerIdx === undefined || joinerIdx === null) {
        return new Response(
          JSON.stringify({ error: 'eventId and joinerIdx required.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      let eventsData;
      try {
        const raw = await kv.get(EVENTS_KEY);
        eventsData = raw ? JSON.parse(raw) : { events: [] };
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Could not load events.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const event = (eventsData.events || []).find(ev => ev.id === eventId);
      if (!event) return new Response(JSON.stringify({ error: 'Event not found.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      if (!Array.isArray(event.joiners)) event.joiners = [];
      if (event.type === '3v3') {
        return new Response(JSON.stringify({ error: 'DE not available for team events.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const idx = Number(joinerIdx);
      if (isNaN(idx) || idx < 0 || idx >= event.joiners.length) {
        return new Response(JSON.stringify({ error: 'joinerIdx out of range.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const target = event.joiners[idx];
      if (target.entryType === 'double') {
        return new Response(JSON.stringify({ error: 'Cannot add DE to a DE entry.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      if (target.type === 'team') {
        return new Response(JSON.stringify({ error: 'Cannot add DE to a team entry.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      // Cross-validate sourceEntryId only if target already has an entryId (normalized entry)
      if (sourceEntryId && target.entryId && target.entryId !== sourceEntryId) {
        return new Response(JSON.stringify({ error: 'Index/ID mismatch.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      // Duplicate check by sourceEntryId
      if (target.entryId && event.joiners.find(j => j.sourceEntryId === target.entryId)) {
        return new Response(JSON.stringify({ error: 'DE already exists for this entry.' }), { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      // Duplicate check by username (account players)
      if (target.username && event.joiners.find(j => j.username === target.username && j.entryType === 'double')) {
        return new Response(JSON.stringify({ error: 'DE already exists for this player.' }), { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      // Lazy upgrade: assign entryId + entryType to legacy entry, set displayLabel
      // Both the upgrade and the new DE push happen in one KV save below.
      if (!target.entryId) {
        target.entryId      = crypto.randomUUID();
        target.entryType    = 'main';
        target.displayLabel = target.displayLabel || target.name;
      }
      event.joiners.push({
        entryId:       crypto.randomUUID(),
        entryType:     'double',
        sourceEntryId: target.entryId,
        username:      target.username || null,
        name:          target.name,
        displayLabel:  target.name + ' (DE)',
        joinedAt:      new Date().toISOString(),
        manualAdd:     target.manualAdd || false
      });
      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
```

- [ ] **Step 4.2: Commit**

```bash
git add functions/api/events.js
git commit -m "feat(events): add admin_add_de action with joinerIdx primary locator and lazy upgrade"
```

- [ ] **Step 4.3: Verify after deploy**

Run in browser console (as admin):
```js
await fetch('/api/events?action=admin_add_de', {
  method: 'PUT',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    adminUsername: 'admin',
    adminPassword: 'yourpassword',
    eventId: 'your-event-id',
    joinerIdx: 0
  })
}).then(r => r.json()).then(console.log)
```

Expected: `{ success: true, event: { joiners: [..., { entryType: "double", sourceEntryId: "uuid-of-main", displayLabel: "Name (DE)" }] } }`.

Test legacy entry (no `entryId`): confirm lazy upgrade assigns `entryId` + `entryType: "main"` to main entry AND creates DE in the same KV write. Test calling twice → 409. Test with `joinerIdx` pointing to a DE entry → 400 "Cannot add DE to a DE entry".

---

## Task 5: events.js — Update `admin_remove` with cascade, live inspection, force override

**Files:**
- Modify: `functions/api/events.js`

**What to read first:** Lines 297–322 (current admin_remove block).

- [ ] **Step 5.1: Replace the `admin_remove` handler body**

Find the entire `if (action === 'admin_remove') {` block. Keep the admin credential check. Replace everything from after the `isAdmin` check to the closing `}` with:

```js
      let eventsData;
      try {
        const raw = await kv.get(EVENTS_KEY);
        eventsData = raw ? JSON.parse(raw) : { events: [] };
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Could not load events.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const event = (eventsData.events || []).find(ev => ev.id === eventId);
      if (!event) return new Response(JSON.stringify({ error: 'Event not found.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      if (!Array.isArray(event.joiners)) event.joiners = [];

      const { joinerIdx, force } = body;
      const numIdx = Number(joinerIdx);
      if (isNaN(numIdx) || numIdx < 0 || numIdx >= event.joiners.length) {
        return new Response(JSON.stringify({ error: 'Invalid index.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const target = event.joiners[numIdx];

      // Collect target + any linked DE
      const toRemove = [target];
      if (target.entryType !== 'double' && target.type !== 'team') {
        if (target.entryId) {
          const linked = event.joiners.find(j => j.sourceEntryId === target.entryId);
          if (linked) toRemove.push(linked);
        } else if (target.username) {
          const linked = event.joiners.find(j => j.username === target.username && j.entryType === 'double');
          if (linked) toRemove.push(linked);
        }
      }

      // Live inspection — only checks event.builds and event.beyResults on this event
      const anyLive = toRemove.some(j => hasLiveData(event, j.entryId || null, j.name));
      if (anyLive && !force) {
        return new Response(
          JSON.stringify({ error: 'Builds or results exist for this entry. Send force: true to remove the roster entry only.' }),
          { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Remove joiner entries only — never delete event.builds or event.beyResults rows
      const removeSet = new Set(toRemove);
      event.joiners = event.joiners.filter(j => !removeSet.has(j));

      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
```

- [ ] **Step 5.2: Commit**

```bash
git add functions/api/events.js
git commit -m "feat(events): admin_remove cascades DE, inspects live data, supports force:true"
```

- [ ] **Step 5.3: Verify after deploy**

1. Add two joiners (main + DE). Admin-remove the main → confirm both main and DE are removed in one call.
2. Admin-remove a main entry that has builds registered → expect 409.
3. Repeat with `force: true` in the request body → joiners removed, check `GET /api/events` to confirm `builds` and `beyResults` rows were NOT deleted.

---

## Task 6: accounts.js — `player_rename` with events KV in the staged write contract

**Files:**
- Modify: `functions/api/accounts.js`

**What to read first:** Lines 199–317 (the full `player_rename` body from the s2/s3 load through the staged writes and rollback).

**Atomicity requirement:** Events KV must join the same staged write/rollback sequence as accounts and season data. If the events write fails, roll back accounts and season data and return an error. Do not return rename success with stale active event identity.

- [ ] **Step 6.1: Load events KV before the staged writes block**

Find the block that loads s2 and s3 (around lines 200–208):
```js
      let s2Raw = null, s3Raw = null, s2 = null, s3 = null;
      try {
        s2Raw = await kv.get('gamedata_s2');
        s2 = s2Raw ? JSON.parse(s2Raw) : null;
      } catch (_) { s2 = null; }
      try {
        s3Raw = await kv.get('gamedata_s3');
        s3 = s3Raw ? JSON.parse(s3Raw) : null;
      } catch (_) { s3 = null; }
```

Immediately after that block (still before the conflict checks), add:

```js
      let evRaw = null, evData = null;
      try {
        evRaw = await kv.get('events');
        evData = evRaw ? JSON.parse(evRaw) : null;
      } catch (_) { evData = null; }
```

- [ ] **Step 6.2: Prepare the updated events payload in memory**

Find the `applyRename` helper and the lines that call it (around lines 257–273):
```js
      const { updated: s2Updated, changed: s2Changed } = applyRename(s2);
      const { updated: s3Updated, changed: s3Changed } = applyRename(s3);
```

After those two lines, add:

```js
      // Prepare updated events: update joiners, live beyResults, and legacy build keys.
      // This runs in memory before any KV write so events can be rolled back if needed.
      let evUpdated = null, evChanged = false;
      if (evData) {
        evUpdated = JSON.parse(JSON.stringify(evData));
        for (const ev of (evUpdated.events || [])) {
          // Only touch events where this account has a solo joiner
          const hasSoloJoiner = (ev.joiners || []).some(
            j => j.username === selfUsername && j.type !== 'team'
          );
          if (!hasSoloJoiner) continue;

          // Update joiner name/displayLabel and collect affected entryIds
          const affectedEntryIds = new Set();
          for (const j of (ev.joiners || [])) {
            if (j.username === selfUsername && j.type !== 'team') {
              if (j.entryId) affectedEntryIds.add(j.entryId);
              j.name = newDisplayName;
              j.displayLabel = j.entryType === 'double'
                ? newDisplayName + ' (DE)'
                : newDisplayName;
              evChanged = true;
            }
          }

          // Update live beyResults:
          // - normalized entries: match by entryId
          // - legacy entries: match by old canonical name (no entryId) within this event
          for (const r of (ev.beyResults || [])) {
            if (r.entryId && affectedEntryIds.has(r.entryId)) {
              r.player = newDisplayName;
              evChanged = true;
            } else if (!r.entryId && r.player === oldDisplayName) {
              r.player = newDisplayName;
              evChanged = true;
            }
          }

          // Rename legacy name-keyed build entry (UUID-keyed DE builds are untouched)
          const builds = ev.builds;
          if (builds && Object.prototype.hasOwnProperty.call(builds, oldDisplayName)) {
            builds[newDisplayName] = builds[oldDisplayName];
            delete builds[oldDisplayName];
            evChanged = true;
          }
        }
      }
```

- [ ] **Step 6.3: Add events as the fourth staged write with full rollback**

Find the end of the existing `if (s3Changed)` block (around line 310). Immediately after it, insert:

```js
      if (evChanged && evUpdated) {
        try {
          await kv.put('events', JSON.stringify(evUpdated));
        } catch (e) {
          // Roll back everything written so far
          try { await kv.put(KEY, accountsRollback); } catch (_) {}
          try { if (s2Changed && s2Raw) await kv.put('gamedata_s2', s2Raw); } catch (_) {}
          try { if (s3Changed && s3Raw) await kv.put('gamedata_s3', s3Raw); } catch (_) {}
          return new Response(
            JSON.stringify({ error: 'Rename failed updating active events. All changes have been rolled back.' }),
            { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }
```

The final response line (`const { password: _pw, tokenVersion: _tv, ...safeAccount } = ...`) comes immediately after this block, unchanged.

- [ ] **Step 6.4: Commit**

```bash
git add functions/api/accounts.js
git commit -m "feat(accounts): player_rename includes events KV in staged write contract with rollback"
```

- [ ] **Step 6.5: Verify after deploy**

1. Join a solo event as a logged-in player and add a DE slot. In EventManager, create a match for the DE slot but do not finalize (leave it as an unfinalized live result in `beyResults`).
2. Go to Settings → Change Display Name → rename to a new name.
3. Open the event detail page → main entry shows new name; DE entry shows "NewName (DE)".
4. Call `GET /api/events` → confirm `joiners[*].name` updated, `joiners[*].displayLabel` updated for both main and DE, and any `beyResults` rows for the account's entryIds now have `player: "NewName"`.
5. Open EventManager → confirm roster cards show the new label. Check `resultsState` in console — `player` field uses the new name.
6. In EventManager, finalize the event. Confirm `beyResults` stats are recorded under `"NewName"` (not the old name), and only the new name key appears in the season gamedata archive.
7. **Rollback test (manual simulation):** Temporarily break the events KV write (e.g., by making `evChanged = true` but setting `evUpdated` to something invalid so `kv.put` throws). Confirm the rename API returns a 502 error, and that `GET /api/accounts` shows the ORIGINAL name was preserved (accounts KV was rolled back).

---

## Task 7: index.html — `getPlayerJoinState()` and join area 3-state machine

**Files:**
- Modify: `index.html`

**What to read first:** `isPlayerJoined` (~line 7070), `renderDetailJoinArea` (~line 7223), `renderEventsList` join button section (~line 7103).

- [ ] **Step 7.1: Replace `isPlayerJoined` with `getPlayerJoinState`**

Find `function isPlayerJoined(ev)` (line ~7070) and replace the entire function:

```js
function getPlayerJoinState(ev) {
  if (!playerSession) return 'none';
  const myUsername = playerSession.username;
  let hasMain = false, hasDe = false;
  for (const j of (ev.joiners || [])) {
    if (j.username === myUsername && j.type !== 'team') {
      if (j.entryType === 'double') hasDe = true;
      else hasMain = true;
    }
    // Team membership check (unchanged behavior)
    if (!hasMain && j.type === 'team' && Array.isArray(j.members)) {
      if (j.members.some(m => typeof m === 'object' && m.username === myUsername)) hasMain = true;
    }
  }
  if (hasMain && hasDe) return 'main+de';
  if (hasMain) return 'main';
  return 'none';
}
```

- [ ] **Step 7.2: Update `renderEventsList` join button logic**

Find the `joinBtnHtml` variable declaration in `renderEventsList` (around line 7121). It currently starts with `const joinBtnHtml = !playerSession ? ...`. Replace the entire `joined` variable and `joinBtnHtml` declaration:

```js
    const joinState  = getPlayerJoinState(ev);
    const joinBtnHtml = !playerSession
      ? `<div style="margin-top:10px;font-size:12px;color:var(--muted);text-align:center;padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">👤 <span style="cursor:pointer;color:var(--gold);text-decoration:underline" onclick="event.stopPropagation();openPlayerLoginModal()">Login</span> to join this event</div>`
      : ev.status !== 'open'
        ? ''
        : ev.type === '3v3'
          ? (joinState !== 'none'
              ? `<button class="ev-join-btn joined" onclick="event.stopPropagation();handleJoinToggle('${ev.id}',true)">✅ Joined — Click to Unjoin</button>`
              : `<button class="ev-join-btn" onclick="event.stopPropagation();openTeamJoinModal('${ev.id}')">🛡️ Join as a Team</button>`)
          : joinState === 'main+de'
            ? `<button class="ev-join-btn joined" onclick="event.stopPropagation();handleJoinToggle('${ev.id}',true)">✅ Joined + DE — Click to Unjoin</button>`
            : joinState === 'main'
              ? `<button class="ev-join-btn joined" onclick="event.stopPropagation();handleJoinToggle('${ev.id}',true)">✅ Joined — Click to Unjoin</button>`
              : `<button class="ev-join-btn" onclick="event.stopPropagation();handleJoinToggle('${ev.id}',false)">⚡ Join This Event</button>`;
```

Also remove the now-dead `const joined = isPlayerJoined(ev);` line (around line 7105) and the `const canJoin = ...` line that referred to `joined`.

- [ ] **Step 7.3: Replace `renderDetailJoinArea`**

Find `function renderDetailJoinArea(ev)` (line ~7223) and replace the entire function:

```js
function renderDetailJoinArea(ev) {
  const area = document.getElementById('evd-join-area');
  if (!area) return;
  if (!playerSession) {
    area.innerHTML = `<div style="font-size:12px;color:var(--muted);text-align:center;padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">👤 <span style="cursor:pointer;color:var(--gold);text-decoration:underline" onclick="closeEventDetail();openPlayerLoginModal()">Login</span> to join this event</div>`;
    return;
  }
  if (ev.status !== 'open') { area.innerHTML = ''; return; }
  const state = getPlayerJoinState(ev);
  const evId  = ev.id;
  area.innerHTML = '';

  if (ev.type === '3v3') {
    const btn = document.createElement('button');
    btn.className = state !== 'none' ? 'ev-join-btn joined' : 'ev-join-btn';
    btn.textContent = state !== 'none' ? "✅ You're In — Click to Unjoin" : '🛡️ Join as a Team';
    btn.onclick = state !== 'none' ? () => handleJoinToggle(evId, true) : () => openTeamJoinModal(evId);
    area.appendChild(btn);
    return;
  }

  // Solo state machine
  if (state === 'none') {
    const btn = document.createElement('button');
    btn.className = 'ev-join-btn';
    btn.textContent = '⚡ Join This Event';
    btn.onclick = () => handleJoinToggle(evId, false);
    area.appendChild(btn);
  } else if (state === 'main') {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px';

    const statusEl = document.createElement('span');
    statusEl.className = 'ev-join-btn joined';
    statusEl.style.cssText = 'flex:1;min-width:120px;text-align:center;cursor:default';
    statusEl.textContent = '✅ Joined';

    const deBtn = document.createElement('button');
    deBtn.className = 'ev-join-btn';
    deBtn.style.cssText = 'flex:1;min-width:120px;background:rgba(212,160,23,.1);border-color:var(--gold)';
    deBtn.textContent = '➕ Add Double Entry';
    deBtn.onclick = () => handleDeAdd(evId);

    const unjoinBtn = document.createElement('button');
    unjoinBtn.className = 'ev-join-btn joined';
    unjoinBtn.style.cssText = 'flex:1;min-width:120px';
    unjoinBtn.textContent = '✕ Unjoin';
    unjoinBtn.onclick = () => handleJoinToggle(evId, true);

    row.appendChild(statusEl); row.appendChild(deBtn); row.appendChild(unjoinBtn);
    area.appendChild(row);
  } else { // main+de
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px';

    const statusEl = document.createElement('span');
    statusEl.className = 'ev-join-btn joined';
    statusEl.style.cssText = 'flex:1;min-width:120px;text-align:center;cursor:default';
    statusEl.textContent = '✅ Joined + DE';

    const deRemBtn = document.createElement('button');
    deRemBtn.className = 'ev-join-btn joined';
    deRemBtn.style.cssText = 'flex:1;min-width:120px;background:rgba(224,48,48,.1);border-color:var(--red)';
    deRemBtn.textContent = '✕ Remove DE';
    deRemBtn.onclick = () => handleDeRemove(evId);

    const unjoinBtn = document.createElement('button');
    unjoinBtn.className = 'ev-join-btn joined';
    unjoinBtn.style.cssText = 'flex:1;min-width:120px';
    unjoinBtn.textContent = '✕ Unjoin Both';
    unjoinBtn.onclick = () => handleJoinToggle(evId, true);

    row.appendChild(statusEl); row.appendChild(deRemBtn); row.appendChild(unjoinBtn);
    area.appendChild(row);
  }
}
```

- [ ] **Step 7.4: Add `handleDeAdd` and `handleDeRemove` functions**

After `handleJoinToggle` (around line 7585), add:

```js
async function handleDeAdd(eventId) {
  if (!playerSession) { openPlayerLoginModal(); return; }
  const name = playerSession.account.displayName || playerSession.username;
  if (!confirm('Add a Double Entry for this event? You will appear in the bracket as "' + name + '" and "' + name + ' (DE)".')) return;
  try {
    const res = await fetch(EVENTS_API + '?action=de_add', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: playerSession.username, sessionToken: playerSession.sessionToken, eventId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    const idx = eventsData.findIndex(e => e.id === eventId);
    if (idx !== -1) eventsData[idx] = data.event;
    renderEventsList();
    if (currentEventDetail && currentEventDetail.id === eventId) {
      currentEventDetail = data.event;
      renderDetailJoinArea(data.event);
      renderDetailJoinersList(data.event);
    }
    showToast('✅ Double Entry added! Good luck! 🔥', 'success');
  } catch(e) { showToast('⚠ ' + e.message, 'error'); }
}

async function handleDeRemove(eventId) {
  if (!playerSession) return;
  if (!confirm('Remove your Double Entry slot? Your main entry stays.')) return;
  try {
    const res = await fetch(EVENTS_API + '?action=de_remove', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: playerSession.username, sessionToken: playerSession.sessionToken, eventId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    const idx = eventsData.findIndex(e => e.id === eventId);
    if (idx !== -1) eventsData[idx] = data.event;
    renderEventsList();
    if (currentEventDetail && currentEventDetail.id === eventId) {
      currentEventDetail = data.event;
      renderDetailJoinArea(data.event);
      renderDetailJoinersList(data.event);
    }
    showToast('Double Entry removed.', '');
  } catch(e) { showToast('⚠ ' + e.message, 'error'); }
}
```

- [ ] **Step 7.5: Commit**

```bash
git add index.html
git commit -m "feat(index): getPlayerJoinState, 3-state join area, handleDeAdd/handleDeRemove"
```

- [ ] **Step 7.6: Verify after deploy**

1. Open a solo event (status: open). Not logged in → "Login to join" message.
2. Log in, open event → "⚡ Join This Event".
3. Click Join → "✅ Joined", "➕ Add Double Entry", "✕ Unjoin".
4. Click "Add Double Entry" → confirm dialog → "✅ Joined + DE", "✕ Remove DE", "✕ Unjoin Both".
5. Click "Remove DE" → back to state 2.
6. Click "Unjoin Both" → confirm dialog (Task 8 adds it) → state 1.
7. Open a 3v3 event → confirm old join/unjoin behavior is unchanged.
8. On the events list page, verify the join button on the event card also reflects the correct state.

---

## Task 8: index.html — DE badge, `buildSoloJoinerRow`, `adminAddDE`, force-remove

**Files:**
- Modify: `index.html`

**What to read first:** `renderDetailJoinersList` (~line 7242), `adminRemoveJoiner` (~line 7637).

- [ ] **Step 8.1: Add `buildSoloJoinerRow` helper function**

Before `renderDetailJoinersList`, add:

```js
function buildSoloJoinerRow(j, i, isAdmin, evId) {
  const row = document.createElement('div');
  row.className = 'ev-joiner-row';
  row.dataset.joinerIdx = i;
  if (j.entryId) row.dataset.entryId = j.entryId;

  const num = document.createElement('span');
  num.className = 'ev-joiner-num';
  num.textContent = (i + 1) + '.';
  row.appendChild(num);

  const label = document.createElement('span');
  label.className = 'ev-joiner-name';
  label.textContent = j.displayLabel != null ? j.displayLabel : j.name;
  row.appendChild(label);

  if (j.entryType === 'double') {
    const badge = document.createElement('span');
    badge.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--gold);background:rgba(212,160,23,.12);border:0.5px solid var(--gold);border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle';
    badge.textContent = 'DE';
    row.appendChild(badge);
  }

  if (isAdmin && (j.entryType === 'main' || !j.entryType) && j.type !== 'team') {
    const deBtn = document.createElement('button');
    deBtn.className = 'ev-joiner-remove';
    deBtn.style.cssText = 'color:var(--gold);border-color:var(--gold);margin-left:auto';
    deBtn.title = 'Add Double Entry';
    deBtn.textContent = '+DE';
    const capturedIdx = i, capturedEntryId = j.entryId || null;
    deBtn.addEventListener('click', e => { e.stopPropagation(); adminAddDE(evId, capturedIdx, capturedEntryId); });
    row.appendChild(deBtn);
  }

  if (isAdmin) {
    const rmBtn = document.createElement('button');
    rmBtn.className = 'ev-joiner-remove';
    rmBtn.title = 'Remove';
    rmBtn.textContent = '✕';
    const capturedIdx = i;
    rmBtn.addEventListener('click', e => { e.stopPropagation(); adminRemoveJoiner(capturedIdx); });
    row.appendChild(rmBtn);
  }
  return row;
}
```

- [ ] **Step 8.2: Update `renderDetailJoinersList` to use DOM construction**

Find the `listEl.innerHTML = joiners.map((j, i) => {` block and replace it entirely with:

```js
  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  joiners.forEach((j, i) => {
    if (j.type === 'team') {
      const members = j.members || [];
      const tooltipMembers = members.map(m => {
        const name = escHtml(typeof m === 'object' ? m.displayName : m);
        const uname = (typeof m === 'object' && m.username && !m.isGuest)
          ? ` <span style="font-size:10px;color:var(--muted2);font-family:'Share Tech Mono',monospace">@${escHtml(m.username)}</span>`
          : (m.isGuest ? ` <span style="font-size:10px;color:var(--muted2);font-family:'Share Tech Mono',monospace">(guest)</span>` : '');
        return `<div class="ev-joiner-team-tooltip-member">${name}${uname}</div>`;
      }).join('');
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `<div class="ev-joiner-row">
        <span class="ev-joiner-num">${i + 1}.</span>
        <div class="ev-joiner-team-wrap" onclick="this.classList.toggle('tapped')">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="ev-joiner-name">${escHtml(j.teamName)}</span>
            <span class="ev-joiner-team-badge">TEAM</span>
          </div>
          <div class="ev-joiner-team-tooltip">
            <div class="ev-joiner-team-tooltip-title">🛡️ ${escHtml(j.teamName)}</div>
            ${tooltipMembers}
          </div>
        </div>
        ${isAdmin ? `<button class="ev-joiner-remove" onclick="adminRemoveJoiner(${i})" title="Remove">✕</button>` : ''}
      </div>`;
      frag.appendChild(wrapper.firstElementChild);
    } else {
      frag.appendChild(buildSoloJoinerRow(j, i, isAdmin, ev.id));
    }
  });
  listEl.appendChild(frag);
```

- [ ] **Step 8.3: Add `adminAddDE` function**

After `adminRemoveJoiner`, add:

```js
async function adminAddDE(eventId, joinerIdx, sourceEntryId) {
  if (!isAdmin || !currentEventDetail) return;
  const joiner = (currentEventDetail.joiners || [])[joinerIdx];
  if (!joiner) return;
  const label = joiner.displayLabel != null ? joiner.displayLabel : joiner.name;
  if (!confirm('Add a Double Entry for "' + label + '"?')) return;
  try {
    const reqBody = { adminUsername: _acAdminUsername, adminPassword: _acAdminPassword, eventId, joinerIdx };
    if (sourceEntryId) reqBody.sourceEntryId = sourceEntryId;
    const res = await fetch(EVENTS_API + '?action=admin_add_de', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    const idx = eventsData.findIndex(e => e.id === eventId);
    if (idx !== -1) eventsData[idx] = data.event;
    currentEventDetail = data.event;
    renderDetailJoinersList(data.event);
    renderEventsList();
    showToast('"' + label + ' (DE)" added!', 'success');
  } catch(e) { showToast('⚠ ' + e.message, 'error'); }
}
```

- [ ] **Step 8.4: Replace `adminRemoveJoiner` with force-remove support**

Replace the existing `adminRemoveJoiner` function (~line 7637):

```js
async function adminRemoveJoiner(joinerIdx, force) {
  if (!isAdmin || !currentEventDetail) return;
  const joiner = (currentEventDetail.joiners || [])[joinerIdx];
  if (!joiner) return;
  const label = joiner.displayLabel != null ? joiner.displayLabel : joiner.name;
  if (!force && !confirm('Remove "' + label + '" from Sure Bladers?')) return;
  try {
    const res = await fetch(EVENTS_API + '?action=admin_remove', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminUsername: _acAdminUsername,
        adminPassword: _acAdminPassword,
        eventId: currentEventDetail.id,
        joinerIdx,
        ...(force ? { force: true } : {})
      })
    });
    const data = await res.json();
    if (res.status === 409 && !force) {
      if (confirm('Builds or results exist for "' + label + '". Force-remove from roster only? Match data will NOT be deleted.')) {
        await adminRemoveJoiner(joinerIdx, true);
      }
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Failed');
    const idx = eventsData.findIndex(e => e.id === currentEventDetail.id);
    if (idx !== -1) eventsData[idx] = data.event;
    currentEventDetail = data.event;
    renderDetailJoinersList(data.event);
    renderEventsList();
    showToast('"' + label + '" removed.', '');
  } catch(e) { showToast('⚠ ' + e.message, 'error'); }
}
```

- [ ] **Step 8.5: Commit**

```bash
git add index.html
git commit -m "feat(index): DE badge in joiner list, adminAddDE, adminRemoveJoiner with force-remove"
```

- [ ] **Step 8.6: Verify after deploy**

1. Open a solo event as admin. Each main joiner row has `+DE` and `✕` buttons.
2. Click `+DE` on a main entry → DE entry appears with `[DE]` badge and only `✕` (no `+DE`).
3. Right-click `+DE` button in devtools → inspect → confirm user data (`label`) is NOT in the `onclick` attribute (it's in a closure via `addEventListener`).
4. Remove a DE entry that has builds (set up via EventManager) → 409 → second confirm with force language → force remove succeeds → builds rows preserved.
5. Remove a main entry → cascade removes its DE as well.

---

## Task 9: eventmanager.html — `slotKey()`, updated `getPlayers()`, `renderBuilds()`, `submitBuilds()` rename propagation

**Files:**
- Modify: `eventmanager.html`

**What to read first:** `getPlayers` (~line 2357), `playerKey` (~line 2379), `renderBuilds` (~line 2622), `showBuildAC` (~line 2709), `submitBuilds` (~line 2802).

- [ ] **Step 9.1: Add `slotKey` and update `playerKey`**

Find `function playerKey(name) { return name; }` (line ~2379). Insert `slotKey` before it:

```js
function slotKey(j) {
  return j.entryId != null ? j.entryId : (j.name || j.displayName || j.username || '');
}
```

Leave `playerKey` as-is (it is still used by legacy code that only has player names; it will be phased out progressively).

- [ ] **Step 9.2: Replace `getPlayers()`**

Replace the entire function (lines ~2357–2376):

```js
function getPlayers() {
  if (!currentEvent) return [];
  const players = [];
  const seen = new Set();
  for (const j of (currentEvent.joiners || [])) {
    if (j.type === 'team' && Array.isArray(j.members)) {
      for (const m of j.members) {
        const name = typeof m === 'object' ? m.displayName : m;
        if (name && !seen.has(name)) {
          seen.add(name);
          players.push({ name, displayLabel: name, entryId: null, entryType: null, sourceEntryId: null, username: null, manualAdd: false, team: j.teamName });
        }
      }
    } else {
      const key = slotKey(j);
      if (key && !seen.has(key)) {
        seen.add(key);
        players.push({
          name:          j.name || j.displayName || j.username || '',
          displayLabel:  j.displayLabel != null ? j.displayLabel : (j.name || j.displayName || j.username || ''),
          entryId:       j.entryId      || null,
          entryType:     j.entryType    || 'main',
          sourceEntryId: j.sourceEntryId || null,
          username:      j.username     || null,
          manualAdd:     j.manualAdd    || false,
          team:          null
        });
      }
    }
  }
  return players;
}
```

- [ ] **Step 9.3: Update `renderBuilds()` to use `slotKey(p)` as the build state key and `data-key` attribute**

In `renderBuilds()` (line ~2622), find every `const key = playerKey(p.name);` inside the `.map(p => {` callback and change to:

```js
    const key = slotKey(p);
```

Find the avatar initial and name display:
```js
            ${escHtml(p.name[0].toUpperCase())}
          ${escHtml(p.name)}
```

Change to:
```js
            ${escHtml((p.displayLabel || p.name)[0].toUpperCase())}
          ${escHtml(p.displayLabel || p.name)}
```

Find where `data-key` is set on the build input (the attribute passed to `showBuildAC`). It currently reads `data-key="${playerKey(p.name)}"` or similar. Change it to:

```js
data-key="${key}"
```

(This uses the already-computed `key = slotKey(p)` from above. No other change needed to `showBuildAC`, `pickBuildAC`, or `buildACKeydown` — those functions read `key` from the `data-key` attribute, so they automatically use UUID-keyed paths for new entries and name-keyed paths for legacy entries.)

- [ ] **Step 9.4: Update `submitBuilds()` build rename propagation to use `entryId`**

In `submitBuilds()` (line ~2802), find the loop that propagates build renames from `buildsState` into each match participant. It currently reads:

```js
const key = playerKey(m[side].player);
const newNames = buildsState[key] || [];
```

Change to:

```js
const key = m[side].entryId ? m[side].entryId : m[side].player;
const newNames = buildsState[key] || [];
```

This ensures that when builds are re-submitted, each match participant's build list is looked up by the slot's UUID (for post-DE entries) or by name (for legacy entries), preventing Ken's updated builds from bleeding into Ken (DE)'s slot or vice versa.

- [ ] **Step 9.5: Commit**

```bash
git add eventmanager.html
git commit -m "feat(eventmanager): slotKey(), getPlayers returns full joiner objects, renderBuilds uses slotKey and data-key, submitBuilds uses entryId for rename propagation"
```

- [ ] **Step 9.6: Verify**

Open EventManager on a solo event that has both a main entry and a DE entry. Confirm:
- Roster tab shows both `Ken` and `Ken (DE)` as separate cards.
- Bey Builds tab shows two separate build cards (one for `Ken`, one for `Ken (DE)`).
- Each build card's key in `buildsState` is the UUID (for new entries) or name (for legacy).
- Type into a build autocomplete field → suggestions populate correctly (the `data-key` carries the UUID to `showBuildAC`).
- No JS errors in console.

---

## Task 10: eventmanager.html — `rosterAddPlayer()` → `admin_add` API

**Files:**
- Modify: `eventmanager.html`

**What to read first:** `rosterAddPlayer` (~line 2566), `manualPlayers` declaration (search the file).

- [ ] **Step 10.1: Replace `rosterAddPlayer`**

Replace the entire `async function rosterAddPlayer()` (lines ~2566–2579):

```js
async function rosterAddPlayer() {
  if (!currentEvent) return;
  const nameInput = document.getElementById('roster-player-name-input');
  const name = nameInput.value.trim();
  if (!name) { showToast('Enter a player name.', 'error'); return; }
  const existingLabels = getPlayers().map(p => (p.displayLabel || p.name).toLowerCase());
  if (existingLabels.includes(name.toLowerCase())) { showToast('Player already in roster.', 'error'); return; }
  try {
    const res = await fetch('/api/events?action=admin_add', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminUsername: adminUser, adminPassword: adminPass, eventId: currentEvent.id, name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    currentEvent = data.event;
    const idx = allEvents.findIndex(e => e.id === currentEvent.id);
    if (idx !== -1) allEvents[idx] = currentEvent;
    nameInput.value = '';
    document.getElementById('roster-add-player-form').style.display = 'none';
    renderRoster();
    renderBuilds();
    showToast('✅ ' + name + ' added to roster.', 'success');
  } catch(e) { showToast('⚠ ' + e.message, 'error'); }
}
```

- [ ] **Step 10.2: Remove `manualPlayers` if it only served the old path**

Search for `let manualPlayers` (or `var manualPlayers`/`const manualPlayers`) in eventmanager.html. If it is only used by the old `rosterAddPlayer` local-push path (not referenced anywhere else), delete the declaration and any lines that push to it. If it is referenced elsewhere, leave it — the new `getPlayers()` no longer reads from it.

- [ ] **Step 10.3: Commit**

```bash
git add eventmanager.html
git commit -m "feat(eventmanager): rosterAddPlayer routes through admin_add API for server-assigned entryId"
```

- [ ] **Step 10.4: Verify**

Open EventManager → Roster tab → type a player name → Add. Confirm player appears in roster and builds tab. Call `GET /api/events` — confirm the new joiner has `entryId`, `entryType: "main"`, `displayLabel`. Click "Add DE" on the card (next task) — confirm it works immediately without re-joining.

---

## Task 11: eventmanager.html — Roster cards: DE badge and "Add DE" button

**Files:**
- Modify: `eventmanager.html`

**What to read first:** `renderRoster` (~line 2481), `rosterSaveJoiners` (~line 2543).

- [ ] **Step 11.1: Replace the solo branch of `renderRoster`**

Find the `else {` branch (non-team) of `renderRoster` (around line 2507):

```js
  } else {
    el.innerHTML = `<div class="roster-grid">${players.map(p => `
      ...
    `).join('')}</div>`;
  }
```

Replace with DOM-based construction:

```js
  } else {
    el.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'roster-grid';
    for (const p of players) {
      const card = document.createElement('div');
      card.className = 'roster-card';

      const avatar = document.createElement('div');
      avatar.className = 'roster-avatar';
      avatar.textContent = (p.displayLabel || p.name)[0].toUpperCase();
      card.appendChild(avatar);

      const info = document.createElement('div');

      const nameEl = document.createElement('div');
      nameEl.className = 'roster-name';
      nameEl.textContent = p.displayLabel || p.name;
      if (p.entryType === 'double') {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--gold);background:rgba(212,160,23,.12);border:0.5px solid var(--gold);border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle';
        badge.textContent = 'DE';
        nameEl.appendChild(badge);
      }
      info.appendChild(nameEl);

      const sub = document.createElement('div');
      sub.className = 'roster-sub';
      sub.textContent = 'Solo';
      info.appendChild(sub);

      if (p.entryType !== 'double') {
        const deBtn = document.createElement('button');
        deBtn.className = 'btn';
        deBtn.style.cssText = 'font-size:9px;padding:2px 7px;margin-top:4px;color:var(--gold);border-color:var(--gold);background:rgba(212,160,23,.07)';
        deBtn.textContent = '+ Add DE';
        const captured = p;
        deBtn.addEventListener('click', () => adminAddDEFromRoster(captured));
        info.appendChild(deBtn);
      }
      card.appendChild(info);
      grid.appendChild(card);
    }
    el.appendChild(grid);
  }
```

- [ ] **Step 11.2: Add `adminAddDEFromRoster` function**

After `rosterAddPlayer`, add:

```js
async function adminAddDEFromRoster(player) {
  if (!currentEvent) return;
  const label = player.displayLabel || player.name;
  if (!confirm('Add Double Entry for "' + label + '"?')) return;
  const joiners = currentEvent.joiners || [];
  let joinerIdx = player.entryId ? joiners.findIndex(j => j.entryId === player.entryId) : -1;
  if (joinerIdx === -1) {
    joinerIdx = joiners.findIndex(j =>
      (j.name || j.displayName || j.username) === player.name &&
      (!j.entryType || j.entryType === 'main') && j.type !== 'team'
    );
  }
  if (joinerIdx === -1) { showToast('Could not locate roster entry.', 'error'); return; }
  try {
    const reqBody = { adminUsername: adminUser, adminPassword: adminPass, eventId: currentEvent.id, joinerIdx };
    if (player.entryId) reqBody.sourceEntryId = player.entryId;
    const res = await fetch('/api/events?action=admin_add_de', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    currentEvent = data.event;
    const idx = allEvents.findIndex(e => e.id === currentEvent.id);
    if (idx !== -1) allEvents[idx] = currentEvent;
    renderRoster();
    renderBuilds();
    showToast('"' + label + ' (DE)" added!', 'success');
  } catch(e) { showToast('⚠ ' + e.message, 'error'); }
}
```

- [ ] **Step 11.3: Commit**

```bash
git add eventmanager.html
git commit -m "feat(eventmanager): roster cards show DE badge and Add DE button via adminAddDEFromRoster"
```

- [ ] **Step 11.4: Verify**

Open EventManager on a solo event. Roster tab shows each non-DE player with a "+ Add DE" button. Click it → DE card appears with `[DE]` badge. DE cards have no "+ Add DE" button. Refresh EventManager → DE entry persists (it was saved via API, not just in memory).

---

## Task 12: eventmanager.html — `_soloSid`, match participant shape, `nmSelectPlayer`, `nmFilterPlayers`, Ken-vs-Ken, `renderMatchCard`

**Files:**
- Modify: `eventmanager.html`

**What to read first:** `_soloSid` (~line 2942), `nmSelectPlayer` (~line 3324), `nmFilterPlayers` (~line 3275), `createMatch` (~line 3354), `loadMatchesFromResults` (~line 2949), `renderMatchCard` (~line 3499).

- [ ] **Step 12.1: Update `_soloSid` to accept participant objects**

Replace `_soloSid` (line ~2942):

```js
function _soloSid(round, p1, p2, instanceIdx) {
  // p1/p2 may be participant objects {entryId, player} or legacy strings
  const s1 = (p1 && p1.entryId) ? p1.entryId : (typeof p1 === 'string' ? p1 : (p1 && p1.player) || '');
  const s2 = (p2 && p2.entryId) ? p2.entryId : (typeof p2 === 'string' ? p2 : (p2 && p2.player) || '');
  return `${round}|${s1}|${s2}|${instanceIdx}`;
}
```

- [ ] **Step 12.2: Update `nmSelectPlayer` to receive full player object**

Replace `nmSelectPlayer` (lines ~3324–3337):

```js
function nmSelectPlayer(slot, playerObj) {
  // playerObj is a full player from getPlayers() — has name, displayLabel, entryId, entryType
  const displayName = playerObj.displayLabel || playerObj.name;
  const key   = slotKey(playerObj);
  const builds = (buildsState[key] || []).filter(Boolean);
  const playerData = {
    player:       playerObj.name,        // canonical name — ALWAYS .name, never displayLabel
    entryId:      playerObj.entryId      || null,
    entryType:    playerObj.entryType    || 'main',
    displayLabel: playerObj.displayLabel || playerObj.name,
    builds:       builds.map(b => ({ build: b, finishes: [], deployed: false }))
  };
  if (slot === 1) _nmP1 = playerData;
  else _nmP2 = playerData;

  document.getElementById(`nm-p${slot}-search`).value = '';
  document.getElementById(`nm-p${slot}-dropdown`).style.display = 'none';
  document.getElementById(`nm-p${slot}-selected`).style.display = '';
  document.getElementById(`nm-p${slot}-name`).textContent = displayName;
  document.getElementById(`nm-p${slot}-builds-preview`).textContent =
    builds.length ? builds.join(' · ') : 'No builds — go to Bey Builds tab first';
  document.getElementById('nm-error').textContent = '';

  const otherSearch = document.getElementById(`nm-p${slot === 1 ? 2 : 1}-search`);
  if (otherSearch.value || document.getElementById(`nm-p${slot === 1 ? 2 : 1}-dropdown`).style.display !== 'none') {
    nmFilterPlayers(slot === 1 ? 2 : 1, otherSearch.value);
  }
}
```

- [ ] **Step 12.3: Update `nmFilterPlayers` to pass full player object and use `slotKey`**

In `nmFilterPlayers` (line ~3310), change the `mousedown` handler:
```js
      div.addEventListener('mousedown', e => {
        e.preventDefault();
        nmSelectPlayer(slot, p.name);  // OLD
      });
```
To:
```js
      div.addEventListener('mousedown', e => {
        e.preventDefault();
        nmSelectPlayer(slot, p);  // pass full player object
      });
```

Also update the "disable if same slot" check in `nmFilterPlayers`. Find:
```js
    const isOther = otherSelected && otherSelected.player === p.name;
```
Replace with:
```js
    // Disable exact same slot (by entryId if available, else by name)
    const isOther = otherSelected && (
      (otherSelected.entryId && p.entryId && otherSelected.entryId === p.entryId) ||
      (!otherSelected.entryId && !p.entryId && otherSelected.player === p.name)
    );
```

Update the builds preview lookup in the dropdown:
```js
    const builds = (buildsState[playerKey(p.name)] || []).filter(Boolean);  // OLD
```
To:
```js
    const builds = (buildsState[slotKey(p)] || []).filter(Boolean);
```

- [ ] **Step 12.4: Add Ken-vs-Ken block in `createMatch`**

In `createMatch` (line ~3381), in the solo `else` branch, before `const soloPairCount = ...`, add:

```js
    // Block: same canonical player cannot face themselves
    if (_nmP1 && _nmP2 && _nmP1.player === _nmP2.player) {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:10000';
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--surface);border:1px solid var(--border2);border-radius:12px;padding:28px 24px;max-width:360px;text-align:center';
      const msg = document.createElement('p');
      msg.style.cssText = 'font-size:13px;color:var(--text);margin-bottom:18px;line-height:1.6';
      msg.textContent = _nmP1.player + ' and ' + _nmP1.player + ' (DE) share the same player. Challonge advancement for this pairing is handled manually. This match will not be recorded.';
      const okBtn = document.createElement('button');
      okBtn.className = 'btn primary';
      okBtn.textContent = 'OK';
      okBtn.onclick = () => document.body.removeChild(overlay);
      box.appendChild(msg); box.appendChild(okBtn); overlay.appendChild(box);
      document.body.appendChild(overlay);
      return;
    }
```

- [ ] **Step 12.5: Update `_soloSid` call in `createMatch`**

Find:
```js
      _sid: _soloSid(round, _nmP1.player, _nmP2.player, soloPairCount),
```
Change to:
```js
      _sid: _soloSid(round, _nmP1, _nmP2, soloPairCount),
```

- [ ] **Step 12.6: Update `_soloSid` call in `loadMatchesFromResults`**

Find (line ~3009):
```js
        _sid: _soloSid(round, p1.player, p2.player, idx),
```
Change to:
```js
        _sid: _soloSid(round, p1, p2, idx),
```

`p1` and `p2` here are `resultsState` rows which, after Task 13, will carry `entryId`. The fallback in `_soloSid` handles the case where `entryId` is absent (legacy rows).

- [ ] **Step 12.7: Update `renderMatchCard` to display `displayLabel` for DE participants**

In `renderMatchCard` (line ~3499), find where participant names are rendered. They currently read `match.p1.player` and `match.p2.player`. Change those to use `displayLabel` with a fallback:

```js
// Find lines like:
<span class="nm-player-name">${escHtml(match.p1.player)}</span>
// Change to:
<span class="nm-player-name">${escHtml(match.p1.displayLabel || match.p1.player)}</span>
```

Apply the same change for `match.p2`. If `renderMatchCard` uses template literals with `.player` on both participants, change both occurrences. Do NOT change `player` references inside logic (win calculation, stat lookups) — only the display text.

- [ ] **Step 12.8: Commit**

```bash
git add eventmanager.html
git commit -m "feat(eventmanager): _soloSid uses entryId, nmSelectPlayer receives full player obj, Ken-vs-Ken block, renderMatchCard shows displayLabel"
```

- [ ] **Step 12.9: Verify**

1. Open EventManager on a solo event with Ken + Ken (DE).
2. Open New Match → dropdown shows `Ken` and `Ken (DE)` as distinct options.
3. Select `Ken` (P1) and `Ken (DE)` (P2) → Ken-vs-Ken modal appears, no match created.
4. Select `Ken` (P1) and a different player (P2) → match created. Inspect `matchesState` in console — `p1.entryId` is set, `_sid` contains the UUID.
5. On the created match card: verify that `Ken (DE)` displays the DE label (not "Ken").
6. Existing tests: non-DE players still work; team matches unaffected.

---

## Task 13: eventmanager.html — `flattenMatchesToResults`, `loadMatchesFromResults`, and `mergeIncomingMatches`

**Files:**
- Modify: `eventmanager.html`

**What to read first:** `flattenMatchesToResults` (~line 3020), `loadMatchesFromResults` (~line 2949), `mergeIncomingMatches` (~line 5895).

- [ ] **Step 13.1: Update solo result rows in `flattenMatchesToResults`**

Find lines ~3046–3047:
```js
      if (m.p1) resultsState.push({ player: m.p1.player, round: m.round, builds: m.p1.builds, pointsTotal: calcPoints(m.p1.builds), win: m.p1.win, _submitted: m.submitted || undefined });
      if (m.p2) resultsState.push({ player: m.p2.player, round: m.round, builds: m.p2.builds, pointsTotal: calcPoints(m.p2.builds), win: m.p2.win, _submitted: m.submitted || undefined });
```

Replace with:
```js
      if (m.p1) resultsState.push({
        player:       m.p1.player,
        entryId:      m.p1.entryId      || undefined,
        entryType:    m.p1.entryType    || undefined,
        displayLabel: m.p1.displayLabel || undefined,
        round: m.round, builds: m.p1.builds,
        pointsTotal: calcPoints(m.p1.builds), win: m.p1.win, _submitted: m.submitted || undefined
      });
      if (m.p2) resultsState.push({
        player:       m.p2.player,
        entryId:      m.p2.entryId      || undefined,
        entryType:    m.p2.entryType    || undefined,
        displayLabel: m.p2.displayLabel || undefined,
        round: m.round, builds: m.p2.builds,
        pointsTotal: calcPoints(m.p2.builds), win: m.p2.win, _submitted: m.submitted || undefined
      });
```

- [ ] **Step 13.2: Update `loadMatchesFromResults` to restore `entryId`/`displayLabel` on p1/p2**

Find (lines ~3011–3015):
```js
        p1: { player: p1.player, builds: p1.builds || [], pointsTotal: p1.pointsTotal || 0, win: p1.win },
        p2: { player: p2.player, builds: p2.builds || [], pointsTotal: p2.pointsTotal || 0, win: p2.win },
```

Replace with:
```js
        p1: {
          player:       p1.player,
          entryId:      p1.entryId      || null,
          entryType:    p1.entryType    || 'main',
          displayLabel: p1.displayLabel || p1.player,
          builds: p1.builds || [], pointsTotal: p1.pointsTotal || 0, win: p1.win
        },
        p2: {
          player:       p2.player,
          entryId:      p2.entryId      || null,
          entryType:    p2.entryType    || 'main',
          displayLabel: p2.displayLabel || p2.player,
          builds: p2.builds || [], pointsTotal: p2.pointsTotal || 0, win: p2.win
        },
```

- [ ] **Step 13.3: Update `mergeIncomingMatches` to preserve `entryId`/`displayLabel` and use updated `_soloSid`**

In `mergeIncomingMatches(serverBuilds, serverResults)` (line ~5895), find where server result rows are projected into p1/p2 participant objects (around line 5942–5945). The current code builds p1/p2 without `entryId`/`displayLabel`:

```js
// CURRENT (approximate):
p1: { player: sm.p1.player, builds: ..., win: ... },
p2: { player: sm.p2.player, builds: ..., win: ... },
_sid: _soloSid(round, p1.player, p2.player, idx),
```

Replace with:
```js
p1: {
  player:       sm.p1.player,
  entryId:      sm.p1.entryId      || null,
  entryType:    sm.p1.entryType    || 'main',
  displayLabel: sm.p1.displayLabel || sm.p1.player,
  builds: sm.p1.builds || [], win: sm.p1.win
},
p2: {
  player:       sm.p2.player,
  entryId:      sm.p2.entryId      || null,
  entryType:    sm.p2.entryType    || 'main',
  displayLabel: sm.p2.displayLabel || sm.p2.player,
  builds: sm.p2.builds || [], win: sm.p2.win
},
_sid: _soloSid(round, sm.p1, sm.p2, idx),
```

Also update the orphan match detection logic (around line 5986–5990) where existing local matches are compared to incoming server matches. The current check uses name only:

```js
// CURRENT:
m.p1?.player === sm.p1.player && m.p2?.player === sm.p2.player
```

Replace with:
```js
// Use entryId for comparison if both sides have it; fall back to player name
(
  (m.p1?.entryId && sm.p1.entryId && m.p1.entryId === sm.p1.entryId) ||
  (!m.p1?.entryId && !sm.p1.entryId && m.p1?.player === sm.p1.player)
) && (
  (m.p2?.entryId && sm.p2.entryId && m.p2.entryId === sm.p2.entryId) ||
  (!m.p2?.entryId && !sm.p2.entryId && m.p2?.player === sm.p2.player)
)
```

- [ ] **Step 13.4: Commit**

```bash
git add eventmanager.html
git commit -m "feat(eventmanager): result rows carry entryId/displayLabel; loadMatchesFromResults and mergeIncomingMatches preserve slot identity"
```

- [ ] **Step 13.5: Verify**

1. Create a match between Ken and another player. Submit it.
2. In console: `JSON.stringify(resultsState, null, 2)` — confirm rows have `entryId`, `entryType`, `displayLabel`. Confirm `player` is canonical name (not `"Ken (DE)"`).
3. Reload EventManager — matches reload with correct participant data (entryId preserved).
4. Check the `_sid` for the match — it should use the UUID from `entryId`, not just the name.
5. Submit the match via the API. Reload EventManager. Confirm `mergeIncomingMatches` does not duplicate the match (the server-side `_sid` matches the local `_sid`).
6. Create a second match between Ken (DE) and a third player. Confirm it gets a distinct `_sid` from Ken's match.

---

## Task 14: eventmanager.html — Archive UUID→canonical-name key conversion

**Files:**
- Modify: `eventmanager.html`

**What to read first:** `archiveBeyResultsToGamedata` (~line 6477), specifically the `cleanedBuilds` loop (~line 6498).

**Build key lifecycle:** During an active event, `buildsState` is keyed by `slotKey(p)` = UUID for post-DE entries, name for legacy. This keeps Ken's and Ken (DE)'s builds separate throughout the tournament. On archive, UUID keys are converted to canonical player names so that both slots' builds merge under `"Ken"` in the season gamedata. This conversion happens ONLY inside `archiveBeyResultsToGamedata` — never during the live event.

- [ ] **Step 14.1: Add UUID detection in the `cleanedBuilds` loop**

Find the `cleanedBuilds` construction loop (lines ~6498–6517):
```js
  const cleanedBuilds = {};
  for (const [rawKey, val] of Object.entries(buildsState || {})) {
    const cleanKey = _resolveBladerKey(rawKey, existingBladerStats) || _normalizePlayerName(rawKey);
    ...
  }
```

Replace with:
```js
  // Build a UUID→canonical-name lookup from current event joiners.
  // UUID-keyed buildsState entries (post-DE format) must be converted to
  // canonical player names on archive so season stats stay name-keyed.
  const uuidToName = {};
  for (const j of (currentEvent.joiners || [])) {
    if (j.entryId && j.name) uuidToName[j.entryId] = j.name;
  }

  const cleanedBuilds = {};
  for (const [rawKey, val] of Object.entries(buildsState || {})) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawKey);
    const nameKey = isUuid ? (uuidToName[rawKey] || rawKey) : rawKey;
    const cleanKey = _resolveBladerKey(nameKey, existingBladerStats) || _normalizePlayerName(nameKey);
    if (!cleanKey) continue;
    if (cleanedBuilds[cleanKey]) {
      // Both main and DE slots map to the same canonical name — merge their build lists
      const existing = cleanedBuilds[cleanKey];
      const merged = [];
      const max = Math.max(existing.length, (val || []).length);
      for (let i = 0; i < max; i++) {
        const a = existing[i] || '', b = (val || [])[i] || '';
        merged[i] = a.length >= b.length ? a : b;
      }
      cleanedBuilds[cleanKey] = merged;
    } else {
      cleanedBuilds[cleanKey] = JSON.parse(JSON.stringify(val || []));
    }
  }
```

- [ ] **Step 14.2: Confirm `beyResults` rows in `cleanedResults` retain `entryId`/`displayLabel`**

The existing code does `JSON.parse(JSON.stringify(entry))` and only changes `e.player`. Since `flattenMatchesToResults` (Task 13) now includes `entryId`/`displayLabel` in result rows, those fields pass through the deep-copy intact. No additional code change needed — just verify in Step 14.3.

- [ ] **Step 14.3: Commit**

```bash
git add eventmanager.html
git commit -m "feat(eventmanager): archive converts UUID build keys to canonical-name keys; beyResults retain entryId"
```

- [ ] **Step 14.4: Verify after deploy**

1. Set up a solo event with Ken (main) and Ken (DE) entries, each with different builds.
2. Run and submit matches for both slots.
3. Press Save in EventManager.
4. Call `GET /api/data?key=gamedata_s3` in browser. Find `archivedBeyResults` for this event.
5. Check `builds` — key is `"Ken"` (canonical), not a UUID. Both slots' builds merged under `"Ken"`.
6. Check `beyResults` rows — each row has `entryId` and `displayLabel` intact. `player` is always `"Ken"`.

---

## Self-Review Checklist

After writing the plan, run through the spec's verification checklist against task coverage:

| Spec Check | Covered by |
|---|---|
| 1. Account player joins → main entry with entryId | Task 1 |
| 2. Player adds DE → Ken + Ken (DE) in roster | Tasks 3, 7 |
| 3. Third entry blocked → 409 | Task 3 |
| 4. DE without main → 404 | Task 3 |
| 5. Admin adds walk-in via admin_add, then admin_add_de | Tasks 1, 4 |
| 6. Legacy joiner lazy upgrade via admin_add_de (joinerIdx primary locator) | Task 4 |
| 7. EventManager rosterAddPlayer → admin_add → DE-eligible | Task 10 |
| 8. Team event shows no DE controls | Tasks 3, 4, 7 (3v3 check) |
| 9. Ken + Ken (DE) distinct builds; _sid uses entryId | Tasks 9, 12 |
| 10. Ken (DE) match records player: "Ken" (canonical) | Task 13 |
| 11. Ken vs Ken (DE) → blocked | Task 12 |
| 12. Unjoin blocked after builds/results | Task 2 |
| 13. Admin force-remove preserves builds/beyResults | Task 5 |
| 14. Admin removes main → cascade removes DE | Task 5 |
| 15. Legacy joiners work as main; name-keyed builds unchanged | Tasks 9, 14 |
| 16. Archive: UUID build keys → canonical-name; beyResults retain entryId | Task 14 |
| 17. Player rename updates joiners, beyResults, legacy build keys — all in one atomic staged write with rollback | Task 6 |
| 18. Build autocomplete uses UUID key via data-key attribute | Task 9 |
| 19. submitBuilds rename propagation uses entryId not name | Task 9 |
| 20. mergeIncomingMatches preserves entryId; orphan detection uses entryId | Task 13 |
| 21. renderMatchCard shows displayLabel for DE participants | Task 12 |
| 22. Security: sessionToken for player, admin credentials for admin, XSS-safe | Tasks 1–8 (DOM construction in Tasks 7, 8, 11, 12) |

All 22 items covered.

---

## Execution Checkpoints

**Checkpoint A — API layer** (Tasks 1–6): events.js new/updated actions, accounts.js player_rename event sync.

**Checkpoint B — Public event UI** (Tasks 7–8): index.html join state machine, DE badge, admin controls.

**Checkpoint C — EventManager slot identity** (Tasks 9–13): builds, autocomplete, submitBuilds propagation, matches, sync, renderMatchCard.

**Checkpoint D — Archive + verification** (Task 14): UUID→name key conversion, full end-to-end test.
