const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ALLOWED_KEYS = ['gamedata', 'gamedata_s1', 'gamedata_s2', 'gamedata_s3'];

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
    try {
      const body = await request.text();
      // Validate it's real JSON before storing
      JSON.parse(body);
      await kv.put(key, body);
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
