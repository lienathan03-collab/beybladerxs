const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function callChallonge(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BeybladeRXS/1.0)',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.errors) detail = parsed.errors.join('; ');
      else if (parsed.error) detail = parsed.error;
    } catch (_) {}
    throw new Error(`Challonge ${res.status}: ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`Challonge returned non-JSON: ${text.slice(0, 120)}`);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const API_KEY = env.CHALLONGE_API_KEY;
  if (!API_KEY) {
    return new Response(
      JSON.stringify({ error: 'CHALLONGE_API_KEY is not set in Cloudflare Environment Variables.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const tournament_id = url.searchParams.get('tournament_id');
  const key = encodeURIComponent(API_KEY);
  try {
    if (action === 'list') {
      const data = await callChallonge(
        `https://api.challonge.com/v1/tournaments.json?api_key=${key}&state=all&per_page=50`
      );
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    if (action === 'participants' && tournament_id) {
      const tid = encodeURIComponent(tournament_id);
      const data = await callChallonge(
        `https://api.challonge.com/v1/tournaments/${tid}/participants.json?api_key=${key}`
      );
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    if (action === 'matches' && tournament_id) {
      const tid = encodeURIComponent(tournament_id);
      const data = await callChallonge(
        `https://api.challonge.com/v1/tournaments/${tid}/matches.json?api_key=${key}`
      );
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ error: 'Invalid action. Use: list, participants, matches' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || String(err) }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}
