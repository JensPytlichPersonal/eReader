import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { makeEpub } from './helpers/make-epub.mjs';
import { makeMobi, fixtureMobiHtml } from './helpers/make-mobi.mjs';

let server, origin, db, processor, dataDir, jens, anna;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-series-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
  ({ db, processor } = created);
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
const calibre = (name, index) => `<meta name="calibre:series" content="${name}"/><meta name="calibre:series_index" content="${index}"/>`;
const strip = (list) => list.map(({ name, position }) => ({ name, position }));

const books = {};

test('series from book details are shared across the library', async () => {
  books.lw = await upload(jens, 'lw.epub', makeEpub({ title: 'Leviathan Wakes', metadata: calibre('The Expanse', '1.0') }));
  books.cw = await upload(anna, 'cw.epub', makeEpub({ title: "Caliban's War",
    metadata: '<meta property="belongs-to-collection" id="c">the expanse</meta><meta refines="#c" property="group-position">2</meta>' }));
  books.ag = await upload(jens, 'ag.mobi', makeMobi({ html: fixtureMobiHtml(), title: "Abaddon's Gate (The Expanse, #3)" }));

  assert.equal(books.ag.title, "Abaddon's Gate");
  const { data } = await anna('/api/books');
  const byId = new Map(data.books.map((b) => [b.id, b]));
  const expanse = byId.get(books.lw.id).series[0];
  assert.equal(expanse.name, 'The Expanse');
  assert.deepEqual([books.lw, books.cw, books.ag].map((b) => byId.get(b.id).series), [
    [{ id: expanse.id, name: 'The Expanse', position: 1 }],
    [{ id: expanse.id, name: 'The Expanse', position: 2 }],
    [{ id: expanse.id, name: 'The Expanse', position: 3 }],
  ]);
  books.expanseId = expanse.id;
  const detail = await anna(`/api/books/${books.cw.id}`);
  assert.deepEqual(strip(detail.data.book.series), [{ name: 'The Expanse', position: 2 }]);
  assert.deepEqual(detail.data.manifest.series, [{ name: 'the expanse', position: 2 }]);
});

