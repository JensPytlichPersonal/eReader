import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, transaction } from '../db.js';
import { detectFormat, readMetadata, readOpfDetails, OPF_FILE, SUPPORTED_EXTENSIONS } from '../converters/index.js';
import { sniffImage, detailsFromFilename } from '../converters/bundle.js';
import { cleanSeriesName, knownSeriesName, parsePlace } from '../converters/series.js';
import { LookupError } from '../lookup.js';
import { fingerprint } from '../duplicates.js';

// A cover picked by hand. The app scales pictures down before sending them, so this only stops mistakes.
const COVER_TYPES = ['jpg', 'png', 'gif', 'webp'];
const MAX_COVER_BYTES = 10 * 1024 * 1024;
// The most books changed at once (the whole library, chosen in the app).
const MAX_BATCH = 10000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

/**
 * Checks the `series` of a book edit: [{ name, position }], position a number, a numeric string, a range
 * such as "1-3" for a book holding several (an omnibus), or empty.
 */
export function parseSeriesInput(input) {
  const invalid = { error: 'series must be a list of { name, position }' };
  if (!Array.isArray(input) || input.length > 50) return invalid;
  const series = [];
  for (const e of input) {
    if (!e || typeof e !== 'object' || typeof e.name !== 'string') return invalid;
    const name = cleanSeriesName(e.name);
    if (!name) continue;
    const empty = e.position == null || String(e.position).trim() === '';
    const place = empty ? { position: null } : parsePlace(e.position);
    if (!place) return { error: `The number in "${name}" must be a number, such as 3 or 2.5, or a range for a book holding several, such as 1-3` };
    series.push({ name, ...place });
  }
  return { series };
}

