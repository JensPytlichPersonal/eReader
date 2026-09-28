// Looks books up on Hardcover (hardcover.app), a book catalogue that knows series and their order
// well. It needs a token from the Hardcover account's API settings (the read:catalog permission is
// enough), given to the server as HARDCOVER_TOKEN; without one the lookup asks Open Library alone.
// Only the server talks to Hardcover, when someone looks a book up or saves a cover from it.
import { withTitleSeries } from './converters/series.js';
import { LookupError, USER_AGENT, rankMatches } from './lookup.js';

const API = 'https://api.hardcover.app/v1/graphql';
const SITE = 'https://hardcover.app';

// A book's cover can be in three places: the edition Hardcover shows it with (the cover on its
// website), a cached copy of that, and the book's own image, which can be an older one.
const COVERS = 'image { url } cached_image default_cover_edition { image { url } }';
// What a match needs of a book. Contributions include translators and illustrators; authors have
// no role or "Author".
const BOOK = `id title release_year ${COVERS} contributions { contribution author { name } } book_series { position featured series { name } }`;
// A request may hold one search and nothing else, so the books it finds are fetched in a second one.
const SEARCH = 'query Search($q: String!) { search(query: $q, query_type: "Book", per_page: 8, page: 1) { ids error } }';
const DETAILS = `query Details($ids: [Int!]!, $isbns: [String!]!) {
  books(where: {id: {_in: $ids}}) { ${BOOK} }
  editions(where: {isbn_13: {_in: $isbns}}, limit: 2) { title book { ${BOOK} } }
}`;
const COVER = `query Cover($id: Int!) { books(where: {id: {_eq: $id}}, limit: 1) { ${COVERS} } }`;

const list = (v) => (Array.isArray(v) ? v : []);
const isBook = (b) => Number.isInteger(b?.id) && b.id > 0 && typeof b.title === 'string' && b.title.trim() !== '';

/** The ids of the books a search found, in order. An answer without them is reported, not taken as "nothing found". */
function foundIds(search) {
  if (typeof search?.error === 'string' && search.error.trim()) throw new LookupError(`Hardcover could not search: ${search.error.trim().slice(0, 200)}`);
  let ids = search?.ids;
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch { ids = null; }
  }
  if (!Array.isArray(ids)) throw new LookupError('Hardcover answered the search without a list of books. Try again in a moment.');
  return ids.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

/** A picture to fetch: https, and not an address inside a network. */
function publicImageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    const inside = /^[\d.]+$/.test(host) || host.includes(':') || host.includes('[') || /(^|\.)(localhost|local|internal)$/i.test(host);
    return url.protocol === 'https:' && !inside ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The address of the cover Hardcover shows a book with on its website: its display edition's, else a
 * cached copy of that, else the book's own image.
 */
function shownCover(book) {
  let cached = book.cached_image;
  if (typeof cached === 'string') {
    try { cached = JSON.parse(cached); } catch { cached = null; }
  }
  for (const image of [book.default_cover_edition?.image, cached, book.image]) {
    const url = publicImageUrl(image?.url);
    if (url) return url;
  }
  return null;
}

/** A Hardcover book as a match to offer. With `editionTitle`, the book was found by an edition's ISBN. */
function toMatch(book, { byIsbn = false, editionTitle } = {}) {
  const authors = list(book.contributions)
    .filter((c) => !c?.contribution || /^author$/i.test(c.contribution))
    .map((c) => c?.author?.name)
    .filter((name) => typeof name === 'string' && name.trim());
  // The featured series first: the one Hardcover shows with the book.
  const series = list(book.book_series)
    .filter((s) => typeof s?.series?.name === 'string')
    .sort((a, b) => (b.featured === true) - (a.featured === true))
    .map((s) => ({ name: s.series.name, position: s.position }));
  // Titles such as "Caliban's War (The Expanse, #2)" are tidied the way uploaded books are.
  const details = withTitleSeries({ title: String((byIsbn && editionTitle) || book.title).trim(), series });
  const cover = shownCover(book);
  return {
    key: `hardcover:${book.id}`,
    source: 'hardcover',
    title: details.title.slice(0, 500),
    author: [...new Set(authors.map((a) => a.trim()))].join(', ').slice(0, 500),
    year: Number.isInteger(book.release_year) ? book.release_year : null,
    series: details.series,
    // Covers are fetched by the book's id when used (see cover()).
    cover,
    coverSource: cover ? 'hardcover' : null,
    coverId: cover ? book.id : null,
    url: `${SITE}/id/book/${book.id}`,
    byIsbn,
  };
}