test('editing the series and collections of a book', async () => {
  const lw = `/api/books/${books.lw.id}`;
  let r = await anna(lw, { method: 'PATCH', body: { series: [] } });
  assert.equal(r.status, 403);
  r = await jens(lw, { method: 'PATCH', body: { series: [{ name: 'The Expanse', position: 'one' }] } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /number/);
  r = await jens(lw, { method: 'PATCH', body: { series: 'The Expanse' } });
  assert.equal(r.status, 400);
  r = await jens(lw, { method: 'PATCH', body: { title: 'Leviathan Wakes (Tie-in)', series: [{ name: ' the  EXPANSE ', position: '1,5' }, { name: 'Book club 2026', position: '' }, { name: '  ', position: 3 }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.book.series.map((s) => [s.id === books.expanseId, s.name, s.position]), [[true, 'The Expanse', 1.5], [false, 'Book club 2026', null]]);
  books.clubId = r.data.book.series[1].id;

  // Converting again keeps edited details; a book nobody edited follows its file.
  const again = await reprocess(books.lw.id);
  assert.equal(again.title, 'Leviathan Wakes (Tie-in)');
  assert.deepEqual(strip(again.series), [{ name: 'The Expanse', position: 1.5 }, { name: 'Book club 2026', position: null }]);
  r = await jens(`/api/books/${books.cw.id}`, { method: 'PATCH', body: { series: [] } });
  assert.deepEqual(r.data.book.series, []);
  assert.deepEqual(strip((await reprocess(books.cw.id)).series), []);
  db.prepare('UPDATE books SET edited_at = 0 WHERE id = ?').run(books.cw.id);
  assert.deepEqual(strip((await reprocess(books.cw.id)).series), [{ name: 'The Expanse', position: 2 }]);
});

test('renaming merges series, removing dissolves one; both are for admins', async () => {
  const expanse = `/api/series/${books.expanseId}`;
  assert.equal((await anna(expanse, { method: 'PATCH', body: { name: 'Mine' } })).status, 403);
  assert.equal((await anna(expanse, { method: 'DELETE' })).status, 403);
  assert.equal((await jens(expanse, { method: 'PATCH', body: { name: ' ' } })).status, 400);
  assert.equal((await jens('/api/series/99999', { method: 'PATCH', body: { name: 'X' } })).status, 404);
  assert.equal((await jens('/api/series/abc', { method: 'DELETE' })).status, 404);

  // Rename keeps the id; the books count as edited, so converting again keeps the new name.
  let r = await jens(expanse, { method: 'PATCH', body: { name: 'Expanse Saga' } });
  assert.deepEqual(r.data.series, { id: books.expanseId, name: 'Expanse Saga' });
  assert.deepEqual(strip((await reprocess(books.ag.id)).series), [{ name: 'Expanse Saga', position: 3 }]);

  // Renaming to an existing name merges into that series, which keeps its name.
  const extra = await upload(jens, 'extra.epub', makeEpub({ title: 'Gods of Risk', metadata: calibre('Expanse novellas', '2.5') }));
  const novellas = extra.series[0].id;
  r = await jens(`/api/series/${novellas}`, { method: 'PATCH', body: { name: 'expanse saga' } });
  assert.deepEqual(r.data.series, { id: books.expanseId, name: 'Expanse Saga' });
  const { data } = await jens('/api/books');
  const positions = data.books.filter((b) => b.series.some((s) => s.id === books.expanseId))
    .map((b) => [b.title, b.series.find((s) => s.id === books.expanseId).position]).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(positions, [['Leviathan Wakes (Tie-in)', 1.5], ["Caliban's War", 2], ['Gods of Risk', 2.5], ["Abaddon's Gate", 3]]);
  assert.equal((await jens(`/api/series/${novellas}`, { method: 'DELETE' })).status, 404);

  // Removing a collection leaves its books in the library.
  assert.equal((await jens(`/api/series/${books.clubId}`, { method: 'DELETE' })).status, 200);
  r = await jens(`/api/books/${books.lw.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.book.series.map((s) => s.name), ['Expanse Saga']);
  // Changing only how the name is written keeps the series.
  r = await jens(expanse, { method: 'PATCH', body: { name: 'The Expanse Saga ' } });
  assert.deepEqual(r.data.series, { id: books.expanseId, name: 'The Expanse Saga' });
  r = await jens(expanse, { method: 'PATCH', body: { name: 'the expanse SAGA' } });
  assert.deepEqual(r.data.series, { id: books.expanseId, name: 'the expanse SAGA' });
});

test('a book holding several, such as an omnibus, keeps a range of numbers', async () => {
  const omnibus = await upload(jens, 'omnibus.epub', makeEpub({ title: 'Omnibus (Ringworld, #1-3)' }));
  assert.equal(omnibus.title, 'Omnibus');
  assert.deepEqual(omnibus.series.map((s) => [s.name, s.position, s.positionEnd]), [['Ringworld', 1, 3]]);
  const detail = await jens(`/api/books/${omnibus.id}`);
  assert.deepEqual(detail.data.manifest.series, [{ name: 'Ringworld', position: 1, positionEnd: 3 }]);

  // Typed in the edit form, in any of the ways a range is written; one that runs backwards is refused.
  const edit = (position) => jens(`/api/books/${omnibus.id}`, { method: 'PATCH', body: { series: [{ name: 'Ringworld', position }] } });
  let r = await edit('4 – 6');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.book.series.map((s) => [s.position, s.positionEnd]), [[4, 6]]);
  r = await edit('6-4');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /range/);
  r = await edit('2');
  assert.deepEqual(r.data.book.series.map((s) => [s.position, s.positionEnd]), [[2, undefined]], 'a single number again');
  await edit('1-3');

  // Merging series keeps the range.
  const other = await upload(jens, 'other.epub', makeEpub({ title: 'Box', metadata: '<meta property="belongs-to-collection" id="c">Ringworld omnibuses</meta><meta refines="#c" property="group-position">7-9</meta>' }));
  assert.equal((await jens(`/api/series/${other.series[0].id}`, { method: 'PATCH', body: { name: 'Ringworld' } })).status, 200);
  const { data } = await jens('/api/books');
  const inRingworld = (id) => data.books.find((b) => b.id === id).series.find((s) => s.name === 'Ringworld');
  assert.deepEqual([inRingworld(omnibus.id), inRingworld(other.id)].map((s) => [s.position, s.positionEnd]), [[1, 3], [7, 9]]);
});

test('a series without books is removed', async () => {
  const solo = await upload(jens, 'solo.epub', makeEpub({ title: 'Alone', metadata: calibre('Solo Series', '1') }));
  const id = solo.series[0].id;
  assert.equal((await jens(`/api/books/${solo.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await jens(`/api/series/${id}`, { method: 'PATCH', body: { name: 'Still here?' } })).status, 404);
});

test('books converted before series support get their series without converting again', async () => {
  const second = await upload(jens, 'second.epub', makeEpub({ title: 'Second Book', metadata: calibre('Old Series', '2') }));
  const first = await upload(jens, 'first.mobi', makeMobi({ html: fixtureMobiHtml(), title: 'First Book (Old Series, Book 1)' }));
  const notes = await upload(jens, 'Notes.txt', Buffer.from('Some notes.\n\nMore notes.'));
  const edited = await upload(jens, 'edited.epub', makeEpub({ title: 'Edited', metadata: calibre('Old Series', '4') }));
  await jens(`/api/books/${edited.id}`, { method: 'PATCH', body: { series: [] } });
  const converted = (id) => db.prepare('SELECT converted_at FROM books WHERE id = ?').get(id).converted_at;
  const before = converted(second.id);

  // The database as an older version left it: no series, titles as the files have them, and one
  // title a person edited by hand to hold the series.
  db.exec('DELETE FROM book_series; DELETE FROM series; UPDATE books SET metadata_version = 0');
  db.prepare('UPDATE books SET title = ? WHERE id = ?').run('First Book (Old Series, Book 1)', first.id);
  db.prepare('UPDATE books SET title = ? WHERE id = ?').run('Notes (Old Series #3)', notes.id);

  const result = await processor.backfillMetadata();
  assert.ok(result.checked >= 4);
  const { data } = await jens('/api/books');
  const get = (id) => data.books.find((b) => b.id === id);
  assert.deepEqual([second, first, notes, edited].map((b) => [get(b.id).title, strip(get(b.id).series)]), [
    ['Second Book', [{ name: 'Old Series', position: 2 }]],
    ['First Book', [{ name: 'Old Series', position: 1 }]],
    ['Notes', [{ name: 'Old Series', position: 3 }]],
    ['Edited', []],
  ]);
  assert.equal(converted(second.id), before, 'read the details only, no reconversion');
  assert.deepEqual(await processor.backfillMetadata(), { checked: 0, found: 0 });
});
