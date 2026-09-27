import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { encodePng } from '../server/converters/png.js';
import { makeEpub } from './helpers/make-epub.mjs';
import { makePdf } from './helpers/make-pdf.mjs';
import { TINY_PNG } from './helpers/zipwriter.mjs';

let server, origin, db, dataDir, jens, anna;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-cover-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
  db = created.db;
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  jens = client();
  await jens('/api/auth/register', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
  await jens('/api/users', { method: 'POST', body: { username: 'anna', password: 'pass1234' } });
  anna = client();
  await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'pass1234' } });
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// Like the other API tests' client, but anything that is not JSON comes back as bytes.
function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (Buffer.isBuffer(body)) { payload = body; h['content-type'] ??= 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(origin + p, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, type };
  };
}

const waitReady = async (id) => {
  for (let i = 0; i < 200; i++) {
    const { data } = await jens(`/api/books/${id}`);
    if (data.book.status !== 'processing') return data.book;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
};
const upload = async (c, name, body) => {
  const r = await c('/api/books', { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name) } });
  assert.equal(r.status, 202);
  return waitReady(r.data.book.id);
};
const setCover = (c, id, body) => c(`/api/books/${id}/cover`, { method: 'PUT', body });
const coverFiles = (id) => fs.readdirSync(path.join(dataDir, 'books', id)).filter((f) => f.includes('cover')).sort();
const cover = ({ hasCover, coverSource, fileHasCover }) => ({ hasCover, coverSource, fileHasCover });

// A 2×3 picture, unlike the one in the fixture EPUB.
const PNG = encodePng({ width: 2, height: 3, kind: 2, data: new Uint8Array(18).fill(200) });
// The server goes by the first bytes, so this passes for a JPEG.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);

test('a cover picked by hand replaces the one in the book and is kept when the book is converted again', async () => {
  const book = await upload(jens, 'Covered.epub', makeEpub({ title: 'Covered' }));
  assert.deepEqual(cover(book), { hasCover: true, coverSource: 'file', fileHasCover: true });
  let r = await anna(`/books/${book.id}/cover`);
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.data, TINY_PNG);
  const versions = [book.coverVersion];

  r = await setCover(jens, book.id, PNG);
  assert.equal(r.status, 200);
  assert.deepEqual(cover(r.data.book), { hasCover: true, coverSource: 'custom', fileHasCover: true });
  versions.push(r.data.book.coverVersion);
  assert.deepEqual((await anna(`/books/${book.id}/cover`)).data, PNG);
  assert.deepEqual(coverFiles(book.id), ['cover.png', 'custom-cover.png']);

  // Converting again rewrites the book's own cover and leaves the one picked by hand alone.
  assert.equal((await jens(`/api/books/${book.id}/reprocess`, { method: 'POST' })).status, 202);
  const again = await waitReady(book.id);
  assert.equal(again.status, 'ready');
  assert.deepEqual(cover(again), { hasCover: true, coverSource: 'custom', fileHasCover: true });
  versions.push(again.coverVersion);
  assert.deepEqual((await anna(`/books/${book.id}/cover`)).data, PNG);
  assert.deepEqual(coverFiles(book.id), ['cover.png', 'custom-cover.png']);

  // Another image replaces the first, whatever its type.
  r = await setCover(jens, book.id, JPEG);
  versions.push(r.data.book.coverVersion);
  r = await anna(`/books/${book.id}/cover`);
  assert.equal(r.type, 'image/jpeg');
  assert.deepEqual(r.data, JPEG);
  assert.deepEqual(coverFiles(book.id), ['cover.png', 'custom-cover.jpg']);

  // No cover: the library shows the title instead, and the book's own cover stays for later.
  r = await setCover(jens, book.id, { source: 'none' });
  assert.equal(r.status, 200);
  assert.deepEqual(cover(r.data.book), { hasCover: false, coverSource: 'none', fileHasCover: true });
  versions.push(r.data.book.coverVersion);
  assert.equal((await anna(`/books/${book.id}/cover`)).status, 404);
  assert.deepEqual(coverFiles(book.id), ['cover.png']);

  r = await setCover(jens, book.id, { source: 'file' });
  assert.deepEqual(cover(r.data.book), { hasCover: true, coverSource: 'file', fileHasCover: true });
  versions.push(r.data.book.coverVersion);
  assert.deepEqual((await anna(`/books/${book.id}/cover`)).data, TINY_PNG);

  // Every change gives the cover a new address, so no device keeps showing an old one.
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);

  // Everyone's library shows the same.
  r = await setCover(jens, book.id, PNG);
  const listed = (await anna('/api/books')).data.books.find((b) => b.id === book.id);
  assert.deepEqual(cover(listed), { hasCover: true, coverSource: 'custom', fileHasCover: true });
  assert.equal(listed.coverVersion, r.data.book.coverVersion);
});

