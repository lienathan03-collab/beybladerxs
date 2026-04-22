const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const PROXY_URL = env.CHALLONGE_PROXY_URL;
  if (!PROXY_URL) {
    return new Response(
      JSON.stringify({ error: 'CHALLONGE_PROXY_URL not set in Cloudflare Environment Variables.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const tournament_id = url.searchParams.get('tournament_id');

  try {
    let proxyPath = '';

    if (action === 'list') {
      proxyPath = `${PROXY_URL}/challonge/tournaments.json?state=all&per_page=50`;
    } else if (action === 'participants' && tournament_id) {
      proxyPath = `${PROXY_URL}/challonge/tournaments/${encodeURIComponent(tournament_id)}/participants.json`;
    } else if (action === 'matches' && tournament_id) {
      proxyPath = `${PROXY_URL}/challonge/tournaments/${encodeURIComponent(tournament_id)}/matches.json`;
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid action.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const res = await fetch(proxyPath);
    const text = await res.text();

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Proxy error ${res.status}: ${text.slice(0, 120)}` }),
        { status: res.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(text, {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || String(err) }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}
