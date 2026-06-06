// tests/challonge-roster-mapping.test.js
// Regression tests for the stale Double Entry roster and incorrect Challonge
// participant mapping bugs.
//
// Root causes fixed:
//   1. matchSoloParticipant fell back to sameName[0] when no DE slot exists.
//   2. challongeBuildParticipantMap skipped existing map entries — never repaired stale ones.
//   3. saveChallongeMetadata ignored data.event.joiners — joiners not refreshed after metadata save.
//   4. No detection of two Challonge participant IDs mapping to the same solo entryId.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
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

// ─────────────────────────────────────────────────────────────────────────────
// matchSoloParticipant: "Name 2" with only main entry must return null
// ─────────────────────────────────────────────────────────────────────────────

test('matchSoloParticipant: "Cheyanne 2" with only main roster entry returns null', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  const players = [
    { name: 'Cheyanne', displayLabel: 'Cheyanne', entryId: 'e-cheyanne', entryType: 'main' },
  ];
  assert.equal(
    matchSoloParticipant('Cheyanne 2', players),
    null,
    '"Cheyanne 2" must not fall back to the main entry when no DE slot exists'
  );
});

test('matchSoloParticipant: "Cheyanne 1" with only main entry resolves to main', () => {
  const { matchSoloParticipant } = loadChallongeHelpers();
  const players = [
    { name: 'Cheyanne', displayLabel: 'Cheyanne', entryId: 'e-cheyanne', entryType: 'main' },
  ];
  assert.equal(
    matchSoloParticipant('Cheyanne 1', players).entryId,
    'e-cheyanne',
    '"Cheyanne 1" with only a main entry should still resolve to it'
  );
});

test('matchSoloParticipant: fresh main and DE entries map "Cheyanne 1" and "Cheyanne 2" to different entryIds', () => {
  const { matchSoloParticipant, soloSlotLabel } = loadChallongeHelpers();
  const joiners = [
    { name: 'Cheyanne', entryType: 'main',   entryId: 'e-cheyanne-main' },
    { name: 'Cheyanne', entryType: 'double',  entryId: 'e-cheyanne-de' },
  ];
  const players = joiners.map(j => ({ ...j, displayLabel: soloSlotLabel(j, joiners) }));
  assert.equal(matchSoloParticipant('Cheyanne 1', players).entryId, 'e-cheyanne-main');
  assert.equal(matchSoloParticipant('Cheyanne 2', players).entryId, 'e-cheyanne-de');
});

// ─────────────────────────────────────────────────────────────────────────────
// buildParticipantMapCore — stale map repair, manual preservation, duplicates
// ─────────────────────────────────────────────────────────────────────────────

test('buildParticipantMapCore: stale map where both participant IDs point to main entry is repaired', () => {
  const { buildParticipantMapCore, soloSlotLabel } = loadChallongeHelpers();
  const joiners = [
    { name: 'Cheyanne', entryType: 'main',   entryId: 'e-cheyanne-main' },
    { name: 'Cheyanne', entryType: 'double',  entryId: 'e-cheyanne-de' },
  ];
  const players = joiners.map(j => ({ ...j, displayLabel: soloSlotLabel(j, joiners) }));
  // Stale map: both Challonge participants point to the main entryId
  const staleMap = {
    10: { name: 'Cheyanne', entryId: 'e-cheyanne-main', entryType: 'main', displayLabel: 'Cheyanne 1' },
    11: { name: 'Cheyanne', entryId: 'e-cheyanne-main', entryType: 'main', displayLabel: 'Cheyanne 1' },
  };
  const participants = [
    { id: 10, display_name: 'Cheyanne 1' },
    { id: 11, display_name: 'Cheyanne 2' },
  ];
  const { map, unmatched } = buildParticipantMapCore({
    participants, players, teams: null, existingMap: staleMap, isTeam: false,
  });
  assert.equal(map[10].entryId, 'e-cheyanne-main', 'participant 10 → main entry');
  assert.equal(map[11].entryId, 'e-cheyanne-de',   'participant 11 repaired → DE entry');
  assert.equal(unmatched.length, 0, 'no unmatched entries after repair');
});

