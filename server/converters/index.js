import { convertEpub, readEpubMetadata } from './epub.js';
import { convertMobi, readMobiMetadata } from './mobi.js';
import { convertMarkdown, readMarkdownMetadata } from './markdown.js';
import { convertText } from './text.js';
import { convertPdf, readPdfMetadata } from './pdf.js';
import { isMobi } from './mobi-codec.js';
import { titleFromFilename } from './bundle.js';
import { withTitleSeries } from './series.js';

export const SUPPORTED_EXTENSIONS = ['epub', 'mobi', 'prc', 'azw', 'azw3', 'kf8', 'pdf', 'md', 'markdown', 'txt', 'text'];

export function detectFormat(filename, buffer) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (buffer && buffer.length > 4) {
    if (buffer.toString('latin1', 0, 4) === '%PDF') return 'pdf';
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && (ext === 'epub' || buffer.includes('META-INF/container.xml', 0, 'latin1') || buffer.includes('mimetypeapplication/epub+zip', 0, 'latin1'))) return 'epub';
    if (isMobi(buffer)) return 'mobi';
  }
  if (ext === 'epub') return 'epub';
  if (['mobi', 'prc', 'azw', 'azw3', 'kf8'].includes(ext)) return 'mobi';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'txt' || ext === 'text' || ext === '') return 'txt';
  return null;
}

async function convertFormat(buffer, { filename }) {
  const format = detectFormat(filename, buffer);
  switch (format) {
    case 'epub': return convertEpub(buffer, { filename });
    case 'mobi': return convertMobi(buffer, { filename });
    case 'pdf': return convertPdf(buffer, { filename });
    case 'md': return convertMarkdown(buffer, { filename });
    case 'txt': return convertText(buffer, { filename });
    default: throw new Error(`Unsupported file type: ${filename}`);
  }
}

/** Converts a book. `meta.series` lists the series and collections it belongs to: [{name, position}]. */
export async function convert(buffer, { filename }) {
  const book = await convertFormat(buffer, { filename });
  return { ...book, meta: withTitleSeries(book.meta) };
}

/**
 * Reads a book's details (title, author, language, series) without converting it. The series
 * are the ones its metadata names; a series named in the title is left to withTitleSeries.
 */
export async function readMetadata(buffer, { filename }) {
  switch (detectFormat(filename, buffer)) {
    case 'epub': return readEpubMetadata(buffer, { filename });
    case 'mobi': return readMobiMetadata(buffer, { filename });
    case 'pdf': return readPdfMetadata(buffer, { filename });
    case 'md': return readMarkdownMetadata(buffer, { filename });
    case 'txt': return { title: titleFromFilename(filename), author: '', language: '', format: 'txt' };
    default: throw new Error(`Unsupported file type: ${filename}`);
  }
}
