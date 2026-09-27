import { normalizeDocument } from './html.js';
import { assembleSections, titleFromFilename } from './bundle.js';

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function decodeText(buffer) {
  // UTF-8 with BOM, UTF-16 BOMs, otherwise UTF-8 falling back to latin1 when invalid.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const utf8 = buffer.toString('utf8');
  if (utf8.includes('�')) {
    const bad = (utf8.match(/�/g) || []).length;
    if (bad > 2 && bad / utf8.length > 0.0005) return buffer.toString('latin1');
  }
  return utf8.replace(/^﻿/, '');
}

/** Converts plain text into paragraphs, detecting hard-wrapped text (e.g. Project Gutenberg). */
export function textToHtml(text) {
  const norm = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const lines = norm.split('\n');
  // Detect hard wrapping: many lines of similar length that do not end in sentence punctuation.
  const nonEmpty = lines.filter((l) => l.trim());
  const longish = nonEmpty.filter((l) => l.length > 50 && l.length < 100).length;
  const hardWrapped = nonEmpty.length > 20 && longish / nonEmpty.length > 0.5;
  const blocks = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const joined = hardWrapped ? para.map((l) => l.trim()).join(' ') : para.join('\n');
    blocks.push(joined);
    para = [];
  };
  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    if (!hardWrapped) { flush(); para.push(line); continue; }
    para.push(line);
  }
  flush();
  const html = [];
  for (const b of blocks) {
    const trimmed = b.trim();
    if (!trimmed) continue;
    const isHeading = trimmed.length < 80 && !/[.,;:]$/.test(trimmed) &&
      (/^(chapter|part|book|prologue|epilogue|section)\b/i.test(trimmed) || (/^[A-Z0-9 .,'"!?:;-]+$/.test(trimmed) && /[A-Z]{2}/.test(trimmed)));
    if (isHeading) html.push(`<h2>${escape(trimmed)}</h2>`);
    else if (/^\s{4,}/.test(b) || (!hardWrapped && b.includes('\n') && /^\s/.test(b))) html.push(`<pre>${escape(b)}</pre>`);
    else html.push(`<p>${escape(trimmed).replace(/\n/g, '<br/>')}</p>`);
  }
  return html.join('\n');
}

export async function convertText(buffer, { filename }) {
  const text = decodeText(buffer);
  const body = textToHtml(text);
  const { root } = normalizeDocument(`<body>${body}</body>`);
  const { sections, toc } = assembleSections([{ root, key: 'text' }]);
  // First heading often is the title of the book.
  const title = titleFromFilename(filename);
  return { meta: { title, author: '', language: '', format: 'txt' }, sections, toc };
}
