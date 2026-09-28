// Looks books up on Hardcover (hardcover.app), a book catalogue that knows series and their order
// well. It needs a token from the Hardcover account's API settings (the read:catalog permission is
// enough), given to the server as HARDCOVER_TOKEN; without one the lookup asks Open Library alone.
// Only the server talks to Hardcover: when someone looks a book up or saves a cover from it, and
// for the books a series lacks (see missing.js).
import { parsePosition, withTitleSeries } from './converters/series.js';
import { LookupError, USER_AGENT, likeness, rankMatches, sameAuthor, sameTitle } from './lookup.js';

const API = 'https://api.hardcover.app/v1/graphql';
const SITE = 'https://hardcover.app';

// Pictures are fetched by their id when a cover is saved, so the one saved is the one offered.
const IMAGE = 'image { id url }';
// An edition's language, as Hardcover codes it ("en" and "eng"). Many editions have none set.
const LANGUAGE = 'language { code2 code3 }';
// Contributions include translators and illustrators; authors have no role or "Author".
const AUTHORS = 'contributions { contribution author { name } }';
// An edition's reading format: 1 physical, 2 audio, 3 both, 4 e-book. Audiobook editions are left out:
// their covers are square, and their titles can say "Unabridged".
const FORMAT = 'reading_format_id';
const AUDIO = 2;
const NOT_AUDIO = `reading_format_id: {_neq: ${AUDIO}}`;
const isAudio = (edition) => edition?.reading_format_id === AUDIO;
// A book's editions with a picture, those most readers have first.
const pictured = (where = '') => `editions(where: {image_id: {_is_null: false}, ${NOT_AUDIO}${where}}, order_by: {users_count: desc}, limit: 30) { ${IMAGE} ${LANGUAGE} ${FORMAT} }`;
// What a match needs of a book. Its covers are its editions', from the one Hardcover shows it with (the
// cover on its website); else it has its own image, which can be an older one. Those in the book's
// language are asked for too: of a book in many languages, the editions most readers have can all be
// in another one.
const BOOK = `id title release_year ${IMAGE} default_cover_edition { ${IMAGE} ${LANGUAGE} ${FORMAT} } ${AUTHORS} book_series { position featured series { name } }
  inLanguage: ${pictured(', language: {code2: {_eq: $language}}')} mostRead: ${pictured()}`;
// An edition can have a title, authors, cover and language of its own.
const EDITION = `id title release_year ${IMAGE} ${AUTHORS} ${LANGUAGE} ${FORMAT}`;
// A request may hold one search and nothing else, so the books found are fetched in another one.
const SEARCH = 'query Search($q: String!) { search(query: $q, query_type: "Book", per_page: 8, page: 1) { ids error } }';
// Each book comes with the editions most readers have: a book can be listed under another title and
// other authors, such as a collection's, and have its own only on an edition. $language is the book's
// ("en"), '' when it is not known.
const DETAILS = `query Details($ids: [Int!]!, $isbns: [String!]!, $language: String!) {
  books(where: {id: {_in: $ids}}) { ${BOOK} editions(where: {${NOT_AUDIO}}, order_by: {users_count: desc}, limit: 10) { ${EDITION} } }
  editions(where: {isbn_13: {_in: $isbns}}, limit: 2) { ${EDITION} book { ${BOOK} } }
}`;
const COVER = 'query Cover($id: bigint!) { images_by_pk(id: $id) { url } }';
const FIND_SERIES = 'query FindSeries($q: String!) { search(query: $q, query_type: "Series", per_page: 5, page: 1) { ids error } }';
// Each series with its books in order, one per place (the most read where several share one),
// leaving out merged duplicates, parts of books and box sets, as Hardcover's series page does.
const SERIES = `query Series($ids: [Int!]!) {
  series(where: {id: {_in: $ids}, canonical_id: {_is_null: true}}) {
    id name author { name }
    book_series(distinct_on: position, order_by: [{position: asc}, {book: {users_count: desc}}], limit: 200,
      where: {position: {_is_null: false}, compilation: {_eq: false}, book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}}}) {
      position book { id title release_date ${AUTHORS} }
    }
  }
}`;
// The series the books a search found are in, to find a series through one of its books. A series
// merged into another has that one's id as its canonical_id.
const BOOKS_SERIES = `query BooksSeries($ids: [Int!]!) {
  books(where: {id: {_in: $ids}}) { id title ${AUTHORS} book_series { position series { id name canonical_id } } }
}`;

