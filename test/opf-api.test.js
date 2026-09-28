import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { readOpfDetails, withOpfDetails } from '../server/converters/index.js';
import { makeEpub } from './helpers/make-epub.mjs';
import { makePdf } from './helpers/make-pdf.mjs';
import { TINY_PNG } from './helpers/zipwriter.mjs';

let server, origin, dataDir, jens;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-opf-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
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

// An OPF file as calibre keeps one beside each book (metadata.opf), with its three-letter language.
const calibreOpf = ({ title = '', author = '', series = '', index = '', isbn = '', language = 'eng' }) => Buffer.from(`<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier opf:scheme="calibre" id="calibre_id">42</dc:identifier>
    <dc:identifier opf:scheme="uuid" id="uuid_id">6c2f4e3e-5b1a-4a1e-9d7e-1f0c3b9a2d11</dc:identifier>
    ${title ? `<dc:title>${title}</dc:title>` : ''}
    ${author ? `<dc:creator opf:file-as="Herbert, Frank" opf:role="aut">${author}</dc:creator>` : ''}
    <dc:language>${language}</dc:language>
    ${isbn ? `<dc:identifier opf:scheme="ISBN">${isbn}</dc:identifier>` : ''}
    ${series ? `<meta name="calibre:series" content="${series}"/><meta name="calibre:series_index" content="${index}"/>` : ''}
  </metadata>
  <guide><reference type="cover" title="Cover" href="cover.jpg"/></guide>
</package>`);

