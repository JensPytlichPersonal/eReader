import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { makeEpub } from './helpers/make-epub.mjs';
import { makePdf } from './helpers/make-pdf.mjs';

let server, origin, processor, dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-api-'));
  const created = createApp({ dataDir, quiet: true, sessionDays: 1 });
  processor = created.processor;
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// Minimal cookie-aware client
function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (Buffer.isBuffer(body)) { payload = body; h['content-type'] ??= 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(origin + p, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

const waitReady = async (c, id) => {
  for (let i = 0; i < 100; i++) {
    const { data } = await c(`/api/books/${id}`);
    if (data.book.status !== 'processing') return data;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
};

test('first account becomes admin, later registration is blocked, admin adds users', async () => {
  const jens = client();
  let r = await jens('/api/auth/me');
  assert.equal(r.status, 401);
  assert.equal(r.data.setupRequired, true);
  r = await jens('/api/auth/register', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'Laptop' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.isAdmin, true);
  r = await jens('/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.username, 'jens');
  assert.equal(r.data.device, 'Laptop');

  const anon = client();
  r = await anon('/api/auth/register', { method: 'POST', body: { username: 'mallory', password: 'secret1' } });
  assert.equal(r.status, 403);
  r = await anon('/api/users');
  assert.equal(r.status, 401);

  r = await jens('/api/users', { method: 'POST', body: { username: 'anna', password: 'pass1234', displayName: 'Anna' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.isAdmin, false);
  r = await jens('/api/users', { method: 'POST', body: { username: 'anna', password: 'pass1234' } });
  assert.equal(r.status, 409);
  r = await jens('/api/users', { method: 'POST', body: { username: 'x y', password: 'pass1234' } });
  assert.equal(r.status, 400);

  const anna = client();
  r = await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'wrong' } });
  assert.equal(r.status, 401);
  r = await anna('/api/auth/login', { method: 'POST', body: { username: 'ANNA', password: 'pass1234', device: 'Boox' } });
  assert.equal(r.status, 200);
  r = await anna('/api/users');
  assert.equal(r.status, 403);
  r = await anna('/api/auth/password', { method: 'POST', body: { currentPassword: 'pass1234', newPassword: 'newpass1' } });
  assert.equal(r.status, 200);
  r = await anna('/api/auth/logout', { method: 'POST' });
  assert.equal(r.status, 200);
  r = await anna('/api/auth/me');
  assert.equal(r.status, 401);
  r = await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'newpass1' } });
  assert.equal(r.status, 200);
});

