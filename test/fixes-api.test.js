import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { parseSection, positionText } from '../server/fixes.js';
import { makeEpub } from './helpers/make-epub.mjs';

let server, origin, db, dataDir, jens, anna;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-fixes-'));
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
const reprocess = async (id) => {
  assert.equal((await jens(`/api/books/${id}/reprocess`, { method: 'POST' })).status, 202);
  return waitReady(id);
};
const section = async (id, n = 0) => (await jens(`/books/${id}/sections/${n}.html`)).data;
const bookFile = (id, ...parts) => path.join(dataDir, 'books', id, ...parts);
const fixText = (id, body) => jens(`/api/books/${id}/fixes`, { method: 'POST', body });
const undo = (id, fixId) => jens(`/api/books/${id}/fixes/${fixId}`, { method: 'DELETE' });
// The reader's place of a piece of text in a section's HTML.
const placeOf = (html, text) => {
  const at = positionText(parseSection(html).children).indexOf(text);
  assert.ok(at >= 0, text);
  return at;
};

const CHAPTERS = [
  { id: 'ch1', file: 'ch1.xhtml', title: 'Chaptr One', body: '<h1 id="c1">Chaptr One</h1><p class="first">Alorn sat in tbe hall with his <em>friends</em>.</p>'
    + '<p>The night was long.</p><p>Yes.</p><p>Middle words.</p><p>Yes.</p><p>Tbe last line.</p>' },
  { id: 'ch2', file: 'ch2.xhtml', title: 'Chapter Two', body: '<h1>Chapter Two</h1><p>Second chapter text.</p>' },
];
const HALL = 'Alorn sat in tbe hall with his friends.';
const GREAT_HALL = 'Alorn sat in the great hall with his friends.';
let books = 0;
// A new copy of the book each time: the same file is not added twice.
const epub = () => makeEpub({ title: `Fix Book ${++books}`, chapters: CHAPTERS });

