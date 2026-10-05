import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { paragraphsOf, parseSection, positionText } from '../server/fixes.js';
import { serialize, textContent, textLength } from '../server/converters/html.js';
import { makeEpub } from './helpers/make-epub.mjs';

let server, origin, db, dataDir, jens, anna;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-places-'));
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
  const detail = await waitReady(id);
  assert.equal(detail.book.status, 'ready');
  return detail;
};
const bookFile = (id, ...parts) => path.join(dataDir, 'books', id, ...parts);
const manifestOf = (id) => JSON.parse(fs.readFileSync(bookFile(id, 'book.json'), 'utf8'));
// Each section of a book on disk as the reader counts places in it.
const textsOf = (id) => manifestOf(id).sections.map((s, i) => positionText(parseSection(fs.readFileSync(bookFile(id, 'sections', `${i}.html`), 'utf8')).children));
// The place of some words in a book's sections.
const placeOf = (texts, words) => {
  for (let section = 0; section < texts.length; section++) {
    const offset = texts[section].indexOf(words);
    if (offset >= 0) return { section, offset };
  }
  throw new Error(`"${words}" is not in the book`);
};
const wordsAt = (texts, { section, offset }) => texts[section].slice(offset, offset + 16);
// Fixes a paragraph of a book, found by its text.
const fixParagraph = (id, before, after) => {
  const sections = manifestOf(id).sections.map((s, i) => paragraphsOf(parseSection(fs.readFileSync(bookFile(id, 'sections', `${i}.html`), 'utf8'))).map((p) => p.text));
  const section = sections.findIndex((texts) => texts.includes(before));
  return jens(`/api/books/${id}/fixes`, { method: 'POST', body: { section, paragraph: sections[section].indexOf(before), before: [before], after: [after] } });
};
// The place at a percent of a book, as the reader finds it from its manifest (but rounded).
const atPercent = (manifest, percent) => {
  const target = percent * manifest.totalChars;
  let section = 0;
  manifest.sections.forEach((s, i) => { if (s.start <= target) section = i; });
  return { section, offset: Math.round(target - manifest.sections[section].start) };
};

const CHAPTERS = [
  { id: 'ch1', file: 'ch1.xhtml', title: 'One', body: '<h1>One</h1><p>The road ran north.</p>' },
  { id: 'ch2', file: 'ch2.xhtml', title: 'Two', body: '<h1>Two</h1><p>Alorn sat in the hall with his <em>friends</em>.</p>'
    + '<p>A map <img src="images/pic.png" alt="map"/> lay on the table.</p><p>Then came the morning, grey and cold.</p>'
    + '<p>They rode out at noon.</p><p>By evening they reached the river.</p>' },
  { id: 'ch3', file: 'ch3.xhtml', title: 'Three', body: '<h1>Three</h1><p>The river was wide and slow.</p><p>On the far side stood a tower.</p>' },
  { id: 'ch4', file: 'ch4.xhtml', title: 'Four', body: '<h1>Four</h1><p>The tower was empty.</p><p>The end of the road.</p>' },
];
let books = 0;
// A new copy of the book each time: the same file is not added twice.
const epub = () => makeEpub({ title: `Places Book ${++books}`, chapters: CHAPTERS });

/**
 * Makes a book's files look as an older converter cut them: section `n` cut in two before the paragraph that
 * starts with `words`, the sections after it numbered one up, and book.json to match.
 */
function cutOlder(id, n, words) {
  const manifest = manifestOf(id);
  const nodes = parseSection(fs.readFileSync(bookFile(id, 'sections', `${n}.html`), 'utf8')).children;
  const at = nodes.findIndex((node) => textContent(node).startsWith(words));
  assert.ok(at > 0, words);
  for (let i = manifest.sections.length - 1; i > n; i--) {
    fs.renameSync(bookFile(id, 'sections', `${i}.html`), bookFile(id, 'sections', `${i + 1}.html`));
  }
  const [first, rest] = [nodes.slice(0, at), nodes.slice(at)];
  fs.writeFileSync(bookFile(id, 'sections', `${n}.html`), serialize(first));
  fs.writeFileSync(bookFile(id, 'sections', `${n + 1}.html`), serialize(rest));
  const s = manifest.sections[n];
  manifest.sections.splice(n, 1, { ...s, chars: textLength(first) }, { ...s, chars: textLength(rest) });
  let start = 0;
  for (const section of manifest.sections) {
    section.start = start;
    start += section.chars;
  }
  manifest.totalChars = start;
  const renumber = (entries) => {
    for (const e of entries || []) {
      if (e.section > n) e.section++;
      renumber(e.children);
    }
  };
  renumber(manifest.toc);
  fs.writeFileSync(bookFile(id, 'book.json'), JSON.stringify(manifest));
}

