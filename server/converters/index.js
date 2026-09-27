import { convertEpub } from './epub.js';
import { convertMobi } from './mobi.js';
import { convertMarkdown } from './markdown.js';
import { convertText } from './text.js';
import { convertPdf } from './pdf.js';
import { isMobi } from './mobi-codec.js';

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

export async function convert(buffer, { filename }) {
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
