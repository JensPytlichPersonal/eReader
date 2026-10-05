import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { ZipReader } from '../server/converters/zip.js';
import { convertEpub } from '../server/converters/epub.js';
import { serialize } from '../server/converters/html.js';
import { parseXml, findAllLocal, findFirstLocal, attr, text } from '../server/converters/xml.js';
import { parseSection } from '../server/fixes.js';
import { epubFileName, asciiFileName, attachmentHeader, bookUuid, exportNodes, linkTargets } from '../server/epub-export.js';
import { makeEpub } from './helpers/make-epub.mjs';
import { makePdf } from './helpers/make-pdf.mjs';
import { TINY_PNG } from './helpers/zipwriter.mjs';

let server, origin, db, dataDir, jens, anna;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-epub-export-'));
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

// Answers in JSON as data, and any other answer as a Buffer.
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
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, data };
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
const edit = async (id, body) => assert.equal((await jens(`/api/books/${id}`, { method: 'PATCH', body })).status, 200);
const download = (id, who = anna) => who(`/api/books/${id}/epub`);
// The name in a Content-Disposition: the ASCII one in quotes, and the UTF-8 one after filename*.
const namesIn = (header) => ({
  ascii: /filename="([^"]*)"/.exec(header)?.[1],
  utf8: decodeURIComponent(/filename\*=UTF-8''(\S+)$/.exec(header)?.[1] ?? ''),
});
const packageOf = (zip) => parseXml(zip.readText('OEBPS/content.opf'));
const flatTitles = (toc) => toc.flatMap((e) => [e.title, ...flatTitles(e.children || [])]);

// A 1x1 GIF, for the book's own cover, so the PNG picked by hand can be told from it.
const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let books = 0;
// A new copy of the book each time: the same file is not added twice.
const epub = (opts = {}) => makeEpub({ title: `Export Book ${++books}`, cover: { href: 'images/cover.gif', type: 'image/gif', data: TINY_GIF }, ...opts });

