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
// Its own image is an older one; the edition Hardcover shows it with has another cover, as on the website.
const leviathan = {
  id: 427, title: 'Leviathan Wakes', release_year: 2011,
  image: { id: 11, url: 'https://assets.hardcover.app/books/427/cover.jpg' },
  default_cover_edition: { image: { id: 31, url: 'https://assets.hardcover.app/editions/31/cover.jpg' } },
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
    calls.push({ operation, query, variables, headers: init.headers });
    const reply = await answer(operation, variables);
    if (reply.status) return new Response(reply.body ?? '', { status: reply.status });
    return new Response(JSON.stringify(reply.errors ? reply : { data: reply }));
  };
  return { calls, fetch };
}

test('Hardcover lookup: the searches, then the books they found and the file\'s edition', async () => {
  // The file's edition has no cover or authors of its own, so the book's are used.
  const site = standIn((operation) => (operation === 'Search'
    ? { search: { ids: ['999', '427'] } }
    : { books: [leviathan, graphicNovel], editions: [{ id: 8, title: 'Leviathan Wakes', release_year: 2011, image: null, contributions: [], book: leviathan }] }));
  const hardcover = createHardcover({ token: 'abc123', fetch: site.fetch });
  const results = await hardcover.lookup({ title: 'Leviathan Wakes', author: 'James S. A. Corey', isbns: ['9780316129084'] });
  assert.deepEqual(site.calls.map((c) => [c.operation, c.variables]), [
    ['Search', { q: 'Leviathan Wakes James S. A. Corey' }],
    ['Search', { q: 'Leviathan Wakes' }],
    // The book's language is not known: no edition has "".
    ['Details', { ids: [999, 427], isbns: ['9780316129084'], language: '' }],
  ]);
  assert.equal(site.calls[0].headers.authorization, 'Bearer abc123');
  assert.match(site.calls[0].headers['user-agent'], /^eReader/);
  assert.deepEqual(results, [
    {
      key: 'hardcover:427', source: 'hardcover', title: 'Leviathan Wakes', author: 'James S. A. Corey', year: 2011,
      // The featured series first; the narrator is not an author.
      series: [{ name: 'The Expanse', position: 1 }, { name: 'The Expanse Universe', position: 1 }],
      cover: 'https://assets.hardcover.app/editions/31/cover.jpg', coverSource: 'hardcover', coverId: 31, covers: [],
      url: 'https://hardcover.app/id/book/427', byIsbn: true,
    },
    {
      key: 'hardcover:999', source: 'hardcover', title: 'Leviathan Wakes: The Graphic Novel', author: 'James S. A. Corey', year: 2021,
      series: [], cover: null, coverSource: null, coverId: null, covers: [], url: 'https://hardcover.app/id/book/999', byIsbn: false,
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
  // An answer without the list of books found is reported, not taken for "nothing found".
  await assert.rejects(failing({ search: { results: {} } }), /without a list of books/);
  await assert.rejects(failing({ search: { ids: null, error: 'Search timed out' } }), /Hardcover could not search: Search timed out/);

  // systemd splits Environment=HARDCOVER_TOKEN=Bearer eyJ... at the space, leaving only "Bearer".
  const site = standIn(() => ({ search: { ids: [] } }));
  await assert.rejects(createHardcover({ token: 'Bearer', fetch: site.fetch }).lookup({ title: 'Dune' }), /holds "Bearer" but nothing after it.*under Settings/);
  assert.equal(site.calls.length, 0, 'nothing is sent without a token');
  // A list sent as text is still read.
  const asText = standIn((operation) => (operation === 'Search' ? { search: { ids: '[427]' } } : { books: [leviathan], editions: [] }));
  const [found] = await createHardcover({ token: 'abc', fetch: asText.fetch }).lookup({ title: 'Leviathan Wakes' });
  assert.equal(found.key, 'hardcover:427');
});

test('a Hardcover match comes with the cover Hardcover\'s website shows, and the picture\'s id', async () => {
  const coverOf = async (book) => {
    const site = standIn(() => ({ search: { ids: [1] }, books: [{ id: 1, title: 'Book', ...book }], editions: [] }));
    const [found] = await createHardcover({ token: 'abc', fetch: site.fetch }).lookup({ title: 'Book' });
    return [found.cover, found.coverId];
  };
  const at = (id) => ({ id, url: `https://assets.hardcover.app/${id}.jpg` });
  // Its display edition's cover, else its own image.
  assert.deepEqual(await coverOf({ image: at(1), default_cover_edition: { image: at(2) } }), ['https://assets.hardcover.app/2.jpg', 2]);
  assert.deepEqual(await coverOf({ image: at(1), default_cover_edition: null }), ['https://assets.hardcover.app/1.jpg', 1]);
  // A picture at an address inside a network, or without an id to fetch it by, is not offered.
  assert.deepEqual(await coverOf({ image: at(1), default_cover_edition: { image: { id: 2, url: 'https://10.0.0.8/big.jpg' } } }), ['https://assets.hardcover.app/1.jpg', 1]);
  assert.deepEqual(await coverOf({ image: { url: at(1).url }, default_cover_edition: null }), [null, null]);
  assert.deepEqual(await coverOf({ image: null, default_cover_edition: null }), [null, null]);
});

// Beyond the Dark Portal as Hardcover has it. One book is listed under its title with a small cover.
// Another is listed as "World of Warcraft, Vol. 4" by other authors, and its edition has the title,
// the authors and a better cover. A third has the title but other authors.
const credit = (...names) => names.map((name) => ({ contribution: null, author: { name } }));
const portal = { id: 4001, title: 'Beyond the Dark Portal', release_year: 2008, image: { id: 800, url: 'https://assets.hardcover.app/books/4001/small.jpg' }, contributions: credit('Aaron Rosenberg', 'Christie Golden'), book_series: [], editions: [] };
const volume4 = {
  id: 5001, title: 'World of Warcraft, Vol. 4', release_year: 2010,
  image: { id: 700, url: 'https://assets.hardcover.app/books/5001/other.jpg' },
  contributions: credit('Walter Simonson', 'Louise Simonson'),
  book_series: [{ position: 4, featured: true, series: { name: 'World of Warcraft' } }],
  editions: [
    { id: 17, title: 'World of Warcraft, Vol. 4', release_year: 2010, image: null, contributions: [] },
    { id: 30562820, title: 'Beyond the Dark Portal', release_year: 2008, image: { id: 900, url: 'https://assets.hardcover.app/edition/30562820/good.jpeg' }, contributions: credit('Aaron Rosenberg', 'Christie Golden') },
  ],
};
const namesake = { id: 6001, title: 'Beyond the Dark Portal', release_year: 2020, image: null, contributions: credit('Someone Else'), book_series: [], editions: [] };

test('a book Hardcover lists under another title and authors is found by the title alone, and offered as its edition', async () => {
  const site = standIn((operation, { q, ids }) => (operation === 'Search'
    ? { search: { ids: q === 'Beyond the Dark Portal' ? [4001, 5001, 6001] : [4001] } }
    : { books: [portal, volume4, namesake].filter((b) => ids.includes(b.id)), editions: [] }));
  const hardcover = createHardcover({ token: 'abc', fetch: site.fetch });
  const results = await hardcover.lookup({ title: 'Beyond the Dark Portal', author: 'Aaron Rosenberg, Christie Golden' });
  assert.deepEqual(site.calls.map((c) => [c.operation, c.variables.q ?? c.variables.ids]), [
    ['Search', 'Beyond the Dark Portal Aaron Rosenberg, Christie Golden'],
    ['Search', 'Beyond the Dark Portal'],
    ['Details', [4001, 5001, 6001]],
  ]);
  // Volume 4 comes as its edition, with the book's series; the namesake by someone else is left out.
  assert.deepEqual(results.map((m) => [m.key, m.title, m.author, m.year, m.series, m.cover, m.coverId]), [
    ['hardcover:4001', 'Beyond the Dark Portal', 'Aaron Rosenberg, Christie Golden', 2008, [], 'https://assets.hardcover.app/books/4001/small.jpg', 800],
    ['hardcover:5001', 'Beyond the Dark Portal', 'Aaron Rosenberg, Christie Golden', 2008, [{ name: 'World of Warcraft', position: 4 }], 'https://assets.hardcover.app/edition/30562820/good.jpeg', 900],
  ]);

  // Without an author there is one search, and a book is offered as it is listed.
  const titleOnly = standIn((operation) => (operation === 'Search' ? { search: { ids: [5001] } } : { books: [volume4], editions: [] }));
  const [listed] = await createHardcover({ token: 'abc', fetch: titleOnly.fetch }).lookup({ title: 'World of Warcraft Vol 4' });
  assert.deepEqual([listed.title, listed.author, listed.coverId, titleOnly.calls.length], ['World of Warcraft, Vol. 4', 'Walter Simonson, Louise Simonson', 700, 2]);

  // When the search by the title alone fails, the other one's books are still offered.
  const halfWorking = standIn((operation, { q, ids }) => {
    if (q === 'Beyond the Dark Portal') return { status: 500 };
    return operation === 'Search' ? { search: { ids: [4001] } } : { books: [portal].filter((b) => ids.includes(b.id)), editions: [] };
  });
  const found = await createHardcover({ token: 'abc', fetch: halfWorking.fetch }).lookup({ title: 'Beyond the Dark Portal', author: 'Aaron Rosenberg' });
  assert.deepEqual(found.map((m) => m.key), ['hardcover:4001']);
});

// Hardcover takes a search that starts with "by" for books by an author, so "By Schism Rent Asunder"
// finds books by Gordon Chism.
const schism = { id: 446538, title: 'By Schism Rent Asunder', release_year: 2008, image: null, contributions: credit('David Weber'), book_series: [{ position: 2, featured: true, series: { name: 'Safehold' } }], editions: [] };
const byChism = { id: 1561276, title: 'The Thinking Person\'s UFO Book', release_year: 2009, image: null, contributions: credit('Richard M. Dolan', 'Gordon Chism'), book_series: [], editions: [] };

test('a title starting with "By" is searched for as a title, not as books by an author', async () => {
  const site = standIn((operation, { q, ids }) => (operation === 'Search'
    ? { search: { ids: /^by\s/i.test(q) ? [byChism.id] : [schism.id] } }
    : { books: [schism, byChism].filter((b) => ids.includes(b.id)), editions: [] }));
  const results = await createHardcover({ token: 'abc', fetch: site.fetch }).lookup({ title: 'By Schism Rent Asunder', author: 'David Weber' });
  assert.deepEqual(site.calls.filter((c) => c.operation === 'Search').map((c) => c.variables.q), ['"By" Schism Rent Asunder David Weber', '"By" Schism Rent Asunder']);
  assert.deepEqual(results.map((m) => [m.title, m.author, m.series]), [['By Schism Rent Asunder', 'David Weber', [{ name: 'Safehold', position: 2 }]]]);

  // Elsewhere, or as part of a word, "by" is left as it is.
  for (const title of ['Stand by Me', 'Bygones']) {
    const other = standIn(() => ({ search: { ids: [] } }));
    await createHardcover({ token: 'abc', fetch: other.fetch }).lookup({ title });
    assert.deepEqual(other.calls.map((c) => c.variables.q), [title]);
  }
});

test('a match offers the covers of its editions that are not marked as being in another language', async () => {
  const at = (id) => ({ id, url: `https://assets.hardcover.app/editions/${id}.jpg` });
  const edition = (id, code2 = null) => ({ image: at(id), language: code2 && { code2, code3: null } });
  // The Shining Ones: its website shows an English edition. Of the editions most readers have, one is
  // Finnish, one has no language set and two share a picture; the Swedish ones are read less.
  const editions = [edition(1, 'en'), edition(2, 'fi'), edition(3, 'en'), edition(4), edition(3, 'en'), edition(5, 'sv'), edition(6, 'sv')];
  const shining = { id: 269694, title: 'The Shining Ones', release_year: 1993, image: at(9), default_cover_edition: editions[0], contributions: credit('David Eddings'), book_series: [], editions: [] };
  const lookup = async (language, all = editions) => {
    const site = standIn((operation, v) => (operation === 'Search'
      ? { search: { ids: [shining.id] } }
      : { books: [{ ...shining, mostRead: all.slice(0, 5), inLanguage: all.filter((e) => e.language?.code2 === v.language) }], editions: [] }));
    const [m] = await createHardcover({ token: 'abc', fetch: site.fetch }).lookup({ title: 'The Shining Ones', language });
    return [site.calls.at(-1).variables.language, m.coverId, m.covers.map((c) => c.coverId)];
  };
  // An English book: the website's cover, then the other English ones and the one with no language.
  assert.deepEqual(await lookup('en-GB'), ['en', 1, [3, 4]]);
  // A Swedish book: the Swedish covers, though fewer read them, and the one with no language.
  assert.deepEqual(await lookup('swe'), ['sv', 5, [6, 4]]);
  // Without a language in the file, the book's is the one of the edition Hardcover shows it with.
  assert.deepEqual(await lookup(''), ['', 1, [3, 4]]);
  // With none in the book's language, one with no language set; with none of those either, the website's.
  assert.deepEqual(await lookup('da'), ['da', 4, []]);
  assert.deepEqual(await lookup('da', editions.filter((e) => e.language)), ['da', 1, []]);

  // A cover is offered as a match's own is, to take by its picture's id.
  const site = standIn((operation) => (operation === 'Search' ? { search: { ids: [shining.id] } } : { books: [{ ...shining, mostRead: editions }], editions: [] }));
  const [m] = await createHardcover({ token: 'abc', fetch: site.fetch }).lookup({ title: 'The Shining Ones', language: 'en' });
  assert.deepEqual(m.covers[0], { cover: 'https://assets.hardcover.app/editions/3.jpg', coverSource: 'hardcover', coverId: 3 });
});

test('audiobook editions are left out: their covers, and as the edition a match is offered as', async () => {
  const at = (id) => ({ id, url: `https://assets.hardcover.app/editions/${id}.jpg` });
  // Hardcover's reading formats: 1 physical, 2 audio, 3 both, 4 e-book.
  const edition = (id, format, fields = {}) => ({ id, image: at(id), language: { code2: 'en', code3: 'eng' }, reading_format_id: format, ...fields });
  const audio = edition(2, 2, { title: 'The Way of Kings (Unabridged)' });
  const kings = { id: 7, title: 'The Way of Kings', release_year: 2010, image: at(9), default_cover_edition: audio, contributions: credit('Brandon Sanderson'), book_series: [],
    editions: [audio], mostRead: [audio, edition(1, 1), edition(3, 4), edition(4, 3)] };
  const site = standIn((operation) => (operation === 'Search' ? { search: { ids: [kings.id] } } : { books: [kings], editions: [] }));
  const hardcover = createHardcover({ token: 'abc', fetch: site.fetch });
  // Not offered as the audiobook, though its title is the one typed, nor with its cover, though it is
  // the one Hardcover shows the book with. The physical, e-book and both-in-one editions' covers are.
  const [m] = await hardcover.lookup({ title: 'The Way of Kings (Unabridged)', language: 'en' });
  assert.deepEqual([m.title, m.coverId, m.covers.map((c) => c.coverId)], ['The Way of Kings', 1, [3, 4]]);
  // Hardcover is asked for editions without them, so the ones most readers have are not all audiobooks;
  // all but the edition asked for by the file's ISBN.
  const lists = site.calls.at(-1).query.match(/editions\(where: [^)]*\)/g);
  assert.equal(lists.length, 6);
  assert.deepEqual(lists.filter((l) => !l.includes('reading_format_id: {_neq: 2}')).map((l) => l.includes('isbn_13')), [true]);
  // With no other picture, no audiobook's either: the book's own image.
  const onlyAudio = standIn((operation) => (operation === 'Search' ? { search: { ids: [kings.id] } } : { books: [{ ...kings, mostRead: [audio] }], editions: [] }));
  const [alone] = await createHardcover({ token: 'abc', fetch: onlyAudio.fetch }).lookup({ title: 'The Way of Kings' });
  assert.equal(alone.coverId, 9);
  // Found by an audiobook edition's ISBN, the book comes as itself.
  const byIsbn = standIn((operation) => (operation === 'Search' ? { search: { ids: [] } } : { books: [], editions: [{ ...audio, book: kings }] }));
  const [found] = await createHardcover({ token: 'abc', fetch: byIsbn.fetch }).lookup({ isbns: ['9780765326355'] });
  assert.deepEqual([found.title, found.coverId, found.byIsbn], ['The Way of Kings', 1, true]);
});

test('the file\'s edition, found by its ISBN, comes with its own title, authors and cover', async () => {
  const stone = {
    id: 1, title: 'Harry Potter and the Philosopher\'s Stone', release_year: 1997, image: { id: 3, url: 'https://assets.hardcover.app/books/1/en.jpg' },
    contributions: credit('J.K. Rowling'), book_series: [{ position: 1, featured: true, series: { name: 'Harry Potter' } }],
    editions: [{ id: 99, title: 'Harry Potter og De Vises Sten', release_year: 1998, image: { id: 4, url: 'https://assets.hardcover.app/editions/99/da.jpg' }, contributions: [{ contribution: null, author: { name: 'J.K. Rowling' } }, { contribution: 'Translator', author: { name: 'Hanna Lützen' } }] }],
  };
  const site = standIn((operation) => (operation === 'Search' ? { search: { ids: [] } } : { books: [], editions: [{ ...stone.editions[0], book: stone }] }));
  const [byIsbn] = await createHardcover({ token: 'abc', fetch: site.fetch }).lookup({ title: 'Harry Potter og De Vises Sten', isbns: ['9788700398368'] });
  assert.deepEqual([byIsbn.title, byIsbn.author, byIsbn.year, byIsbn.series, byIsbn.coverId, byIsbn.byIsbn], ['Harry Potter og De Vises Sten', 'J.K. Rowling', 1998, [{ name: 'Harry Potter', position: 1 }], 4, true]);

  // Found by its title, the book comes as the edition with that title too.
  const byTitle = standIn((operation) => (operation === 'Search' ? { search: { ids: [1] } } : { books: [stone], editions: [] }));
  const [found] = await createHardcover({ token: 'abc', fetch: byTitle.fetch }).lookup({ title: 'Harry Potter og De Vises Sten' });
  assert.deepEqual([found.title, found.coverId, found.byIsbn], ['Harry Potter og De Vises Sten', 4, false]);
});

test('Hardcover covers are fetched by the picture\'s id, from the address Hardcover gives if it is a public one', async () => {
  const url = leviathan.image.url;
  const site = standIn((operation, { id }) => ({ images_by_pk: id === 11 ? { url } : id === 5 ? { url: 'https://10.0.0.8/cover.jpg' } : null }), { [url]: PNG });
  const hardcover = createHardcover({ token: 'abc', fetch: site.fetch });
  assert.deepEqual(await hardcover.cover(11), PNG);
  assert.deepEqual(site.calls.map((c) => [c.operation ?? c.picture, c.variables]), [['Cover', { id: 11 }], [url, undefined]]);
  await assert.rejects(hardcover.cover(5), /no longer has this cover/, 'an address inside a network is not fetched');
  await assert.rejects(hardcover.cover(6), /no longer has this cover/);
  assert.equal(site.calls.filter((c) => c.picture).length, 1);
  await assert.rejects(hardcover.cover('11'), TypeError);
});

test('Hardcover series are found by name, each with its books in order', async () => {
  const corey = (...more) => [...credit('James S. A. Corey'), ...more];
  const expanse = {
    id: 26, name: 'The Expanse', author: { name: 'James S. A. Corey' },
    book_series: [
      { position: 1, book: { id: 427, title: 'Leviathan Wakes', release_date: '2011-06-15', contributions: corey() } },
      { position: 2, book: { id: 428, title: "Caliban's War (The Expanse, #2)", release_date: '2012-06-26', contributions: corey({ contribution: 'Narrator', author: { name: 'Jefferson Mays' } }) } },
      { position: 2.5, book: { id: 429, title: 'Gods of Risk', release_date: null, contributions: corey() } },
      // Without a book or a place there is nothing to show.
      { position: 3, book: null },
      { position: -1, book: { id: 430, title: 'Before the Beginning', release_date: null, contributions: corey() } },
      { position: 10, book: { id: 431, title: 'Announced', release_date: '2999-01-01', contributions: corey() } },
    ],
  };
  const site = standIn((operation) => (operation === 'FindSeries' ? { search: { ids: [26, 404] } } : { series: [{ id: 404, name: '' }, expanse] }));
  const found = await createHardcover({ token: 'abc', fetch: site.fetch }).series('Expanse');
  assert.deepEqual(site.calls.map((c) => [c.operation, c.variables]), [['FindSeries', { q: 'Expanse' }], ['Series', { ids: [26, 404] }]]);
  const book = (id, position, title, upcoming = false) => ({ position, title, author: 'James S. A. Corey', upcoming, url: `https://hardcover.app/id/book/${id}` });
  assert.deepEqual(found, [{
    name: 'The Expanse', author: 'James S. A. Corey', url: 'https://hardcover.app/id/series/26',
    // Titles are tidied like a lookup's; a book not out yet is marked.
    books: [book(427, 1, 'Leviathan Wakes'), book(428, 2, "Caliban's War"), book(429, 2.5, 'Gods of Risk'), book(431, 10, 'Announced', true)],
  }]);

  // Nothing found by that name: nothing more is asked.
  const none = standIn(() => ({ search: { ids: [] } }));
  assert.deepEqual(await createHardcover({ token: 'abc', fetch: none.fetch }).series('Nothing'), []);
  assert.equal(none.calls.length, 1);
  await assert.rejects(createHardcover({ token: 'abc', fetch: standIn(() => ({ status: 401 })).fetch }).series('The Expanse'), /did not accept the token/);
});

test('Hardcover series are found through one of their books', async () => {
  const lowder = credit('James Lowder');
  const inSeries = (position, id, name, canonical = null) => ({ position, series: { id, name, canonical_id: canonical } });
  const avatar = {
    id: 5, name: 'Forgotten Realms: Avatar', author: { name: 'Richard Awlinson' },
    book_series: [
      { position: 1, book: { id: 51, title: 'Shadowdale', release_date: '1989-04-01', contributions: credit('Scott Ciencin') } },
      { position: 4, book: { id: 54, title: 'Prince of Lies', release_date: '1993-08-01', contributions: lowder } },
    ],
  };
  const realms = { id: 8, name: 'Forgotten Realms', author: null, book_series: [{ position: 40, book: { id: 60, title: 'Prince of Lies', release_date: null, contributions: lowder } }] };
  const stranger = { id: 61, title: 'Prince of Lies', contributions: credit('Someone Else'), book_series: [inSeries(1, 9, 'Lies')] };
  const site = standIn((operation) => ({
    Search: { search: { ids: [54, 60, 61, 62] } },
    BooksSeries: {
      books: [
        // The book, with the series in its title, in the series and in a duplicate merged into it.
        { id: 54, title: 'Prince of Lies (Forgotten Realms: Avatar, #4)', contributions: lowder, book_series: [inSeries(4, 5, 'Forgotten Realms: Avatar'), inSeries(4, 7, 'Forgotten Realms: The Avatar Series,', 5)] },
        // The book listed once more, in another series; one of that title by someone else; another book by the author.
        { id: 60, title: 'Prince of Lies', contributions: lowder, book_series: [inSeries(40, 8, 'Forgotten Realms')] },
        stranger,
        { id: 62, title: 'Knight of the Black Rose', contributions: lowder, book_series: [inSeries(1, 10, 'Ravenloft')] },
      ],
    },
    Series: { series: [realms, avatar] },
  })[operation]);
  const found = await createHardcover({ token: 'abc', fetch: site.fetch }).seriesOf({ title: 'Prince of Lies', author: 'James Lowder' });
  assert.deepEqual(site.calls.map((c) => [c.operation, c.variables]), [
    ['Search', { q: 'Prince of Lies James Lowder' }],
    ['BooksSeries', { ids: [54, 60, 61, 62] }],
    ['Series', { ids: [5, 8] }],
  ]);
  // In the order the search found the books, as series() gives them.
  assert.deepEqual(found.map((s) => [s.name, s.url, s.books.map((b) => [b.position, b.title, b.author])]), [
    ['Forgotten Realms: Avatar', 'https://hardcover.app/id/series/5', [[1, 'Shadowdale', 'Scott Ciencin'], [4, 'Prince of Lies', 'James Lowder']]],
    ['Forgotten Realms', 'https://hardcover.app/id/series/8', [[40, 'Prince of Lies', 'James Lowder']]],
  ]);

  // Nothing found, or no book that is the one: nothing more is asked.
  const none = standIn(() => ({ search: { ids: [] } }));
  assert.deepEqual(await createHardcover({ token: 'abc', fetch: none.fetch }).seriesOf({ title: 'Nothing', author: 'Nobody' }), []);
  assert.equal(none.calls.length, 1);
  const other = standIn((operation) => (operation === 'Search' ? { search: { ids: [61] } } : { books: [stranger] }));
  assert.deepEqual(await createHardcover({ token: 'abc', fetch: other.fetch }).seriesOf({ title: 'Prince of Lies', author: 'James Lowder' }), []);
  assert.deepEqual(other.calls.map((c) => c.operation), ['Search', 'BooksSeries']);
});

// ---- both catalogues ----

const match = (fields) => ({ series: [], cover: null, coverSource: null, coverId: null, covers: [], byIsbn: false, year: null, url: '', ...fields });
const catalogue = (lookup, cover = async () => PNG) => ({ lookup, cover });

test('a book found in both catalogues is offered once, with what only one of them had', async () => {
  const fromHardcover = [
    match({ key: 'hardcover:427', source: 'hardcover', title: 'Leviathan Wakes', author: 'James S. A. Corey', series: [{ name: 'The Expanse', position: 1 }] }),
    match({ key: 'hardcover:500', source: 'hardcover', title: 'Leviathan Falls', author: 'James S. A. Corey' }),
  ];
  const fromOpenLibrary = [
    match({ key: '/works/OL1W', source: 'openlibrary', title: 'Leviathan wakes', author: 'James S.A. Corey', cover: 'https://covers.openlibrary.org/b/id/7-L.jpg?default=false', coverSource: 'openlibrary', coverId: 7 }),
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
  const logged = [];
  const log = { error: (...args) => logged.push(args) };
  let lookups = createLookup({ hardcover: expired, openLibrary: catalogue(async () => [leviathanWakes]), log });
  assert.deepEqual(await lookups.lookup({ title: 'Leviathan Wakes' }), { results: [leviathanWakes], problems: ['Hardcover did not accept the token.'] });
  // The server's log says which catalogue failed, for which book, and why.
  assert.deepEqual(logged, [['[lookup] "Leviathan Wakes": Hardcover did not accept the token.']]);
  // Nothing found is not a failure.
  lookups = createLookup({ hardcover: expired, openLibrary: catalogue(async () => []), log });
  assert.deepEqual(await lookups.lookup({ title: 'Nothing' }), { results: [], problems: ['Hardcover did not accept the token.'] });
  lookups = createLookup({ hardcover: expired, openLibrary: catalogue(async () => { throw new LookupError('Open Library did not answer.'); }), log });
  await assert.rejects(lookups.lookup({ title: 'Leviathan Wakes' }), { message: 'Hardcover did not accept the token. Open Library did not answer.' });
  // A catalogue that fails in a way its client did not expect is named to the user, and the log keeps the error itself.
  logged.length = 0;
  const bug = new TypeError('bug');
  lookups = createLookup({ hardcover: catalogue(async () => { throw bug; }), openLibrary: catalogue(async () => [leviathanWakes]), log });
  assert.deepEqual(await lookups.lookup({ title: 'Leviathan Wakes' }), { results: [leviathanWakes], problems: ['Hardcover sent an answer the app could not read. Try again in a moment.'] });
  assert.deepEqual(logged, [['[lookup] "Leviathan Wakes": Hardcover failed:', bug]]);
  // Without a token only Open Library is asked; when it fails like that too, the user is told so.
  lookups = createLookup({ openLibrary: catalogue(async () => { throw bug; }), log: { error() {} } });
  assert.deepEqual(lookups.sources, ['openlibrary']);
  await assert.rejects(lookups.lookup({ title: 'Leviathan Wakes' }), { message: 'Open Library sent an answer the app could not read. Try again in a moment.' });
});

// ---- the API ----

let server, origin, dataDir, jens;
const covers = [];
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-hardcover-'));
  const hardcover = catalogue(
    async () => [match({ key: 'hardcover:427', source: 'hardcover', title: 'Leviathan Wakes', author: 'James S. A. Corey', series: [{ name: 'The Expanse', position: 1 }], cover: leviathan.image.url, coverSource: 'hardcover', coverId: 11 })],
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
  // Which catalogues were asked, for the dialog's "No match on …" and for an admin checking the token.
  assert.deepEqual(r.data.sources, ['hardcover', 'openlibrary']);
  assert.deepEqual((await jens('/api/health')).data.lookup, ['hardcover', 'openlibrary']);

  r = await jens(`/api/books/${book.id}/cover`, { method: 'PUT', body: { source: 'hardcover', coverId: 11 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.book.coverSource, 'custom');
  assert.deepEqual(covers, [11]);
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
    assert.deepEqual((await (await fetch(`${at}/api/health`)).json()).lookup, ['openlibrary']);
  } finally {
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
