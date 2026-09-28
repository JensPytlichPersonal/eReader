import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { createMissingBooks, missingBooks, pickSeries } from '../server/missing.js';
import { LookupError } from '../server/lookup.js';
import { gaps, inOrder, missingBooks as toShow } from '../public/js/missing.js';
import { makeEpub } from './helpers/make-epub.mjs';

// The Expanse as Hardcover's series() gives it, with a novella at 1.5 and a book not out yet.
const entry = (position, title, { author = 'James S. A. Corey', upcoming = false } = {}) => ({ position, title, author, upcoming, url: `https://hardcover.app/id/book/${position * 10}` });
const expanse = {
  name: 'The Expanse', author: 'James S. A. Corey', url: 'https://hardcover.app/id/series/26',
  books: [entry(1, 'Leviathan Wakes'), entry(1.5, 'The Butcher of Anderson Station'), entry(2, "Caliban's War"), entry(3, "Abaddon's Gate"), entry(4, 'Cibola Burn'), entry(9, 'Leviathan Falls'), entry(10, 'Announced', { upcoming: true })],
};
// Another series of almost the same name, by someone else.
const namesake = { name: 'Expanse', author: 'Someone Else', url: 'https://hardcover.app/id/series/27', books: [entry(1, 'Far Away', { author: 'Someone Else' })] };
const quiet = { error() {} };

test('the series Hardcover has under a name is taken only when it is the library\'s', () => {
  const corey = (title, position) => ({ title, author: 'James S. A. Corey', position });
  const pick = (name, books) => pickSeries([namesake, expanse], { name, books })?.url ?? null;
  // Its titles, name and author; not the namesake, which comes first.
  assert.equal(pick('Expanse', [corey('Leviathan Wakes', 1), corey('Cibola Burn', 4)]), expanse.url);
  // Translated titles: the name and the author are enough.
  assert.equal(pick('The Expanse', [corey('Leviathan vågner', 1)]), expanse.url);
  // Two of its titles, under a name the library gave it.
  assert.equal(pick('Space opera', [corey('Leviathan Wakes', 1), corey("Caliban's War", 2)]), expanse.url);
  // The name and one title, without an author.
  assert.equal(pick('The Expanse', [{ title: 'Leviathan Wakes', author: '', position: 1 }]), expanse.url);
  // The name alone is not enough: another author's series, or books that could be anyone's.
  assert.equal(pick('The Expanse', [{ title: 'Leviathan vågner', author: 'Jens Hansen', position: 1 }]), null);
  assert.equal(pick('The Expanse', [{ title: 'Leviathan vågner', author: '', position: 1 }]), null);
});

test('the books the library lacks are the main ones with a number and a title it has not', () => {
  const lacking = (books) => missingBooks(expanse, books).map((e) => e.position);
  assert.deepEqual(lacking([{ title: 'Leviathan Wakes', position: 1 }, { title: "Caliban's War", position: 2 }, { title: 'Cibola Burn', position: 4 }]), [3, 9, 10]);
  // A book the library has without a number, or with another one, is not missing.
  assert.deepEqual(lacking([{ title: 'Leviathan Wakes', position: 1 }, { title: "Abaddon's Gate", position: null }, { title: 'Cibola Burn', position: 5 }]), [2, 9, 10]);
  assert.deepEqual(missingBooks(expanse, [{ title: 'Leviathan Wakes', position: 1 }])[1], entry(3, "Abaddon's Gate"));
  // "Dune Messiah" is not "Dune".
  const dune = { books: [entry(1, 'Dune'), entry(2, 'Dune Messiah'), entry(3, 'Children of Dune')] };
  assert.deepEqual(missingBooks(dune, [{ title: 'Dune', position: 1 }]).map((e) => e.title), ['Dune Messiah', 'Children of Dune']);
  // An omnibus holds the books in it.
  assert.deepEqual(lacking([{ title: 'Leviathan Wakes', position: 1 }, { title: 'The Expanse Books 2-4', position: 2, positionEnd: 4 }]), [9, 10]);
});

// Books of a series in the library, by their places: a number, or [first, last] for an omnibus.
const at = (...places) => places.map((p) => (Array.isArray(p) ? { position: p[0], positionEnd: p[1] } : { position: p }));

