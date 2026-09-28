// Settings an admin changes from the app rather than on the server, kept in the database: one value
// per key, with who set it and when. So far only the Hardcover token (see catalogues.js).
import { now } from './db.js';

export function createSettingsStore(db) {
  const stmts = {
    // The name of whoever set it goes with it; null once their account is deleted.
    get: db.prepare(`SELECT s.value, s.updated_at, s.updated_by, u.display_name FROM settings s
      LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?`),
    set: db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    remove: db.prepare('DELETE FROM settings WHERE key = ?'),
  };

  /**
   * A setting, or null when it is not set. `updatedBy` is the id of the user who set it, and
   * `updatedByName` their display name (both null once their account is deleted).
   * @returns {{value: string, updatedAt: number, updatedBy: number|null, updatedByName: string|null}|null}
   */
  function get(key) {
    const row = stmts.get.get(key);
    return row ? { value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by ?? null, updatedByName: row.display_name ?? null } : null;
  }

  /** Sets a setting, by the user with this id (null when no one in particular did). */
  function set(key, value, userId = null) {
    stmts.set.run(key, String(value), now(), userId ?? null);
  }

  /** Removes a setting, so what the server is given instead applies again. */
  function remove(key) {
    stmts.remove.run(key);
  }

  return { get, set, remove };
}
