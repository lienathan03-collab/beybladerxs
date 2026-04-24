// /functions/api/data.js
// Cloudflare Pages Function — KV-backed data API
// Supports ?key=gamedata_s2 / ?key=gamedata_s3 for multi-season storage.
// KV namespace binding name: BEYBLADE_KV (set in Pages dashboard or wrangler.toml)

const ALLOWED_KEYS = ['gamedata', 'gamedata_s2', 'gamedata_s3'];

function getKey(url) {
  const k = new URL(url).searchParams.get('key') || 'gamedata';
  // Only allow known keys — prevents arbitrary KV reads/writes
  return ALLOWED_KEYS.includes(k) ? k : 'gamedata';
}

export async function onRequestGet({ request, env }) {
  try {
    const key = getKey(request.url);
    const value = await env.BEYBLADE_KV.get(key);
    if (value === null) {
      // Return empty object so client doesn't error on first load of a new season
      return new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    return new Response(value, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export async function onRequestPut({ request, env }) {
  try {
    const key = getKey(request.url);
    const body = await request.text();
    // Validate it's real JSON before storing
    JSON.parse(body);
    await env.BEYBLADE_KV.put(key, body);
    return new Response(JSON.stringify({ ok: true, key }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
