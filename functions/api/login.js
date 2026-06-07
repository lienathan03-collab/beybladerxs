import { checkRateLimit, clientIp } from './_shared/ratelimit.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Rate limit admin login attempts per IP (brute-force protection).
  const rl = await checkRateLimit(env, 'login:' + clientIp(request), 10, 5 * 60 * 1000);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: 'Too many login attempts. Please wait a few minutes and try again.' }),
      { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    body = {};
  }

  const { username, password } = body;

  if (!username || !password) {
    return new Response(
      JSON.stringify({ error: 'Username and password required' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const validUsername  = env.ADMIN_USERNAME;
  const validPassword  = env.ADMIN_PASSWORD;
  const valid2Username = env.ADMIN2_USERNAME;
  const valid2Password = env.ADMIN2_PASSWORD;

  const isValid =
    (username === validUsername && password === validPassword) ||
    (valid2Username && username === valid2Username && password === valid2Password);

  if (isValid) {
    return new Response(
      JSON.stringify({ success: true, user: username }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } else {
    return new Response(
      JSON.stringify({ error: 'Incorrect username or password.' }),
      { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}
