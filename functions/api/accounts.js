const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const KEY = 'accounts';

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

  // ── GET — return accounts (SHA-256 hashed passwords only, safe to serve) ──
  if (request.method === 'GET') {
    try {
      const data = await kv.get(KEY);
      return new Response(data || '{}', {
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

  // ── PUT — write accounts ──
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

    const url = new URL(request.url);
    const isSelfSave = url.searchParams.get('self') === '1';

    if (isSelfSave) {
      // Player self-save: can only update aliases and displayName
      const { selfUsername, selfPasswordHash, accounts } = body;

      if (!selfUsername || !selfPasswordHash || !accounts) {
        return new Response(
          JSON.stringify({ error: 'Missing selfUsername, selfPasswordHash, or accounts.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      let currentAccounts;
      try {
        const raw = await kv.get(KEY);
        currentAccounts = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Could not read accounts: ' + e.message }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const existing = currentAccounts[selfUsername];
      if (!existing || existing.password !== selfPasswordHash) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized.' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const incomingEntry = accounts[selfUsername];
      if (!incomingEntry) {
        return new Response(
          JSON.stringify({ error: 'Account entry missing for ' + selfUsername }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Whitelist: only aliases and displayName changeable by player
      currentAccounts[selfUsername] = {
        ...existing,
        aliases:     Array.isArray(incomingEntry.aliases) ? incomingEntry.aliases : existing.aliases,
        displayName: typeof incomingEntry.displayName === 'string' ? incomingEntry.displayName : existing.displayName
      };

      try {
        await kv.put(KEY, JSON.stringify(currentAccounts));
        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── Admin full write ──
    const { adminUsername, adminPassword, accounts } = body;

    const validUsername  = env.ADMIN_USERNAME;
    const validPassword  = env.ADMIN_PASSWORD;
    const valid2Username = env.ADMIN2_USERNAME;
    const valid2Password = env.ADMIN2_PASSWORD;

    const isAdmin =
      (adminUsername === validUsername && adminPassword === validPassword) ||
      (valid2Username && adminUsername === valid2Username && adminPassword === valid2Password);

    if (!isAdmin) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized. Admin credentials required.' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    if (!accounts || typeof accounts !== 'object') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid accounts payload.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    try {
      await kv.put(KEY, JSON.stringify(accounts));
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
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
