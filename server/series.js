// Series and collections are shared by the whole library, like the books in them. A book can
// belong to several, each with a position (numbered series) or none (a collection without order).
// Names are matched loosely, so "the expanse" joins an existing "The Expanse".
import { now, transaction } from './db.js';
import { cleanSeriesName, seriesKey, uniqueSeries } from './converters/series.js';

export function createSeriesStore(db) {
  const stmts = {
    get: db.prepare('SELECT id, name FROM series WHERE id = ?'),
    names: db.prepare('SELECT name FROM series ORDER BY id'),
    byKey: db.prepare('SELECT id, name FROM series WHERE name_key = ?'),
    insert: db.prepare('INSERT INTO series (name, name_key, created_at) VALUES (?, ?, ?)'),
    rename: db.prepare('UPDATE series SET name = ?, name_key = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM series WHERE id = ?'),
    prune: db.prepare('DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM book_series bs WHERE bs.series_id = series.id)'),
    forBook: db.prepare(`SELECT s.id, s.name, bs.position FROM book_series bs JOIN series s ON s.id = bs.series_id
      WHERE bs.book_id = ? ORDER BY bs.rowid`),
    all: db.prepare('SELECT bs.book_id, s.id, s.name, bs.position FROM book_series bs JOIN series s ON s.id = bs.series_id ORDER BY bs.rowid'),
    booksIn: db.prepare('SELECT b.title, b.author, bs.position FROM book_series bs JOIN books b ON b.id = bs.book_id WHERE bs.series_id = ? ORDER BY bs.position'),
    clearBook: db.prepare('DELETE FROM book_series WHERE book_id = ?'),
    addBook: db.prepare('INSERT INTO book_series (book_id, series_id, position) VALUES (?, ?, ?)'),
    // Merging: books take their place from the series being merged in when they have none in the other.
    fillPositions: db.prepare(`UPDATE book_series SET position = (SELECT f.position FROM book_series f WHERE f.series_id = ? AND f.book_id = book_series.book_id)
      WHERE series_id = ? AND position IS NULL`),
    moveBooks: db.prepare('INSERT OR IGNORE INTO book_series (book_id, series_id, position) SELECT book_id, ?, position FROM book_series WHERE series_id = ?'),
    markEdited: db.prepare('UPDATE books SET edited_at = ? WHERE id IN (SELECT book_id FROM book_series WHERE series_id = ?)'),
  };

  const shape = (r) => ({ id: r.id, name: r.name, position: r.position ?? null });

  /** The id of the series with this name, creating it when there is none. */
  function idFor(name) {
    const clean = cleanSeriesName(name);
    const key = seriesKey(clean);
    const row = stmts.byKey.get(key);
    return row ? row.id : Number(stmts.insert.run(clean, key, now()).lastInsertRowid);
  }

  /** Replaces the series and collections a book is in. `entries`: [{ name, position }] in order of importance. */
  function setForBook(bookId, entries) {
    transaction(db, () => {
      stmts.clearBook.run(bookId);
      for (const e of uniqueSeries(entries)) stmts.addBook.run(bookId, idFor(e.name), e.position);
      stmts.prune.run();
    });
  }

  /** Map of book id -> [{ id, name, position }] for the whole library. */
  function byBook() {
    const out = new Map();
    for (const r of stmts.all.all()) {
      if (!out.has(r.book_id)) out.set(r.book_id, []);
      out.get(r.book_id).push(shape(r));
    }
    return out;
  }

  /**
   * Renames a series. When another series already has the new name, this one is merged into it
   * (which keeps its name). Books in it count as edited by hand, so converting them again keeps the change.
   * @returns {number} id of the renamed (or merged into) series
   */
  function rename(id, name) {
    const clean = cleanSeriesName(name);
    const key = seriesKey(clean);
    return transaction(db, () => {
      stmts.markEdited.run(now(), id);
      const other = stmts.byKey.get(key);
      if (!other || other.id === id) {
        stmts.rename.run(clean, key, id);
        return id;
      }
      stmts.fillPositions.run(id, other.id);
      stmts.moveBooks.run(other.id, id);
      stmts.delete.run(id);
      return other.id;
    });
  }

  /** Dissolves a series; its books stay in the library. */
  function remove(id) {
    transaction(db, () => {
      stmts.markEdited.run(now(), id);
      stmts.delete.run(id);
    });
  }

  return {
    get: (id) => stmts.get.get(id) || null,
    /** The name of every series and collection, oldest first. */
    names: () => stmts.names.all().map((r) => r.name),
    forBook: (bookId) => stmts.forBook.all(bookId).map(shape),
    /** The title, author and number of each book in a series or collection. */
    books: (id) => stmts.booksIn.all(id).map((r) => ({ title: r.title, author: r.author, position: r.position ?? null })),
    byBook,
    setForBook,
    rename,
    remove,
    /** Drops series no book belongs to any more (after books are deleted). */
    prune: () => stmts.prune.run(),
  };
}
