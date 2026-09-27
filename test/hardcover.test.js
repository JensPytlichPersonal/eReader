import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { createHardcover } from '../server/hardcover.js';
import { createLookup, LookupError } from '../server/lookup.js';
import { encodePng } from '../server/converters/png.js';
import { makeEpub } from './helpers/make-epub.mjs';

// Books as Hardcover's GraphQL API sends them, with the fields asked for.
const leviathan = {
  id: 427, title: 'Leviathan Wakes', release_year: 2011, image: { url: 'https://assets.hardcover.app/books/427/cover.jpg' },
  contributions: [{ contribution: null, author: { name: 'James S. A. Corey' } }, { contribution: 'Narrator', author: { name: 'Jefferson Mays' } }],
  book_series: [{ position: 1, featured: false, series: { name: 'The Expanse Universe' } }, { position: 1, featured: true, series: { name: 'The Expanse' } }],
};
const graphicNovel = {
  id: 999, title: 'Leviathan Wakes: The Graphic Novel', release_year: 2021, image: null,
  contributions: [{ contribution: 'Author', author: { name: 'James S. A. Corey' } }, { contribution: 'Illustrator', author: { name: 'Huang Danlan' } }], book_series: [],
};
const PNG = encodePng({ width: 2, height: 3, kind: 2, data: new Uint8Array(18).fill(90) });

/**
 * A stand-in for Hardcover: `answer(operation, variables)` gives the GraphQL data, or { status, body },
 * or throws. Pictures are fetched with GET and come from `pictures`.
 */
function standIn(answer, pictures = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    if (!init.method) {
      calls.push({ picture: url });
      return url in pictures ? new Response(pictures[url]) : new Response('', { status: 404 });
    }
    const { query, variables } = JSON.parse(init.body);
    const operation = /query (\w+)/.exec(query)[1];
    calls.push({ operation, variables, headers: init.headers });
    const reply = await answer(operation, variables);
    if (reply.status) return new Response(reply.body ?? '', { status: reply.status });
    return new Response(JSON.stringify(reply.errors ? reply : { data: reply }));
  };
  return { calls, fetch };
}

test('Hardcover lookup: a search, then the books it found and the file\'s edition', async () => {
  const site = standIn((operation) => (operation === 'Search'
    ? { search: { ids: ['999', '427'] } }
    : { books: [leviathan, graphicNovel], editions: [{ title: 'Leviathan Wakes', book: leviathan }] }));
  const hardcover = createHardcover({ token: 'abc123', fetch: site.fetch });
  const results = await hardcover.lookup({ title: 'Leviathan Wakes', author: 'James S. A. Corey', isbns: ['9780316129084'] });
  assert.deepEqual(site.calls.map((c) => [c.operation, c.variables]), [
    ['Search', { q: 'Leviathan Wakes James S. A. Corey' }],
    ['Details', { ids: [999, 427], isbns: ['9780316129084'] }],
  ]);
  assert.equal(site.calls[0].headers.authorization, 'Bearer abc123');
  assert.match(site.calls[0].headers['user-agent'], /^eReader/);
  assert.deepEqual(results, [
    {
      key: 'hardcover:427', source: 'hardcover', title: 'Leviathan Wakes', author: 'James S. A. Corey', year: 2011,
      // The featured series first; the narrator is not an author.
      series: [{ name: 'The Expanse', position: 1 }, { name: 'The Expanse Universe', position: 1 }],
      cover: 'https://assets.hardcover.app/books/427/cover.jpg', coverSource: 'hardcover', coverId: 427,
      url: 'https://hardcover.app/id/book/427', byIsbn: true,
    },
    {
      key: 'hardcover:999', source: 'hardcover', title: 'Leviathan Wakes: The Graphic Novel', author: 'James S. A. Corey', year: 2021,
      series: [], cover: null, coverSource: null, coverId: null, url: 'https://hardcover.app/id/book/999', byIsbn: false,
    },
  ]);

  // A token copied with "Bearer " in front is sent as it is; without a title only the ISBN is looked up.
  const isbnOnly = standIn(() => ({ books: [], editions: [] }));
  assert.deepEqual(await createHardcover({ token: 'Bearer abc123', fetch: isbnOnly.fetch }).lookup({ isbns: ['9780316129084'] }), []);
  assert.deepEqual(isbnOnly.calls.map((c) => [c.operation, c.headers.authorization]), [['Details', 'Bearer abc123']]);
});

