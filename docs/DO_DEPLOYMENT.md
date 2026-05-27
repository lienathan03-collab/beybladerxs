# BeyStateDO — Deployment Guide

## Why it exists

`/api/beyresults` originally read-merged-wrote a single KV blob. Two judges
submitting results at the same moment could both read the same baseline,
merge their own match in, and write back — the last writer silently overwrote
the other's match.

`BeyStateDO` is a Cloudflare Durable Object. One instance is created per
event ID (`idFromName(eventId)`). Cloudflare guarantees that requests to a
single DO instance are processed **strictly serially** — there is no concurrent
read-merge-write window. This eliminates the multi-judge race entirely.

## Architecture

```
Browser / Event Manager
    │
    ▼
Cloudflare Pages Function
    /api/beyresults (functions/api/beyresults.js)
    │
    ├─── env.BEY_STATE_DO bound? ──YES──▶ Durable Object (bey-state-do worker)
    │                                          stores { beyResults, builds, version }
    │                                          per event — AUTHORITATIVE
    │
    └─── NO ──▶ BEYBLADE_KV (best-effort, concurrent writes may be lost)
```

When `BEY_STATE_DO` is **not** bound, the Pages Function falls back to KV with
a `X-BEY-CONCURRENCY: best-effort-kv` warning header. For a single-judge
tournament this is fine. For simultaneous multi-device submissions enable the DO.

## Step-by-step deployment

### 1. Deploy the DO worker

```bash
cd workers/bey-state-do
npm install          # if you add any npm deps later; currently zero deps
wrangler deploy
```

This registers the `BeyStateDO` class and runs the migration that creates the
DO namespace. The output will confirm the worker name (`bey-state-do`).

### 2. Wire the binding in wrangler.toml

The root `wrangler.toml` already has the correct `[[durable_objects.bindings]]` stanza:

```toml
[[durable_objects.bindings]]
name        = "BEY_STATE_DO"
class_name  = "BeyStateDO"
script_name = "bey-state-do"
```

> **Important:** This binding type **must** be `[[durable_objects.bindings]]`, **not** `[[services]]`.
> `[[services]]` creates a Worker-to-Worker HTTP binding which does **not** expose `idFromName()`
> or `get()` — those methods only exist on a proper DO namespace stub. The Pages Function calls
> both methods, so the wrong binding type causes a runtime error on the first request.

The `BEYBLADE_KV` binding points at the existing Cloudflare KV namespace named
`BEYBLADE_DATA`.

### 3. Deploy the Pages project

```bash
wrangler pages deploy
```

After this deploy, every `PUT /api/beyresults` call is routed through the DO
and serialized. The first PUT for each event migrates existing KV data into the
DO automatically (lazy migration — no batch script needed).

### 4. Verify

After a judge submits a match, the response header `X-BEY-CONCURRENCY` should
read `durable-object`. If it reads `best-effort-kv`, the binding is not active.

## First-write migration (automatic)

The DO starts unhydrated. On the **first PUT** for a given event the Pages
Function reads the event's current state from KV and includes it in the
`__hydrateFromLegacy` field of the DO PUT body. The DO applies it once (the
flag `hydrated: true` prevents re-application) and immediately continues with
the incoming merge on top of the migrated baseline.

No manual migration script is needed. The DO becomes authoritative after the
first normal judge submission.

## Rolling back to KV-only

> ⚠️ **Data-loss risk — read this section before removing the binding.**

Once `BEY_STATE_DO` is bound and any judge submits a match (triggering the
first PUT per event), **the DO becomes the authoritative store for that event.**
Subsequent writes (judge submissions, admin purges, player renames) update the
DO only — **KV is not kept in sync with DO writes** after the first migration.

Removing the `[[durable_objects.bindings]]` stanza causes the Pages Function
to fall back to KV, which will serve the **stale KV snapshot** captured at the
time of the first PUT (or before). Any matches, purges, or renames applied
through the DO will be silently invisible.

### Export DO state to KV before rolling back

> **Important:** A normal `PUT /api/beyresults` always routes to the DO while
> `BEY_STATE_DO` is bound — `mergeMode: false` does **not** bypass it. The only
> way to write KV directly while the binding is active is the `__syncToKV`
> admin action described below.

