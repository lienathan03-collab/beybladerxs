// tests/challonge-no-autopoll.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'eventmanager.html'), 'utf8');

test('no setInterval drives Challonge importing', () => {
  // startChallongePoll must not register a recurring Challonge import.
  const start = html.indexOf('function startChallongePoll');
  const end = html.indexOf('function stopChallongePoll', start);
  const src = html.slice(start, end);
  assert.ok(!/setInterval/.test(src), 'startChallongePoll must not call setInterval');
  assert.ok(!/challongeImportOpenMatches/.test(src),
    'startChallongePoll must not auto-import');
});

test('loadEvent no longer starts a Challonge poll', () => {
  const start = html.indexOf('function loadEvent(id)');
  const end = html.indexOf('function getPlayers', start);
  const src = html.slice(start, end);
  assert.ok(!/startChallongePoll\(\)/.test(src),
    'loadEvent must not start Challonge polling');
});

test('challongeLinkTournament no longer starts a Challonge poll', () => {
  const start = html.indexOf('function challongeLinkTournament');
  const end = html.indexOf('async function challongeBuildParticipantMap', start);
  const src = html.slice(start, end);
  assert.ok(!/startChallongePoll\(\)/.test(src),
    'challongeLinkTournament must not start Challonge polling');
});
