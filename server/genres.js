// A book's genre, such as "Fantasy" or "Crime": one per book, set by hand, and shared by the whole
// library like series are. The library can group its books by it. Genres are matched loosely, so
// "fantasy" joins an existing "Fantasy".
import { transaction } from './db.js';

const MAX_GENRE = 100;

/** Tidies a genre: single spaces, none around it. '' for none. */
export function cleanGenre(name) {
  return String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, MAX_GENRE).trim();
}

/** Two spellings of one genre share this key: case, spacing, quotes and dashes do not matter. */
export function genreKey(name) {
  return cleanGenre(name).normalize('NFKC').toLowerCase().replace(/[‘’‛´`]/g, "'").replace(/[‐‑‒–—―]/g, '-');
}

export function createGenreStore(db) {
  const stmts = {
    names: db.prepare("SELECT DISTINCT genre FROM books WHERE genre != '' ORDER BY genre"),
    set: db.prepare('UPDATE books SET genre = ? WHERE id = ?'),
    // The genres of the other books in the numbered series a book is in, with how many books have each, the most common first.
    inSeries: db.prepare(`SELECT b.genre, COUNT(DISTINCT b.id) AS n FROM book_series mine
      JOIN book_series other ON other.series_id = mine.series_id AND other.book_id != mine.book_id
      JOIN books b ON b.id = other.book_id
      WHERE mine.book_id = ? AND mine.position IS NOT NULL AND b.genre != ''
      GROUP BY b.genre ORDER BY n DESC`),
  };

  /** Every genre a book in the library has. */
  const names = () => stmts.names.all().map((r) => r.genre);

  /** The genre as the library already spells it ("Fantasy" for "fantasy"), else tidied. '' for none. */
  function known(name) {
    const clean = cleanGenre(name);
    const key = genreKey(clean);
    return (key && names().find((n) => genreKey(n) === key)) || clean;
  }

  /** Gives books a genre, or none (''). Returns the genre as it was saved. */
  function set(ids, name) {
    const genre = known(name);
    transaction(db, () => { for (const id of ids) stmts.set.run(genre, id); });
    return genre;
  }

  /**
   * The genre of the other books in the numbered series a book is in: the one most of them have, or ''
   * when none has one or two genres are as common. A collection without numbers gives none.
   */
  function ofSeries(bookId) {
    const [first, second] = stmts.inSeries.all(bookId);
    return first && first.n !== second?.n ? first.genre : '';
  }

  return { names, known, set, ofSeries };
}
