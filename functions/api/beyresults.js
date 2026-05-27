const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EVENTS_KEY = 'events';

// Mirror index.html's _playerNamesMatch exactly:
//   const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
// This removes ALL whitespace (including internal spaces) and lowercases,
// so "Alice Smith", "alicesmith", "ALICE SMITH" all normalize to "alicesmith".
function normalizePlayerName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, '').toLowerCase() : '';
}

// Tombstone TTL — after this much elapsed real-time, a deletion is forgotten
// and the same _matchSid may be created again. 24h is enough to outlive any
// realistic stale-client window during a tournament day while still letting an
// admin re-create the "same" match the next day.
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Identity helpers — mirror eventmanager.html's _soloSid / _teamSid exactly.
// A match "_matchSid" is stable across devices because it's derived from the
// round + (entryId | player) + slot-occurrence index.
// ─────────────────────────────────────────────────────────────────────────────
function soloSid(round, p1, p2, idx) {
  return `${round}|${p1.entryId || p1.player}|${p2.entryId || p2.player}|${idx}`;
}

function teamSid(round, t1, t2, idx) {
  return `${round}|T|${t1}|${t2}|${idx}`;
}

function isTombstone(e) {
  return !!(e && typeof e === 'object' && e._tombstone === true);
}

// Attach _matchSid to entries that lack one, using positional pairing — the
// same rule the client uses when reconstructing matches from a flat beyResults
// array. Existing _matchSid values are preserved untouched (so a client that
// already labels its entries wins; legacy data is migrated implicitly).
// Tombstone records (carrying _matchSid already) are NEVER repaired through
// pairing — they're identity-only markers.
export function computeSidsForEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = entries.map(e => (e && typeof e === 'object') ? { ...e } : e);

  const byRound = new Map();
  out.forEach((e, idx) => {
    if (!e || typeof e !== 'object') return;
    if (isTombstone(e)) return;
    const round = e.round;
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(idx);
  });

  for (const [round, indices] of byRound.entries()) {
    const teamIndices = indices.filter(i => out[i].team);
    const soloIndices = indices.filter(i => !out[i].team);

    if (teamIndices.length) {
      const teamNames = [];
      const seen = new Set();
      for (const i of teamIndices) {
        const t = out[i].team;
        if (t && !seen.has(t)) { seen.add(t); teamNames.push(t); }
      }
      const sidByTeam = {};
      const pairCount = {};
      for (let i = 0; i < teamNames.length; i += 2) {
        const t1 = teamNames[i];
        const t2 = teamNames[i + 1];
        if (!t1 || !t2) continue;
        const key = `${t1}||${t2}`;
        const idx = pairCount[key] || 0;
        pairCount[key] = idx + 1;
        const sid = teamSid(round, t1, t2, idx);
        sidByTeam[t1] = sid;
        sidByTeam[t2] = sid;
      }
      for (const i of teamIndices) {
        if (!out[i]._matchSid) {
          const computed = sidByTeam[out[i].team];
          if (computed) out[i]._matchSid = computed;
        }
      }
    }

    // MANUAL-round entries are standalone singletons — each player record is
    // its own discrete result (admin-entered points, no opponent). Extract
    // them BEFORE the pairing loop so two MANUAL entries in the same event
    // are never accidentally paired into a shared SID.
    const soloForPairing = [];
    for (const i of soloIndices) {
      const e = out[i];
      if (round === 'MANUAL') {
        if (!e._matchSid) {
          e._matchSid = `MANUAL|${e.entryId || e.player}`;
        }
      } else {
        soloForPairing.push(i);
      }
    }

    const soloPairCount = {};
    for (let p = 0; p < soloForPairing.length; p += 2) {
      const i1 = soloForPairing[p];
      const i2 = soloForPairing[p + 1];
      const p1 = out[i1];
      const p2 = i2 !== undefined ? out[i2] : null;
      if (!p1) continue;
      if (!p2) {
        // Orphan entry in a non-MANUAL round (odd player count in a round).
        if (!p1._matchSid) {
          p1._matchSid = `MANUAL|${round}|${p1.entryId || p1.player}`;
        }
        continue;
      }
      const key = `${p1.entryId || p1.player}||${p2.entryId || p2.player}`;
      const idx = soloPairCount[key] || 0;
      soloPairCount[key] = idx + 1;
      const sid = soloSid(round, p1, p2, idx);
      if (!p1._matchSid) p1._matchSid = sid;
      if (!p2._matchSid) p2._matchSid = sid;
    }
  }

  return out;
}