For every active event, synchronise DO state back to KV using the built-in
export endpoint, while the DO binding is still active:

1. Call `PUT /api/beyresults` with admin credentials, the `eventId`, and
   `"__syncToKV": true`. This reads the current authoritative DO state and
   writes it directly to KV, bypassing normal DO routing.

2. Repeat for every event that has had judge activity since the binding was
   first deployed.

3. Remove the `[[durable_objects.bindings]]` stanza and redeploy.

```bash
# Sync a single event's DO state to KV (run before removing the binding)
curl -X PUT "https://yoursite.pages.dev/api/beyresults" \
  -H "Content-Type: application/json" \
  -d '{
    "adminUsername": "YOUR_ADMIN_USER",
    "adminPassword": "YOUR_ADMIN_PASS",
    "eventId":       "MY-EVENT-ID",
    "__syncToKV":    true
  }'
# Response: { "success": true, "synced": { "beyResults": [...], "builds": {...} } }
```

The `__syncToKV` action:
- Requires admin credentials (same as all write operations).
- Reads the current authoritative DO state. The **raw** beyResults array —
  **including tombstones** — is written to KV; only the API response body
  strips tombstones for the caller. Tombstones (and `purgedOwners`) must
  persist in KV so any merge PUT processed via the KV-only path during the
  rollback window cannot resurrect a previously deleted match or re-add a
  purged player's builds.
- Writes `beyResults`, `builds`, and `purgedOwners` directly to the KV event
  blob, bypassing DO routing.
- Is idempotent — safe to call multiple times before removing the binding.
- Returns 404 if the DO for that event has not yet been hydrated (in which
  case KV already holds the current state).

### Re-activating the DO binding

> ⚠️ **You must run `__syncFromKV` for every event after re-adding the binding,
> before live judge traffic resumes.** Otherwise any matches written during the
> KV-only window will be invisible — the already-hydrated DO ignores KV.

Re-add the `[[durable_objects.bindings]]` stanza and redeploy. The DO for each
event resumes from its stored state (which includes all writes made while the
binding was active before rollback).

**Important:** writes made while the DO binding was removed went to KV only.
On reactivation:

- **If the DO for an event was never hydrated**, the first judge PUT will
  lazily migrate the current KV state via `__hydrateFromLegacy` — no admin
  action needed.
- **If the DO was already hydrated** (the common case after a rollback from
  an active deployment), the DO will silently ignore KV. `__hydrateFromLegacy`
  is a no-op once `hydrated: true` is set. The `__syncFromKV` admin action
  below must be run for each affected event before judges resume submitting.

```bash
# Merge current KV state into the (already-hydrated) DO for one event.
curl -X PUT "https://yoursite.pages.dev/api/beyresults" \
  -H "Content-Type: application/json" \
  -d '{
    "adminUsername": "YOUR_ADMIN_USER",
    "adminPassword": "YOUR_ADMIN_PASS",
    "eventId":       "MY-EVENT-ID",
    "__syncFromKV":  true
  }'
# Response: { "success": true, "imported": "merged-from-kv", "version": <int>, "beyResults": [...], "builds": {...} }
```

The `__syncFromKV` action:
- Requires admin credentials.
- Reads the current KV event state (`beyResults` including tombstones,
  `builds`, `purgedOwners`) and posts it to the DO's `/import` endpoint.
- Merges KV state on top of existing DO state — it does NOT replace.
  - Data entries are merged via the same SID-keyed merge used by judge PUTs
    (incoming wins per SID; no duplicate rows).
  - Tombstones present on either side persist.
  - `purgedOwners` lists are unioned; builds for any purged owner are stripped
    from the merged builds map.
- Is idempotent: re-running it after a no-op KV state is harmless.
- For a never-hydrated DO it behaves as a normal first-write hydration — safe
  to run unconditionally after reactivation.

## Concurrent-write semantics summary

| Mode | Concurrent safety | When to use |
|------|-------------------|-------------|
| `best-effort-kv` | ❌ Last-writer-wins race | Single judge, development |
| `durable-object` | ✅ Strictly serial per event | Multi-judge tournaments |
