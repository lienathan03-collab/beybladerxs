const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

function makeKV(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

test('challonge_update changes only allowlisted metadata and preserves tournament data', async () => {
  const { onRequest } = await import(
    'file://' + path.join(__dirname, '..', 'functions', 'api', 'events.js').replace(/\\/g, '/')
  );
  const originalBuilds = { alice: ['Wizard Rod'], bob: ['Phoenix Wing'] };
  const originalResults = [
    { player: 'alice', round: 'R1', _matchSid: 'r1-a-b' },
    { player: 'bob', round: 'R1', _matchSid: 'r1-a-b' },
  ];
  const kv = makeKV({
    events: JSON.stringify({
      events: [{
        id: 'evt-1',
        title: 'Swiss Event',
        builds: originalBuilds,
        beyResults: originalResults,
        challongeTournamentId: 'old-tour',
      }],
    }),
  });
  const request = new Request('https://example.com/api/events?action=challonge_update', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adminUsername: 'admin',
      adminPassword: 'secret',
      eventId: 'evt-1',
      challongeMetadata: {
        challongeTournamentId: 'new-tour',
        challongeMissing: false,
        builds: {},
        beyResults: [],
      },
    }),
  });

  const res = await onRequest({
    request,
    env: {
      BEYBLADE_KV: kv,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'secret',
    },
  });

  assert.equal(res.status, 200);
  const stored = JSON.parse(await kv.get('events')).events[0];
  assert.equal(stored.challongeTournamentId, 'new-tour');
  assert.equal(stored.challongeMissing, false);
  assert.deepEqual(stored.builds, originalBuilds);
  assert.deepEqual(stored.beyResults, originalResults);
});