const list = (v) => (Array.isArray(v) ? v : []);
const isBook = (b) => Number.isInteger(b?.id) && b.id > 0 && typeof b.title === 'string' && b.title.trim() !== '';
const isSeries = (s) => Number.isInteger(s?.id) && s.id > 0 && typeof s.name === 'string' && s.name.trim() !== '';
const year = (v) => (Number.isInteger(v) ? v : null);

/**
 * A search as Hardcover should read it. Hardcover takes one that starts with "by" for books by an
 * author ("by Brandon Sanderson"), so "By Schism Rent Asunder" found books by Gordon Chism and Michele
 * Scism. In quotes, "By" is a word to find like the others.
 */
const searchFor = (q) => q.replace(/^by(?=\s)/i, '"$&"');

/** A language as its code, from a tag such as "en-GB" or "eng", or as Hardcover gives it. '' when there is none. */
function languageOf(value) {
  try {
    const code = new Intl.Locale(typeof value === 'string' ? value : value?.code2 || value?.code3).language;
    return /^[a-z]{2,3}$/.test(code) ? code : '';
  } catch {
    return '';
  }
}

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

/** A picture to offer as a cover: its id, and its address if that is a public one. */
function picture(image) {
  const url = publicImageUrl(image?.url);
  const id = Number(image?.id);
  return url && Number.isSafeInteger(id) && id > 0 ? { id, url } : null;
}

/** The authors among the contributors to a book or edition, in one line. */
function authorsOf(contributions) {
  const names = list(contributions)
    .filter((c) => !c?.contribution || /^author$/i.test(c.contribution))
    .map((c) => c?.author?.name)
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim());
  return [...new Set(names)].join(', ');
}

/**
 * The edition whose title and authors fit the ones typed better than the book's own, or null. On
 * Hardcover, Beyond the Dark Portal is listed as "World of Warcraft, Vol. 4" by other authors, and
 * only its edition has its title and authors.
 */
function fittingEdition(book, { title = '', author = '' }) {
  const fit = (t, a) => likeness(t, title) + (author && sameAuthor(a, author) ? 1 : 0);
  const own = authorsOf(book.contributions);
  let best = null;
  let most = fit(book.title, own);
  for (const edition of list(book.editions)) {
    if (typeof edition?.title !== 'string' || !edition.title.trim() || isAudio(edition)) continue;
    const score = fit(edition.title, authorsOf(edition.contributions) || own);
    if (score > most) [best, most] = [edition, score];
  }
  return best;
}

/**
 * A Hardcover book as a match to offer, as it is listed or as one of its editions: the one with the
 * file's ISBN (`byIsbn`), or one that fits the title typed better (see fittingEdition()). `language`
 * is the book's, as languageOf() gives it.
 */
