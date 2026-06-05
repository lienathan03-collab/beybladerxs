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