test('a reader downloads a book as an EPUB with its fixed text and the details as the library shows them', async () => {
  const id = await upload('Export.epub', epub());
  const before = await waitReady(id);
  await edit(id, { title: 'Edited Title', author: 'Ann Author & Bob Writer', genre: 'Fantasy',
    series: [{ name: 'The Saga', position: 2 }, { name: 'Book Club', position: '' }] });
  const cover = await jens(`/api/books/${id}/cover`, { method: 'PUT', body: TINY_PNG, headers: { 'content-type': 'image/png' } });
  assert.equal(cover.status, 200);
  const fix = await jens(`/api/books/${id}/fixes`, { method: 'POST', body: { section: 0, paragraph: 1, before: ['Hello world. See note.'], after: ['Hello wide world. See note.'] } });
  assert.equal(fix.status, 201);

  // Anna is not an admin, and did not add the book.
  const r = await download(id);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/epub+zip');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(namesIn(r.headers.get('content-disposition')),
    { ascii: 'Ann Author & Bob Writer-Edited Title.epub', utf8: 'Ann Author & Bob Writer-Edited Title.epub' });

  // The mimetype comes first, stored without an extra field, so its text starts at byte 38.
  const buf = r.data;
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(8), 0, 'stored');
  assert.equal(buf.readUInt16LE(28), 0, 'no extra field');
  assert.equal(buf.toString('latin1', 30, 38), 'mimetype');
  assert.equal(buf.toString('latin1', 38, 58), 'application/epub+zip');
  assert.notEqual(buf.readUInt16LE(12), 0, 'dated');
  const zip = new ZipReader(buf);
  assert.equal(zip.names()[0], 'mimetype');
  assert.equal(zip.readText('mimetype'), 'application/epub+zip');
  assert.equal(attr(findFirstLocal(parseXml(zip.readText('META-INF/container.xml')), 'rootfile'), 'full-path'), 'OEBPS/content.opf');

  // The package's details.
  const opf = packageOf(zip);
  const metadata = findFirstLocal(opf, 'metadata');
  const metas = findAllLocal(metadata, 'meta');
  const meta = (property) => metas.filter((m) => attr(m, 'property') === property);
  assert.equal(attr(opf.children.find((c) => c.name === 'package'), 'unique-identifier'), 'book-id');
  assert.equal(text(findFirstLocal(metadata, 'identifier')), bookUuid(id));
  assert.equal(text(findFirstLocal(metadata, 'title')), 'Edited Title');
  assert.deepEqual(findAllLocal(metadata, 'creator').map(text), ['Ann Author', 'Bob Writer']);
  assert.equal(text(findFirstLocal(metadata, 'language')), 'en');
  assert.equal(text(findFirstLocal(metadata, 'subject')), 'Fantasy');
  assert.match(text(meta('dcterms:modified')[0]), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const collections = meta('belongs-to-collection').map((m) => {
    const refined = (p) => text(metas.find((x) => attr(x, 'refines') === `#${attr(m, 'id')}` && attr(x, 'property') === p));
    return [text(m), refined('collection-type'), refined('group-position')];
  });
  assert.deepEqual(collections, [['The Saga', 'series', '2'], ['Book Club', 'set', '']]);
  const named = (n) => attr(metas.find((m) => attr(m, 'name') === n), 'content');
  assert.equal(named('calibre:series'), 'The Saga');
  assert.equal(named('calibre:series_index'), '2');
  assert.equal(named('cover'), 'cover-image');

  // Every file the package names is in the zip, and the reading order names only those.
  const items = findAllLocal(findFirstLocal(opf, 'manifest'), 'item');
  for (const item of items) assert.ok(zip.has(`OEBPS/${decodeURIComponent(attr(item, 'href'))}`), attr(item, 'href'));
  const ids = new Set(items.map((i) => attr(i, 'id')));
  const spine = findFirstLocal(opf, 'spine');
  assert.equal(attr(spine, 'toc'), 'ncx');
  for (const ref of findAllLocal(spine, 'itemref')) assert.ok(ids.has(attr(ref, 'idref')), attr(ref, 'idref'));
  const item = (id) => items.find((i) => attr(i, 'id') === id);
  assert.equal(attr(item('nav'), 'properties'), 'nav');
  assert.equal(attr(item('ncx'), 'media-type'), 'application/x-dtbncx+xml');
  assert.equal(attr(item('cover-image'), 'properties'), 'cover-image');
  assert.equal(attr(item('cover-image'), 'media-type'), 'image/png');
  assert.deepEqual(zip.read(`OEBPS/${attr(item('cover-image'), 'href')}`), TINY_PNG);
  assert.equal(attr(findAllLocal(spine, 'itemref')[0], 'idref'), 'cover-page');
  const ncxUid = findAllLocal(parseXml(zip.readText('OEBPS/toc.ncx')), 'meta').find((m) => attr(m, 'name') === 'dtb:uid');
  assert.equal(attr(ncxUid, 'content'), bookUuid(id));

  // Read back as the app reads an upload.
  const back = await convertEpub(buf);
  assert.equal(back.meta.title, 'Edited Title');
  assert.equal(back.meta.author, 'Ann Author, Bob Writer');
  assert.deepEqual(back.meta.series, [{ name: 'The Saga', position: 2 }, { name: 'Book Club', position: null }]);
  assert.deepEqual(flatTitles(back.toc), flatTitles(before.manifest.toc));
  assert.deepEqual(back.cover.data, TINY_PNG);
  const html = back.sections.map((s) => serialize(s.nodes));
  const first = html.findIndex((h) => h.includes('Hello <em>wide world</em>') || h.includes('Hello wide <em>world</em>'));
  assert.ok(first >= 0, 'the fixed text');
  const picture = /<img[^>]*data-src="([^"]+)"/.exec(html[first])?.[1];
  assert.ok(picture, 'the picture');
  assert.deepEqual(back.images.get(picture), TINY_PNG);
  const link = /<a [^>]*data-sec="(\d+)" data-id="note1"[^>]*>note<\/a>/.exec(html[first]);
  assert.ok(link, 'the link to the note');
  assert.match(html[Number(link[1])], /id="note1"/);
});

