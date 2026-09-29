// Watermarks that download sites stamp into the books they hand out. OceanofPDF adds an
// "OceanofPDF.com" link to every chapter (and to the pages of its PDFs) and starts its
// file names with "_OceanofPDF.com_". Credit lines at the start of a book are further down.

// Some PDFs space the letters out ("O c e a n o f P D F . c o m").
const TEXT_RE = /(?:https?:\/\/)?(?:www\.)?o\s*c\s*e\s*a\s*n\s*o\s*f\s*p\s*d\s*f\s*\.\s*c\s*o\s*m\b\/?/i;
// Starts only where a whitespace run starts, which keeps long runs of spaces linear to scan.
const STRIP_RE = new RegExp(`(?<!\\s)\\s*${TEXT_RE.source}`, 'gi');
const LINK_RE = /^https?:\/\/(?:www\.)?oceanofpdf\.com(?:[/?#:]|$)/i;

export function hasWatermark(text) {
  return TEXT_RE.test(text);
}

/** Remove every watermark along with the whitespace in front of it. */
export function stripWatermarks(text) {
  return text.replace(STRIP_RE, '');
}

/** True for text that is nothing but watermarks, such as a PDF line reading "OceanofPDF.com". */
export function isWatermark(text) {
  return hasWatermark(text) && !stripWatermarks(text).trim();
}

export function isWatermarkLink(href) {
  return LINK_RE.test(href);
}

// Credit lines that scanners and download sites put at the start of the books they pass round, such as
// "Formatted by X Exclusively for Demonoid.com" or "Scanned & proofed by Y". Only a whole short paragraph
// counts, among the first CREDIT_REACH paragraphs of a book (see removeCreditLines in html.js): further in,
// or run into other text, such words are the book's own.
export const CREDIT_REACH = 20;
const CREDIT_MAX = 200;
// "Scanned by", "Scanned & proofed by", "Scanned, proofed and formatted by". Not "Translated by" or "Edited
// by": those name the people who made the book.
const CREDIT_WORD = '(?:scanned|proofed|proof-?read|(?:re-?)?formatted|converted|uploaded)';
const CREDIT_START_RE = new RegExp(`^[\\p{P}\\p{S}\\s]*${CREDIT_WORD}(?:\\s*(?:,|&|\\+|/|\\band\\b)\\s*(?:and\\s+)?${CREDIT_WORD})*\\s+by\\b`, 'iu');
// Download sites that sign the books they hand out.
const CREDIT_SITE_RE = /demonoid|\bz-lib(?:rary)?\b|\blibgen\b|\blibrary genesis\b/i;

/** True for a paragraph that is only a credit line of a scanner or a download site (it must also be near the start). */
export function isCreditLine(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length < CREDIT_MAX && (CREDIT_START_RE.test(t) || CREDIT_SITE_RE.test(t));
}
