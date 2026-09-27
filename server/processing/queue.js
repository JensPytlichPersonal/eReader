// Single-worker conversion queue. Books are converted one at a time in-process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { convert, readMetadata } from '../converters/index.js';
import { writeBundle } from '../converters/bundle.js';
import { withTitleSeries } from '../converters/series.js';
import { now, transaction } from '../db.js';

// Bumped when the converters learn to read more from a book's metadata. Books seen by an older
// generation are topped up by backfillMetadata() without being converted again.
// 1: series and collections.
export const METADATA_VERSION = 1;

export function createProcessor(db, config, series, log = console) {
  const queue = [];
  let running = false;
  const stmts = {
    get: db.prepare('SELECT * FROM books WHERE id = ?'),
    setStatus: db.prepare('UPDATE books SET status = ?, error = ? WHERE id = ?'),
    finish: db.prepare(`UPDATE books SET status = 'ready', error = NULL, title = ?, author = ?, language = ?, format = ?,
      total_chars = ?, section_count = ?, page_count = ?, has_cover = ?, converted_at = ?, metadata_version = ? WHERE id = ?`),
    pending: db.prepare("SELECT id FROM books WHERE status = 'processing' ORDER BY added_at"),
    outdated: db.prepare("SELECT id FROM books WHERE status = 'ready' AND metadata_version < ? ORDER BY added_at"),
    setTitle: db.prepare('UPDATE books SET title = ? WHERE id = ?'),
    setMetadataVersion: db.prepare('UPDATE books SET metadata_version = ? WHERE id = ?'),
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
      const manifest = await writeBundle(dir, result);
      transaction(db, () => {
        const current = stmts.get.get(id);
        if (!current) return; // deleted while converting
        // Details someone edited by hand win over what the file says.
        const edited = current.edited_at > 0;
        stmts.finish.run(
          edited ? current.title : (manifest.title || book.title).slice(0, 500), edited ? current.author : (manifest.author || '').slice(0, 500),
          manifest.language || '', manifest.format, manifest.totalChars, manifest.sections.length, manifest.pageCount || 0, manifest.cover ? 1 : 0,
          manifest.convertedAt || now(), METADATA_VERSION, id,
        );
        if (!edited) series.setForBook(id, result.meta.series);
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
   * Reads the series of books converted before the converters knew about series, straight from
   * their original files (no reconversion). A series named in the title is taken from the title
   * the library shows, which may have been edited by hand.
   */
  async function backfillMetadata() {
    const rows = stmts.outdated.all(METADATA_VERSION);
    let found = 0;
    for (const { id } of rows) {
      const book = stmts.get.get(id);
      if (!book) continue;
      let meta = {};
      try {
        meta = await readMetadata(await readOriginal(id), { filename: book.original_name });
      } catch (err) {
        log.error?.(`[metadata] ${id}: ${err.message}`);
      }
      transaction(db, () => {
        const current = stmts.get.get(id);
        if (!current || current.status !== 'ready' || current.metadata_version >= METADATA_VERSION) return;
        if (!current.edited_at && !series.forBook(id).length) {
          const details = withTitleSeries({ title: current.title, series: meta.series });
          if (details.series.length) {
            if (details.title !== current.title) stmts.setTitle.run(details.title.slice(0, 500), id);
            series.setForBook(id, details.series);
            found++;
          }
        }
        stmts.setMetadataVersion.run(METADATA_VERSION, id);
      });
    }
    if (rows.length) log.info?.(`[metadata] checked ${rows.length} book(s) for series, found ${found}`);
    return { checked: rows.length, found };
  }

  return { enqueue, resumePending, backfillMetadata, isBusy: () => running || queue.length > 0, queueLength: () => queue.length, _now: now };
}