test('the file name: the title alone without an author, characters a file name cannot hold replaced, Danish letters kept', async () => {
  const id = await upload('Names.epub', epub({ author: '' }));
  await edit(id, { title: 'Lonely Book' });
  assert.deepEqual(namesIn((await download(id)).headers.get('content-disposition')), { ascii: 'Lonely Book.epub', utf8: 'Lonely Book.epub' });

  await edit(id, { title: 'What: Why? <Now>/Then', author: 'Ann "Quote" Author|X' });
  assert.deepEqual(namesIn((await download(id)).headers.get('content-disposition')),
    { ascii: 'Ann Quote Author X-What Why Now Then.epub', utf8: 'Ann Quote Author X-What Why Now Then.epub' });

  await edit(id, { title: 'Blåbærgrød på Café Ærø', author: 'Søren Ågård' });
  const header = (await download(id)).headers.get('content-disposition');
  assert.deepEqual(namesIn(header), { ascii: 'Soeren Aagaard-Blaabaergroed paa Cafe Aeroe.epub', utf8: 'Søren Ågård-Blåbærgrød på Café Ærø.epub' });
  assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''[A-Za-z0-9%.!~_-]+$/);
});

test('file names: trimmed, cut at a word, Untitled when nothing is left', () => {
  assert.equal(epubFileName({ title: 'Pawn of Prophecy', author: 'David Eddings' }), 'David Eddings-Pawn of Prophecy.epub');
  assert.equal(epubFileName({ title: ' .Dots and spaces.. ', author: '' }), 'Dots and spaces.epub');
  assert.equal(epubFileName({ title: '???', author: '' }), 'Untitled.epub');
  assert.equal(epubFileName({ title: 'Tab\there\u0007', author: 'A/B' }), 'A B-Tab here.epub');
  const long = epubFileName({ title: 'word '.repeat(60).trim(), author: 'Author' });
  assert.ok(long.length <= 150 + '.epub'.length, long);
  assert.match(long, /^Author-word( word)+\.epub$/);
  // A name with no space to cut at is cut where it is too long.
  assert.equal(epubFileName({ title: 'x'.repeat(200), author: '' }), `${'x'.repeat(150)}.epub`);
  assert.equal(asciiFileName('Æble Øl Åen Straße naïve ／'), 'Aeble Oel Aaen Strasse naive _');
  assert.equal(attachmentHeader("It's (done).epub"), 'attachment; filename="It\'s (done).epub"; filename*=UTF-8\'\'It%27s%20%28done%29.epub');
});

