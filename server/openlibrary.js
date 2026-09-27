// Looks books up in Open Library (openlibrary.org), a free catalogue that needs no key or account.
// Only the server talks to it, when someone presses "Look up on Open Library": the ISBN in the
// book's file and the title and author typed in the form go out, and matching books come back.
// When a match's cover is chosen, the server fetches that picture on saving.
import { withTitleSeries } from './converters/series.js';

const SITE = 'https://openlibrary.org';
const COVERS = 'https://covers.openlibrary.org';
// Open Library asks applications to say who they are.
const USER_AGENT = 'eReader (self-hosted e-reader)';
const FIELDS = 'key,title,author_name,first_publish_year,cover_i,series_name,series_position,editions,editions.key,editions.title,editions.cover_i';
const SHOWN = 5;
const KEY = /^\/(works|books)\/OL\d+[WM]$/;

/** A lookup Open Library could not answer. The message can be shown as it is. */
export class LookupError extends Error {}

// Characters with a meaning in Open Library's query syntax: "Adler-Olsen" would leave out books by "Olsen".
const searchText = (s) => String(s ?? '').replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();

const list = (v) => (Array.isArray(v) ? v : []);
// Too common to tell two titles apart: "The Hunted" is nothing like "The Encyclopedia of Arcade Video Games".
const COMMON = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'af', 'de', 'den', 'det', 'en', 'et', 'i', 'med', 'og', 'på', 'til']);

/** The words that tell a title or name apart; all of them when there is nothing else ("It"). */
function words(s) {
  const all = String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const telling = all.filter((w) => !COMMON.has(w));
  return new Set(telling.length ? telling : all);
}

/** How alike two titles are, from 0 (no word in common) to 1 (the same words). */
function likeness(a, b) {
  const x = words(a);
  const y = words(b);
  let same = 0;
  for (const w of x) if (y.has(w)) same++;
  return same ? same / (x.size + y.size - same) : 0;
}

/** Whether two authors share a name: "Adler-Olsen, Jussi" and "Jussi Adler-Olsen". Initials do not count. */
function sameAuthor(a, b) {
  const x = words(a);
  return [...words(b)].some((w) => w.length > 1 && x.has(w));
}

/**
 * A search result as a match to offer: a work (the book in all its editions and languages) and the
 * edition Open Library picked for the search.
 */
