// ─────────────────────────────────────────────────────────────────────────────
// Shared merge logic for BeyStateDO and the /api/beyresults Pages Function.
//
// This module is the single source of truth for:
//   • computeSidsForEntries — attaches stable _matchSid to legacy entries
//   • mergeBeyResults       — union merge with persistent tombstone support
//   • mergeBuilds           — per-player build merging
//   • stripTombstonesForResponse — hides internal tombstone records from clients
//
// Keep this file in sync with functions/api/beyresults.js when modifying
// the merge algorithm. (A future refactor could have beyresults.js import
// from here, but Cloudflare Pages Functions require co-located files.)
// ─────────────────────────────────────────────────────────────────────────────

// Tombstone TTL — after this much elapsed real-time a deletion is forgotten
// and the same _matchSid may be created again. 24h is enough to outlive any
// realistic stale-client window during a tournament day while still letting an
// admin re-create the "same" match the next day.
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Identity helpers — mirror eventmanager.html's _soloSid / _teamSid exactly.
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

    // MANUAL-round entries are standalone singletons — every player record
    // is its own discrete result (admin-entered points, no opponent).
    // Extract them BEFORE the pairing loop so that two MANUAL entries in
    // the same event are NOT accidentally paired into a shared SID.
    // Non-MANUAL solo entries (regular round play) are paired as before.
    const soloForPairing = [];
    for (const i of soloIndices) {
      const e = out[i];
      if (round === 'MANUAL') {
        // Each MANUAL entry gets an individual stable SID.
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
// sid matches an active tombstone is dropped. This prevents a stale
// client — one that still believes a deleted match exists — from resurrecting
// it on its next PUT. Tombstones expire after TOMBSTONE_TTL_MS.
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
