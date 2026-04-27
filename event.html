const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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

  // ── GET — return beyResults for a specific event or all events ──
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const eventId = url.searchParams.get('eventId');
    try {
      const raw = await kv.get(EVENTS_KEY);
      const data = raw ? JSON.parse(raw) : { events: [] };
      const events = data.events || [];
      if (eventId) {
        const ev = events.find(e => e.id === eventId);
        if (!ev) return new Response(JSON.stringify({ error: 'Event not found.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ beyResults: ev.beyResults || [], builds: ev.builds || [] }), {
          status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
      // Return all bey results across all events (for rankings)
      const allResults = events.map(ev => ({
        eventId: ev.id,
        eventTitle: ev.title,
        season: ev.season || 'unknown',
        date: ev.date,
        beyResults: ev.beyResults || [],
        builds: ev.builds || []
      }));
      return new Response(JSON.stringify({ events: allResults }), {
        status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
  }

  // ── PUT — save bey builds + results for an event (admin only) ──
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON.' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const { adminUsername, adminPassword, eventId, builds, beyResults } = body;

    // Auth check
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

    let eventsData;
    try {
      const raw = await kv.get(EVENTS_KEY);
      eventsData = raw ? JSON.parse(raw) : { events: [] };
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Could not load events.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const evIdx = (eventsData.events || []).findIndex(e => e.id === eventId);
    if (evIdx === -1) {
      return new Response(JSON.stringify({ error: 'Event not found.' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // builds: { [player]: [buildName, buildName, ...] }
    // beyResults: [ { player, round, builds: [ { build, finishes:[], deployed } ], pointsTotal, win } ]
    if (builds !== undefined) eventsData.events[evIdx].builds = builds;
    if (beyResults !== undefined) eventsData.events[evIdx].beyResults = beyResults;

    try {
      await kv.put(EVENTS_KEY, JSON.stringify(eventsData));
      return new Response(JSON.stringify({ success: true, event: eventsData.events[evIdx] }), {
        status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}