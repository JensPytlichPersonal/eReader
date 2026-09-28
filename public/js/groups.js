// The library's Group by menu: books in sections by author or by genre. A book by several authors goes
// under each of them, and a series shown as one goes under its lead author or its main genre. Authors
// are compared loosely and sorted by surname, so "Herbert, Frank" is "Frank Herbert", under H.

// The words of a name: case, accents and punctuation aside.
const words = (s) => String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/** One author written in different ways shares this key: "Herbert, Frank" is "Frank Herbert". */
export const authorKey = (name) => words(name).sort().join(' ');

/** One genre written in different ways shares this key: "fantasy" is "Fantasy". */
export const genreKey = (name) => String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  .replace(/[‘’‛´`]/g, "'").replace(/[‐‑‒–—―]/g, '-');

// A part of an author line that is a name of its own: two words or more ("Neil Gaiman"), and not given
// names ending in an initial, as in "Le Guin, Ursula K.".
const wholeName = (s) => s.split(' ').length > 1 && !/(^|\s)\p{L}\.?$/u.test(s);

/**
 * The authors in a book's author line. Files name several as "Terry Pratchett, Neil Gaiman", with "&",
 * "and" or ";" between them, and a name surname first as "Herbert, Frank". So ";" always parts two
 * authors, and "&", "and" and "," do when each part is a name of its own (see wholeName()). [] for none.
 */
export function authorNames(line) {
  let names = String(line || '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const separator of [/\s*&\s*|\s+and\s+/i, /\s*,\s*/]) {
    names = names.flatMap((name) => {
      const parts = name.split(separator).filter(Boolean);
      return parts.length > 1 && parts.every(wholeName) ? parts : [name];
    });
  }
  // One author named twice counts once, as first written.
  const once = new Map();
  for (const name of names) if (!once.has(authorKey(name) || name)) once.set(authorKey(name) || name, name);
  return [...once.values()];
}

const SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;

/** The name an author is sorted by: "Herbert" for "Frank Herbert" and for "Herbert, Frank". */
export function surname(name) {
  const comma = name.indexOf(',');
  const given = comma < 0 ? '' : name.slice(comma + 1).trim();
  if (comma > 0 && given && !SUFFIX.test(given)) return name.slice(0, comma).trim();
  const parts = (comma < 0 ? name : name.slice(0, comma)).trim().split(/\s+/);
  while (parts.length > 1 && SUFFIX.test(parts.at(-1))) parts.pop();
  return parts.at(-1) || '';
}

const byAuthor = (name) => `${surname(name)} ${name}`;
const orders = new Map();

/** Where a book goes in the Author order: by its first author's surname. '' for none. */
export function authorOrder(line) {
  if (!orders.has(line)) {
    const [first] = authorNames(line);
    orders.set(line, first ? byAuthor(first) : '');
  }
  return orders.get(line);
}

/** The spelling most of these share (a Map of spelling -> count); on a tie, one without a comma ("Frank Herbert"), else the first. */
function spelling(spellings) {
  let best = '';
  let most = 0;
  for (const [name, n] of spellings) {
    if (n > most || (n === most && best.includes(',') && !name.includes(','))) [best, most] = [name, n];
  }
  return best;
}

/**
 * The name most of `names` share, as `keyOf` tells names apart, spelled the way most of them spell it:
 * the lead author of a series, or its main genre. The first of them wins a tie; '' when none has a name.
 */
export function mostCommon(names, keyOf) {
  const counts = new Map();
  for (const name of names) {
    if (!name) continue;
    const key = keyOf(name) || name;
    if (!counts.has(key)) counts.set(key, { n: 0, spellings: new Map() });
    const c = counts.get(key);
    c.n++;
    c.spellings.set(name, (c.spellings.get(name) || 0) + 1);
  }
  let top = null;
  for (const c of counts.values()) if (!top || c.n > top.n) top = c;
  return top ? spelling(top.spellings) : '';
}

/**
 * Things in sections by the names `namesOf(thing)` gives them, `by` 'author' or 'genre': a thing goes
 * under each of its names, and under '' when it has none. Returns [{ name, items }], each section named
 * as most of its things spell it, authors in order of surname and genres alphabetically, with '' last.
 * The things keep their order within a section.
 */
export function sections(things, namesOf, by) {
  const keyOf = by === 'author' ? authorKey : genreKey;
  const found = new Map();
  for (const thing of things) {
    const names = namesOf(thing).filter(Boolean);
    for (const name of names.length ? names : ['']) {
      const key = name && (keyOf(name) || name);
      if (!found.has(key)) found.set(key, { spellings: new Map(), items: new Set() });
      const s = found.get(key);
      s.spellings.set(name, (s.spellings.get(name) || 0) + 1);
      s.items.add(thing);
    }
  }
  const order = by === 'author' ? byAuthor : (name) => name;
  return [...found.values()]
    .map((s) => ({ name: spelling(s.spellings), items: [...s.items] }))
    .sort((a, b) => !a.name - !b.name || order(a.name).localeCompare(order(b.name)));
}
