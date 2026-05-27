// Shared helper used by multiple Pages Functions to interact with BeyStateDO.
// Pages Functions cannot import each other, but they CAN import from shared
// modules in the same project tree.

/**
 * Fetch live beyResults for a single event.
 * • When BEY_STATE_DO is bound and the DO is hydrated (200), returns DO state.
 * • When DO returns 404 (not yet hydrated), falls through to KV fallback.
 * • When DO returns any other error status OR throws, this function THROWS so
 *   callers performing destructive operations (unjoin, admin_remove, de_remove)
 *   can return 502 rather than using stale KV data that may be missing live results.
 *
 * @param {object} env         - Cloudflare env (env.BEY_STATE_DO, env.BEYBLADE_KV)
 * @param {string} eventId     - event identifier
 * @param {object|null} kvEvent - event object already loaded from KV (avoids re-read)
 * @returns {{ beyResults: any[], builds: object }}
 * @throws {Error} when DO is bound but returns a non-404 error or network exception
 */
export async function fetchLiveEventResults(env, eventId, kvEvent = null) {
  if (env.BEY_STATE_DO) {
    const id   = env.BEY_STATE_DO.idFromName(eventId);
    const stub = env.BEY_STATE_DO.get(id);
    const url  = `https://bey-state-do/event/${encodeURIComponent(eventId)}/get`;

    let res;
    try {
      res = await stub.fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      // Network/runtime error reaching the DO. Fail closed: callers performing
      // destructive operations must not use stale KV data as a substitute.
      throw new Error('[fetchLiveEventResults] DO fetch threw: ' + (e && e.message ? e.message : String(e)));
    }

    if (res.ok) {
      const state = await res.json();
      return { beyResults: state.beyResults || [], builds: state.builds || {} };
    }

    if (res.status === 404) {
      // DO is bound but not yet hydrated for this event — fall through to KV.
      // This is the normal state before the first Event Manager PUT for an event.
    } else {
      // Unexpected DO error (5xx, 400, etc.). Fail closed rather than silently
      // returning stale KV data — a destructive op (unjoin) could proceed despite
      // live results that only exist in the (currently failing) DO.
      const errText = await res.text().catch(() => '(unreadable)');
      throw new Error(`[fetchLiveEventResults] DO returned ${res.status}: ${errText}`);
    }
  }

  // KV fallback — only reached when DO is unbound or returned 404.
  if (kvEvent) return { beyResults: kvEvent.beyResults || [], builds: kvEvent.builds || {} };
  return { beyResults: [], builds: {} };
}

/**
 * Send a renamePlayer PUT to the DO for a single event.
 * No-op when BEY_STATE_DO is not bound.
 *
 * When the DO for this event has never been hydrated, passing a hydrateHint
 * (the post-rename KV event snapshot) lets the DO initialise from the correct
 * state before applying the rename — preventing an empty-state hydration that
 * would hide all existing KV matches from subsequent DO reads.
 *
 * THROWS on DO network errors or non-2xx responses so the caller can roll back
 * any KV writes that already succeeded. Callers must not swallow the error
 * without rolling back — an uncommunicated partial failure leaves KV and DO
 * inconsistent and the DO stays authoritative with the stale player name.
 *
 * @param {object}      env        - Cloudflare env
 * @param {string}      eventId
 * @param {string}      from       - old display name
 * @param {string}      to         - new display name
 * @param {object|null} hydrateHint - { beyResults, builds, purgedOwners? } from updated KV event
 * @throws {Error} when DO is unavailable or returns a non-2xx status
 */
export async function doRenamePlayerInEvent(env, eventId, from, to, hydrateHint = null) {
  if (!env.BEY_STATE_DO) return;
  const id   = env.BEY_STATE_DO.idFromName(eventId);
  const stub = env.BEY_STATE_DO.get(id);
  const url  = `https://bey-state-do/event/${encodeURIComponent(eventId)}/put`;
  const payload = { renamePlayer: { from, to }, mergeMode: true };
  if (hydrateHint && typeof hydrateHint === 'object') {
    payload.__hydrateFromLegacy = hydrateHint;
  }

  // We split the two failure modes deliberately because callers must compensate
  // differently:
  //   • `outcome: 'unknown'` — fetch itself threw, so the rename may or may not
  //     have committed inside the DO before the response was lost. Callers must
  //     treat the event as potentially modified and run compensation on it.
  //   • `outcome: 'not-applied'` — the DO returned a non-2xx response. The DO
  //     handler awaits saveState BEFORE returning 200, so any non-2xx implies
  //     the merge did not commit. Callers may roll back KV without touching
  //     this DO.
  let res;
  try {
    res = await stub.fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    const err = new Error(
      `[doRenamePlayerInEvent] fetch threw for event ${eventId}: ${e && e.message ? e.message : String(e)}`
    );
    err.outcome = 'unknown';
    err.cause   = e;
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '(unreadable)');
    const err = new Error(
      `[doRenamePlayerInEvent] DO returned ${res.status} for event ${eventId}: ${errText}`
    );
    err.outcome = 'not-applied';
    err.status  = res.status;
    throw err;
  }
}
