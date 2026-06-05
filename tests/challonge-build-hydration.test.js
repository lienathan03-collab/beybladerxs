// tests/challonge-build-hydration.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function sliceBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  const end = html.indexOf(endNeedle, start);
  assert.notEqual(start, -1, `Missing source marker: ${startNeedle}`);
  assert.notEqual(end, -1, `Missing source marker: ${endNeedle}`);
  return html.slice(start, end);
}

function loadReconcile() {
  const ctx = { Array };
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  return ctx.reconcileMatchSlotBuilds;
}

test('reconcile: creates build objects on an empty slot from submitted names', () => {
  const reconcile = loadReconcile();
  const slot = { player: 'Ken', builds: [] };
  reconcile(slot, ['Dragoon', 'Dranzer', 'Draciel']);
  assert.equal(slot.builds.length, 3);
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer', 'Draciel']);
  assert.equal(slot.builds[0].build, 'Dragoon');
  assert.equal(slot.builds[0].finishes.length, 0);
  assert.equal(slot.builds[0].deployed, false);
});

test('reconcile: renames existing build by slot index, preserving finishes & deployed', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [
    { build: 'OldA', finishes: ['S', 'O'], deployed: true },
    { build: 'OldB', finishes: ['L'], deployed: false },
  ] };
  reconcile(slot, ['NewA', 'NewB']);
  assert.equal(slot.builds.length, 2);
  assert.deepEqual(slot.builds[0], { build: 'NewA', finishes: ['S', 'O'], deployed: true });
  assert.deepEqual(slot.builds[1], { build: 'NewB', finishes: ['L'], deployed: false });
});

test('reconcile: ignores interior blank / padding names (filtered indexing)', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [] };
  reconcile(slot, ['Dragoon', '', '  ', 'Dranzer']);
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
});

test('reconcile: trims trailing UNSCORED extras but KEEPS scored extras (preserve results)', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [
    { build: 'A', finishes: [], deployed: false },
    { build: 'B', finishes: ['O'], deployed: false },
    { build: 'C', finishes: [], deployed: false },
  ] };
  reconcile(slot, ['A']);
  assert.equal(slot.builds.length, 2);
  assert.deepEqual(slot.builds.map(b => b.build), ['A', 'B']);
  assert.deepEqual(slot.builds[1].finishes, ['O']);
});

test('reconcile: deployed-only trailing extra is preserved', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [
    { build: 'A', finishes: [], deployed: false },
    { build: 'B', finishes: [], deployed: true },
  ] };
  reconcile(slot, ['A']);
  assert.equal(slot.builds.length, 2);
  assert.equal(slot.builds[1].deployed, true);
});

test('reconcile: idempotent — repeated calls create no duplicates', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [] };
  reconcile(slot, ['Dragoon', 'Dranzer']);
  reconcile(slot, ['Dragoon', 'Dranzer']);
  reconcile(slot, ['Dragoon', 'Dranzer']);
  assert.equal(slot.builds.length, 2);
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
});

test('reconcile: empty submitted list leaves an empty slot empty', () => {
  const reconcile = loadReconcile();
  const slot = { builds: [] };
  reconcile(slot, []);
  assert.deepEqual(slot.builds, []);
});

test('reconcile: missing builds array is initialised', () => {
  const reconcile = loadReconcile();
  const slot = { player: 'Ken' };
  reconcile(slot, ['Dragoon']);
  assert.equal(slot.builds.length, 1);
  assert.equal(slot.builds[0].build, 'Dragoon');
});

function loadChallongeSlot(ctxExtras) {
  const ctx = Object.assign({ JSON, Array }, ctxExtras);
  vm.createContext(ctx);
  // reconcile helper first (challongeEntryToMatchSlot depends on it)
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  vm.runInContext(
    sliceBetween('function challongeEntryToMatchSlot(ref)', 'async function challongeImportOpenMatches'),
    ctx
  );
  return ctx;
}

test('challongeEntryToMatchSlot: builds submitted BEFORE sync hydrate the slot by entryId', () => {
  const ctx = loadChallongeSlot({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['Dragoon', 'Dranzer', 'Draciel'] },
    getPlayers: () => [
      { name: 'Ken', displayLabel: 'Ken', entryId: 'e-ken', entryType: 'main' },
    ],
  });
  const slot = vm.runInContext(
    `challongeEntryToMatchSlot({ entryId: 'e-ken', name: 'Ken' })`, ctx
  );
  assert.deepEqual(slot.builds.map(b => b.build), ['Dragoon', 'Dranzer', 'Draciel']);
  assert.deepEqual(slot.builds[0], { build: 'Dragoon', finishes: [], deployed: false });
  assert.equal(slot.entryId, 'e-ken');
  assert.equal(slot.player, 'Ken');
});

