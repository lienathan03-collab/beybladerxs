const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EVENTS_KEY = 'events';

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
    if (action === 'join' || action === 'unjoin' || action === 'team_join') {
      const { username, passwordHash, eventId, displayName, teamName, members } = body;
      if (!username || !passwordHash || !eventId) {
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
        if (!Array.isArray(members) || members.length !== 3) {
          return new Response(
            JSON.stringify({ error: 'Exactly 3 members are required.' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      // Verify player credentials
      let accounts;
      try {
        const raw = await kv.get('accounts');
        accounts = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Could not verify account.' }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      const account = accounts[username];
      if (!account || account.password !== passwordHash) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized.' }),
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

      const playerName = displayName || account.displayName || username;

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
            members.some(m => !m || typeof m !== 'object' || !m.username || !m.displayName)) {
          return new Response(
            JSON.stringify({ error: 'Invalid members format. Each member must have username and displayName.' }),
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
                  JSON.stringify({ error: `${conflictMember.displayName} is already registered in team "${joiner.teamName}".` }),
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
          members:   members.map(m => ({ username: m.username, displayName: m.displayName })),
          joinedAt:  new Date().toISOString()
        });
      } else if (action === 'join') {
        // Prevent duplicate joins by same username
        const alreadyJoined = event.joiners.find(j => j.username === username);
        if (alreadyJoined) {
          return new Response(
            JSON.stringify({ error: 'Already joined.' }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        event.joiners.push({ username, name: playerName, joinedAt: new Date().toISOString() });
      } else {
        // unjoin — remove by username
        event.joiners = event.joiners.filter(j => j.username !== username);
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
      event.joiners.push({ username: null, name: name.trim(), joinedAt: new Date().toISOString(), manualAdd: true });
      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ── Admin: remove a joiner by index ──
    if (action === 'admin_remove') {
      const { adminUsername, adminPassword, eventId, joinerIdx } = body;
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
      if (joinerIdx < 0 || joinerIdx >= event.joiners.length) return new Response(JSON.stringify({ error: 'Invalid index.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      event.joiners.splice(joinerIdx, 1);
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