test('buildParticipantMapCore: two auto-mapped participants to same entryId are flagged as duplicates', () => {
  const { buildParticipantMapCore } = loadChallongeHelpers();
  // Only a main entry exists — two Challonge participants both map to it
  const players = [
    { name: 'Ken', displayLabel: 'Ken', entryId: 'e-ken', entryType: 'main' },
  ];
  const participants = [
    { id: 10, display_name: 'Ken' },
    { id: 11, display_name: 'Ken' },
  ];
  const { map, unmatched, hasDuplicates } = buildParticipantMapCore({
    participants, players, teams: null, existingMap: {}, isTeam: false,
  });
  assert.equal(hasDuplicates, true, 'duplicate mapping must be detected');
  assert.equal(Object.keys(map).length, 0, 'both duplicate entries removed from map');
  assert.equal(unmatched.length, 2, 'both marked as unresolved/unmatched');
});

test('hasDuplicateSoloParticipantMappings: detects persisted duplicate entryIds', () => {
  const { hasDuplicateSoloParticipantMappings } = loadChallongeHelpers();
  assert.equal(hasDuplicateSoloParticipantMappings({
    10: { entryId: 'e-main' },
    11: { entryId: 'e-main' },
  }), true);
  assert.equal(hasDuplicateSoloParticipantMappings({
    10: { entryId: 'e-main' },
    11: { entryId: 'e-de' },
  }), false);
});

test('buildParticipantMapCore: "Cheyanne 2" unresolved when no DE slot, not silently mapped to main', () => {
  const { buildParticipantMapCore, soloSlotLabel } = loadChallongeHelpers();
  const joiners = [
    { name: 'Cheyanne', entryType: 'main', entryId: 'e-cheyanne-main' },
  ];
  const players = joiners.map(j => ({ ...j, displayLabel: soloSlotLabel(j, joiners) }));
  const participants = [
    { id: 10, display_name: 'Cheyanne' },
    { id: 11, display_name: 'Cheyanne 2' },
  ];
  const { map, unmatched, hasDuplicates } = buildParticipantMapCore({
    participants, players, teams: null, existingMap: {}, isTeam: false,
  });
  // pid 10 ("Cheyanne") auto-maps to main; pid 11 ("Cheyanne 2") has no DE → null → unmatched
  assert.equal(map[10].entryId, 'e-cheyanne-main', 'pid 10 maps to main');
  assert.equal(map[11], undefined, 'pid 11 must not be silently mapped to main');
  assert.equal(unmatched.some(u => u.id === 11), true, '"Cheyanne 2" is unmatched');
  assert.equal(hasDuplicates, false, 'no duplicate since pid 11 was not mapped');
});

test('buildParticipantMapCore: valid manual mapping preserved when auto-match fails and entryId still in roster', () => {
  const { buildParticipantMapCore } = loadChallongeHelpers();
  const players = [
    { name: 'Ken', displayLabel: 'Ken', entryId: 'e-ken', entryType: 'main' },
  ];
  const existingMap = {
    99: { name: 'KennethXYZ', entryId: 'e-ken', entryType: 'main', displayLabel: 'Ken' },
  };
  const participants = [
    { id: 99, display_name: 'KennethXYZ' }, // will not auto-match "Ken"
  ];
  const { map, unmatched } = buildParticipantMapCore({
    participants, players, teams: null, existingMap, isTeam: false,
  });
  assert.equal(map[99].entryId, 'e-ken', 'valid manual mapping preserved');
  assert.equal(unmatched.length, 0, 'not unmatched when manual mapping is valid');
});