test('the identifier stays the same for a book, as a version 5 UUID', () => {
  assert.equal(bookUuid('0123456789abcdef'), bookUuid('0123456789abcdef'));
  assert.notEqual(bookUuid('0123456789abcdef'), bookUuid('fedcba9876543210'));
  assert.match(bookUuid('0123456789abcdef'), /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a section as EPUB text: pictures, links, footnotes, empty PDF pages and characters XML cannot hold', () => {
  const sections = [
    '<span class="pg" id="pg1"></span><h1 id="rr0-h1">One</h1><p>Text<sup><a id="fnref-1-1-1" href="#sec=1&amp;id=fn-1-1" data-sec="1" data-id="fn-1-1">1</a></sup>'
      + ' and <a href="#sec=1" data-sec="1">two</a>, <a href="#sec=1&amp;id=lost" data-sec="1" data-id="lost">lost</a>,'
      + ' <a href="https://example.com" target="_blank" rel="noopener">out</a>, <a href="#nowhere">here</a>.</p>'
      + '<p data-type="x"><img data-src="images/a.png" alt="" loading="lazy"/><img data-src="images/gone.png" loading="lazy"/>Bell\u0007 and \uD800half</p>'
      + '<hr class="scene-break"/><span class="anchor" id="keep"></span>',
    '<p><span class="pdf-empty">[Page 2 has no extractable text - use the page view]</span></p>'
      + '<section class="endnotes"><p class="footnote" id="fn-1-1"><sup><a href="#sec=0&amp;id=fnref-1-1-1" data-sec="0" data-id="fnref-1-1-1">1</a></sup> A note.</p></section>',
  ];
  const roots = sections.map(parseSection);
  const book = { ...linkTargets(roots), images: new Map([['images/a.png', TINY_PNG]]), used: new Set() };
  assert.deepEqual([...book.notes], ['fn-1-1']);
  assert.deepEqual(book.ids.map((ids) => [...ids]), [['pg1', 'rr0-h1', 'fnref-1-1-1', 'keep'], ['fn-1-1']]);
  const [one, two] = roots.map((root) => { exportNodes(root.children, book); return serialize(root.children); });
  assert.equal(one, '<span class="pg" id="pg1"></span><h1 id="rr0-h1">One</h1><p>Text<sup><a id="fnref-1-1-1" href="part-2.xhtml#fn-1-1" epub:type="noteref">1</a></sup>'
    + ' and <a href="part-2.xhtml">two</a>, <a href="part-2.xhtml">lost</a>, <a href="https://example.com" target="_blank" rel="noopener">out</a>, <a>here</a>.</p>'
    + '<p><img alt="" src="../images/a.png" />Bell and half</p><hr class="scene-break" /><span class="anchor" id="keep"></span>');
  assert.equal(two, '<p><span class="pdf-empty">[Page 2 has no text]</span></p>'
    + '<section class="endnotes" epub:type="footnotes"><aside epub:type="footnote" id="fn-1-1"><p class="footnote"><sup><a href="part-1.xhtml#fnref-1-1-1">1</a></sup> A note.</p></aside></section>');
  assert.deepEqual([...book.used], ['images/a.png']);
});

test('a PDF downloads as an EPUB of its text, a page without text saying so', async () => {
  const id = await upload('Paper.pdf', makePdf([['The first page of the paper.', 'It goes on here.'], []], { title: 'Paper Title' }));
  const r = await download(id);
  assert.equal(r.status, 200);
  assert.equal(namesIn(r.headers.get('content-disposition')).utf8, 'Paper Title.epub');
  const zip = new ZipReader(r.data);
  // No language: none on the pages, and "und" in the package.
  assert.equal(text(findFirstLocal(findFirstLocal(packageOf(zip), 'metadata'), 'language')), 'und');
  const parts = zip.names().filter((n) => /^OEBPS\/text\/part-\d+\.xhtml$/.test(n)).map((n) => zip.readText(n)).join('\n');
  assert.doesNotMatch(parts, /xml:lang/);
  assert.match(parts, /The first page of the paper\./);
  assert.match(parts, /<span class="pg" id="pg1"\/>/);
  assert.match(parts, /\[Page 2 has no text\]/);
  assert.ok(!zip.has('OEBPS/text/cover.xhtml'), 'no cover');
  const back = await convertEpub(r.data);
  assert.equal(back.meta.title, 'Paper Title');
  assert.match(back.sections.map((s) => serialize(s.nodes)).join(''), /The first page of the paper\. It goes on here\./);
});

test('no EPUB for a book that is not there, is being converted or could not be converted', async () => {
  assert.equal((await download('0000000000000000')).status, 404);
  const id = await upload('Refused.epub', epub());
  db.prepare("UPDATE books SET status = 'processing' WHERE id = ?").run(id);
  const busy = await download(id);
  assert.equal(busy.status, 409);
  assert.equal(busy.data.error, 'The book is being converted. Try again in a moment.');
  db.prepare("UPDATE books SET status = 'error' WHERE id = ?").run(id);
  assert.deepEqual((await download(id)).data, { error: 'The book could not be converted' });
  db.prepare("UPDATE books SET status = 'ready' WHERE id = ?").run(id);
  assert.equal((await download(id)).status, 200);
});
