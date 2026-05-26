const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ALLOWED_KEYS = ['gamedata', 'gamedata_s1', 'gamedata_s2', 'gamedata_s3', 'homedata'];

function getKey(url) {
  const k = new URL(url).searchParams.get('key') || 'gamedata';
  return ALLOWED_KEYS.includes(k) ? k : 'gamedata';
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

  const key = getKey(request.url);

  if (request.method === 'GET') {
    try {
      const data = await kv.get(key);
      if (!data) {
        return new Response('{}', {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
      return new Response(data, {
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

    const { adminUsername, adminPassword, payload } = body;
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

    if (payload === undefined || payload === null) {
      return new Response(
        JSON.stringify({ error: 'Missing payload field.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    try {
      await kv.put(key, JSON.stringify(payload));
      return new Response(JSON.stringify({ success: true, key }), {
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

  return new Response(
    JSON.stringify({ error: 'Method not allowed' }),
    { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
}