test('upload, conversion, shared library and per-user progress with conflict detection', async () => {
  const jens = client();
  await jens('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'Laptop' } });
  const anna = client();
  await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'newpass1', device: 'Boox' } });

  let r = await jens('/api/books', { method: 'POST', body: makeEpub({ title: 'Shared Book' }), headers: { 'x-file-name': encodeURIComponent('Shared Book.epub') } });
  assert.equal(r.status, 202);
  const id = r.data.book.id;
  r = await jens('/api/books', { method: 'POST', body: Buffer.from('garbage'), headers: { 'x-file-name': 'file.docx' } });
  assert.equal(r.status, 415);
  r = await jens('/api/books', { method: 'POST', body: Buffer.alloc(0), headers: { 'x-file-name': 'a.txt' } });
  assert.equal(r.status, 400);

  const detail = await waitReady(jens, id);
  assert.equal(detail.book.status, 'ready');
  assert.equal(detail.book.title, 'Shared Book');
  assert.equal(detail.manifest.sections.length, 2);
  assert.equal(detail.progress, null);

  // Anna sees the same book
  r = await anna('/api/books');
  assert.equal(r.data.books.length, 1);
  assert.equal(r.data.books[0].id, id);
  assert.equal(r.data.books[0].addedBy, 'jens');

  // Section and cover files require auth
  r = await client()(`/books/${id}/sections/0.html`);
  assert.equal(r.status, 401);
  r = await anna(`/books/${id}/sections/0.html`);
  assert.equal(r.status, 200);
  assert.match(r.data, /Chapter One/);
  r = await anna(`/books/${id}/cover`);
  assert.equal(r.status, 200);
  r = await anna(`/books/${id}/book.json`);
  assert.equal(r.status, 200);
  r = await anna(`/books/${id}/../../ereader.sqlite`);
  assert.equal(r.status, 404);
  r = await anna(`/books/${id}/original`);
  assert.equal(r.status, 200);

  // Progress is per user
  r = await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 20, percent: 0.6, knownUpdatedAt: 0 } });
  assert.equal(r.status, 200);
  const t1 = r.data.progress.updatedAt;
  assert.equal(r.data.progress.device, 'Laptop');
  r = await anna(`/api/books/${id}/progress`);
  assert.equal(r.data.progress, null);
  r = await anna(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 0, offset: 5, percent: 0.1 } });
  assert.equal(r.status, 200);
  r = await jens('/api/books');
  assert.equal(r.data.books[0].progress.section, 1);
  r = await anna('/api/books');
  assert.equal(r.data.books[0].progress.section, 0);

  // Another of jens's devices writes; the first device's stale update is rejected with the newer position
  await new Promise((res) => setTimeout(res, 5));
  const jensPhone = client();
  await jensPhone('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'iPhone' } });
  r = await jensPhone(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 300, percent: 0.9, knownUpdatedAt: t1 } });
  assert.equal(r.status, 200);
  const t2 = r.data.progress.updatedAt;
  assert.ok(t2 > t1);
  r = await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 40, percent: 0.65, knownUpdatedAt: t1 } });
  assert.equal(r.status, 409);
  assert.equal(r.data.progress.offset, 300);
  assert.equal(r.data.progress.device, 'iPhone');
  r = await jens(`/api/books/${id}/progress`, { method: 'PUT', body: { section: 1, offset: 40, percent: 0.65, knownUpdatedAt: t2 } });
  assert.equal(r.status, 200);

  // Readers list
  r = await anna(`/api/books/${id}/readers`);
  assert.deepEqual(r.data.readers.map((x) => x.username).sort(), ['anna', 'jens']);

  // Bookmarks
  r = await anna(`/api/books/${id}/bookmarks`, { method: 'POST', body: { section: 0, offset: 3, percent: 0.05, label: 'Start' } });
  assert.equal(r.status, 201);
  r = await jens(`/api/books/${id}/bookmarks`);
  assert.equal(r.data.bookmarks.length, 0);
  r = await anna(`/api/books/${id}/bookmarks`);
  assert.equal(r.data.bookmarks.length, 1);

  // Only uploader or admin can delete; anna cannot, jens can
  r = await anna(`/api/books/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 403);
  r = await anna(`/api/books/${id}`, { method: 'PATCH', body: { title: 'Nope' } });
  assert.equal(r.status, 403);
  r = await jens(`/api/books/${id}`, { method: 'PATCH', body: { title: 'Renamed', author: 'Someone' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.book.title, 'Renamed');
  const before = (await jens(`/api/books/${id}`)).data.book.convertedAt;
  assert.ok(before > 0);
  await new Promise((res) => setTimeout(res, 5));
  r = await jens(`/api/books/${id}/reprocess`, { method: 'POST' });
  assert.equal(r.status, 202);
  const after = await waitReady(jens, id);
  assert.ok(after.book.convertedAt > before, 'reconversion bumps convertedAt');
  assert.equal(after.manifest.convertedAt, after.book.convertedAt);
  r = await jens(`/api/books/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  r = await anna(`/api/books/${id}`);
  assert.equal(r.status, 404);
  assert.equal(fs.existsSync(path.join(dataDir, 'books', id)), false);
});

