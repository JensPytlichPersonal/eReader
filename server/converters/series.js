// Series and collections: which books belong together, and where each one goes in the order.
// Books carry this in different places: calibre's series and EPUB 3 collections in the OPF,
// calibre's series in PDF XMP metadata, Markdown front matter, and the title itself, e.g.
// "Leviathan Wakes (The Expanse Book 1)" (the only place MOBI files have for it).
import { parseXml, findAllLocal, findFirstLocal, attr, text } from './xml.js';

const MAX_NAME = 200;
const MAX_POSITION = 99999;

/** Tidies a series name: single spaces, no separators around it. '' when there is no name. */
export function cleanSeriesName(name) {
  return String(name ?? '').normalize('NFC').replace(/\s+/g, ' ')
    .replace(/^[\s,:;\-–—]+|[\s,:;\-–—]+$/g, '').slice(0, MAX_NAME).trim();
}

/** Two spellings of one series share this key: case, spacing, quotes and dashes do not matter. */
export function seriesKey(name) {
  return cleanSeriesName(name).normalize('NFKC').toLowerCase()
    .replace(/[‘’‛´`]/g, "'").replace(/[“”„]/g, '"').replace(/[‐‑‒–—―]/g, '-');
}

/** Looser still, for telling whether a title names the series a book already has: "Expanse" is "The Expanse". */
function looseKey(name) {
  return seriesKey(name).replace(/^(the|a|an|den|det|de|der|die|das|le|la|les|el|il) /, '').replace(/[\s-]seri(es|en)$/, '');
}

/** The name a series already has among `known` names ("Expanse" for "The Expanse"), else the name itself. */
export function knownSeriesName(name, known) {
  const clean = cleanSeriesName(name);
  return known.find((k) => seriesKey(k) === seriesKey(clean)) ?? known.find((k) => looseKey(k) === looseKey(clean)) ?? clean;
}

/** A place in a series: 3, "3", "03", "2.5" or "2,5". Anything else is null (no place). */
export function parsePosition(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= MAX_POSITION ? Math.round(value * 100) / 100 : null;
  const m = /^\s*(\d{1,5}(?:[.,]\d+)?)\s*$/.exec(String(value ?? ''));
  return m ? parsePosition(parseFloat(m[1].replace(',', '.'))) : null;
}

/**
 * A place in a series as { position }, or for a book holding several, such as an omnibus, a range
 * as { position, positionEnd }: "1-3", "1–3" or "1 - 3". A number as parsePosition() takes it, or
 * null when it is neither (a range must go up).
 */
export function parsePlace(value) {
  if (typeof value === 'number') {
    const position = parsePosition(value);
    return position == null ? null : { position };
  }
  const m = /^\s*(\d{1,5}(?:[.,]\d+)?)(?:\s*[-–—]\s*(\d{1,5}(?:[.,]\d+)?))?\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const position = parsePosition(m[1]);
  if (m[2] == null || position == null) return position == null ? null : { position };
  const end = parsePosition(m[2]);
  if (end == null || end < position) return null;
  return end > position ? { position, positionEnd: end } : { position };
}

// Where an entry puts its book: { position } (null for none), with positionEnd when it covers a range,
// given as "1-3" or as a positionEnd beside the position.
function placeOf(e) {
  const place = parsePlace(e?.position) ?? { position: null };
  const end = parsePosition(e?.positionEnd);
  return place.position != null && place.positionEnd == null && end > place.position ? { ...place, positionEnd: end } : place;
}

/** Merges entries naming the same series (first spelling wins) and drops nameless ones. */
export function uniqueSeries(entries) {
  const out = new Map();
  for (const e of entries || []) {
    const name = cleanSeriesName(e?.name);
    const key = seriesKey(name);
    if (!key) continue;
    const place = placeOf(e);
    const seen = out.get(key);
    if (!seen) out.set(key, { name, ...place });
    else if (seen.position == null) Object.assign(seen, place);
  }
  return [...out.values()];
}

// ---- series in titles ----

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const DIGITS = '\\d{1,5}(?:\\.\\d{1,2})?';
// A number, or for a book holding several, such as an omnibus, a range of them ("#1-3", "Books 1 – 3").
const NUM = `(${DIGITS}(?:\\s?[-–—]\\s?${DIGITS})?|[ivxlc]{1,7}|${NUMBER_WORDS.join('|')})`;
// Before the title itself, as in "The Expanse #1-3 - Omnibus", only without spaces: "#5 - 1066 and All That" is book 5.
const NUM_TIGHT = `(${DIGITS}(?:[-–—]${DIGITS})?|[ivxlc]{1,7}|${NUMBER_WORDS.join('|')})`;
// Words that introduce a number in a series, in the languages a household library is likely to hold,
// with their plurals, which introduce ranges ("Books 1-3", "Bind 1-3").
const VOLUME_WORDS = 'volumes?|vols?|parts?|pts?|no|nos|nr|numbers?|episodes?|del|dele|teile?|folgen?|deel|delen';
const BOOK_WORDS = 'books?|bks?|bind|bd|bog|bøger|bok|bøker|band|bände|buch|bücher|tomes?|tomos?|livres?|libros?|boek|boeken';
const SEP = '[\\s,:;\\-–—]';
const OF = '(?:of|in|from|i|af|fra|aus|von|de|du)';
const rx = (s) => new RegExp(s, 'iu');
// "The Expanse, Book 1", "The Expanse #1", "The Expanse Book 1 of 9"
const namedNumber = (words) => ({ re: rx(`^(.+?)(?:${SEP}+(?:${words})\\.?\\s*#?\\s*|${SEP}*#\\s*)${NUM}(?:\\s+(?:of|af|von)\\s+\\d+)?$`), name: 1, num: 2 });
// "Book 1 of The Expanse", "Bind 3 i Harry Potter-serien"
// Here the name is often descriptive ("in the Expanse series"), so "the" and "series" are dropped.
const numberOfName = (words) => ({ re: rx(`^(?:${words})\\.?\\s*#?\\s*${NUM}\\s+${OF}\\s+(.+)$`), name: 2, num: 1, descriptive: true });
const ANY_WORDS = `${BOOK_WORDS}|${VOLUME_WORDS}`;
const IN_BRACKETS = [namedNumber(ANY_WORDS), numberOfName(ANY_WORDS)];
// After a colon or dash, "Volume 2" and "Part 2" are too often part of the title itself.
const AFTER_COLON = [namedNumber(BOOK_WORDS), numberOfName(BOOK_WORDS)];
// "The Expanse 01 - Leviathan Wakes", "Discworld #5 - Sourcery", "Discworld, Book 5: Sourcery"
const LEADING = rx(`^([^:()\\[\\]]+?)(?:${SEP}+(?:${ANY_WORDS})\\.?\\s*#?\\s*${NUM_TIGHT}|${SEP}*#\\s*${NUM_TIGHT}|\\s+(0\\d{1,3}))\\s*(?:[:.]|\\s[-–—])\\s*(.+)$`);
const GENERIC = new Set(['book', 'volume', 'vol', 'part', 'issue', 'edition', 'chapter', 'episode', 'number', 'no', 'nr', 'bind', 'bog', 'del', 'band', 'teil', 'tome', 'series', 'serien']);

function romanValue(s) {
  const t = s.toUpperCase();
  if (!/^(C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(t)) return null;
  const val = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let n = 0;
  for (let i = 0; i < t.length; i++) n += val[t[i]] < (val[t[i + 1]] || 0) ? -val[t[i]] : val[t[i]];
  return n || null;
}

/** The place a number in a title gives: "3", "iv", "one", or a range such as "1-3". */
function numberValue(s) {
  const word = NUMBER_WORDS.indexOf(s.toLowerCase());
  if (word >= 0) return { position: word + 1 };
  if (/^\d/.test(s)) return parsePlace(s);
  const roman = romanValue(s);
  return roman == null ? null : { position: roman };
}

function seriesName(raw, descriptive = false) {
  const name = cleanSeriesName(descriptive ? String(raw).replace(/^the\s/, '').replace(/[\s-]seri(es|en)$/i, '') : raw);
  if (!/\p{L}/u.test(name) || /[()[\]]/.test(name) || name.length > 100 || GENERIC.has(seriesKey(name))) return null;
  return name;
}

function matchSeries(part, patterns) {
  for (const p of patterns) {
    const m = p.re.exec(part);
    if (!m) continue;
    const name = seriesName(m[p.name], p.descriptive);
    const place = numberValue(m[p.num]);
    if (name && place) return { name, ...place };
  }
  return null;
}

const hasText = (s) => /[\p{L}\p{N}]/u.test(s);

/**
 * Finds a series named in a title and returns the title without it, or null.
 * Only explicit forms count (a "#", or a word such as Book, Volume, Bind or Band before the
 * number), so titles like "Windows 10 (Python 3)" are left alone. An omnibus gives a range:
 * "(The Expanse, #1-3)" is positions 1 to 3.
 * @returns {{title: string, name: string, position: number, positionEnd?: number} | null}
 */
export function seriesFromTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // "Leviathan Wakes (The Expanse Book 1)", "[Afdeling Q, bind 1]"
  const bracket = /^(.*?\S)\s*[([]([^()[\]]+)[)\]]$/.exec(t);
  if (bracket && hasText(bracket[1])) {
    const found = matchSeries(bracket[2].trim(), IN_BRACKETS);
    if (found) return { title: bracket[1].trim(), ...found };
  }
  // "A Game of Thrones: A Song of Ice and Fire: Book One", "The Way of Kings: Book One of the Stormlight Archive"
  for (const sep of t.matchAll(/:\s|\s[-–—]\s/g)) {
    const head = t.slice(0, sep.index).trim();
    if (!hasText(head)) continue;
    // A closing remark such as "(now a TV series)" is not part of the series name.
    const tail = t.slice(sep.index + sep[0].length).replace(/\s*[([][^()[\]]*[)\]]$/, '').trim();
    const found = matchSeries(tail, AFTER_COLON);
    if (found) return { title: head, ...found };
  }
  const lead = LEADING.exec(t);
  if (lead && hasText(lead[5])) {
    const name = seriesName(lead[1]);
    const place = numberValue(lead[2] ?? lead[3] ?? lead[4]);
    if (name && place) return { title: lead[5].trim(), name, ...place };
  }
  return null;
}

/**
 * Completes a book's details with a series named in its title. The title loses that part when
 * it names the series the book is recorded in (or the book has none recorded), so
 * "Leviathan Wakes (The Expanse Book 1)" becomes "Leviathan Wakes" in The Expanse, #1.
 */
export function withTitleSeries(meta) {
  const series = uniqueSeries(meta.series);
  const found = seriesFromTitle(meta.title);
  if (!found) return { ...meta, series };
  const { title, name, ...place } = found;
  if (!series.length) return { ...meta, title, series: [{ name, ...place }] };
  const same = series.find((s) => looseKey(s.name) === looseKey(name));
  if (!same) return { ...meta, series };
  if (same.position == null) Object.assign(same, place);
  return { ...meta, title, series };
}

// ---- series in package metadata ----

/** Values of EPUB 3 <meta refines="#id" property="..."> elements, by the id they refine. */
function refinements(metas) {
  const out = new Map();
  for (const m of metas) {
    const ref = attr(m, 'refines');
    const prop = (attr(m, 'property') || '').toLowerCase();
    if (!ref || !prop) continue;
    const id = ref.replace(/^#/, '');
    if (!out.has(id)) out.set(id, {});
    out.get(id)[prop] ??= text(m);
  }
  return out;
}

const TITLE_TYPES_NOT_MAIN = new Set(['collection', 'edition', 'subtitle', 'short', 'expanded']);

/**
 * Reads the title and series from an OPF <metadata> element: calibre's series fields, EPUB 3
 * collections (series and sets) and EPUB 3 collection titles.
 * @returns {{title: string, series: Array<{name: string, position: number|null, positionEnd?: number}>}}
 */
export function opfTitleAndSeries(metadata) {
  const metas = findAllLocal(metadata, 'meta');
  const refines = refinements(metas);
  const titles = findAllLocal(metadata, 'title');
  const titleType = (el) => (refines.get(attr(el, 'id'))?.['title-type'] || '').toLowerCase();
  const main = titles.find((t) => titleType(t) === 'main') || titles.find((t) => !TITLE_TYPES_NOT_MAIN.has(titleType(t))) || titles[0];

  const series = [];
  const sets = [];
  for (const m of metas) {
    if ((attr(m, 'property') || '').toLowerCase() !== 'belongs-to-collection' || attr(m, 'refines')) continue;
    const props = refines.get(attr(m, 'id')) || {};
    const entry = { name: text(m), position: props['group-position'] };
    if ((props['collection-type'] || '').toLowerCase() === 'set') sets.push(entry); else series.push(entry);
  }
  const named = (n) => attr(metas.find((m) => (attr(m, 'name') || '').toLowerCase() === n), 'content');
  if (named('calibre:series')) series.push({ name: named('calibre:series'), position: named('calibre:series_index') });
  for (const t of titles) if (titleType(t) === 'collection') sets.push({ name: text(t), position: null });
  return { title: main ? text(main) : '', series: uniqueSeries([...series, ...sets]) };
}

/** calibre's series in PDF XMP: <calibre:series><rdf:value>…</rdf:value><calibreSI:series_index>…</calibreSI:series_index></calibre:series> */
export function seriesFromXmp(xmp) {
  if (!xmp || !/calibre-ebook\.com/i.test(xmp)) return [];
  const doc = parseXml(xmp);
  const namespaceOf = (el) => {
    const prefix = (el.name || '').includes(':') ? el.name.split(':')[0] : '';
    for (let e = el; e; e = e.parent) {
      const ns = e.attribs?.[prefix ? `xmlns:${prefix}` : 'xmlns'];
      if (ns) return ns;
    }
    return '';
  };
  const out = [];
  for (const el of findAllLocal(doc, 'series')) {
    if (!/calibre-ebook\.com\/xmp-namespace\/?$/.test(namespaceOf(el))) continue;
    const value = findFirstLocal(el, 'value');
    const index = findFirstLocal(el, 'series_index');
    out.push({ name: value ? text(value) : text(el), position: index ? text(index) : null });
  }
  return uniqueSeries(out);
}

/** Markdown front matter: "series:" (or "collection:") with "series_index:" (or "volume:"). */
export function seriesFromFrontMatter(meta) {
  let name = meta.series || meta.collection || '';
  const list = /^\[(.*)\]$/.exec(name);
  if (list) name = list[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
  const position = meta.series_index ?? meta['series-index'] ?? meta.series_number ?? meta['series-number'] ?? meta.volume;
  return uniqueSeries([{ name, position }]);
}