test('challongeEntryToMatchSlot: main vs DE same name resolve by SEPARATE entryId keys', () => {
  const ctx = loadChallongeSlot({
    playerKey: (name) => name,
    buildsState: {
      'e-lien-1': ['MainA', 'MainB'],
      'e-lien-2': ['DeA', 'DeB'],
    },
    getPlayers: () => [
      { name: 'Lienathan', displayLabel: 'Lienathan 1', entryId: 'e-lien-1', entryType: 'main' },
      { name: 'Lienathan', displayLabel: 'Lienathan 2', entryId: 'e-lien-2', entryType: 'double' },
    ],
  });
  const main = vm.runInContext(`challongeEntryToMatchSlot({ entryId: 'e-lien-1', name: 'Lienathan' })`, ctx);
  const de   = vm.runInContext(`challongeEntryToMatchSlot({ entryId: 'e-lien-2', name: 'Lienathan' })`, ctx);
  assert.deepEqual(main.builds.map(b => b.build), ['MainA', 'MainB']);
  assert.deepEqual(de.builds.map(b => b.build), ['DeA', 'DeB']);
});

test('challongeEntryToMatchSlot: no submitted builds yields an empty (not undefined) builds array', () => {
  const ctx = loadChallongeSlot({
    playerKey: (name) => name,
    buildsState: {},
    getPlayers: () => [{ name: 'Mia', displayLabel: 'Mia', entryId: 'e-mia', entryType: 'main' }],
  });
  const slot = vm.runInContext(`challongeEntryToMatchSlot({ entryId: 'e-mia', name: 'Mia' })`, ctx);
  assert.deepEqual(slot.builds, []);
});

function loadSubmitApply(ctxExtras) {
  const ctx = Object.assign({ JSON, Array, Object }, ctxExtras);
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  vm.runInContext(
    sliceBetween('// === SUBMIT-APPLY START ===', '// === SUBMIT-APPLY END ==='),
    ctx
  );
  return ctx;
}

test('applySubmittedBuildsToMatches: populates a previously EMPTY solo slot (sync-before-submit)', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['Dragoon', 'Dranzer'], 'e-mia': ['Driger'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Ken', entryId: 'e-ken', builds: [] },
      p2: { player: 'Mia', entryId: 'e-mia', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].p1.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
  assert.deepEqual(ctx.matchesState[0].p2.builds.map(b => b.build), ['Driger']);
});

test('applySubmittedBuildsToMatches: renames existing builds, preserving finishes/deployed', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['NewA', 'NewB'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Ken', entryId: 'e-ken', builds: [
        { build: 'OldA', finishes: ['S'], deployed: true },
        { build: 'OldB', finishes: [], deployed: false },
      ] },
      p2: { player: 'Mia', entryId: 'e-mia', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].p1.builds[0], { build: 'NewA', finishes: ['S'], deployed: true });
  assert.equal(ctx.matchesState[0].p1.builds[1].build, 'NewB');
});

test('applySubmittedBuildsToMatches: solo slot keyed by entryId, not name', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'e-lien-1': ['MainA'], 'e-lien-2': ['DeA'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Lienathan', entryId: 'e-lien-1', builds: [] },
      p2: { player: 'Lienathan', entryId: 'e-lien-2', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].p1.builds.map(b => b.build), ['MainA']);
  assert.deepEqual(ctx.matchesState[0].p2.builds.map(b => b.build), ['DeA']);
});

test('applySubmittedBuildsToMatches: team members receive their submitted builds (keyed by name)', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'Alice': ['A1', 'A2'], 'Bob': ['B1'] },
    matchesState: [{
      round: 'R1', isTeamMatch: true,
      team1: { teamName: 'T1', members: [{ player: 'Alice', builds: [] }] },
      team2: { teamName: 'T2', members: [{ player: 'Bob', builds: [] }] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.deepEqual(ctx.matchesState[0].team1.members[0].builds.map(b => b.build), ['A1', 'A2']);
  assert.deepEqual(ctx.matchesState[0].team2.members[0].builds.map(b => b.build), ['B1']);
});

test('applySubmittedBuildsToMatches: idempotent across repeated submit passes', () => {
  const ctx = loadSubmitApply({
    playerKey: (name) => name,
    buildsState: { 'e-ken': ['Dragoon', 'Dranzer'] },
    matchesState: [{
      round: 'R1',
      p1: { player: 'Ken', entryId: 'e-ken', builds: [] },
      p2: { player: 'Mia', entryId: 'e-mia', builds: [] },
    }],
  });
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  vm.runInContext('applySubmittedBuildsToMatches()', ctx);
  assert.equal(ctx.matchesState[0].p1.builds.length, 2);
});

// The team-import conversion mirrors nmSelectTeam: each joiner member
// { displayName } becomes { player, builds:[…] } hydrated from buildsState by name.
function loadTeamConvert(ctxExtras) {
  const ctx = Object.assign({ JSON, Array }, ctxExtras);
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('// === BUILD-RECONCILE START ===', '// === BUILD-RECONCILE END ==='),
    ctx
  );
  vm.runInContext(
    sliceBetween('function challongeJoinerTeamToMatchTeam(joiner)', '// === TEAM-CONVERT END ==='),
    ctx
  );
  return ctx;
}

