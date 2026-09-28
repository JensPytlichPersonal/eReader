// Finds a book's details in the catalogues the server can reach: Hardcover (hardcover.app) when a
// token for it is set, and Open Library (openlibrary.org), which needs none. Both are asked at once,
// and a book found in both is offered once.

/** A lookup a catalogue could not answer. The message can be shown as it is. */
export class LookupError extends Error {}

// Catalogues ask applications to say who they are.
export const USER_AGENT = 'eReader (self-hosted e-reader)';
const SHOWN = 5;

// Too common to tell two titles apart: "The Hunted" is nothing like "The Encyclopedia of Arcade Video Games".
const COMMON = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with', 'af', 'de', 'den', 'det', 'en', 'et', 'i', 'med', 'og', 'på', 'til']);

/** The words that tell a title or name apart; all of them when there is nothing else ("It"). */
function words(s) {
  const all = String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const telling = all.filter((w) => !COMMON.has(w));
  return new Set(telling.length ? telling : all);
}

/** How alike two titles are, from 0 (no word in common) to 1 (the same words). */
export function likeness(a, b) {
  const x = words(a);
  const y = words(b);
  let same = 0;
  for (const w of x) if (y.has(w)) same++;
  return same ? same / (x.size + y.size - same) : 0;
}

// Titles this alike name the same book.
const SAME_TITLE = 0.8;

/** Whether two titles name the same book: "Dune" and "Dune Messiah" do not. */
export function sameTitle(a, b) {
  return likeness(a, b) >= SAME_TITLE;
}

/** Whether two authors share a name: "Adler-Olsen, Jussi" and "Jussi Adler-Olsen". Initials do not count. */
export function sameAuthor(a, b) {
  const x = words(a);
  return [...words(b)].some((w) => w.length > 1 && x.has(w));
}

/**
 * The matches worth offering, best first: those found by the file's ISBN, then the titles closest to
 * the one typed. When some share words with it, those that share none are left out. A book sharing no
 * word with the title is only offered when nothing else is and it has the author typed (a translation
 * under another title).
 */
export function rankMatches(found, { title = '', author = '' }, limit = SHOWN) {
  const seen = new Set();
  const ranked = found
    .filter((m) => !seen.has(m.key) && seen.add(m.key))
    .map((m, i) => ({ m, i, score: m.byIsbn ? 2 : likeness(m.title, title) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  // A loose search finds books with those words anywhere, even in their subjects: on Open Library
  // "Omega Force: Hunted" turns up an encyclopedia of arcade games.
  const close = ranked[0]?.score > 0;
  return ranked.filter((r) => r.score > 0 || (!close && sameAuthor(r.m.author, author))).slice(0, limit).map((r) => r.m);
}

/**
 * @param {object} catalogues each with lookup(book) and cover(id); `hardcover` is null without a token
 */
export function createLookup({ openLibrary, hardcover = null }) {
  // Asked in this order, so a book both have comes from Hardcover, which knows series better.
  const catalogues = Object.entries({ hardcover, openlibrary: openLibrary }).filter(([, c]) => c);

  /**
   * Matches from every catalogue, best first, and what went wrong with those that did not answer.
   * @returns {Promise<{results: object[], problems: string[]}>}
   */
  async function lookup(book) {
    const answers = await Promise.allSettled(catalogues.map(([, c]) => c.lookup(book)));
    const found = [];
    const problems = [];
    for (const answer of answers) {
      if (answer.status === 'fulfilled') found.push(...answer.value);
      else if (answer.reason instanceof LookupError) problems.push(answer.reason.message);
      else throw answer.reason;
    }
    if (problems.length === catalogues.length) throw new LookupError(problems.join(' '));
    // A book in both catalogues is offered once, where the better match of the two ranks: as the
    // catalogue asked first has it, with a series or cover only the other has.
    const order = (m) => catalogues.findIndex(([name]) => name === m.source);
    const results = [];
    for (const m of rankMatches(found, book, found.length)) {
      const i = results.findIndex((r) => r.source !== m.source && likeness(r.title, m.title) === 1 && sameAuthor(r.author, m.author));
      if (i < 0) {
        results.push(m);
        continue;
      }
      const [main, other] = order(m) < order(results[i]) ? [m, results[i]] : [results[i], m];
      results[i] = {
        ...main,
        series: main.series.length ? main.series : other.series,
        ...(main.cover ? {} : { cover: other.cover, coverSource: other.coverSource, coverId: other.coverId }),
        byIsbn: main.byIsbn || other.byIsbn,
      };
    }
    return { results: results.slice(0, SHOWN), problems };
  }

  return {
    lookup,
    /** The catalogues this server asks: 'hardcover' and 'openlibrary'. */
    sources: catalogues.map(([name]) => name),
    /** The large picture of a match's cover (its coverSource and coverId). */
    cover: (source, id) => catalogues.find(([name]) => name === source)[1].cover(id),
  };
}
