// Integration tests for Durable Object live-state ownership.
//
// These tests run in Node.js with ESM (node --experimental-vm-modules or
// Node ≥ 22 with native ESM). They test the server-side logic directly by
// mocking Cloudflare primitives (KV, DO storage, Request/Response).
//
// Run: node --test tests/integration/do-integration.test.js
//
// Note: globalThis.Request and globalThis.Response must exist.
// Node ≥ 18 provides them via the built-in `fetch` implementation.

import assert from 'node:assert/strict';
import test   from 'node:test';

// ─── Cloudflare primitive mocks ──────────────────────────────────────────────

/** In-memory KV store compatible with Cloudflare Workers KV. */
function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); }
  };
}

/** In-memory DO storage compatible with state.storage in Durable Objects. */
function makeDOStorage() {
  const store = new Map();
  return {
    async get(key) { return store.get(key); },
    async put(key, value) { store.set(key, value); }
  };
}

/**
 * Instantiate a BeyStateDO with fresh in-memory storage.
 * Returns the instance directly so tests can call do.fetch().
 */
async function makeDO(initialStorage = {}) {
  const { BeyStateDO } = await import('../../workers/bey-state-do/src/index.js');
  const storage = makeDOStorage();
  for (const [k, v] of Object.entries(initialStorage)) {
    await storage.put(k, v);
  }
  return new BeyStateDO({ storage }, {});
}

/**
 * Build a mock env that wires a real BeyStateDO instance into the BEY_STATE_DO
 * binding shape that the Pages Functions expect.
 */
function makeDOBinding(doInstance) {
  return {
    idFromName(_name) { return { name: _name }; },
    get(_id) {
      return {
        // The stub's fetch receives the URL + init and delegates to the DO instance.
        fetch(url, init) {
          return doInstance.fetch(new Request(url, init));
        }
      };
    }
  };
}

function makeSerialDOBinding(doInstance) {
  let chain = Promise.resolve();
  return {
    idFromName(_name) { return { name: _name }; },
    get(_id) {
      return {
        fetch(url, init) {
          chain = chain.then(() => doInstance.fetch(new Request(url, init)));
          return chain;
        }
      };
    }
  };
}

/**
 * Helper: call the DO's PUT action directly without going through the Pages
 * function, to set up test fixture state.
 */
async function doPut(doInstance, eventId, body) {
  const url = `https://bey-state-do/event/${encodeURIComponent(eventId)}/put`;
  const res = await doInstance.fetch(new Request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));
  const data = await res.json();
  return { res, data };
}

/**
 * Helper: call the DO's GET action directly.
 */
async function doGet(doInstance, eventId) {
  const url = `https://bey-state-do/event/${encodeURIComponent(eventId)}/get`;
  const res = await doInstance.fetch(new Request(url, { method: 'GET' }));
  const data = res.ok ? await res.json() : null;
  return { res, data };
}

/** Build a mock context for Pages Function onRequest handlers. */
function makePagesCtx(env, method, url, body) {
  return {
    env,
    request: new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
  };
}

// ─── Test 1: first DO write migrates existing KV rows ────────────────────────

test('first DO write migrates existing KV rows into DO state', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  // KV has an existing event with two match entries.
  const existingKvEvent = {
    id: 'evt-1',
    title: 'Test Event',
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] }
  };
  const kv = makeKV({ events: JSON.stringify({ events: [existingKvEvent] }) });

  // Fresh DO — not yet hydrated.
  const doInst = await makeDO();

  const env = {
    BEYBLADE_KV:  kv,
    BEY_STATE_DO: makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Simulate Event Manager submitting a NEW match via merge PUT.
  const newEntry = { player: 'Carol', round: 'R1', _matchSid: 'R1|Carol|Dave|0', builds: [] };
  const ctx = makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-1',
    beyResults: [newEntry, { player: 'Dave', round: 'R1', _matchSid: 'R1|Carol|Dave|0', builds: [] }],
    mergeMode: true, deletedSids: []
  });
  const res = await onRequest(ctx);
  assert.equal(res.status, 200, 'PUT must succeed');

  const body = await res.json();
  assert.ok(Array.isArray(body.beyResults), 'response must include beyResults');

  // DO state should now contain BOTH the migrated KV entries AND the new entries.
  const { res: getRes, data: doState } = await doGet(doInst, 'evt-1');
  assert.equal(getRes.status, 200, 'DO must be hydrated after first PUT');

  const sids = new Set(doState.beyResults.map(e => e._matchSid).filter(Boolean));
  assert.ok(sids.has('R1|Alice|Bob|0'),  'migrated KV match must be present in DO');
  assert.ok(sids.has('R1|Carol|Dave|0'), 'new Event Manager match must be present in DO');
});

test('six Event Manager phones preserve 40 submitted matches per round across five rounds', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');
  const eventId = 'evt-six-phone-swiss';
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: eventId,
      title: 'Six Phone Swiss',
      joiners: [],
      beyResults: [],
      builds: {}
    }] })
  });
  const doInst = await makeDO();
  const env = {
    BEYBLADE_KV: kv,
    BEY_STATE_DO: makeSerialDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const phoneCount = 6;
  const rounds = ['R1', 'R2', 'R3', 'R4', 'R5'];
  const batches = Array.from({ length: phoneCount }, () => []);

  for (const round of rounds) {
    for (let i = 0; i < 40; i++) {
      const p1 = `${round}-P${String(i + 1).padStart(2, '0')}A`;
      const p2 = `${round}-P${String(i + 1).padStart(2, '0')}B`;
      const sid = `${round}|${p1}|${p2}|0`;
      batches[i % phoneCount].push(
        {
          player: p1, round, _matchSid: sid, _submitted: true, win: true,
          builds: [{ build: `${p1}-Blade`, finishes: ['S'] }]
        },
        {
          player: p2, round, _matchSid: sid, _submitted: true, win: false,
          builds: [{ build: `${p2}-Blade`, finishes: [] }]
        }
      );
    }
  }

  await Promise.all(batches.map(batch => {
    const ctx = makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
      adminUsername: 'admin', adminPassword: 'secret',
      eventId,
      beyResults: batch,
      builds: {},
      mergeMode: true,
      deletedSids: []
    });
    return onRequest(ctx).then(async res => {
      const text = await res.text();
      assert.equal(res.status, 200, 'phone write must succeed: ' + text);
      assert.equal(res.headers.get('X-BEY-CONCURRENCY'), 'durable-object');
    });
  }));

  const { data } = await doGet(doInst, eventId);
  const visibleRows = data.beyResults.filter(e => !e._tombstone);
  const sids = new Set(visibleRows.map(e => e._matchSid));

  assert.equal(visibleRows.length, 400, '200 matches must be stored as 400 player rows');
  assert.equal(sids.size, 200, 'all 200 match identities must survive');
  for (const round of rounds) {
    const roundSids = new Set(
      visibleRows.filter(e => e.round === round).map(e => e._matchSid)
    );
    assert.equal(roundSids.size, 40, `${round} must retain all 40 matches`);
  }
});

// ─── Test 2: MANUAL admin result survives a DO write ─────────────────────────

