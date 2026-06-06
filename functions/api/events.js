import { fetchLiveEventResults } from './_shared/do-client.js';
import { applyEventsAction } from './_shared/events-ops.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EVENTS_KEY = 'events';
const TEAM_NAME_MAX = 30;
const TEAM_NAME_RE = /^[a-zA-Z0-9 ._\-]+$/;

// Single serialized registry instance — every events-blob mutation funnels here
// so concurrent writers cannot clobber each other (see _shared/events-ops.js).
const REGISTRY_ID = '__events_registry__';

// Attempt to commit a mutation through the registry Durable Object.
// Returns { status, body } on a real DO response, or null to signal the caller
// should fall back to the direct-KV path. null is returned when:
//   • BEY_STATE_DO is not bound, or
//   • the DO is reachable but lacks the registry route (old worker → 404/405), or
//   • the fetch threw (DO unreachable).
// This makes deploying the Pages change BEFORE the DO worker safe: until the new
// DO worker is live, every write transparently uses today's KV code path.
async function commitViaRegistry(env, op, params, ctx = {}) {
  if (!env.BEY_STATE_DO) return null;
  let res;
  try {
    const id = env.BEY_STATE_DO.idFromName(REGISTRY_ID);
    const stub = env.BEY_STATE_DO.get(id);
    res = await stub.fetch('https://bey-state-do/registry/events/mutate', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params, ctx })
    });
  } catch (e) {
    return null; // DO unreachable → KV fallback (today's behavior)
  }
  if (res.status === 404 || res.status === 405) return null; // old worker w/o registry
  let body;
  try { body = await res.json(); } catch (e) { body = { error: 'Registry returned non-JSON response.' }; }
  return { status: res.status, body };
}

function corsJson(body, status) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

// Inspects beyResults and builds from a live-state snapshot.
// When BEY_STATE_DO is bound the caller must pass DO-fetched results;
// otherwise it falls back to the KV event object's fields.
// Name fallback is for legacy entries with no entryId.
function hasLiveData({ beyResults, builds }, entryId, name) {
  const results = Array.isArray(beyResults) ? beyResults : [];
  // Check by entryId when present
  if (entryId) {
    if (builds[entryId] && builds[entryId].some(b => b && b.trim())) return true;
    if (results.some(r => r.entryId === entryId)) return true;
  }
  // Also check by canonical name — catches legacy/imported records without entryId
  // that share the same player name (conservative: block if ambiguous ownership)
  if (name) {
    if (builds[name] && builds[name].some(b => b && b.trim())) return true;
    if (results.some(r => r.player === name && !r.entryId)) return true;
  }
  return false;
}

