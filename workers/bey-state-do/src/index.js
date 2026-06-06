// ─────────────────────────────────────────────────────────────────────────────
// BeyStateDO — one Durable Object instance per Event ID.
//
// Why this exists:
//   The /api/beyresults Pages Function used to be read-merge-write against a
//   single KV blob. Two judges submitting at the same moment could both read
//   the same baseline, merge in their own data, and PUT back — last writer
//   silently overwrites the other's match.
//
// What this provides:
//   Cloudflare Durable Objects guarantee that all requests for one DO instance
//   are processed STRICTLY SERIALLY. By naming the DO instance with the event
//   ID (`idFromName(eventId)`), every write for that event funnels through a
//   single-threaded actor — there is no read-modify-write window during which
//   a concurrent write can race.
//
// The DO owns the per-event state:
//   { beyResults: [...], builds: {...}, version: <int> }
// `beyResults` includes tombstone records produced by mergeBeyResults so a
// stale client cannot resurrect a deleted match on a later PUT.
//
// On first access the DO lazily migrates from the legacy events KV blob if a
// hydrate hint is provided by the caller (BEY_HYDRATE_FROM_KV env). After the
// first PUT, the DO is authoritative.
// ─────────────────────────────────────────────────────────────────────────────

import {
  mergeBeyResults,
  mergeBuilds,
  computeSidsForEntries,
  stripTombstonesForResponse
} from './merge.js';

const STORAGE_STATE_KEY = 'state';

// Mirror index.html's _playerNamesMatch exactly:
//   const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
// Removes ALL whitespace (including internal spaces) and lowercases.
// "Alice Smith", "alicesmith", and "ALICE SMITH" all normalize to "alicesmith".
function normalizePlayerName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, '').toLowerCase() : '';
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

