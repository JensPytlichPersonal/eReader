import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { titleKey, authorKey } from '../server/duplicates.js';
import { makeEpub } from './helpers/make-epub.mjs';
import { makeMobi, fixtureMobiHtml } from './helpers/make-mobi.mjs';
import { makePdf } from './helpers/make-pdf.mjs';

let server, origin, db, processor, duplicates, dataDir, jens, anna;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-duplicates-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
  ({ db, processor, duplicates } = created);
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
const post = (c, name, body) => c('/api/books', { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name) } });
const upload = async (c, name, body) => {
  const r = await post(c, name, body);
  assert.equal(r.status, 202, `${name}: ${r.data.error}`);
  return waitReady(r.data.book.id);
};
const library = async () => (await jens('/api/books')).data.books;
const duplicatesOf = (books, b) => books.find((x) => x.id === b.id).duplicates;
const byId = (list) => [...list].sort((x, y) => x.id.localeCompare(y.id));
const notDuplicate = (c, a, b) => c(`/api/books/${a.id}/not-duplicate`, { method: 'POST', body: { of: b.id } });

test('a file already in the library is not added again, under any name', async () => {
  const epub = makeEpub({ title: 'Once', author: 'Only' });
  const first = await upload(jens, 'Once.epub', epub);
  const folders = fs.readdirSync(path.join(dataDir, 'books')).length;

  // Anna has the same file under another name.
  const r = await post(anna, 'Copy of once.epub', epub);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'Already in the library as "Once"');
  assert.equal(r.data.book.id, first.id);
  assert.equal(r.data.book.addedBy, 'jens');
  assert.deepEqual((await library()).filter((b) => b.title === 'Once').map((b) => b.id), [first.id]);
  assert.equal(fs.readdirSync(path.join(dataDir, 'books')).length, folders, 'nothing is left behind');

  // Only the file counts: another file of the book gets in (and is flagged, see below).
  await upload(jens, 'Once.txt', Buffer.from('Once\n\nThe text of the book.'));
});

test('the same file sent twice at once is added once', async () => {
  const epub = makeEpub({ title: 'Twice at once' });
  const answers = await Promise.all([post(jens, 'a.epub', epub), post(anna, 'b.epub', epub)]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [202, 409]);
  const added = answers.find((r) => r.status === 202).data.book;
  assert.equal(answers.find((r) => r.status === 409).data.book.id, added.id);
  await waitReady(added.id);
  const ids = (await library()).map((b) => b.id);
  assert.equal(ids.filter((id) => id === added.id).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'books')).sort(), [...ids].sort(), 'no folder for the one turned away');
});

test('titles and authors are compared loosely', () => {
  assert.equal(titleKey('L’Anomalie!'), titleKey("l'anomalie"));
  assert.equal(titleKey('  Dune:   Deluxe  '), 'dune deluxe');
  assert.notEqual(titleKey('Dune Messiah'), titleKey('Dune'));
  assert.equal(authorKey('Herbert, Frank'), authorKey('Frank  HERBERT'));
  assert.equal(authorKey('Hervé Le Tellier'), authorKey('Herve Le Tellier'));
  assert.equal(authorKey(''), '');
});

