import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { createOpenLibrary, LookupError } from '../server/openlibrary.js';
import { readIsbn } from '../server/converters/isbn.js';
import { readMetadata } from '../server/converters/index.js';
import { makeEpub } from './helpers/make-epub.mjs';
import { makeMobi, fixtureMobiHtml } from './helpers/make-mobi.mjs';

// Search results as Open Library sends them (fields trimmed to the ones asked for).
const leviathan = {
  key: '/works/OL16114008W', title: 'Leviathan Wakes', author_name: ['James S. A. Corey'], first_publish_year: 2009, cover_i: 7314237,
  series_name: ['The Expanse'], series_position: ['1'], editions: { docs: [{ key: '/books/OL32667325M', title: 'Leviathan Wakes', cover_i: 11295081 }] },
};
const boxSet = { key: '/works/OL21650948W', title: "Expanse Hardcover Boxed Set : Leviathan Wakes, Caliban's War, Abaddon's Gate", author_name: ['James S. A. Corey'], first_publish_year: 2019 };
const philosopher = {
  key: '/works/OL82563W', title: "Harry Potter and the Philosopher's Stone", author_name: ['J. K. Rowling'], first_publish_year: 1997, cover_i: 15155833,
  series_name: ['Harry Potter'], series_position: ['1'], editions: { docs: [{ key: '/books/OL39797842M', title: 'Harry Potter og De Vises Sten', cover_i: 12917614 }] },
};
const unrelated = { key: '/works/OL15980749W', title: 'The 7 principles of highly accountable men', author_name: ['Mark R. Laaser'] };

/** A stand-in for Open Library's search. `answer(params, i)` gives { docs } or { status, body }, or throws. */
function standIn(answer) {
  const calls = [];
  const fetch = async (url, { headers }) => {
    const params = Object.fromEntries(new URL(url).searchParams);
    calls.push({ params, headers, at: Date.now() });
    const reply = await answer(params, calls.length - 1);
    return new Response(reply.body ?? JSON.stringify({ docs: reply.docs ?? [] }), { status: reply.status ?? 200 });
  };
  return { calls, fetch };
}
/** Answers the requests in turn. */
const inTurn = (...replies) => (params, i) => {
  if (replies[i] instanceof Error) throw replies[i];
  return replies[i];
};

test('ISBNs are read from identifiers and checked', () => {
  assert.equal(readIsbn('978-0-316-12908-4'), '9780316129084');
  assert.equal(readIsbn('urn:isbn:9780316129084'), '9780316129084');
  assert.equal(readIsbn('ISBN-13: 978 0 316 12908 4 (e-book)'), '9780316129084');
  assert.equal(readIsbn('urn:isbn:0316129089'), '9780316129084', 'ISBN-10s become ISBN-13s');
  assert.equal(readIsbn('0-8044-2957-X', { isbn: true }), '9780804429573');
  assert.equal(readIsbn('0316129089'), null, 'a bare ten-digit number could be anything');
  assert.equal(readIsbn('9780316129085'), null, 'wrong check digit');
  assert.equal(readIsbn('1234567890128'), null, 'ISBN-13s start with 978 or 979');
  for (const other of ['urn:uuid:9780316129084', 'B00ABCDEFG', 'calibre:1234', '', null]) assert.equal(readIsbn(other, { isbn: true }), null, other);
});

test('EPUB and MOBI files name their ISBNs', async () => {
  const epub = makeEpub({ metadata: '<dc:identifier opf:scheme="ISBN">0316129089</dc:identifier><dc:identifier opf:scheme="calibre">1234</dc:identifier>'
    + '<dc:identifier>urn:isbn:9780316129084</dc:identifier><dc:source>urn:isbn:978-0-7653-2635-5</dc:source>' });
  assert.deepEqual((await readMetadata(epub, { filename: 'a.epub' })).isbns, ['9780316129084', '9780765326355'], 'e-book first, then the printed book');
  assert.deepEqual((await readMetadata(makeEpub(), { filename: 'b.epub' })).isbns, []);
  const mobi = makeMobi({ html: fixtureMobiHtml(), exth: [[104, '978-0-316-12908-4'], [112, 'calibre:5678']] });
  assert.deepEqual((await readMetadata(mobi, { filename: 'c.mobi' })).isbns, ['9780316129084']);
  assert.deepEqual((await readMetadata(makeMobi({ html: fixtureMobiHtml() }), { filename: 'd.mobi' })).isbns, []);
});

