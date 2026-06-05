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