export function bookRoutes(db, auth, config, processor, { series, genres }, lookups, duplicates) {
  const r = Router();
  const stmts = {
    list: db.prepare(`SELECT b.*, u.username AS added_by_name,
        p.section AS p_section, p.offset AS p_offset, p.percent AS p_percent, p.updated_at AS p_updated_at, p.device AS p_device
      FROM books b LEFT JOIN users u ON u.id = b.added_by
      LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?
      ORDER BY COALESCE(p.updated_at, 0) DESC, b.added_at DESC`),
    get: db.prepare('SELECT b.*, u.username AS added_by_name FROM books b LEFT JOIN users u ON u.id = b.added_by WHERE b.id = ?'),
    insert: db.prepare(`INSERT INTO books (id, title, author, format, original_name, size, added_by, added_at, status, sha256, cover_source, cover_edited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // The book a file already is, the first one added when there are several (from before uploads were checked).
    withFile: db.prepare('SELECT b.*, u.username AS added_by_name FROM books b LEFT JOIN users u ON u.id = b.added_by WHERE b.sha256 = ? ORDER BY b.added_at LIMIT 1'),
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

  // `inSeries`: the series and collections the book is in, [{ id, name, position, positionEnd? }].
  const shapeBook = (b, inSeries = series.forBook(b.id)) => ({
    id: b.id, title: b.title, author: b.author, language: b.language, format: b.format, originalName: b.original_name, size: b.size,
    series: inSeries, genre: b.genre || '',
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
  // The book's ISBNs: those kept when it was converted, from its file and any OPF file that came with it,
  // else those in its file. EPUB and MOBI files carry them, and reading their details is quick.
  const readIsbns = async (b) => {
    if (b.isbns) return b.isbns.split(' ');
    const name = ['epub', 'mobi'].includes(b.format) && findOriginal(b.id);
    if (!name) return [];
    try { return (await readMetadata(await fsp.readFile(path.join(bookDir(b.id), name)), { filename: b.original_name })).isbns || []; } catch { return []; }
  };

  r.use(auth.requireUser);

  // The library. Only here does a book list its possible duplicates, [{ id, reason }] (see duplicates.js),
  // since finding them compares every book.
  r.get('/', (req, res) => {
    const bookSeries = series.byBook();
    const alike = duplicates.byBook();
    const books = stmts.list.all(req.user.id).map((b) => ({ ...shapeBook(b, bookSeries.get(b.id) || []), duplicates: alike.get(b.id) || [] }));
    res.json({ books, processing: processor.isBusy(), supported: SUPPORTED_EXTENSIONS });
  });

  // Upload: raw body, filename in X-File-Name (URL encoded). A file that is already in the library, under
  // any name, is not added again: the answer is 409, with the book it is.
  // Files that came with the book go ahead of it in the body, their sizes in X-Opf-Size and X-Cover-Size:
  // its details in an OPF file, as calibre keeps one beside each book, and its cover. Their details win
  // over the book's own (see withOpfDetails), and the cover becomes the book's like one picked by hand.
  // `used` in the answer says which of them were taken.
  r.post('/', express.raw({ type: () => true, limit: config.maxUploadBytes }), async (req, res) => {
    let filename = '';
    try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = req.get('x-file-name') || ''; }
    filename = path.basename(filename).replace(/[\r\n\t]/g, ' ').trim().slice(0, 255);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file data received' });
    if (!filename) return res.status(400).json({ error: 'Missing X-File-Name header' });
    const [opfSize, coverSize] = ['x-opf-size', 'x-cover-size'].map((h) => (req.get(h) == null ? 0 : Number(req.get(h))));
    if (![opfSize, coverSize].every((n) => Number.isInteger(n) && n >= 0) || opfSize + coverSize > req.body.length) {
      return res.status(400).json({ error: 'X-Opf-Size and X-Cover-Size must be the sizes of the files ahead of the book' });
    }
    const opf = req.body.subarray(0, opfSize);
    const cover = req.body.subarray(opfSize, opfSize + coverSize);
    const body = req.body.subarray(opfSize + coverSize);
    if (!body.length) return res.status(400).json({ error: 'No file data received' });
    const format = detectFormat(filename, body);
    if (!format) return res.status(415).json({ error: `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}` });
    const sha256 = fingerprint(body);
    const alreadyIn = (b) => res.status(409).json({ error: `Already in the library as "${b.title}"`, book: shapeBook(b) });
    let same = stmts.withFile.get(sha256);
    if (same) return alreadyIn(same);
    const id = crypto.randomBytes(8).toString('hex');
    const ext = (path.extname(filename).slice(1).toLowerCase() || format).replace(/[^a-z0-9]/g, '') || 'bin';
    const dir = bookDir(id);
    const details = opf.length ? readOpfDetails(opf) : null;
    const coverType = cover.length && cover.length <= MAX_COVER_BYTES ? sniffImage(cover) : null;
    const useCover = COVER_TYPES.includes(coverType);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `original.${ext}`), body);
    // Kept beside the original, as the processor reads it whenever the book is converted.
    if (details) await fsp.writeFile(path.join(dir, OPF_FILE), opf);
    if (useCover) await fsp.writeFile(path.join(dir, `custom-cover.${coverType}`), cover);
    // Asked again: the same file may have been sent twice at once, and the other copy saved meanwhile.
    // From here to the insert nothing waits, so only one of them gets in.
    same = stmts.withFile.get(sha256);
    if (same) {
      await fsp.rm(dir, { recursive: true, force: true });
      return alreadyIn(same);
    }
    const added = now();
    stmts.insert.run(id, (details?.title || detailsFromFilename(filename).title).slice(0, 500), (details?.author || '').slice(0, 500), format, filename, body.length,
      req.user.id, added, 'processing', sha256, useCover ? 'custom' : 'file', useCover ? added : 0);
    processor.enqueue(id);
    res.status(202).json({ book: shapeBook({ ...stmts.get.get(id) }, []), used: { opf: !!details, cover: useCover } });
  });

  r.get('/:id', async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    const manifest = b.status === 'ready' ? await readManifest(b.id) : null;
    res.json({ book: shapeBook(b), manifest, progress: shapeProgress(stmts.progress.get(req.user.id, b.id)), bookmarks: stmts.bookmarks.all(req.user.id, b.id) });
  });

  // Changes several books at once, such as the books chosen in the library or a whole series:
  // { ids, genre }, genre '' for none. Only the uploader of each of them or an admin can, else nothing
  // changes. Books no longer in the library are passed over; `updated` says how many were changed.
  r.patch('/', (req, res) => {
    const { ids, genre } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH || !ids.every((id) => typeof id === 'string')) {
      return res.status(400).json({ error: 'ids must be a list of book ids' });
    }
    if (typeof genre !== 'string') return res.status(400).json({ error: 'genre must be text' });
    const found = [...new Set(ids)].map((id) => stmts.get.get(id)).filter(Boolean);
    const others = req.user.isAdmin ? 0 : found.filter((b) => b.added_by !== req.user.id).length;
    if (others) {
      const which = others === 1 ? 'one of these books was' : `${others} of these books were`;
      return res.status(403).json({ error: `Only the uploader or an admin can change the genre of a book, and ${which} added by someone else` });
    }
    res.json({ genre: genres.set(found.map((b) => b.id), genre), updated: found.length });
  });

  // Edit the details: title, author, genre and the series and collections the book is in. Edited
  // details are kept when the book is converted again.
  r.patch('/:id', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can edit this book' });
    const { title, author, series: seriesInput, genre } = req.body || {};
    if (genre !== undefined && typeof genre !== 'string') return res.status(400).json({ error: 'genre must be text' });
    let parsed = null;
    if (seriesInput !== undefined) {
      parsed = parseSeriesInput(seriesInput);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
    }
    transaction(db, () => {
      if (title !== undefined || author !== undefined || parsed) {
        stmts.updateMeta.run((title ?? b.title).toString().trim().slice(0, 500) || b.title, (author ?? b.author).toString().trim().slice(0, 500), now(), b.id);
        if (parsed) series.setForBook(b.id, parsed.series);
      }
      // No file has a genre, so converting again keeps it without counting it as edited.
      if (genre !== undefined) genres.set([b.id], genre);
    });
    res.json({ book: shapeBook(stmts.get.get(b.id)) });
  });

  // Finds the book on Hardcover (when set up) and Open Library by the ISBN in its file and by the
  // title and author typed in the edit form. Nothing changes here: picking a match fills in the form,
  // which is then saved. `notes` says which catalogue could not be asked, and why.
  r.get('/:id/lookup', async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can edit this book' });
    const field = (v) => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
    const title = field(req.query.title);
    const isbns = await readIsbns(b);
    if (!title && !isbns.length) return res.status(400).json({ error: 'Type a title to look up' });
    let found;
    try {
      found = await lookups.lookup({ title, author: field(req.query.author), isbns, language: b.language });
    } catch (err) {
      if (err instanceof LookupError) return res.status(502).json({ error: err.message });
      throw err;
    }
    // A series the library already has keeps its name there, so the book joins it.
    const known = series.names();
    const results = found.results.map((m) => ({ ...m, series: m.series.map((s) => ({ ...s, name: knownSeriesName(s.name, known) })) }));
    res.json({ results, notes: found.problems, sources: lookups.sources });
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

  // Says that two books which look alike are different books, so neither is flagged as a possible
  // duplicate of the other any more. Body: { of: the other book's id }. The uploader of either book or
  // an admin can.
  r.post('/:id/not-duplicate', (req, res) => {
    const otherId = req.body?.of;
    if (typeof otherId !== 'string') return res.status(400).json({ error: 'of must be the id of the other book' });
    const b = stmts.get.get(req.params.id);
    const other = stmts.get.get(otherId);
    if (!b || !other) return res.status(404).json({ error: 'No such book' });
    if (b.id === other.id) return res.status(400).json({ error: 'That is the same book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id && other.added_by !== req.user.id) {
      return res.status(403).json({ error: 'Only the uploader of one of the books or an admin can do this' });
    }
    duplicates.markDifferent(b.id, other.id);
    res.json({ ok: true });
  });

  r.post('/:id/reprocess', (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can reprocess this book' });
    processor.enqueue(b.id);
    res.status(202).json({ book: shapeBook(stmts.get.get(b.id)) });
  });

  // Keeps an image as the cover picked for the book. Checked by content, not by name: an SVG could
  // carry scripts. False when it is not a JPEG, PNG, GIF or WebP image.
  const useCoverImage = async (b, image) => {
    const ext = sniffImage(image);
    if (!COVER_TYPES.includes(ext)) return false;
    const name = `custom-cover.${ext}`;
    await removeCustomCovers(b.id, name);
    await fsp.writeFile(path.join(bookDir(b.id), name), image);
    stmts.setCover.run('custom', now(), b.id);
    return true;
  };

  // The cover the library shows. Send an image (JPEG, PNG, GIF or WebP) to use it, or JSON
  // { source: 'file' } for the cover in the book's own file, { source: 'none' } for no cover, or the
  // coverSource and coverId of a match from the lookup ({ source: 'openlibrary', coverId }), which
  // the server fetches from that catalogue.
  // The image is kept apart from the book's own cover, so converting the book again keeps it.
  r.put('/:id/cover', express.raw({ type: (req) => !req.is('json'), limit: MAX_COVER_BYTES }), async (req, res) => {
    const b = stmts.get.get(req.params.id);
    if (!b) return res.status(404).json({ error: 'No such book' });
    if (!req.user.isAdmin && b.added_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or an admin can change the cover' });
    const source = req.body?.source;
    if (Buffer.isBuffer(req.body)) {
      if (!req.body.length) return res.status(400).json({ error: 'No image received' });
      if (!(await useCoverImage(b, req.body))) return res.status(415).json({ error: 'The cover must be a JPEG, PNG, GIF or WebP image' });
    } else if (source === 'openlibrary' || source === 'hardcover') {
      if (!lookups.sources.includes(source)) return res.status(400).json({ error: 'Hardcover is not set up on this server. An admin can add a token for it under Settings.' });
      const { coverId } = req.body;
      if (!Number.isInteger(coverId) || coverId <= 0) return res.status(400).json({ error: 'coverId must be the number the catalogue gave with the match' });
      let image;
      try {
        image = await lookups.cover(source, coverId);
      } catch (err) {
        if (err instanceof LookupError) return res.status(502).json({ error: err.message });
        throw err;
      }
      if (!stmts.get.get(b.id)) return res.status(404).json({ error: 'No such book' }); // deleted meanwhile
      if (image.length > MAX_COVER_BYTES || !(await useCoverImage(b, image))) return res.status(502).json({ error: 'The catalogue sent something that is not a cover picture' });
    } else {
      if (source !== 'file' && source !== 'none') return res.status(400).json({ error: "Send an image, or a source of 'file', 'none', 'openlibrary' or 'hardcover'" });
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
// access are blocked and it gets an opaque origin. It is not set on /original, which the built-in PDF
// viewer opens with its own scripts; an original is safe without it because of ORIGINAL_FORMATS.
const FILE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
// An original is sent as the format it was read as, which comes from its first bytes, never by its
// file name, which the uploader chose: a PDF uploaded as "x.html" must not come back as a web page.
// None of these types is run by a browser.
const ORIGINAL_FORMATS = ['epub', 'mobi', 'pdf', 'md', 'txt'];

/** Serves converted book files: /books/:id/book.json, sections/N.html, images/*, cover, styles.css, original */
export function bookFiles(db, auth, config) {
  const r = Router();
  const coverSource = db.prepare('SELECT cover_source FROM books WHERE id = ?');
  const bookFormat = db.prepare('SELECT format FROM books WHERE id = ?');
  r.use(auth.requireUser);
  r.get('/:id/original', (req, res) => {
    const dir = path.join(config.booksDir, req.params.id);
    if (!/^[a-f0-9]{16}$/.test(req.params.id)) return res.status(404).end();
    let name;
    try { name = fs.readdirSync(dir).find((f) => f.startsWith('original.')); } catch { return res.status(404).end(); }
    if (!name) return res.status(404).end();
    const format = bookFormat.get(req.params.id)?.format;
    res.setHeader('Content-Type', ORIGINAL_FORMATS.includes(format) ? MIME[`.${format}`] : 'application/octet-stream');
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