test('books that look like the same book are flagged until one goes, or they are said to be different', async () => {
  // A shared ISBN: the MOBI gives it in ten digits, under another title and author.
  const lw = await upload(jens, 'lw.epub', makeEpub({ title: 'Leviathan Wakes', author: 'James S. A. Corey', metadata: '<dc:identifier opf:scheme="ISBN">9780316129084</dc:identifier>' }));
  const lwMobi = await upload(anna, 'lw.mobi', makeMobi({ html: fixtureMobiHtml(), title: 'The Expanse One', author: 'Corey', exth: [[104, '0-316-12908-9']] }));
  // The same title and author, written differently, and a PDF that names no author (its title comes from its file name).
  const dune = await upload(jens, 'dune.epub', makeEpub({ title: 'Dune', author: 'Frank Herbert' }));
  const duneAgain = await upload(anna, 'dune2.epub', makeEpub({ title: 'DUNE', author: 'Herbert, Frank' }));
  const dunePdf = await upload(jens, 'Dune.pdf', makePdf([['In the week before their departure to Arrakis.']]));
  assert.deepEqual([dunePdf.title, dunePdf.author], ['Dune', '']);
  // Not the same: another title by the same author, and one title by two authors.
  const messiah = await upload(jens, 'messiah.epub', makeEpub({ title: 'Dune Messiah', author: 'Frank Herbert' }));
  const poems = await upload(jens, 'p1.epub', makeEpub({ title: 'Poems', author: 'Emily Dickinson' }));
  const otherPoems = await upload(jens, 'p2.epub', makeEpub({ title: 'Poems', author: 'Robert Frost' }));

  let books = await library();
  assert.deepEqual(duplicatesOf(books, lw), [{ id: lwMobi.id, reason: 'isbn' }]);
  assert.deepEqual(duplicatesOf(books, lwMobi), [{ id: lw.id, reason: 'isbn' }]);
  assert.deepEqual(byId(duplicatesOf(books, dune)), byId([{ id: duneAgain.id, reason: 'title' }, { id: dunePdf.id, reason: 'title' }]));
  assert.deepEqual(byId(duplicatesOf(books, dunePdf)), byId([{ id: dune.id, reason: 'title' }, { id: duneAgain.id, reason: 'title' }]));
  for (const b of [messiah, poems, otherPoems]) assert.deepEqual(duplicatesOf(books, b), [], b.title);
  // The book from the first test, as a text file too.
  const once = books.filter((b) => b.title === 'Once');
  assert.deepEqual(once.map((b) => b.duplicates.map((d) => d.reason)), [['title'], ['title']]);
  // Only the library lists them.
  assert.equal((await jens(`/api/books/${dune.id}`)).data.book.duplicates, undefined);

  // Saying two books are different: the uploader of either one, or an admin.
  assert.equal((await notDuplicate(anna, dune, dunePdf)).status, 403, 'anna uploaded neither');
  assert.equal((await notDuplicate(client(), dune, dunePdf)).status, 401);
  assert.equal((await notDuplicate(anna, dune, dune)).status, 400);
  assert.equal((await notDuplicate(anna, dune, { id: 'ffffffffffffffff' })).status, 404);
  assert.equal((await anna(`/api/books/${dune.id}/not-duplicate`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await notDuplicate(anna, duneAgain, dune)).status, 200);
  assert.equal((await notDuplicate(anna, dune, duneAgain)).status, 200, 'saying it twice is fine');
  books = await library();
  assert.deepEqual(duplicatesOf(books, dune), [{ id: dunePdf.id, reason: 'title' }]);
  assert.deepEqual(duplicatesOf(books, duneAgain), [{ id: dunePdf.id, reason: 'title' }]);

  // Deleting a copy ends its flags, and what was said about it.
  assert.equal((await jens(`/api/books/${dunePdf.id}`, { method: 'DELETE' })).status, 200);
  books = await library();
  assert.deepEqual([duplicatesOf(books, dune), duplicatesOf(books, duneAgain)], [[], []]);
  const different = () => db.prepare('SELECT COUNT(*) AS n FROM distinct_books').get().n;
  assert.equal(different(), 1);
  assert.equal((await jens(`/api/books/${duneAgain.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(different(), 0);
});

test('books added before uploads were checked get their fingerprints in the background', async () => {
  const epub = makeEpub({ title: 'Old Copy', author: 'Past' });
  const old = await upload(jens, 'old.epub', epub);
  // As an older version left the library: no fingerprints, so the same file could be added twice.
  db.exec("UPDATE books SET sha256 = ''");
  const again = await upload(anna, 'old again.epub', epub);
  assert.deepEqual(duplicatesOf(await library(), old), [{ id: again.id, reason: 'title' }]);

  const result = await duplicates.backfillFingerprints();
  assert.ok(result.checked >= 2);
  assert.equal(result.fingerprinted, result.checked);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books WHERE sha256 = ''").get().n, 0);
  // The two copies are now known to be the same file, and a third is turned away, naming the first.
  assert.deepEqual(duplicatesOf(await library(), old), [{ id: again.id, reason: 'file' }]);
  const r = await post(jens, 'old once more.epub', epub);
  assert.equal(r.status, 409);
  assert.equal(r.data.book.id, old.id);
  assert.deepEqual(await duplicates.backfillFingerprints(), { checked: 0, fingerprinted: 0 });
});

test('books converted before ISBNs were kept get them without converting again', async () => {
  const numbered = await upload(jens, 'numbered.epub', makeEpub({ title: 'Numbered', author: 'Someone', metadata: '<dc:identifier opf:scheme="ISBN">978-0-306-40615-7</dc:identifier>' }));
  const serial = await upload(jens, 'serial.mobi', makeMobi({ html: fixtureMobiHtml(), title: 'First Book (Serial, Book 1)' }));
  const row = db.prepare('SELECT isbns, converted_at, metadata_version FROM books WHERE id = ?');
  const before = row.get(numbered.id);
  assert.equal(before.isbns, '9780306406157');

  // As an older version left them: series read, but no ISBNs. A series taken away since stays away.
  db.exec("UPDATE books SET isbns = '', metadata_version = 1");
  db.prepare('DELETE FROM book_series WHERE book_id = ?').run(serial.id);
  const result = await processor.backfillMetadata();
  assert.ok(result.checked >= 2);
  assert.equal(result.found, 0);
  const after = row.get(numbered.id);
  assert.deepEqual([after.isbns, after.converted_at, after.metadata_version], ['9780306406157', before.converted_at, 2]);
  assert.deepEqual((await jens(`/api/books/${serial.id}`)).data.book.series, []);
  assert.deepEqual(await processor.backfillMetadata(), { checked: 0, found: 0 });
});

test('a database from an older version gets the new columns', () => {
  const file = path.join(dataDir, 'older.sqlite');
  // A books table from before the columns added since, with a book in it.
  const first = new DatabaseSync(file);
  first.exec(`CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL, original_name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, added_by INTEGER, added_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing', error TEXT, total_chars INTEGER NOT NULL DEFAULT 0, section_count INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0, has_cover INTEGER NOT NULL DEFAULT 0)`);
  first.exec("INSERT INTO books (id, title, format, original_name, added_at, status) VALUES ('0123456789abcdef', 'Kept', 'epub', 'kept.epub', 1, 'ready')");
  first.exec('CREATE TABLE book_series (book_id TEXT NOT NULL, series_id INTEGER NOT NULL, position REAL, PRIMARY KEY (book_id, series_id))');
  first.exec("INSERT INTO book_series (book_id, series_id, position) VALUES ('0123456789abcdef', 1, 2)");
  first.close();
  const older = openDatabase(file);
  const book = older.prepare('SELECT * FROM books').get();
  assert.deepEqual([book.title, book.sha256, book.isbns, book.metadata_version], ['Kept', '', '', 0]);
  assert.deepEqual(older.prepare("SELECT name FROM sqlite_master WHERE name IN ('books_sha256', 'distinct_books') ORDER BY name").all().map((r) => r.name), ['books_sha256', 'distinct_books']);
  assert.deepEqual({ ...older.prepare('SELECT position, position_end FROM book_series').get() }, { position: 2, position_end: null });
  older.close();
});