test('challongeJoinerTeamToMatchTeam: maps joiner members to hydrated {player, builds}', () => {
  const ctx = loadTeamConvert({
    playerKey: (name) => name,
    buildsState: { 'Alice': ['A1', 'A2'], 'Bob': ['B1'] },
  });
  const team = vm.runInContext(
    `challongeJoinerTeamToMatchTeam({ teamName: 'Dragons', members: [{ displayName: 'Alice' }, { displayName: 'Bob' }] })`,
    ctx
  );
  assert.equal(team.teamName, 'Dragons');
  assert.equal(team.members.length, 2);
  assert.equal(team.members[0].player, 'Alice');
  assert.deepEqual(team.members[0].builds.map(b => b.build), ['A1', 'A2']);
  assert.deepEqual(team.members[1].builds.map(b => b.build), ['B1']);
});

test('challongeJoinerTeamToMatchTeam: string members and missing builds are handled', () => {
  const ctx = loadTeamConvert({ playerKey: (name) => name, buildsState: {} });
  const team = vm.runInContext(
    `challongeJoinerTeamToMatchTeam({ teamName: 'X', members: ['Solo'] })`, ctx
  );
  assert.equal(team.members[0].player, 'Solo');
  assert.deepEqual(team.members[0].builds, []);
});

function loadFlattenAndLoad() {
  const ctx = {
    JSON, Array, Object, Set, console,
    resultsState: [],
    matchesState: [],
    _matchIdCounter: 1,
    calcPoints: () => 0,
    autoCheckWin() {}, autoCheckDeWin() {}, autoCheckTeamWin() {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('function flattenMatchesToResults()', '// LIVE-PUSH PATCH HELPERS (start)'),
    ctx
  );
  vm.runInContext(
    sliceBetween('function loadMatchesFromResults()', 'function flattenMatchesToResults()'),
    ctx
  );
  return ctx;
}

test('round-trip: flatten then load preserves solo build names, finishes and deployed', () => {
  const ctx = loadFlattenAndLoad();
  ctx.matchesState = [{
    id: 1, _sid: 'R1|e-ken|e-mia|0', round: 'R1',
    p1: { player: 'Ken', entryId: 'e-ken', builds: [
      { build: 'Dragoon', finishes: ['S'], deployed: true },
      { build: 'Dranzer', finishes: [], deployed: false },
    ] },
    p2: { player: 'Mia', entryId: 'e-mia', builds: [
      { build: 'Driger', finishes: ['O'], deployed: false },
    ] },
  }];
  vm.runInContext('flattenMatchesToResults()', ctx);
  // server row builds carry the scoring objects intact
  assert.deepEqual(ctx.resultsState[0].builds[0], { build: 'Dragoon', finishes: ['S'], deployed: true });
  // reload from the flattened rows
  vm.runInContext('loadMatchesFromResults()', ctx);
  const m = ctx.matchesState[0];
  assert.deepEqual(m.p1.builds.map(b => b.build), ['Dragoon', 'Dranzer']);
  assert.deepEqual(m.p1.builds[0].finishes, ['S']);
  assert.equal(m.p1.builds[0].deployed, true);
  assert.deepEqual(m.p2.builds.map(b => b.build), ['Driger']);
});

test('round-trip: non-dirty full-replace merge keeps server-hydrated builds', () => {
  // mergeIncomingMatches (non-dirty path) builds slots from server rows that
  // already carry hydrated build objects -> they must survive the replace.
  const ctx = {
    JSON, Array, Object, Set, console,
    dirty: false,
    matchesState: [],
    resultsState: [],
    buildsState: {},
    _matchIdCounter: 5,
    _activeLiveMatchSid: null,
    flattenMatchesToResults() {},
    playerKey: (n) => n,
    slotKey: (p) => p.entryId || p.player,
    isDeSelfMatch: () => false,
    _soloSid: (r, p1, p2, i) => `${r}|${p1.entryId || p1.player}|${p2.entryId || p2.player}|${i}`,
    _teamSid: (r, a, b, i) => `${r}|T|${a}|${b}|${i}`,
  };
  const serverResults = [
    { player: 'Ken', entryId: 'e-ken', round: 'R1', _matchSid: 'R1|e-ken|e-mia|0',
      builds: [{ build: 'Dragoon', finishes: ['S'], deployed: true }] },
    { player: 'Mia', entryId: 'e-mia', round: 'R1', _matchSid: 'R1|e-ken|e-mia|0',
      builds: [{ build: 'Driger', finishes: [], deployed: false }] },
  ];
  ctx.serverResults = serverResults;
  vm.createContext(ctx);
  vm.runInContext(
    sliceBetween('function mergeIncomingMatches', '// SUBMIT MATCH'),
    ctx
  );
  vm.runInContext(`mergeIncomingMatches({}, serverResults)`, ctx);
  assert.equal(ctx.matchesState.length, 1);
  const p1Builds = ctx.matchesState[0].p1.builds;
  assert.equal(p1Builds.length, 1);
  assert.equal(p1Builds[0].build, 'Dragoon');
  assert.deepEqual(p1Builds[0].finishes, ['S']);
  assert.equal(p1Builds[0].deployed, true);
});
