import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { now } from '../db.js';
import { detectFormat, SUPPORTED_EXTENSIONS } from '../converters/index.js';
import { titleFromFilename } from '../converters/bundle.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

export function bookRoutes(db, auth, config, processor) {
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
    updateMeta: db.prepare('UPDATE books SET title = ?, author = ? WHERE id = ?'),
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

  const shapeBook = (b) => ({
    id: b.id, title: b.title, author: b.author, language: b.language, format: b.format, originalName: b.original_name, size: b.size,
    addedBy: b.added_by_name || null, addedById: b.added_by, addedAt: b.added_at, status: b.status, error: b.error,
    totalChars: b.total_chars, sectionCount: b.section_count, pageCount: b.page_count, hasCover: !!b.has_cover,
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

  r.use(auth.requireUser);

  r.get('/', (req, res) => {
    res.json({ books: stmts.list.all(req.user.id).map(shapeBook), processing: processor.isBusy(), supported: SUPPORTED_EXTENSIONS });
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
    res.status(202).json({ book: shapeBook({ ...stmts.get.get(id) }) });
  });

  r.get('/:id', async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    const manifest = b.status === 'ready' ? await readManifest(b.id) : null;
    res.json({ book: shapeBook(b), manifest, progress: shapeProgress(stmts.progress.get(req.user.id, b.id)), bookmarks: stmts.bookmarks.all(req.user.id, b.id) });
  });

  r.patch('/:id', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can edit this book' });
    const { title, author } = req.body || {};
    stmts.updateMeta.run((title ?? b.title).toString().trim().slice(0, 500) || b.title, (author ?? b.author).toString().trim().slice(0, 500), b.id);
    res.json({ book: shapeBook(stmts.get.get(b.id)) });
  });

  r.delete('/:id', async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can delete this book' });
    stmts.delete.run(b.id);
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

/** Serves converted book files: /books/:id/book.json, sections/N.html, images/*, cover.*, styles.css, original */
export function bookFiles(auth, config) {
  const r = Router();
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
  r.get('/:id/cover', (req, res) => {
    if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).end();
    const dir = path.join(config.booksDir, req.params.id);
    let name;
    try { name = fs.readdirSync(dir).find((f) => f.startsWith('cover.')); } catch { return res.status(404).end(); }
    if (!name) return res.status(404).end();
    res.setHeader('Content-Type', MIME[path.extname(name).toLowerCase()] || 'image/jpeg');
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
    res.setHeader('Cache-Control', ext === '.json' ? 'no-cache' : 'private, max-age=86400');
    res.sendFile(target, (err) => { if (err && !res.headersSent) res.status(err.statusCode || 404).end(); });
  });
  return r;
}