test('MANUAL admin result row survives a subsequent Event Manager DO write', async () => {
  // Set up: DO already hydrated with one MANUAL row.
  const doInst = await makeDO();
  await doPut(doInst, 'evt-2', {
    beyResults: [
      { player: 'Alice', round: 'MANUAL', builds: [{ build: 'Dragon', finishes: ['S', 'S'] }], pointsTotal: 4, win: false }
    ],
    builds: { Alice: ['Dragon'] },
    mergeMode: true
  });

  // Verify MANUAL row got a stable SID.
  const { data: after1 } = await doGet(doInst, 'evt-2');
  const manualEntry = after1.beyResults.find(e => e.player === 'Alice' && e.round === 'MANUAL');
  assert.ok(manualEntry, 'MANUAL row must be stored in DO');
  assert.ok(manualEntry._matchSid && manualEntry._matchSid.startsWith('MANUAL|'),
    'MANUAL row must have a stable MANUAL|... SID: ' + manualEntry._matchSid);

  // Now: Event Manager submits a regular match (different round, different players).
  await doPut(doInst, 'evt-2', {
    beyResults: [
      { player: 'Bob',  round: 'R1', _matchSid: 'R1|Bob|Carol|0', builds: [] },
      { player: 'Carol', round: 'R1', _matchSid: 'R1|Bob|Carol|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  });

  const { data: after2 } = await doGet(doInst, 'evt-2');
  const manualStillThere = after2.beyResults.find(e => e.player === 'Alice' && e.round === 'MANUAL');
  assert.ok(manualStillThere, 'MANUAL row must survive Event Manager merge write');
  const emMatch = after2.beyResults.filter(e => e._matchSid === 'R1|Bob|Carol|0');
  assert.equal(emMatch.length, 2, 'Event Manager match must also be present');
});

// ─── Test 3: deleting a player removes DO state ───────────────────────────────

test('purgePlayers tombstones target entries and blocks stale resurrection', async () => {
  const doInst = await makeDO();

  // Populate DO with Alice's match entries.
  await doPut(doInst, 'evt-3', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });

  // Admin deletes Alice via purgePlayers.
  await doPut(doInst, 'evt-3', {
    purgePlayers: ['Alice'],
    mergeMode: true,  // simulate Event Manager merge path
    deletedSids: []
  });

  const { data: afterDelete } = await doGet(doInst, 'evt-3');
  // Alice's entries must not be visible to clients.
  const visible = afterDelete.beyResults; // DO already strips tombstones on GET
  assert.ok(!visible.some(e => e.player === 'Alice'), 'Alice must be gone from visible results');
  // Alice's builds key must be removed.
  assert.ok(!Object.prototype.hasOwnProperty.call(afterDelete.builds, 'Alice'), 'Alice builds key must be removed');

  // Stale client tries to resurrect Alice.
  await doPut(doInst, 'evt-3', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  });

  const { data: afterStale } = await doGet(doInst, 'evt-3');
  assert.ok(!afterStale.beyResults.some(e => e.player === 'Alice'),
    'tombstone must block stale resurrection of Alice');
});

// ─── Test 4: /api/events live-data protection sees DO results ─────────────────

test('/api/events unjoin is blocked when player has results stored only in DO', async () => {
  const { onRequest: eventsOnRequest } = await import('../../functions/api/events.js');

  // KV: event exists with Bob as a joiner, but no beyResults in KV.
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-4',
      title: 'Test Event',
      joiners: [{ username: 'bob', entryId: 'eid-bob', entryType: 'main', name: 'Bob' }],
      beyResults: [],
      builds: {}
    }] }),
    accounts: JSON.stringify({ bob: {
      displayName: 'Bob', password: 'hash', tokenVersion: 1
    }}),
    'session:tok-bob': JSON.stringify({ username: 'bob', tokenVersion: 1 })
  });

  // DO has Bob's live match results (wrote by Event Manager).
  const doInst = await makeDO();
  await doPut(doInst, 'evt-4', {
    beyResults: [
      { player: 'Bob',  round: 'R1', _matchSid: 'R1|Bob|Carol|0', entryId: 'eid-bob', builds: [] },
      { player: 'Carol', round: 'R1', _matchSid: 'R1|Bob|Carol|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  });

  const env = {
    BEYBLADE_KV:  kv,
    BEY_STATE_DO: makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Bob tries to unjoin.
  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/events?action=unjoin',
    { username: 'bob', sessionToken: 'tok-bob', eventId: 'evt-4' }
  );
  const res = await eventsOnRequest(ctx);

  assert.equal(res.status, 403,
    'unjoin must be blocked because Bob has live results in DO');
  const body = await res.json();
  assert.ok(body.error, 'error message must be present');
});

// ─── Test 6: wrangler.toml uses [[durable_objects.bindings]] not [[services]] ──

test('wrangler.toml binding for BEY_STATE_DO uses [[durable_objects.bindings]]', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const tomlPath = resolve(__dir, '../../wrangler.toml');
  const toml = readFileSync(tomlPath, 'utf8');

  // Must have the durable_objects.bindings stanza.
  assert.ok(
    toml.includes('[[durable_objects.bindings]]'),
    'wrangler.toml must use [[durable_objects.bindings]] for BEY_STATE_DO'
  );
  assert.ok(
    toml.includes('name') && toml.includes('BEY_STATE_DO'),
    'wrangler.toml [[durable_objects.bindings]] must declare name = "BEY_STATE_DO"'
  );
  assert.ok(
    toml.includes('class_name') && toml.includes('BeyStateDO'),
    'wrangler.toml [[durable_objects.bindings]] must declare class_name = "BeyStateDO"'
  );
  assert.ok(
    toml.includes('script_name') && toml.includes('bey-state-do'),
    'wrangler.toml [[durable_objects.bindings]] must declare script_name = "bey-state-do"'
  );
  // Must NOT have a [[services]] binding for BEY_STATE_DO.
  // A [[services]] binding does not expose idFromName() / get(), which the code requires.
  const servicesIdx = toml.indexOf('[[services]]');
  if (servicesIdx !== -1) {
    const snippet = toml.slice(servicesIdx, servicesIdx + 200);
    assert.ok(
      !snippet.includes('BEY_STATE_DO'),
      'BEY_STATE_DO must not be under [[services]] — it must be under [[durable_objects.bindings]]'
    );
  }
});

// ─── Test 7: rename on fresh DO hydrates from KV, not from empty state ────────

test('rename on fresh DO hydrates from KV event, not from empty state', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // Fresh DO — never hydrated.
  const doInst = await makeDO();

  // KV has Alice's match results (DO does NOT — simulates the common case where
  // the Event Manager has not submitted yet for this event).
  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1,
      aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [{
      id: 'evt-7',
      title: 'Test Event',
      joiners: [{ username: 'alice', entryId: 'eid-alice', entryType: 'main', name: 'Alice', type: 'solo' }],
      beyResults: [
        { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
        { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
      ],
      builds: { Alice: ['Dragon'] }
    }] })
  });

  const env = {
    BEYBLADE_KV:  kv,
    BEY_STATE_DO: makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Alice renames herself. accounts.js must pass the post-rename KV snapshot as
  // hydrateHint so the fresh DO initialises from real data, not from an empty state.
  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);
  assert.equal(res.status, 200, 'rename must succeed: ' + (res.ok ? '' : await res.text()));

  // After rename, the DO must contain Bob's entry (from the KV hydration).
  // If doRenamePlayerInEvent hydratedFromLegacy with an empty hint, Bob's entry
  // would be missing — that's the regression this test guards against.
  const { res: getRes, data: doState } = await doGet(doInst, 'evt-7');
  assert.equal(getRes.status, 200, 'DO must be hydrated after rename');

  assert.ok(
    doState.beyResults.some(e => e.player === 'Bob'),
    'Bob\'s entry must survive — DO must have been hydrated from KV, not from empty state'
  );
  assert.ok(
    doState.beyResults.some(e => e.player === 'NewAlice'),
    'Alice\'s entry must be renamed to NewAlice in the DO'
  );
  assert.ok(
    !doState.beyResults.some(e => e.player === 'Alice'),
    'old name Alice must not remain in DO after rename'
  );
});

// ─── Test 8: fetchLiveEventResults throws on DO 5xx, events.js returns 502 ────

test('unjoin returns 502 when DO returns 5xx instead of using stale KV', async () => {
  const { onRequest: eventsOnRequest } = await import('../../functions/api/events.js');

  // KV: event exists, Bob is a joiner, KV shows no beyResults (stale).
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-8',
      title: 'Test Event',
      joiners: [{ username: 'bob', entryId: 'eid-bob', entryType: 'main', name: 'Bob' }],
      beyResults: [],
      builds: {}
    }] }),
    accounts: JSON.stringify({ bob: {
      displayName: 'Bob', password: 'hash', tokenVersion: 1
    }}),
    'session:tok-bob': JSON.stringify({ username: 'bob', tokenVersion: 1 })
  });

  // A broken DO binding that always returns 500.
  const brokenDOBinding = {
    idFromName(_name) { return { name: _name }; },
    get(_id) {
      return {
        fetch(_url, _init) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'internal' }), { status: 500 }));
        }
      };
    }
  };

  const env = {
    BEYBLADE_KV:  kv,
    BEY_STATE_DO: brokenDOBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Bob tries to unjoin. Even though KV has no beyResults, the DO is returning
  // 500 — we must refuse to proceed rather than fall through to stale KV.
  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/events?action=unjoin',
    { username: 'bob', sessionToken: 'tok-bob', eventId: 'evt-8' }
  );
  const res = await eventsOnRequest(ctx);

  assert.equal(res.status, 502,
    'unjoin must return 502 when DO returns 5xx — must not fall back to stale KV');
  const body = await res.json();
  assert.ok(body.error, 'error message must be present');
});

// ─── Test 9: purgePlayers matches case-insensitively ─────────────────────────

test('purgePlayers tombstones entries regardless of name case', async () => {
  const doInst = await makeDO();

  // Populate DO with two separate matches:
  //   • Alice vs Bob  — Alice will be purged (Bob shares her SID, also removed)
  //   • Carol vs Dave — unrelated match, must survive
  await doPut(doInst, 'evt-9', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0',   builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0',   builds: [] },
      { player: 'Carol', round: 'R1', _matchSid: 'R1|Carol|Dave|0',  builds: [] },
      { player: 'Dave',  round: 'R1', _matchSid: 'R1|Carol|Dave|0',  builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'], Carol: ['Valkyrie'] },
    mergeMode: true
  });

  // Purge using lower-case name — must still match canonically-cased "Alice".
  await doPut(doInst, 'evt-9', {
    purgePlayers: ['alice'],  // deliberately different casing
    mergeMode: true,
    deletedSids: []
  });

  const { data: afterPurge } = await doGet(doInst, 'evt-9');

  assert.ok(
    !afterPurge.beyResults.some(e => e.player === 'Alice'),
    'Alice must be purged from beyResults even when purgePlayers used lowercase "alice"'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(afterPurge.builds, 'Alice'),
    'Alice builds key must be removed even with case-mismatched purge name'
  );
  // Bob shares Alice's SID — the whole match is tombstoned, which is correct.
  // Carol and Dave are in a separate match and must be unaffected.
  assert.ok(
    afterPurge.beyResults.some(e => e.player === 'Carol'),
    'Carol (different match, not purged) must still be present after Alice purge'
  );
  assert.ok(
    afterPurge.beyResults.some(e => e.player === 'Dave'),
    'Dave (different match, not purged) must still be present after Alice purge'
  );
});

// ─── Test 5: account/player rename updates DO-backed live results ─────────────

