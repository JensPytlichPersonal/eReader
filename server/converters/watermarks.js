// Watermarks that download sites stamp into the books they hand out. OceanofPDF adds an
// "OceanofPDF.com" link to every chapter (and to the pages of its PDFs) and starts its
// file names with "_OceanofPDF.com_".

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
