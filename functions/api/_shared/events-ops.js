// ─────────────────────────────────────────────────────────────────────────────
// events-ops.js — pure, I/O-free mutations of the `events` blob.
//
// Every mutating action in functions/api/events.js boils down to a
// read-modify-write of the single `{ events: [...] }` KV blob. Because KV has
// no atomic compare-and-swap, two concurrent writers can each read the same
// baseline and clobber each other (lost joins / wiped rosters). To make these
// writes safe they must be SERIALIZED through one Durable Object instance.
//
// This module is the single mutation implementation used by BOTH:
//   • the registry Durable Object (serialized, authoritative path), and
//   • the events.js KV fallback (when the DO is not yet bound/deployed).
//
// It contains NO auth and NO network/KV I/O. The caller (events.js) is
// responsible for:
//   • admin / session authentication,
//   • format validation that does not depend on current blob state,
//   • live-result guards (unjoin / de_remove / admin_remove) that need the
//     match Durable Object — those are pre-checked before the removal op runs.
//
// Blob-state-DEPENDENT validation (already-joined, duplicate team name,
// member-in-another-team, DE-already-exists, index ranges, …) lives HERE so it
// is evaluated against fresh state inside the serialized actor.
//
// IMPORTANT: a byte-identical copy exists at
//   workers/bey-state-do/src/events-ops.js
// The two are exercised by the same fixtures in tests/events-ops.test.js. If you
// change one, change the other (they live in separate deploy units, mirroring
// the existing merge.js split). See audit follow-up H-5.
// ─────────────────────────────────────────────────────────────────────────────

const TEAM_NAME_MAX = 30;
const TEAM_NAME_RE = /^[a-zA-Z0-9 ._\-]+$/;

