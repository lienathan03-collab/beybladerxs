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
  const customKeyParam = url.searchParams.get('customKey') || undefined;
  const target = resolveChallongeTarget(env, {
    account:   url.searchParams.get('account')   || undefined,
    customKey: customKeyParam,
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
    const { scores_csv, winner_id, adminUsername, adminPassword } = body;

    // Writing a result back to Challonge uses the server's API key, so it MUST
    // require admin credentials. Without this gate any anonymous caller could
    // overwrite bracket results using the configured account's key.
    const isAdmin =
      (adminUsername === env.ADMIN_USERNAME && adminPassword === env.ADMIN_PASSWORD) ||
      (env.ADMIN2_USERNAME && adminUsername === env.ADMIN2_USERNAME && adminPassword === env.ADMIN2_PASSWORD);
    if (!isAdmin) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized. Admin credentials required.' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    if (!scores_csv) {
      return new Response(
        JSON.stringify({ error: 'scores_csv is required.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

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

  // Read actions (list/participants/matches): when an explicit API key was
  // supplied, talk to Challonge directly so the caller's own account is used.
  // A proxy may be bound to a different account, which would hide the caller's
  // own tournaments. Without an explicit key, fall back to the proxy.
  const CHALLONGE_API = 'https://api.challonge.com/v1';
  const useDirect = !!customKeyParam && !!target.key;

  if (!useDirect && !PROXY_URL) {
    return new Response(
      JSON.stringify({ error: 'No Challonge proxy resolved (account/season not configured).' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const keyQS = useDirect ? `api_key=${encodeURIComponent(target.key)}` : '';
    let readUrl = '';

    if (action === 'list') {
      readUrl = useDirect
        ? `${CHALLONGE_API}/tournaments.json?state=all&per_page=50&${keyQS}`
        : `${PROXY_URL}/challonge/tournaments.json?state=all&per_page=50`;
    } else if (action === 'participants' && tournament_id) {
      readUrl = useDirect
        ? `${CHALLONGE_API}/tournaments/${encodeURIComponent(tournament_id)}/participants.json?${keyQS}`
        : `${PROXY_URL}/challonge/tournaments/${encodeURIComponent(tournament_id)}/participants.json`;
    } else if (action === 'matches' && tournament_id) {
      readUrl = useDirect
        ? `${CHALLONGE_API}/tournaments/${encodeURIComponent(tournament_id)}/matches.json?${keyQS}`
        : `${PROXY_URL}/challonge/tournaments/${encodeURIComponent(tournament_id)}/matches.json`;
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid action.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const res = await fetch(readUrl);
    const text = await res.text();

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `${useDirect ? 'Challonge' : 'Proxy'} error ${res.status}: ${text.slice(0, 120)}` }),
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
