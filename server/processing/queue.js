// Single-worker conversion queue. Books are converted one at a time in-process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { convert, readMetadata, readOpfDetails, withOpfDetails, OPF_FILE } from '../converters/index.js';
import { writeBundle } from '../converters/bundle.js';
import { withTitleSeries } from '../converters/series.js';
import { now, transaction } from '../db.js';

// Bumped when the converters learn to read more from a book's metadata. Books seen by an older
// generation are topped up by backfillMetadata() without being converted again.
// 1: series and collections. 2: ISBNs, which tell the same book in another file (see duplicates.js).
export const METADATA_VERSION = 2;

// The formats whose files carry ISBNs.
const ISBN_FORMATS = ['epub', 'mobi'];

export function createProcessor(db, config, { series, genres }, log = console) {
  const queue = [];
  let running = false;
  const stmts = {
    get: db.prepare('SELECT * FROM books WHERE id = ?'),
    setStatus: db.prepare('UPDATE books SET status = ?, error = ? WHERE id = ?'),
    finish: db.prepare(`UPDATE books SET status = 'ready', error = NULL, title = ?, author = ?, language = ?, format = ?,
      total_chars = ?, section_count = ?, page_count = ?, has_cover = ?, converted_at = ?, metadata_version = ?, isbns = ? WHERE id = ?`),
    pending: db.prepare("SELECT id FROM books WHERE status = 'processing' ORDER BY added_at"),
    outdated: db.prepare("SELECT id FROM books WHERE status = 'ready' AND metadata_version < ? ORDER BY added_at"),
    setTitle: db.prepare('UPDATE books SET title = ? WHERE id = ?'),
    setMetadataVersion: db.prepare('UPDATE books SET metadata_version = ? WHERE id = ?'),
    setIsbns: db.prepare('UPDATE books SET isbns = ? WHERE id = ?'),
  };

  // The details of an OPF file that came with the book, which win over its file's own, or null.
  const readOpf = async (id) => {
    try { return readOpfDetails(await fs.readFile(path.join(config.booksDir, id, OPF_FILE))); } catch { return null; }
  };

  const readOriginal = async (id) => {
    const dir = path.join(config.booksDir, id);
    const name = (await fs.readdir(dir)).find((f) => f.startsWith('original.'));
    if (!name) throw new Error('Original file is missing');
    return fs.readFile(path.join(dir, name));
  };

  async function processBook(id) {
    const book = stmts.get.get(id);
    if (!book) return;
    const dir = path.join(config.booksDir, id);
    try {
      const result = await convert(await readOriginal(id), { filename: book.original_name });
      if (!result.sections.length) throw new Error('No readable content found');
      const opf = await readOpf(id);
      if (opf) result.meta = withOpfDetails(result.meta, opf);
      const manifest = await writeBundle(dir, result);
      transaction(db, () => {
        const current = stmts.get.get(id);
        if (!current) return; // deleted while converting
        // Details someone edited by hand win over what the file says.
        const edited = current.edited_at > 0;
        stmts.finish.run(
          edited ? current.title : (manifest.title || book.title).slice(0, 500), edited ? current.author : (manifest.author || '').slice(0, 500),
          manifest.language || '', manifest.format, manifest.totalChars, manifest.sections.length, manifest.pageCount || 0, manifest.cover ? 1 : 0,
          manifest.convertedAt || now(), METADATA_VERSION, (result.meta.isbns || []).join(' '), id,
        );
        if (!edited) series.setForBook(id, result.meta.series);
        // A book new to the library takes the genre of the other books in its series. Converting again
        // leaves the genre as it is, so a book someone took out of the series' genre stays out.
        if (!current.converted_at && !current.genre) {
          const genre = genres.ofSeries(id);
          if (genre) genres.set([id], genre);
        }
      });
      log.info?.(`[convert] ${id} ok: "${manifest.title}" (${manifest.format}, ${manifest.sections.length} sections)`);
    } catch (err) {
      log.error?.(`[convert] ${id} failed: ${err.message}`);
      stmts.setStatus.run('error', String(err.message || err).slice(0, 1000), id);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        await processBook(id);
      }
    } finally {
      running = false;
    }
  }

  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    stmts.setStatus.run('processing', null, id);
    const p = run();
    return p;
  }

  function resumePending() {
    for (const row of stmts.pending.all()) enqueue(row.id);
  }

  /**
   * Tops up the books converted by an older generation (see METADATA_VERSION) straight from their
   * original files, without converting them again: the series of books converted before the
   * converters knew about series, and the ISBNs of those converted before they were kept. A series
   * named in the title is taken from the title the library shows, which may have been edited by hand.
   */
  async function backfillMetadata() {
    const rows = stmts.outdated.all(METADATA_VERSION);
    let found = 0;
    for (const { id } of rows) {
      const book = stmts.get.get(id);
      if (!book) continue;
      let meta = {};
      // A book that has its series needs only its ISBNs, and only some formats carry any.
      if (book.metadata_version < 1 || ISBN_FORMATS.includes(book.format)) {
        try {
          meta = await readMetadata(await readOriginal(id), { filename: book.original_name });
        } catch (err) {
          log.error?.(`[metadata] ${id}: ${err.message}`);
        }
      }
      const opf = await readOpf(id);
      if (opf) meta = withOpfDetails({ title: '', author: '', language: '', series: [], ...meta }, opf);
      transaction(db, () => {
        const current = stmts.get.get(id);
        if (!current || current.status !== 'ready' || current.metadata_version >= METADATA_VERSION) return;
        if (current.metadata_version < 1 && !current.edited_at && !series.forBook(id).length) {
          const details = withTitleSeries({ title: current.title, series: meta.series });
          if (details.series.length) {
            if (details.title !== current.title) stmts.setTitle.run(details.title.slice(0, 500), id);
            series.setForBook(id, details.series);
            found++;
          }
        }
        stmts.setIsbns.run((meta.isbns || []).join(' '), id);
        stmts.setMetadataVersion.run(METADATA_VERSION, id);
      });
    }
    if (rows.length) log.info?.(`[metadata] checked ${rows.length} book(s) for series and ISBNs, found ${found} in a series`);
    return { checked: rows.length, found };
  }

  return { enqueue, resumePending, backfillMetadata, isBusy: () => running || queue.length > 0, queueLength: () => queue.length, _now: now };
}