// Sends a book with the OPF file and cover that came with it ahead of it, as the library page does.
const post = (name, book, { opf = Buffer.alloc(0), cover = Buffer.alloc(0), headers = {} } = {}) => jens('/api/books', {
  method: 'POST',
  body: Buffer.concat([opf, cover, book]),
  headers: { 'x-file-name': encodeURIComponent(name), ...(opf.length ? { 'x-opf-size': String(opf.length) } : {}), ...(cover.length ? { 'x-cover-size': String(cover.length) } : {}), ...headers },
});
const waitReady = async (id) => {
  for (let i = 0; i < 200; i++) {
    const { data } = await jens(`/api/books/${id}`);
    if (data.book.status !== 'processing') return data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
};
const reprocess = async (id) => {
  assert.equal((await jens(`/api/books/${id}/reprocess`, { method: 'POST' })).status, 202);
  return (await waitReady(id)).book;
};
const series = (b) => b.series.map((s) => [s.name, s.position]);

test('an OPF file on its own is read like the package inside an EPUB', () => {
  assert.deepEqual(readOpfDetails(calibreOpf({ title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', index: '1.0', isbn: '978-0-441-01359-3' })),
    { title: 'Dune', author: 'Frank Herbert', language: 'eng', series: [{ name: 'Dune Chronicles', position: 1 }], isbns: ['9780441013593'] });
  for (const other of ['not xml at all', '<html><body>A page</body></html>', calibreOpf({})]) assert.equal(readOpfDetails(Buffer.from(other)), null, String(other).slice(0, 30));

  // What the OPF names wins; the file's own fill in the rest, and the ISBNs of both count.
  const file = { title: 'Dune: Deluxe Edition', author: 'Herbert, Frank', language: 'en-GB', format: 'epub', series: [], isbns: ['9780593099322'] };
  assert.deepEqual(withOpfDetails(file, { title: 'Dune', author: '', language: 'dan', series: [{ name: 'Dune Chronicles', position: 1 }], isbns: ['9780441013593'] }),
    { ...file, title: 'Dune', language: 'da', series: [{ name: 'Dune Chronicles', position: 1 }], isbns: ['9780593099322', '9780441013593'] });
  // calibre's "und" is no language.
  assert.equal(withOpfDetails(file, { title: '', author: '', language: 'und', series: [], isbns: [] }).language, 'en-GB');
});

test('the details and cover that come with a book are used', async () => {
  const opf = calibreOpf({ title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles', index: '1', isbn: '9780441013593' });
  const r = await post('Dune - Frank Herbert.pdf', makePdf([['In the week before their departure to Arrakis.']]), { opf, cover: TINY_PNG });
  assert.equal(r.status, 202);
  assert.deepEqual(r.data.used, { opf: true, cover: true });
  assert.deepEqual([r.data.book.title, r.data.book.author], ['Dune', 'Frank Herbert'], 'named so while it is prepared');

  const { book, manifest } = await waitReady(r.data.book.id);
  assert.deepEqual([book.status, book.title, book.author, book.language, series(book)], ['ready', 'Dune', 'Frank Herbert', 'en', [['Dune Chronicles', 1]]]);
  assert.deepEqual([manifest.title, manifest.author, manifest.language], ['Dune', 'Frank Herbert', 'en']);
  assert.deepEqual([book.hasCover, book.coverSource], [true, 'custom']);
  assert.equal((await jens(`/books/${book.id}/cover`)).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'books', book.id, 'custom-cover.png')), TINY_PNG);
  assert.ok(fs.existsSync(path.join(dataDir, 'books', book.id, 'metadata.opf')));

  // Converting again reads it again; details edited by hand still win over it.
  const converted = await reprocess(book.id);
  assert.deepEqual([converted.title, series(converted), converted.coverSource], ['Dune', [['Dune Chronicles', 1]], 'custom']);
  await jens(`/api/books/${book.id}`, { method: 'PATCH', body: { title: 'Dune (my copy)' } });
  assert.equal((await reprocess(book.id)).title, 'Dune (my copy)');

  // The same file again is turned away, whatever comes with it.
  const again = await post('Dune again.pdf', makePdf([['In the week before their departure to Arrakis.']]), { opf });
  assert.equal(again.status, 409);
  assert.equal(again.data.book.id, book.id);
  assert.equal(again.data.used, undefined);
});

test('an OPF file wins over the details in an EPUB, which fill in what it leaves out', async () => {
  const epub = makeEpub({ title: 'Dune: Deluxe Edition', author: 'Herbert, Frank', metadata: '<dc:identifier opf:scheme="ISBN">9780593099322</dc:identifier>' });
  const r = await post('dune.epub', epub, { opf: calibreOpf({ title: 'Dune', series: 'Dune Chronicles', index: '1', isbn: '9780441013593', language: 'und' }) });
  const { book } = await waitReady(r.data.book.id);
  assert.deepEqual([book.title, book.author, book.language, series(book), book.hasCover, book.coverSource], ['Dune', 'Herbert, Frank', 'en', [['Dune Chronicles', 1]], true, 'file']);

  // Both ISBNs count for finding the same book: the PDF from the test before shares the OPF file's, and
  // a new PDF whose OPF file names the EPUB's own is flagged too.
  const pdf = await post('Dune.pdf', makePdf([['Another copy.']]), { opf: calibreOpf({ title: 'Dune (scan)', isbn: '9780593099322' }) });
  await waitReady(pdf.data.book.id);
  const { data } = await jens('/api/books');
  const earlier = data.books.find((b) => b.title === 'Dune (my copy)');
  const byId = (list) => [...list].sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(byId(data.books.find((b) => b.id === book.id).duplicates), byId([{ id: earlier.id, reason: 'isbn' }, { id: pdf.data.book.id, reason: 'isbn' }]));
});

test('files that are not what they say are left out, and the book still goes in', async () => {
  const r = await post('Plain.epub', makeEpub({ title: 'Plain', author: 'Someone' }), { opf: Buffer.from('not an opf file'), cover: Buffer.from('not a picture') });
  assert.equal(r.status, 202);
  assert.deepEqual(r.data.used, { opf: false, cover: false });
  const { book } = await waitReady(r.data.book.id);
  assert.deepEqual([book.title, book.author, book.coverSource], ['Plain', 'Someone', 'file']);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'books', book.id)).filter((f) => /metadata|custom-cover/.test(f)), []);

  // Sizes that do not add up are refused.
  const epub = makeEpub({ title: 'Sizes' });
  for (const headers of [{ 'x-opf-size': 'abc' }, { 'x-opf-size': '-1' }, { 'x-cover-size': '1.5' }, { 'x-opf-size': String(epub.length + 1) }]) {
    assert.equal((await post('sizes.epub', epub, { headers })).status, 400, JSON.stringify(headers));
  }
  const noBook = await jens('/api/books', { method: 'POST', body: Buffer.from('<package/>'), headers: { 'x-file-name': 'x.epub', 'x-opf-size': '10' } });
  assert.equal(noBook.status, 400);
});
