const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const API_KEY = env.JSONBIN_API_KEY;
  const BIN_ID  = env.JSONBIN_BIN_ID;

  if (!API_KEY || !BIN_ID) {
    return new Response(
      JSON.stringify({ error: 'JSONBIN_API_KEY or JSONBIN_BIN_ID not set in Cloudflare Environment Variables.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

  // GET — load latest data
  if (request.method === 'GET') {
    try {
      const upstream = await fetch(`${JSONBIN_URL}/latest`, {
        headers: { 'X-Master-Key': API_KEY, 'X-Bin-Meta': 'false' },
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return new Response(
          JSON.stringify({ error: `JSONBin load failed: ${text.slice(0, 120)}` }),
          { status: upstream.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      return new Response(text, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
  }

  // PUT — save data
  if (request.method === 'PUT') {
    try {
      const body = await request.text();
      const upstream = await fetch(JSONBIN_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY },
        body,
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return new Response(
          JSON.stringify({ error: `JSONBin save failed: ${text.slice(0, 120)}` }),
          { status: upstream.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      return new Response(text, {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
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
