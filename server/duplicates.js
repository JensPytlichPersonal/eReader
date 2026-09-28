// Finding the same book twice. A file that is already in the library is turned away when it is uploaded
// again, by its fingerprint (see the upload in routes/books.js). The same book in another file, such as
// an EPUB and a PDF of it, cannot be told for certain, so it is only flagged: books that share an ISBN,
// or have the same title and author, are listed as possible duplicates of each other until one of them
// is deleted or someone says they are different books.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** A file's fingerprint: its SHA-256, in hex. */
export const fingerprint = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** The fingerprint of a file on disk, read a piece at a time so a large one does not hold up the server. */
async function fingerprintFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Titles and authors are compared loosely: case, accents and punctuation aside, and an author's names
// in any order, so "Herbert, Frank" is "Frank Herbert".
const words = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
export const titleKey = (title) => words(title).join(' ');
export const authorKey = (author) => words(author).sort().join(' ');

export function createDuplicates(db, config, log = console) {
  const stmts = {
    // A book still being prepared has a title made from its file name, so it is compared once it is ready.
    books: db.prepare("SELECT id, title, author, sha256, isbns FROM books WHERE status != 'processing'"),
    distinct: db.prepare('SELECT book_id, other_id FROM distinct_books'),
    markDifferent: db.prepare('INSERT OR IGNORE INTO distinct_books (book_id, other_id) VALUES (?, ?)'),
    unknown: db.prepare("SELECT id FROM books WHERE sha256 = '' ORDER BY added_at"),
    setSha256: db.prepare('UPDATE books SET sha256 = ? WHERE id = ?'),
  };
  const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);

  /**
   * Map of book id -> [{ id, reason }]: the other books it looks like, and why, the strongest reason
   * first: 'file' (the same file, added before uploads were checked), 'isbn' (an ISBN in both files)
   * or 'title' (the same title, by the same author or with the author missing on one of them, as a
   * PDF often has). Books someone said are different are left out.
   */
  function byBook() {
    const rows = stmts.books.all();
    const different = new Set(stmts.distinct.all().map((r) => pairKey(r.book_id, r.other_id)));
    const pairs = new Map(); // pairKey -> reason, the first one found
    const note = (a, b, reason) => {
      const key = pairKey(a.id, b.id);
      if (!different.has(key) && !pairs.has(key)) pairs.set(key, reason);
    };
    // The books that share a key, for each key more than one book has.
    const grouped = (keysOf) => {
      const groups = new Map();
      for (const b of rows) {
        for (const k of new Set(keysOf(b))) {
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(b);
        }
      }
      return [...groups.values()].filter((g) => g.length > 1);
    };
    const eachPair = (group, fn) => {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) fn(group[i], group[j]);
    };
    for (const g of grouped((b) => (b.sha256 ? [b.sha256] : []))) eachPair(g, (a, b) => note(a, b, 'file'));
    for (const g of grouped((b) => b.isbns.split(' ').filter(Boolean))) eachPair(g, (a, b) => note(a, b, 'isbn'));
    const authors = new Map(rows.map((b) => [b.id, authorKey(b.author)]));
    const titled = (b) => { const t = titleKey(b.title); return t && t !== 'untitled' ? [t] : []; };
    for (const g of grouped(titled)) {
      eachPair(g, (a, b) => {
        const [x, y] = [authors.get(a.id), authors.get(b.id)];
        if (!x || !y || x === y) note(a, b, 'title');
      });
    }
    const out = new Map();
    const add = (id, entry) => { if (!out.has(id)) out.set(id, []); out.get(id).push(entry); };
    for (const [key, reason] of pairs) {
      const [a, b] = key.split(' ');
      add(a, { id: b, reason });
      add(b, { id: a, reason });
    }
    return out;
  }

  /** Records that two books are different books, so they are no longer flagged as possible duplicates. */
  function markDifferent(a, b) {
    stmts.markDifferent.run(...(a < b ? [a, b] : [b, a]));
  }

  /**
   * Fingerprints the books added before uploads were checked, from their original files, so that
   * uploading one of them again is noticed, and copies of one file already in the library are flagged.
   */
  async function backfillFingerprints() {
    const rows = stmts.unknown.all();
    let done = 0;
    for (const { id } of rows) {
      const dir = path.join(config.booksDir, id);
      try {
        const name = (await fsp.readdir(dir)).find((f) => f.startsWith('original.'));
        if (!name) throw new Error('Original file is missing');
        stmts.setSha256.run(await fingerprintFile(path.join(dir, name)), id);
        done++;
      } catch (err) {
        log.error?.(`[fingerprint] ${id}: ${err.message}`);
      }
    }
    if (rows.length) log.info?.(`[fingerprint] fingerprinted ${done} of ${rows.length} book(s) added before uploads were checked`);
    return { checked: rows.length, fingerprinted: done };
  }

  return { byBook, markDifferent, backfillFingerprints };
}
