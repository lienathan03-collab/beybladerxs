const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const FN_PATH = 'file://' + path.join(__dirname, '..', 'functions', 'api', '_shared', 'events-ops.js').replace(/\\/g, '/');
const DO_PATH = 'file://' + path.join(__dirname, '..', 'workers', 'bey-state-do', 'src', 'events-ops.js').replace(/\\/g, '/');

async function load() {
  const { applyEventsAction } = await import(FN_PATH);
  return applyEventsAction;
}

function baseBlob() {
  return {
    events: [
      { id: 'e1', title: 'Cup', type: 'solo', joiners: [
        { entryId: 'a', entryType: 'main', username: 'alice', name: 'Alice', displayLabel: 'Alice' }
      ], beyResults: [{ round: 'R1', player: 'Alice' }], builds: { Alice: ['X'] }, purgedOwners: ['ghost'] },
      { id: 'e2', title: 'Teams', type: '3v3', joiners: [] }
    ]
  };
}

// ── replace_events: the core C-3 fix ───────────────────────────────────────────
test('replace_events preserves server joiners/beyResults/builds against a stale snapshot', async () => {
  const apply = await load();
  const blob = baseBlob();
  // Stale admin snapshot: e1 with NO joiners and only a title edit; e2 unchanged.
  const staleSnapshot = [
    { id: 'e1', title: 'Cup (renamed)', type: 'solo', joiners: [], beyResults: [], builds: {} },
    { id: 'e2', title: 'Teams', type: '3v3', joiners: [] }
  ];
  const res = apply(blob, 'replace_events', { events: staleSnapshot });
  assert.equal(res.status, 200);
  const e1 = blob.events.find(e => e.id === 'e1');
  assert.equal(e1.title, 'Cup (renamed)', 'metadata edit applied');
  assert.equal(e1.joiners.length, 1, 'server joiners preserved, not wiped');
  assert.equal(e1.joiners[0].username, 'alice');
  assert.equal(e1.beyResults.length, 1, 'server beyResults preserved');
  assert.deepEqual(e1.builds, { Alice: ['X'] }, 'server builds preserved');
  assert.deepEqual(e1.purgedOwners, ['ghost'], 'purgedOwners preserved');
});

test('replace_events honors add and delete of events', async () => {
  const apply = await load();
  const blob = baseBlob();
  // Drop e2, add e3.
  const snapshot = [
    { id: 'e1', title: 'Cup', type: 'solo' },
    { id: 'e3', title: 'New', type: 'solo', joiners: [] }
  ];
  apply(blob, 'replace_events', { events: snapshot });
  const ids = blob.events.map(e => e.id);
  assert.deepEqual(ids, ['e1', 'e3']);
  assert.equal(blob.events.find(e => e.id === 'e1').joiners.length, 1, 'kept e1 joiners');
});

test('replace_events rejects non-array', async () => {
  const apply = await load();
  const res = apply(baseBlob(), 'replace_events', { events: null });
  assert.equal(res.status, 400);
});

// ── join ────────────────────────────────────────────────────────────────────
test('join appends a solo joiner; duplicate username is 409', async () => {
  const apply = await load();
  const blob = baseBlob();
  const ok = apply(blob, 'join', { eventId: 'e1', username: 'bob', playerName: 'Bob' });
  assert.equal(ok.status, 200);
  assert.equal(blob.events[0].joiners.length, 2);
  const dup = apply(blob, 'join', { eventId: 'e1', username: 'bob', playerName: 'Bob' });
  assert.equal(dup.status, 409);
});

test('join on missing event is 404', async () => {
  const apply = await load();
  const res = apply(baseBlob(), 'join', { eventId: 'nope', username: 'x', playerName: 'X' });
  assert.equal(res.status, 404);
});

// ── team_add ──────────────────────────────────────────────────────────────────
test('team_add appends a team; duplicate team name is 409; validates members/name', async () => {
  const apply = await load();
  const blob = baseBlob();
  const ok = apply(blob, 'team_add', { eventId: 'e2', teamName: 'Dragons', members: [{ displayName: 'M1' }, { displayName: 'M2' }] });
  assert.equal(ok.status, 200);
  const t = blob.events[1].joiners[0];
  assert.equal(t.type, 'team');
  assert.equal(t.teamName, 'Dragons');
  assert.equal(t.members.length, 2);

  const dup = apply(blob, 'team_add', { eventId: 'e2', teamName: 'dragons', members: [{ displayName: 'A' }, { displayName: 'B' }] });
  assert.equal(dup.status, 409);

  const tooFew = apply(blob, 'team_add', { eventId: 'e2', teamName: 'Solo', members: [{ displayName: 'A' }] });
  assert.equal(tooFew.status, 400);

  const badName = apply(blob, 'team_add', { eventId: 'e2', teamName: 'Bad<script>', members: [{ displayName: 'A' }, { displayName: 'B' }] });
  assert.equal(badName.status, 400);
});

