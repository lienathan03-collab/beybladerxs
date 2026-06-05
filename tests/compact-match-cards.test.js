// tests/compact-match-cards.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

function bodyOf(fnSignature, endNeedle) {
  const start = html.indexOf(fnSignature);
  assert.notEqual(start, -1, `Missing ${fnSignature}`);
  const end = html.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing end needle after ${fnSignature}`);
  return html.slice(start, end);
}

test('challongeImportOpenMatches pushes collapsed matches (solo + team)', () => {
  const body = bodyOf('async function challongeImportOpenMatches()', '\nlet _challongePollTimer');
  // Every collapsed: literal in the import builder must be true.
  const flags = [...body.matchAll(/collapsed:\s*(true|false)/g)].map(m => m[1]);
  assert.ok(flags.length >= 2, 'expected at least the solo + team push sites');
  assert.ok(flags.every(f => f === 'true'),
    `imported matches must be collapsed; found: ${flags.join(', ')}`);
});

test('loadMatchesFromResults builds matches collapsed', () => {
  const body = bodyOf('function loadMatchesFromResults()', 'function flattenMatchesToResults()');
  const flags = [...body.matchAll(/collapsed:\s*(true|false)/g)].map(m => m[1]);
  assert.ok(flags.length >= 1, 'expected collapse flags in loader');
  assert.ok(flags.every(f => f === 'true'), `loaded matches must be collapsed; got ${flags}`);
});

test('mergeIncomingMatches adds server matches collapsed', () => {
  const body = bodyOf('function mergeIncomingMatches(', '// SUBMIT MATCH');
  // New-from-server and full-replace-fallback must default collapsed true.
  assert.match(body, /sm\.collapsed\s*=\s*true/);
  assert.match(body, /sm\.collapsed\s*=\s*existing\s*\?\s*existing\.collapsed\s*:\s*true/);
});

test('submitMatch leaves the match collapsed (does not auto-expand)', () => {
  // Slice the submit routine (submitMatch:7712 → unsubmitMatch:7813) and assert
  // the collapse line is true, not false.
  const body = bodyOf('async function submitMatch(mid)', 'async function unsubmitMatch(mid)');
  assert.match(body, /toSubmit\.collapsed\s*=\s*true/,
    'submitting should keep the compact row collapsed');
  assert.doesNotMatch(body, /toSubmit\.collapsed\s*=\s*false/);
});

const vm = require('node:vm');

function loadManualOpen() {
  const start = html.indexOf('// === MANUAL-OPEN-ROUTE START ===');
  const end = html.indexOf('// === MANUAL-OPEN-ROUTE END ===');
  assert.notEqual(start, -1, 'Missing MANUAL-OPEN-ROUTE START marker');
  assert.notEqual(end, -1, 'Missing MANUAL-OPEN-ROUTE END marker');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  // Wrap exported functions so returned plain objects are in the outer realm
  // (vm context produces a different realm on Node 24, breaking deepStrictEqual).
  const wrapped = {};
  for (const key of Object.keys(ctx)) {
    const val = ctx[key];
    wrapped[key] = typeof val === 'function'
      ? (...args) => { const r = val(...args); return r == null ? r : JSON.parse(JSON.stringify(r)); }
      : val;
  }
  return wrapped;
}

test('manualMatchScoringTarget routes a solo match to openLiveModeSolo', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.deepEqual(manualMatchScoringTarget({ id: 7 }),
    { fn: 'openLiveModeSolo', args: [7, 'p1'] });
});

test('manualMatchScoringTarget routes a team match to openLiveMode', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.deepEqual(manualMatchScoringTarget({ id: 9, isTeamMatch: true }),
    { fn: 'openLiveMode', args: [9, 'team1', 0] });
});

test('manualMatchScoringTarget routes a DE self-match to openDeSelfScore', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.deepEqual(manualMatchScoringTarget({ id: 4, _deSelfMatch: true }),
    { fn: 'openDeSelfScore', args: [4] });
  // DE flag wins even though the match is otherwise solo-shaped:
  assert.equal(manualMatchScoringTarget({ id: 4, _deSelfMatch: true }).fn, 'openDeSelfScore');
});

test('manualMatchScoringTarget returns null for a missing match', () => {
  const { manualMatchScoringTarget } = loadManualOpen();
  assert.equal(manualMatchScoringTarget(null), null);
});

test('openManualMatchScoring calls the solo entry point exactly once', () => {
  const { openManualMatchScoring } = loadManualOpen();
  const calls = [];
  const table = {
    openLiveModeSolo: (...a) => calls.push(['solo', a]),
    openLiveMode:     (...a) => calls.push(['team', a]),
    openDeSelfScore:  (...a) => calls.push(['de', a]),
  };
  const ok = openManualMatchScoring({ id: 3 }, table);
  assert.equal(ok, true);
  assert.deepEqual(calls, [['solo', [3, 'p1']]]);
});

test('openManualMatchScoring routes team + DE without touching solo', () => {
  const { openManualMatchScoring } = loadManualOpen();
  const calls = [];
  const table = {
    openLiveModeSolo: () => calls.push('solo'),
    openLiveMode:     () => calls.push('team'),
    openDeSelfScore:  () => calls.push('de'),
  };
  openManualMatchScoring({ id: 1, isTeamMatch: true }, table);
  openManualMatchScoring({ id: 2, _deSelfMatch: true }, table);
  assert.deepEqual(calls, ['team', 'de']);
});

test('openManualMatchScoring returns false when the entry point throws', () => {
  const { openManualMatchScoring } = loadManualOpen();
  const table = { openLiveModeSolo: () => { throw new Error('modal boom'); } };
  assert.equal(openManualMatchScoring({ id: 5 }, table), false);
});

test('openManualMatchScoring returns false when the fn is missing', () => {
  const { openManualMatchScoring } = loadManualOpen();
  assert.equal(openManualMatchScoring({ id: 6 }, {}), false);
});

test('createMatch creates matches collapsed and opens scoring after the save await', () => {
  const body = bodyOf('async function createMatch()', '// ROUND FILTER');
  // (a) created matches are collapsed
  const flags = [...body.matchAll(/collapsed:\s*(true|false)/g)].map(m => m[1]);
  assert.ok(flags.length >= 2 && flags.every(f => f === 'true'),
    `manual matches must be created collapsed; got ${flags}`);
  // (b) it captures the created match and opens scoring via the dispatcher
  assert.match(body, /openManualMatchScoring\s*\(/);
  // (c) ordering: the await of the save queue comes BEFORE opening scoring
  const awaitIdx = body.indexOf('await queueCreatedMatchSave()');
  const openIdx  = body.indexOf('openManualMatchScoring');
  assert.ok(awaitIdx !== -1 && openIdx !== -1 && awaitIdx < openIdx,
    'must persist/queue before opening scoring');
});

test('challongeImportOpenMatches does NOT open scoring', () => {
  const body = bodyOf('async function challongeImportOpenMatches()', '\nlet _challongePollTimer');
  assert.doesNotMatch(body, /openManualMatchScoring|openLiveModeSolo|openLiveMode\(|openDeSelfScore/,
    'imports must never auto-open scoring');
});

function loadHeaderHelpers() {
  const start = html.indexOf('// === MATCH-HEADER-HTML START ===');
  const end = html.indexOf('// === MATCH-HEADER-HTML END ===');
  assert.notEqual(start, -1, 'Missing MATCH-HEADER-HTML START marker');
  assert.notEqual(end, -1, 'Missing MATCH-HEADER-HTML END marker');
  const ctx = {
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

test('matchOverflowMenuHtml shows Submit (not Unsubmit) for a pending match', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const out = matchOverflowMenuHtml({ id: 1, submitted: false });
  assert.match(out, /submitMatch\(1\)/);
  assert.doesNotMatch(out, /unsubmitMatch\(/);
  assert.match(out, /removeMatch\(1\)/);
});

test('matchOverflowMenuHtml shows Unsubmit for a submitted match', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const out = matchOverflowMenuHtml({ id: 2, submitted: true });
  assert.match(out, /unsubmitMatch\(2\)/);
  assert.doesNotMatch(out, /(?<![a-zA-Z])submitMatch\(/);
});

test('matchOverflowMenuHtml shows a Retry item only on push error', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const err = matchOverflowMenuHtml({ id: 3, _challongeMatchId: 'c', _challongePushState: 'error' });
  assert.match(err, /retry/i);
  const ok = matchOverflowMenuHtml({ id: 3, _challongeMatchId: 'c', _challongePushState: 'ok' });
  assert.doesNotMatch(ok, /retry/i);
});

test('matchOverflowMenuHtml Remove item carries the danger class and stops propagation', () => {
  const { matchOverflowMenuHtml } = loadHeaderHelpers();
  const out = matchOverflowMenuHtml({ id: 9, submitted: false });
  assert.match(out, /class="[^"]*mc2-menu-item[^"]*danger[^"]*"[^>]*removeMatch\(9\)/);
  assert.match(out, /event\.stopPropagation\(\)/);
});

test('matchStatusChipHtml reflects submitted / pending / push states', () => {
  const { matchStatusChipHtml } = loadHeaderHelpers();
  assert.match(matchStatusChipHtml({ id: 1, submitted: true }), /submitted/i);
  assert.match(matchStatusChipHtml({ id: 2, submitted: false }), /pending/i);
  assert.match(
    matchStatusChipHtml({ id: 3, _challongeMatchId: 'c', _challongePushState: 'error' }),
    /retry|failed|⚠/i);
});
