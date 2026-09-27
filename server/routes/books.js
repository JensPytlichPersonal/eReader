import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, transaction } from '../db.js';
import { detectFormat, SUPPORTED_EXTENSIONS } from '../converters/index.js';
import { sniffImage, titleFromFilename } from '../converters/bundle.js';
import { cleanSeriesName, parsePosition } from '../converters/series.js';

// A cover picked by hand. The app scales pictures down before sending them, so this only stops mistakes.
const COVER_TYPES = ['jpg', 'png', 'gif', 'webp'];
const MAX_COVER_BYTES = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

/** Checks the `series` of a book edit: [{ name, position }], position a number, a numeric string or empty. */
export function parseSeriesInput(input) {
  const invalid = { error: 'series must be a list of { name, position }' };
  if (!Array.isArray(input) || input.length > 50) return invalid;
  const series = [];
  for (const e of input) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string') return invalid;
    const name = cleanSeriesName(e.name);
    if (!name) continue;
    const empty = e.position == null || String(e.position).trim() === '';
    const position = empty ? null : parsePosition(e.position);
    if (!empty && position == null) return { error: `The number in "${name}" must be a number, such as 3 or 2.5` };
    series.push({ name, position });
  }
  return { series };
}

export function bookRoutes(db, auth, config, processor, series) {
  const r = Router();
  const stmts = {
    list: db.prepare(`SELECT b.*, u.username AS added_by_name,
        p.section AS p_section, p.offset AS p_offset, p.percent AS p_percent, p.updated_at AS p_updated_at, p.device AS p_device
      FROM books b LEFT JOIN users u ON u.id = b.added_by
      LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?
      ORDER BY COALESCE(p.updated_at, 0) DESC, b.added_at DESC`),
    get: db.prepare('SELECT b.*, u.username AS added_by_name FROM books b LEFT JOIN users u ON u.id = b.added_by WHERE b.id = ?'),
    insert: db.prepare('INSERT INTO books (id, title, author, format, original_name, size, added_by, added_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    delete: db.prepare('DELETE FROM books WHERE id = ?'),
    updateMeta: db.prepare('UPDATE books SET title = ?, author = ?, edited_at = ? WHERE id = ?'),
    // Always later than the cover's current version, even for two changes within a millisecond.
    setCover: db.prepare('UPDATE books SET cover_source = ?, cover_edited_at = MAX(?, converted_at + 1, cover_edited_at + 1) WHERE id = ?'),
    progress: db.prepare('SELECT * FROM progress WHERE user_id = ? AND book_id = ?'),
    upsertProgress: db.prepare(`INSERT INTO progress (user_id, book_id, section, offset, percent, finished, device, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET section = excluded.section, offset = excluded.offset, percent = excluded.percent,
        finished = excluded.finished, device = excluded.device, updated_at = excluded.updated_at`),
    deleteProgress: db.prepare('DELETE FROM progress WHERE user_id = ? AND book_id = ?'),
    allProgress: db.prepare(`SELECT p.*, u.username, u.display_name FROM progress p JOIN users u ON u.id = p.user_id WHERE p.book_id = ? ORDER BY p.updated_at DESC`),
    bookmarks: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND book_id = ? ORDER BY percent, created_at'),
    insertBookmark: db.prepare('INSERT INTO bookmarks (user_id, book_id, section, offset, percent, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    deleteBookmark: db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?'),
  };

  // `inSeries`: the series and collections the book is in, [{ id, name, position }].
  const shapeBook = (b, inSeries = series.forBook(b.id)) => ({
    id: b.id, title: b.title, author: b.author, language: b.language, format: b.format, originalName: b.original_name, size: b.size,
    series: inSeries,
    addedBy: b.added_by_name || null, addedById: b.added_by, addedAt: b.added_at, status: b.status, error: b.error,
    totalChars: b.total_chars, sectionCount: b.section_count, pageCount: b.page_count, convertedAt: b.converted_at || 0,
    // `hasCover`: the library shows a cover image; `coverVersion` changes whenever that image may have.
    hasCover: b.cover_source === 'custom' || (b.cover_source === 'file' && !!b.has_cover), coverSource: b.cover_source, fileHasCover: !!b.has_cover,
    coverVersion: Math.max(b.converted_at || 0, b.cover_edited_at || 0) || b.added_at,
    progress: b.p_updated_at != null ? { section: b.p_section, offset: b.p_offset, percent: b.p_percent, updatedAt: b.p_updated_at, device: b.p_device } : null,
  });
  const shapeProgress = (p) => (p ? { section: p.section, offset: p.offset, percent: p.percent, finished: !!p.finished, device: p.device, updatedAt: p.updated_at } : null);

  const bookDir = (id) => path.join(config.booksDir, id);
  const findOriginal = (id) => {
    try { return fs.readdirSync(bookDir(id)).find((f) => f.startsWith('original.')) || null; } catch { return null; }
  };
  const readManifest = async (id) => {
    try { return JSON.parse(await fsp.readFile(path.join(bookDir(id), 'book.json'), 'utf8')); } catch { return null; }
  };
  const removeCustomCovers = async (id, keep) => {
    let files = [];
    try { files = await fsp.readdir(bookDir(id)); } catch { /* no folder */ }
    for (const f of files) if (f.startsWith('custom-cover.') && f !== keep) await fsp.rm(path.join(bookDir(id), f), { force: true });
  };

  r.use(auth.requireUser);

  r.get('/', (req, res) => {
    const bookSeries = series.byBook();
    const books = stmts.list.all(req.user.id).map((b) => shapeBook(b, bookSeries.get(b.id) || []));
    res.json({ books, processing: processor.isBusy(), supported: SUPPORTED_EXTENSIONS });
  });

  // Upload: raw body, filename in X-File-Name (URL encoded)
  r.post('/', express.raw({ type: () => true, limit: config.maxUploadBytes }), async (req, res) => {
    let filename = '';
    try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = req.get('x-file-name') || ''; }
    filename = path.basename(filename).replace(/[\r\n\t]/g, ' ').trim().slice(0, 255);
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'No file data received' });
    if (!filename) return res.status(400).json({ error: 'Missing X-File-Name header' });
    const format = detectFormat(filename, body);
    if (!format) return res.status(415).json({ error: `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}` });
    const id = crypto.randomBytes(8).toString('hex');
    const ext = (path.extname(filename).slice(1).toLowerCase() || format).replace(/[^a-z0-9]/g, '') || 'bin';
    const dir = bookDir(id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `original.${ext}`), body);
    stmts.insert.run(id, titleFromFilename(filename), '', format, filename, body.length, req.user.id, now(), 'processing');
    processor.enqueue(id);
    res.status(202).json({ book: shapeBook({ ...stmts.get.get(id) }, []) });
  });

  r.get('/:id', async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    const manifest = b.status === 'ready' ? await readManifest(b.id) : null;
    res.json({ book: shapeBook(b), manifest, progress: shapeProgress(stmts.progress.get(req.user.id, b.id)), bookmarks: stmts.bookmarks.all(req.user.id, b.id) });
  });

  // Edit the details: title, author and the series and collections the book is in. Edited
  // details are kept when the book is converted again.
  r.patch('/:id', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can edit this book' });
    const { title, author, series: seriesInput } = req.body || {};
    let parsed = null;
    if (seriesInput !== undefined) {
      parsed = parseSeriesInput(seriesInput);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
    }
    if (title !== undefined || author !== undefined || parsed) {
      transaction(db, () => {
        stmts.updateMeta.run((title ?? b.title).toString().trim().slice(0, 500) || b.title, (author ?? b.author).toString().trim().slice(0, 500), now(), b.id);
        if (parsed) series.setForBook(b.id, parsed.series);
      });
    }
    res.json({ book: shapeBook(stmts.get.get(b.id)) });
  });

  r.delete('/:id', async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can delete this book' });
    stmts.delete.run(b.id);
    series.prune();
    await fsp.rm(bookDir(b.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  r.post('/:id/reprocess', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can reprocess this book' });
    processor.enqueue(b.id);
    res.status(202).json({ book: shapeBook(stmts.get.get(b.id)) });
  });

  // The cover the library shows. Send an image (JPEG, PNG, GIF or WebP) to use it, or JSON
  // { source: 'file' } for the cover in the book's own file or { source: 'none' } for no cover.
  // The image is kept apart from the book's own cover, so converting the book again keeps it.
  r.put('/:id/cover', express.raw({ type: (req) => !req.is('json'), limit: MAX_COVER_BYTES }), async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can change the cover' });
    if (Buffer.isBuffer(req.body)) {
      if (!req.body.length) return res.status(400).json({ error: 'No image received' });
      // Checked by content, not by name: an SVG could carry scripts.
      const ext = sniffImage(req.body);
      if (!COVER_TYPES.includes(ext)) return res.status(415).json({ error: 'The cover must be a JPEG, PNG, GIF or WebP image' });
      const name = `custom-cover.${ext}`;
      await removeCustomCovers(b.id, name);
      await fsp.writeFile(path.join(bookDir(b.id), name), req.body);
      stmts.setCover.run('custom', now(), b.id);
    } else {
      const source = req.body?.source;
      if (source !== 'file' && source !== 'none') return res.status(400).json({ error: "Send an image, or a source of 'file' or 'none'" });
      stmts.setCover.run(source, now(), b.id);
      await removeCustomCovers(b.id);
    }
    const updated = stmts.get.get(b.id);
    if (!updated) return res.status(404).json({ error: 'No such book' }); // deleted meanwhile
    res.json({ book: shapeBook(updated) });
  });

  // ---- progress ----
  r.get('/:id/progress', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    res.json({ progress: shapeProgress(stmts.progress.get(req.user.id, b.id)) });
  });

  r.put('/:id/progress', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    const { section, offset, percent, device, finished, knownUpdatedAt } = req.body || {};
    const sec = Number.isInteger(section) && section >= 0 ? section : 0;
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const pct = Number.isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0;
    const current = stmts.progress.get(req.user.id, b.id);
    // Another device wrote a newer position than the one this client started from: tell it to catch up.
    if (current && Number.isFinite(knownUpdatedAt) && current.updated_at > knownUpdatedAt && !req.body.force) {
      return res.status(409).json({ error: 'Newer progress exists', progress: shapeProgress(current) });
    }
    const t = now();
    stmts.upsertProgress.run(req.user.id, b.id, sec, off, pct, finished ? 1 : 0, String(device || req.device || '').slice(0, 120), t);
    res.json({ progress: shapeProgress(stmts.progress.get(req.user.id, b.id)) });
  });

  r.delete('/:id/progress', (req, res) => {
    stmts.deleteProgress.run(req.user.id, req.params.id);
    res.json({ ok: true });
  });

  r.get('/:id/readers', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    res.json({ readers: stmts.allProgress.all(b.id).map((p) => ({ username: p.username, displayName: p.display_name, percent: p.percent, updatedAt: p.updated_at })) });
  });

  // ---- bookmarks ----
  r.get('/:id/bookmarks', (req, res) => res.json({ bookmarks: stmts.bookmarks.all(req.user.id, req.params.id) }));
  r.post('/:id/bookmarks', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    const { section, offset, percent, label } = req.body || {};
    const info = stmts.insertBookmark.run(req.user.id, b.id, Number.isInteger(section) ? section : 0, Number.isInteger(offset) ? offset : 0,
      Number.isFinite(percent) ? percent : 0, String(label || '').slice(0, 200), now());
    res.status(201).json({ bookmark: stmts.bookmarks.all(req.user.id, b.id).find((x) => x.id === Number(info.lastInsertRowid)) });
  });
  r.delete('/:id/bookmarks/:bid', (req, res) => {
    stmts.deleteBookmark.run(parseInt(req.params.bid, 10), req.user.id);
    res.json({ ok: true });
  });

  return r;
}