function groupBySid(entries) {
  const groups = new Map();
  const order = [];
  const unkeyed = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') { unkeyed.push(e); continue; }
    const sid = e._matchSid;
    if (!sid) { unkeyed.push(e); continue; }
    if (!groups.has(sid)) {
      groups.set(sid, []);
      order.push(sid);
    }
    groups.get(sid).push(e);
  }
  return { groups, order, unkeyed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge with PERSISTENT TOMBSTONES.
//
// Tombstones live inside the beyResults array as identity-only records:
//     { _matchSid, _tombstone: true, _deletedAt: <ms since epoch> }
// They survive across PUTs (stored in KV / DO), and any incoming entry whose
// sid matches an active tombstone is dropped. This is what prevents a stale
// client — one that still believes a deleted match exists — from resurrecting
// it on its next PUT. Tombstones expire after TOMBSTONE_TTL_MS so admins can
// genuinely re-create the "same" match later.
// ─────────────────────────────────────────────────────────────────────────────
export function mergeBeyResults(existing, incoming, deletedSidsArr, opts = {}) {
  const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
  const ttl = (opts && typeof opts.tombstoneTtlMs === 'number') ? opts.tombstoneTtlMs : TOMBSTONE_TTL_MS;

  const existingWithSids = computeSidsForEntries(existing || []);
  const incomingWithSids = computeSidsForEntries(incoming || []);

  // Split existing into data vs tombstones, GC tombstones past TTL.
  const existingTombs = [];
  const existingData = [];
  for (const e of existingWithSids) {
    if (isTombstone(e)) {
      const at = (e._deletedAt && Number.isFinite(e._deletedAt)) ? e._deletedAt : now;
      if ((now - at) < ttl && e._matchSid) {
        existingTombs.push({ _matchSid: e._matchSid, _tombstone: true, _deletedAt: at });
      }
      // else: expired, drop silently.
    } else {
      existingData.push(e);
    }
  }

  // Active tombstone set = surviving existing + new deletions from this PUT.
  const tombAt = new Map();
  for (const t of existingTombs) tombAt.set(t._matchSid, t._deletedAt);
  if (Array.isArray(deletedSidsArr)) {
    for (const sid of deletedSidsArr) {
      if (typeof sid === 'string' && sid.length) {
        // Newest deletion timestamp wins — refreshes the TTL window.
        tombAt.set(sid, now);
      }
    }
  }

  // Drop any incoming data entries the tombstone set forbids.
  const incomingData = incomingWithSids.filter(e => !isTombstone(e) && !tombAt.has(e._matchSid));

  const ex = groupBySid(existingData);
  const inc = groupBySid(incomingData);

  const merged = [];
  const seen = new Set();

  for (const sid of ex.order) {
    if (tombAt.has(sid)) { seen.add(sid); continue; }
    if (inc.groups.has(sid)) {
      merged.push(...inc.groups.get(sid));
    } else {
      merged.push(...ex.groups.get(sid));
    }
    seen.add(sid);
  }

  for (const sid of inc.order) {
    if (seen.has(sid)) continue;
    if (tombAt.has(sid)) continue;
    merged.push(...inc.groups.get(sid));
  }

  if (ex.unkeyed.length) merged.push(...ex.unkeyed);

  // Append tombstone records LAST so they persist into the next PUT cycle.
  // Stored sorted by sid for deterministic ordering / test stability.
  const tombs = Array.from(tombAt.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sid, at]) => ({ _matchSid: sid, _tombstone: true, _deletedAt: at }));
  merged.push(...tombs);

  return merged;
}

export function mergeBuilds(existing, incoming) {
  const merged = { ...(existing || {}) };
  if (incoming && typeof incoming === 'object') {
    for (const [k, v] of Object.entries(incoming)) {
      merged[k] = v;
    }
  }
  return merged;
}

