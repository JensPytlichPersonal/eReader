// The books of a series the library does not have, as Hardcover lists the series. The library shows
// them as dashed outlines in their place. Hardcover is asked for the series by its name, and the one
// taken is the one whose name and author, or titles, are the library's. When none is, the series is
// found through one of its books, since Hardcover can call it something else: the library's "Avatar"
// is Hardcover's "Forgotten Realms: Avatar". Hardcover allows 60 requests a minute, so the series are
// looked up one at a time, spaced out, and what a lookup found is kept for a day.
import { sameSeriesName, seriesKey } from './converters/series.js';
import { LookupError, sameAuthor, sameTitle } from './lookup.js';

/**
 * The series among `found` (from the catalogue's series() or seriesOf()) that is the library's, or
 * null. It is the library's when it has the name and an author or a title of the library's books
 * ("Harry Potter" by J.K. Rowling, whatever language the books are in), two of their titles under
 * any name, or one of the books under its number, title and author (Prince of Lies by James Lowder,
 * #4 of "Forgotten Realms: Avatar" and of the library's "Avatar"). A series without books is not taken.
 * @param {{name: string, books: Array<{title: string, author: string, position: number|null}>}} library the series in the library
 */
export function pickSeries(found, { name, books }) {
  let best = null;
  let most = 0;
  for (const s of found) {
    // An empty one would hide the gaps the library shows without Hardcover.
    if (!s.books.length) continue;
    const titles = books.filter((b) => s.books.some((e) => sameTitle(e.title, b.title))).length;
    const named = sameSeriesName(s.name, name);
    const authors = [s.author, ...s.books.map((e) => e.author)].filter(Boolean);
    const byAuthor = books.some((b) => b.author && authors.some((a) => sameAuthor(a, b.author)));
    const placed = books.some((b) => b.author && s.books.some((e) => e.position === b.position && sameTitle(e.title, b.title) && sameAuthor(e.author, b.author)));
    if (titles < 2 && !placed && !(named && (byAuthor || titles))) continue;
    const score = titles * 3 + (named ? 2 : 0) + (byAuthor ? 1 : 0);
    if (score > most) [best, most] = [s, score];
  }
  return best;
}

// The numbers a book holds: its own, and for a book holding several, such as an omnibus (1 to 3),
// every whole number in its range.
function numbers({ position, positionEnd }) {
  if (position == null) return [];
  const out = [position];
  for (let n = Math.ceil(position); n <= (positionEnd ?? position); n++) out.push(n);
  return out;
}

/**
 * The books of a catalogue's series the library lacks: the main ones (whole numbers, so not the
 * novellas at 1.5), where no book in the library holds the number or has the title.
 * @param {{books: Array<{position: number, title: string}>}} series
 * @param {Array<{title: string, position: number|null, positionEnd?: number|null}>} books the books of the series in the library
 */
export function missingBooks(series, books) {
  const held = new Set(books.flatMap(numbers));
  return series.books.filter((e) => Number.isInteger(e.position) && !held.has(e.position) && !books.some((b) => sameTitle(e.title, b.title)));
}

// The book a series is looked for through: the first of its main books with an author to tell it
// from other books of that title. An omnibus is left out: the books of a series as Hardcover gives
// them hold none.
const guide = (books) => books.find((b) => Number.isInteger(b.position) && b.positionEnd == null && b.title && b.author);

/**
 * @param {object} options
 * @param {{series: (name: string) => Promise<object[]>, seriesOf: (book: {title: string, author: string}) => Promise<object[]>}} options.catalogue Hardcover (see createHardcover())
 * @param {number} [options.interval] least time per request to Hardcover, in ms: a lookup starts this long after the one before for each request that one makes
 * @param {number} [options.keep] how long what Hardcover has under a name, or for a book, is kept, in ms
 * @param {number} [options.retry] how long a lookup that failed is not tried again, in ms
 */
export function createMissingBooks({ catalogue, interval = 1250, keep = 24 * 3600 * 1000, retry = 10 * 60 * 1000, log = console }) {
  const known = new Map(); // lookup key -> { at, found } or { at, error }
  const asking = new Map(); // lookup key -> the lookup under way
  let queue = Promise.resolve();
  let nextStart = 0;

  // One lookup at a time, each starting at least `interval` after the one before for every request
  // that one makes.
  function lookUp(ask, requests) {
    const run = queue.then(async () => {
      const wait = nextStart - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      nextStart = Date.now() + interval * requests;
      return ask();
    });
    queue = run.catch(() => {});
    return run;
  }

  /** What a lookup found, from the last day's when there was one. `what` names it in the log. */
  function cached(key, what, ask, requests) {
    const seen = known.get(key);
    if (seen && Date.now() - seen.at < (seen.error ? retry : keep)) return seen.error ? Promise.reject(seen.error) : Promise.resolve(seen.found);
    if (!asking.has(key)) {
      asking.set(key, lookUp(ask, requests).then((found) => {
        known.set(key, { at: Date.now(), found });
        return found;
      }, (err) => {
        // A catalogue that cannot be asked now is not asked again for a while.
        if (err instanceof LookupError) {
          known.set(key, { at: Date.now(), error: err });
          log.error?.(`[series] ${what}: ${err.message}`);
        }
        throw err;
      }).finally(() => asking.delete(key)));
    }
    return asking.get(key);
  }

  // Hardcover is asked for the series of that name, then for their books.
  const seriesNamed = (name) => cached(`name\n${seriesKey(name)}`, name, () => catalogue.series(name), 2);
  // Hardcover is asked for the book, then for its series, then for their books.
  const seriesWith = (name, { title, author }) => cached(`book\n${seriesKey(title)}\n${seriesKey(author)}`, `${name}, through "${title}"`,
    () => catalogue.seriesOf({ title, author }), 3);

  /**
   * The books of a series the library lacks, in order, and the Hardcover series they are from; none,
   * and null, when Hardcover has no series that fits.
   * @param {{name: string, books: Array<{title: string, author: string, position: number|null, positionEnd?: number|null}>}} library the series in the library
   * @returns {Promise<{series: {name: string, url: string}|null, missing: Array<{position: number, title: string, author: string, upcoming: boolean, url: string}>}>}
   */
  async function forSeries({ name, books }) {
    let s = pickSeries(await seriesNamed(name), { name, books });
    const book = s ? null : guide(books);
    if (book) s = pickSeries(await seriesWith(name, book), { name, books });
    return s ? { series: { name: s.name, url: s.url }, missing: missingBooks(s, books) } : { series: null, missing: [] };
  }

  return { forSeries };
}
