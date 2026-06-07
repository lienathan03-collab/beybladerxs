// Public image serving for photos uploaded via /api/upload. Same-origin, so it
// satisfies the app's CSP (img-src 'self'). Immutable cache — ids are unique
// per upload, so a photo body never changes under a given id.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PHOTO_PREFIX = 'photo:';
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }

  const kv = env.BEYBLADE_KV;
  if (!kv) return new Response('KV not bound', { status: 500, headers: CORS_HEADERS });

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!ID_RE.test(id)) return new Response('Bad id', { status: 400, headers: CORS_HEADERS });

  let res;
  try {
    res = await kv.getWithMetadata(PHOTO_PREFIX + id, { type: 'arrayBuffer' });
  } catch (e) {
    return new Response('Error', { status: 502, headers: CORS_HEADERS });
  }
  if (!res || !res.value) return new Response('Not found', { status: 404, headers: CORS_HEADERS });

  const ct = (res.metadata && res.metadata.ct) || 'image/png';
  return new Response(res.value, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}