test('buildParticipantMapCore: stale manual mapping discarded when entryId no longer in roster', () => {
  const { buildParticipantMapCore } = loadChallongeHelpers();
  const players = [
    { name: 'Ken', displayLabel: 'Ken', entryId: 'e-ken', entryType: 'main' },
  ];
  const existingMap = {
    99: { name: 'Cheyanne', entryId: 'e-old-removed', entryType: 'main', displayLabel: 'Cheyanne' },
  };
  const participants = [
    { id: 99, display_name: 'CheyanneXYZ' }, // will not auto-match
  ];
  const { map, unmatched } = buildParticipantMapCore({
    participants, players, teams: null, existingMap, isTeam: false,
  });
  assert.equal(map[99], undefined, 'stale manual mapping must be discarded');
  assert.equal(unmatched.some(u => u.id === 99), true, 'participant becomes unmatched');
});

// ─────────────────────────────────────────────────────────────────────────────
// applyChallongeMetadataResponse — joiners refresh without overwriting live state
// ─────────────────────────────────────────────────────────────────────────────

test('applyChallongeMetadataResponse: refreshes joiners from server without overwriting builds or beyResults', () => {
  const { applyChallongeMetadataResponse } = loadChallongeHelpers();
  const currentEvent = {
    id: 'evt-1',
    builds: { alice: ['Build A'] },
    beyResults: [{ player: 'alice', round: 'R1' }],
    joiners: [{ name: 'Alice', entryType: 'main', entryId: 'e-alice' }],
    challongeParticipantMap: {},
  };
  const allEvents = [currentEvent];
  const patch = { challongeParticipantMap: { 10: { name: 'Alice', entryId: 'e-alice' } } };
  const serverEvent = {
    id: 'evt-1',
    builds: {},        // server may return stale/empty — must NOT overwrite
    beyResults: [],    // server may return stale/empty — must NOT overwrite
    joiners: [
      { name: 'Alice', entryType: 'main',   entryId: 'e-alice' },
      { name: 'Alice', entryType: 'double', entryId: 'e-alice-de' }, // newly added DE slot
    ],
    challongeParticipantMap: { 10: { name: 'Alice', entryId: 'e-alice' } },
  };

  applyChallongeMetadataResponse(currentEvent, allEvents, patch, serverEvent);

  assert.equal(currentEvent.joiners.length, 2, 'joiners refreshed — new DE slot present');
  assert.equal(currentEvent.joiners[1].entryId, 'e-alice-de', 'DE slot has correct entryId');
  assert.deepEqual(currentEvent.builds,     { alice: ['Build A'] }, 'builds not overwritten');
  assert.deepEqual(currentEvent.beyResults, [{ player: 'alice', round: 'R1' }], 'beyResults not overwritten');
  assert.ok(currentEvent.challongeParticipantMap[10], 'patch metadata applied');
});

test('applyChallongeMetadataResponse: also updates matching allEvents cache entry joiners', () => {
  const { applyChallongeMetadataResponse } = loadChallongeHelpers();
  const currentEvent = {
    id: 'evt-1',
    builds: {}, beyResults: [],
    joiners: [{ name: 'Ken', entryType: 'main', entryId: 'e-ken' }],
    challongeParticipantMap: {},
  };
  // allEvents holds a separate object reference (as in production)
  const cachedEntry = { ...currentEvent, joiners: [{ name: 'Ken', entryType: 'main', entryId: 'e-ken' }] };
  const allEvents = [cachedEntry];
  const patch = { challongeTournamentId: 'tour-123' };
  const serverEvent = {
    joiners: [
      { name: 'Ken', entryType: 'main',   entryId: 'e-ken' },
      { name: 'NewPlayer', entryType: 'main', entryId: 'e-new' },
    ],
  };

  applyChallongeMetadataResponse(currentEvent, allEvents, patch, serverEvent);

  assert.equal(cachedEntry.joiners.length, 2, 'cached allEvents entry joiners also refreshed');
  assert.equal(cachedEntry.challongeTournamentId, 'tour-123', 'patch applied to cached entry');
});