test('player rename propagates to DO-backed live beyResults', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // DO has Alice's match results.
  const doInst = await makeDO();
  await doPut(doInst, 'evt-5', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  });

  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1,
      aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [{
      id: 'evt-5',
      title: 'Test Event',
      joiners: [{ username: 'alice', entryId: 'eid-alice', entryType: 'main', name: 'Alice', type: 'solo' }],
      beyResults: [
        { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
        { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
      ],
      builds: {}
    }] })
  });

  const env = {
    BEYBLADE_KV:  kv,
    BEY_STATE_DO: makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Alice renames herself to NewAlice.
  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);
  assert.equal(res.status, 200, 'rename must succeed: ' + (res.ok ? '' : await res.text()));

  // DO must now have entries with player: 'NewAlice'.
  const { data: doState } = await doGet(doInst, 'evt-5');
  const aliceEntry = doState.beyResults.find(e => e._matchSid === 'R1|Alice|Bob|0' && e.player === 'NewAlice');
  assert.ok(aliceEntry, 'DO beyResults must have updated player name NewAlice after rename');
  assert.ok(!doState.beyResults.some(e => e.player === 'Alice'),
    'DO must not still have old player name Alice');
});

// ─── Test 10: two MANUAL players have independent SIDs and purge independently ─

test('two MANUAL players in one event have independent SIDs and purge independently', async () => {
  const doInst = await makeDO();

  // Both Alice and Bob are admin-entered MANUAL results — no opponent (singleton).
  // They must NOT be paired together into a shared SID.
  await doPut(doInst, 'evt-10', {
    beyResults: [
      { player: 'Alice', round: 'MANUAL', pointsTotal: 5, win: true,  builds: [] },
      { player: 'Bob',   round: 'MANUAL', pointsTotal: 3, win: false, builds: [] }
    ],
    mergeMode: true
  });

  const { data: after1 } = await doGet(doInst, 'evt-10');
  const aliceEntry = after1.beyResults.find(e => e.player === 'Alice');
  const bobEntry   = after1.beyResults.find(e => e.player === 'Bob');
  assert.ok(aliceEntry, 'Alice MANUAL entry must be stored');
  assert.ok(bobEntry,   'Bob MANUAL entry must be stored');
  assert.ok(aliceEntry._matchSid, 'Alice must have a SID assigned');
  assert.ok(bobEntry._matchSid,   'Bob must have a SID assigned');
  assert.notEqual(
    aliceEntry._matchSid, bobEntry._matchSid,
    'Two MANUAL entries in one event must have DIFFERENT SIDs — they must not be paired'
  );

  // Purge Alice only — Bob must survive.
  await doPut(doInst, 'evt-10', {
    purgePlayers: ['Alice'],
    mergeMode: true, deletedSids: []
  });

  const { data: after2 } = await doGet(doInst, 'evt-10');
  assert.ok(
    !after2.beyResults.some(e => e.player === 'Alice'),
    'Alice must be purged'
  );
  assert.ok(
    after2.beyResults.some(e => e.player === 'Bob'),
    'Bob must survive Alice purge — their SIDs are independent'
  );
});

// ─── Test 11: DO rename 5xx returns 503 and rolls back KV ─────────────────────

test('player rename returns 503 and rolls back KV when DO rename returns 5xx', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // A DO binding that always returns 503 for any PUT (rename fails).
  const brokenDOBinding = {
    idFromName(_name) { return { name: _name }; },
    get(_id) {
      return {
        fetch(_url, _init) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 })
          );
        }
      };
    }
  };

  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [{
      id: 'evt-11',
      title: 'Test Event',
      // solo joiner so accounts.js includes this event in affectedEventIds
      joiners: [{ username: 'alice', entryId: 'eid-alice', entryType: 'main', name: 'Alice', type: 'solo' }],
      beyResults: [{ player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }],
      builds: {}
    }] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   brokenDOBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  assert.equal(res.status, 503,
    'rename must return 503 when DO is unavailable — must not report success');

  // KV must be rolled back — accounts still shows Alice, not NewAlice.
  const accountsRaw = await kv.get('accounts');
  const accountsObj = JSON.parse(accountsRaw);
  assert.equal(
    accountsObj.alice.displayName, 'Alice',
    'accounts KV must be rolled back to old display name after DO rename failure'
  );

  // Events KV must also be rolled back.
  const eventsRaw = await kv.get('events');
  const eventsObj = JSON.parse(eventsRaw);
  const joiner = (eventsObj.events[0].joiners || []).find(j => j.username === 'alice');
  assert.equal(
    joiner && joiner.name, 'Alice',
    'events KV must be rolled back — joiner name must still be Alice'
  );
});

// ─── Test 12: whitespace-insensitive purge matching ───────────────────────────

test('purgePlayers matches player names with internal whitespace differences', async () => {
  const doInst = await makeDO();

  // Player has an internal space in their canonical name.
  await doPut(doInst, 'evt-12', {
    beyResults: [
      { player: 'Alice Smith', round: 'R1', _matchSid: 'R1|Alice Smith|Bob|0', builds: [] },
      { player: 'Bob',         round: 'R1', _matchSid: 'R1|Alice Smith|Bob|0', builds: [] }
    ],
    builds: { 'Alice Smith': ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });

  // Purge using the space-collapsed, lowercase form — matching what the UI
  // sends via _playerNamesMatch (which strips ALL whitespace before comparing).
  await doPut(doInst, 'evt-12', {
    purgePlayers: ['AliceSmith'],   // no space, different casing
    mergeMode: true, deletedSids: []
  });

  const { data: afterPurge } = await doGet(doInst, 'evt-12');

  assert.ok(
    !afterPurge.beyResults.some(e => e.player === 'Alice Smith'),
    '"Alice Smith" must be purged by space-collapsed purge name "AliceSmith"'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(afterPurge.builds, 'Alice Smith'),
    '"Alice Smith" builds key must be removed by space-collapsed purge name'
  );
});

// ─── Test 13: stale builds cannot reappear after purgePlayers ─────────────────

test('stale builds cannot reappear after purgePlayers via subsequent merge PUT', async () => {
  const doInst = await makeDO();

  // Populate DO with Alice and Bob.
  await doPut(doInst, 'evt-13', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });

  // Admin purges Alice.
  await doPut(doInst, 'evt-13', {
    purgePlayers: ['Alice'],
    mergeMode: true, deletedSids: []
  });

  // Verify Alice's builds are gone.
  const { data: afterPurge } = await doGet(doInst, 'evt-13');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(afterPurge.builds, 'Alice'),
    'Alice builds gone after purge'
  );

  // Stale client (missed the purge) sends a merge PUT with Alice's builds.
  await doPut(doInst, 'evt-13', {
    beyResults: [
      { player: 'Bob', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },  // stale: still includes Alice
    mergeMode: true, deletedSids: []
  });

  const { data: afterStale } = await doGet(doInst, 'evt-13');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(afterStale.builds, 'Alice'),
    'Alice builds must NOT reappear after stale client resends them — purgedOwners must block re-insertion'
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(afterStale.builds, 'Bob'),
    'Bob builds must still be present after stale merge'
  );
});

// ─── Test 15: multi-event partial rename failure rolls back successful DOs ─────

test('partial rename failure rolls back KV and compensates already-renamed DOs', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // Two separate DO instances — one per event.
  const doInstA = await makeDO();
  const doInstB = await makeDO(); // never actually called; its binding returns 503

  // Pre-populate evt-a with Alice's match entry.
  await doPut(doInstA, 'evt-a', {
    beyResults: [{ player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }],
    mergeMode: true
  });

  // Custom multi-event binding:
  //   evt-a → real doInstA (succeeds)
  //   evt-b → always returns 503 (fails)
  const partialBinding = {
    idFromName(name) { return { name }; },
    get(id) {
      if (id.name === 'evt-a') {
        return {
          fetch(url, init) { return doInstA.fetch(new Request(url, init)); }
        };
      }
      // evt-b: simulate service unavailable
      return {
        fetch() {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'evt-b unavailable' }), { status: 503 })
          );
        }
      };
    }
  };

  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [
      {
        id: 'evt-a', title: 'Event A',
        joiners: [{ username: 'alice', entryId: 'eid', entryType: 'main', name: 'Alice', type: 'solo' }],
        beyResults: [], builds: {}
      },
      {
        id: 'evt-b', title: 'Event B',
        joiners: [{ username: 'alice', entryId: 'eid', entryType: 'main', name: 'Alice', type: 'solo' }],
        beyResults: [], builds: {}
      }
    ] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   partialBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  assert.equal(res.status, 503,
    'rename must return 503 when any event DO rename fails');

  // KV must be rolled back to Alice.
  const accountsRaw = await kv.get('accounts');
  assert.equal(
    JSON.parse(accountsRaw).alice.displayName, 'Alice',
    'KV accounts must be rolled back to Alice'
  );

  // evt-a DO succeeded before evt-b failed, so a compensating rename must
  // have been sent to revert it back to Alice.
  const { data: evtAState } = await doGet(doInstA, 'evt-a');
  assert.ok(
    evtAState.beyResults.some(e => e.player === 'Alice'),
    'evt-a DO must be compensating-renamed back to Alice after partial failure'
  );
  assert.ok(
    !evtAState.beyResults.some(e => e.player === 'NewAlice'),
    'evt-a DO must not retain NewAlice after compensating rollback'
  );
});

// ─── Test 16: __syncToKV writes DO state directly to KV ───────────────────────