test('Open Library lookup: the file\'s ISBN first, and only books like the title typed', async () => {
  const ol = standIn(inTurn({ docs: [philosopher] }, { docs: [unrelated, philosopher] }));
  const results = await createOpenLibrary({ interval: 0, fetch: ol.fetch })
    .lookup({ title: 'hp1', author: 'J.K. Rowling', isbns: ['9788702113990', '9780747532743'], language: 'da-DK' });
  assert.deepEqual(ol.calls.map((c) => [c.params.q, c.params.lang]), [['isbn:9788702113990', 'da'], ['hp1 J.K. Rowling', 'da']]);
  assert.match(ol.calls[0].headers['User-Agent'], /^eReader/);
  // The ISBN names the Danish edition, so its title wins over the work's (the English original).
  assert.deepEqual(results, [{
    key: '/works/OL82563W', title: 'Harry Potter og De Vises Sten', author: 'J. K. Rowling', year: 1997, series: [{ name: 'Harry Potter', position: 1 }],
    cover: 'https://covers.openlibrary.org/b/id/12917614-M.jpg', url: 'https://openlibrary.org/books/OL39797842M', byIsbn: true,
  }]);
});

test('Open Library lookup: the title typed picks the work or a translation, and the order', async () => {
  const ol = standIn(() => ({ docs: [philosopher] }));
  const openLibrary = createOpenLibrary({ interval: 0, fetch: ol.fetch });
  const [danish] = await openLibrary.lookup({ title: 'Harry Potter og De Vises Sten' });
  assert.deepEqual([danish.title, danish.url, danish.byIsbn], ['Harry Potter og De Vises Sten', 'https://openlibrary.org/books/OL39797842M', false]);
  const [english] = await openLibrary.lookup({ title: "Harry Potter and the Philosopher's Stone" });
  assert.deepEqual([english.title, english.url, english.cover], [
    "Harry Potter and the Philosopher's Stone", 'https://openlibrary.org/works/OL82563W', 'https://covers.openlibrary.org/b/id/15155833-M.jpg',
  ]);
  assert.equal(ol.calls[0].params.lang, undefined, 'no language, no preference');

  // Query syntax is taken out ("Adler-Olsen" would leave out "Olsen"). No match with the author: again without.
  const tieIn = { key: '/works/OL2W', title: 'Leviathan Wakes (The Expanse, #1)', author_name: ['J. Corey', 'J. Corey'] };
  const expanse = standIn(inTurn({ docs: [] }, { docs: [boxSet, leviathan, tieIn] }));
  const results = await createOpenLibrary({ interval: 0, fetch: expanse.fetch })
    .lookup({ title: 'Leviathan Wakes: A Novel', author: 'Corey, James S. A. (Ty Franck & Daniel Abraham)', language: 'en' });
  assert.deepEqual(expanse.calls.map((c) => [c.params.q, c.params.limit]), [['Leviathan Wakes A Novel Corey, James S. A. Ty Franck Daniel Abraham', '8'], ['Leviathan Wakes A Novel', '8']]);
  // Closest titles first, otherwise in Open Library's order.
  assert.deepEqual(results.map((m) => [m.title, m.author, m.year, m.series]), [
    ['Leviathan Wakes', 'James S. A. Corey', 2009, [{ name: 'The Expanse', position: 1 }]],
    // A series named in the title is taken out of it, as when a book is uploaded.
    ['Leviathan Wakes', 'J. Corey', null, [{ name: 'The Expanse', position: 1 }]],
    [boxSet.title, 'James S. A. Corey', 2019, []],
  ]);
});

test('Open Library failures are reported, and what was found before is kept', async () => {
  const failing = async (reply) => createOpenLibrary({ interval: 0, fetch: standIn(inTurn(reply)).fetch }).lookup({ title: 'Dune' });
  await assert.rejects(failing({ status: 503, body: 'Down for maintenance' }), (err) => err instanceof LookupError && /\(error 503\)/.test(err.message));
  await assert.rejects(failing({ status: 429 }), /busy/);
  await assert.rejects(failing(new TypeError('fetch failed')), /did not answer/);
  await assert.rejects(failing({ body: '<html>' }), LookupError);

  const ol = standIn(inTurn({ docs: [leviathan] }, { status: 500 }));
  const results = await createOpenLibrary({ interval: 0, fetch: ol.fetch }).lookup({ title: 'Leviathan Wakes', isbns: ['9780316129084'] });
  assert.deepEqual(results.map((m) => [m.title, m.byIsbn]), [['Leviathan Wakes', true]]);
});

