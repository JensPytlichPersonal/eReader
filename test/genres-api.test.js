import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { cleanGenre, genreKey } from '../server/genres.js';
import { makeEpub } from './helpers/make-epub.mjs';

let server, origin, db, dataDir, jens, anna;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-genres-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
  ({ db } = created);
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
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
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
const reprocess = async (id) => {
  assert.equal((await jens(`/api/books/${id}/reprocess`, { method: 'POST' })).status, 202);
  return waitReady(id);
};
const genreOf = async (id) => (await jens(`/api/books/${id}`)).data.book.genre;
const editedAt = (id) => db.prepare('SELECT edited_at FROM books WHERE id = ?').get(id).edited_at;
const calibre = (name, index) => `<meta name="calibre:series" content="${name}"/><meta name="calibre:series_index" content="${index}"/>`;
const setGenre = (c, ids, genre) => c('/api/books', { method: 'PATCH', body: { ids, genre } });

test('genres are tidied and compared loosely', () => {
  assert.equal(cleanGenre('  Science \n  fiction '), 'Science fiction');
  assert.equal(cleanGenre(null), '');
  assert.equal(cleanGenre('x'.repeat(300)).length, 100);
  assert.equal(genreKey('SCIENCE  fiction'), genreKey('Science fiction'));
  assert.equal(genreKey('Sci‑fi'), genreKey('sci-fi'));
  assert.notEqual(genreKey('Science fiction'), genreKey('Science-fiction'));
});

