// tests/challonge-import.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

test('resolveChallongeTarget: named account from CHALLONGE_ACCOUNTS', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_ACCOUNTS: JSON.stringify({
      lienathanS2: { proxyUrl: 'https://proxy.example/s2', key: 'KEY2' },
    }),
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
  };
  const t = resolveChallongeTarget(env, { account: 'lienathanS2' });
  assert.equal(t.proxyUrl, 'https://proxy.example/s2');
  assert.equal(t.key, 'KEY2');
});

test('resolveChallongeTarget: custom key overrides account', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = { CHALLONGE_PROXY_URL: 'https://proxy.example/default' };
  const t = resolveChallongeTarget(env, { customKey: 'ABC123' });
  assert.equal(t.key, 'ABC123');
  assert.equal(t.proxyUrl, 'https://proxy.example/default');
});

test('resolveChallongeTarget: unknown account returns null proxyUrl', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_ACCOUNTS: JSON.stringify({
      lienathanS2: { proxyUrl: 'https://proxy.example/s2', key: 'KEY2' },
    }),
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
  };
  const t = resolveChallongeTarget(env, { account: 'nonexistent' });
  assert.equal(t.proxyUrl, null);
});

test('resolveChallongeTarget: falls back to season URLs', async () => {
  const { resolveChallongeTarget } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
  const env = {
    CHALLONGE_PROXY_URL: 'https://proxy.example/default',
    CHALLONGE_PROXY_URL_S3: 'https://proxy.example/s3',
  };
  assert.equal(resolveChallongeTarget(env, { season: '3' }).proxyUrl, 'https://proxy.example/s3');
  assert.equal(resolveChallongeTarget(env, { season: '2' }).proxyUrl, 'https://proxy.example/default');
});

async function importChallongeApi() {
  return import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'challonge.js').replace(/\\/g, '/')
  );
}

test('onRequest: list with explicit customKey hits Challonge API directly', async () => {
  const { onRequest } = await importChallongeApi();
  const origFetch = global.fetch;
  let calledUrl = '';
  global.fetch = async (u) => { calledUrl = String(u); return new Response('[]', { status: 200 }); };
  try {
    const request = new Request('https://example.com/api/challonge?action=list&customKey=MYKEY&season=2');
    const res = await onRequest({ request, env: { CHALLONGE_PROXY_URL: 'https://proxy.example/default' } });
    assert.equal(res.status, 200);
    assert.match(calledUrl, /^https:\/\/api\.challonge\.com\/v1\/tournaments\.json/);
    assert.match(calledUrl, /api_key=MYKEY/);
    assert.match(calledUrl, /state=all/);
  } finally {
    global.fetch = origFetch;
  }
});

test('onRequest: list without customKey uses the proxy (unchanged behaviour)', async () => {
  const { onRequest } = await importChallongeApi();
  const origFetch = global.fetch;
  let calledUrl = '';
  global.fetch = async (u) => { calledUrl = String(u); return new Response('[]', { status: 200 }); };
  try {
    const request = new Request('https://example.com/api/challonge?action=list&season=2');
    const res = await onRequest({ request, env: { CHALLONGE_PROXY_URL: 'https://proxy.example/default' } });
    assert.equal(res.status, 200);
    assert.equal(calledUrl, 'https://proxy.example/default/challonge/tournaments.json?state=all&per_page=50');
  } finally {
    global.fetch = origFetch;
  }
});

test('onRequest: matches with customKey hits Challonge directly and preserves {match} shape', async () => {
  const { onRequest } = await importChallongeApi();
  const origFetch = global.fetch;
  let calledUrl = '';
  global.fetch = async (u) => { calledUrl = String(u); return new Response('[{"match":{"id":1,"state":"open"}}]', { status: 200 }); };
  try {
    const request = new Request('https://example.com/api/challonge?action=matches&tournament_id=beyblade33123&customKey=MYKEY&season=2');
    const res = await onRequest({ request, env: { CHALLONGE_PROXY_URL: 'https://proxy.example/default' } });
    assert.equal(res.status, 200);
    assert.match(calledUrl, /api\.challonge\.com\/v1\/tournaments\/beyblade33123\/matches\.json/);
    assert.match(calledUrl, /api_key=MYKEY/);
    const body = await res.json();
    assert.equal(body[0].match.id, 1);
  } finally {
    global.fetch = origFetch;
  }
});