test('__syncToKV admin action writes current DO state directly to KV', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  const doInst = await makeDO();

  // Populate the DO with Alice and Bob (KV has stale empty state).
  await doPut(doInst, 'evt-sync', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });

  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-sync', title: 'Sync Test',
      beyResults: [], builds: {}   // deliberately stale
    }] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Call __syncToKV while DO binding is active.
  const ctx = makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-sync',
    __syncToKV: true
  });
  const res = await onRequest(ctx);
  assert.equal(res.status, 200, '__syncToKV must return 200');

  const body = await res.json();
  assert.ok(body.success, 'response must include success: true');
  assert.ok(
    (body.synced.beyResults || []).some(e => e.player === 'Alice'),
    'synced.beyResults must include Alice'
  );

  // KV must now contain the DO\'s authoritative state.
  const kvRaw = await kv.get('events');
  const kvEvent = JSON.parse(kvRaw).events.find(e => e.id === 'evt-sync');
  assert.ok(kvEvent, 'event must exist in KV after __syncToKV');
  assert.ok(
    (kvEvent.beyResults || []).some(e => e.player === 'Alice'),
    'KV must have Alice\'s result after __syncToKV'
  );
  assert.ok(
    (kvEvent.beyResults || []).some(e => e.player === 'Bob'),
    'KV must have Bob\'s result after __syncToKV'
  );
  assert.ok(
    kvEvent.builds && kvEvent.builds.Alice,
    'KV must have Alice\'s builds after __syncToKV'
  );
});

// ─── Test 17: KV full-replace cannot resurrect purged beyResults ───────────────

test('full-replace PUT cannot resurrect tombstoned/purged beyResults rows in KV', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  // KV-only (no DO binding) so we exercise the KV code path directly.
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-kv-purge', title: 'Purge Test', beyResults: [], builds: {}
    }] })
  });
  const env = { BEYBLADE_KV: kv, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret' };

  // Step 1: add two separate matches via merge PUT.
  //   Match A: Alice vs Carol (R1) — Alice will be purged; Carol shares her SID
  //   Match B: Bob vs Dave (R2)   — unrelated, must survive Alice purge
  let ctx = makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-kv-purge',
    beyResults: [
      { player: 'Alice', round: 'R1', builds: [] },
      { player: 'Carol', round: 'R1', builds: [] },
      { player: 'Bob',   round: 'R2', builds: [] },
      { player: 'Dave',  round: 'R2', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });
  let res = await onRequest(ctx);
  assert.equal(res.status, 200, 'initial merge PUT must succeed');

  // Step 2: purge Alice (tombstones R1|Alice|Carol|0, adds alice to purgedOwners).
  ctx = makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-kv-purge',
    purgePlayers: ['Alice'],
    mergeMode: true, deletedSids: []
  });
  res = await onRequest(ctx);
  assert.equal(res.status, 200, 'purge PUT must succeed');

  // Step 3: stale legacy full-replace includes Alice (and Carol, Bob, Dave).
  // No mergeMode flag — this is the unsafe legacy path.
  // After the fix, kvHasProtectedState forces merge mode, so tombstones apply.
  ctx = makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-kv-purge',
    beyResults: [
      { player: 'Alice', round: 'R1', builds: [] },  // purged SID — must be blocked
      { player: 'Carol', round: 'R1', builds: [] },  // shares Alice's SID — also blocked
      { player: 'Bob',   round: 'R2', builds: [] },  // different match — must survive
      { player: 'Dave',  round: 'R2', builds: [] }   // different match — must survive
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] }
    // NOTE: no mergeMode
  });
  res = await onRequest(ctx);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(
    !(body.beyResults || []).some(e => e.player === 'Alice'),
    'Alice must not appear in response — full-replace must honour tombstone protection'
  );
  assert.ok(
    (body.beyResults || []).some(e => e.player === 'Bob'),
    'Bob (different match, not purged) must still be present in response'
  );
  assert.ok(
    (body.beyResults || []).some(e => e.player === 'Dave'),
    'Dave (different match, not purged) must still be present in response'
  );

  // Verify KV state directly.
  const kvRaw = await kv.get('events');
  const kvEvent = JSON.parse(kvRaw).events.find(e => e.id === 'evt-kv-purge');
  const visible = (kvEvent.beyResults || []).filter(e => !e._tombstone);
  assert.ok(
    !visible.some(e => e.player === 'Alice'),
    'Alice must not be in visible KV beyResults after full-replace resurrection attempt'
  );
  assert.ok(
    visible.some(e => e.player === 'Bob'),
    'Bob must remain in KV beyResults'
  );
});

// ─── Test 18: __syncToKV preserves tombstones in KV (deletion case) ───────────

test('__syncToKV preserves match-deletion tombstones in KV so rollback cannot resurrect deleted matches', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  const doInst = await makeDO();

  // Step 1: populate DO with Alice vs Bob.
  await doPut(doInst, 'evt-sync-tomb', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });

  // Step 2: delete the match — DO must now hold a tombstone for the SID.
  await doPut(doInst, 'evt-sync-tomb', {
    deletedSids: ['R1|Alice|Bob|0'],
    mergeMode: true
  });

  // Sanity: DO state contains a tombstone for the deleted SID.
  const { data: doStateBefore } = await doGet(doInst, 'evt-sync-tomb');
  assert.ok(
    (doStateBefore.beyResults || []).some(e => e._tombstone === true && e._matchSid === 'R1|Alice|Bob|0'),
    'DO must hold a tombstone for the deleted match before __syncToKV'
  );

  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-sync-tomb', title: 'Sync Tomb Test',
      beyResults: [], builds: {}
    }] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Step 3: __syncToKV export.
  let res = await onRequest(makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-sync-tomb',
    __syncToKV: true
  }));
  assert.equal(res.status, 200, '__syncToKV must succeed');

  const body = await res.json();
  // Client-visible response strips tombstones.
  assert.ok(
    !(body.synced.beyResults || []).some(e => e._tombstone === true),
    'response must NOT expose tombstone entries to the caller'
  );

  // KV state MUST contain the tombstone so rollback (DO binding removed) is safe.
  const kvEvent = JSON.parse(await kv.get('events')).events.find(e => e.id === 'evt-sync-tomb');
  assert.ok(
    (kvEvent.beyResults || []).some(e => e._tombstone === true && e._matchSid === 'R1|Alice|Bob|0'),
    'KV beyResults MUST retain the tombstone after __syncToKV — required for post-rollback safety'
  );

  // Step 4: simulate post-rollback world — DO binding removed, KV-only path active.
  //         A stale client tries to resurrect the deleted match via merge PUT.
  const envKvOnly = {
    BEYBLADE_KV:    kv,
    // BEY_STATE_DO intentionally omitted — DO binding has been removed.
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };
  res = await onRequest(makePagesCtx(envKvOnly, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-sync-tomb',
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  }));
  assert.equal(res.status, 200, 'stale merge PUT must process');
  const stale = await res.json();
  assert.ok(
    !(stale.beyResults || []).some(e => e.player === 'Alice'),
    'deleted match must NOT be resurrected post-rollback — tombstone in KV must still block it'
  );
});

// ─── Test 19: __syncToKV preserves purgePlayers tombstones + purgedOwners ─────

test('__syncToKV preserves purgePlayers tombstones and purgedOwners list in KV', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  const doInst = await makeDO();
  await doPut(doInst, 'evt-sync-purge', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });
  await doPut(doInst, 'evt-sync-purge', {
    purgePlayers: ['Alice'],
    mergeMode: true, deletedSids: []
  });

  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-sync-purge', title: 'Sync Purge Test',
      beyResults: [], builds: {}
    }] })
  });
  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const res = await onRequest(makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-sync-purge',
    __syncToKV: true
  }));
  assert.equal(res.status, 200, '__syncToKV must succeed');

  const kvEvent = JSON.parse(await kv.get('events')).events.find(e => e.id === 'evt-sync-purge');
  assert.ok(
    (kvEvent.beyResults || []).some(e => e._tombstone === true),
    'KV must retain at least one tombstone after purgePlayers __syncToKV'
  );
  assert.ok(
    Array.isArray(kvEvent.purgedOwners) && kvEvent.purgedOwners.length > 0,
    'KV must retain purgedOwners list after __syncToKV'
  );

  // Post-rollback: a stale client tries to re-add Alice's builds.
  const envKvOnly = { BEYBLADE_KV: kv, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret' };
  const res2 = await onRequest(makePagesCtx(envKvOnly, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-sync-purge',
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  }));
  assert.equal(res2.status, 200);
  const body = await res2.json();
  assert.ok(
    !(body.beyResults || []).some(e => e.player === 'Alice'),
    'purged Alice must not resurrect after rollback — KV tombstone must block stale resurrect'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(body.builds || {}, 'Alice'),
    'purged Alice builds must not reappear post-rollback — purgedOwners in KV must block'
  );
});

// ─── Test 20: failed compensation surfaces repair-required, NOT clean rollback ─

