// The books of a series the library does not have, as Hardcover lists the series. The library shows
// them as dashed outlines in their place. Hardcover is asked for the series by its name, and the one
// taken is the one whose name and author, or titles, are the library's. Hardcover allows 60 requests
// a minute, so the series are looked up one at a time, spaced out, and what a lookup found is kept
// for a day.
import { sameSeriesName, seriesKey } from './converters/series.js';
import { LookupError, likeness, sameAuthor } from './lookup.js';

// Titles this alike name the same book: "Dune" and "Dune Messiah" do not.
const SAME_TITLE = 0.8;

const sameTitle = (a, b) => likeness(a, b) >= SAME_TITLE;

/**
 * The series among `found` (from the catalogue's series()) that is the library's, or null. It is
 * the library's when it has the name and an author or a title of the library's books ("Harry Potter"
 * by J.K. Rowling, whatever language the books are in), or two of their titles under any name.
 * @param {{name: string, books: Array<{title: string, author: string}>}} library the series in the library
 */
export function pickSeries(found, { name, books }) {
  let best = null;
  let most = 0;
  for (const s of found) {
    const titles = books.filter((b) => s.books.some((e) => sameTitle(e.title, b.title))).length;
    const named = sameSeriesName(s.name, name);
    const authors = [s.author, ...s.books.map((e) => e.author)].filter(Boolean);
    const byAuthor = books.some((b) => b.author && authors.some((a) => sameAuthor(a, b.author)));
    if (titles < 2 && !(named && (byAuthor || titles))) continue;
    const score = titles * 3 + (named ? 2 : 0) + (byAuthor ? 1 : 0);
    if (score > most) [best, most] = [s, score];
  }
  return best;
}

/**
 * The books of a catalogue's series the library lacks: the main ones (whole numbers, so not the
 * novellas at 1.5), where no book in the library has the number or the title.
 * @param {{books: Array<{position: number, title: string}>}} series
 * @param {Array<{title: string, position: number|null}>} books the books of the series in the library
 */
export function missingBooks(series, books) {
  const held = new Set(books.map((b) => b.position));
  return series.books.filter((e) => Number.isInteger(e.position) && !held.has(e.position) && !books.some((b) => sameTitle(e.title, b.title)));
}

/**
 * @param {object} options
 * @param {{series: (name: string) => Promise<object[]>}} options.catalogue Hardcover (see createHardcover())
 * @param {number} [options.interval] least time between the starts of two lookups, in ms; each asks Hardcover twice
 * @param {number} [options.keep] how long what Hardcover has under a name is kept, in ms
 * @param {number} [options.retry] how long a lookup that failed is not tried again, in ms
 */
export function createMissingBooks({ catalogue, interval = 2500, keep = 24 * 3600 * 1000, retry = 10 * 60 * 1000, log = console }) {
  const known = new Map(); // series key -> { at, found } or { at, error }
  const asking = new Map(); // series key -> the lookup under way
  let queue = Promise.resolve();
  let nextStart = 0;

  // One lookup at a time, each starting at least `interval` after the one before.
  function lookUp(name) {
    const run = queue.then(async () => {
      const wait = nextStart - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      nextStart = Date.now() + interval;
      return catalogue.series(name);
    });
    queue = run.catch(() => {});
    return run;
  }

  /** The series Hardcover has under a name, from the last day's lookup when there was one. */
  function seriesNamed(name) {
    const key = seriesKey(name);
    const seen = known.get(key);
    if (seen && Date.now() - seen.at < (seen.error ? retry : keep)) return seen.error ? Promise.reject(seen.error) : Promise.resolve(seen.found);
    if (!asking.has(key)) {
      asking.set(key, lookUp(name).then((found) => {
        known.set(key, { at: Date.now(), found });
        return found;
      }, (err) => {
        // A catalogue that cannot be asked now is not asked again for a while.
        if (err instanceof LookupError) {
          known.set(key, { at: Date.now(), error: err });
          log.error?.(`[series] ${name}: ${err.message}`);
        }
        throw err;
      }).finally(() => asking.delete(key)));
    }
    return asking.get(key);
  }

  /**
   * The books of a series the library lacks, in order, and the Hardcover series they are from; none,
   * and null, when Hardcover has no series that fits.
   * @param {{name: string, books: Array<{title: string, author: string, position: number|null}>}} library the series in the library
   * @returns {Promise<{series: {name: string, url: string}|null, missing: Array<{position: number, title: string, author: string, upcoming: boolean, url: string}>}>}
   */
  async function forSeries({ name, books }) {
    const s = pickSeries(await seriesNamed(name), { name, books });
    return s ? { series: { name: s.name, url: s.url }, missing: missingBooks(s, books) } : { series: null, missing: [] };
  }

  return { forSeries };
}
