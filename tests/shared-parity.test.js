const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const url = rel => 'file://' + path.join(root, rel).replace(/\\/g, '/');

// These shared modules are duplicated across deploy units (Pages Functions vs
// the bey-state-do Worker bundle). They MUST stay byte-identical or the atomic
// (DO) path and the KV-fallback path can diverge. This guard fails the build the
// moment they drift.
test('merge.js: shared copy is byte-identical to the DO copy', () => {
  assert.equal(
    read('functions/api/_shared/merge.js'),
    read('workers/bey-state-do/src/merge.js'),
    'functions/api/_shared/merge.js and workers/bey-state-do/src/merge.js have drifted'
  );
});

test('events-ops.js: shared copy is byte-identical to the DO copy', () => {
  assert.equal(
    read('functions/api/_shared/events-ops.js'),
    read('workers/bey-state-do/src/events-ops.js'),
    'functions/api/_shared/events-ops.js and workers/bey-state-do/src/events-ops.js have drifted'
  );
});

test('beyresults.js re-exports the shared merge functions', async () => {
  const mod = await import(url('functions/api/beyresults.js'));
  for (const fn of ['mergeBeyResults', 'computeSidsForEntries', 'mergeBuilds', 'stripTombstonesForResponse']) {
    assert.equal(typeof mod[fn], 'function', `beyresults.js must re-export ${fn}`);
  }
  // Sanity: the re-exported merge still behaves.
  const merged = mod.mergeBeyResults(
    [{ player: 'A', round: 'R1', _matchSid: 'R1|A|B|0' }],
    [{ player: 'C', round: 'R1', _matchSid: 'R1|C|D|0' }],
    []
  );
  const sids = new Set(merged.map(e => e._matchSid));
  assert.ok(sids.has('R1|A|B|0') && sids.has('R1|C|D|0'));
});