/**
 * @param {object} options
 * @param {string} options.token from the account's API settings, with or without "Bearer " in front
 * @param {string} [options.url] where the API is (tests use a stand-in)
 * @param {number} [options.timeout] how long to wait for an answer, in ms
 */
export function createHardcover({ token, url = API, timeout = 10000, fetch = globalThis.fetch }) {
  const bare = token.trim().replace(/^bearer(\s+|$)/i, '');
  // systemd splits Environment= settings at spaces, so HARDCOVER_TOKEN=Bearer eyJ... leaves only "Bearer".
  const unusable = bare ? null : 'HARDCOVER_TOKEN holds "Bearer" but no token. In the systemd unit, put the whole setting in quotes or leave "Bearer " out, then run systemctl daemon-reload and restart the eReader.';

  async function query(text, variables) {
    if (unusable) throw new LookupError(unusable);
    let res;
    let body;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bare}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({ query: text, variables }),
        signal: AbortSignal.timeout(timeout),
      });
      body = await res.text();
    } catch (err) {
      throw new LookupError('Hardcover did not answer. Try again in a moment.', { cause: err });
    }
    if (res.status === 401) throw new LookupError('Hardcover did not accept the token; it may have expired. Make a new one and restart the eReader server.');
    if (res.status === 403) throw new LookupError('The Hardcover token may not look up books. Make one with the read:catalog permission.');
    if (res.status === 429) throw new LookupError('Hardcover is busy, or the token has used up its requests for today. Try again later.');
    let data = null;
    try { data = JSON.parse(body); } catch { /* reported below */ }
    // GraphQL reports a query it cannot run with status 200 and a list of errors.
    const problem = list(data?.errors)[0]?.message;
    if (!res.ok || problem || !data?.data) {
      throw new LookupError(`Hardcover could not look it up${problem ? `: ${String(problem).slice(0, 200)}` : res.ok ? '' : ` (error ${res.status})`}. Try again in a moment.`);
    }
    return data.data;
  }

  /**
   * Books matching a book's ISBNs and a title and author, ranked by rankMatches(). At most five.
   * @param {{title?: string, author?: string, isbns?: string[]}} book
   */
  async function lookup({ title = '', author = '', isbns = [] }) {
    const typed = String(title).trim();
    const ids = typed ? foundIds((await query(SEARCH, { q: `${typed} ${String(author).trim()}`.trim().slice(0, 300) })).search) : [];
    const isbn13 = isbns.filter((i) => /^\d{13}$/.test(i)).slice(0, 2);
    if (!ids.length && !isbn13.length) return [];
    const data = await query(DETAILS, { ids, isbns: isbn13 });
    const found = list(data.editions).filter((e) => isBook(e?.book)).map((e) => toMatch(e.book, { byIsbn: true, editionTitle: e.title }));
    // In the order the search found them.
    const books = new Map(list(data.books).filter(isBook).map((b) => [b.id, b]));
    for (const id of ids) if (books.has(id)) found.push(toMatch(books.get(id)));
    return rankMatches(found, { title, author });
  }

  /**
   * The picture of a book's cover, by the `coverId` of a match (the book's id): the one its website
   * shows, as Hardcover stores it.
   * @returns {Promise<Buffer>} the image as sent; the caller checks that it is one
   */
  async function cover(id) {
    if (!Number.isInteger(id) || id <= 0) throw new TypeError(`Not a Hardcover book id: ${id}`);
    const address = shownCover(list((await query(COVER, { id })).books)[0] ?? {});
    if (!address) throw new LookupError('Hardcover has no cover for this book.');
    let res;
    let image;
    try {
      res = await fetch(address, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
      image = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new LookupError('Hardcover did not send the cover. Try again in a moment.', { cause: err });
    }
    if (!res.ok) throw new LookupError(`Hardcover did not send the cover (error ${res.status}). Try again in a moment.`);
    return image;
  }

  /** Why the token cannot work, when that is plain from the start. */
  return { lookup, cover, problem: unusable };
}
