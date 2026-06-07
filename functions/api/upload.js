// Admin-authenticated image upload. Stores each image as its OWN KV entry
// (photo:<uuid>) instead of embedding a data URL inside the single gamedata blob
// — which kept that blob small and away from the 25 MB KV value cap that would
// otherwise eventually break every save. Returns a same-origin URL the client
// stores in place of the old data URL.
//
// Structured so the storage backend can later be swapped to R2 with minimal
// change (only put/get move; the URL shape /api/photo?id=<id> stays).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB per image
const PHOTO_PREFIX = 'photo:';

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

// Parse a base64 image data URL into { ct, bytes }. Returns null if not a valid
// image data URL.
export function dataUrlToBytes(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const ct = m[1].toLowerCase();
  let bin;
  try { bin = atob(m[2]); } catch (_) { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ct, bytes };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const kv = env.BEYBLADE_KV;
  if (!kv) return json({ error: 'KV namespace not bound.' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON body.' }, 400); }

  const { adminUsername, adminPassword, dataUrl } = body;
  const isAdmin =
    (adminUsername === env.ADMIN_USERNAME && adminPassword === env.ADMIN_PASSWORD) ||
    (env.ADMIN2_USERNAME && adminUsername === env.ADMIN2_USERNAME && adminPassword === env.ADMIN2_PASSWORD);
  if (!isAdmin) return json({ error: 'Unauthorized. Admin credentials required.' }, 401);

  const parsed = dataUrlToBytes(dataUrl);
  if (!parsed) return json({ error: 'Expected an image data URL (data:image/...;base64,...).' }, 400);
  if (parsed.bytes.length > MAX_BYTES) {
    return json({ error: `Image too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).` }, 413);
  }

  const id = crypto.randomUUID();
  try {
    await kv.put(PHOTO_PREFIX + id, parsed.bytes.buffer, { metadata: { ct: parsed.ct } });
  } catch (e) {
    return json({ error: 'Could not store image: ' + (e && e.message ? e.message : String(e)) }, 502);
  }

  return json({ success: true, id, url: '/api/photo?id=' + id }, 200);
}
