// The books a series lacks, and where they go. The library shows them as dashed outlines in their
// place: from the numbers of the books it has, and from what Hardcover lists for the series when
// the server can ask it (GET /api/series/:id/missing).

// Past this many, a series is numbered some other way than book after book (by year, say).
const MAX_GAPS = 50;

const highest = (positions) => Math.max(0, ...positions.filter((p) => p != null));

/**
 * The whole numbers below the highest of `positions` that none of them is: [3] for 1, 2 and 4, and
 * [2, 3, 4] for 1 and 4.5. Null when there are too many to be gaps.
 * @param {Array<number|null>} positions the numbers of the books of a series in the library
 */
export function gaps(positions) {
  const held = new Set(positions);
  const top = highest(positions);
  const out = [];
  for (let n = 1; n < top; n++) {
    if (held.has(n)) continue;
    if (out.length === MAX_GAPS) return null;
    out.push(n);
  }
  return out;
}

/**
 * The books of a series to show as missing, in order: those Hardcover lists when it knows the series
 * (`answer.series`), else the gaps in the numbers, which have only a number. With `all` (the series'
 * own page) every book Hardcover lists; otherwise, as with the gaps, those numbered from 1 to below
 * the highest book the library has.
 * @param {Array<number|null>} positions the numbers of the books of the series in the library
 * @param {{series: object|null, missing: object[]}|null|undefined} answer from GET /api/series/:id/missing
 * @returns {Array<{position: number, title?: string, author?: string, upcoming?: boolean, url?: string}>}
 */
export function missingBooks(positions, answer, { all = false } = {}) {
  if (!answer?.series) return (gaps(positions) ?? []).map((position) => ({ position }));
  const held = new Set(positions);
  const top = highest(positions);
  return answer.missing.filter((m) => !held.has(m.position) && (all || (m.position >= 1 && m.position < top)));
}

/** A series' books (each with its `position`) and the `missing` ones in between, in order. The missing ones come as { position, missing }. */
export function inOrder(items, missing) {
  return [...items, ...missing.map((m) => ({ position: m.position, missing: m }))]
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
}
