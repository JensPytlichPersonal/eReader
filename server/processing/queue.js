// Single-worker conversion queue. Books are converted one at a time in-process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { convert } from '../converters/index.js';
import { writeBundle } from '../converters/bundle.js';
import { now } from '../db.js';

export function createProcessor(db, config, log = console) {
  const queue = [];
  let running = false;
  const stmts = {
    get: db.prepare('SELECT * FROM books WHERE id = ?'),
    setStatus: db.prepare('UPDATE books SET status = ?, error = ? WHERE id = ?'),
    finish: db.prepare(`UPDATE books SET status = 'ready', error = NULL, title = ?, author = ?, language = ?, format = ?,
      total_chars = ?, section_count = ?, page_count = ?, has_cover = ? WHERE id = ?`),
    pending: db.prepare("SELECT id FROM books WHERE status = 'processing' ORDER BY added_at"),
  };

  async function processBook(id) {
    const book = stmts.get.get(id);
    if (!book) return;
    const dir = path.join(config.booksDir, id);
    try {
      const originalName = (await fs.readdir(dir)).find((f) => f.startsWith('original.'));
      if (!originalName) throw new Error('Original file is missing');
      const buffer = await fs.readFile(path.join(dir, originalName));
      const result = await convert(buffer, { filename: book.original_name });
      if (!result.sections.length) throw new Error('No readable content found');
      const manifest = await writeBundle(dir, result);
      stmts.finish.run(
        (manifest.title || book.title).slice(0, 500), (manifest.author || '').slice(0, 500), manifest.language || '', manifest.format,
        manifest.totalChars, manifest.sections.length, manifest.pageCount || 0, manifest.cover ? 1 : 0, id,
      );
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

  return { enqueue, resumePending, isBusy: () => running || queue.length > 0, queueLength: () => queue.length, _now: now };
}