test('applyChallongeMetadataResponse: handles missing serverEvent gracefully', () => {
  const { applyChallongeMetadataResponse } = loadChallongeHelpers();
  const currentEvent = {
    id: 'evt-1',
    builds: { x: ['B'] }, beyResults: [],
    joiners: [{ name: 'Ken', entryType: 'main', entryId: 'e-ken' }],
    challongeParticipantMap: {},
  };
  const allEvents = [currentEvent];
  const patch = { challongeMissing: false };

  // No serverEvent (null / undefined) — must not throw
  assert.doesNotThrow(() => {
    applyChallongeMetadataResponse(currentEvent, allEvents, patch, null);
  });
  assert.equal(currentEvent.challongeMissing, false, 'patch still applied');
  assert.deepEqual(currentEvent.builds, { x: ['B'] }, 'builds untouched');
});

test('challongeImportOpenMatches: persisted duplicate solo mapping blocks import before fetch', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const helperStart = html.indexOf('// === CHALLONGE-HELPERS START ===');
  const helperEnd = html.indexOf('// === CHALLONGE-HELPERS END ===');
  const importStart = html.indexOf('async function challongeImportOpenMatches()');
  const importEnd = html.indexOf('let _challongePollTimer', importStart);
  assert.notEqual(importStart, -1, 'Missing challongeImportOpenMatches');
  assert.notEqual(importEnd, -1, 'Missing import function end marker');

  let fetchCalled = false;
  const toasts = [];
  const ctx = {
    currentEvent: {
      type: 'solo',
      challongeTournamentId: 'tour-1',
      challongeParticipantMap: {
        10: { entryId: 'e-main', name: 'Cheyanne' },
        11: { entryId: 'e-main', name: 'Cheyanne' },
      },
    },
    fetch: async () => {
      fetchCalled = true;
      throw new Error('fetch must not run for duplicate mappings');
    },
    migratePendingChallongeMatchSids: () => 0,
    showToast: (message, type) => toasts.push({ message, type }),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(helperStart, helperEnd), ctx);
  vm.runInContext(html.slice(importStart, importEnd), ctx);

  const created = await vm.runInContext('challongeImportOpenMatches()', ctx);
  assert.equal(created, 0);
  assert.equal(fetchCalled, false, 'duplicate map must block before Challonge fetch');
  assert.equal(toasts.some(t => /same roster slot/i.test(t.message)), true);
});

test('challongeManualSync reports a queued server retry instead of false synced success', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const start = html.indexOf('async function challongeManualSync()');
  const end = html.indexOf('// Challonge importing is MANUAL ONLY', start);
  assert.notEqual(start, -1, 'Missing challongeManualSync');
  assert.notEqual(end, -1, 'Missing challongeManualSync end marker');

  const toasts = [];
  const ctx = {
    currentEvent: { challongeTournamentId: 'tour-1', challongeMissing: false },
    matchesState: [],
    _challongeImportSaveDeferred: true,
    challongeImportOpenMatches: async () => 14,
    queueCreatedMatchSave: async () => true,
    showToast: (message, type) => toasts.push({ message, type }),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);

  await vm.runInContext('challongeManualSync()', ctx);

  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /retry queued/i);
  assert.doesNotMatch(toasts[0].message, /^.*Imported 14 match\(es\)\.$/);
});

test('challongeManualSync republishes pending local matches when Challonge has nothing new', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');
  const start = html.indexOf('async function challongeManualSync()');
  const end = html.indexOf('// Challonge importing is MANUAL ONLY', start);
  let saveCalls = 0;
  const toasts = [];
  const ctx = {
    currentEvent: { challongeTournamentId: 'tour-1', challongeMissing: false },
    matchesState: [
      { _sid: 'R1|a|b|0', _pendingServerSave: true },
      { _sid: 'R1|c|d|0' },
    ],
    _challongeImportSaveDeferred: false,
    challongeImportOpenMatches: async () => 0,
    queueCreatedMatchSave: async () => { saveCalls++; return true; },
    showToast: (message, type) => toasts.push({ message, type }),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);

  await vm.runInContext('challongeManualSync()', ctx);

  assert.equal(saveCalls, 1);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /synced 1 pending match/i);
});