test('converting a book again moves every place and bookmark to the same words in the new sections', async () => {
  const id = await upload('Moved.epub', epub());
  const converted = manifestOf(id).sections.length;
  const cut = placeOf(textsOf(id), 'Then came').section;
  cutOlder(id, cut, 'Then came');
  const old = textsOf(id);
  assert.equal(old.length, converted + 1);

  // Places in the older cut: in the later part of the cut section, in the sections after it, and before it.
  const evening = placeOf(old, 'they reached');
  const farSide = placeOf(old, 'far side');
  const grey = placeOf(old, 'grey and cold');
  const empty = placeOf(old, 'was empty');
  const hall = placeOf(old, 'the hall');
  assert.deepEqual([evening.section, grey.section, hall.section], [cut + 1, cut + 1, cut]);
  assert.ok(farSide.section > cut + 1 && empty.section > farSide.section);
  await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { ...evening, percent: 0.45, device: 'Boox', finished: false } });
  await anna(`/api/books/${id}/progress`, { method: 'PUT', body: { ...farSide, percent: 0.7, device: 'Phone', finished: true } });
  await jens(`/api/books/${id}/bookmarks`, { method: 'POST', body: { ...grey, percent: 0.4, label: 'Grey' } });
  await jens(`/api/books/${id}/bookmarks`, { method: 'POST', body: { ...hall, percent: 0.2, label: 'Hall' } });
  await anna(`/api/books/${id}/bookmarks`, { method: 'POST', body: { ...empty, percent: 0.9, label: 'Empty' } });
  const progressRows = () => db.prepare('SELECT * FROM progress WHERE book_id = ? ORDER BY user_id').all(id);
  const bookmarkRows = () => db.prepare('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY id').all(id);
  const progressBefore = progressRows();
  const bookmarksBefore = bookmarkRows();
  const versionBefore = (await jens(`/api/books/${id}/progress`)).data.version;
  assert.equal(versionBefore, manifestOf(id).convertedAt);

  const again = await reprocess(id);
  const now = textsOf(id);
  assert.equal(now.length, converted);
  const progressAfter = progressRows();
  const bookmarksAfter = bookmarkRows();
  // Each reads the same words as before, in the section that now holds them.
  progressBefore.forEach((p, i) => assert.equal(wordsAt(now, progressAfter[i]), wordsAt(old, p), `progress of user ${p.user_id}`));
  bookmarksBefore.forEach((b, i) => assert.equal(wordsAt(now, bookmarksAfter[i]), wordsAt(old, b), b.label));
  // The cut section is whole again, so the places from its later part on are one section further up.
  assert.deepEqual(progressAfter.map((p) => p.section), progressBefore.map((p) => p.section - 1));
  assert.deepEqual(bookmarksAfter.map((b) => [b.label, b.section]), [['Grey', grey.section - 1], ['Hall', hall.section], ['Empty', empty.section - 1]]);
  assert.deepEqual(bookmarksAfter[1], bookmarksBefore[1]); // before the cut, nothing moved
  // Only the place moves: when it was read, how far, on what device and the labels stay as they were.
  const rest = ({ section, offset, ...other }) => other;
  assert.deepEqual(progressAfter.map(rest), progressBefore.map(rest));
  assert.deepEqual(bookmarksAfter.map(rest), bookmarksBefore.map(rest));

  // The reader's API serves the moved places, with the book's new version.
  const read = (await jens(`/api/books/${id}/progress`)).data;
  assert.deepEqual([read.progress.section, read.progress.offset], [progressAfter[0].section, progressAfter[0].offset]);
  assert.equal(read.version, again.manifest.convertedAt);
  assert.notEqual(read.version, versionBefore);
});

test('a fix made before converting again is applied again, and places still move to the same words', async () => {
  const id = await upload('FixedMoved.epub', epub());
  assert.equal((await fixParagraph(id, 'They rode out at noon.', 'They rode out at noon, all of them.')).status, 201);
  const cut = placeOf(textsOf(id), 'Then came').section;
  cutOlder(id, cut, 'Then came');
  const old = textsOf(id);
  const evening = placeOf(old, 'By evening');
  const noon = placeOf(old, 'all of them');
  assert.deepEqual([evening.section, noon.section], [cut + 1, cut + 1]);
  await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { ...evening, percent: 0.45 } });
  await jens(`/api/books/${id}/bookmarks`, { method: 'POST', body: { ...noon, percent: 0.42, label: 'Noon' } });

  await reprocess(id);
  const now = textsOf(id);
  assert.match(fs.readFileSync(bookFile(id, 'sections', `${cut}.html`), 'utf8'), /They rode out at noon, all of them\./);
  assert.deepEqual((await jens(`/api/books/${id}/fixes`)).data.fixes.map((f) => [f.applied, f.section]), [[true, cut]]);
  const progress = (await jens(`/api/books/${id}/progress`)).data.progress;
  assert.equal(progress.section, cut);
  assert.equal(wordsAt(now, progress), wordsAt(old, evening));
  const [mark] = (await jens(`/api/books/${id}/bookmarks`)).data.bookmarks;
  assert.equal(wordsAt(now, mark), wordsAt(old, noon));
});