const fs = require('node:fs');
const vm = require('node:vm');

function loadChallongeHelpers() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const start = html.indexOf('// === CHALLONGE-HELPERS START ===');
  const end = html.indexOf('// === CHALLONGE-HELPERS END ===');
  assert.notEqual(start, -1, 'Missing CHALLONGE-HELPERS START marker');
  assert.notEqual(end, -1, 'Missing CHALLONGE-HELPERS END marker');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

test('matchSoloParticipant: exact and case-insensitive', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  const players = [
    { name: 'Ken', displayLabel: 'Ken', entryId: 'e-ken', entryType: 'main' },
    { name: 'Lienathan', displayLabel: 'Lienathan', entryId: 'e-lien-1', entryType: 'main' },
    { name: 'Lienathan', displayLabel: 'Lienathan (DE)', entryId: 'e-lien-2', entryType: 'double' },
  ];
  assert.equal(matchSoloParticipant('Ken', players).entryId, 'e-ken');
  assert.equal(matchSoloParticipant('ken', players).entryId, 'e-ken');
});

test('matchSoloParticipant: DE trailing-number rule', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  const players = [
    { name: 'Lienathan', displayLabel: 'Lienathan', entryId: 'e-lien-1', entryType: 'main' },
    { name: 'Lienathan', displayLabel: 'Lienathan (DE)', entryId: 'e-lien-2', entryType: 'double' },
  ];
  assert.equal(matchSoloParticipant('Lienathan 1', players).entryId, 'e-lien-1');
  assert.equal(matchSoloParticipant('Lienathan 2', players).entryId, 'e-lien-2');
});

test('matchSoloParticipant: returns null when no match', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  assert.equal(matchSoloParticipant('Nobody', [{ name: 'Ken', displayLabel: 'Ken', entryId: 'e', entryType: 'main' }]), null);
});

test('matchTeamParticipant: exact then case-insensitive', () => {
  const { matchTeamParticipant } = loadChallongeHelpers();
  const teams = [{ teamName: 'Dragon Squad' }, { teamName: 'Phoenix' }];
  assert.equal(matchTeamParticipant('Dragon Squad', teams).teamName, 'Dragon Squad');
  assert.equal(matchTeamParticipant('phoenix', teams).teamName, 'Phoenix');
  assert.equal(matchTeamParticipant('Nope', teams), null);
});

test('challongeRoundLabel maps positive round to R{n}', () => {
  const { challongeRoundLabel } = loadChallongeHelpers();
  assert.equal(challongeRoundLabel(1), 'R1');
  assert.equal(challongeRoundLabel(3), 'R3');
});

test('isSameOwnerSolo true for same base name different entries', () => {
  const { isSameOwnerSolo } = loadChallongeHelpers();
  const a = { name: 'Lienathan', entryId: 'e1', entryType: 'main' };
  const b = { name: 'Lienathan', entryId: 'e2', entryType: 'double' };
  assert.equal(isSameOwnerSolo(a, b), true);
  assert.equal(isSameOwnerSolo(a, { name: 'Ken', entryId: 'e3', entryType: 'main' }), false);
});

test('alreadyImported detects existing challonge match id', () => {
  const { alreadyImported } = loadChallongeHelpers();
  const state = [{ id: 1, _challongeMatchId: 555 }, { id: 2 }];
  assert.equal(alreadyImported(state, 555), true);
  assert.equal(alreadyImported(state, 999), false);
});