test('partial rename with failing compensation returns repair-required response and inconsistent event IDs', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // Real DO for evt-a (forward rename will succeed against it).
  const doInstA = await makeDO();
  await doPut(doInstA, 'evt-a', {
    beyResults: [{ player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }],
    mergeMode: true
  });

  // Stateful binding:
  //   • First call to evt-a (forward rename Alice→NewAlice) succeeds via doInstA.
  //   • Any later call to evt-a (the reverse-compensation rename) returns 503.
  //   • evt-b ALWAYS returns 503 (forward rename fails, which triggers compensation).
  let evtACallCount = 0;
  const flakyBinding = {
    idFromName(name) { return { name }; },
    get(id) {
      if (id.name === 'evt-a') {
        return {
          fetch(url, init) {
            evtACallCount += 1;
            if (evtACallCount === 1) {
              // forward rename — succeeds via the real DO
              return doInstA.fetch(new Request(url, init));
            }
            // compensation attempt — fail
            return Promise.resolve(
              new Response(JSON.stringify({ error: 'evt-a unavailable for compensation' }), { status: 503 })
            );
          }
        };
      }
      return {
        fetch() {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'evt-b unavailable' }), { status: 503 })
          );
        }
      };
    }
  };

  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [
      {
        id: 'evt-a', title: 'Event A',
        joiners: [{ username: 'alice', entryId: 'eid', entryType: 'main', name: 'Alice', type: 'solo' }],
        beyResults: [], builds: {}
      },
      {
        id: 'evt-b', title: 'Event B',
        joiners: [{ username: 'alice', entryId: 'eid', entryType: 'main', name: 'Alice', type: 'solo' }],
        beyResults: [], builds: {}
      }
    ] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   flakyBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  // The response MUST signal that the rollback did not complete cleanly.
  assert.notEqual(
    res.status, 503,
    'response must NOT be the plain 503 "all rolled back" status when compensation failed'
  );
  assert.equal(
    res.status, 500,
    'failed compensation must surface as a 500 repair-required response'
  );

  const body = await res.json();
  assert.equal(body.repairRequired, true, 'response must set repairRequired:true');
  assert.ok(
    Array.isArray(body.inconsistentEventIds) && body.inconsistentEventIds.includes('evt-a'),
    'response must list evt-a as inconsistent (compensation failed)'
  );
  assert.ok(
    typeof body.error === 'string' && !/all changes have been rolled back/i.test(body.error),
    'error message must NOT claim "all changes have been rolled back" when compensation failed'
  );

  // KV must still be reverted to Alice (best-effort) — we report divergence
  // because the DO still holds NewAlice.
  const accountsRaw = await kv.get('accounts');
  assert.equal(
    JSON.parse(accountsRaw).alice.displayName, 'Alice',
    'KV accounts must still be rolled back to Alice'
  );

  // The real evt-a DO still holds NewAlice — the inconsistency the response reports.
  const { data: evtAState } = await doGet(doInstA, 'evt-a');
  assert.ok(
    evtAState.beyResults.some(e => e.player === 'NewAlice'),
    'evt-a DO must still hold NewAlice — compensation never completed'
  );
});

// ─── Test 21: __syncFromKV reactivation merges KV-only writes back into DO ────

test('__syncFromKV merges KV-only writes into an already-hydrated DO so reactivation does not hide matches', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  // Step 1: BEY_STATE_DO active. Save Alice/Bob via the DO.
  const doInst = await makeDO();
  await doPut(doInst, 'evt-react', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });

  // KV is stale until __syncToKV is run.
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-react', title: 'Reactivation Test',
      beyResults: [], builds: {}
    }] })
  });
  const envWithDO = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Step 2: __syncToKV — export DO state to KV (including tombstones, none here yet).
  let res = await onRequest(makePagesCtx(envWithDO, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-react',
    __syncToKV: true
  }));
  assert.equal(res.status, 200, '__syncToKV must succeed');

  // Step 3: Remove DO binding — KV-only path. Save Carol/Dave (new match).
  const envKvOnly = { BEYBLADE_KV: kv, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret' };
  res = await onRequest(makePagesCtx(envKvOnly, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-react',
    beyResults: [
      { player: 'Carol', round: 'R2', _matchSid: 'R2|Carol|Dave|0', builds: [] },
      { player: 'Dave',  round: 'R2', _matchSid: 'R2|Carol|Dave|0', builds: [] }
    ],
    builds: { Carol: ['Valkyrie'] },
    mergeMode: true, deletedSids: []
  }));
  assert.equal(res.status, 200, 'KV-only PUT must succeed');

  // Sanity: KV now holds both matches.
  const kvEvent = JSON.parse(await kv.get('events')).events.find(e => e.id === 'evt-react');
  const kvPlayers = new Set((kvEvent.beyResults || []).filter(e => !e._tombstone).map(e => e.player));
  assert.ok(kvPlayers.has('Alice') && kvPlayers.has('Bob') && kvPlayers.has('Carol') && kvPlayers.has('Dave'),
    'KV must contain all four players after KV-only write');

  // Step 4: Restore DO binding (DO is still hydrated with Alice/Bob, no Carol/Dave).
  //         GET WITHOUT __syncFromKV would only return Alice/Bob — confirm the bug.
  res = await onRequest(makePagesCtx(envWithDO, 'GET', 'https://example.com/api/beyresults?eventId=evt-react'));
  assert.equal(res.status, 200);
  const preFixBody = await res.json();
  const preFixPlayers = new Set((preFixBody.beyResults || []).map(e => e.player));
  assert.ok(preFixPlayers.has('Alice'), 'Alice (in DO) must be visible before reactivation merge');
  assert.ok(!preFixPlayers.has('Carol'),
    'Carol (KV-only) must NOT be visible until __syncFromKV runs — this is the bug being fixed');

  // Step 5: __syncFromKV — merge KV state into the already-hydrated DO.
  res = await onRequest(makePagesCtx(envWithDO, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-react',
    __syncFromKV: true
  }));
  assert.equal(res.status, 200, '__syncFromKV must succeed');
  const importBody = await res.json();
  assert.equal(importBody.imported, 'merged-from-kv',
    'response must indicate merge-into-existing-DO path, not first-write hydration');

  // Step 6: GET — all four players must now be visible from the DO.
  res = await onRequest(makePagesCtx(envWithDO, 'GET', 'https://example.com/api/beyresults?eventId=evt-react'));
  assert.equal(res.status, 200);
  const finalBody = await res.json();
  const finalPlayers = new Set((finalBody.beyResults || []).map(e => e.player));
  assert.ok(finalPlayers.has('Alice'), 'Alice must remain visible after reactivation merge');
  assert.ok(finalPlayers.has('Bob'),   'Bob must remain visible after reactivation merge');
  assert.ok(finalPlayers.has('Carol'), 'Carol (KV-only) must be visible after __syncFromKV');
  assert.ok(finalPlayers.has('Dave'),  'Dave (KV-only) must be visible after __syncFromKV');
});

// ─── Test 22: __syncFromKV preserves DO tombstones and purgedOwners ───────────

test('__syncFromKV preserves DO tombstones and unions purgedOwners — no resurrection on reactivation', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  const doInst = await makeDO();
  // Populate DO with two matches:
  //   • Alice vs Carol (R1) — Alice will be purged; Carol shares the SID so the
  //     whole match goes tombstone.
  //   • Bob vs Dave (R2)    — unrelated; must survive the purge and reactivation.
  await doPut(doInst, 'evt-react2', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
      { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
      { player: 'Bob',   round: 'R2', _matchSid: 'R2|Bob|Dave|0',    builds: [] },
      { player: 'Dave',  round: 'R2', _matchSid: 'R2|Bob|Dave|0',    builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });
  await doPut(doInst, 'evt-react2', {
    purgePlayers: ['Alice'],
    mergeMode: true, deletedSids: []
  });

  // KV holds a STALE pre-purge snapshot that still contains Alice (and Carol,
  // sharing her SID) — exactly the hazard reactivation has to handle safely.
  // The unrelated Bob/Dave match is also in KV.
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-react2', title: 'Reactivation Tomb Test',
      beyResults: [
        { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
        { player: 'Carol', round: 'R1', _matchSid: 'R1|Alice|Carol|0', builds: [] },
        { player: 'Bob',   round: 'R2', _matchSid: 'R2|Bob|Dave|0',    builds: [] },
        { player: 'Dave',  round: 'R2', _matchSid: 'R2|Bob|Dave|0',    builds: [] }
      ],
      builds: { Alice: ['Dragon'], Bob: ['Phoenix'] }
    }] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // __syncFromKV must merge KV into DO without resurrecting Alice.
  const res = await onRequest(makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-react2',
    __syncFromKV: true
  }));
  assert.equal(res.status, 200, '__syncFromKV must succeed');

  // GET the event via the DO path.
  const getRes = await onRequest(makePagesCtx(env, 'GET',
    'https://example.com/api/beyresults?eventId=evt-react2'));
  assert.equal(getRes.status, 200);
  const body = await getRes.json();
  assert.ok(
    !(body.beyResults || []).some(e => e.player === 'Alice'),
    'Alice must NOT resurrect — DO tombstone must survive __syncFromKV'
  );
  assert.ok(
    !(body.beyResults || []).some(e => e.player === 'Carol'),
    'Carol (shared tombstoned SID with Alice) must NOT resurrect either'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(body.builds || {}, 'Alice'),
    'Alice builds must NOT reappear — purgedOwners must survive __syncFromKV'
  );
  assert.ok(
    (body.beyResults || []).some(e => e.player === 'Bob'),
    'Bob (unrelated match) must still be present after __syncFromKV merge'
  );
  assert.ok(
    (body.beyResults || []).some(e => e.player === 'Dave'),
    'Dave (unrelated match) must still be present after __syncFromKV merge'
  );
});

// ─── Test 23: KV rollback failure during s2 write surfaces repair-required ────

