import { doRenamePlayerInEvent } from './_shared/do-client.js';
import { verifyPassword, hashPassword } from './_shared/password.js';

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
    // Require authentication to prevent anonymous account enumeration.
    // Accept EITHER admin credentials OR a valid player session, via headers
    // (kept out of the URL/query so they don't land in access logs).
    const adminU = request.headers.get('X-Admin-User');
    const adminP = request.headers.get('X-Admin-Pass');
    const isAdmin =
      (adminU === env.ADMIN_USERNAME && adminP === env.ADMIN_PASSWORD) ||
      (env.ADMIN2_USERNAME && adminU === env.ADMIN2_USERNAME && adminP === env.ADMIN2_PASSWORD);
    let authed = isAdmin;
    if (!authed) {
      const pu = request.headers.get('X-Player-User');
      const ps = request.headers.get('X-Player-Session');
      if (pu && ps) {
        try { await verifySession(kv, pu, ps); authed = true; } catch (_) { authed = false; }
      }
    }
    if (!authed) {
      return new Response(
        JSON.stringify({ error: 'Authentication required.' }),
        { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
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

      if (!(await verifyPassword(account.password, currentPasswordHash))) {
        return new Response(
          JSON.stringify({ error: 'Current password is incorrect.' }),
          { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const newTokenVersion = (account.tokenVersion || 0) + 1;
      accounts[selfUsername] = { ...account, password: await hashPassword(newPasswordHash), tokenVersion: newTokenVersion };

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
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Could not read season 2 data.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      try {
        s3Raw = await kv.get('gamedata_s3');
        s3 = s3Raw ? JSON.parse(s3Raw) : null;
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Could not read season 3 data.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }

      let evRaw = null, evData = null;
      try {
        evRaw = await kv.get('events');
        evData = evRaw ? JSON.parse(evRaw) : null;
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Could not read active events.' }), { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }

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

      const SNAP_FIELDS = ['wins','losses','matchesPlayed','matchPoints','spinFinishes','overFinishes','extremeFinishes','burstFinishes'];
      function applyRename(data) {
        if (!data || !data.players) return { updated: null, changed: false };
        let changed = false;
        const out = JSON.parse(JSON.stringify(data));

        // 1. players[] name
        for (const p of out.players) {
          if (p.name === oldDisplayName) { p.name = newDisplayName; changed = true; }
        }

        // 2. bladerStats key rename/merge
        if (out.bladerStats && out.bladerStats[oldDisplayName] !== undefined) {
          if (out.bladerStats[newDisplayName]) {
            for (const f of SNAP_FIELDS) {
              out.bladerStats[newDisplayName][f] = (out.bladerStats[newDisplayName][f] || 0) + (out.bladerStats[oldDisplayName][f] || 0);
            }
            if (!out.bladerStats[newDisplayName].photo) out.bladerStats[newDisplayName].photo = out.bladerStats[oldDisplayName].photo || '';
          } else {
            out.bladerStats[newDisplayName] = out.bladerStats[oldDisplayName];
          }
          delete out.bladerStats[oldDisplayName];
          changed = true;
        }

        // 3. archivedBeyResults: result players, displayLabels, builds keys
        for (const archived of (out.archivedBeyResults || [])) {
          for (const r of (archived.beyResults || [])) {
            if (r.player === oldDisplayName) {
              r.player = newDisplayName;
              if (r.displayLabel) r.displayLabel = r.entryType === 'double' ? newDisplayName + ' (DE)' : newDisplayName;
              changed = true;
            }
          }
          if (archived.builds && archived.builds[oldDisplayName] !== undefined) {
            if (archived.builds[newDisplayName]) {
              const a = archived.builds[newDisplayName];
              const b = archived.builds[oldDisplayName];
              for (let i = 0; i < Math.max(a.length, b.length); i++) {
                const va = a[i] || ''; const vb = b[i] || '';
                a[i] = va.length >= vb.length ? va : vb;
              }
            } else {
              archived.builds[newDisplayName] = archived.builds[oldDisplayName];
            }
            delete archived.builds[oldDisplayName];
            changed = true;
          }
        }

        // 4. eventSnapshots: rename/merge per-event contribution keys
        for (const snap of Object.values(out.eventSnapshots || {})) {
          if (snap && snap[oldDisplayName] !== undefined) {
            if (snap[newDisplayName]) {
              for (const f of SNAP_FIELDS) {
                snap[newDisplayName][f] = (snap[newDisplayName][f] || 0) + (snap[oldDisplayName][f] || 0);
              }
            } else {
              snap[newDisplayName] = snap[oldDisplayName];
            }
            delete snap[oldDisplayName];
            changed = true;
          }
        }

        return { updated: out, changed };
      }

      const { updated: s2Updated, changed: s2Changed } = applyRename(s2);
      const { updated: s3Updated, changed: s3Changed } = applyRename(s3);

      // Prepare updated events in memory: joiner labels, live beyResults, legacy build keys.
      let evUpdated = null, evChanged = false;
      if (evData) {
        evUpdated = JSON.parse(JSON.stringify(evData));
        for (const ev of (evUpdated.events || [])) {
          const hasSoloJoiner = (ev.joiners || []).some(
            j => j.username === selfUsername && j.type !== 'team'
          );
          if (!hasSoloJoiner) continue;

          const affectedEntryIds = new Set();
          for (const j of (ev.joiners || [])) {
            if (j.username === selfUsername && j.type !== 'team') {
              if (j.entryId) affectedEntryIds.add(j.entryId);
              j.name = newDisplayName;
              j.displayLabel = j.entryType === 'double'
                ? newDisplayName + ' (DE)'
                : newDisplayName;
              evChanged = true;
            }
          }
          for (const r of (ev.beyResults || [])) {
            if (r.entryId && affectedEntryIds.has(r.entryId)) {
              r.player = newDisplayName; evChanged = true;
            } else if (!r.entryId && r.player === oldDisplayName) {
              r.player = newDisplayName; evChanged = true;
            }
          }
          const builds = ev.builds;
          if (builds && Object.prototype.hasOwnProperty.call(builds, oldDisplayName)) {
            builds[newDisplayName] = builds[oldDisplayName];
            delete builds[oldDisplayName];
            evChanged = true;
          }
        }
      }

      // Rollback snapshot (re-stringify after verifySession parsed it)
      const accountsRollback = JSON.stringify(accounts);

      // Attempt a rollback write and capture the failure if any. We collect
      // every failure across the rollback batch so the response can list each
      // key that needs manual repair instead of pretending "all changes rolled
      // back" when one of the restoration writes actually failed.
      async function safeKvPut(key, value, label) {
        try { await kv.put(key, value); return null; }
        catch (e) {
          const message = e && e.message ? e.message : String(e);
          console.error('[accounts player_rename] rollback write failed for', key, message);
          return { key, label, message };
        }
      }
      function rollbackFailureResponse(originalError, rollbackFailures, partialMessage) {
        return new Response(
          JSON.stringify({
            error: partialMessage,
            repairRequired: true,
            rollbackFailures,
            originalError
          }),
          { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

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
          const failures = [];
          const f1 = await safeKvPut(KEY, accountsRollback, 'accounts');
          if (f1) failures.push(f1);
          if (failures.length) {
            return rollbackFailureResponse(
              'Rename failed writing season 2 data: ' + (e.message || String(e)),
              failures,
              'Rename failed writing season 2 data, and rollback of earlier writes also failed. Repair required.'
            );
          }
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
          const failures = [];
          const f1 = await safeKvPut(KEY, accountsRollback, 'accounts');
          if (f1) failures.push(f1);
          if (s2Changed && s2Raw) {
            const f2 = await safeKvPut('gamedata_s2', s2Raw, 'gamedata_s2');
            if (f2) failures.push(f2);
          }
          if (failures.length) {
            return rollbackFailureResponse(
              'Rename failed writing season 3 data: ' + (e.message || String(e)),
              failures,
              'Rename failed writing season 3 data, and rollback of earlier writes also failed. Repair required.'
            );
          }
          return new Response(
            JSON.stringify({ error: 'Rename failed writing season 3 data. Changes have been rolled back.' }),
            { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }
      }

      if (evChanged && evUpdated) {
        try {
          await kv.put('events', JSON.stringify(evUpdated));
        } catch (e) {
          const failures = [];
          const f1 = await safeKvPut(KEY, accountsRollback, 'accounts');
          if (f1) failures.push(f1);
          if (s2Changed && s2Raw) {
            const f2 = await safeKvPut('gamedata_s2', s2Raw, 'gamedata_s2');
            if (f2) failures.push(f2);
          }
          if (s3Changed && s3Raw) {
            const f3 = await safeKvPut('gamedata_s3', s3Raw, 'gamedata_s3');
            if (f3) failures.push(f3);
          }
          if (failures.length) {
            return rollbackFailureResponse(
              'Rename failed updating active events: ' + (e.message || String(e)),
              failures,
              'Rename failed updating active events, and rollback of earlier writes also failed. Repair required.'
            );
          }
          return new Response(
            JSON.stringify({ error: 'Rename failed updating active events. All changes have been rolled back.' }),
            { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Propagate the rename into any DO instances that hold live beyResults.
        //
        // DO renames are applied SEQUENTIALLY (not concurrently) so we can
        // track exactly which events succeeded before a failure and send
        // compensating renames to reverse them. With concurrent Promise.all an
        // e1 success + e2 failure would leave e1 DO renamed while KV rolls back
        // to the old name — an unrecoverable inconsistency.
        //
        // Failure path:
        //   1. Send compensating rename (newName→oldName) to every event that
        //      already succeeded — best-effort, logged if it also fails.
        //   2. Roll back all KV writes.
        //   3. Return 503 so the client knows the rename was not committed.
        if (env.BEY_STATE_DO) {
          const affectedEventIds = new Set();
          for (const ev of (evData.events || [])) {
            if ((ev.joiners || []).some(j => j.username === selfUsername && j.type !== 'team')) {
              affectedEventIds.add(ev.id);
            }
          }
          const successfulRenames = []; // eids whose forward rename returned 2xx — known committed
          let doRenameError = null;
          let ambiguousEid   = null;     // eid whose outcome is UNKNOWN — caller threw mid-call
          for (const eid of affectedEventIds) {
            const evSnapshot = evUpdated
              ? (evUpdated.events || []).find(e => e.id === eid)
              : null;
            const hint = evSnapshot
              ? {
                  beyResults:   evSnapshot.beyResults   || [],
                  builds:       evSnapshot.builds       || {},
                  purgedOwners: Array.isArray(evSnapshot.purgedOwners)
                    ? evSnapshot.purgedOwners : []
                }
              : null;
            try {
              await doRenamePlayerInEvent(env, eid, oldDisplayName, newDisplayName, hint);
              successfulRenames.push(eid);
            } catch (e) {
              doRenameError = e;
              // do-client tags the error with `outcome`:
              //   • 'not-applied' — the DO returned a non-2xx response, so the
              //     merge did NOT commit (the DO awaits saveState before 2xx).
              //     Safe to skip compensation for this event.
              //   • 'unknown' (or absent) — fetch itself threw, so the rename
              //     MAY have committed before the response was lost. Treat the
              //     event as potentially modified and let compensation reach it.
              //     Skipping it here was the bug that left DOs at NewAlice
              //     while KV rolled back to Alice.
              if (e && e.outcome !== 'not-applied') {
                ambiguousEid = eid;
              }
              break; // stop renaming further events
            }
          }

          if (doRenameError) {
            // Compensate: send a reverse rename to every event that may hold
            // NewAlice — confirmed-committed events PLUS the in-flight failed
            // event whose outcome is unknown. If compensation succeeds for the
            // ambiguous event the DO is restored to Alice regardless of whether
            // the forward rename actually committed (it's a no-op when the
            // forward never landed).
            //
            // We MUST inspect each compensation result — if any reverse-rename
            // also fails, KV will roll back to the old name while those DOs may
            // still hold the new name. That divergence is a real data
            // inconsistency, NOT a clean rollback, and the response must say so.
            console.error('[accounts player_rename] DO rename failed; compensating and rolling back:', doRenameError);
            const eidsToCompensate = [...successfulRenames];
            if (ambiguousEid && !eidsToCompensate.includes(ambiguousEid)) {
              eidsToCompensate.push(ambiguousEid);
            }
            const failedCompensations = []; // eids whose reverse-rename also failed
            if (eidsToCompensate.length) {
              // Build a per-event PRE-RENAME hydration hint from the original KV
              // snapshot (`evData`, before any in-memory rename was applied).
              //
              // Why this matters specifically for `ambiguousEid` against a fresh
              // (never-hydrated) DO: if the forward rename never reached the DO,
              // a compensation call with `null` would land as the DO's first
              // PUT and `maybeHydrateFromLegacy(null)` would mark it hydrated
              // with empty beyResults/builds — wiping the event's live data
              // from every subsequent GET while KV happily holds Alice/Bob.
              //
              // Providing the pre-rename hint is safe in both branches:
              //   • Forward never committed → fresh DO hydrates from the real
              //     old-name KV state; the NewAlice→Alice rename is a no-op
              //     because no entry holds NewAlice. DO ends matching KV.
              //   • Forward did commit → DO is already hydrated and the hint
              //     is ignored; the reverse rename runs normally.
              // For confirmed-successful eids the DO is definitely hydrated, so
              // passing the hint is a harmless no-op there too.
              const settled = await Promise.allSettled(
                eidsToCompensate.map(eid => {
                  const preRenameEvent = evData
                    ? (evData.events || []).find(e => e.id === eid)
                    : null;
                  const preRenameHint = preRenameEvent
                    ? {
                        beyResults:   preRenameEvent.beyResults   || [],
                        builds:       preRenameEvent.builds       || {},
                        purgedOwners: Array.isArray(preRenameEvent.purgedOwners)
                          ? preRenameEvent.purgedOwners : []
                      }
                    : null;
                  return doRenamePlayerInEvent(env, eid, newDisplayName, oldDisplayName, preRenameHint);
                })
              );
              settled.forEach((r, i) => {
                if (r.status === 'rejected') {
                  console.error(
                    '[accounts player_rename] compensating rename failed for event',
                    eidsToCompensate[i], r.reason
                  );
                  failedCompensations.push(eidsToCompensate[i]);
                }
              });
            }
            // Roll back KV writes regardless — KV must reflect the old name so
            // any future read returns a consistent baseline. Capture rollback
            // failures so the response can list each KV key that needs repair
            // rather than silently claiming "all changes rolled back".
            const rollbackFailures = [];
            const fAcc = await safeKvPut(KEY, accountsRollback, 'accounts');
            if (fAcc) rollbackFailures.push(fAcc);
            if (s2Changed && s2Raw) {
              const fS2 = await safeKvPut('gamedata_s2', s2Raw, 'gamedata_s2');
              if (fS2) rollbackFailures.push(fS2);
            }
            if (s3Changed && s3Raw) {
              const fS3 = await safeKvPut('gamedata_s3', s3Raw, 'gamedata_s3');
              if (fS3) rollbackFailures.push(fS3);
            }
            if (evChanged && evRaw) {
              const fEv = await safeKvPut('events', evRaw, 'events');
              if (fEv) rollbackFailures.push(fEv);
            }

            if (failedCompensations.length || rollbackFailures.length) {
              // Honest signal: rollback did NOT complete. Some event DOs still
              // hold the new name (failedCompensations) and/or some KV keys
              // could not be restored (rollbackFailures).
              return new Response(
                JSON.stringify({
                  error: 'Rename failed and rollback could not be completed. Repair required.',
                  repairRequired: true,
                  inconsistentEventIds: failedCompensations,
                  rollbackFailures,
                  oldDisplayName,
                  newDisplayName
                }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
              );
            }

            return new Response(
              JSON.stringify({ error: 'Rename could not be applied to all live-result stores. All changes have been rolled back. Please try again.' }),
              { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }
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

        if (acc.password) {
          // A password was explicitly provided (account create or admin reset).
          // The client sends sha256(password); stretch it with PBKDF2 before
          // storing, and bump tokenVersion to revoke all existing sessions.
          // (GET strips password, so the admin UI only sends it when deliberately
          // set — unchanged accounts take the else branch and are untouched.)
          merged[username] = {
            ...acc,
            password: await hashPassword(acc.password),
            tokenVersion: (existingAcc.tokenVersion || 0) + 1
          };
        } else {
          // No password provided — preserve the existing (already-hashed) password
          // and tokenVersion.
          merged[username] = {
            ...acc,
            password: existingAcc.password,
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