test('the library shows gaps in the numbers, and what Hardcover lists in their place', () => {
  assert.deepEqual(gaps(at(1, 2, 4)), [3]);
  assert.deepEqual(gaps(at(1, 4.5, null)), [2, 3, 4]);
  assert.deepEqual(gaps(at(3)), [1, 2]);
  assert.deepEqual(gaps(at(1, 2, 2.5, 3)), []);
  assert.deepEqual(gaps(at(null, null)), []);
  assert.equal(gaps(at(2019, 2020)), null, 'numbered by year, not book after book');
  // An omnibus holds every book in it: with #1–3 and #5 only #4 is missing.
  assert.deepEqual(gaps(at([1, 3], 5)), [4]);
  assert.deepEqual(gaps(at(1, [4, 6])), [2, 3]);

  const answer = { series: { name: 'The Expanse', url: expanse.url }, missing: missingBooks(expanse, [{ title: 'Leviathan Wakes', position: 1 }, { title: 'Cibola Burn', position: 4 }]) };
  // A shelf shows the gaps, with Hardcover's titles; the series' page every book the library lacks.
  assert.deepEqual(toShow(at(1, 4), answer).map((m) => [m.position, m.title]), [[2, "Caliban's War"], [3, "Abaddon's Gate"]]);
  assert.deepEqual(toShow(at(1, 4), answer, { all: true }).map((m) => m.position), [2, 3, 9, 10]);
  // Until Hardcover answers, or when it has no such series, the gaps show with only their number.
  assert.deepEqual(toShow(at(1, 4), null), [{ position: 2 }, { position: 3 }]);
  assert.deepEqual(toShow(at(1, 4), { series: null, missing: [] }, { all: true }), [{ position: 2 }, { position: 3 }]);
  // Hardcover knows the series has no #3: no gap there. Books added since it answered are not missing.
  assert.deepEqual(toShow(at(1, 2, 4), { series: answer.series, missing: [] }), []);
  assert.deepEqual(toShow(at(1, 2, 4), answer).map((m) => m.position), [3]);
  assert.deepEqual(toShow(at(1, [2, 3], 4), answer, { all: true }).map((m) => m.position), [9, 10]);

  // In the library's order, an omnibus after the books it holds.
  const book = (name, position, positionEnd) => ({ book: name, position, positionEnd });
  const order = (items, missing) => inOrder(items, missing.map((position) => ({ position }))).map((i) => i.book ?? `#${i.missing.position}`);
  assert.deepEqual(order([book('one', 1), book('two', 2), book('three', 3), book('omnibus', 1, 3), book('five', 5), book('extra', null)], [4, 6]),
    ['one', 'two', 'three', 'omnibus', '#4', 'five', '#6', 'extra']);
  assert.deepEqual(order([book('one', 1), book('omnibus', 4, 6)], [2, 3, 7]), ['one', '#2', '#3', 'omnibus', '#7']);
});

test('Hardcover is asked once a day for a series, one lookup at a time', async () => {
  const asked = [];
  let reply = async () => [expanse];
  const catalogue = { series: async (name) => { asked.push({ name, at: Date.now() }); return reply(name); } };
  const books = [{ title: 'Leviathan Wakes', author: 'James S. A. Corey', position: 1 }];

  let missing = createMissingBooks({ catalogue, interval: 0, log: quiet });
  // Asked once for both, however the name is written, and kept.
  const [first, second] = await Promise.all([missing.forSeries({ name: 'The Expanse', books }), missing.forSeries({ name: 'the  expanse', books })]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.series, { name: 'The Expanse', url: expanse.url });
  assert.deepEqual(first.missing.map((m) => m.position), [2, 3, 4, 9, 10]);
  await missing.forSeries({ name: 'The Expanse', books: [...books, { title: "Caliban's War", author: '', position: 2 }] });
  assert.equal(asked.length, 1);
  // No series of that name, or none that fits: nothing is missing.
  reply = async () => [namesake];
  assert.deepEqual(await missing.forSeries({ name: 'Leviathan', books }), { series: null, missing: [] });

  // A catalogue that cannot be asked is not asked again for a while; a bug is not kept.
  reply = async () => { throw new LookupError('Hardcover is busy.'); };
  missing = createMissingBooks({ catalogue, interval: 0, log: quiet });
  asked.length = 0;
  await assert.rejects(missing.forSeries({ name: 'The Expanse', books }), /busy/);
  await assert.rejects(missing.forSeries({ name: 'The Expanse', books }), /busy/);
  assert.equal(asked.length, 1);
  missing = createMissingBooks({ catalogue, interval: 0, retry: 0, keep: 0, log: quiet });
  reply = async () => { throw new TypeError('bug'); };
  await assert.rejects(missing.forSeries({ name: 'The Expanse', books }), TypeError);
  reply = async () => [expanse];
  assert.equal((await missing.forSeries({ name: 'The Expanse', books })).series.url, expanse.url);
  await missing.forSeries({ name: 'The Expanse', books });
  assert.equal(asked.length, 4, 'asked again once nothing is kept');

  // Lookups of different series are spaced out.
  missing = createMissingBooks({ catalogue, interval: 150, log: quiet });
  asked.length = 0;
  await Promise.all(['A', 'B'].map((name) => missing.forSeries({ name, books })));
  assert.equal(asked.length, 2);
  assert.ok(asked[1].at - asked[0].at >= 140, `the second lookup waited (${asked[1].at - asked[0].at} ms)`);
});