test('rename returns 500 repairRequired when KV rollback fails during s2 write failure', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // Custom KV: gamedata_s2 PUT throws (forcing rollback), accounts PUT also
  // throws on the SECOND call (the rollback). Sequence:
  //   1. PUT accounts (updated)        — succeeds
  //   2. PUT gamedata_s2 (updated)     — throws → triggers rollback
  //   3. PUT accounts (rollback)       — throws → captured as rollbackFailure
  const store = new Map();
  let accountsPutCount = 0;
  const kv = {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) {
      if (key === 'gamedata_s2') {
        throw new Error('simulated s2 write failure');
      }
      if (key === 'accounts') {
        accountsPutCount += 1;
        if (accountsPutCount === 2) {
          throw new Error('simulated accounts rollback failure');
        }
      }
      store.set(key, value);
    },
    async delete(key) { store.delete(key); }
  };
  store.set('accounts', JSON.stringify({ alice: {
    displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
  }}));
  store.set('session:tok-alice', JSON.stringify({ username: 'alice', tokenVersion: 1 }));
  // gamedata_s2 must have a player named Alice so s2Changed flips true.
  store.set('gamedata_s2', JSON.stringify({
    players: [{ name: 'Alice', wins: 1 }],
    bladerStats: { Alice: { wins: 1 } }
  }));

  const env = {
    BEYBLADE_KV:    kv,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  assert.equal(res.status, 500,
    'response must be 500 when KV rollback itself fails');
  const body = await res.json();
  assert.equal(body.repairRequired, true,
    'response must set repairRequired:true');
  assert.ok(
    Array.isArray(body.rollbackFailures) &&
      body.rollbackFailures.some(f => f.key === 'accounts'),
    'response must list "accounts" in rollbackFailures'
  );
  assert.ok(
    !/has been rolled back/i.test(body.error || ''),
    'error message must NOT claim "has been rolled back" when rollback failed'
  );
});

// ─── Test 24: KV rollback failure during compensation also surfaces repair ────

test('rename returns 500 repairRequired when KV rollback fails after DO compensation', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // DO binding always 503 — forward rename fails immediately, no compensation
  // needed. We just exercise the rollback-failure path in the post-DO branch.
  const brokenDOBinding = {
    idFromName(name) { return { name }; },
    get(_id) {
      return {
        fetch() {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 })
          );
        }
      };
    }
  };

  // KV: accounts and events PUTs succeed the first time, fail on rollback.
  const store = new Map();
  let accountsPutCount = 0;
  let eventsPutCount   = 0;
  const kv = {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) {
      if (key === 'accounts') {
        accountsPutCount += 1;
        if (accountsPutCount === 2) {
          throw new Error('simulated accounts rollback failure');
        }
      }
      if (key === 'events') {
        eventsPutCount += 1;
        if (eventsPutCount === 2) {
          throw new Error('simulated events rollback failure');
        }
      }
      store.set(key, value);
    },
    async delete(key) { store.delete(key); }
  };
  store.set('accounts', JSON.stringify({ alice: {
    displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
  }}));
  store.set('session:tok-alice', JSON.stringify({ username: 'alice', tokenVersion: 1 }));
  store.set('events', JSON.stringify({ events: [{
    id: 'evt-rb', title: 'Rollback Test',
    joiners: [{ username: 'alice', entryId: 'eid', entryType: 'main', name: 'Alice', type: 'solo' }],
    beyResults: [], builds: {}
  }] }));

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   brokenDOBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  assert.equal(res.status, 500,
    'response must be 500 when KV rollback in the compensation path fails');
  const body = await res.json();
  assert.equal(body.repairRequired, true, 'response must set repairRequired:true');
  assert.ok(
    Array.isArray(body.rollbackFailures) && body.rollbackFailures.length >= 1,
    'response must list at least one rollback failure'
  );
  assert.ok(
    body.rollbackFailures.some(f => f.key === 'accounts' || f.key === 'events'),
    'response must include the failed KV key in rollbackFailures'
  );
  assert.ok(
    !/all changes have been rolled back/i.test(body.error || ''),
    'error message must NOT claim "all changes have been rolled back" when rollback failed'
  );
});

// ─── Test 25: docs explicitly state __syncToKV preserves tombstones in KV ─────

test('DO_DEPLOYMENT.md states __syncToKV writes raw tombstone-containing state to KV', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const docPath = resolve(__dir, '../../docs/DO_DEPLOYMENT.md');
  const doc = readFileSync(docPath, 'utf8');

  const lower = doc.toLowerCase();
  // The old wording "tombstone-stripped" must be gone.
  assert.ok(
    !lower.includes('tombstone-stripped'),
    'docs must NOT describe __syncToKV as writing tombstone-stripped state — that is the bug'
  );
  // The new wording must say raw / including tombstones are written.
  assert.ok(
    lower.includes('including tombstones') || lower.includes('raw'),
    'docs must say __syncToKV writes raw (tombstone-containing) state to KV'
  );
  // The reactivation step must be documented.
  assert.ok(
    lower.includes('__syncfromkv'),
    'docs must document the __syncFromKV reactivation step'
  );
});

// ─── Test 26: DO commits, response is lost — compensation must run on the failing event ─

test('rename compensates the in-flight failed event even when its forward call threw mid-response', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  // A single-event DO that COMMITS the forward rename, then the binding wrapper
  // THROWS — simulating a network reset / response-lost after the DO already
  // applied the change. The bug: accounts.js never sees the eid as successful
  // (push happens only on resolve), so no compensation runs and the DO is left
  // at NewAlice while KV rolls back to Alice.
  const doInst = await makeDO();

  // Pre-populate with Alice's match entry so we can later detect rename state.
  await doPut(doInst, 'evt-ifail', {
    beyResults: [{ player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }],
    mergeMode: true
  });

  // Binding behaviour by call count:
  //   1. Forward rename (Alice→NewAlice): apply to real DO, then throw.
  //   2. Compensation (NewAlice→Alice):  pass-through (succeeds).
  //   3+ : pass-through.
  let putCount = 0;
  const ifailBinding = {
    idFromName(name) { return { name }; },
    get(_id) {
      return {
        async fetch(url, init) {
          // Only PUTs are interesting — GETs pass through.
          if (init && init.method === 'PUT') {
            putCount += 1;
            if (putCount === 1) {
              // DO commits the forward rename …
              await doInst.fetch(new Request(url, init));
              // … then the response gets lost on the wire.
              throw new Error('simulated network reset after DO commit');
            }
          }
          return doInst.fetch(new Request(url, init));
        }
      };
    }
  };

  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [{
      id: 'evt-ifail', title: 'In-flight failure Test',
      joiners: [{ username: 'alice', entryId: 'eid', entryType: 'main', name: 'Alice', type: 'solo' }],
      beyResults: [{ player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }],
      builds: {}
    }] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   ifailBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  // KV must be rolled back to Alice (always, regardless of DO outcome).
  const accountsRaw = await kv.get('accounts');
  assert.equal(
    JSON.parse(accountsRaw).alice.displayName, 'Alice',
    'KV accounts must be rolled back to Alice'
  );

  // The fix's core contract: the DO must NOT be silently left holding NewAlice.
  // Compensation ran on the in-flight failed eid → DO is back at Alice.
  const { data: doState } = await doGet(doInst, 'evt-ifail');
  assert.ok(
    !doState.beyResults.some(e => e.player === 'NewAlice'),
    'DO must NOT still hold NewAlice — compensation must have run for the in-flight failed event'
  );
  assert.ok(
    doState.beyResults.some(e => e.player === 'Alice'),
    'DO must be restored to Alice via compensating rename'
  );

  // Either outcome is acceptable for the API response, but it must be honest:
  //   • 503 "rolled back" only if DO is genuinely restored (this run: yes).
  //   • 500 repairRequired listing the eid if compensation failed (not here).
  // We accept the 503 path here since compensation succeeded.
  assert.ok(
    res.status === 503 || res.status === 500,
    'response must be either 503 (clean rollback) or 500 (repair-required), got ' + res.status
  );
  if (res.status === 500) {
    const body = await res.json();
    assert.ok(
      Array.isArray(body.inconsistentEventIds) && body.inconsistentEventIds.includes('evt-ifail'),
      'if 500 is returned, the in-flight failed eid must appear in inconsistentEventIds'
    );
  }
});

// ─── Test 27: In-flight forward fail + compensation also fails → 500 repair-required ─

test('rename in-flight forward fail AND compensation also fail → 500 lists the eid in inconsistentEventIds', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');

  const doInst = await makeDO();
  await doPut(doInst, 'evt-ifail2', {
    beyResults: [{ player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }],
    mergeMode: true
  });

  // EVERY PUT applies to the real DO then throws — both the forward call and
  // the subsequent compensation throw, so the system genuinely cannot confirm
  // final DO state.
  const alwaysThrowBinding = {
    idFromName(name) { return { name }; },
    get(_id) {
      return {
        async fetch(url, init) {
          if (init && init.method === 'PUT') {
            await doInst.fetch(new Request(url, init));
            throw new Error('simulated network reset after DO commit');
          }
          return doInst.fetch(new Request(url, init));
        }
      };
    }
  };

  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [{
      id: 'evt-ifail2', title: 'In-flight failure Test 2',
      joiners: [{ username: 'alice', entryId: 'eid', entryType: 'main', name: 'Alice', type: 'solo' }],
      beyResults: [], builds: {}
    }] })
  });
  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   alwaysThrowBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  assert.equal(res.status, 500,
    'response must be 500 when both forward and compensation outcomes are unconfirmed');
  const body = await res.json();
  assert.equal(body.repairRequired, true, 'response must set repairRequired:true');
  assert.ok(
    Array.isArray(body.inconsistentEventIds) && body.inconsistentEventIds.includes('evt-ifail2'),
    'the ambiguous in-flight eid must appear in inconsistentEventIds'
  );
  assert.ok(
    !/all changes have been rolled back/i.test(body.error || ''),
    'error must NOT claim "all changes rolled back" when compensation result is unknown'
  );
});

// ─── Test 28: __syncFromKV is idempotent — tombstone _deletedAt is not refreshed ─

