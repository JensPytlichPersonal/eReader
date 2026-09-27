import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { makeEpub } from './helpers/make-epub.mjs';

let server, origin, processor, dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-api-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
  processor = created.processor;
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// Minimal cookie-aware client
function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (Buffer.isBuffer(body)) { payload = body; h['content-type'] ??= 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(origin + p, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

const waitReady = async (c, id) => {
  for (let i = 0; i < 100; i++) {
    const { data } = await c(`/api/books/${id}`);
    if (data.book.status !== 'processing') return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
};

test('first account becomes admin, later registration is blocked, admin adds users', async () => {
  const jens = client();
  let r = await jens('/api/auth/me');
  assert.equal(r.status, 401);
  assert.equal(r.data.setupRequired, true);
  r = await jens('/api/auth/register', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'Laptop' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.isAdmin, true);
  r = await jens('/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.username, 'jens');
  assert.equal(r.data.device, 'Laptop');

  const anon = client();
  r = await anon('/api/auth/register', { method: 'POST', body: { username: 'mallory', password: 'secret1' } });
  assert.equal(r.status, 403);
  r = await anon('/api/users');
  assert.equal(r.status, 401);

  r = await jens('/api/users', { method: 'POST', body: { username: 'anna', password: 'pass1234', displayName: 'Anna' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.isAdmin, false);
  r = await jens('/api/users', { method: 'POST', body: { username: 'anna', password: 'pass1234' } });
  assert.equal(r.status, 409);
  r = await jens('/api/users', { method: 'POST', body: { username: 'x y', password: 'pass1234' } });
  assert.equal(r.status, 400);

  const anna = client();
  r = await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'wrong' } });
  assert.equal(r.status, 401);
  r = await anna('/api/auth/login', { method: 'POST', body: { username: 'ANNA', password: 'pass1234', device: 'Boox' } });
  assert.equal(r.status, 200);
  r = await anna('/api/users');
  assert.equal(r.status, 403);
  r = await anna('/api/auth/password', { method: 'POST', body: { currentPassword: 'pass1234', newPassword: 'newpass1' } });
  assert.equal(r.status, 200);
  r = await anna('/api/auth/logout', { method: 'POST' });
  assert.equal(r.status, 200);
  r = await anna('/api/auth/me');
  assert.equal(r.status, 401);
  r = await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'newpass1' } });
  assert.equal(r.status, 200);
});

test('upload, conversion, shared library and per-user progress with conflict detection', async () => {
  const jens = client();
  await jens('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'Laptop' } });
  const anna = client();
  await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'newpass1', device: 'Boox' } });

  let r = await jens('/api/books', { method: 'POST', body: makeEpub({ title: 'Shared Book' }), headers: { 'x-file-name': encodeURIComponent('Shared Book.epub') } });
  assert.equal(r.status, 202);
  const id = r.data.book.id;
  r = await jens('/api/books', { method: 'POST', body: Buffer.from('garbage'), headers: { 'x-file-name': 'file.docx' } });
  assert.equal(r.status, 415);
  r = await jens('/api/books', { method: 'POST', body: Buffer.alloc(0), headers: { 'x-file-name': 'a.txt' } });
  assert.equal(r.status, 400);

  const detail = await waitReady(jens, id);
  assert.equal(detail.book.status, 'ready');
  assert.equal(detail.book.title, 'Shared Book');
  assert.equal(detail.manifest.sections.length, 2);
  assert.equal(detail.progress, null);

  // Anna sees the same book
  r = await anna('/api/books');
  assert.equal(r.data.books.length, 1);
  assert.equal(r.data.books[0].id, id);
  assert.equal(r.data.books[0].addedBy, 'jens');

  // Section and cover files require auth
  r = await client()(`/books/${id}/sections/0.html`);
  assert.equal(r.status, 401);
  r = await anna(`/books/${id}/sections/0.html`);
  assert.equal(r.status, 200);
  assert.match(r.data, /Chapter One/);
  r = await anna(`/books/${id}/cover`);
  assert.equal(r.status, 200);
  r = await anna(`/books/${id}/book.json`);
  assert.equal(r.status, 200);
  r = await anna(`/books/${id}/../../ereader.sqlite`);
  assert.equal(r.status, 404);
  r = await anna(`/books/${id}/original`);
  assert.equal(r.status, 200);

  // Progress is per user
  r = await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 20, percent: 0.6, knownUpdatedAt: 0 } });
  assert.equal(r.status, 200);
  const t1 = r.data.progress.updatedAt;
  assert.equal(r.data.progress.device, 'Laptop');
  r = await anna(`/api/books/${id}/progress`);
  assert.equal(r.data.progress, null);
  r = await anna(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 0, offset: 5, percent: 0.1 } });
  assert.equal(r.status, 200);
  r = await jens('/api/books');
  assert.equal(r.data.books[0].progress.section, 1);
  r = await anna('/api/books');
  assert.equal(r.data.books[0].progress.section, 0);

  // Another of jens's devices writes; the first device's stale update is rejected with the newer position
  await new Promise((res) => setTimeout(res, 5));
  const jensPhone = client();
  await jensPhone('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'iPhone' } });
  r = await jensPhone(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 300, percent: 0.9, knownUpdatedAt: t1 } });
  assert.equal(r.status, 200);
  const t2 = r.data.progress.updatedAt;
  assert.ok(t2 > t1);
  r = await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 40, percent: 0.65, knownUpdatedAt: t1 } });
  assert.equal(r.status, 409);
  assert.equal(r.data.progress.offset, 300);
  assert.equal(r.data.progress.device, 'iPhone');
  r = await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 40, percent: 0.65, knownUpdatedAt: t2 } });
  assert.equal(r.status, 200);

  // Readers list
  r = await anna(`/api/books/${id}/readers`);
  assert.deepEqual(r.data.readers.map((x) => x.username).sort(), ['anna', 'jens']);

  // Bookmarks
  r = await anna(`/api/books/${id}/bookmarks`, { method: 'POST', body: { section: 0, offset: 3, percent: 0.05, label: 'Start' } });
  assert.equal(r.status, 201);
  r = await jens(`/api/books/${id}/bookmarks`);
  assert.equal(r.data.bookmarks.length, 0);
  r = await anna(`/api/books/${id}/bookmarks`);
  assert.equal(r.data.bookmarks.length, 1);

  // Only uploader or admin can delete; anna cannot, jens can
  r = await anna(`/api/books/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 403);
  r = await anna(`/api/books/${id}`, { method: 'PATCH', body: { title: 'Nope' } });
  assert.equal(r.status, 403);
  r = await jens(`/api/books/${id}`, { method: 'PATCH', body: { title: 'Renamed', author: 'Someone' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.book.title, 'Renamed');
  r = await jens(`/api/books/${id}/reprocess`, { method: 'POST' });
  assert.equal(r.status, 202);
  await waitReady(jens, id);
  r = await jens(`/api/books/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  r = await anna(`/api/books/${id}`);
  assert.equal(r.status, 404);
  assert.equal(fs.existsSync(path.join(dataDir, 'books', id)), false);
});

test('conversion failure is reported on the book', async () => {
  const jens = client();
  await jens('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
  const r = await jens('/api/books', { method: 'POST', body: Buffer.from('PK\x03\x04 not really a zip'), headers: { 'x-file-name': 'broken.epub' } });
  assert.equal(r.status, 202);
  const detail = await waitReady(jens, r.data.book.id);
  assert.equal(detail.book.status, 'error');
  assert.ok(detail.book.error.length > 0);
  await jens(`/api/books/${r.data.book.id}`, { method: 'DELETE' });
});