test('buildImportPlan: imports open matches, skips non-open and duplicates; DE self-match imports as de-self', () => {
  const { buildImportPlan } = loadChallongeHelpers();
  const pidMap = {
    10: { name: 'Ken',       entryId: 'eK',  entryType: 'main' },
    11: { name: 'Mia',       entryId: 'eM',  entryType: 'main' },
    12: { name: 'Lienathan', entryId: 'eL1', entryType: 'main' },
    13: { name: 'Lienathan', entryId: 'eL2', entryType: 'double' },
  };
  const matches = [
    { match: { id: 100, state: 'open',    round: 1, player1_id: 10, player2_id: 11, group_id: null } },
    { match: { id: 101, state: 'pending', round: 1, player1_id: null, player2_id: null } },
    { match: { id: 102, state: 'open',    round: 1, player1_id: 12, player2_id: 13 } }, // DE self-match
    { match: { id: 103, state: 'open',    round: 1, player1_id: 10, player2_id: 11 } }, // dup of existing
  ];
  const matchesState = [{ id: 9, _challongeMatchId: 103 }];
  const plan = buildImportPlan({ matches, pidMap, matchesState, isTeam: false });
  const creates = plan.filter(p => !p.skip);
  // 100 (Ken vs Mia) and 102 (Lienathan DE self-match) should both be created
  assert.equal(creates.length, 2);
  assert.ok(creates.some(p => p.challongeMatchId === 100), 'Ken vs Mia must be created');
  assert.ok(creates.some(p => p.challongeMatchId === 102), 'DE self-match must be created');
  const deEntry = plan.find(p => p.challongeMatchId === 102);
  assert.equal(deEntry.skip,        false,    'DE self-match must not be skipped');
  assert.equal(deEntry.reason,      'de-self', 'DE self-match reason must be de-self');
  assert.equal(deEntry.deSelfMatch, true);
  // Ken vs Mia
  const kenMia = creates.find(p => p.challongeMatchId === 100);
  assert.equal(kenMia.round, 'R1');
  assert.equal(kenMia.side1Ref.entryId, 'eK');
  // 101 skipped (not open), 103 skipped (dup)
  assert.equal(plan.find(p => p.challongeMatchId === 103).reason, 'duplicate');
});

test('eventPointsToScoresCsv: p1 wins', () => {
  const { eventPointsToScoresCsv } = loadChallongeHelpers();
  const result = eventPointsToScoresCsv(5, 3, 10, 10, 11);
  assert.equal(result.scores_csv, '5-3');
  assert.equal(result.winner_id, 10);
});

test('eventPointsToScoresCsv: p2 wins', () => {
  const { eventPointsToScoresCsv } = loadChallongeHelpers();
  const result = eventPointsToScoresCsv(2, 7, 11, 10, 11);
  assert.equal(result.scores_csv, '7-2');
  assert.equal(result.winner_id, 11);
});

test('eventPointsToScoresCsv: equal points, p1 wins', () => {
  const { eventPointsToScoresCsv } = loadChallongeHelpers();
  const result = eventPointsToScoresCsv(4, 4, 10, 10, 11);
  assert.equal(result.scores_csv, '4-4');
  assert.equal(result.winner_id, 10);
});

test('eventPointsToScoresCsv: null winnerId fallback (pts decides order)', () => {
  const { eventPointsToScoresCsv } = loadChallongeHelpers();
  const result = eventPointsToScoresCsv(6, 2, null, 10, 11);
  assert.equal(result.scores_csv, '6-2');
  assert.equal(result.winner_id, 'tie');
});

test('eventPointsToScoresCsv: zero-zero tie', () => {
  const { eventPointsToScoresCsv } = loadChallongeHelpers();
  const result = eventPointsToScoresCsv(0, 0, 11, 10, 11);
  assert.equal(result.scores_csv, '0-0');
  assert.equal(result.winner_id, 11);
});

// soloSlotLabel tests
test('soloSlotLabel: lone player (no DE) keeps plain name', () => {
  const { soloSlotLabel } = loadChallongeHelpers();
  const joiners = [
    { name: 'Ken', entryType: 'main', entryId: 'e-ken' },
  ];
  assert.equal(soloSlotLabel(joiners[0], joiners), 'Ken');
});

test('soloSlotLabel: DE pair — main gets 1, double gets 2', () => {
  const { soloSlotLabel } = loadChallongeHelpers();
  const joiners = [
    { name: 'Lienathan', entryType: 'main',   entryId: 'e-lien-1' },
    { name: 'Lienathan', entryType: 'double',  entryId: 'e-lien-2' },
  ];
  assert.equal(soloSlotLabel(joiners[0], joiners), 'Lienathan 1');
  assert.equal(soloSlotLabel(joiners[1], joiners), 'Lienathan 2');
});

test('soloSlotLabel: legacy main (no entryType) in DE pair gets 1', () => {
  const { soloSlotLabel } = loadChallongeHelpers();
  const joiners = [
    { name: 'OldPlayer', entryId: 'e-old' },                                    // legacy, no entryType
    { name: 'OldPlayer', entryType: 'double', entryId: 'e-old-de' },
  ];
  assert.equal(soloSlotLabel(joiners[0], joiners), 'OldPlayer 1');
  assert.equal(soloSlotLabel(joiners[1], joiners), 'OldPlayer 2');
});

