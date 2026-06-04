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

test('buildImportPlan: imports open matches, skips non-open and duplicates', () => {
  const { buildImportPlan } = loadChallongeHelpers();
  const pidMap = {
    10: { name: 'Ken', entryId: 'eK', entryType: 'main' },
    11: { name: 'Mia', entryId: 'eM', entryType: 'main' },
    12: { name: 'Lienathan', entryId: 'eL1', entryType: 'main' },
    13: { name: 'Lienathan', entryId: 'eL2', entryType: 'double' },
  };
  const matches = [
    { match: { id: 100, state: 'open', round: 1, player1_id: 10, player2_id: 11, group_id: null } },
    { match: { id: 101, state: 'pending', round: 1, player1_id: null, player2_id: null } },
    { match: { id: 102, state: 'open', round: 1, player1_id: 12, player2_id: 13 } }, // same owner
    { match: { id: 103, state: 'open', round: 1, player1_id: 10, player2_id: 11 } }, // dup of existing
  ];
  const matchesState = [{ id: 9, _challongeMatchId: 103 }];
  const plan = buildImportPlan({ matches, pidMap, matchesState, isTeam: false });
  const create = plan.filter(p => !p.skip);
  assert.equal(create.length, 1);
  assert.equal(create[0].challongeMatchId, 100);
  assert.equal(create[0].round, 'R1');
  assert.equal(create[0].side1Ref.entryId, 'eK');
  // 101 skipped (not open), 102 skipped (same owner), 103 skipped (dup)
  assert.equal(plan.find(p => p.challongeMatchId === 102).reason, 'same-owner');
  assert.equal(plan.find(p => p.challongeMatchId === 103).reason, 'duplicate');
});