// ── de_add / de_remove ────────────────────────────────────────────────────────
test('de_add then de_remove for a main joiner', async () => {
  const apply = await load();
  const blob = baseBlob();
  const add = apply(blob, 'de_add', { eventId: 'e1', username: 'alice', canonicalName: 'Alice' });
  assert.equal(add.status, 200);
  assert.equal(blob.events[0].joiners.filter(j => j.entryType === 'double').length, 1);
  const dupDe = apply(blob, 'de_add', { eventId: 'e1', username: 'alice', canonicalName: 'Alice' });
  assert.equal(dupDe.status, 409);
  const rm = apply(blob, 'de_remove', { eventId: 'e1', username: 'alice' });
  assert.equal(rm.status, 200);
  assert.equal(blob.events[0].joiners.filter(j => j.entryType === 'double').length, 0);
});

test('de_add refused on a 3v3 event', async () => {
  const apply = await load();
  const blob = baseBlob();
  const res = apply(blob, 'de_add', { eventId: 'e2', username: 'x', canonicalName: 'X' });
  assert.equal(res.status, 400);
});

// ── unjoin cascade ────────────────────────────────────────────────────────────
test('unjoin removes the main entry and its linked DE', async () => {
  const apply = await load();
  const blob = baseBlob();
  apply(blob, 'de_add', { eventId: 'e1', username: 'alice', canonicalName: 'Alice' });
  assert.equal(blob.events[0].joiners.length, 2);
  const res = apply(blob, 'unjoin', { eventId: 'e1', username: 'alice' });
  assert.equal(res.status, 200);
  assert.equal(blob.events[0].joiners.length, 0, 'main + DE both removed');
});

// ── admin_add / admin_remove ──────────────────────────────────────────────────
test('admin_add appends a manual joiner; admin_remove by index removes it', async () => {
  const apply = await load();
  const blob = baseBlob();
  apply(blob, 'admin_add', { eventId: 'e1', name: 'Walkin' });
  assert.equal(blob.events[0].joiners.length, 2);
  const idx = blob.events[0].joiners.findIndex(j => j.name === 'Walkin');
  const res = apply(blob, 'admin_remove', { eventId: 'e1', joinerIdx: idx, force: true });
  assert.equal(res.status, 200);
  assert.equal(blob.events[0].joiners.some(j => j.name === 'Walkin'), false);
});

test('admin_remove out-of-range index is 400', async () => {
  const apply = await load();
  const res = apply(baseBlob(), 'admin_remove', { eventId: 'e1', joinerIdx: 99 });
  assert.equal(res.status, 400);
});

// ── challonge_update ──────────────────────────────────────────────────────────
test('challonge_update sets allowed fields and deletes on null', async () => {
  const apply = await load();
  const blob = baseBlob();
  apply(blob, 'challonge_update', { eventId: 'e1', challongeMetadata: { challongeTournamentId: 'T1', challongeAccount: 'acct' } });
  assert.equal(blob.events[0].challongeTournamentId, 'T1');
  assert.equal(blob.events[0].challongeAccount, 'acct');
  apply(blob, 'challonge_update', { eventId: 'e1', challongeMetadata: { challongeTournamentId: null } });
  assert.equal('challongeTournamentId' in blob.events[0], false, 'null deletes the field');
});

// ── unknown action ────────────────────────────────────────────────────────────
test('unknown action returns 400', async () => {
  const apply = await load();
  const res = apply(baseBlob(), 'nope', { eventId: 'e1' });
  assert.equal(res.status, 400);
});

// ── parity: Pages copy and DO copy behave identically ─────────────────────────
test('functions copy and DO copy produce identical results', async () => {
  const { applyEventsAction: fn } = await import(FN_PATH);
  const { applyEventsAction: doFn } = await import(DO_PATH);
  const cases = [
    ['join', { eventId: 'e1', username: 'bob', playerName: 'Bob' }],
    ['admin_add', { eventId: 'e1', name: 'Z' }],
    ['team_add', { eventId: 'e2', teamName: 'Dragons', members: [{ displayName: 'M1' }, { displayName: 'M2' }] }],
    ['challonge_update', { eventId: 'e1', challongeMetadata: { challongeAccount: 'x' } }],
  ];
  for (const [op, params] of cases) {
    const a = baseBlob(); const b = baseBlob();
    const ra = fn(a, op, params);
    const rb = doFn(b, op, params);
    assert.equal(ra.status, rb.status, `status parity for ${op}`);
    // Compare resulting joiner counts / patched fields (ignore random entryId/joinedAt).
    assert.equal(a.events[0].joiners.length, b.events[0].joiners.length, `joiner-count parity ${op}`);
    assert.equal(a.events[1].joiners.length, b.events[1].joiners.length, `joiner-count parity e2 ${op}`);
  }
});
