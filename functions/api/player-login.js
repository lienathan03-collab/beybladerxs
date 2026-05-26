const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TTL_30_DAYS = 30 * 24 * 60 * 60;

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const kv = env.BEYBLADE_KV;
  if (!kv) {
    return new Response(
      JSON.stringify({ error: 'KV namespace not bound.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // ── ?action=verify — validate a session token ──
  if (action === 'verify') {
    const { username, sessionToken } = body;
    if (!username || !sessionToken) {
      return new Response(
        JSON.stringify({ error: 'username and sessionToken required.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    let accounts;
    try {
      const raw = await kv.get('accounts');
      accounts = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Could not verify session.' }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const account = accounts[username];
    if (!account) {
      return new Response(
        JSON.stringify({ error: 'Account not found.' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    let session;
    try {
      const raw = await kv.get('session:' + sessionToken);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Could not verify session.' }),
        { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    if (!session || session.username !== username) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired session.' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // tokenVersion: sessions without a version field are always rejected (pre-fix tokens)
    const accountVersion = account.tokenVersion || 0;
    if (session.tokenVersion === undefined || session.tokenVersion !== accountVersion) {
      return new Response(
        JSON.stringify({ error: 'Session expired. Please log in again.' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const { password: _ignored, ...safeAccount } = account;
    return new Response(
      JSON.stringify({ success: true, account: safeAccount }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // ── Default: login with password hash ──
  const { username, passwordHash } = body;
  if (!username || !passwordHash) {
    return new Response(
      JSON.stringify({ error: 'Username and passwordHash required.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  let accounts;
  try {
    const raw = await kv.get('accounts');
    accounts = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Could not verify account.' }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const account = accounts[username];
  if (!account || account.password !== passwordHash) {
    return new Response(
      JSON.stringify({ error: 'Incorrect username or password.' }),
      { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Issue a session token embedding the current tokenVersion
  const tokenVersion = account.tokenVersion || 0;
  const sessionToken = crypto.randomUUID();
  try {
    await kv.put(
      'session:' + sessionToken,
      JSON.stringify({ username, issuedAt: Date.now(), tokenVersion }),
      { expirationTtl: TTL_30_DAYS }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Could not create session.' }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const { password: _ignored, ...safeAccount } = account;
  return new Response(
    JSON.stringify({ success: true, sessionToken, account: safeAccount }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
}
