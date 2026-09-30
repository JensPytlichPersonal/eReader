// The books a series lacks, and where they go. The library shows them as dashed outlines in their
// place: from the numbers of the books it has, and from what Hardcover lists for the series when
// the server can ask it (GET /api/series/:id/missing). A book's place is { position, positionEnd },
// the second ending the range of a book holding several, such as an omnibus (#1–3). An admin can
// remove one shown wrongly: `removed` has the numbers at which none shows (see removedMissing in
// GET /api/books).

// Past this many, a series is numbered some other way than book after book (by year, say).
const MAX_GAPS = 50;

/** The numbers the books hold: each its own, and a book holding several every whole number in its range. */
function held(places) {
  const out = new Set();
  for (const { position, positionEnd } of places) {
    if (position == null) continue;
    out.add(position);
    for (let n = Math.ceil(position); n <= (positionEnd ?? position); n++) out.add(n);
  }
  return out;
}

const highest = (places) => Math.max(0, ...places.map((p) => p.positionEnd ?? p.position ?? 0));

/**
 * The whole numbers below the highest the books hold that none of them holds: 3 for #1, #2 and #4,
 * 2 to 4 for #1 and #4.5, none for #1–3 and #4. Null when there are too many to be gaps. The numbers
 * in `removed` are left out.
 * @param {Array<{position: number|null, positionEnd?: number|null}>} places the books of a series in the library
 * @param {{removed?: number[]}} [options]
 */
export function gaps(places, { removed = [] } = {}) {
  const have = held(places);
  const gone = new Set(removed);
  const top = highest(places);
  const out = [];
  for (let n = 1; n < top; n++) {
    if (have.has(n) || gone.has(n)) continue;
    if (out.length === MAX_GAPS) return null;
    out.push(n);
  }
  return out;
}

/**
 * The books of a series to show as missing, in order: those Hardcover lists when it knows the series
 * (`answer.series`), else the gaps in the numbers, which have only a number. With `all` (the series'
 * own page) every book Hardcover lists; otherwise, as with the gaps, those numbered from 1 to below
 * the highest book the library has. None at the numbers in `removed`.
 * @param {Array<{position: number|null, positionEnd?: number|null}>} places the books of the series in the library
 * @param {{series: object|null, missing: object[]}|null|undefined} answer from GET /api/series/:id/missing
 * @param {{all?: boolean, removed?: number[]}} [options]
 * @returns {Array<{position: number, title?: string, author?: string, upcoming?: boolean, url?: string}>}
 */
export function missingBooks(places, answer, { all = false, removed = [] } = {}) {
  if (!answer?.series) return (gaps(places, { removed }) ?? []).map((position) => ({ position }));
  const have = held(places);
  const gone = new Set(removed);
  const top = highest(places);
  return answer.missing.filter((m) => !have.has(m.position) && !gone.has(m.position) && (all || (m.position >= 1 && m.position < top)));
}

/**
 * A series' books (each with its place) and the `missing` ones in between, in order, a book holding
 * several after the books it holds, as the library sorts them: #1, #2, #3, #1–3, #4. The missing ones
 * come as { position, missing }.
 */
export function inOrder(items, missing) {
  const last = (i) => i.positionEnd ?? i.position ?? Infinity;
  return [...items, ...missing.map((m) => ({ position: m.position, missing: m }))]
    .sort((a, b) => last(a) - last(b) || (b.position ?? 0) - (a.position ?? 0));
}