export class BeyStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async loadState() {
    const stored = await this.state.storage.get(STORAGE_STATE_KEY);
    if (stored) return stored;
    return { beyResults: [], builds: {}, version: 0, hydrated: false, purgedOwners: [] };
  }

  async saveState(next) {
    await this.state.storage.put(STORAGE_STATE_KEY, next);
  }

  // Hydrate from the legacy KV blob exactly once per DO instance. The Pages
  // function can pass a hydration hint in the PUT body (`__hydrateFromLegacy`)
  // so the first writer migrates the existing event data into the DO without
  // any external coordination.
  async maybeHydrateFromLegacy(legacy) {
    const cur = await this.loadState();
    if (cur.hydrated) return cur;
    if (!legacy || typeof legacy !== 'object') {
      cur.hydrated = true;
      await this.saveState(cur);
      return cur;
    }
    const next = {
      beyResults:   Array.isArray(legacy.beyResults) ? legacy.beyResults : [],
      builds:       (legacy.builds && typeof legacy.builds === 'object') ? legacy.builds : {},
      version:      1,
      hydrated:     true,
      // Migrate purgedOwners from KV event snapshot so a DO freshly hydrated
      // from KV honours prior purge operations.
      purgedOwners: Array.isArray(legacy.purgedOwners) ? legacy.purgedOwners : []
    };
    await this.saveState(next);
    return next;
  }

  async fetch(request) {
    // DOs process one request at a time. Everything below runs to completion
    // before the next request is dispatched — this is the atomicity guarantee.
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean); // ['event', <id>, <action>]
    const action = segments[2] || '';

    if (request.method === 'GET' && action === 'get') {
      const cur = await this.loadState();
      // Return 404 until the DO has been explicitly hydrated. A fresh DO
      // binding returns empty beyResults/builds which the Event Manager
      // live-sync would treat as "server has no matches" and wipe local
      // cards. The Pages Function already handles DO 404 by falling through
      // to KV, so this is the safe path for first-time reads.
      if (!cur.hydrated) {
        return jsonResponse({ error: 'Not yet hydrated — fall back to KV.' }, 404);
      }
      return jsonResponse({
        beyResults:   cur.beyResults,
        builds:       cur.builds,
        version:      cur.version || 0,
        purgedOwners: cur.purgedOwners || []
      });
    }

    if (request.method === 'PUT' && action === 'put') {
      let body;
      try { body = await request.json(); } catch (e) {
        return jsonResponse({ error: 'Invalid JSON: ' + e.message }, 400);
      }
      const {
        builds, beyResults, mergeMode, deletedSids,
        revivedSids,    // string[] — sids to un-tombstone (intentional re-import, e.g. Challonge)
        purgePlayers,   // string[] — player names to tombstone (deletePlayer admin op)
        renamePlayer,   // { from: string, to: string } — player rename (accounts.js)
        __hydrateFromLegacy
      } = body;

      // First-touch hydration from legacy KV (no-op after the first PUT).
      let cur = await this.maybeHydrateFromLegacy(__hydrateFromLegacy);

      // ── Apply renamePlayer BEFORE merge so the rename is serialized inside
      //    the DO's single-threaded actor. The KV snapshot in accounts.js may
      //    be stale if an Event Manager write landed between the rename read and
      //    this PUT; applying rename in the DO ensures consistency.
      let workingBeyResults = cur.beyResults || [];
      let workingBuilds     = cur.builds     || {};
      if (renamePlayer && renamePlayer.from && renamePlayer.to) {
        const { from, to } = renamePlayer;
        workingBeyResults = workingBeyResults.map(e => {
          if (e._tombstone || e.player !== from) return e;
          return {
            ...e,
            player: to,
            ...(e.displayLabel ? {
              displayLabel: e.entryType === 'double' ? to + ' (DE)' : to
            } : {})
          };
        });
        if (Object.prototype.hasOwnProperty.call(workingBuilds, from)) {
          // Merge old-name builds into new-name (new-name wins on overlap).
          const merged = { ...(workingBuilds[from] || []) };
          workingBuilds = { ...workingBuilds };
          workingBuilds[to] = workingBuilds[to] || workingBuilds[from];
          delete workingBuilds[from];
        }
      }

      // ── Expand purgePlayers into explicit deletedSids so the merge logic can
      //    tombstone them. Computing this here (inside the DO) ensures we see the
      //    most recent state, not whatever KV snapshot the client had.
      // Accumulate the list of permanently-purged build owners across PUTs.
      // Normalized names are stored so future merge PUTs cannot re-add builds
      // for a deleted player regardless of case or whitespace differences.
      let nextPurgedOwners = [...(cur.purgedOwners || [])];

      let effectiveDeletedSids = Array.isArray(deletedSids) ? [...deletedSids] : [];
      if (Array.isArray(purgePlayers) && purgePlayers.length) {
        // Normalized (case-insensitive, all-whitespace-stripped) purge matching.
        const purgeSet = new Set(purgePlayers.map(normalizePlayerName));
        for (const e of workingBeyResults) {
          if (e._matchSid && !e._tombstone && purgeSet.has(normalizePlayerName(e.player))) {
            effectiveDeletedSids.push(e._matchSid);
          }
        }
        // Remove purged players from the working builds dict immediately.
        workingBuilds = { ...workingBuilds };
        for (const k of Object.keys(workingBuilds)) {
          if (purgeSet.has(normalizePlayerName(k))) delete workingBuilds[k];
        }
        // Extend the persistent purged-owners list.
        for (const norm of purgeSet) {
          if (norm && !nextPurgedOwners.includes(norm)) nextPurgedOwners.push(norm);
        }
      }

      // Force merge when the DO already holds authoritative event state.
      // A legacy full-replace write from index.html (mergeMode omitted) would
      // otherwise wipe tombstones and matches accumulated by concurrent Event
      // Manager clients. The only safe full-replace is the very first write to
      // a fresh DO instance (cur.hydrated is false at that point).
      const effectiveMergeMode = mergeMode === true || cur.hydrated;

      let nextBeyResults;
      let nextBuilds;
      const mergeOpts = Array.isArray(revivedSids) ? { revivedSids } : undefined;
      if (effectiveMergeMode) {
        nextBeyResults = Array.isArray(beyResults)
          ? mergeBeyResults(workingBeyResults, beyResults, effectiveDeletedSids, mergeOpts)
          : mergeBeyResults(workingBeyResults, [], effectiveDeletedSids, mergeOpts);
        nextBuilds = (builds && typeof builds === 'object')
          ? mergeBuilds(workingBuilds, builds)
          : workingBuilds;
      } else {
        // First write to a fresh DO (cur.hydrated is false): full-replace is
        // safe here because there is no accumulated state to protect yet.
        nextBeyResults = (beyResults !== undefined) ? beyResults : workingBeyResults;
        nextBuilds = (builds !== undefined) ? builds : workingBuilds;
      }

      // Strip purged owners from the merged builds map so stale merge PUTs
      // cannot resurrect a deleted player's builds.
      if (nextPurgedOwners.length) {
        const purgedSet = new Set(nextPurgedOwners);
        nextBuilds = { ...nextBuilds };
        for (const k of Object.keys(nextBuilds)) {
          if (purgedSet.has(normalizePlayerName(k))) delete nextBuilds[k];
        }
      }

      const next = {
        beyResults:   nextBeyResults,
        builds:       nextBuilds,
        version:      (cur.version || 0) + 1,
        hydrated:     true,
        purgedOwners: nextPurgedOwners
      };
      await this.saveState(next);

      return jsonResponse({
        success: true,
        version: next.version,
        beyResults: stripTombstonesForResponse(nextBeyResults),
        builds: nextBuilds
      });
    }

    // ── Admin reactivation merge: import KV state into an already-hydrated DO ──
    //
    // Why this exists:
    //   The DO is authoritative once hydrated. If an operator rolls back to the
    //   KV-only code path, writes during that window land in KV but not the DO.
    //   On reactivation the DO ignores those KV writes — its `hydrated: true`
    //   flag prevents __hydrateFromLegacy from re-applying. This action lets the
    //   admin merge KV state INTO the existing DO state safely:
    //     • Existing DO tombstones / purgedOwners are preserved.
    //     • Tombstones present in the KV payload are union-merged.
    //     • Data entries are merged via the same mergeBeyResults helper used by
    //       judge writes (so SID-keyed updates replace, not duplicate).
    //     • purgedOwners from KV are unioned in; builds for purged owners are
    //       filtered out of the merged builds map.
    //   For a never-hydrated DO, this behaves like the normal first-write
    //   hydration so it is safe to call before the first judge submission.
    if (request.method === 'PUT' && action === 'import') {
      let body;
      try { body = await request.json(); } catch (e) {
        return jsonResponse({ error: 'Invalid JSON: ' + e.message }, 400);
      }

      const kvBeyResults  = Array.isArray(body.beyResults) ? body.beyResults : [];
      const kvBuilds      = (body.builds && typeof body.builds === 'object' && !Array.isArray(body.builds)) ? body.builds : {};
      const kvPurgedOwners = Array.isArray(body.purgedOwners) ? body.purgedOwners : [];

      let cur = await this.loadState();

      // Never-hydrated DO: route through the same lazy-hydration path normal
      // first writes use. This makes __syncFromKV before any judge PUT a no-op
      // beyond writing the KV snapshot as the initial DO state.
      if (!cur.hydrated) {
        const hydrated = await this.maybeHydrateFromLegacy({
          beyResults:   kvBeyResults,
          builds:       kvBuilds,
          purgedOwners: kvPurgedOwners
        });
        return jsonResponse({
          success:    true,
          imported:   'hydrated-from-kv',
          version:    hydrated.version || 0,
          beyResults: stripTombstonesForResponse(hydrated.beyResults || []),
          builds:     hydrated.builds || {}
        });
      }

      // Hydrated DO: merge KV state on top of existing DO state.
      //
      // Tombstones must keep their ORIGINAL _deletedAt — passing tombstone sids
      // through mergeBeyResults's deletedSidsArr would record them as new
      // deletions stamped Date.now(), refreshing the TTL on every __syncFromKV
      // call and contradicting its idempotence contract. Instead we union
      // DO + KV tombstones into a single record set (max _deletedAt per sid)
      // and inject them into the `existing` array, where mergeBeyResults
      // preserves them with their stored timestamps.
      const incomingData = kvBeyResults.filter(e => !(e && typeof e === 'object' && e._tombstone === true));

      const nowMs   = Date.now();
      const tombMap = new Map(); // sid → _deletedAt
      function recordTomb(e) {
        if (!e || typeof e !== 'object' || e._tombstone !== true) return;
        if (typeof e._matchSid !== 'string' || !e._matchSid) return;
        const at = (typeof e._deletedAt === 'number' && Number.isFinite(e._deletedAt)) ? e._deletedAt : nowMs;
        const prev = tombMap.get(e._matchSid);
        if (prev === undefined || at > prev) tombMap.set(e._matchSid, at);
      }
      for (const e of (cur.beyResults || [])) recordTomb(e);
      for (const e of kvBeyResults)           recordTomb(e);

      const existingDataOnly = (cur.beyResults || []).filter(e => !(e && typeof e === 'object' && e._tombstone === true));
      const existingWithUnionedTombs = [
        ...existingDataOnly,
        ...Array.from(tombMap.entries()).map(([sid, at]) => ({ _matchSid: sid, _tombstone: true, _deletedAt: at }))
      ];

      const mergedBey    = mergeBeyResults(existingWithUnionedTombs, incomingData, []);
      const mergedBuilds = mergeBuilds(cur.builds || {}, kvBuilds);

      // Union purgedOwners (already normalised at write time on both sides).
      const nextPurgedOwners = [...(cur.purgedOwners || [])];
      for (const n of kvPurgedOwners) {
        if (typeof n === 'string' && n && !nextPurgedOwners.includes(n)) nextPurgedOwners.push(n);
      }

      let finalBuilds = mergedBuilds;
      if (nextPurgedOwners.length) {
        const purgedSet = new Set(nextPurgedOwners);
        finalBuilds = { ...mergedBuilds };
        for (const k of Object.keys(finalBuilds)) {
          if (purgedSet.has(normalizePlayerName(k))) delete finalBuilds[k];
        }
      }

      const next = {
        beyResults:   mergedBey,
        builds:       finalBuilds,
        version:      (cur.version || 0) + 1,
        hydrated:     true,
        purgedOwners: nextPurgedOwners
      };
      await this.saveState(next);

      return jsonResponse({
        success:    true,
        imported:   'merged-from-kv',
        version:    next.version,
        beyResults: stripTombstonesForResponse(mergedBey),
        builds:     finalBuilds
      });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
}

// The Worker's default export is required by Wrangler but the DO is the only
// surface area we actually use. Anyone hitting the Worker URL directly gets
// a 404 — Pages Functions reach the DO via the service binding stub instead.
export default {
  async fetch() {
    return new Response('BeyStateDO worker — bind via env.BEY_STATE_DO, do not call directly.', { status: 404 });
  }
};