test('only admins see, make and undo fixes', async () => {
  const id = await upload('Admins.epub', epub());
  assert.equal((await anna(`/api/books/${id}/fixes`)).status, 403);
  assert.equal((await anna(`/api/books/${id}/fixes`, { method: 'POST', body: { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] } })).status, 403);
  const made = await fixText(id, { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] });
  assert.equal(made.status, 201);
  assert.equal((await anna(`/api/books/${id}/fixes/${made.data.fix.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await jens(`/api/books/${id}/fixes`)).data.fixes.length, 1);
  assert.equal((await jens('/api/books/0000000000000000/fixes')).status, 404);
  assert.equal((await fixText(id, { section: 0, paragraph: 1, before: [GREAT_HALL], after: [` ${GREAT_HALL}\n`] })).data.error, 'Nothing has changed');
  assert.equal((await fixText(id, { section: 0, paragraph: 1, before: 'x', after: [] })).status, 400);
  assert.equal((await undo(id, 9999)).status, 404);
});

test('a fix changes the section, gives the book a new version, and keeps the section as converted', async () => {
  const id = await upload('Fixed.epub', epub());
  const first = await waitReady(id);
  const converted = await section(id);
  const r = await fixText(id, { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] });
  assert.equal(r.status, 201);
  assert.deepEqual({ ...r.data.fix, id: 0, createdAt: 0 },
    { id: 0, before: [HALL], after: [GREAT_HALL], applied: true, section: 0, paragraph: 1, createdAt: 0, by: 'jens' });

  const fixed = await section(id);
  assert.equal(fixed, converted.replace('tbe hall', 'the great hall'));
  assert.match(fixed, /<em>friends<\/em>/);
  assert.equal(fs.readFileSync(bookFile(id, 'unfixed', '0.html'), 'utf8'), converted);

  // Lengths, starts and the version, the same in the manifest and the library.
  const manifest = JSON.parse(fs.readFileSync(bookFile(id, 'book.json'), 'utf8'));
  assert.equal(manifest.sections[0].chars, first.manifest.sections[0].chars + 6);
  assert.equal(manifest.sections[1].start, first.manifest.sections[1].start + 6);
  assert.equal(manifest.totalChars, first.manifest.totalChars + 6);
  assert.ok(manifest.convertedAt > first.manifest.convertedAt);
  assert.deepEqual(r.data.manifest, manifest);
  const now = await jens(`/api/books/${id}`);
  assert.deepEqual(now.data.manifest, manifest);
  assert.equal(now.data.book.convertedAt, manifest.convertedAt);
  assert.equal(now.data.book.totalChars, manifest.totalChars);
  assert.equal(r.data.book.convertedAt, manifest.convertedAt);

  const list = await jens(`/api/books/${id}/fixes`);
  assert.deepEqual(list.data.fixes, [r.data.fix]);
});

test('a fix is found by its text, and refused when the text changed since it was opened', async () => {
  const id = await upload('Found.epub', epub());
  const stale = await fixText(id, { section: 0, paragraph: 1, before: ['Alorn sat in tbe hall.'], after: ['Alorn sat.'] });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'The text has changed since it was opened. Reload the book and try again.');
  assert.equal((await fixText(id, { section: 7, paragraph: 0, before: [HALL], after: [GREAT_HALL] })).status, 409);
  // A wrong number, but text found once in the section, is fixed where it is.
  const moved = await fixText(id, { section: 0, paragraph: 0, before: ['The night was long.'], after: ['The night was very long.'] });
  assert.equal(moved.status, 201);
  assert.equal(moved.data.fix.paragraph, 2);
  assert.match(await section(id), /<p>The night was very long\.<\/p>/);
  // Text found twice is fixed only at the number given.
  assert.equal((await fixText(id, { section: 0, paragraph: 4, before: ['Yes.'], after: ['No.'] })).status, 409);
  const yes = await fixText(id, { section: 0, paragraph: 5, before: ['Yes.'], after: ['Yes!'] });
  assert.equal(yes.status, 201);
  assert.match(await section(id), /<p>Yes\.<\/p><p>Middle words\.<\/p><p>Yes!<\/p>/);
});

test('reading places and bookmarks move with the text', async () => {
  const id = await upload('Places.epub', epub());
  const html = await section(id);
  const tbe = placeOf(html, 'tbe hall');
  const night = placeOf(html, 'night');
  const sat = placeOf(html, 'sat');
  await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 0, offset: night, percent: 0.2 } });
  await anna(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 0, offset: tbe + 2, percent: 0.1 } });
  await anna(`/api/books/${id}/bookmarks`, { method: 'POST', body: { section: 0, offset: sat, percent: 0.05, label: 'Sat' } });
  await anna(`/api/books/${id}/bookmarks`, { method: 'POST', body: { section: 1, offset: 3, percent: 0.8, label: 'Later' } });
  const jensBefore = (await jens(`/api/books/${id}/progress`)).data.progress;

  assert.equal((await fixText(id, { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] })).status, 201);
  const fixedHtml = await section(id);
  const jensAfter = (await jens(`/api/books/${id}/progress`)).data.progress;
  assert.equal(jensAfter.offset, placeOf(fixedHtml, 'night'));
  assert.equal(jensAfter.offset, night + 6);
  assert.equal(jensAfter.updatedAt, jensBefore.updatedAt);
  assert.equal(jensAfter.percent, 0.2);
  // A place inside the change goes to where it starts.
  assert.equal((await anna(`/api/books/${id}/progress`)).data.progress.offset, tbe + 1);
  const marks = (await anna(`/api/books/${id}/bookmarks`)).data.bookmarks;
  assert.deepEqual(marks.map((b) => [b.label, b.offset]), [['Sat', sat], ['Later', 3]]);
});

test('a book being converted, or that could not be, cannot have its text fixed', async () => {
  const id = await upload('Busy.epub', epub());
  const body = { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] };
  db.prepare("UPDATE books SET status = 'processing' WHERE id = ?").run(id);
  let r = await fixText(id, body);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'The book is being converted. Try again in a moment.');
  db.prepare("UPDATE books SET status = 'error' WHERE id = ?").run(id);
  r = await fixText(id, body);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'The book could not be converted, so its text cannot be fixed');
  db.prepare("UPDATE books SET status = 'ready' WHERE id = ?").run(id);
  assert.equal((await fixText(id, body)).status, 201);
});

test('converting again applies the fixes again, and marks those whose text is gone', async () => {
  const id = await upload('Again.md', Buffer.from('# Tale\n\nOnce tbere was a king.\n\nHe ruled well.\n'));
  const converted = await section(id);
  const made = await fixText(id, { section: 0, paragraph: 1, before: ['Once tbere was a king.'], after: ['Once there was a king.', 'He had a crown.'] });
  assert.equal(made.status, 201);
  const fixed = await section(id);

  const again = await reprocess(id);
  assert.equal(await section(id), fixed);
  assert.equal(fs.readFileSync(bookFile(id, 'unfixed', '0.html'), 'utf8'), converted);
  assert.equal(again.book.totalChars, again.manifest.totalChars);
  assert.equal(again.manifest.sections[0].chars, made.data.manifest.sections[0].chars);
  let list = (await jens(`/api/books/${id}/fixes`)).data.fixes;
  assert.deepEqual(list.map((f) => f.applied), [true]);

  // The book's file now says something else: the fix is kept, but not applied.
  const original = fs.readdirSync(bookFile(id)).find((f) => f.startsWith('original.'));
  fs.writeFileSync(bookFile(id, original), '# Tale\n\nA queen ruled instead.\n');
  await reprocess(id);
  assert.match(await section(id), /A queen ruled instead\./);
  assert.equal(fs.existsSync(bookFile(id, 'unfixed')), false);
  list = (await jens(`/api/books/${id}/fixes`)).data.fixes;
  assert.deepEqual(list.map((f) => f.applied), [false]);
  assert.equal((await undo(id, list[0].id)).status, 200);
  assert.deepEqual((await jens(`/api/books/${id}/fixes`)).data.fixes, []);
});

test('a stored fix that fails is marked not applied, and the book is still converted with the others', async () => {
  const id = await upload('Broken.md', Buffer.from('# Tale\n\nOnce tbere was a king.\n\nHe ruled well.\n\nThe end came lafe.\n'));
  const first = await fixText(id, { section: 0, paragraph: 1, before: ['Once tbere was a king.'], after: ['Once there was a king.'] });
  assert.equal(first.status, 201);
  // A row no fix could have written: its new text is not JSON.
  const broken = Number(db.prepare(`INSERT INTO text_fixes (book_id, old_text, new_text, section, paragraph, created_at)
    VALUES (?, ?, ?, 0, 2, ?)`).run(id, JSON.stringify(['He ruled well.']), 'not json', Date.now()).lastInsertRowid);
  const last = await fixText(id, { section: 0, paragraph: 3, before: ['The end came lafe.'], after: ['The end came late.'] });
  assert.equal(last.status, 201);

  const again = await reprocess(id);
  assert.equal(again.book.status, 'ready');
  const html = await section(id);
  assert.match(html, /Once there was a king\./);
  assert.match(html, /He ruled well\./);
  assert.match(html, /The end came late\./);
  const applied = (fixId) => db.prepare('SELECT applied FROM text_fixes WHERE id = ?').get(fixId).applied;
  assert.deepEqual([applied(first.data.fix.id), applied(broken), applied(last.data.fix.id)], [1, 0, 1]);
});

test('undo puts the text back as it was, and moves places back', async () => {
  const id = await upload('Undo.epub', epub());
  const converted = await section(id);
  const night = placeOf(converted, 'night');
  await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 0, offset: night, percent: 0.2 } });
  const first = (await jens(`/api/books/${id}`)).data;

  // The only fix in the section.
  const a = await fixText(id, { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] });
  assert.equal((await jens(`/api/books/${id}/progress`)).data.progress.offset, night + 6);
  const r = await undo(id, a.data.fix.id);
  assert.equal(r.status, 200);
  assert.equal(await section(id), converted);
  assert.equal(fs.existsSync(bookFile(id, 'unfixed', '0.html')), false);
  assert.equal((await jens(`/api/books/${id}/progress`)).data.progress.offset, night);
  assert.equal(r.data.manifest.totalChars, first.manifest.totalChars);
  assert.ok(r.data.manifest.convertedAt > a.data.manifest.convertedAt);
  assert.equal(r.data.book.convertedAt, r.data.manifest.convertedAt);
  assert.deepEqual((await jens(`/api/books/${id}/fixes`)).data.fixes, []);

  // Two fixes apart: undoing the first keeps the second.
  const b = await fixText(id, { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] });
  const c = await fixText(id, { section: 0, paragraph: 6, before: ['Tbe last line.'], after: ['The last line.'] });
  assert.equal((await undo(id, b.data.fix.id)).status, 200);
  assert.equal(await section(id), converted.replace('Tbe last', 'The last'));
  assert.equal(fs.readFileSync(bookFile(id, 'unfixed', '0.html'), 'utf8'), converted);

  // A later fix to the same text must be undone first.
  const d = await fixText(id, { section: 0, paragraph: 6, before: ['The last line.'], after: ['The very last line.'] });
  const refused = await undo(id, c.data.fix.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, 'A later fix changed this text. Undo that one first.');
  assert.match(await section(id), /The very last line\./);
  assert.equal((await undo(id, d.data.fix.id)).status, 200);
  assert.equal(await section(id), converted.replace('Tbe last', 'The last'));
  assert.equal((await undo(id, c.data.fix.id)).status, 200);
  assert.equal(await section(id), converted);
  assert.equal((await jens(`/api/books/${id}/progress`)).data.progress.offset, night);
});

test('a fixed chapter title renames its contents entry and section title, and undo renames them back', async () => {
  const id = await upload('Titles.epub', epub());
  const r = await fixText(id, { section: 0, paragraph: 0, before: ['Chaptr One'], after: ['Chapter One'] });
  assert.equal(r.status, 201);
  assert.equal(r.data.manifest.toc[0].title, 'Chapter One');
  assert.equal(r.data.manifest.sections[0].title, 'Chapter One');
  assert.equal(r.data.manifest.toc[1].title, 'Chapter Two');
  assert.match(await section(id), /<h1 id="c1">Chapter One<\/h1>/);
  // Converting again renames them again.
  const again = await reprocess(id);
  assert.equal(again.manifest.toc[0].title, 'Chapter One');
  assert.equal(again.manifest.sections[0].title, 'Chapter One');
  const back = await undo(id, r.data.fix.id);
  assert.equal(back.status, 200);
  assert.equal(back.data.manifest.toc[0].title, 'Chaptr One');
  assert.equal(back.data.manifest.sections[0].title, 'Chaptr One');
});

test('fixes sent at once are made one after the other', async () => {
  const id = await upload('AtOnce.epub', epub());
  const converted = await section(id);
  const [x, y, z] = await Promise.all([
    fixText(id, { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] }),
    fixText(id, { section: 0, paragraph: 6, before: ['Tbe last line.'], after: ['The last line.'] }),
    fixText(id, { section: 0, paragraph: 6, before: ['Tbe last line.'], after: ['The final line.'] }),
  ]);
  // The two fixes to the last line: whichever came first is made, and the other finds its text changed.
  assert.equal(x.status, 201);
  assert.deepEqual([y.status, z.status].sort(), [201, 409]);
  const last = y.status === 201 ? 'The last line.' : 'The final line.';
  assert.equal(await section(id), converted.replace('tbe hall', 'the great hall').replace('Tbe last line.', last));
  const made = [x, y, z].filter((r) => r.status === 201).map((r) => r.data.manifest);
  assert.notEqual(made[0].convertedAt, made[1].convertedAt);
  const book = (await jens(`/api/books/${id}`)).data;
  assert.equal(book.book.convertedAt, Math.max(...made.map((m) => m.convertedAt)));
  assert.equal(book.book.totalChars, book.manifest.totalChars);
  assert.equal((await jens(`/api/books/${id}/fixes`)).data.fixes.length, 2);
});

test('a book deleted takes its fixes with it', async () => {
  const id = await upload('Deleted.epub', epub());
  assert.equal((await fixText(id, { section: 0, paragraph: 1, before: [HALL], after: [GREAT_HALL] })).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM text_fixes WHERE book_id = ?').get(id).n, 1);
  assert.equal((await jens(`/api/books/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM text_fixes WHERE book_id = ?').get(id).n, 0);
  assert.equal(fs.existsSync(bookFile(id)), false);
});
