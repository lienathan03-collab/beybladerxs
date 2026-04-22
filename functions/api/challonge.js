const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function callChallonge(url, apiKey) {
  // Use Basic Auth instead of API key in URL
  const credentials = btoa(`lienathan:${apiKey}`);
  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'User-Agent': 'curl/7.68.0',
      'Accept': 'application/json',
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
      JSON.stringify({ error: 'CHALLONGE_API_KEY is not set.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const tournament_id = url.searchParams.get('tournament_id');

  try {
    if (action === 'list') {
      const data = await callChallonge(
        `https://api.challonge.com/v1/tournaments.json?state=all&per_page=50`,
        API_KEY
      );
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    if (action === 'participants' && tournament_id) {
      const tid = encodeURIComponent(tournament_id);
      const data = await callChallonge(
        `https://api.challonge.com/v1/tournaments/${tid}/participants.json`,
        API_KEY
      );
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    if (action === 'matches' && tournament_id) {
      const tid = encodeURIComponent(tournament_id);
      const data = await callChallonge(
        `https://api.challonge.com/v1/tournaments/${tid}/matches.json`,
        API_KEY
      );
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ error: 'Invalid action.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || String(err) }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}
