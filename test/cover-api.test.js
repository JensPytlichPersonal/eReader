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

  // Another image replaces the first, whatever its type. The first is put away in covers/.
  r = await setCover(jens, book.id, JPEG);
  versions.push(r.data.book.coverVersion);
  r = await anna(`/books/${book.id}/cover`);
  assert.equal(r.type, 'image/jpeg');
  assert.deepEqual(r.data, JPEG);
  assert.deepEqual(coverFiles(book.id), ['cover.png', 'covers', 'custom-cover.jpg']);

  // No cover: the library shows the title instead, and the book's own cover stays for later.
  r = await setCover(jens, book.id, { source: 'none' });
  assert.equal(r.status, 200);
  assert.deepEqual(cover(r.data.book), { hasCover: false, coverSource: 'none', fileHasCover: true });
  versions.push(r.data.book.coverVersion);
  assert.equal((await anna(`/books/${book.id}/cover`)).status, 404);
  assert.deepEqual(coverFiles(book.id), ['cover.png', 'covers']);

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
  assert.deepEqual(coverFiles(book.id), ['covers']);
});

test('the cover in the book\'s file can be fetched whatever cover the library shows', async () => {
  const book = await upload(jens, 'Own.epub', makeEpub({ title: 'Own' }));
  const own = (c, id) => c(`/books/${id}/cover?source=file`);
  let r = await own(anna, book.id);
  assert.equal(r.status, 200, 'a reader who did not add the book can fetch it');
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.data, TINY_PNG);

  // A cover picked by hand is what the library shows, and the book's own stays to be seen.
  await setCover(jens, book.id, PNG);
  assert.deepEqual((await anna(`/books/${book.id}/cover`)).data, PNG);
  r = await own(anna, book.id);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.data, TINY_PNG);

  // So it does with no cover shown.
  await setCover(jens, book.id, { source: 'none' });
  assert.equal((await anna(`/books/${book.id}/cover`)).status, 404);
  r = await own(jens, book.id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, TINY_PNG);

  // A PDF without a cover of its own has none to show, whatever cover it was given.
  const pdf = await upload(jens, 'Bare.pdf', makePdf([['Another page of text.']]));
  assert.equal((await own(jens, pdf.id)).status, 404);
  await setCover(jens, pdf.id, PNG);
  assert.deepEqual((await jens(`/books/${pdf.id}/cover`)).data, PNG);
  assert.equal((await own(anna, pdf.id)).status, 404);
  assert.equal((await own(jens, '0123456789abcdef')).status, 404);
  assert.equal((await own(client(), book.id)).status, 401);
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

// A third picture; the server goes by the first bytes.
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 3)]);
// The covers a book had before, newest first, as its menu loads them; their ids, and their pictures.
const earlier = async (c, id) => (await c(`/api/books/${id}/covers`)).data.covers;
const ids = (list) => list.map((e) => e.id);
const pictures = (list) => Promise.all(list.map(async (e) => (await anna(e.url)).data));
const earlierFiles = (id) => (fs.existsSync(path.join(dataDir, 'books', id, 'covers')) ? fs.readdirSync(path.join(dataDir, 'books', id, 'covers')).sort() : []);

test('a cover that is replaced is kept, most recent first, and can be used again', async () => {
  const book = await upload(jens, 'Earlier.epub', makeEpub({ title: 'Earlier' }));
  assert.deepEqual(await earlier(jens, book.id), []);
  // The cover in the book's file is not one of them: it stays in the book.
  await setCover(jens, book.id, PNG);
  assert.deepEqual(await earlier(jens, book.id), []);

  await setCover(jens, book.id, JPEG);
  let list = await earlier(jens, book.id);
  assert.equal(list.length, 1);
  const png = list[0].id;
  assert.match(png, /^[a-f0-9]{16}\.png$/);
  assert.equal(list[0].url, `/books/${book.id}/covers/${png}`);
  // Any reader can load it, like the book's other files.
  let r = await anna(list[0].url);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.data, PNG);

  // Going back to the book's own cover keeps the one picked by hand, and so does going to none.
  await setCover(jens, book.id, { source: 'file' });
  list = await earlier(jens, book.id);
  const jpg = list[0].id;
  assert.deepEqual(ids(list), [jpg, png]);
  assert.deepEqual(await pictures(list), [JPEG, PNG]);
  await setCover(jens, book.id, PNG);
  await setCover(jens, book.id, { source: 'none' });
  assert.deepEqual(ids(await earlier(jens, book.id)), [png, jpg]);

  // Used again, it is the cover picked by hand, with a new address, and not listed while it is shown.
  const version = (await jens(`/api/books/${book.id}`)).data.book.coverVersion;
  r = await setCover(jens, book.id, { source: 'earlier', id: jpg });
  assert.equal(r.status, 200);
  assert.deepEqual(cover(r.data.book), { hasCover: true, coverSource: 'custom', fileHasCover: true });
  assert.ok(r.data.book.coverVersion > version);
  assert.deepEqual((await anna(`/books/${book.id}/cover`)).data, JPEG);
  assert.deepEqual(ids(await earlier(jens, book.id)), [png]);

  // Another earlier cover swaps places with it.
  r = await setCover(jens, book.id, { source: 'earlier', id: png });
  assert.equal(r.status, 200);
  assert.deepEqual((await anna(`/books/${book.id}/cover`)).data, PNG);
  assert.deepEqual(ids(await earlier(jens, book.id)), [jpg]);
  assert.deepEqual(coverFiles(book.id), ['cover.png', 'covers', 'custom-cover.png']);

  // So does the same picture sent again as an image.
  await setCover(jens, book.id, JPEG);
  assert.deepEqual(ids(await earlier(jens, book.id)), [png]);
  assert.deepEqual(earlierFiles(book.id), [png]);
});

