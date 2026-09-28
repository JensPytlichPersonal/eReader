import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- The typeface the reader picked; it follows them to every device ('' until they pick one).
  font TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  total_chars INTEGER NOT NULL DEFAULT 0,
  section_count INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  -- Whether the book's file has a cover of its own (cover.<ext> in the book's folder).
  has_cover INTEGER NOT NULL DEFAULT 0,
  converted_at INTEGER NOT NULL DEFAULT 0,
  -- When someone last edited the title, author or series by hand; converting again keeps those.
  edited_at INTEGER NOT NULL DEFAULT 0,
  -- Which generation of metadata reading has seen this book (see METADATA_VERSION in processing/queue.js).
  metadata_version INTEGER NOT NULL DEFAULT 0,
  -- The cover the library shows: 'file' the book's own (if it has one), 'custom' an image someone
  -- picked (custom-cover.<ext> in the book's folder) or 'none'. Converting again keeps it.
  cover_source TEXT NOT NULL DEFAULT 'file',
  -- When someone last changed the cover. It versions the cover's address, so every device fetches the new one.
  cover_edited_at INTEGER NOT NULL DEFAULT 0,
  -- The SHA-256 of the uploaded file, so the same file is not added twice ('' until known; see duplicates.js).
  sha256 TEXT NOT NULL DEFAULT '',
  -- The ISBNs in the book's file, 13 digits each, separated by spaces. The same book in another file shares one.
  isbns TEXT NOT NULL DEFAULT ''
);

-- Two books that look like the same book, but that someone said are different books, so they are no
-- longer flagged as possible duplicates. book_id is the smaller id of the two.
CREATE TABLE IF NOT EXISTS distinct_books (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, other_id)
);
CREATE INDEX IF NOT EXISTS distinct_books_other ON distinct_books(other_id);

-- Series and collections: books that belong together. A book can be in several; position
-- orders a series (1, 2, 2.5 ...) and is NULL in collections without an order. A book holding
-- several, such as an omnibus, has a range: position_end is its last number (1 to 3), else NULL.
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_series (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  position REAL,
  position_end REAL,
  PRIMARY KEY (book_id, series_id)
);
CREATE INDEX IF NOT EXISTS book_series_series ON book_series(series_id);

CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  section INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  percent REAL NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  device TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  section INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  percent REAL NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookmarks_user_book ON bookmarks(user_id, book_id);
`;

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Adds columns introduced after the first release to databases created before them. */
function migrate(db) {
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userColumns.has('font')) db.exec("ALTER TABLE users ADD COLUMN font TEXT NOT NULL DEFAULT ''");
  const columns = new Set(db.prepare('PRAGMA table_info(books)').all().map((c) => c.name));
  if (!columns.has('converted_at')) db.exec('ALTER TABLE books ADD COLUMN converted_at INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('edited_at')) db.exec('ALTER TABLE books ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('metadata_version')) db.exec('ALTER TABLE books ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('cover_source')) db.exec("ALTER TABLE books ADD COLUMN cover_source TEXT NOT NULL DEFAULT 'file'");
  if (!columns.has('cover_edited_at')) db.exec('ALTER TABLE books ADD COLUMN cover_edited_at INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('sha256')) db.exec("ALTER TABLE books ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''");
  if (!columns.has('isbns')) db.exec("ALTER TABLE books ADD COLUMN isbns TEXT NOT NULL DEFAULT ''");
  // Here rather than in SCHEMA, which runs before an older database has the column.
  db.exec('CREATE INDEX IF NOT EXISTS books_sha256 ON books(sha256)');
  const seriesColumns = new Set(db.prepare('PRAGMA table_info(book_series)').all().map((c) => c.name));
  if (!seriesColumns.has('position_end')) db.exec('ALTER TABLE book_series ADD COLUMN position_end REAL');
}

/** Runs `fn` in a transaction (a savepoint, so calls can nest). `fn` must be synchronous. */
export function transaction(db, fn) {
  db.exec('SAVEPOINT tx');
  try {
    const result = fn();
    db.exec('RELEASE tx');
    return result;
  } catch (err) {
    db.exec('ROLLBACK TO tx');
    db.exec('RELEASE tx');
    throw err;
  }
}

export const now = () => Date.now();
