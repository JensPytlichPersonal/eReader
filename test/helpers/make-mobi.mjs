// Builds a small MOBI7 file (PalmDOC compressed, EXTH, image record, trailing entries) for tests.
import { TINY_PNG } from './zipwriter.mjs';

export function palmdocCompress(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    let bestLen = 0;
    let bestDist = 0;
    for (let dist = 1; dist <= Math.min(2047, i); dist++) {
      let len = 0;
      while (len < 10 && i + len < data.length && data[i + len - dist] === data[i + len]) len++;
      if (len > bestLen) { bestLen = len; bestDist = dist; if (len === 10) break; }
    }
    if (bestLen >= 3) {
      const w = 0x8000 | (bestDist << 3) | (bestLen - 3);
      out.push(w >> 8, w & 0xff);
      i += bestLen;
      continue;
    }
    const c = data[i];
    if (c === 0x20 && i + 1 < data.length && data[i + 1] >= 0x40 && data[i + 1] <= 0x7f) { out.push(data[i + 1] ^ 0x80); i += 2; continue; }
    if (c === 0 || (c >= 9 && c < 0x80)) { out.push(c); i++; continue; }
    let run = 0;
    while (run < 8 && i + run < data.length && (data[i + run] >= 0x80 || (data[i + run] >= 1 && data[i + run] <= 8))) run++;
    out.push(run, ...data.subarray(i, i + run));
    i += run;
  }
  return Buffer.from(out);
}

function exthRecord(type, data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const b = Buffer.alloc(8 + d.length);
  b.writeUInt32BE(type, 0); b.writeUInt32BE(8 + d.length, 4); d.copy(b, 8);
  return b;
}

// `exth` adds EXTH records: [[type, data], ...], e.g. [[104, '9780316129084']] for an ISBN.
export function makeMobi({ html, title = 'Mobi Fixture', author = 'Mobi Author', compress = true, trailing = true, images = [TINY_PNG], exth: extra = [] } = {}) {
  const text = Buffer.from(html, 'utf8');
  const recSize = 4096;
  const textRecords = [];
  for (let i = 0; i < text.length; i += recSize) {
    const chunk = text.subarray(i, i + recSize);
    let rec = compress ? palmdocCompress(chunk) : Buffer.from(chunk);
    if (trailing) rec = Buffer.concat([rec, Buffer.from([0x00])]); // multibyte trailing entry with 0 overlap bytes
    textRecords.push(rec);
  }
  const fullName = Buffer.from(title, 'utf8');
  const exthRecords = [exthRecord(100, author), exthRecord(503, title), exthRecord(201, Buffer.from([0, 0, 0, 0])), ...extra.map(([type, data]) => exthRecord(type, data))];
  const exth = Buffer.concat(exthRecords);
  const exthHeader = Buffer.alloc(12);
  exthHeader.write('EXTH', 0, 'latin1'); exthHeader.writeUInt32BE(12 + exth.length, 4); exthHeader.writeUInt32BE(exthRecords.length, 8);
  const mobiLen = 0xe8; // header length (from 'MOBI') covering the NCX index field
  const rec0 = Buffer.alloc(16 + mobiLen + exthHeader.length + exth.length + fullName.length + 2, 0);
  rec0.writeUInt16BE(compress ? 2 : 1, 0);
  rec0.writeUInt32BE(text.length, 4);
  rec0.writeUInt16BE(textRecords.length, 8);
  rec0.writeUInt16BE(recSize, 10);
  rec0.writeUInt16BE(0, 12);
  rec0.write('MOBI', 16, 'latin1');
  rec0.writeUInt32BE(mobiLen, 20);
  rec0.writeUInt32BE(2, 24); // mobi type: book
  rec0.writeUInt32BE(65001, 28);
  rec0.writeUInt32BE(12345, 32);
  rec0.writeUInt32BE(6, 36); // version
  for (let o = 40; o < 80; o += 4) rec0.writeUInt32BE(0xffffffff, o);
  const firstNonBook = 1 + textRecords.length;
  rec0.writeUInt32BE(firstNonBook, 80);
  const fullNameOffset = 16 + mobiLen + exthHeader.length + exth.length;
  rec0.writeUInt32BE(fullNameOffset, 84);
  rec0.writeUInt32BE(fullName.length, 88);
  rec0.writeUInt32BE(9, 92); // locale en
  rec0.writeUInt32BE(6, 104);
  rec0.writeUInt32BE(firstNonBook, 108); // first image
  rec0.writeUInt32BE(0xffffffff, 112);
  rec0.writeUInt32BE(0, 116);
  rec0.writeUInt32BE(0x40, 128); // exth flag
  rec0.writeUInt16BE(1, 0xc0); // first content
  rec0.writeUInt16BE(textRecords.length, 0xc2);
  rec0.writeUInt32BE(1, 0xc4);
  rec0.writeUInt32BE(0xffffffff, 0xc8); rec0.writeUInt32BE(0xffffffff, 0xd0);
  rec0.writeUInt16BE(trailing ? 1 : 0, 0xf2);
  rec0.writeUInt32BE(0xffffffff, 0xf4); // no NCX index
  exthHeader.copy(rec0, 16 + mobiLen);
  exth.copy(rec0, 16 + mobiLen + exthHeader.length);
  fullName.copy(rec0, fullNameOffset);

  const records = [rec0, ...textRecords, ...images.map((i) => Buffer.from(i)), Buffer.from('FLIS'), Buffer.from('FCIS'), Buffer.from([0xe9, 0x8e, 0x0d, 0x0a])];
  const header = Buffer.alloc(78 + records.length * 8 + 2, 0);
  header.write(title.slice(0, 31), 0, 'latin1');
  header.writeUInt16BE(0, 32);
  header.writeUInt16BE(0, 34);
  header.write('BOOK', 60, 'latin1');
  header.write('MOBI', 64, 'latin1');
  header.writeUInt16BE(records.length, 76);
  let offset = header.length;
  records.forEach((r, i) => {
    header.writeUInt32BE(offset, 78 + i * 8);
    header.writeUInt8(0, 82 + i * 8);
    header.writeUIntBE(i * 2, 83 + i * 8, 3);
    offset += r.length;
  });
  return Buffer.concat([header, ...records]);
}

/** Builds fixture HTML with correct filepos values. */
export function fixtureMobiHtml() {
  const head = '<html><head><guide></guide></head><body>';
  const ch1 = '<h1>Chapter One</h1><p>First paragraph of the book, with some text that repeats repeats repeats.</p><p>See <a filepos=FILEPOS_TWO>chapter two</a>.</p>';
  const brk = '<mbp:pagebreak/>';
  const ch2Start = '<h1>Chapter Two</h1>';
  const ch2 = ch2Start + '<p>Second chapter with an image: <img recindex="00001" /></p><p>Back to <a filepos=0000000000>start</a>.</p>';
  const tail = '</body></html>';
  const filler = ('<p>Filler paragraph to push the text across record boundaries. Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' + 'Ünïcödé text ✓ works. '.repeat(3) + '</p>').repeat(60);
  let doc = head + ch1 + filler + brk + ch2 + tail;
  const pos = Buffer.byteLength(head + ch1.replace('FILEPOS_TWO', '0000000000') + filler + brk, 'utf8');
  doc = doc.replace('FILEPOS_TWO', String(pos).padStart(10, '0'));
  return doc;
}