test('Hardcover failures say what to do', async () => {
  const failing = (reply) => createHardcover({ token: 'abc', fetch: standIn(() => { if (reply instanceof Error) throw reply; return reply; }).fetch }).lookup({ title: 'Dune' });
  await assert.rejects(failing({ status: 401, body: '{"error":"invalid_token"}' }), (err) => err instanceof LookupError && /did not accept the token/.test(err.message));
  await assert.rejects(failing({ status: 403, body: '{"error":"insufficient_scope"}' }), /read:catalog/);
  await assert.rejects(failing({ status: 429 }), /busy/);
  await assert.rejects(failing({ errors: [{ message: "field 'ids' not found in type: 'SearchOutput'" }] }), /Hardcover could not look it up: field 'ids' not found/);
  await assert.rejects(failing(new TypeError('fetch failed')), /Hardcover did not answer/);
});

test('Hardcover covers are fetched from the address Hardcover gives, if it is a public one', async () => {
  const url = leviathan.image.url;
  const site = standIn((operation, { id }) => ({ books: id === 427 ? [{ image: { url } }] : id === 5 ? [{ image: { url: 'https://10.0.0.8/cover.jpg' } }] : [{ image: null }] }), { [url]: PNG });
  const hardcover = createHardcover({ token: 'abc', fetch: site.fetch });
  assert.deepEqual(await hardcover.cover(427), PNG);
  assert.deepEqual(site.calls.map((c) => c.operation ?? c.picture), ['Cover', url]);
  await assert.rejects(hardcover.cover(5), /no cover/, 'an address inside a network is not fetched');
  await assert.rejects(hardcover.cover(6), /no cover/);
  assert.equal(site.calls.filter((c) => c.picture).length, 1);
  await assert.rejects(hardcover.cover('427'), TypeError);
});

// ---- both catalogues ----

const match = (fields) => ({ series: [], cover: null, coverSource: null, coverId: null, byIsbn: false, year: null, url: '', ...fields });
const catalogue = (lookup, cover = async () => PNG) => ({ lookup, cover });

test('a book found in both catalogues is offered once, with what only one of them had', async () => {
  const fromHardcover = [
    match({ key: 'hardcover:427', source: 'hardcover', title: 'Leviathan Wakes', author: 'James S. A. Corey', series: [{ name: 'The Expanse', position: 1 }] }),
    match({ key: 'hardcover:500', source: 'hardcover', title: 'Leviathan Falls', author: 'James S. A. Corey' }),
  ];
  const fromOpenLibrary = [
    match({ key: '/works/OL1W', source: 'openlibrary', title: 'Leviathan wakes', author: 'James S.A. Corey', cover: 'https://covers.openlibrary.org/b/id/7-M.jpg', coverSource: 'openlibrary', coverId: 7 }),
    match({ key: '/works/OL2W', source: 'openlibrary', title: 'Leviathan Wakes', author: 'Someone Else' }),
  ];
  const lookups = createLookup({ hardcover: catalogue(async () => fromHardcover), openLibrary: catalogue(async () => fromOpenLibrary) });
  assert.deepEqual(lookups.sources, ['hardcover', 'openlibrary']);
  const { results, problems } = await lookups.lookup({ title: 'Leviathan Wakes', author: 'James S. A. Corey' });
  assert.deepEqual(problems, []);
  assert.deepEqual(results.map((m) => [m.key, m.series.length, m.coverSource, m.coverId]), [
    ['hardcover:427', 1, 'openlibrary', 7], // Hardcover's series, Open Library's cover
    ['/works/OL2W', 0, null, null], // another author: another book
    ['hardcover:500', 0, null, null],
  ]);

  // Open Library found it by the file's ISBN and Hardcover by its title: still Hardcover's, at the top.
  const byIsbn = { ...fromOpenLibrary[0], byIsbn: true, series: [{ name: 'Expanse', position: 1 }] };
  const both = createLookup({ hardcover: catalogue(async () => [fromHardcover[0]]), openLibrary: catalogue(async () => [fromOpenLibrary[1], byIsbn]) });
  const [top, ...rest] = (await both.lookup({ title: 'Leviathan Wakes' })).results;
  assert.deepEqual([top.key, top.byIsbn, top.series, top.coverSource], ['hardcover:427', true, [{ name: 'The Expanse', position: 1 }], 'openlibrary']);
  assert.deepEqual(rest.map((m) => m.key), ['/works/OL2W']);
});