test('__syncFromKV does not refresh tombstone _deletedAt on repeated imports', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  const doInst = await makeDO();

  // Populate DO with Alice/Bob, then delete the match — DO holds a tombstone
  // whose _deletedAt is set at this moment.
  await doPut(doInst, 'evt-idem', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    builds: { Alice: ['Dragon'], Bob: ['Phoenix'] },
    mergeMode: true
  });
  await doPut(doInst, 'evt-idem', {
    deletedSids: ['R1|Alice|Bob|0'],
    mergeMode: true
  });

  // Capture the original _deletedAt before any __syncFromKV calls.
  const { data: doStateBefore } = await doGet(doInst, 'evt-idem');
  const tombBefore = (doStateBefore.beyResults || []).find(
    e => e._tombstone === true && e._matchSid === 'R1|Alice|Bob|0'
  );
  assert.ok(tombBefore, 'DO must hold the tombstone after deletion');
  const originalDeletedAt = tombBefore._deletedAt;
  assert.ok(
    typeof originalDeletedAt === 'number' && Number.isFinite(originalDeletedAt),
    'tombstone must have a numeric _deletedAt before any __syncFromKV'
  );

  // KV mirrors the DO state via __syncToKV (so KV also holds the same tombstone).
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-idem', title: 'Idempotency Test',
      beyResults: [], builds: {}
    }] })
  });
  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   makeDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  let res = await onRequest(makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-idem', __syncToKV: true
  }));
  assert.equal(res.status, 200, '__syncToKV must succeed');

  // Sanity: KV now holds the same tombstone with the same _deletedAt.
  const kvEvent = JSON.parse(await kv.get('events')).events.find(e => e.id === 'evt-idem');
  const kvTomb = (kvEvent.beyResults || []).find(e => e._tombstone === true && e._matchSid === 'R1|Alice|Bob|0');
  assert.ok(kvTomb, 'KV must hold the tombstone after __syncToKV');
  assert.equal(kvTomb._deletedAt, originalDeletedAt,
    'KV tombstone _deletedAt must equal DO tombstone _deletedAt after sync');

  // Wait a beat so that "now" advances meaningfully relative to originalDeletedAt.
  await new Promise(r => setTimeout(r, 25));

  // First __syncFromKV import. Must NOT bump _deletedAt forward.
  res = await onRequest(makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-idem', __syncFromKV: true
  }));
  assert.equal(res.status, 200, 'first __syncFromKV must succeed');

  const { data: doStateAfter1 } = await doGet(doInst, 'evt-idem');
  const tombAfter1 = (doStateAfter1.beyResults || []).find(
    e => e._tombstone === true && e._matchSid === 'R1|Alice|Bob|0'
  );
  assert.ok(tombAfter1, 'tombstone must survive first __syncFromKV');
  assert.equal(tombAfter1._deletedAt, originalDeletedAt,
    'tombstone _deletedAt MUST be unchanged after first __syncFromKV (no TTL refresh)');

  // Wait again, then re-import. Still must NOT bump _deletedAt.
  await new Promise(r => setTimeout(r, 25));

  res = await onRequest(makePagesCtx(env, 'PUT', 'https://example.com/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret',
    eventId: 'evt-idem', __syncFromKV: true
  }));
  assert.equal(res.status, 200, 'second __syncFromKV must succeed');

  const { data: doStateAfter2 } = await doGet(doInst, 'evt-idem');
  const tombAfter2 = (doStateAfter2.beyResults || []).find(
    e => e._tombstone === true && e._matchSid === 'R1|Alice|Bob|0'
  );
  assert.ok(tombAfter2, 'tombstone must survive second __syncFromKV');
  assert.equal(tombAfter2._deletedAt, originalDeletedAt,
    'tombstone _deletedAt MUST still be unchanged after second __syncFromKV — repeated imports must be idempotent');
});

// ─── Test 29: compensation to a fresh DO must hydrate from KV, not empty ─────

test('compensation of in-flight failure to a fresh DO hydrates from pre-rename KV — live GET keeps Alice/Bob', async () => {
  const { onRequest: accountsOnRequest } = await import('../../functions/api/accounts.js');
  const { onRequest: beyresultsOnRequest } = await import('../../functions/api/beyresults.js');

  // Fresh DO — never hydrated. KV holds the event's Alice/Bob match.
  const doInst = await makeDO();

  // Binding behaviour:
  //   • PUT #1 (forward rename Alice→NewAlice): THROW before reaching the DO.
  //     This is the ambiguous in-flight case — fetch failed at the wire so the
  //     DO has no idea a request was even attempted.
  //   • PUT #2+ (compensation NewAlice→Alice): pass through to the real DO.
  //   • Any GET: pass through.
  let putCount = 0;
  const flakyBinding = {
    idFromName(name) { return { name }; },
    get(_id) {
      return {
        async fetch(url, init) {
          if (init && init.method === 'PUT') {
            putCount += 1;
            if (putCount === 1) {
              throw new Error('simulated network error before forward request reached DO');
            }
          }
          return doInst.fetch(new Request(url, init));
        }
      };
    }
  };

  const kv = makeKV({
    accounts: JSON.stringify({ alice: {
      displayName: 'Alice', password: 'hash', tokenVersion: 1, aliases: ['Alice']
    }}),
    'session:tok-alice': JSON.stringify({ username: 'alice', tokenVersion: 1 }),
    events: JSON.stringify({ events: [{
      id: 'evt-fresh',
      title: 'Fresh DO In-flight Test',
      joiners: [{ username: 'alice', entryId: 'eid-alice', entryType: 'main', name: 'Alice', type: 'solo' }],
      beyResults: [
        { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
        { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
      ],
      builds: { Alice: ['Dragon'], Bob: ['Phoenix'] }
    }] })
  });

  const env = {
    BEYBLADE_KV:    kv,
    BEY_STATE_DO:   flakyBinding,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  const ctx = makePagesCtx(env, 'PUT',
    'https://example.com/api/accounts?action=player_rename',
    { selfUsername: 'alice', sessionToken: 'tok-alice', newDisplayName: 'NewAlice' }
  );
  const res = await accountsOnRequest(ctx);

  // KV must be rolled back to Alice and still hold the Alice/Bob match.
  const accountsRaw = await kv.get('accounts');
  assert.equal(JSON.parse(accountsRaw).alice.displayName, 'Alice',
    'KV accounts must be rolled back to Alice');
  const evRaw = await kv.get('events');
  const ev = JSON.parse(evRaw).events.find(e => e.id === 'evt-fresh');
  assert.ok(
    (ev.beyResults || []).some(e => e.player === 'Alice'),
    'KV events must still contain Alice after rollback'
  );
  assert.ok(
    (ev.beyResults || []).some(e => e.player === 'Bob'),
    'KV events must still contain Bob after rollback'
  );

  // CORE FIX: a subsequent live GET via the API must still return Alice/Bob.
  // Before the fix, compensation hydrated the fresh DO with empty state and
  // the DO returned [], wiping the live API view of this event.
  const getCtx = makePagesCtx(env, 'GET',
    'https://example.com/api/beyresults?eventId=evt-fresh'
  );
  const getRes = await beyresultsOnRequest(getCtx);
  assert.equal(getRes.status, 200, 'GET via DO-backed API must succeed');
  const getBody = await getRes.json();
  assert.ok(
    (getBody.beyResults || []).some(e => e.player === 'Alice'),
    'live API GET must still return Alice — compensation must hydrate fresh DO from KV, not empty state'
  );
  assert.ok(
    (getBody.beyResults || []).some(e => e.player === 'Bob'),
    'live API GET must still return Bob after compensation'
  );

  // And the DO state must contain those matches (proves the fix, not just KV fallthrough).
  const { res: doGetRes, data: doState } = await doGet(doInst, 'evt-fresh');
  assert.equal(doGetRes.status, 200, 'DO must be hydrated after compensation');
  assert.ok(
    (doState.beyResults || []).some(e => e.player === 'Alice'),
    'DO state must contain Alice after compensation — pre-rename hint must have hydrated it'
  );
  assert.ok(
    !doState.beyResults.some(e => e.player === 'NewAlice'),
    'DO must not contain NewAlice after compensation'
  );

  // Response should be 503 (clean rollback — compensation succeeded) or 500
  // (repair-required). Either is honest; just not a silent success.
  assert.ok(
    res.status === 503 || res.status === 500,
    'response must be 503 or 500, got ' + res.status
  );
});

// ─── Test 14: DO_DEPLOYMENT.md documents rollback data risk ───────────────────

test('DO_DEPLOYMENT.md documents rollback data risk and KV-sync warning', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const docPath = resolve(__dir, '../../docs/DO_DEPLOYMENT.md');
  const doc = readFileSync(docPath, 'utf8');

  assert.ok(
    doc.toLowerCase().includes('data-loss risk') || doc.toLowerCase().includes('data loss risk'),
    'docs must include a data-loss risk warning for rollback'
  );
  assert.ok(
    doc.toLowerCase().includes('not kept in sync') || doc.toLowerCase().includes('not in sync'),
    'docs must state that KV is not kept in sync with DO writes'
  );
  assert.ok(
    doc.toLowerCase().includes('export') && doc.toLowerCase().includes('rollback'),
    'docs must describe an export procedure to follow before rollback'
  );
});

// ─── Test: match-level patch preserves other matches (live scoring) ──────────

test('match-level patch PUT preserves other matches (non-submitted live push)', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');
  const eventId = 'evt-patch';
  const kv = makeKV({
    events: JSON.stringify({ events: [{ id: eventId, title: 'Patch Test', joiners: [], beyResults: [], builds: {} }] })
  });
  const doInst = await makeDO();
  const env = {
    BEYBLADE_KV: kv,
    BEY_STATE_DO: makeSerialDOBinding(doInst),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret'
  };

  // Seed two matches in one merge PUT.
  let res = await onRequest(makePagesCtx(env, 'PUT', 'https://x/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret', eventId, mergeMode: true, builds: {}, deletedSids: [],
    beyResults: [
      { player: 'a', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' },
      { player: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' },
      { player: 'c', round: 'R1', builds: [], win: false, _matchSid: 'R1|c|d|0' },
      { player: 'd', round: 'R1', builds: [], win: false, _matchSid: 'R1|c|d|0' }
    ]
  }));
  assert.equal(res.status, 200, 'seed PUT must succeed');

  // Live push: ONLY match A rows, in-progress O, NOT submitted.
  res = await onRequest(makePagesCtx(env, 'PUT', 'https://x/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret', eventId, mergeMode: true, builds: {}, deletedSids: [],
    beyResults: [
      { player: 'a', round: 'R1', builds: [{ finishes: ['O'] }], win: false, _matchSid: 'R1|a|b|0' },
      { player: 'b', round: 'R1', builds: [], win: false, _matchSid: 'R1|a|b|0' }
    ]
  }));
  assert.equal(res.status, 200, 'patch PUT must succeed');

  const getRes = await onRequest(makePagesCtx(env, 'GET', 'https://x/api/beyresults?eventId=' + eventId, null));
  const data = await getRes.json();
  const sids = new Set(data.beyResults.map(r => r._matchSid));
  assert.ok(sids.has('R1|c|d|0'), 'match C/D preserved by subset patch');
  const aRow = data.beyResults.find(r => r._matchSid === 'R1|a|b|0' && r.player === 'a');
  assert.deepEqual(aRow.builds, [{ finishes: ['O'] }], 'patch applied to match A');
});

// ─── Test: revivedSids lets a Challonge re-import through an active tombstone ──
//
// Root cause this guards against: a match deleted within the 24h tombstone TTL
// keeps a server tombstone. When the organizer re-imports the SAME pairing from
// Challonge, the recreated match carries the SAME deterministic _matchSid, so
// mergeBeyResults silently drops it — the re-import never persists. The fix lets
// the Challonge sync explicitly REVIVE only the sids it just recreated.

test('revivedSids lets a re-imported match through an active tombstone (DO path)', async () => {
  const doInst = await makeDO();

  // Seed Alice vs Bob.
  await doPut(doInst, 'evt-revive', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true
  });

  // Delete it — DO now holds an active tombstone for the sid.
  await doPut(doInst, 'evt-revive', { deletedSids: ['R1|Alice|Bob|0'], mergeMode: true });
  const { data: afterDelete } = await doGet(doInst, 'evt-revive');
  assert.ok(
    !(afterDelete.beyResults || []).some(e => e.player === 'Alice'),
    'precondition: deleted match is gone'
  );

  // Without revive, a plain merge PUT must STILL be blocked (tombstone holds).
  await doPut(doInst, 'evt-revive', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  });
  const { data: stillBlocked } = await doGet(doInst, 'evt-revive');
  assert.ok(
    !(stillBlocked.beyResults || []).some(e => e.player === 'Alice'),
    'plain re-PUT must remain blocked by the tombstone (stale-device protection)'
  );

  // Challonge re-import declares the sid it just recreated via revivedSids.
  await doPut(doInst, 'evt-revive', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: [], revivedSids: ['R1|Alice|Bob|0']
  });
  const { data: revived } = await doGet(doInst, 'evt-revive');
  assert.ok(
    (revived.beyResults || []).some(e => e.player === 'Alice'),
    'revivedSids must let the intentional re-import persist'
  );
  // The tombstone for that sid is cleared (revived), so it is not re-emitted.
  assert.ok(
    !(revived.beyResults || []).some(e => e._tombstone === true && e._matchSid === 'R1|Alice|Bob|0'),
    'reviving a sid must clear its tombstone'
  );
});

