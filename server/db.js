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
  created_at INTEGER NOT NULL
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
  has_cover INTEGER NOT NULL DEFAULT 0,
  converted_at INTEGER NOT NULL DEFAULT 0,
  -- When someone last edited the title, author or series by hand; converting again keeps those.
  edited_at INTEGER NOT NULL DEFAULT 0,
  -- Which generation of metadata reading has seen this book (see METADATA_VERSION in processing/queue.js).
  metadata_version INTEGER NOT NULL DEFAULT 0
);

-- Series and collections: books that belong together. A book can be in several; position
-- orders a series (1, 2, 2.5 ...) and is NULL in collections without an order.
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
  const columns = new Set(db.prepare('PRAGMA table_info(books)').all().map((c) => c.name));
  if (!columns.has('converted_at')) db.exec('ALTER TABLE books ADD COLUMN converted_at INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('edited_at')) db.exec('ALTER TABLE books ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('metadata_version')) db.exec('ALTER TABLE books ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0');
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
