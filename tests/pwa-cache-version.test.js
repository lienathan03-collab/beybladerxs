const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'eventmanager.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

test('Event Manager and service worker ship matching cache version v18', () => {
  const appVersion = html.match(/const APP_VERSION = '([^']+)'/)?.[1];
  const cacheVersion = serviceWorker.match(/const CACHE_VERSION = '([^']+)'/)?.[1];

  assert.equal(appVersion, 'rxs-em-v18');
  assert.equal(cacheVersion, appVersion);
});
