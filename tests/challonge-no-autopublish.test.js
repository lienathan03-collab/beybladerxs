// tests/challonge-no-autopublish.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

test('submitMatch does not call challongeReportMatch', () => {
  const start = html.indexOf('async function submitMatch(mid)');
  const end = html.indexOf('async function unsubmitMatch', start);
  const src = html.slice(start, end);
  assert.ok(!/challongeReportMatch\(/.test(src),
    'finalizing a match must not publish to Challonge');
});