// Strip tombstones from a stored beyResults array before sending it to the
// client. The client only deals with real match entries; tombstones are an
// internal server-side concern.
export function stripTombstonesForResponse(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(e => !isTombstone(e));
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic-write strategy selection.
//
// • If env.BEY_STATE_DO is bound (Durable Object namespace), every PUT for a
//   given eventId is routed to that DO. A DO instance is single-threaded by
//   contract, which makes the read-merge-write sequence atomic per event —
//   the only Cloudflare-native way to get true serialization here.
//
// • If no DO binding is configured, we fall back to KV with the documented
//   limitation: under genuinely simultaneous PUTs from multiple judges, the
//   read-merge-write loop is racy and an update CAN be lost. The response
//   carries a X-BEY-CONCURRENCY: best-effort-kv header so callers and ops
//   tooling can detect this. See docs/CONCURRENCY.md for setup instructions
//   to enable the DO path.
// ─────────────────────────────────────────────────────────────────────────────
async function handleViaDurableObject(env, eventId, action, body) {
  const id = env.BEY_STATE_DO.idFromName(eventId);
  const stub = env.BEY_STATE_DO.get(id);
  const url = `https://bey-state-do/event/${encodeURIComponent(eventId)}/${action}`;
  const init = {
    method: action === 'get' ? 'GET' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: action === 'get' ? undefined : JSON.stringify(body || {})
  };
  return await stub.fetch(url, init);
}

async function readEventFromKV(kv, eventId) {
  const raw = await kv.get(EVENTS_KEY);
  const data = raw ? JSON.parse(raw) : { events: [] };
  const events = Array.isArray(data.events) ? data.events : [];
  const idx = events.findIndex(e => e.id === eventId);
  return { data, events, idx };
}

async function putEventStateToKV(kv, eventId, mergedBeyResults, mergedBuilds, purgedOwners = null) {
  const { data, events, idx } = await readEventFromKV(kv, eventId);
  if (idx === -1) {
    const err = new Error('Event not found.');
    err.status = 404;
    throw err;
  }
  // NOTE: this is the documented race window. Two concurrent KV PUTs can each
  // re-read the same baseline and clobber each other's tombstones on writeback.
  // The DO path eliminates this. See docs/CONCURRENCY.md.
  events[idx].beyResults = mergedBeyResults;
  events[idx].builds     = mergedBuilds;
  // Persist the purged-owners list so subsequent merge PUTs cannot re-add
  // builds for a player that has been permanently removed from this event.
  if (purgedOwners !== null) events[idx].purgedOwners = purgedOwners;
  data.events = events;
  await kv.put(EVENTS_KEY, JSON.stringify(data));
  return events[idx];
}

// ─────────────────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const kv = env.BEYBLADE_KV;
  if (!kv && !env.BEY_STATE_DO) {
    return new Response(
      JSON.stringify({ error: 'KV namespace not bound.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // ── GET ────────────────────────────────────────────────────────────────────
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const eventId = url.searchParams.get('eventId');
    try {
      // Try DO first for per-event GETs (it owns the live state).
      if (eventId && env.BEY_STATE_DO) {
        const doRes = await handleViaDurableObject(env, eventId, 'get', null);
        if (doRes.ok) {
          const state = await doRes.json();
          const cleaned = stripTombstonesForResponse(state.beyResults || []);
          const annotated = computeSidsForEntries(cleaned);
          return new Response(JSON.stringify({ beyResults: annotated, builds: state.builds || {} }), {
            status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-BEY-CONCURRENCY': 'durable-object' }
          });
        }
        if (doRes.status !== 404) {
          // DO is bound but failed for some reason — surface the error.
          const errText = await doRes.text();
          return new Response(errText, { status: doRes.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        // DO 404 (no state yet) → fall through to KV for legacy / first-time reads.
      }

      const raw = await kv.get(EVENTS_KEY);
      const data = raw ? JSON.parse(raw) : { events: [] };
      const events = data.events || [];
      if (eventId) {
        const ev = events.find(e => e.id === eventId);
        if (!ev) return new Response(JSON.stringify({ error: 'Event not found.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        const cleaned = stripTombstonesForResponse(ev.beyResults || []);
        const annotated = computeSidsForEntries(cleaned);
        return new Response(JSON.stringify({ beyResults: annotated, builds: ev.builds || {} }), {
          status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-BEY-CONCURRENCY': env.BEY_STATE_DO ? 'durable-object' : 'best-effort-kv' }
        });
      }
      const allResults = events.map(ev => ({
        eventId: ev.id,
        eventTitle: ev.title,
        season: ev.season || 'unknown',
        date: ev.date,
        beyResults: computeSidsForEntries(stripTombstonesForResponse(ev.beyResults || [])),
        builds: ev.builds || {}
      }));
      return new Response(JSON.stringify({ events: allResults }), {
        status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
  }

  // ── PUT ────────────────────────────────────────────────────────────────────
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const {
      adminUsername, adminPassword, eventId,
      builds, beyResults, mergeMode, deletedSids,
      purgePlayers,   // passed through to DO unchanged
      renamePlayer,   // passed through to DO unchanged
      __syncToKV,     // admin-only: read DO state and write directly to KV (pre-rollback export)
      __syncFromKV    // admin-only: merge current KV state INTO an already-hydrated DO (post-rollback reactivation)
    } = body;

    const validU  = env.ADMIN_USERNAME;
    const validP  = env.ADMIN_PASSWORD;
    const valid2U = env.ADMIN2_USERNAME;
    const valid2P = env.ADMIN2_PASSWORD;
    const isAdmin =
      (adminUsername === validU && adminPassword === validP) ||
      (valid2U && adminUsername === valid2U && adminPassword === valid2P);

    if (!isAdmin) {
      return new Response(JSON.stringify({ error: 'Unauthorized.' }), { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
    if (!eventId) {
      return new Response(JSON.stringify({ error: 'eventId required.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ── Sync-to-KV: export authoritative DO state → KV (admin-only) ───────────
    // This is the "export before rollback" operation documented in
    // docs/DO_DEPLOYMENT.md. It reads the current DO state and writes it
    // directly to KV while the DO binding is still active, so the admin can
    // remove the binding without losing data written through the DO.
    //
    // Note: normal PUT operations always route to DO when bound — this flag is
    // the ONLY way to write KV directly while BEY_STATE_DO is active.
    if (__syncToKV) {
      if (!kv) {
        return new Response(JSON.stringify({ error: 'KV namespace not bound.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      if (!env.BEY_STATE_DO) {
        return new Response(JSON.stringify({ error: '__syncToKV requires BEY_STATE_DO binding to be active.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      try {
        const doRes = await handleViaDurableObject(env, eventId, 'get', null);
        if (!doRes.ok) {
          if (doRes.status === 404) {
            return new Response(JSON.stringify({ error: 'DO has no state for this event (not yet hydrated). Nothing to sync.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
          }
          const errText = await doRes.text().catch(() => '');
          return new Response(errText || JSON.stringify({ error: 'DO read failed.' }), { status: doRes.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        const doState = await doRes.json();
        // Persist the RAW DO beyResults — including tombstones — to KV. Tombstones
        // are required stored state: they block stale clients from resurrecting
        // deleted matches via subsequent merge PUTs (post-rollback or otherwise).
        // Only the client-visible response strips tombstones.
        const rawResults     = Array.isArray(doState.beyResults) ? doState.beyResults : [];
        const visibleResults = stripTombstonesForResponse(rawResults);
        const updated = await putEventStateToKV(
          kv, eventId, rawResults, doState.builds || {}, doState.purgedOwners || []
        );
        return new Response(JSON.stringify({
          success: true,
          synced: { beyResults: visibleResults, builds: updated.builds || {} }
        }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: '__syncToKV failed: ' + e.message }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
    }

    // ── Sync-from-KV: import KV state into an already-hydrated DO ────────────
    // After a rollback period (DO binding removed, then later restored), the DO
    // still holds its pre-rollback state and ignores any KV writes that happened
    // in the meantime — it is already hydrated, so __hydrateFromLegacy no-ops.
    // This admin-only action sends the current KV event state to the DO's
    // /import endpoint, which merges (not replaces) it on top of the existing
    // DO state. Tombstones and purgedOwners on both sides are preserved /
    // union-merged. See docs/DO_DEPLOYMENT.md → "Re-activating the DO binding".
    if (__syncFromKV) {
      if (!kv) {
        return new Response(JSON.stringify({ error: 'KV namespace not bound.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      if (!env.BEY_STATE_DO) {
        return new Response(JSON.stringify({ error: '__syncFromKV requires BEY_STATE_DO binding to be active.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      try {
        const { events, idx } = await readEventFromKV(kv, eventId);
        if (idx === -1) {
          return new Response(JSON.stringify({ error: 'Event not found in KV.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        const ev = events[idx];
        const payload = {
          beyResults:   Array.isArray(ev.beyResults) ? ev.beyResults : [],
          builds:       (ev.builds && typeof ev.builds === 'object' && !Array.isArray(ev.builds)) ? ev.builds : {},
          purgedOwners: Array.isArray(ev.purgedOwners) ? ev.purgedOwners : []
        };
        const doRes = await handleViaDurableObject(env, eventId, 'import', payload);
        const text  = await doRes.text();
        if (!doRes.ok) {
          return new Response(text || JSON.stringify({ error: 'DO import failed.' }), { status: doRes.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        return new Response(text, { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: '__syncFromKV failed: ' + e.message }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
    }

    // DO path — atomic per-event serialization.
    if (env.BEY_STATE_DO) {
      try {
        // Read KV state so the DO can lazily migrate on its first write.
        // maybeHydrateFromLegacy is idempotent — it's a no-op after the DO has
        // already been hydrated, so this KV read is the only overhead added.
        let hydrateHint = null;
        if (kv) {
          try {
            const { events, idx } = await readEventFromKV(kv, eventId);
            if (idx !== -1) hydrateHint = {
              beyResults:   events[idx].beyResults   || [],
              builds:       events[idx].builds       || {},
              purgedOwners: Array.isArray(events[idx].purgedOwners) ? events[idx].purgedOwners : []
            };
          } catch (_) {/* non-fatal — DO will start empty if KV unreadable */}
        }

        const doRes = await handleViaDurableObject(env, eventId, 'put', {
          builds, beyResults, mergeMode, deletedSids,
          purgePlayers, renamePlayer,
          __hydrateFromLegacy: hydrateHint
        });
        const text = await doRes.text();
        if (!doRes.ok) {
          return new Response(text, { status: doRes.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        const parsed = JSON.parse(text);
        // Strip tombstones from the client-visible response.
        if (Array.isArray(parsed.beyResults)) {
          parsed.beyResults = stripTombstonesForResponse(parsed.beyResults);
        }
        return new Response(JSON.stringify(parsed), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-BEY-CONCURRENCY': 'durable-object' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'DO write failed: ' + e.message }), {
          status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
    }

    // KV fallback — DOCUMENTED LIMITATION: the read-merge-write below is NOT
    // atomic and CAN lose updates when two judges PUT simultaneously. The
    // X-BEY-CONCURRENCY response header announces this so monitoring can flag
    // it. See docs/CONCURRENCY.md for the DO upgrade path.
    try {
      const { events, idx } = await readEventFromKV(kv, eventId);
      if (idx === -1) {
        return new Response(JSON.stringify({ error: 'Event not found.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const ev = events[idx];

      // ── KV-path purgePlayers / renamePlayer (mirrors DO logic for consistency) ──
      let kvWorkingResults = Array.isArray(ev.beyResults) ? ev.beyResults : [];
      let kvWorkingBuilds  = (ev.builds && typeof ev.builds === 'object' && !Array.isArray(ev.builds)) ? ev.builds : {};
      // Persist the normalized list of build owners that have been purged from
      // this event. Any incoming builds key whose normalized form matches an
      // entry in this list is filtered out to prevent stale clients from
      // re-adding builds for deleted players via subsequent merge PUTs.
      let kvPurgedOwners = Array.isArray(ev.purgedOwners) ? [...ev.purgedOwners] : [];

      if (renamePlayer && renamePlayer.from && renamePlayer.to) {
        const { from, to } = renamePlayer;
        kvWorkingResults = kvWorkingResults.map(e => {
          if (e._tombstone || e.player !== from) return e;
          return { ...e, player: to, ...(e.displayLabel ? { displayLabel: e.entryType === 'double' ? to + ' (DE)' : to } : {}) };
        });
        if (Object.prototype.hasOwnProperty.call(kvWorkingBuilds, from)) {
          kvWorkingBuilds = { ...kvWorkingBuilds };
          kvWorkingBuilds[to] = kvWorkingBuilds[to] || kvWorkingBuilds[from];
          delete kvWorkingBuilds[from];
        }
      }

      let kvDeletedSids = Array.isArray(deletedSids) ? [...deletedSids] : [];
      if (Array.isArray(purgePlayers) && purgePlayers.length) {
        // Normalized (case-insensitive, all-whitespace-stripped) purge matching.
        const purgeSet = new Set(purgePlayers.map(normalizePlayerName));
        const withSids = computeSidsForEntries(kvWorkingResults);
        for (const e of withSids) {
          if (e._matchSid && !e._tombstone && purgeSet.has(normalizePlayerName(e.player))) {
            kvDeletedSids.push(e._matchSid);
          }
        }
        kvWorkingBuilds = { ...kvWorkingBuilds };
        for (const k of Object.keys(kvWorkingBuilds)) {
          if (purgeSet.has(normalizePlayerName(k))) delete kvWorkingBuilds[k];
        }
        // Extend the persistent purged-owners list so future merge PUTs cannot
        // re-add builds for these players.
        for (const norm of purgeSet) {
          if (norm && !kvPurgedOwners.includes(norm)) kvPurgedOwners.push(norm);
        }
      }

      let finalBeyResults;
      let finalBuilds;
      // Force merge when active tombstones or purgedOwners exist in stored state.
      // A legacy full-replace (mergeMode omitted) would otherwise bypass tombstone
      // and purge protection, resurrecting deleted players and matches.
      // This mirrors the DO's effectiveMergeMode = mergeMode === true || cur.hydrated.
      const kvHasProtectedState =
        kvPurgedOwners.length > 0 ||
        kvWorkingResults.some(e => e._tombstone === true);
      if (mergeMode === true || purgePlayers || renamePlayer || kvHasProtectedState) {
        // Always use merge path when any targeted operation is requested, or when
        // protection state (tombstones / purgedOwners) must be upheld.
        finalBeyResults = Array.isArray(beyResults)
          ? mergeBeyResults(kvWorkingResults, beyResults, kvDeletedSids)
          : mergeBeyResults(kvWorkingResults, [], kvDeletedSids);
        finalBuilds = (builds && typeof builds === 'object')
          ? mergeBuilds(kvWorkingBuilds, builds)
          : kvWorkingBuilds;
      } else {
        // Full replace — only safe when there are no tombstones or purged owners.
        finalBeyResults = (beyResults !== undefined) ? beyResults : kvWorkingResults;
        finalBuilds = (builds !== undefined) ? builds : kvWorkingBuilds;
      }

      // Strip purged owners from the final builds map so stale clients cannot
      // resurrect a deleted player's builds via subsequent merge PUTs.
      if (kvPurgedOwners.length) {
        const purgedSet = new Set(kvPurgedOwners);
        finalBuilds = { ...finalBuilds };
        for (const k of Object.keys(finalBuilds)) {
          if (purgedSet.has(normalizePlayerName(k))) delete finalBuilds[k];
        }
      }

      const updated = await putEventStateToKV(kv, eventId, finalBeyResults, finalBuilds, kvPurgedOwners);

      const cleaned = stripTombstonesForResponse(finalBeyResults);
      return new Response(JSON.stringify({
        success: true,
        event: { ...updated, beyResults: cleaned },
        beyResults: cleaned,
        builds: finalBuilds
      }), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          // Honest signal: this write was best-effort, not atomic.
          'X-BEY-CONCURRENCY': 'best-effort-kv',
          'X-BEY-CONCURRENCY-WARNING': 'Concurrent PUTs from multiple judges may lose updates. Enable the BEY_STATE_DO durable-object binding to make writes atomic. See docs/CONCURRENCY.md.'
        }
      });
    } catch (e) {
      const status = e.status || 502;
      return new Response(JSON.stringify({ error: e.message }), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}