function toMatch(doc, { title, byIsbn = false, site }) {
  const edition = doc.editions?.docs?.[0];
  // A translation's work carries the original title and its edition the translated one. The edition's
  // title wins when its ISBN is the file's, or when it is closer to the title typed.
  const target = byIsbn ? edition?.title || title : title;
  const useEdition = typeof edition?.title === 'string' && likeness(edition.title, target) > likeness(doc.title, target);
  const onEdition = (useEdition || byIsbn) && KEY.test(edition?.key);
  const cover = [onEdition ? edition.cover_i : null, doc.cover_i, edition?.cover_i].find((id) => Number.isInteger(id) && id > 0);
  // Titles such as "Caliban's War (The Expanse, #2)" are tidied the way uploaded books are.
  const details = withTitleSeries({
    title: (useEdition ? edition.title : doc.title).trim(),
    series: list(doc.series_name).map((name, i) => ({ name, position: list(doc.series_position)[i] })),
  });
  return {
    key: doc.key,
    title: details.title.slice(0, 500),
    author: [...new Set(list(doc.author_name).filter((a) => typeof a === 'string'))].join(', ').slice(0, 500),
    year: Number.isInteger(doc.first_publish_year) ? doc.first_publish_year : null,
    series: details.series,
    // `cover` is a small picture to show; `coverId` asks for the large one to use (see cover()).
    cover: cover ? `${COVERS}/b/id/${cover}-M.jpg` : null,
    coverId: cover ?? null,
    url: `${site}${onEdition ? edition.key : doc.key}`,
    byIsbn,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.url] where Open Library is (tests use a stand-in)
 * @param {number} [options.interval] least time between the starts of two requests, in ms: Open Library asks for one a second at most
 * @param {number} [options.timeout] how long to wait for an answer, in ms
 */
export function createOpenLibrary({ url = SITE, interval = 1000, timeout = 10000, fetch = globalThis.fetch } = {}) {
  let nextStart = 0;

  /** The works matching a search, each with its best edition. */
  async function search(params) {
    const wait = nextStart - Date.now();
    nextStart = Math.max(nextStart, Date.now()) + interval;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    let res;
    let body;
    try {
      res = await fetch(`${url}/search.json?${new URLSearchParams({ ...params, fields: FIELDS })}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      body = await res.text();
    } catch (err) {
      throw new LookupError('Open Library did not answer. Try again in a moment.', { cause: err });
    }
    if (res.status === 429) throw new LookupError('Open Library is busy. Try again in a minute.');
    let docs = null;
    try { docs = res.ok ? JSON.parse(body).docs : null; } catch { /* reported below */ }
    if (!Array.isArray(docs)) throw new LookupError(`Open Library could not search just now${res.ok ? '' : ` (error ${res.status})`}. Try again in a moment.`);
    return docs.filter((d) => KEY.test(d?.key) && typeof d.title === 'string' && d.title.trim());
  }

  /**
   * Books matching a book's ISBNs, which name its exact edition, and a title and author. The file's
   * own edition comes first, then the titles closest to the one typed; when some share words with
   * it, those that share none are left out. A book sharing no word with the title is only offered
   * when nothing else is and it has the author typed (a translation under another title). At most five.
   * @param {{title?: string, author?: string, isbns?: string[], language?: string}} book language as in the file ("da", "en-GB")
   * @returns {Promise<Array<{key: string, title: string, author: string, year: number|null, series: Array<{name: string, position: number|null}>, cover: string|null, coverId: number|null, url: string, byIsbn: boolean}>>}
   */
  async function lookup({ title = '', author = '', isbns = [], language = '' }) {
    // Open Library shows the edition in this language where there is one.
    const lang = /^([a-z]{2})(?:-|$)/i.exec(language)?.[1].toLowerCase();
    const base = lang ? { lang } : {};
    const text = searchText(title);
    const who = searchText(author);
    const found = [];
    try {
      for (const isbn of isbns.filter((i) => /^\d{13}$/.test(i)).slice(0, 2)) {
        const [doc] = await search({ ...base, q: `isbn:${isbn}`, limit: 1 });
        if (doc) { found.push(toMatch(doc, { title, byIsbn: true, site: url })); break; }
      }
      if (text) {
        let docs = await search({ ...base, q: who ? `${text} ${who}` : text, limit: 8 });
        // Every word has to match, so an author written differently can hide the book.
        if (!docs.length && who) docs = await search({ ...base, q: text, limit: 8 });
        found.push(...docs.map((doc) => toMatch(doc, { title, site: url })));
      }
    } catch (err) {
      // What was found before Open Library stopped answering is still worth showing.
      if (!(err instanceof LookupError) || !found.length) throw err;
    }
    const seen = new Set();
    const ranked = found
      .filter((m) => !seen.has(m.key) && seen.add(m.key))
      .map((m, i) => ({ m, i, score: m.byIsbn ? 2 : likeness(m.title, title) }))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    // The search without the author finds books with those words anywhere, even in their subjects:
    // "Omega Force: Hunted" turns up an encyclopedia of arcade games.
    const close = ranked[0]?.score > 0;
    return ranked.filter((r) => r.score > 0 || (!close && sameAuthor(r.m.author, author))).slice(0, SHOWN).map((r) => r.m);
  }

  /**
   * The large picture of a cover, by the `coverId` of a match. Open Library keeps many of them on
   * archive.org and redirects there.
   * @returns {Promise<Buffer>} the image as sent; the caller checks that it is one
   */
  async function cover(id) {
    if (!Number.isInteger(id) || id <= 0) throw new TypeError(`Not a cover id: ${id}`);
    let res;
    let image;
    try {
      // Without default=false a missing cover comes back as a blank picture.
      res = await fetch(`${COVERS}/b/id/${id}-L.jpg?default=false`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
      image = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new LookupError('Open Library did not send the cover. Try again in a moment.', { cause: err });
    }
    if (res.status === 404) throw new LookupError('Open Library no longer has this cover.');
    if (!res.ok) throw new LookupError(`Open Library did not send the cover (error ${res.status}). Try again in a moment.`);
    return image;
  }

  return { lookup, cover };
}
