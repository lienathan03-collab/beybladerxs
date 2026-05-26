const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const KEY = 'accounts';
const TTL_30_DAYS = 30 * 24 * 60 * 60;
const DISPLAY_NAME_RE = /^[a-zA-Z0-9 ._\-]+$/;

// Returns { account, accounts } if token is valid, throws otherwise.
async function verifySession(kv, username, sessionToken) {
  const raw = await kv.get(KEY);
  const accounts = raw ? JSON.parse(raw) : {};
  const account = accounts[username];
  if (!account) throw new Error('Account not found.');

  const sessionRaw = await kv.get('session:' + sessionToken);
  if (!sessionRaw) throw new Error('Invalid or expired session.');
  const session = JSON.parse(sessionRaw);
  if (session.username !== username) throw new Error('Invalid session.');

  // tokenVersion must be present and match the account's current version exactly.
  // Sessions issued before this system was introduced lack the field and are rejected.
  const accountVersion = account.tokenVersion || 0;
  if (session.tokenVersion === undefined || session.tokenVersion !== accountVersion) {
    throw new Error('Session expired. Please log in again.');
  }

  return { account, accounts };
}

// Validate a display name or alias value.
function validateName(name) {
  if (!name || typeof name !== 'string') return 'Name must be a non-empty string.';
  if (name.length > 30) return 'Name too long (max 30 characters).';
  if (!DISPLAY_NAME_RE.test(name)) return 'Only letters, numbers, spaces, dots, dashes, underscores allowed.';
  return null; // valid
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

  // ── GET — return accounts without password fields ──
  if (request.method === 'GET') {
    try {
      const data = await kv.get(KEY);
      const accounts = data ? JSON.parse(data) : {};
      const safe = {};
      for (const [username, account] of Object.entries(accounts)) {
        const { password: _pw, tokenVersion: _tv, ...rest } = account;
        safe[username] = rest;
      }
      return new Response(JSON.stringify(safe), {
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

  // ── PUT ──
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
    const action = url.searchParams.get('action');
    // ── Player change-password ──
    if (action === 'change_password') {
      const { selfUsername, sessionToken, currentPasswordHash, newPasswordHash } = body;
      if (!selfUsername || !sessionToken || !currentPasswordHash || !newPasswordHash) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
      if (currentPasswordHash === newPasswordHash) {
        return new Response(
          JSON.stringify({ error: 'New password must be different.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      let account, accounts;
      try {
        ({ account, accounts } = await verifySession(kv, selfUsername, sessionToken));
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      if (account.password !== currentPasswordHash) {
        return new Response(
          JSON.stringify({ error: 'Current password is incorrect.' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const newTokenVersion = (account.tokenVersion || 0) + 1;
      accounts[selfUsername] = { ...account, password: newPasswordHash, tokenVersion: newTokenVersion };

      try {
        await kv.put(KEY, JSON.stringify(accounts));
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // Invalidate old token; issue a new one with the new version
      try { await kv.delete('session:' + sessionToken); } catch (_) {}
      const newToken = crypto.randomUUID();
      const now = Date.now();
      try {
        await kv.put(
          'session:' + newToken,
          JSON.stringify({ username: selfUsername, issuedAt: now, tokenVersion: newTokenVersion }),
          { expirationTtl: TTL_30_DAYS }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Password updated but could not create new session.' }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, sessionToken: newToken }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // ── Player rename (atomic: accounts + gamedata seasons) ──
    if (action === 'player_rename') {
      const { selfUsername, sessionToken, newDisplayName } = body;
      if (!selfUsername || !sessionToken || !newDisplayName) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const nameErr = validateName(newDisplayName);
      if (nameErr) {
        return new Response(
          JSON.stringify({ error: nameErr }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      let account, accounts;
      try {
        ({ account, accounts } = await verifySession(kv, selfUsername, sessionToken));
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const oldDisplayName = account.displayName || selfUsername;
      const lowerNew = newDisplayName.toLowerCase();
      const lowerOld = oldDisplayName.toLowerCase();

      if (lowerNew === lowerOld) {
        return new Response(
          JSON.stringify({ error: 'That is already your name.' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      // ── Load season data before any conflict check ──
      let s2Raw = null, s3Raw = null, s2 = null, s3 = null;
      try {
        s2Raw = await kv.get('gamedata_s2');
        s2 = s2Raw ? JSON.parse(s2Raw) : null;
      } catch (_) { s2 = null; }
      try {
        s3Raw = await kv.get('gamedata_s3');
        s3 = s3Raw ? JSON.parse(s3Raw) : null;
      } catch (_) { s3 = null; }

      // ── Conflict: other accounts ──
      for (const [uname, acc] of Object.entries(accounts)) {
        if (uname === selfUsername) continue;
        if ((acc.displayName || '').toLowerCase() === lowerNew) {
          return new Response(
            JSON.stringify({ error: 'That name is already taken by another player.' }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
        if (Array.isArray(acc.aliases) && acc.aliases.some(a => a.toLowerCase() === lowerNew)) {
          return new Response(
            JSON.stringify({ error: 'That name conflicts with another player\'s alias.' }),
            { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      // ── Conflict: season data ──
      for (const [, data] of [['gamedata_s2', s2], ['gamedata_s3', s3]]) {
        if (!data) continue;
        for (const p of (data.players || [])) {
          if (p.name.toLowerCase() === lowerNew && p.name.toLowerCase() !== lowerOld) {
            return new Response(
              JSON.stringify({ error: 'That name is already used by a player in season data.' }),
              { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }
        }
        for (const statKey of Object.keys(data.bladerStats || {})) {
          if (statKey.toLowerCase() === lowerNew && statKey.toLowerCase() !== lowerOld) {
            return new Response(
              JSON.stringify({ error: 'That name conflicts with existing stats in season data.' }),
              { status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }
        }
      }

      // ── Prepare all changes in memory ──
      const updatedAliases = Array.isArray(account.aliases)
        ? account.aliases.map(a => a.toLowerCase() === lowerOld ? newDisplayName : a)
        : [newDisplayName];
      const updatedAccounts = {
        ...accounts,
        [selfUsername]: { ...account, displayName: newDisplayName, aliases: updatedAliases }
      };

      function applyRename(data) {
        if (!data || !data.players) return { updated: null, changed: false };
        let changed = false;
        const out = JSON.parse(JSON.stringify(data));
        for (const p of out.players) {
          if (p.name === oldDisplayName) { p.name = newDisplayName; changed = true; }
        }
        if (out.bladerStats && out.bladerStats[oldDisplayName] !== undefined) {
          out.bladerStats[newDisplayName] = out.bladerStats[oldDisplayName];
          delete out.bladerStats[oldDisplayName];
          changed = true;
        }
        return { updated: out, changed };
      }

      const { updated: s2Updated, changed: s2Changed } = applyRename(s2);
      const { updated: s3Updated, changed: s3Changed } = applyRename(s3);

      // Rollback snapshot (re-stringify after verifySession parsed it)
      const accountsRollback = JSON.stringify(accounts);

      // ── Staged writes with rollback ──
      try {
        await kv.put(KEY, JSON.stringify(updatedAccounts));
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'Could not update account: ' + e.message }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      if (s2Changed) {
        try {
          await kv.put('gamedata_s2', JSON.stringify(s2Updated));
        } catch (e) {
          try { await kv.put(KEY, accountsRollback); } catch (_) {}
          return new Response(
            JSON.stringify({ error: 'Rename failed writing season 2 data. Account change has been rolled back.' }),
            { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      if (s3Changed) {
        try {
          await kv.put('gamedata_s3', JSON.stringify(s3Updated));
        } catch (e) {
          try { await kv.put(KEY, accountsRollback); } catch (_) {}
          try { if (s2Changed && s2Raw) await kv.put('gamedata_s2', s2Raw); } catch (_) {}
          return new Response(
            JSON.stringify({ error: 'Rename failed writing season 3 data. Changes have been rolled back.' }),
            { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      const { password: _pw, tokenVersion: _tv, ...safeAccount } = updatedAccounts[selfUsername];
      return new Response(
        JSON.stringify({ success: true, account: safeAccount }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // ── Admin full write — password-preserving merge, session revocation on password change ──
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
      const existingRaw = await kv.get(KEY);
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      const merged = {};

      for (const [username, acc] of Object.entries(accounts)) {
        const existingAcc = existing[username] || {};

        if (acc.password && acc.password !== existingAcc.password) {
          // Password is new or changed — increment tokenVersion to revoke all existing sessions
          merged[username] = {
            ...acc,
            tokenVersion: (existingAcc.tokenVersion || 0) + 1
          };
        } else {
          // No password change — preserve existing password (if payload omits it) and tokenVersion
          merged[username] = {
            ...acc,
            password: acc.password || existingAcc.password,
            tokenVersion: existingAcc.tokenVersion || 0
          };
        }
      }

      await kv.put(KEY, JSON.stringify(merged));
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
