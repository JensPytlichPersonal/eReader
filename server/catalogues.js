// The catalogues books are looked up in, and the Hardcover token they use. An admin enters the token
// under Settings in the app, where it is kept in the database (see settings.js) and wins over
// HARDCOVER_TOKEN, which the server can be given instead. A token saved while the server runs is used
// at once: the Hardcover client, and what finds the books a series lacks, are made anew from it, and
// the lookup and the routes ask for them each time. The token itself never leaves the server.
import { createHardcover } from './hardcover.js';
import { createLookup, LookupError } from './lookup.js';
import { createMissingBooks } from './missing.js';

const HARDCOVER_TOKEN = 'hardcoverToken';
// Hardcover's tokens are a few hundred characters; this only stops mistakes.
const MAX_TOKEN = 4096;

/** A setting that cannot be taken as it is. The message can be shown as it is. */
export class SettingError extends Error {}

/**
 * @param {object} options
 * @param {{hardcoverToken: string}} options.config the token the server was given (HARDCOVER_TOKEN)
 * @param {ReturnType<import('./settings.js').createSettingsStore>} options.settings
 * @param {object} options.openLibrary
 * @param {object} [options.overrides] tests hand in stand-ins: a Hardcover client (`hardcover`, null for
 * none) used whatever the token, a finder of the books a series lacks (`missingBooks`), or the fetch
 * a Hardcover client made from the token uses (`hardcoverFetch`)
 */
export function createCatalogues({ config, settings, log = console, openLibrary, overrides = {} }) {
  const current = { hardcover: null, missingBooks: null };

  /** The token in use: the one saved under Settings when there is one ('' for none), else the server's. */
  function hardcoverToken() {
    const saved = settings.get(HARDCOVER_TOKEN);
    return { token: (saved ? saved.value : config.hardcoverToken ?? '').trim(), saved };
  }

  function rebuild() {
    const { token } = hardcoverToken();
    const fetch = overrides.hardcoverFetch ? { fetch: overrides.hardcoverFetch } : {};
    const hardcover = overrides.hardcover !== undefined ? overrides.hardcover : token ? createHardcover({ token, ...fetch }) : null;
    if (hardcover?.problem) log.error?.(`[lookup] ${hardcover.problem}`);
    current.hardcover = hardcover;
    // The books a series lacks come from Hardcover alone. Tests hand in one that does not wait between lookups.
    current.missingBooks = overrides.missingBooks !== undefined ? overrides.missingBooks : hardcover ? createMissingBooks({ catalogue: hardcover, log }) : null;
  }

  const lookups = createLookup({ openLibrary, hardcover: () => current.hardcover, log });

  /**
   * Where the token in use comes from ('settings', 'env' for HARDCOVER_TOKEN, or 'none'), its last
   * four characters to tell it by, and when and by whom it was saved under Settings.
   */
  function hardcoverStatus() {
    const { token, saved } = hardcoverToken();
    const source = !token ? 'none' : saved ? 'settings' : 'env';
    const inSettings = source === 'settings';
    return { source, hint: token.slice(-4), updatedAt: inSettings ? saved.updatedAt : null, updatedBy: inSettings ? saved.updatedByName : null };
  }

  /**
   * Saves the Hardcover token an admin entered, copied with or without "Bearer " in front, and uses it
   * from now on. '' removes it, so HARDCOVER_TOKEN applies again, or none. Throws a SettingError for
   * something that cannot be a token.
   */
  function setHardcoverToken(token, userId) {
    if (typeof token !== 'string') throw new SettingError("hardcoverToken must be the token as text, or '' to remove it");
    const typed = token.trim();
    const bare = typed.replace(/^bearer(\s+|$)/i, '');
    if (typed && !bare) throw new SettingError('That is only "Bearer". Paste the token that comes after it as well.');
    if (bare.length > MAX_TOKEN) throw new SettingError('That is too long for a Hardcover token. Paste the token alone.');
    // Hardcover's tokens are plain ASCII; anything else is a paste gone wrong, which would otherwise fail later as "Hardcover did not answer".
    if (/[^\x21-\x7E]/.test(bare)) throw new SettingError('A Hardcover token is plain text without spaces or line breaks. Paste the token alone.');
    if (bare) settings.set(HARDCOVER_TOKEN, bare, userId);
    else settings.remove(HARDCOVER_TOKEN);
    rebuild();
    return hardcoverStatus();
  }

  /** Whether Hardcover takes the token in use: { ok: true }, or { ok: false, error } saying why not. */
  async function checkHardcover() {
    if (!current.hardcover) return { ok: false, error: 'No Hardcover token is set.' };
    try {
      await current.hardcover.check();
      return { ok: true };
    } catch (err) {
      if (err instanceof LookupError) return { ok: false, error: err.message };
      throw err;
    }
  }

  rebuild();

  return {
    hardcoverStatus,
    setHardcoverToken,
    checkHardcover,
    /** The Hardcover client in use, or null without a token. */
    get hardcover() { return current.hardcover; },
    /** What finds the books a series lacks (see missing.js), or null without a token. */
    get missingBooks() { return current.missingBooks; },
    lookups,
    /** The catalogues books are looked up in now: 'hardcover' and 'openlibrary'. */
    get sources() { return lookups.sources; },
  };
}
