// ISBNs in book files. EPUB packages record them as dc:identifier (the e-book) and sometimes
// dc:source (the printed book); MOBI files in EXTH record 104. Used to look a book up exactly.

// "urn:isbn:", "isbn:", "ISBN ", "ISBN-13: " in front of the number.
const MARKER = /^(?:urn:)?isbn(?:[-\s]?1[03])?(?:\s*:\s*|\s+)/i;

function validIsbn13(d) {
  if (!/^97[89]\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(d[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

function validIsbn10(d) {
  if (!/^\d{9}[\dX]$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (d[i] === 'X' ? 10 : Number(d[i])) * (10 - i);
  return sum % 11 === 0;
}

function isbn10To13(d) {
  const body = `978${d.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
  return body + ((10 - (sum % 10)) % 10);
}

/**
 * The ISBN in an identifier such as "978-0-316-12908-4", "urn:isbn:0316129089" or "ISBN 0 316 12908 9",
 * as 13 digits, or null. Ten-digit ISBNs only count when the identifier says it is an ISBN (a marker
 * such as "urn:isbn:", or `isbn` set by the caller), since other identifiers can pass for one.
 */
export function readIsbn(value, { isbn = false } = {}) {
  let s = String(value ?? '').trim();
  const marked = MARKER.test(s);
  s = s.replace(MARKER, '');
  const digits = (/^[\dXx][\dXx\s-]*/.exec(s)?.[0] || '').replace(/[\s-]/g, '').toUpperCase();
  if (validIsbn13(digits)) return digits;
  if ((isbn || marked) && validIsbn10(digits)) return isbn10To13(digits);
  return null;
}

/** The distinct ISBNs among identifiers: [{ value, isbn }] in order of preference. */
export function uniqueIsbns(identifiers) {
  return [...new Set(identifiers.map(({ value, isbn }) => readIsbn(value, { isbn })).filter(Boolean))];
}