test('requests to Open Library are spaced out', async () => {
  const ol = standIn(() => ({ docs: [] }));
  const results = await createOpenLibrary({ interval: 150, fetch: ol.fetch }).lookup({ title: 'Nothing', author: 'Nobody' });
  assert.deepEqual(results, []);
  assert.equal(ol.calls.length, 2);
  assert.ok(ol.calls[1].at - ol.calls[0].at >= 140, `the second request waited (${ol.calls[1].at - ol.calls[0].at} ms)`);
});

// ---- the API ----

let server, origin, dataDir, jens, anna;
let answer = () => ({ docs: [] });
const site = standIn((params, i) => answer(params, i));
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-lookup-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1, openLibrary: createOpenLibrary({ interval: 0, fetch: site.fetch }) });
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

const upload = async (c, name, body) => {
  const r = await c('/api/books', { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name) } });
  assert.equal(r.status, 202);
  for (let i = 0; i < 200; i++) {
    const { data } = await c(`/api/books/${r.data.book.id}`);
    if (data.book.status !== 'processing') return data.book;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('timeout');
};
const lookup = (c, id, query) => c(`/api/books/${id}/lookup?${new URLSearchParams(query)}`);

test('looking a book up from the edit form', async () => {
  // The library already has the series, spelled its own way.
  const cw = await upload(jens, 'cw.mobi', makeMobi({ html: fixtureMobiHtml(), title: "Caliban's War (Expanse, #2)" }));
  assert.deepEqual(cw.series.map((s) => s.name), ['Expanse']);
  const lw = await upload(jens, 'lw.epub', makeEpub({ title: 'Leviathan Wakes', author: 'James S. A. Corey', metadata: '<dc:identifier opf:scheme="ISBN">9780316129084</dc:identifier>' }));

  answer = (params) => ({ docs: params.q.startsWith('isbn:') ? [leviathan] : [leviathan, boxSet] });
  site.calls.length = 0;
  let r = await lookup(jens, lw.id, { title: 'Leviathan Wakes', author: 'James S. A. Corey' });
  assert.equal(r.status, 200);
  assert.deepEqual(site.calls.map((c) => [c.params.q, c.params.lang]), [['isbn:9780316129084', 'en'], ['Leviathan Wakes James S. A. Corey', 'en']]);
  // "The Expanse" on Open Library is the library's "Expanse", so the book would join it.
  assert.deepEqual(r.data.results.map((m) => [m.title, m.byIsbn, m.series]), [
    ['Leviathan Wakes', true, [{ name: 'Expanse', position: 1 }]],
    [boxSet.title, false, []],
  ]);
  assert.equal((await jens(`/api/books/${lw.id}`)).data.book.title, 'Leviathan Wakes', 'looking up changes nothing');

  // A MOBI's ISBN is enough without a title; a book without one needs a title.
  const mobi = await upload(jens, 'isbn.mobi', makeMobi({ html: fixtureMobiHtml(), exth: [[104, '0-316-12908-9']] }));
  site.calls.length = 0;
  r = await lookup(jens, mobi.id, { title: '' });
  assert.equal(r.status, 200);
  assert.deepEqual(site.calls.map((c) => c.params.q), ['isbn:9780316129084']);
  assert.equal((await lookup(jens, cw.id, { title: ' ' })).status, 400);

  // Only those who can edit the book can look it up.
  assert.equal((await lookup(anna, lw.id, { title: 'Leviathan Wakes' })).status, 403);
  assert.equal((await lookup(jens, 'ffffffffffffffff', { title: 'Leviathan Wakes' })).status, 404);
  assert.equal((await lookup(client(), lw.id, { title: 'Leviathan Wakes' })).status, 401);

  answer = () => ({ status: 503 });
  r = await lookup(jens, cw.id, { title: "Caliban's War" });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Open Library could not search just now/);
});