test('when one catalogue cannot be asked the other still answers, and the reason is passed on', async () => {
  const leviathanWakes = match({ key: '/works/OL1W', source: 'openlibrary', title: 'Leviathan Wakes', author: 'James S. A. Corey' });
  const expired = catalogue(async () => { throw new LookupError('Hardcover did not accept the token.'); });
  let lookups = createLookup({ hardcover: expired, openLibrary: catalogue(async () => [leviathanWakes]) });
  assert.deepEqual(await lookups.lookup({ title: 'Leviathan Wakes' }), { results: [leviathanWakes], problems: ['Hardcover did not accept the token.'] });
  // Nothing found is not a failure.
  lookups = createLookup({ hardcover: expired, openLibrary: catalogue(async () => []) });
  assert.deepEqual(await lookups.lookup({ title: 'Nothing' }), { results: [], problems: ['Hardcover did not accept the token.'] });
  lookups = createLookup({ hardcover: expired, openLibrary: catalogue(async () => { throw new LookupError('Open Library did not answer.'); }) });
  await assert.rejects(lookups.lookup({ title: 'Leviathan Wakes' }), { message: 'Hardcover did not accept the token. Open Library did not answer.' });
  // Without a token only Open Library is asked; a bug is not passed off as a catalogue's problem.
  lookups = createLookup({ openLibrary: catalogue(async () => { throw new TypeError('bug'); }) });
  assert.deepEqual(lookups.sources, ['openlibrary']);
  await assert.rejects(lookups.lookup({ title: 'Leviathan Wakes' }), TypeError);
});

// ---- the API ----

let server, origin, dataDir, jens;
const covers = [];
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-hardcover-'));
  const hardcover = catalogue(
    async () => [match({ key: 'hardcover:427', source: 'hardcover', title: 'Leviathan Wakes', author: 'James S. A. Corey', series: [{ name: 'The Expanse', position: 1 }], cover: leviathan.image.url, coverSource: 'hardcover', coverId: 427 })],
    async (id) => { covers.push(id); return PNG; },
  );
  const openLibrary = catalogue(async () => { throw new LookupError('Open Library did not answer. Try again in a moment.'); });
  const created = createApp({ dataDir, quiet: true, sessionDays: 1, openLibrary, hardcover });
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  jens = client();
  await jens('/api/auth/register', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
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

const upload = async (name, body) => {
  const r = await jens('/api/books', { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name) } });
  assert.equal(r.status, 202);
  for (let i = 0; i < 200; i++) {
    const { data } = await jens(`/api/books/${r.data.book.id}`);
    if (data.book.status !== 'processing') return data.book;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('timeout');
};

test('looking up with Hardcover, and using its cover', async () => {
  const book = await upload('lw.epub', makeEpub({ title: 'Leviathan Wakes' }));
  let r = await jens(`/api/books/${book.id}/lookup?${new URLSearchParams({ title: 'Leviathan Wakes' })}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((m) => [m.source, m.title, m.series]), [['hardcover', 'Leviathan Wakes', [{ name: 'The Expanse', position: 1 }]]]);
  assert.deepEqual(r.data.notes, ['Open Library did not answer. Try again in a moment.']);

  r = await jens(`/api/books/${book.id}/cover`, { method: 'PUT', body: { source: 'hardcover', coverId: 427 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.book.coverSource, 'custom');
  assert.deepEqual(covers, [427]);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'books', book.id, 'custom-cover.png')), PNG);
});

test('a server without a Hardcover token does not take Hardcover covers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-nohardcover-'));
  const created = createApp({ dataDir: dir, quiet: true, hardcover: null, hardcoverToken: 'ignored when a client is given' });
  const other = created.app.listen(0);
  try {
    await new Promise((r) => other.once('listening', r));
    const at = `http://127.0.0.1:${other.address().port}`;
    const res = await fetch(`${at}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'solo', password: 'secret1' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const up = await fetch(`${at}/api/books`, { method: 'POST', headers: { cookie, 'x-file-name': 'a.epub', 'content-type': 'application/octet-stream' }, body: makeEpub() });
    const { book } = await up.json();
    const r = await fetch(`${at}/api/books/${book.id}/cover`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hardcover', coverId: 427 }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Hardcover is not set up/);
  } finally {
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