// A book's own files are served from the app's own origin, and a book can carry an SVG (an EPUB
// cover, or a figure inside a chapter). Shown in an <img> its scripts never run, but opened as a URL
// it would be a document on this origin with the viewer's session cookie, free to call the API as
// them. This policy sandboxes every book file: an SVG still draws, but its scripts, forms and network
// access are blocked and it gets an opaque origin. It is not set on /original, whose formats are not
// served as documents the browser runs (epub, mobi, pdf, text) and where the built-in PDF viewer
// needs its own scripts.
const FILE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/** Serves converted book files: /books/:id/book.json, sections/N.html, images/*, cover, styles.css, original */
export function bookFiles(db, auth, config) {
  const r = Router();
  const coverSource = db.prepare('SELECT cover_source FROM books WHERE id = ?');
  r.use(auth.requireUser);
  r.get('/:id/original', (req, res) => {
    const dir = path.join(config.booksDir, req.params.id);
    if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).end();
    let name;
    try { name = fs.readdirSync(dir).find((f) => f.startsWith('original.')); } catch { return res.status(404).end(); }
    if (!name) return res.status(404).end();
    res.setHeader('Content-Type', MIME[path.extname(name).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(dir, name));
  });
  // The cover the library shows: one picked by hand, or the one in the book's file.
  r.get('/:id/cover', (req, res) => {
    if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).end();
    const source = coverSource.get(req.params.id)?.cover_source;
    if (source !== 'custom' && source !== 'file') return res.status(404).end();
    const prefix = source === 'custom' ? 'custom-cover.' : 'cover.';
    const dir = path.join(config.booksDir, req.params.id);
    let name;
    try { name = fs.readdirSync(dir).find((f) => f.startsWith(prefix)); } catch { return res.status(404).end(); }
    if (!name) return res.status(404).end();
    res.setHeader('Content-Type', MIME[path.extname(name).toLowerCase()] || 'image/jpeg');
    res.setHeader('Content-Security-Policy', FILE_CSP);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(dir, name));
  });
  r.get('/:id/*rest', (req, res) => {
    if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).end();
    const rel = Array.isArray(req.params.rest) ? req.params.rest.join('/') : String(req.params.rest || '');
    const dir = path.join(config.booksDir, req.params.id);
    const target = path.normalize(path.join(dir, rel));
    if (!target.startsWith(dir + path.sep) || /original\./.test(path.basename(target))) return res.status(404).end();
    const ext = path.extname(target).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', FILE_CSP);
    res.setHeader('Cache-Control', ext === '.json' ? 'no-cache' : 'private, max-age=86400');
    res.sendFile(target, (err) => { if (err && !res.headersSent) res.status(err.statusCode || 404).end(); });
  });
  return r;
}