// Returns { account, accounts } if token is valid, throws otherwise.
async function verifySession(kv, username, sessionToken) {
  const raw = await kv.get('accounts');
  const accounts = raw ? JSON.parse(raw) : {};
  const account = accounts[username];
  if (!account) throw new Error('Account not found.');

  const sessionRaw = await kv.get('session:' + sessionToken);
  if (!sessionRaw) throw new Error('Invalid or expired session.');
  const session = JSON.parse(sessionRaw);
  if (session.username !== username) throw new Error('Invalid session.');

  // tokenVersion must be present and match exactly; sessions without it are pre-fix tokens.
  const accountVersion = account.tokenVersion || 0;
  if (session.tokenVersion === undefined || session.tokenVersion !== accountVersion) {
    throw new Error('Session expired. Please log in again.');
  }

  return { account, accounts };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const kv = env.BEYBLADE_KV;
  if (!kv) {
    return new Response(
      JSON.stringify({ error: 'KV namespace not bound.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // ── GET — return all events (public) ──
  if (request.method === 'GET') {
    try {
      const data = await kv.get(EVENTS_KEY);
      return new Response(data || '{"events":[]}', {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
  }

  // ── PUT — write events (admin full write OR player join/unjoin) ──
  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action'); // 'join' | 'unjoin' | 'admin_add' | 'admin_remove'

    // ── Player join / unjoin / team_join ──
    if (action === 'join' || action === 'unjoin' || action === 'team_join' || action === 'de_add' || action === 'de_remove') {
      const { username, sessionToken, eventId, displayName, teamName, members } = body;
      if (!username || !sessionToken || !eventId) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Basic team_join early validation
      if (action === 'team_join') {
        if (!teamName || !teamName.trim()) {
          return new Response(
            JSON.stringify({ error: 'Team name is required.' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        const trimmedTeamName = teamName.trim();
        if (trimmedTeamName.length > TEAM_NAME_MAX) {
          return new Response(
            JSON.stringify({ error: `Team name too long (max ${TEAM_NAME_MAX} characters).` }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        if (!TEAM_NAME_RE.test(trimmedTeamName)) {
          return new Response(
            JSON.stringify({ error: 'Team name: only letters, numbers, spaces, dots, dashes, underscores allowed.' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        if (!Array.isArray(members) || members.length !== 3) {
          return new Response(
            JSON.stringify({ error: 'Exactly 3 members are required.' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      // Verify player session token
      let account, accounts;
      try {
        ({ account, accounts } = await verifySession(kv, username, sessionToken));
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Load events
      let eventsData;
      try {
        const raw = await kv.get(EVENTS_KEY);
        eventsData = raw ? JSON.parse(raw) : { events: [] };
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Could not load events.' }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const event = (eventsData.events || []).find(ev => ev.id === eventId);
      if (!event) {
        return new Response(
          JSON.stringify({ error: 'Event not found.' }),
          { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      if (!Array.isArray(event.joiners)) event.joiners = [];

      const playerName = account.displayName || username;

      if (action === 'team_join') {
        // Prevent duplicate joins by same username (team captain already registered)
        const alreadyJoined = event.joiners.find(j => j.username === username);
        if (alreadyJoined) {
          return new Response(
            JSON.stringify({ error: 'Already joined.' }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // members is now an array of {username, displayName} objects
        // Validate structure
        if (!Array.isArray(members) || members.length !== 3 ||
            members.some(m => !m || typeof m !== 'object' || !m.username)) {
          return new Response(
            JSON.stringify({ error: 'Invalid members format. Each member must have a username.' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Verify all member usernames exist in accounts
        for (const m of members) {
          if (!accounts[m.username]) {
            return new Response(
              JSON.stringify({ error: `Player "@${m.username}" does not have an account.` }),
              { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }
        }

        // Prevent duplicate member usernames within the team
        const memberUsernames = members.map(m => m.username.toLowerCase());
        if (new Set(memberUsernames).size < 3) {
          return new Response(
            JSON.stringify({ error: 'All 3 members must be different players.' }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Prevent any member username from appearing in an already-registered team
        for (const joiner of event.joiners) {
          if (joiner.type === 'team' && Array.isArray(joiner.members)) {
            for (const existingMember of joiner.members) {
              const existingUsername = (typeof existingMember === 'object'
                ? existingMember.username
                : existingMember // backwards compat with old string format
              ).toLowerCase();
              const conflict = memberUsernames.find(u => u === existingUsername);
              if (conflict) {
                const conflictMember = members.find(m => m.username.toLowerCase() === conflict);
                return new Response(
                  JSON.stringify({ error: `${accounts[conflictMember.username].displayName || conflictMember.username} is already registered in team "${joiner.teamName}".` }),
                  { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
                );
              }
            }
          }
        }

        // Prevent duplicate team name (case-insensitive)
        const dupTeam = event.joiners.find(j =>
          j.type === 'team' && j.teamName && j.teamName.toLowerCase() === teamName.trim().toLowerCase()
        );
        if (dupTeam) {
          return new Response(
            JSON.stringify({ error: `Team name "${teamName.trim()}" is already taken.` }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Save the full team object — members stored as [{username, displayName}]
        event.joiners.push({
          username,
          name:      teamName.trim(),
          type:      'team',
          teamName:  teamName.trim(),
          members:   members.map(m => ({ username: m.username, displayName: accounts[m.username].displayName || m.username })),
          joinedAt:  new Date().toISOString()
        });
      } else if (action === 'join') {
        const alreadyJoined = event.joiners.find(j => j.username === username);
        if (alreadyJoined) {
          return new Response(
            JSON.stringify({ error: 'Already joined.' }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        event.joiners.push({
          entryId:      crypto.randomUUID(),
          entryType:    'main',
          username,
          name:         playerName,
          displayLabel: playerName,
          joinedAt:     new Date().toISOString()
        });
      } else if (action === 'de_add') {
        if (event.type === '3v3') {
          return new Response(JSON.stringify({ error: 'DE not available for team events.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        const mainJoiner = event.joiners.find(j =>
          j.username === username && (j.entryType === 'main' || !j.entryType) && j.type !== 'team'
        );
        if (!mainJoiner) {
          return new Response(JSON.stringify({ error: 'Join the event first before adding a Double Entry.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        if (event.joiners.find(j => j.username === username && j.entryType === 'double')) {
          return new Response(JSON.stringify({ error: 'Double Entry already exists.' }), { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
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
      } else if (action === 'de_remove') {
        const deJoiner = event.joiners.find(j => j.username === username && j.entryType === 'double');
        if (!deJoiner) {
          return new Response(JSON.stringify({ error: 'No Double Entry found.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        // Fetch authoritative live state from DO (falls back to KV only on 404; throws on 5xx).
        let liveState;
        try {
          liveState = await fetchLiveEventResults(env, eventId, event);
        } catch (doErr) {
          console.error('[events de_remove] fetchLiveEventResults threw:', doErr);
          return new Response(JSON.stringify({ error: 'Could not verify live results. Please try again.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        if (hasLiveData(liveState, deJoiner.entryId || null, deJoiner.name)) {
          return new Response(JSON.stringify({ error: 'Builds are registered. Contact the admin.' }), { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        event.joiners = event.joiners.filter(j => j !== deJoiner);
      } else {
        // unjoin — cascade main + DE, block if live data exists on this event
        const userJoiners = event.joiners.filter(j => j.username === username);
        // Fetch authoritative live state once for all joiner checks (throws on DO 5xx).
        let liveState;
        try {
          liveState = await fetchLiveEventResults(env, eventId, event);
        } catch (doErr) {
          console.error('[events unjoin] fetchLiveEventResults threw:', doErr);
          return new Response(JSON.stringify({ error: 'Could not verify live results. Please try again.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        for (const j of userJoiners) {
          if (hasLiveData(liveState, j.entryId || null, j.name || username)) {
            return new Response(JSON.stringify({ error: 'Match preparation has started. Contact the admin to be removed.' }), { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
          }
        }
        const removeIds = new Set(userJoiners.map(j => j.entryId).filter(Boolean));
        event.joiners = event.joiners.filter(j => {
          if (j.entryId && removeIds.has(j.entryId)) return false;
          if (!j.entryId && j.username === username) return false;
          return true;
        });
      }

      // Serialize the mutation through the registry DO when available. Auth and
      // (for de_remove/unjoin) the live-result guard already ran above; the DO
      // re-applies the validated op against the freshest blob.
      {
        let regOp, regParams, regCtx = {};
        if (action === 'join') { regOp = 'join'; regParams = { eventId, username, playerName }; }
        else if (action === 'team_join') { regOp = 'team_join'; regParams = { eventId, username, teamName: teamName.trim(), members }; regCtx = { accounts }; }
        else if (action === 'de_add') { regOp = 'de_add'; regParams = { eventId, username, canonicalName: account.displayName || username }; }
        else if (action === 'de_remove') { regOp = 'de_remove'; regParams = { eventId, username }; }
        else { regOp = 'unjoin'; regParams = { eventId, username }; }
        const doRes = await commitViaRegistry(env, regOp, regParams, regCtx);
        if (doRes) return corsJson(doRes.body, doRes.status);
      }

      try {
        await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
        return new Response(JSON.stringify({ success: true, event }), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── Admin: manually add a name to joiners ──
    if (action === 'admin_add') {
      const { adminUsername, adminPassword, eventId, name } = body;
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
      if (!eventId || !name || !name.trim()) {
        return new Response(
          JSON.stringify({ error: 'eventId and name required.' }),
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
      const addDoRes = await commitViaRegistry(env, 'admin_add', { eventId, name });
      if (addDoRes) return corsJson(addDoRes.body, addDoRes.status);
      event.joiners.push({
        entryId:      crypto.randomUUID(),
        entryType:    'main',
        username:     null,
        name:         name.trim(),
        displayLabel: name.trim(),
        joinedAt:     new Date().toISOString(),
        manualAdd:    true
      });
      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ── Admin: add a walk-in team (display-name members) ──
    // Targeted action so a single team add no longer requires the client to
    // round-trip the whole events array (which could clobber concurrent edits).
    if (action === 'team_add') {
      const { adminUsername, adminPassword, eventId, teamName, members } = body;
      const validU  = env.ADMIN_USERNAME;
      const validP  = env.ADMIN_PASSWORD;
      const valid2U = env.ADMIN2_USERNAME;
      const valid2P = env.ADMIN2_PASSWORD;
      const isAdmin =
        (adminUsername === validU && adminPassword === validP) ||
        (valid2U && adminUsername === valid2U && adminPassword === valid2P);
      if (!isAdmin) return corsJson({ error: 'Unauthorized.' }, 401);
      if (!eventId) return corsJson({ error: 'eventId required.' }, 400);

      const params = { eventId, teamName, members };
      const teamDoRes = await commitViaRegistry(env, 'team_add', params);
      if (teamDoRes) return corsJson(teamDoRes.body, teamDoRes.status);

      // KV fallback — reuse the shared mutation so behavior matches the DO path.
      let eventsData;
      try {
        const raw = await kv.get(EVENTS_KEY);
        eventsData = raw ? JSON.parse(raw) : { events: [] };
      } catch (e) {
        return corsJson({ error: 'Could not load events.' }, 502);
      }
      const result = applyEventsAction(eventsData, 'team_add', params);
      if (result.status !== 200) return corsJson(result.body, result.status);
      try {
        await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      } catch (e) {
        return corsJson({ error: e.message }, 502);
      }
      return corsJson(result.body, 200);
    }

    // ── Admin: add DE slot for a main entry ──
    // joinerIdx is the primary locator for all entries (legacy and normalized).
    // sourceEntryId is optional cross-validation for already-normalized entries only.
    if (action === 'admin_add_de') {
      const { adminUsername, adminPassword, eventId, joinerIdx, sourceEntryId } = body;
      const validU  = env.ADMIN_USERNAME;
      const validP  = env.ADMIN_PASSWORD;
      const valid2U = env.ADMIN2_USERNAME;
      const valid2P = env.ADMIN2_PASSWORD;
      const isAdmin =
        (adminUsername === validU && adminPassword === validP) ||
        (valid2U && adminUsername === valid2U && adminPassword === valid2P);
      if (!isAdmin) return new Response(JSON.stringify({ error: 'Unauthorized.' }), { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      if (!eventId || joinerIdx === undefined || joinerIdx === null) {
        return new Response(JSON.stringify({ error: 'eventId and joinerIdx required.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
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
      if (event.type === '3v3') return new Response(JSON.stringify({ error: 'DE not available for team events.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      const idx = Number(joinerIdx);
      if (isNaN(idx) || idx < 0 || idx >= event.joiners.length) {
        return new Response(JSON.stringify({ error: 'joinerIdx out of range.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const target = event.joiners[idx];
      if (target.entryType === 'double') return new Response(JSON.stringify({ error: 'Cannot add DE to a DE entry.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      if (target.type === 'team') return new Response(JSON.stringify({ error: 'Cannot add DE to a team entry.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      if (sourceEntryId && target.entryId && target.entryId !== sourceEntryId) {
        return new Response(JSON.stringify({ error: 'Index/ID mismatch.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      if (target.entryId && event.joiners.find(j => j.sourceEntryId === target.entryId)) {
        return new Response(JSON.stringify({ error: 'DE already exists for this entry.' }), { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      if (target.username && event.joiners.find(j => j.username === target.username && j.entryType === 'double')) {
        return new Response(JSON.stringify({ error: 'DE already exists for this player.' }), { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      // Resolve canonical name — supports legacy { displayName, type:"solo" } walk-in entries
      const canonicalName = (target.name || target.displayName || '').trim();
      if (!canonicalName) {
        return new Response(JSON.stringify({ error: 'Cannot determine player name for this entry.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      // Lazy upgrade: normalize all identity fields atomically with the DE push
      if (!target.entryId) target.entryId = crypto.randomUUID();
      target.name        = canonicalName;
      target.displayLabel = canonicalName;
      target.entryType   = 'main';
      event.joiners.push({
        entryId:       crypto.randomUUID(),
        entryType:     'double',
        sourceEntryId: target.entryId,
        username:      target.username || null,
        name:          canonicalName,
        displayLabel:  canonicalName + ' (DE)',
        joinedAt:      new Date().toISOString(),
        manualAdd:     target.manualAdd || false
      });
      const addDeDoRes = await commitViaRegistry(env, 'admin_add_de', { eventId, joinerIdx, sourceEntryId });
      if (addDeDoRes) return corsJson(addDeDoRes.body, addDeDoRes.status);
      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ── Admin: remove a joiner by index (with cascade, live inspection, force override) ──
    if (action === 'admin_remove') {
      const { adminUsername, adminPassword, eventId, joinerIdx, force } = body;
      const validU  = env.ADMIN_USERNAME;
      const validP  = env.ADMIN_PASSWORD;
      const valid2U = env.ADMIN2_USERNAME;
      const valid2P = env.ADMIN2_PASSWORD;
      const isAdmin =
        (adminUsername === validU && adminPassword === validP) ||
        (valid2U && adminUsername === valid2U && adminPassword === valid2P);
      if (!isAdmin) return new Response(JSON.stringify({ error: 'Unauthorized.' }), { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
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
      const numIdx = Number(joinerIdx);
      if (isNaN(numIdx) || numIdx < 0 || numIdx >= event.joiners.length) {
        return new Response(JSON.stringify({ error: 'Invalid index.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const target = event.joiners[numIdx];
      // Collect target + linked DE entry
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
      // Live inspection — query DO for authoritative state (throws on DO 5xx).
      let adminLiveState;
      try {
        adminLiveState = await fetchLiveEventResults(env, eventId, event);
      } catch (doErr) {
        console.error('[events admin_remove] fetchLiveEventResults threw:', doErr);
        return new Response(JSON.stringify({ error: 'Could not verify live results. Please try again.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      const anyLive = toRemove.some(j => hasLiveData(adminLiveState, j.entryId || null, j.name));
      if (anyLive && !force) {
        return new Response(
          JSON.stringify({ error: 'Builds or results exist for this entry. Send force: true to remove the roster entry only.' }),
          { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      // Remove roster entries only — builds and beyResults rows are never deleted.
      // Live guard / force decision already enforced above; serialize the removal.
      const removeDoRes = await commitViaRegistry(env, 'admin_remove', { eventId, joinerIdx, force });
      if (removeDoRes) return corsJson(removeDoRes.body, removeDoRes.status);
      const removeSet = new Set(toRemove);
      event.joiners = event.joiners.filter(j => !removeSet.has(j));
      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ── Admin: targeted Challonge metadata update ──
    // This intentionally reads and patches the current KV event instead of
    // accepting a full client-side events snapshot. Challonge link changes must
    // never overwrite builds or beyResults with stale Event Manager data.
    if (action === 'challonge_update') {
      const { adminUsername, adminPassword, eventId, challongeMetadata } = body;
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
      if (!eventId || !challongeMetadata || typeof challongeMetadata !== 'object' || Array.isArray(challongeMetadata)) {
        return new Response(
          JSON.stringify({ error: 'eventId and challongeMetadata object required.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      let eventsData;
      try {
        const raw = await kv.get(EVENTS_KEY);
        eventsData = raw ? JSON.parse(raw) : { events: [] };
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Could not load events.' }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      const event = (eventsData.events || []).find(ev => ev.id === eventId);
      if (!event) {
        return new Response(
          JSON.stringify({ error: 'Event not found.' }),
          { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const allowed = [
        'challongeTournamentId',
        'challongeAccount',
        'challongeCustomKey',
        'challongeParticipantMap',
        'challongeGroupMap',
        'challongeMissing',
      ];
      for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(challongeMetadata, key)) continue;
        const value = challongeMetadata[key];
        if (value === null) delete event[key];
        else event[key] = value;
      }

      const challongeDoRes = await commitViaRegistry(env, 'challonge_update', { eventId, challongeMetadata });
      if (challongeDoRes) return corsJson(challongeDoRes.body, challongeDoRes.status);

      try {
        await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
        return new Response(JSON.stringify({ success: true, event }), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── Admin: full events write (create/update/delete events) ──
    {
      const { adminUsername, adminPassword, events } = body;
      const validU  = env.ADMIN_USERNAME;
      const validP  = env.ADMIN_PASSWORD;
      const valid2U = env.ADMIN2_USERNAME;
      const valid2P = env.ADMIN2_PASSWORD;
      const isAdmin =
        (adminUsername === validU && adminPassword === validP) ||
        (valid2U && adminUsername === valid2U && adminPassword === valid2P);
      if (!isAdmin) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized. Admin credentials required.' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      if (!Array.isArray(events)) {
        return new Response(
          JSON.stringify({ error: 'events must be an array.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Serialize through the registry DO when available.
      const replaceDoRes = await commitViaRegistry(env, 'replace_events', { events });
      if (replaceDoRes) return corsJson(replaceDoRes.body, replaceDoRes.status);

      // KV fallback — MERGE rather than wholesale replace, so a stale client
      // snapshot can no longer wipe joiners/beyResults/builds for events that
      // still exist (the catastrophic data-loss vector). Uses the same shared
      // mutation the DO path uses.
      try {
        let eventsData;
        const raw = await kv.get(EVENTS_KEY);
        eventsData = raw ? JSON.parse(raw) : { events: [] };
        const result = applyEventsAction(eventsData, 'replace_events', { events });
        if (result.status !== 200) return corsJson(result.body, result.status);
        await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }
  }

  return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
}