test('each picture is kept once, however often it is put away', async () => {
  const book = await upload(jens, 'Once.epub', makeEpub({ title: 'Once' }));
  for (const body of [PNG, JPEG, PNG, JPEG, GIF, { source: 'none' }]) assert.equal((await setCover(jens, book.id, body)).status, 200);
  let list = await earlier(jens, book.id);
  assert.deepEqual(await pictures(list), [GIF, JPEG, PNG]);
  assert.equal(earlierFiles(book.id).length, 3);

  // Put away again, a cover moves to the front.
  await setCover(jens, book.id, { source: 'earlier', id: list[2].id });
  await setCover(jens, book.id, { source: 'none' });
  list = await earlier(jens, book.id);
  assert.deepEqual(await pictures(list), [PNG, GIF, JPEG]);
  assert.equal(earlierFiles(book.id).length, 3);

  // As if a save was cut short and left the cover shown among the earlier ones too: put away, it is still kept once.
  const gif = list[1].id;
  await setCover(jens, book.id, { source: 'earlier', id: gif });
  const dir = path.join(dataDir, 'books', book.id);
  fs.copyFileSync(path.join(dir, 'custom-cover.gif'), path.join(dir, 'covers', gif));
  fs.utimesSync(path.join(dir, 'covers', gif), new Date(2001, 0, 1), new Date(2001, 0, 1));
  await setCover(jens, book.id, { source: 'none' });
  assert.deepEqual(await pictures(await earlier(jens, book.id)), [GIF, PNG, JPEG]);
  assert.equal(earlierFiles(book.id).length, 3);
});

test('only the uploader or an admin can see and use the earlier covers, and only the book\'s own', async () => {
  const theirs = await upload(jens, 'Guarded.epub', makeEpub({ title: 'Guarded' }));
  await setCover(jens, theirs.id, PNG);
  await setCover(jens, theirs.id, JPEG);
  const [png] = await earlier(jens, theirs.id);
  let r = await anna(`/api/books/${theirs.id}/covers`);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /uploader or an admin/);
  assert.equal((await setCover(anna, theirs.id, { source: 'earlier', id: png.id })).status, 403);
  assert.equal((await client()(`/api/books/${theirs.id}/covers`)).status, 401);
  assert.equal((await jens('/api/books/0123456789abcdef/covers')).status, 404);

  const mine = await upload(anna, 'Annas own.epub', makeEpub({ title: 'Annas own' }));
  await setCover(anna, mine.id, GIF);
  await setCover(anna, mine.id, PNG);
  r = await anna(`/api/books/${mine.id}/covers`);
  assert.equal(r.status, 200);
  const [gif] = r.data.covers;
  assert.deepEqual(await earlier(jens, mine.id), r.data.covers, 'an admin sees them too');

  const version = (await jens(`/api/books/${theirs.id}`)).data.book.coverVersion;
  for (const id of [undefined, 5, null, [png.id]]) {
    r = await setCover(jens, theirs.id, { source: 'earlier', id });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /earlier covers/);
  }
  // Only a name among the book's earlier covers: no other file of the book, and nothing outside it.
  const others = ['', 'custom-cover.jpg', 'cover.png', 'book.json', '../cover.png', `covers/${png.id}`, `./${png.id}`, `${png.id}/`,
    png.id.toUpperCase(), '0123456789abcdef.png', `../../${mine.id}/covers/${gif.id}`, gif.id];
  for (const id of others) {
    r = await setCover(jens, theirs.id, { source: 'earlier', id });
    assert.equal(r.status, 404, id);
    assert.equal(r.data.error, 'No such earlier cover');
  }
  // The address of an earlier cover cannot reach past the book's folder either.
  assert.equal((await jens(`/books/${theirs.id}/covers/..%2F..%2F${mine.id}%2Fcustom-cover.png`)).status, 404);

  // Nothing above changed it.
  const after = (await jens(`/api/books/${theirs.id}`)).data.book;
  assert.equal(after.coverVersion, version);
  assert.deepEqual(ids(await earlier(jens, theirs.id)), [png.id]);
  assert.deepEqual(coverFiles(theirs.id), ['cover.png', 'covers', 'custom-cover.jpg']);
  assert.deepEqual((await jens(`/books/${theirs.id}/cover`)).data, JPEG);
});

test('converting a book again keeps its earlier covers, and deleting it deletes them', async () => {
  const book = await upload(jens, 'Kept.epub', makeEpub({ title: 'Kept' }));
  await setCover(jens, book.id, PNG);
  await setCover(jens, book.id, JPEG);
  const before = await earlier(jens, book.id);
  assert.equal((await jens(`/api/books/${book.id}/reprocess`, { method: 'POST' })).status, 202);
  assert.equal((await waitReady(book.id)).status, 'ready');
  assert.deepEqual(await earlier(jens, book.id), before);
  assert.deepEqual(await pictures(before), [PNG]);
  assert.deepEqual((await jens(`/books/${book.id}/cover`)).data, JPEG);

  assert.equal((await jens(`/api/books/${book.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'books', book.id)), false);
});