function uuid() {
  // crypto.randomUUID is available both in Workers/DO and modern Node test runs.
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function nowIso() { return new Date().toISOString(); }

function err(status, message) { return { status, body: { error: message } }; }
function ok(event) { return { status: 200, body: { success: true, event } }; }

function findEvent(eventsData, eventId) {
  const events = Array.isArray(eventsData.events) ? eventsData.events : [];
  return events.find(ev => ev.id === eventId) || null;
}

/**
 * Apply a single mutating action to `eventsData` IN PLACE.
 * @returns {{ status:number, body:object }} — caller persists eventsData when status===200.
 *
 * @param {object} eventsData  parsed `{ events: [...] }`
 * @param {string} action      'join'|'team_join'|'team_add'|'de_add'|'de_remove'|
 *                             'unjoin'|'admin_add'|'admin_add_de'|'admin_remove'|
 *                             'challonge_update'|'replace_events'
 * @param {object} params      validated, blob-independent params from the request
 * @param {object} ctx         { accounts? } extra read-only context
 */
export function applyEventsAction(eventsData, action, params = {}, ctx = {}) {
  if (!eventsData || typeof eventsData !== 'object') eventsData = { events: [] };
  if (!Array.isArray(eventsData.events)) eventsData.events = [];

  // ── replace_events: full CRUD write with per-event live-field preservation ──
  // Honors add / remove / reorder / metadata edits from the incoming list, but
  // NEVER lets a (possibly stale) client snapshot overwrite server-owned
  // joiners / beyResults / builds / purgedOwners for an event that still exists.
  if (action === 'replace_events') {
    const incoming = Array.isArray(params.events) ? params.events : null;
    if (!incoming) return err(400, 'events must be an array.');
    const curById = new Map(eventsData.events.map(e => [e.id, e]));
    eventsData.events = incoming.map(inc => {
      const cur = inc && curById.get(inc.id);
      if (!cur) return inc; // brand-new event → take as-is
      const preserved = { ...inc };
      if (cur.joiners      !== undefined) preserved.joiners      = cur.joiners;
      if (cur.beyResults   !== undefined) preserved.beyResults   = cur.beyResults;
      if (cur.builds       !== undefined) preserved.builds       = cur.builds;
      if (cur.purgedOwners !== undefined) preserved.purgedOwners = cur.purgedOwners;
      return preserved;
    });
    return { status: 200, body: { success: true } };
  }

  // All remaining actions operate on a single event.
  const event = findEvent(eventsData, params.eventId);
  if (!event) return err(404, 'Event not found.');
  if (!Array.isArray(event.joiners)) event.joiners = [];

  if (action === 'join') {
    const { username, playerName } = params;
    if (event.joiners.find(j => j.username === username)) return err(409, 'Already joined.');
    event.joiners.push({
      entryId: uuid(), entryType: 'main', username,
      name: playerName, displayLabel: playerName, joinedAt: nowIso()
    });
    return ok(event);
  }

  if (action === 'team_join') {
    const { username, teamName, members } = params;
    const accounts = ctx.accounts || {};
    if (event.joiners.find(j => j.username === username)) return err(409, 'Already joined.');
    if (!Array.isArray(members) || members.length !== 3 ||
        members.some(m => !m || typeof m !== 'object' || !m.username)) {
      return err(400, 'Invalid members format. Each member must have a username.');
    }
    for (const m of members) {
      if (!accounts[m.username]) return err(400, `Player "@${m.username}" does not have an account.`);
    }
    const memberUsernames = members.map(m => m.username.toLowerCase());
    if (new Set(memberUsernames).size < 3) return err(409, 'All 3 members must be different players.');
    for (const joiner of event.joiners) {
      if (joiner.type === 'team' && Array.isArray(joiner.members)) {
        for (const existingMember of joiner.members) {
          const existingUsername = (typeof existingMember === 'object'
            ? existingMember.username : existingMember).toLowerCase();
          const conflict = memberUsernames.find(u => u === existingUsername);
          if (conflict) {
            const conflictMember = members.find(m => m.username.toLowerCase() === conflict);
            return err(409, `${accounts[conflictMember.username].displayName || conflictMember.username} is already registered in team "${joiner.teamName}".`);
          }
        }
      }
    }
    const trimmed = teamName.trim();
    const dupTeam = event.joiners.find(j =>
      j.type === 'team' && j.teamName && j.teamName.toLowerCase() === trimmed.toLowerCase());
    if (dupTeam) return err(409, `Team name "${trimmed}" is already taken.`);
    event.joiners.push({
      username, name: trimmed, type: 'team', teamName: trimmed,
      members: members.map(m => ({ username: m.username, displayName: accounts[m.username].displayName || m.username })),
      joinedAt: nowIso()
    });
    return ok(event);
  }

  // Admin walk-in team (display-name only members) — replaces the old EM
  // full-snapshot save path so a single team add can't clobber the blob.
  if (action === 'team_add') {
    const teamName = (params.teamName || '').trim();
    const members = Array.isArray(params.members) ? params.members : [];
    if (!teamName) return err(400, 'Team name is required.');
    if (teamName.length > TEAM_NAME_MAX) return err(400, `Team name too long (max ${TEAM_NAME_MAX} characters).`);
    if (!TEAM_NAME_RE.test(teamName)) return err(400, 'Team name: only letters, numbers, spaces, dots, dashes, underscores allowed.');
    const cleanMembers = members
      .map(m => (typeof m === 'string' ? { displayName: m.trim() } : { displayName: (m && m.displayName || '').trim() }))
      .filter(m => m.displayName);
    if (cleanMembers.length < 2) return err(400, 'Add at least 2 members.');
    const dupTeam = event.joiners.find(j =>
      j.type === 'team' && j.teamName && j.teamName.toLowerCase() === teamName.toLowerCase());
    if (dupTeam) return err(409, `Team name "${teamName}" is already taken.`);
    event.joiners.push({
      entryId: uuid(), name: teamName, type: 'team', teamName,
      members: cleanMembers, joinedAt: nowIso(), manualAdd: true
    });
    return ok(event);
  }

  if (action === 'de_add') {
    const { username, canonicalName } = params;
    if (event.type === '3v3') return err(400, 'DE not available for team events.');
    const mainJoiner = event.joiners.find(j =>
      j.username === username && (j.entryType === 'main' || !j.entryType) && j.type !== 'team');
    if (!mainJoiner) return err(404, 'Join the event first before adding a Double Entry.');
    if (event.joiners.find(j => j.username === username && j.entryType === 'double')) {
      return err(409, 'Double Entry already exists.');
    }
    if (!mainJoiner.entryId) {
      mainJoiner.entryId = uuid();
      mainJoiner.entryType = 'main';
      mainJoiner.displayLabel = mainJoiner.name;
    }
    event.joiners.push({
      entryId: uuid(), entryType: 'double', sourceEntryId: mainJoiner.entryId,
      username, name: canonicalName, displayLabel: canonicalName + ' (DE)',
      joinedAt: nowIso(), manualAdd: false
    });
    return ok(event);
  }

  if (action === 'de_remove') {
    // live-data guard already enforced by caller
    const { username } = params;
    const deJoiner = event.joiners.find(j => j.username === username && j.entryType === 'double');
    if (!deJoiner) return err(404, 'No Double Entry found.');
    event.joiners = event.joiners.filter(j => j !== deJoiner);
    return ok(event);
  }

  if (action === 'unjoin') {
    // live-data guard already enforced by caller
    const { username } = params;
    const userJoiners = event.joiners.filter(j => j.username === username);
    const removeIds = new Set(userJoiners.map(j => j.entryId).filter(Boolean));
    event.joiners = event.joiners.filter(j => {
      if (j.entryId && removeIds.has(j.entryId)) return false;
      if (!j.entryId && j.username === username) return false;
      return true;
    });
    return ok(event);
  }

  if (action === 'admin_add') {
    const name = (params.name || '').trim();
    if (!name) return err(400, 'eventId and name required.');
    event.joiners.push({
      entryId: uuid(), entryType: 'main', username: null,
      name, displayLabel: name, joinedAt: nowIso(), manualAdd: true
    });
    return ok(event);
  }

  if (action === 'admin_add_de') {
    if (event.type === '3v3') return err(400, 'DE not available for team events.');
    const idx = Number(params.joinerIdx);
    if (isNaN(idx) || idx < 0 || idx >= event.joiners.length) return err(400, 'joinerIdx out of range.');
    const target = event.joiners[idx];
    if (target.entryType === 'double') return err(400, 'Cannot add DE to a DE entry.');
    if (target.type === 'team') return err(400, 'Cannot add DE to a team entry.');
    if (params.sourceEntryId && target.entryId && target.entryId !== params.sourceEntryId) {
      return err(400, 'Index/ID mismatch.');
    }
    if (target.entryId && event.joiners.find(j => j.sourceEntryId === target.entryId)) {
      return err(409, 'DE already exists for this entry.');
    }
    if (target.username && event.joiners.find(j => j.username === target.username && j.entryType === 'double')) {
      return err(409, 'DE already exists for this player.');
    }
    const canonicalName = (target.name || target.displayName || '').trim();
    if (!canonicalName) return err(400, 'Cannot determine player name for this entry.');
    if (!target.entryId) target.entryId = uuid();
    target.name = canonicalName;
    target.displayLabel = canonicalName;
    target.entryType = 'main';
    event.joiners.push({
      entryId: uuid(), entryType: 'double', sourceEntryId: target.entryId,
      username: target.username || null, name: canonicalName,
      displayLabel: canonicalName + ' (DE)', joinedAt: nowIso(),
      manualAdd: target.manualAdd || false
    });
    return ok(event);
  }

  if (action === 'admin_remove') {
    // live-data guard / force decision already enforced by caller
    const numIdx = Number(params.joinerIdx);
    if (isNaN(numIdx) || numIdx < 0 || numIdx >= event.joiners.length) return err(400, 'Invalid index.');
    const target = event.joiners[numIdx];
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
    const removeSet = new Set(toRemove);
    event.joiners = event.joiners.filter(j => !removeSet.has(j));
    return ok(event);
  }

  if (action === 'challonge_update') {
    const challongeMetadata = params.challongeMetadata;
    if (!challongeMetadata || typeof challongeMetadata !== 'object' || Array.isArray(challongeMetadata)) {
      return err(400, 'eventId and challongeMetadata object required.');
    }
    const allowed = [
      'challongeTournamentId', 'challongeAccount', 'challongeCustomKey',
      'challongeParticipantMap', 'challongeGroupMap', 'challongeMissing',
    ];
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(challongeMetadata, key)) continue;
      const value = challongeMetadata[key];
      if (value === null) delete event[key];
      else event[key] = value;
    }
    return ok(event);
  }

  return err(400, 'Unknown action.');
}
