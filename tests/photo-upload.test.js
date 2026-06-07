const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const UPLOAD = 'file://' + path.join(__dirname, '..', 'functions', 'api', 'upload.js').replace(/\\/g, '/');
const PHOTO = 'file://' + path.join(__dirname, '..', 'functions', 'api', 'photo.js').replace(/\\/g, '/');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ADMIN = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret' };

function makeKv() {
  const m = new Map();
  return {
    put: async (k, v, opts) => { m.set(k, { value: v, metadata: opts && opts.metadata }); },
    getWithMetadata: async (k) => { const e = m.get(k); return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null }; },
    get: async (k) => { const e = m.get(k); return e ? e.value : null; },
    _m: m
  };
}

test('upload: rejects without admin credentials', async () => {
  const { onRequest } = await import(UPLOAD);
  const env = { BEYBLADE_KV: makeKv(), ...ADMIN };
  const req = new Request('https://x/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: TINY_PNG }) });
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 401);
});

test('upload: stores a valid image and returns /api/photo url', async () => {
  const { onRequest } = await import(UPLOAD);
  const kv = makeKv();
  const env = { BEYBLADE_KV: kv, ...ADMIN };
  const req = new Request('https://x/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminUsername: 'admin', adminPassword: 'secret', dataUrl: TINY_PNG }) });
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.url, /^\/api\/photo\?id=/);
  assert.ok(kv._m.has('photo:' + data.id), 'stored under photo:<id>');
  assert.equal(kv._m.get('photo:' + data.id).metadata.ct, 'image/png');
});

test('upload: rejects a non-image data URL', async () => {
  const { onRequest } = await import(UPLOAD);
  const env = { BEYBLADE_KV: makeKv(), ...ADMIN };
  const req = new Request('https://x/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminUsername: 'admin', adminPassword: 'secret', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }) });
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 400);
});

test('upload: rejects an oversized image (413)', async () => {
  const { onRequest } = await import(UPLOAD);
  const env = { BEYBLADE_KV: makeKv(), ...ADMIN };
  const big = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024); // ~3.75MB decoded > 3MB cap
  const req = new Request('https://x/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminUsername: 'admin', adminPassword: 'secret', dataUrl: big }) });
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 413);
});

test('photo: serves a stored image; 404 when missing; 400 on bad id', async () => {
  const upload = (await import(UPLOAD)).onRequest;
  const photo = (await import(PHOTO)).onRequest;
  const kv = makeKv();
  const env = { BEYBLADE_KV: kv, ...ADMIN };
  const up = await upload({ request: new Request('https://x/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminUsername: 'admin', adminPassword: 'secret', dataUrl: TINY_PNG }) }), env });
  const { id } = await up.json();

  const ok = await photo({ request: new Request('https://x/api/photo?id=' + id), env });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Content-Type'), 'image/png');
  const buf = await ok.arrayBuffer();
  assert.ok(buf.byteLength > 0);

  const missing = await photo({ request: new Request('https://x/api/photo?id=does-not-exist'), env });
  assert.equal(missing.status, 404);

  const bad = await photo({ request: new Request('https://x/api/photo?id=' + encodeURIComponent('../evil')), env });
  assert.equal(bad.status, 400);
});