test("a book's genre is part of its details, joins the spelling the library has, and stays when converting again", async () => {
  const dune = await upload(jens, 'dune.epub', makeEpub({ title: 'Dune' }));
  assert.equal(dune.genre, '');
  let r = await jens(`/api/books/${dune.id}`, { method: 'PATCH', body: { genre: '  Science   fiction ' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.book.genre, 'Science fiction');
  // No file has a genre, so a genre alone does not hold the title and series to what they are now.
  assert.equal(editedAt(dune.id), 0);

  const hyperion = await upload(jens, 'hyperion.epub', makeEpub({ title: 'Hyperion' }));
  r = await jens(`/api/books/${hyperion.id}`, { method: 'PATCH', body: { title: 'Hyperion', genre: 'SCIENCE FICTION' } });
  assert.equal(r.data.book.genre, 'Science fiction');
  assert.ok(editedAt(hyperion.id) > 0, 'the title was edited too');

  assert.equal((await reprocess(dune.id)).genre, 'Science fiction');
  const { data } = await anna('/api/books');
  assert.deepEqual(data.books.filter((b) => b.genre).map((b) => b.title).sort(), ['Dune', 'Hyperion']);

  assert.equal((await jens(`/api/books/${dune.id}`, { method: 'PATCH', body: { genre: 5 } })).status, 400);
  assert.equal((await anna(`/api/books/${dune.id}`, { method: 'PATCH', body: { genre: 'Mine' } })).status, 403);
  r = await jens(`/api/books/${hyperion.id}`, { method: 'PATCH', body: { genre: ' ' } });
  assert.equal(r.data.book.genre, '', 'an empty genre is none');
});

test('several books get a genre at once, when every one is yours or you are an admin', async () => {
  const one = await upload(anna, 'anna-1.epub', makeEpub({ title: 'Anna One' }));
  const two = await upload(anna, 'anna-2.epub', makeEpub({ title: 'Anna Two' }));
  const his = await upload(jens, 'jens-1.epub', makeEpub({ title: 'Jens One' }));
  const hers = [one.id, two.id];

  for (const body of [{ genre: 'Crime' }, { ids: [], genre: 'Crime' }, { ids: one.id, genre: 'Crime' }, { ids: [1], genre: 'Crime' }, { ids: hers }, { ids: hers, genre: null }]) {
    assert.equal((await anna('/api/books', { method: 'PATCH', body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await setGenre(anna, Array(10001).fill(one.id), 'Crime')).status, 400);

  // One book someone else added, and none of them changes.
  let r = await setGenre(anna, [...hers, his.id], 'Crime');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /one of these books was added by someone else/);
  assert.deepEqual(await Promise.all([one.id, two.id, his.id].map(genreOf)), ['', '', '']);

  // An admin can change any, and a spelling the library has wins.
  r = await setGenre(jens, [his.id], 'Crime');
  assert.deepEqual(r.data, { genre: 'Crime', updated: 1 });
  // Her own books, named twice, and a book no longer in the library, which is passed over.
  r = await setGenre(anna, [...hers, one.id, '0123456789abcdef'], ' crime ');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { genre: 'Crime', updated: 2 });
  assert.deepEqual(await Promise.all([one.id, two.id, his.id].map(genreOf)), ['Crime', 'Crime', 'Crime']);
  assert.deepEqual([one.id, two.id, his.id].map(editedAt), [0, 0, 0], 'a genre is not an edit that converting again has to keep');

  r = await setGenre(jens, [one.id, his.id], '');
  assert.deepEqual(r.data, { genre: '', updated: 2 });
  assert.deepEqual(await Promise.all([one.id, two.id, his.id].map(genreOf)), ['', 'Crime', '']);
});

test('a book new to the library takes the genre of the other books in its series', async () => {
  const first = await upload(jens, 'mistborn-1.epub', makeEpub({ title: 'The Final Empire', metadata: calibre('Mistborn', '1') }));
  const second = await upload(jens, 'mistborn-2.epub', makeEpub({ title: 'The Well of Ascension', metadata: calibre('Mistborn', '2') }));
  assert.equal(second.genre, '', 'the series has no genre yet');
  await setGenre(jens, [first.id, second.id], 'Fantasy');
  const third = await upload(anna, 'mistborn-3.epub', makeEpub({ title: 'The Hero of Ages', metadata: calibre('Mistborn', '3') }));
  assert.equal(third.genre, 'Fantasy');

  // Converting again leaves the genre as it is, so a book taken out of the series' genre stays out.
  await setGenre(anna, [third.id], '');
  assert.equal((await reprocess(third.id)).genre, '');

  // The genre most of the series' books have; none when two are as common.
  await setGenre(jens, [third.id], 'Young adult');
  const fourth = await upload(jens, 'mistborn-4.epub', makeEpub({ title: 'The Alloy of Law', metadata: calibre('Mistborn', '4') }));
  assert.equal(fourth.genre, 'Fantasy');
  await setGenre(jens, [fourth.id], 'Young adult');
  const fifth = await upload(jens, 'mistborn-5.epub', makeEpub({ title: 'Shadows of Self', metadata: calibre('Mistborn', '5') }));
  assert.equal(fifth.genre, '');

  // A collection without numbers, such as a book club's, passes on no genre.
  const set = (name) => `<meta property="belongs-to-collection" id="c">${name}</meta><meta refines="#c" property="collection-type">set</meta>`;
  const read = await upload(jens, 'club-1.epub', makeEpub({ title: 'Club One', metadata: set('Book club') }));
  await setGenre(jens, [read.id], 'Poetry');
  const next = await upload(jens, 'club-2.epub', makeEpub({ title: 'Club Two', metadata: set('Book club') }));
  assert.deepEqual(next.series.map((s) => [s.name, s.position]), [['Book club', null]]);
  assert.equal(next.genre, '');
});

test('a database from before genres gets the column, empty for every book', () => {
  const file = path.join(dataDir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL, original_name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, added_by INTEGER, added_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing', error TEXT, total_chars INTEGER NOT NULL DEFAULT 0, section_count INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0, has_cover INTEGER NOT NULL DEFAULT 0)`);
  old.prepare("INSERT INTO books (id, title, format, original_name, added_at) VALUES ('0123456789abcdef', 'Old', 'txt', 'old.txt', 1)").run();
  old.close();
  const upgraded = openDatabase(file);
  assert.equal(upgraded.prepare('SELECT genre FROM books').get().genre, '');
  upgraded.close();
});
