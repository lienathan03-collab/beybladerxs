const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function resolveChallongeTarget(env, params) {
  const { account, customKey, season } = params || {};
  // (a) named account from JSON env map
  if (account && env.CHALLONGE_ACCOUNTS) {
    let map = {};
    try { map = JSON.parse(env.CHALLONGE_ACCOUNTS); } catch (e) { map = {}; }
    const acc = map[account];
    if (acc && acc.proxyUrl) {
      return { proxyUrl: acc.proxyUrl, key: customKey || acc.key || null };
    }
    // Unknown account key — return null so onRequest surfaces a 500 instead of
    // silently falling through to the season-URL path.
    return { proxyUrl: null, key: null };
  }
  // (c) season fallback (existing behaviour)
  const proxyUrl = season === '3'
    ? (env.CHALLONGE_PROXY_URL_S3 || env.CHALLONGE_PROXY_URL)
    : env.CHALLONGE_PROXY_URL;
  // (b) custom key with the default proxy
  return { proxyUrl: proxyUrl || null, key: customKey || null };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const target = resolveChallongeTarget(env, {
    account:   url.searchParams.get('account')   || undefined,
    customKey: url.searchParams.get('customKey') || undefined,
    season:    url.searchParams.get('season')    || '2',
  });
  const PROXY_URL = target.proxyUrl;

  const action = url.searchParams.get('action');
  const tournament_id = url.searchParams.get('tournament_id');

  // action=report: write match result directly to Challonge (no proxy needed)
  if (action === 'report' && (request.method === 'PUT' || request.method === 'POST')) {
    const match_id = url.searchParams.get('match_id');

    if (!tournament_id || !match_id) {
      return new Response(
        JSON.stringify({ error: 'tournament_id and match_id are required.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    if (!target.key) {
      return new Response(
        JSON.stringify({ error: 'No Challonge API key available for write-back.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    const { scores_csv, winner_id } = body;

    const challongeUrl =
      `https://api.challonge.com/v1/tournaments/${encodeURIComponent(tournament_id)}/matches/${encodeURIComponent(match_id)}.json` +
      `?api_key=${encodeURIComponent(target.key)}`;

    const formBody =
      `match[scores_csv]=${encodeURIComponent(scores_csv ?? '')}` +
      `&match[winner_id]=${encodeURIComponent(winner_id ?? '')}`;

    try {
      const res = await fetch(challongeUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody,
      });
      const text = await res.text();

      if (!res.ok) {
        return new Response(
          JSON.stringify({ error: `Challonge error ${res.status}: ${text.slice(0, 120)}` }),
          { status: res.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(text, {
        status: res.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || String(err) }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
  }

  // Proxy-based actions require a resolved proxy URL
  if (!PROXY_URL) {
    return new Response(
      JSON.stringify({ error: 'No Challonge proxy resolved (account/season not configured).' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

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