test('conversion failure is reported on the book', async () => {
  const jens = client();
  await jens('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
  const r = await jens('/api/books', { method: 'POST', body: Buffer.from('PK\x03\x04 not really a zip'), headers: { 'x-file-name': 'broken.epub' } });
  assert.equal(r.status, 202);
  const detail = await waitReady(jens, r.data.book.id);
  assert.equal(detail.book.status, 'error');
  assert.ok(detail.book.error.length > 0);
  await jens(`/api/books/${r.data.book.id}`, { method: 'DELETE' });
});

test('an SVG from a book is sandboxed, so opening it directly cannot run its scripts', async () => {
  const jens = client();
  await jens('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
  // A book can carry SVGs: an EPUB cover, and a figure inside a chapter. Either could hold a <script>.
  const svg = (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123"/><script>document.title=${JSON.stringify(id)}</script></svg>`;
  const epub = makeEpub({
    title: 'Has SVGs',
    cover: { href: 'images/cover.svg', type: 'image/svg+xml', data: svg('cover') },
    chapters: [{ id: 'ch1', file: 'ch1.xhtml', title: 'One', body: '<h1>One</h1><p><img src="images/fig.svg" alt="a figure"/></p>' }],
    files: [{ name: 'images/fig.svg', data: svg('figure') }],
  });
  let r = await jens('/api/books', { method: 'POST', body: epub, headers: { 'x-file-name': encodeURIComponent('Has SVGs.epub') } });
  const id = r.data.book.id;
  const detail = await waitReady(jens, id);
  assert.equal(detail.book.status, 'ready');
  assert.equal(detail.book.hasCover, true);

  // The sandbox gives the file an opaque origin and blocks scripts, forms and network access, so a
  // <script> in an SVG opened as a page cannot act as the viewer. The SVG still draws inside an <img>.
  const sandboxed = (res) => {
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /(^|;)\s*sandbox\s*(;|$)/, `expected a sandbox in "${csp}"`);
    assert.match(csp, /default-src 'none'/);
  };

  // The book's own cover is an SVG here (image/svg+xml), and it is sandboxed.
  r = await jens(`/books/${id}/cover`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  sandboxed(r);

  // The SVG figure inside the chapter, served from the book's files, is sandboxed too.
  const section = await jens(`/books/${id}/sections/0.html`);
  const figurePath = section.data.match(/data-src="(images\/[^"]+\.svg)"/)?.[1];
  assert.ok(figurePath, `expected an SVG figure in the section, got: ${section.data}`);
  r = await jens(`/books/${id}/${figurePath}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  sandboxed(r);
  // Other book files (the manifest, styles) carry it as well.
  sandboxed(await jens(`/books/${id}/book.json`));

  // The original download is not sandboxed: its formats are never run as a page, and the built-in
  // PDF viewer needs its own scripts.
  r = await jens(`/books/${id}/original`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.headers.get('content-security-policy') || '', /sandbox/);

  await jens(`/api/books/${id}`, { method: 'DELETE' });
});

test('an original is sent as the format it was read as, whatever its file name says', async () => {
  const jens = client();
  await jens('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
  // The uploader picks the file name, but the format is read from the file's first bytes. A name
  // ending in .html or .svg must not make the browser open the original as a page on this site.
  const cases = [
    ['Paper.html', makePdf([['A page of text.']]), 'application/pdf'],
    ['Novel.svg', makeEpub({ title: 'Novel' }), 'application/epub+zip'],
    ['Notes.txt', Buffer.from('Some plain notes.'), 'text/plain; charset=utf-8'],
  ];
  for (const [name, body, type] of cases) {
    const r = await jens('/api/books', { method: 'POST', body, headers: { 'x-file-name': encodeURIComponent(name) } });
    assert.equal(r.status, 202, name);
    await waitReady(jens, r.data.book.id);
    const original = await jens(`/books/${r.data.book.id}/original`);
    assert.equal(original.status, 200, name);
    assert.equal(original.headers.get('content-type'), type, name);
    await jens(`/api/books/${r.data.book.id}`, { method: 'DELETE' });
  }
});

test('the font is kept on the account, so each device of a user gets the same one', async () => {
  const laptop = client();
  await laptop('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'Laptop' } });
  let r = await laptop('/api/auth/me');
  assert.equal(r.data.user.font, '');
  r = await laptop('/api/auth/me', { method: 'PATCH', body: { font: 'georgia' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.font, 'georgia');

  const boox = client();
  await boox('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1', device: 'Boox' } });
  assert.equal((await boox('/api/auth/me')).data.user.font, 'georgia');
  const anna = client();
  await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'newpass1' } });
  assert.equal((await anna('/api/auth/me')).data.user.font, '', 'every reader has their own');

  for (const font of ['<b>serif</b>', 12, 'x'.repeat(41)]) assert.equal((await boox('/api/auth/me', { method: 'PATCH', body: { font } })).status, 400);
  assert.equal((await client()('/api/auth/me', { method: 'PATCH', body: { font: 'mono' } })).status, 401);
  r = await boox('/api/auth/me', { method: 'PATCH', body: { font: '' } });
  assert.equal(r.data.user.font, '');
  assert.equal((await laptop('/api/auth/me')).data.user.font, '');
});

test('the bundled fonts are served with the app', async () => {
  const css = await client()('/css/fonts.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const families = new Set([...css.data.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...families], ['Literata', 'Merriweather', 'Libre Baskerville', 'Bitter', 'Atkinson Hyperlegible', 'OpenDyslexic']);
  const urls = [...new Set([...css.data.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]))];
  assert.ok(urls.length > 100 && urls.every((u) => u.startsWith('/vendor/fonts/')));
  for (const url of urls.filter((u) => u.includes('-latin-'))) {
    const res = await fetch(origin + url, { method: 'HEAD' });
    assert.equal(res.status, 200, url);
  }
});

test('the PDF viewer gets the decoders for scanned pages (JBIG2, CCITT fax, JPEG 2000) and colour profiles', async () => {
  for (const file of ['wasm/jbig2.wasm', 'wasm/openjpeg.wasm', 'wasm/qcms_bg.wasm', 'wasm/jbig2_nowasm_fallback.js', 'wasm/openjpeg_nowasm_fallback.js', 'iccs/CGATS001Compat-v2-micro.icc']) {
    const res = await fetch(`${origin}/vendor/pdfjs/${file}`, { method: 'HEAD' });
    assert.equal(res.status, 200, file);
  }
  // The fallbacks are imported as modules, which browsers only run when they are sent as scripts.
  const fallback = await fetch(`${origin}/vendor/pdfjs/wasm/jbig2_nowasm_fallback.js`, { method: 'HEAD' });
  assert.match(fallback.headers.get('content-type'), /javascript/);
});

test('scripts and styles are checked for changes on every load, so a reload gets a new version', async () => {
  for (const file of ['/js/reader.js', '/js/settings-page.js', '/css/app.css', '/css/reader.css']) {
    const res = await fetch(origin + file);
    await res.text();
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('cache-control'), 'no-cache', file);
    // As a browser revalidates. (fetch would add "cache-control: no-cache" to a conditional request, which skips the 304.)
    const again = await fetch(origin + file, { headers: { 'if-none-match': res.headers.get('etag'), 'cache-control': 'max-age=0' } });
    assert.equal(again.status, 304, file);
  }
  // Icons change rarely and may be kept for an hour.
  const icon = await fetch(origin + '/icons/icon.svg');
  await icon.text();
  assert.equal(icon.headers.get('cache-control'), 'public, max-age=3600');
});

test('the bundled fonts with every weight come drawn heavier, for the text weight setting', async () => {
  const get = client();
  const faces = (css) => [...css.matchAll(/font-family: '([^']+)';\s*font-style: (\w+);[^}]*?font-weight: (\d+);\s*src: url\(([^)]+)\)/g)]
    .map(([, family, style, weight, url]) => ({ family, style, weight, url }));

  const css = await get('/css/fonts/literata-600.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const literata = faces(css.data);
  // A family of its own with the regular and bold styles, drawn with the semibold and the black faces.
  assert.deepEqual(new Set(literata.map((f) => `${f.family} ${f.weight} ${f.style}`)), new Set(['Literata 600 400 normal', 'Literata 600 400 italic', 'Literata 600 700 normal', 'Literata 600 700 italic']));
  for (const f of literata) assert.ok(f.url.endsWith(`-${f.weight === '400' ? 600 : 900}-${f.style}.woff2`), f.url);
  for (const f of literata.filter((x) => x.url.includes('-latin-'))) assert.equal((await fetch(origin + f.url, { method: 'HEAD' })).status, 200, f.url);

  // Libre Baskerville goes no heavier than bold, so at bold its bold text is the same face.
  const baskerville = faces((await get('/css/fonts/libre-baskerville-700.css')).data);
  assert.ok(baskerville.length && baskerville.every((f) => f.family === 'Libre Baskerville 700' && f.url.endsWith(`-700-${f.style}.woff2`)));

  // Fonts with only a regular and a bold are outlined in the reader instead.
  for (const file of ['atkinson-hyperlegible-500', 'opendyslexic-700', 'literata-400', 'literata-450', 'literata-1000', 'georgia-500']) {
    assert.equal((await get(`/css/fonts/${file}.css`)).status, 404, file);
  }
});