function toMatch(book, { edition = null, byIsbn = false, language = '' } = {}) {
  // The featured series first: the one Hardcover shows with the book.
  const series = list(book.book_series)
    .filter((s) => typeof s?.series?.name === 'string')
    .sort((a, b) => (b.featured === true) - (a.featured === true))
    .map((s) => ({ name: s.series.name, position: s.position }));
  // Titles such as "Caliban's War (The Expanse, #2)" are tidied the way uploaded books are.
  const title = (typeof edition?.title === 'string' && edition.title.trim()) || book.title.trim();
  const details = withTitleSeries({ title, series });
  // Covers of editions that are not marked as being in another language than the book, as its file
  // gives it, else as the edition it is offered as has it: the edition's own first, then the one
  // Hardcover shows the book with, then those in the book's language, then those most readers have.
  const lang = language || languageOf(edition?.language) || languageOf(book.default_cover_edition?.language);
  const fits = (e) => !isAudio(e) && (!lang || [lang, ''].includes(languageOf(e.language)));
  // A picture two editions share is offered once. The same artwork in another size is a picture of
  // its own, and is offered as well: the larger one can be the better cover.
  const seen = new Set();
  const pictures = [edition, ...[book.default_cover_edition, ...list(book.inLanguage), ...list(book.mostRead)].filter((e) => e && fits(e))]
    .map((e) => picture(e?.image))
    .filter((p) => p && !seen.has(p.id) && seen.add(p.id));
  // Without one, the cover Hardcover shows the book with all the same, unless it is an audiobook's,
  // else the book's own image.
  const cover = pictures[0] ?? (isAudio(book.default_cover_edition) ? null : picture(book.default_cover_edition?.image)) ?? picture(book.image);
  return {
    key: `hardcover:${book.id}`,
    source: 'hardcover',
    title: details.title.slice(0, 500),
    author: ((edition && authorsOf(edition.contributions)) || authorsOf(book.contributions)).slice(0, 500),
    year: year(edition?.release_year) ?? year(book.release_year),
    series: details.series,
    // Covers are fetched by the picture's id when used (see cover()).
    cover: cover?.url ?? null,
    coverSource: cover ? 'hardcover' : null,
    coverId: cover?.id ?? null,
    // The other covers, to take instead of that one.
    covers: pictures.slice(1).map((p) => ({ cover: p.url, coverSource: 'hardcover', coverId: p.id })),
    url: `${SITE}/id/book/${book.id}`,
    byIsbn,
  };
}

/**
 * A Hardcover series with its books in order. A book not published by `today` (YYYY-MM-DD) is
 * `upcoming`; Hardcover lists books once they are announced.
 */
function toSeries(s, today) {
  const books = list(s.book_series)
    .map((entry) => ({ entry, position: parsePosition(entry?.position) }))
    .filter(({ entry, position }) => position != null && isBook(entry.book))
    .map(({ entry: { book }, position }) => ({
      position,
      // Titles such as "Caliban's War (The Expanse, #2)" are tidied the way uploaded books are.
      title: withTitleSeries({ title: book.title.trim(), series: [{ name: s.name, position }] }).title.slice(0, 500),
      author: authorsOf(book.contributions).slice(0, 500),
      upcoming: typeof book.release_date === 'string' && book.release_date > today,
      url: `${SITE}/id/book/${book.id}`,
    }));
  const author = typeof s.author?.name === 'string' ? s.author.name.trim() : '';
  return { name: s.name.trim(), author, url: `${SITE}/id/series/${s.id}`, books };
}

/**
 * Whether a book a search found is the one looked for: the same title, tidied as a series' titles are,
 * and one of the same authors when the author is known.
 */
function isTheBook(book, { title, author }) {
  const series = list(book.book_series).filter((e) => typeof e?.series?.name === 'string').map((e) => ({ name: e.series.name, position: e.position }));
  return sameTitle(withTitleSeries({ title: book.title.trim(), series }).title, title) && (!author || sameAuthor(authorsOf(book.contributions), author));
}