test('revivedSids is scoped — other tombstones survive a revive (DO path)', async () => {
  const doInst = await makeDO();

  // Seed two matches.
  await doPut(doInst, 'evt-revive-scope', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Carol', round: 'R1', _matchSid: 'R1|Carol|Dave|0', builds: [] },
      { player: 'Dave',  round: 'R1', _matchSid: 'R1|Carol|Dave|0', builds: [] }
    ],
    mergeMode: true
  });

  // Delete BOTH — two active tombstones.
  await doPut(doInst, 'evt-revive-scope', {
    deletedSids: ['R1|Alice|Bob|0', 'R1|Carol|Dave|0'], mergeMode: true
  });

  // Revive ONLY Alice/Bob; a stale device re-pushes Carol/Dave in the same PUT.
  await doPut(doInst, 'evt-revive-scope', {
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Carol', round: 'R1', _matchSid: 'R1|Carol|Dave|0', builds: [] },
      { player: 'Dave',  round: 'R1', _matchSid: 'R1|Carol|Dave|0', builds: [] }
    ],
    mergeMode: true, deletedSids: [], revivedSids: ['R1|Alice|Bob|0']
  });

  const { data } = await doGet(doInst, 'evt-revive-scope');
  assert.ok(
    (data.beyResults || []).some(e => e.player === 'Alice'),
    'revived match (Alice/Bob) must be present'
  );
  assert.ok(
    !(data.beyResults || []).some(e => e.player === 'Carol'),
    'non-revived tombstone (Carol/Dave) must STILL block the stale re-push'
  );
});

test('revivedSids lets a re-imported match through an active tombstone (KV path)', async () => {
  const { onRequest } = await import('../../functions/api/beyresults.js');

  // KV-only world (no DO binding) with an active tombstone for Alice/Bob.
  const kv = makeKV({
    events: JSON.stringify({ events: [{
      id: 'evt-revive-kv', title: 'Revive KV',
      beyResults: [
        { _matchSid: 'R1|Alice|Bob|0', _tombstone: true, _deletedAt: Date.now() }
      ],
      builds: {}
    }] })
  });
  const env = { BEYBLADE_KV: kv, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret' };

  // Plain re-PUT stays blocked.
  let res = await onRequest(makePagesCtx(env, 'PUT', 'https://x/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret', eventId: 'evt-revive-kv',
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: []
  }));
  let body = await res.json();
  assert.ok(
    !(body.beyResults || []).some(e => e.player === 'Alice'),
    'KV: plain re-PUT must stay blocked by the tombstone'
  );

  // Re-import with revivedSids gets through.
  res = await onRequest(makePagesCtx(env, 'PUT', 'https://x/api/beyresults', {
    adminUsername: 'admin', adminPassword: 'secret', eventId: 'evt-revive-kv',
    beyResults: [
      { player: 'Alice', round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] },
      { player: 'Bob',   round: 'R1', _matchSid: 'R1|Alice|Bob|0', builds: [] }
    ],
    mergeMode: true, deletedSids: [], revivedSids: ['R1|Alice|Bob|0']
  }));
  body = await res.json();
  assert.ok(
    (body.beyResults || []).some(e => e.player === 'Alice'),
    'KV: revivedSids must let the intentional re-import persist'
  );
});

test('stable Challonge sid persists and updates even when a legacy DO ignores revivedSids', async () => {
  const { mergeBeyResults } = await import('../../workers/bey-state-do/src/merge.js');
  const legacySid = 'R1|entry-a|entry-b|0';
  const challongeSid = 'CHALLONGE|459446168';
  const tombstoned = [{
    _matchSid: legacySid,
    _tombstone: true,
    _deletedAt: Date.now()
  }];

  // Device 1 imports the open Challonge match. A legacy worker ignores the
  // revivedSids field, but the stable Challonge identity does not collide with
  // the old player-pair tombstone and therefore persists.
  const imported = mergeBeyResults(tombstoned, [
    { player: 'Alice', entryId: 'entry-a', round: 'R1', _matchSid: challongeSid, builds: [], win: false },
    { player: 'Bob', entryId: 'entry-b', round: 'R1', _matchSid: challongeSid, builds: [], win: false }
  ], []);
  assert.ok(
    imported.some(row => row._matchSid === challongeSid && row.player === 'Alice'),
    'device 2 can receive the imported match from authoritative state'
  );

  // Device 2 scores the same stable identity 5-0. The patch replaces the
  // imported rows instead of creating a duplicate or being blocked.
  const scored = mergeBeyResults(imported, [
    {
      player: 'Alice', entryId: 'entry-a', round: 'R1', _matchSid: challongeSid,
      builds: [{ finishes: ['O', 'O', 'S'] }], pointsTotal: 5, win: true, _submitted: true
    },
    {
      player: 'Bob', entryId: 'entry-b', round: 'R1', _matchSid: challongeSid,
      builds: [{ finishes: ['L', 'L', 'L'] }], pointsTotal: 0, win: false, _submitted: true
    }
  ], []);

  const alice = scored.find(row => row._matchSid === challongeSid && row.player === 'Alice');
  assert.equal(alice.pointsTotal, 5);
  assert.equal(alice.win, true);
  assert.equal(
    scored.filter(row => row._matchSid === challongeSid).length,
    2,
    'both devices converge on one match identity'
  );
  assert.ok(
    scored.some(row => row._matchSid === legacySid && row._tombstone === true),
    'the unrelated legacy tombstone remains intact'
  );
});