// ---- the API ----

let server, origin, dataDir, jens, anna;
const asked = [];
let reply = async () => [namesake, expanse];
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-missing-'));
  const catalogue = { series: async (name) => { asked.push(name); return reply(name); } };
  const created = createApp({ dataDir, quiet: true, sessionDays: 1, hardcover: null, missingBooks: createMissingBooks({ catalogue, interval: 0, keep: 0, retry: 0, log: quiet }) });
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

function client(at = () => origin) {
  let cookie = '';
  return async (p, { method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (Buffer.isBuffer(body)) { payload = body; h['content-type'] ??= 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(at() + p, { method, headers: h, body: payload });
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
const calibre = (name, index) => `<meta name="calibre:series" content="${name}"/><meta name="calibre:series_index" content="${index}"/>`;
const coreyBook = (title, metadata) => makeEpub({ title, author: 'James S. A. Corey', metadata });

test('every reader can see which books of a series the library lacks', async () => {
  await upload(jens, 'lw.epub', coreyBook('Leviathan Wakes', calibre('Expanse', 1)));
  const club = '<meta property="belongs-to-collection" id="club">Book club</meta><meta refines="#club" property="collection-type">set</meta>';
  const cibola = await upload(jens, 'cb.epub', coreyBook('Cibola Burn', calibre('Expanse', 4) + club));
  const [{ id }, set] = cibola.series;
  const r = await anna(`/api/series/${id}/missing`);
  assert.equal(r.status, 200);
  assert.deepEqual(asked, ['Expanse']);
  assert.deepEqual(r.data.series, { name: 'The Expanse', url: expanse.url });
  assert.deepEqual(r.data.missing, [2, 3, 9, 10].map((p) => expanse.books.find((e) => e.position === p)));

  // A collection without numbers lacks nothing, and Hardcover is not asked.
  assert.deepEqual([set.name, set.position], ['Book club', null]);
  assert.deepEqual((await anna(`/api/series/${set.id}/missing`)).data, { series: null, missing: [] });
  assert.equal(asked.length, 1);
  assert.equal((await anna('/api/series/99999/missing')).status, 404);
  assert.equal((await client()(`/api/series/${id}/missing`)).status, 401);
  // Changing a series is still for admins.
  assert.equal((await anna(`/api/series/${id}`, { method: 'PATCH', body: { name: 'Mine' } })).status, 403);

  // An omnibus holds the books in it.
  const omnibus = await upload(jens, 'omnibus.epub', coreyBook('The Expanse Books 2-3', calibre('Expanse', '2-3')));
  assert.deepEqual(omnibus.series.map((s) => [s.id, s.position, s.positionEnd]), [[id, 2, 3]]);
  assert.deepEqual((await anna(`/api/series/${id}/missing`)).data.missing.map((m) => m.position), [9, 10]);

  reply = async () => { throw new LookupError('Hardcover did not answer. Try again in a moment.'); };
  const failed = await anna(`/api/series/${id}/missing`);
  assert.deepEqual([failed.status, failed.data.error], [502, 'Hardcover did not answer. Try again in a moment.']);
});

test('without a Hardcover token no series lacks anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-nomissing-'));
  const created = createApp({ dataDir: dir, quiet: true, hardcover: null, hardcoverToken: 'ignored when a client is given' });
  const other = created.app.listen(0);
  try {
    await new Promise((r) => other.once('listening', r));
    const solo = client(() => `http://127.0.0.1:${other.address().port}`);
    await solo('/api/auth/register', { method: 'POST', body: { username: 'solo', password: 'secret1' } });
    const book = await upload(solo, 'aa.epub', coreyBook("Abaddon's Gate", calibre('The Expanse', 3)));
    assert.deepEqual((await solo(`/api/series/${book.series[0].id}/missing`)).data, { series: null, missing: [] });
  } finally {
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