test('soloSlotLabel: mixed roster — numbered pair, plain lone player', () => {
  const { soloSlotLabel } = loadChallongeHelpers();
  const joiners = [
    { name: 'Ken',       entryType: 'main',   entryId: 'e-ken' },
    { name: 'Lienathan', entryType: 'main',   entryId: 'e-lien-1' },
    { name: 'Lienathan', entryType: 'double',  entryId: 'e-lien-2' },
  ];
  assert.equal(soloSlotLabel(joiners[0], joiners), 'Ken');
  assert.equal(soloSlotLabel(joiners[1], joiners), 'Lienathan 1');
  assert.equal(soloSlotLabel(joiners[2], joiners), 'Lienathan 2');
});

test('soloSlotLabel round-trip: labels resolve back to correct entryId via matchSoloParticipant', () => {
  const { soloSlotLabel, matchSoloParticipant } = loadChallongeHelpers();
  const joiners = [
    { name: 'Lienathan', entryType: 'main',   entryId: 'e-lien-1' },
    { name: 'Lienathan', entryType: 'double',  entryId: 'e-lien-2' },
  ];
  // Simulate what getPlayers() will return after adding displayLabel via soloSlotLabel
  const players = joiners.map(j => ({ ...j, displayLabel: soloSlotLabel(j, joiners) }));
  assert.equal(matchSoloParticipant('Lienathan 1', players).entryId, 'e-lien-1');
  assert.equal(matchSoloParticipant('Lienathan 2', players).entryId, 'e-lien-2');
});

// ─────────────────────────────────────────────────────────────────────────────
// isDeSelfMatch — discriminates legit DE self-matches from true duplicates
// ─────────────────────────────────────────────────────────────────────────────

test('isDeSelfMatch: true for same name, different entryId (legit DE pairing)', () => {
  const { isDeSelfMatch } = loadChallongeHelpers();
  const main   = { name: 'VG.GAV X', entryId: 'e-main',   entryType: 'main' };
  const double = { name: 'VG.GAV X', entryId: 'e-double', entryType: 'double' };
  assert.equal(isDeSelfMatch(main, double), true);
});

test('isDeSelfMatch: false when entryIds match (true duplicate mistake)', () => {
  const { isDeSelfMatch } = loadChallongeHelpers();
  const a = { name: 'VG.GAV X', entryId: 'e-same', entryType: 'main' };
  const b = { name: 'VG.GAV X', entryId: 'e-same', entryType: 'main' };
  assert.equal(isDeSelfMatch(a, b), false);
});

test('isDeSelfMatch: false for different names', () => {
  const { isDeSelfMatch } = loadChallongeHelpers();
  const a = { name: 'Ken', entryId: 'e-ken', entryType: 'main' };
  const b = { name: 'Mia', entryId: 'e-mia', entryType: 'main' };
  assert.equal(isDeSelfMatch(a, b), false);
});

test('isDeSelfMatch: false when entryId is missing on either side', () => {
  const { isDeSelfMatch } = loadChallongeHelpers();
  assert.equal(isDeSelfMatch({ name: 'VG.GAV X', entryId: null },    { name: 'VG.GAV X', entryId: 'e-double' }), false);
  assert.equal(isDeSelfMatch({ name: 'VG.GAV X', entryId: 'e-main' }, { name: 'VG.GAV X', entryId: null }),    false);
});