test('a changed cover gets a new address even when the clock is behind', async () => {
  const book = await upload(jens, 'Skewed.epub', makeEpub({ title: 'Skewed' }));
  // As if the server's clock was set back after the book was converted.
  db.prepare('UPDATE books SET converted_at = ? WHERE id = ?').run(Date.now() + 3600e3, book.id);
  let version = (await jens(`/api/books/${book.id}`)).data.book.coverVersion;
  for (const body of [PNG, { source: 'none' }, { source: 'file' }, { source: 'file' }]) {
    const next = (await setCover(jens, book.id, body)).data.book.coverVersion;
    assert.ok(next > version, `${next} > ${version}`);
    version = next;
  }
});

test('a PDF has no cover until one is added', async () => {
  const book = await upload(jens, 'Plain.pdf', makePdf([['A page of text.']]));
  assert.equal(book.status, 'ready');
  assert.deepEqual(cover(book), { hasCover: false, coverSource: 'file', fileHasCover: false });
  assert.equal((await jens(`/books/${book.id}/cover`)).status, 404);

  let r = await setCover(jens, book.id, PNG);
  assert.deepEqual(cover(r.data.book), { hasCover: true, coverSource: 'custom', fileHasCover: false });
  assert.deepEqual((await jens(`/books/${book.id}/cover`)).data, PNG);

  r = await setCover(jens, book.id, { source: 'file' });
  assert.deepEqual(cover(r.data.book), { hasCover: false, coverSource: 'file', fileHasCover: false });
  assert.equal((await jens(`/books/${book.id}/cover`)).status, 404);
  assert.deepEqual(coverFiles(book.id), []);
});

test('only the uploader or an admin can change a cover, and only to an image', async () => {
  const mine = await upload(anna, 'Annas.epub', makeEpub({ title: 'Annas' }));
  assert.equal((await setCover(anna, mine.id, PNG)).status, 200);
  assert.equal((await setCover(jens, mine.id, JPEG)).status, 200, 'an admin can change any book');
  const theirs = await upload(jens, 'Jens.epub', makeEpub({ title: 'Jens' }));
  let r = await setCover(anna, theirs.id, PNG);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /uploader or an admin/);
  assert.equal((await setCover(anna, theirs.id, { source: 'none' })).status, 403);
  assert.equal((await setCover(client(), theirs.id, PNG)).status, 401);
  assert.equal((await setCover(jens, '0123456789abcdef', PNG)).status, 404);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const body of [svg, Buffer.from('not an image at all'), Buffer.from('BM this would be a bitmap')]) {
    r = await setCover(jens, theirs.id, body);
    assert.equal(r.status, 415);
    assert.match(r.data.error, /JPEG, PNG, GIF or WebP/);
  }
  r = await jens(`/api/books/${theirs.id}/cover`, { method: 'PUT', body: Buffer.alloc(0), headers: { 'content-type': 'image/png' } });
  assert.equal(r.status, 400);
  for (const body of [{ source: 'custom' }, { source: 'elsewhere' }, {}]) assert.equal((await setCover(jens, theirs.id, body)).status, 400);
  r = await setCover(jens, theirs.id, Buffer.alloc(11 * 1024 * 1024));
  assert.equal(r.status, 413);
  assert.match(r.data.error, /limit 10 MB/);

  // Nothing above changed it.
  const after = (await jens(`/api/books/${theirs.id}`)).data.book;
  assert.deepEqual(cover(after), { hasCover: true, coverSource: 'file', fileHasCover: true });
  assert.equal(after.coverVersion, theirs.coverVersion);
  assert.deepEqual(coverFiles(theirs.id), ['cover.png']);
});