/** The id of a series a book is listed in; of one merged into another, that one's. */
const seriesId = (s) => [s?.canonical_id, s?.id].find((id) => Number.isInteger(id) && id > 0) ?? null;

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

  /** The ids of the books a search finds. */
  const search = async (q) => foundIds((await query(SEARCH, { q: searchFor(q).slice(0, 300) })).search);
  // A search that only adds to another: when it fails, the other's books are offered.
  const extraSearch = (q) => search(q).catch((err) => {
    if (err instanceof LookupError) return [];
    throw err;
  });

  /**
   * Books matching a book's ISBNs and a title and author, ranked by rankMatches(). At most five.
   * @param {{title?: string, author?: string, isbns?: string[], language?: string}} book language as in the file ("da", "en-GB")
   */
  async function lookup({ title = '', author = '', isbns = [], language = '' }) {
    const lang = languageOf(language);
    const typed = String(title).trim();
    const who = String(author).trim();
    // With an author, the title alone as well: that finds a book listed with other authors than its
    // edition's. Of the books only it finds, those by the authors typed are offered.
    const [ids, more] = typed ? await Promise.all([search(`${typed} ${who}`.trim()), who ? extraSearch(typed) : []]) : [[], []];
    const extra = new Set(more.filter((id) => !ids.includes(id)));
    const all = [...ids, ...extra];
    const isbn13 = isbns.filter((i) => /^\d{13}$/.test(i)).slice(0, 2);
    if (!all.length && !isbn13.length) return [];
    const data = await query(DETAILS, { ids: all, isbns: isbn13, language: lang });
    // An ISBN of an audiobook edition still names the book, which is offered as itself.
    const found = list(data.editions).filter((e) => isBook(e?.book)).map((e) => toMatch(e.book, { edition: isAudio(e) ? null : e, byIsbn: true, language: lang }));
    // In the order the searches found them.
    const books = new Map(list(data.books).filter(isBook).map((b) => [b.id, b]));
    for (const id of all) {
      const book = books.get(id);
      if (!book) continue;
      const m = toMatch(book, { edition: fittingEdition(book, { title, author }), language: lang });
      if (!extra.has(id) || sameAuthor(m.author, who)) found.push(m);
    }
    return rankMatches(found, { title, author });
  }

  /**
   * The picture of a match's cover, by its `coverId` (the picture's id), as Hardcover stores it.
   * @returns {Promise<Buffer>} the image as sent; the caller checks that it is one
   */
  async function cover(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`Not a Hardcover picture id: ${id}`);
    const address = publicImageUrl((await query(COVER, { id })).images_by_pk?.url);
    if (!address) throw new LookupError('Hardcover no longer has this cover.');
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

  /** The series with these ids, in that order, each with its books in order. Merged duplicates are left out. */
  async function seriesById(ids) {
    if (!ids.length) return [];
    const found = new Map(list((await query(SERIES, { ids })).series).filter(isSeries).map((s) => [s.id, s]));
    const today = new Date().toISOString().slice(0, 10);
    return ids.filter((id) => found.has(id)).map((id) => toSeries(found.get(id), today));
  }

  /**
   * The series Hardcover has under a name, the closest first, each with its books in order. At most five.
   * @returns {Promise<Array<{name: string, author: string, url: string, books: Array<{position: number, title: string, author: string, upcoming: boolean, url: string}>}>>}
   */
  async function series(name) {
    return seriesById(foundIds((await query(FIND_SERIES, { q: String(name).slice(0, 300) })).search));
  }

  /**
   * The series Hardcover lists a book in, found by its title and author, as series() gives them. This
   * finds a series under another name than the library's: Prince of Lies by James Lowder is #4 of
   * what Hardcover calls "Forgotten Realms: Avatar". At most five.
   * @param {{title: string, author?: string}} book
   */
  async function seriesOf({ title, author = '' }) {
    const book = { title: String(title).trim(), author: String(author).trim() };
    if (!book.title) return [];
    const ids = await search(`${book.title} ${book.author}`.trim());
    if (!ids.length) return [];
    const found = new Map(list((await query(BOOKS_SERIES, { ids })).books).filter(isBook).map((b) => [b.id, b]));
    // The series of the books that are this one, in the order the search found them.
    const inSeries = ids.map((id) => found.get(id)).filter((b) => b && isTheBook(b, book))
      .flatMap((b) => list(b.book_series).map((e) => seriesId(e?.series)))
      .filter((id, i, all) => id && all.indexOf(id) === i);
    return seriesById(inSeries.slice(0, 5));
  }

  /** Why the token cannot work, when that is plain from the start. */
  return { lookup, cover, series, seriesOf, problem: unusable };
}