test('isDeSelfMatch: works with player property (match-slot objects from createMatch)', () => {
  const { isDeSelfMatch } = loadChallongeHelpers();
  // nmSelectPlayer stores the name under 'player', not 'name'
  const slot1 = { player: 'Lienathan', entryId: 'eL1', entryType: 'main' };
  const slot2 = { player: 'Lienathan', entryId: 'eL2', entryType: 'double' };
  assert.equal(isDeSelfMatch(slot1, slot2), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildImportPlan — DE pair must import as 'de-self', not be skipped
// ─────────────────────────────────────────────────────────────────────────────

test('buildImportPlan: DE pair (same name, different entryId) imports as de-self, not skipped', () => {
  const { buildImportPlan } = loadChallongeHelpers();
  const pidMap = {
    12: { name: 'Lienathan', entryId: 'eL1', entryType: 'main' },
    13: { name: 'Lienathan', entryId: 'eL2', entryType: 'double' },
  };
  const matches = [
    { match: { id: 102, state: 'open', round: 1, player1_id: 12, player2_id: 13, group_id: null } },
  ];
  const plan = buildImportPlan({ matches, pidMap, matchesState: [], isTeam: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].skip, false, 'DE self-match must not be skipped');
  assert.equal(plan[0].reason, 'de-self');
  assert.equal(plan[0].deSelfMatch, true);
});

test('buildImportPlan: true same-entryId pair is still blocked as same-owner', () => {
  const { buildImportPlan } = loadChallongeHelpers();
  const pidMap = {
    12: { name: 'Lienathan', entryId: 'eL1', entryType: 'main' },
    13: { name: 'Lienathan', entryId: 'eL1', entryType: 'main' }, // same entryId — mistake
  };
  const matches = [
    { match: { id: 102, state: 'open', round: 1, player1_id: 12, player2_id: 13, group_id: null } },
  ];
  const plan = buildImportPlan({ matches, pidMap, matchesState: [], isTeam: false });
  assert.equal(plan[0].skip, true);
  assert.equal(plan[0].reason, 'same-owner');
});

test('challongeImportSignature: order-independent (A,B) === (B,A)', () => {
  const { challongeImportSignature } = loadChallongeHelpers();
  const s1 = challongeImportSignature('R1', { entryId: 'eA' }, { entryId: 'eB' }, false);
  const s2 = challongeImportSignature('R1', { entryId: 'eB' }, { entryId: 'eA' }, false);
  assert.equal(s1, s2, 'signature must be order-independent');
});

test('buildImportPlan: legacy match (no _challongeMatchId) blocks duplicate import by signature', () => {
  const { buildImportPlan } = loadChallongeHelpers();

  // 21 real existing matches — one per pair, no _challongeMatchId (legacy data)
  const matchesState = [
    { round: 'R1', p1: { entryId: 'eA' }, p2: { entryId: 'eB' } },  // no _challongeMatchId
  ];
  const pidMap = { 1: { entryId: 'eA' }, 2: { entryId: 'eB' } };
  const matches = [{ match: { id: 42, state: 'open', round: 1, player1_id: 1, player2_id: 2 } }];

  const plan = buildImportPlan({ matches, pidMap, matchesState, isTeam: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].skip, true, 'legacy match must block duplicate import by signature');
  assert.equal(plan[0].reason, 'duplicate-sig');
});

test('buildImportPlan: signature suppresses only one slot; second identical Challonge match still imports', () => {
  const { buildImportPlan } = loadChallongeHelpers();

  // One local legacy match, two Challonge matches with same pair (rematch scenario)
  const matchesState = [
    { round: 'R1', p1: { entryId: 'eA' }, p2: { entryId: 'eB' } },  // one existing slot
  ];
  const pidMap = { 1: { name: 'Alice', entryId: 'eA' }, 2: { name: 'Bob', entryId: 'eB' } };
  const matches = [
    { match: { id: 42, state: 'open', round: 1, player1_id: 1, player2_id: 2 } },
    { match: { id: 43, state: 'open', round: 1, player1_id: 1, player2_id: 2 } },
  ];

  const plan = buildImportPlan({ matches, pidMap, matchesState, isTeam: false });
  assert.equal(plan.length, 2);
  const skipped = plan.filter(p => p.skip);
  const created = plan.filter(p => !p.skip);
  assert.equal(skipped.length, 1, 'only one slot consumed — one suppressed');
  assert.equal(created.length, 1, 'second match still imports');
});

test('buildImportPlan: DE pair with no local match still imports as de-self', () => {
  const { buildImportPlan } = loadChallongeHelpers();

  // No existing local matches at all
  const matchesState = [];
  const pidMap = {
    1: { entryId: 'eL1', name: 'Lienathan' },
    2: { entryId: 'eL2', name: 'Lienathan' },
  };
  const matches = [{ match: { id: 99, state: 'open', round: 1, player1_id: 1, player2_id: 2 } }];

  const plan = buildImportPlan({ matches, pidMap, matchesState, isTeam: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].skip, false, 'DE pair must not be skipped');
  assert.equal(plan[0].reason, 'de-self');
});
