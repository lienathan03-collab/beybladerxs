const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EVENTS_KEY = 'events';
const TEAM_NAME_MAX = 30;
const TEAM_NAME_RE = /^[a-zA-Z0-9 ._\-]+$/;

// Inspects only event.builds and event.beyResults on the given event object.
// Does not read any other KV key. Name fallback is for legacy entries with no entryId.
function hasLiveData(event, entryId, name) {
  const builds = event.builds || {};
  const results = event.beyResults || [];
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
        if (hasLiveData(event, deJoiner.entryId || null, deJoiner.name)) {
          return new Response(JSON.stringify({ error: 'Builds are registered. Contact the admin.' }), { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        }
        event.joiners = event.joiners.filter(j => j !== deJoiner);
      } else {
        // unjoin — cascade main + DE, block if live data exists on this event
        const userJoiners = event.joiners.filter(j => j.username === username);
        for (const j of userJoiners) {
          if (hasLiveData(event, j.entryId || null, j.name || username)) {
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
      // Live inspection — only checks this event's builds and beyResults
      const anyLive = toRemove.some(j => hasLiveData(event, j.entryId || null, j.name));
      if (anyLive && !force) {
        return new Response(
          JSON.stringify({ error: 'Builds or results exist for this entry. Send force: true to remove the roster entry only.' }),
          { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      // Remove roster entries only — builds and beyResults rows are never deleted
      const removeSet = new Set(toRemove);
      event.joiners = event.joiners.filter(j => !removeSet.has(j));
      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
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
      try {
        await kv.put(EVENTS_KEY, JSON.stringify({ events }));
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
