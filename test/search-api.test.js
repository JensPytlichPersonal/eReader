import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { parseSection, positionText } from '../server/fixes.js';
import { makeEpub } from './helpers/make-epub.mjs';

// `id`: the book most tests search.
let server, origin, db, dataDir, jens, anna, id;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-search-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
  ({ db } = created);
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  jens = client();
  await jens('/api/auth/register', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
  await jens('/api/users', { method: 'POST', body: { username: 'anna', password: 'pass1234', displayName: 'Anna' } });
  anna = client();
  await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'pass1234' } });
  id = await upload('Search.epub', epub());
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
    if (data.book.status !== 'processing') return data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
};
const upload = async (name, body) => {
  const r = await jens('/api/books', { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name) } });
  assert.equal(r.status, 202);
  const detail = await waitReady(r.data.book.id);
  assert.equal(detail.book.status, 'ready');
  return r.data.book.id;
};
const section = async (id, n = 0) => (await jens(`/books/${id}/sections/${n}.html`)).data;
const search = (who, id, q) => who(`/api/books/${id}/search?q=${encodeURIComponent(q)}`);
// The words a hit stands for, cut out of its section as the reader counts places there.
const cut = async (id, hit) => positionText(parseSection(await section(id, hit.section)).children).slice(hit.offset, hit.offset + hit.length);

const CHAPTERS = [
  { id: 'ch1', file: 'ch1.xhtml', title: 'Chapter One', body: '<h1 id="c1">Chapter One</h1>'
    + '<p>Call me <em>Ish</em>mael. Some years\n   ago, never <a href="ch2.xhtml">mind how</a> long.</p>'
    + '<p>It was the end.</p><p>Start again.</p>'
    + '<p>\u201CIt\u2019s mine,\u201D he said of the WHALE.</p><p>Han gik hjem til gården.</p>' },
  { id: 'ch2', file: 'ch2.xhtml', title: 'Chapter Two', body: `<h1>Chapter Two</h1><p>${'A whale. '.repeat(250)}</p>` },
];
let books = 0;
// A new copy of the book each time: the same file is not added twice.
const epub = () => makeEpub({ title: `Search Book ${++books}`, chapters: CHAPTERS });

test('search needs a signed-in reader, any reader, and a book that is there', async () => {
  assert.equal((await search(client(), id, 'whale')).status, 401);
  assert.equal((await search(jens, '0000000000000000', 'whale')).status, 404);
  const r = await search(anna, id, 'whale');
  assert.equal(r.status, 200);
  assert.equal(r.data.query, 'whale');
});

test('a search shorter than 2 characters or longer than 200 is refused', async () => {
  for (const q of ['', 'a', '  a  ', '\u00AD\u00ADa']) {
    const r = await search(jens, id, q);
    assert.equal(r.status, 400, JSON.stringify(q));
    assert.equal(r.data.error, 'Type at least 2 characters to search for');
  }
  assert.equal((await jens(`/api/books/${id}/search`)).status, 400);
  assert.equal((await jens(`/api/books/${id}/search?q=ab&q=cd`)).status, 400);
  const long = await search(jens, id, 'x'.repeat(201));
  assert.equal(long.status, 400);
  assert.equal(long.data.error, 'Search for 200 characters at most');
  // White space runs count as one character.
  assert.equal((await search(jens, id, `${'x'.repeat(100)}      ${'x'.repeat(99)}`)).status, 200);
});

test('a hit is a place as the reader counts them, and holds the words as the book has them', async () => {
  const r = await search(jens, id, 'ishmael. some years ago');
  assert.equal(r.data.total, 1);
  const [hit] = r.data.hits;
  assert.equal(hit.section, 0);
  assert.equal(await cut(id, hit), 'Ishmael. Some years\n   ago');
  assert.equal(hit.match, 'Ishmael. Some years ago');
  assert.equal(hit.before, 'Call me ');
  assert.equal(hit.after, ', never mind how long.');
  assert.equal(hit.title, 'Chapter One');
  const across = (await search(jens, id, 'never mind how long')).data.hits[0];
  assert.equal(await cut(id, across), 'never mind how long');
});

test('case does not matter, and the places come in book order with the chapter and how far in they are', async () => {
  const { data } = await search(jens, id, 'WHALE');
  const { manifest } = (await jens(`/api/books/${id}`)).data;
  assert.equal(data.version, manifest.convertedAt);
  assert.equal(data.hits[0].match, 'WHALE');
  assert.equal(await cut(id, data.hits[0]), 'WHALE');
  assert.equal(data.hits[1].match, 'whale');
  assert.equal(await cut(id, data.hits[1]), 'whale');
  assert.deepEqual([...new Set(data.hits.map((h) => h.title))], ['Chapter One', 'Chapter Two']);
  const last = data.hits[data.hits.length - 1];
  const s = manifest.sections[last.section];
  assert.equal(last.percent, (s.start + last.offset) / manifest.totalChars);
  assert.ok(data.hits.every((h, i) => !i || h.section > data.hits[i - 1].section || h.offset > data.hits[i - 1].offset));
});

test('a phrase is not found across two paragraphs', async () => {
  assert.equal((await search(jens, id, 'end. start')).data.total, 0);
  assert.equal((await search(jens, id, 'end.start')).data.total, 0);
  assert.equal((await search(jens, id, 'the end.')).data.total, 1);
});

test('curly quotes in the book are found with straight ones', async () => {
  const { data } = await search(jens, id, '"it\'s mine,"');
  assert.equal(data.total, 1);
  assert.equal(await cut(id, data.hits[0]), '\u201CIt\u2019s mine,\u201D');
});

test('"gard" does not find "gården"', async () => {
  assert.equal((await search(jens, id, 'gard')).data.total, 0);
  assert.equal((await search(jens, id, 'GÅRDEN')).data.total, 1);
});

test('the first 200 places are answered, with how many there are', async () => {
  const { data } = await search(jens, id, 'whale');
  assert.equal(data.total, 251);
  assert.equal(data.hits.length, 200);
  assert.equal((await search(jens, id, 'no such words')).data.total, 0);
});

test('a fix to the text gives the places of the new version', async () => {
  const own = await upload('Fixed.epub', epub());
  const first = (await search(jens, own, 'the WHALE')).data;
  const r = await jens(`/api/books/${own}/fixes`, { method: 'POST', body: {
    section: 0, paragraph: 1, before: ['Call me Ishmael. Some years ago, never mind how long.'], after: ['Call me Ishmael. Some years ago, never mind how long it was.'],
  } });
  assert.equal(r.status, 201);
  const now = (await search(jens, own, 'the WHALE')).data;
  assert.equal(now.version, r.data.manifest.convertedAt);
  assert.notEqual(now.version, first.version);
  assert.equal(now.hits[0].offset, first.hits[0].offset + ' it was'.length);
  assert.equal(await cut(own, now.hits[0]), 'the WHALE');
});

test('a book being converted, or that could not be, is not searched', async () => {
  db.prepare("UPDATE books SET status = 'processing' WHERE id = ?").run(id);
  let r = await search(anna, id, 'whale');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'The book is being converted. Try again in a moment.');
  db.prepare("UPDATE books SET status = 'error' WHERE id = ?").run(id);
  r = await search(anna, id, 'whale');
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'The book could not be converted, so it cannot be searched');
  db.prepare("UPDATE books SET status = 'ready' WHERE id = ?").run(id);
  assert.equal((await search(anna, id, 'whale')).status, 200);
});