test('converting a book again with the same cut leaves its places as they are', async () => {
  const id = await upload('Same.epub', epub());
  const texts = textsOf(id);
  const place = placeOf(texts, 'far side');
  await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { ...place, percent: 0.7 } });
  const before = db.prepare('SELECT * FROM progress WHERE book_id = ?').get(id);
  await reprocess(id);
  assert.deepEqual(db.prepare('SELECT * FROM progress WHERE book_id = ?').get(id), before);
});

test('a place or bookmark sent from an older version of the book is found by its percent', async () => {
  const id = await upload('Versions.epub', epub());
  const manifest = manifestOf(id);
  const version = manifest.convertedAt;
  assert.ok(version > 0);
  const progress = () => jens(`/api/books/${id}/progress`);
  const put = (body) => jens(`/api/books/${id}/progress`, { method: 'PUT', body });
  const bookmark = async (body) => (await jens(`/api/books/${id}/bookmarks`, { method: 'POST', body })).data.bookmark;
  const placeIn = (p) => ({ section: p.section, offset: p.offset });

  let r = await progress();
  assert.deepEqual(r.data, { progress: null, version });
  const sent = { section: 0, offset: 3, percent: 0.6 };
  const found = atPercent(manifest, 0.6);
  assert.notDeepEqual(found, { section: 0, offset: 3 });
  r = await put({ ...sent, version: version - 1000 });
  assert.deepEqual(placeIn(r.data.progress), found);
  assert.equal(r.data.progress.percent, 0.6);
  // The version open is the current one, or not sent (an older reader): the place is kept as sent.
  r = await put({ ...sent, version });
  assert.deepEqual(placeIn(r.data.progress), { section: 0, offset: 3 });
  r = await put({ ...sent, offset: 4 });
  assert.deepEqual(placeIn(r.data.progress), { section: 0, offset: 4 });
  r = await put({ ...sent, offset: 5, version: 'old' });
  assert.deepEqual(placeIn(r.data.progress), { section: 0, offset: 5 });

  // A device that fell behind is told the version with the newer place.
  r = await put({ ...sent, knownUpdatedAt: 1, version: version - 1000 });
  assert.equal(r.status, 409);
  assert.equal(r.data.version, version);
  assert.deepEqual(placeIn(r.data.progress), { section: 0, offset: 5 });

  assert.deepEqual(placeIn(await bookmark({ ...sent, label: 'Old', version: version - 1000 })), found);
  assert.deepEqual(placeIn(await bookmark({ ...sent, label: 'Now', version })), { section: 0, offset: 3 });
  assert.deepEqual(placeIn(await bookmark({ ...sent, label: 'None' })), { section: 0, offset: 3 });

  // A book converted before books.converted_at was kept still has its version, from book.json.
  db.prepare('UPDATE books SET converted_at = 0 WHERE id = ?').run(id);
  assert.equal((await progress()).data.version, version);

  // While the book converts, its version is not known, and places are kept as sent: converting moves them.
  db.prepare("UPDATE books SET status = 'processing' WHERE id = ?").run(id);
  r = await progress();
  assert.equal(r.data.version, null);
  r = await put({ ...sent, offset: 6, version: version - 1000 });
  assert.equal(r.status, 200);
  assert.deepEqual(placeIn(r.data.progress), { section: 0, offset: 6 });
  assert.deepEqual(placeIn(await bookmark({ ...sent, offset: 7, label: 'Busy', version: version - 1000 })), { section: 0, offset: 7 });
  assert.equal((await put({ ...sent, knownUpdatedAt: 1 })).data.version, null);
  db.prepare("UPDATE books SET status = 'ready' WHERE id = ?").run(id);

  // A fix to the text gives the book a new version, and a place from before it is found by its percent.
  const fix = await fixParagraph(id, 'They rode out at noon.', 'They rode out at dawn.');
  assert.equal(fix.status, 201);
  const fixed = fix.data.manifest.convertedAt;
  assert.equal((await progress()).data.version, fixed);
  r = await put({ ...sent, percent: 0.3, version });
  assert.deepEqual(placeIn(r.data.progress), atPercent(fix.data.manifest, 0.3));
  r = await put({ ...sent, percent: 0.3, version: fixed });
  assert.deepEqual(placeIn(r.data.progress), { section: 0, offset: 3 });

  assert.equal((await jens('/api/books/0000000000000000/progress')).status, 404);
  assert.equal((await jens('/api/books/0000000000000000/progress', { method: 'PUT', body: sent })).status, 404);
  assert.equal((await jens('/api/books/0000000000000000/bookmarks', { method: 'POST', body: sent })).status, 404);
});
