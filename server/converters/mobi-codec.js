// Low level pieces of the Mobipocket / Kindle container: PDB records, PalmDOC and
// HUFF/CDIC decompression, trailing-entry stripping and INDX table parsing.

export function readPdb(buf) {
  if (buf.length < 78) throw new Error('File too small to be a MOBI');
  const type = buf.toString('latin1', 60, 64);
  const creator = buf.toString('latin1', 64, 68);
  const numRecords = buf.readUInt16BE(76);
  const offsets = [];
  for (let i = 0; i < numRecords; i++) {
    const p = 78 + i * 8;
    if (p + 8 > buf.length) break;
    offsets.push(buf.readUInt32BE(p));
  }
  const records = offsets.map((off, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    return buf.subarray(off, Math.max(off, Math.min(end, buf.length)));
  });
  return { name: buf.toString('latin1', 0, 32).replace(/\0.*$/s, ''), type, creator, records };
}

export function isMobi(buf) {
  if (buf.length < 78) return false;
  const type = buf.toString('latin1', 60, 68);
  return type === 'BOOKMOBI' || type === 'TEXtREAd';
}

// ---- PalmDOC (LZ77 variant) ----
export function palmdocDecompress(input) {
  const out = Buffer.alloc(input.length * 8 + 16);
  let o = 0;
  let p = 0;
  const n = input.length;
  while (p < n) {
    const c = input[p++];
    if (c >= 1 && c <= 8) {
      for (let i = 0; i < c && p < n; i++) out[o++] = input[p++];
    } else if (c < 128) {
      out[o++] = c;
    } else if (c >= 192) {
      out[o++] = 0x20;
      out[o++] = c ^ 128;
    } else {
      if (p >= n) break;
      const w = (c << 8) | input[p++];
      const dist = (w >> 3) & 0x07ff;
      const len = (w & 7) + 3;
      if (dist === 0 || dist > o) continue;
      for (let i = 0; i < len; i++) { out[o] = out[o - dist]; o++; }
    }
    if (o > out.length - 16) return Buffer.concat([out.subarray(0, o), palmdocDecompress(input.subarray(p))]);
  }
  return out.subarray(0, o);
}

// ---- HUFF/CDIC ----
export class HuffCdic {
  constructor(huffRecord, cdicRecords) {
    if (huffRecord.toString('latin1', 0, 4) !== 'HUFF') throw new Error('Invalid HUFF record');
    const off1 = huffRecord.readUInt32BE(8);
    const off2 = huffRecord.readUInt32BE(12);
    this.dict1 = [];
    for (let i = 0; i < 256; i++) {
      const v = huffRecord.readUInt32BE(off1 + i * 4);
      const codelen = v & 0x1f;
      const term = v & 0x80;
      let maxcode = v >>> 8;
      maxcode = ((maxcode + 1) * 2 ** (32 - codelen)) - 1;
      this.dict1.push({ codelen, term, maxcode });
    }
    this.mincode = [0];
    this.maxcode = [0];
    for (let i = 0; i < 32; i++) {
      const codelen = i + 1;
      const mn = huffRecord.readUInt32BE(off2 + i * 8);
      const mx = huffRecord.readUInt32BE(off2 + i * 8 + 4);
      this.mincode.push(mn * 2 ** (32 - codelen));
      this.maxcode.push(((mx + 1) * 2 ** (32 - codelen)) - 1);
    }
    this.dictionary = [];
    for (const cdic of cdicRecords) {
      if (cdic.toString('latin1', 0, 4) !== 'CDIC') throw new Error('Invalid CDIC record');
      const phrases = cdic.readUInt32BE(8);
      const bits = cdic.readUInt32BE(12);
      const n = Math.min(1 << bits, phrases - this.dictionary.length);
      for (let i = 0; i < n; i++) {
        const off = cdic.readUInt16BE(16 + i * 2);
        const blen = cdic.readUInt16BE(16 + off);
        const slice = cdic.subarray(18 + off, 18 + off + (blen & 0x7fff));
        this.dictionary.push({ slice, flag: blen & 0x8000 });
      }
    }
  }

  decompress(data) {
    let bitsleft = data.length * 8;
    const padded = Buffer.concat([data, Buffer.alloc(8)]);
    let pos = 0;
    let x = padded.readBigUInt64BE(0);
    let n = 32;
    const parts = [];
    for (;;) {
      if (n <= 0) {
        pos += 4;
        x = padded.readBigUInt64BE(pos);
        n += 32;
      }
      const code = Number((x >> BigInt(n)) & 0xffffffffn);
      let { codelen, term, maxcode } = this.dict1[code >>> 24];
      if (!term) {
        while (code < this.mincode[codelen]) codelen++;
        maxcode = this.maxcode[codelen];
      }
      n -= codelen;
      bitsleft -= codelen;
      if (bitsleft < 0) break;
      const r = Math.floor((maxcode - code) / 2 ** (32 - codelen));
      const entry = this.dictionary[r];
      if (!entry) throw new Error('HUFF/CDIC dictionary index out of range');
      if (!entry.flag) {
        this.dictionary[r] = null; // guard against loops
        const expanded = this.decompress(entry.slice);
        this.dictionary[r] = { slice: expanded, flag: 1 };
        parts.push(expanded);
      } else {
        parts.push(entry.slice);
      }
    }
    return Buffer.concat(parts);
  }
}

// ---- Trailing entries ----
function trailingEntrySize(data, size) {
  let bitpos = 0;
  let result = 0;
  if (size <= 0) return 0;
  for (;;) {
    const v = data[size - 1];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    size -= 1;
    if ((v & 0x80) !== 0 || bitpos >= 28 || size === 0) return result;
  }
}

export function trailingSize(data, flags) {
  let num = 0;
  let test = flags >>> 1;
  while (test) {
    if (test & 1) num += trailingEntrySize(data, data.length - num);
    test >>>= 1;
  }
  if (flags & 1) num += (data[data.length - num - 1] & 0x3) + 1;
  return num;
}

// ---- Variable width integers (forward) ----
export function readVarint(data, offset) {
  let value = 0;
  let consumed = 0;
  for (;;) {
    const v = data[offset + consumed];
    consumed++;
    value = (value * 128) + (v & 0x7f);
    if (v & 0x80 || offset + consumed >= data.length) break;
  }
  return { value, consumed };
}

// ---- INDX parsing ----
function parseIndxHeader(data) {
  if (data.toString('latin1', 0, 4) !== 'INDX') throw new Error('Not an INDX record');
  const words = ['len', 'nul1', 'type', 'gen', 'start', 'count', 'code', 'lng', 'total', 'ordt', 'ligt', 'nligt', 'nctoc'];
  const h = {};
  words.forEach((w, i) => { h[w] = data.readUInt32BE(4 + i * 4); });
  let ordt2 = null;
  if (data.length >= 0xa4 + 20) {
    const ocnt = data.readUInt32BE(0xa4);
    const oentries = data.readUInt32BE(0xa8);
    const op2 = data.readUInt32BE(0xb0);
    if ((h.code === 0xfdea || ocnt !== 0 || oentries > 0) && op2 + 4 + oentries * 2 <= data.length && data.toString('latin1', op2, op2 + 4) === 'ORDT') {
      ordt2 = [];
      for (let i = 0; i < oentries; i++) ordt2.push(data.readUInt16BE(op2 + 4 + i * 2));
    }
  }
  return { header: h, ordt2 };
}

function readTagx(data, start) {
  const tags = [];
  let controlByteCount = 0;
  if (data.toString('latin1', start, start + 4) === 'TAGX') {
    const firstEntryOffset = data.readUInt32BE(start + 4);
    controlByteCount = data.readUInt32BE(start + 8);
    for (let i = 12; i < firstEntryOffset; i += 4) {
      const p = start + i;
      tags.push({ tag: data[p], valuesPerEntry: data[p + 1], mask: data[p + 2], endFlag: data[p + 3] });
    }
  }
  return { controlByteCount, tags };
}

function countBits(v) { let c = 0; for (let i = 0; i < 8; i++) { if (v & 1) c++; v >>= 1; } return c; }

function getTagMap(controlByteCount, tagTable, data, startPos) {
  const tags = [];
  const map = {};
  let controlByteIndex = 0;
  let dataStart = startPos + controlByteCount;
  for (const { tag, valuesPerEntry, mask, endFlag } of tagTable) {
    if (endFlag === 0x01) { controlByteIndex++; continue; }
    const cbyte = data[startPos + controlByteIndex];
    let value = cbyte & mask;
    if (value !== 0) {
      if (value === mask) {
        if (countBits(mask) > 1) {
          const { value: v, consumed } = readVarint(data, dataStart);
          dataStart += consumed;
          tags.push({ tag, valueCount: null, valueBytes: v, valuesPerEntry });
        } else {
          tags.push({ tag, valueCount: 1, valueBytes: null, valuesPerEntry });
        }
      } else {
        let m = mask;
        while ((m & 1) === 0) { m >>= 1; value >>= 1; }
        tags.push({ tag, valueCount: value, valueBytes: null, valuesPerEntry });
      }
    }
  }
  for (const { tag, valueCount, valueBytes, valuesPerEntry } of tags) {
    const values = [];
    if (valueCount != null) {
      for (let i = 0; i < valueCount; i++) {
        for (let j = 0; j < valuesPerEntry; j++) {
          const { value, consumed } = readVarint(data, dataStart);
          dataStart += consumed;
          values.push(value);
        }
      }
    } else {
      let total = 0;
      while (total < valueBytes) {
        const { value, consumed } = readVarint(data, dataStart);
        dataStart += consumed;
        total += consumed;
        values.push(value);
      }
    }
    map[tag] = values;
  }
  return map;
}

function readCncx(data) {
  const out = new Map();
  let offset = 0;
  while (offset < data.length) {
    if (data[offset] === 0) break;
    const start = offset;
    const { value: len, consumed } = readVarint(data, offset);
    offset += consumed;
    out.set(start, data.subarray(offset, offset + len));
    offset += len;
  }
  return out;
}

/**
 * Read an INDX table starting at record `idx`.
 * @returns {{entries: Array<{label: Buffer, tags: Record<number, number[]>}>, cncx: Map<number, Buffer>}}
 */
export function readIndex(records, idx) {
  const entries = [];
  const cncx = new Map();
  if (idx == null || idx === 0xffffffff || idx >= records.length) return { entries, cncx };
  const main = records[idx];
  const { header } = parseIndxHeader(main);
  const indexCount = header.count;
  let recOff = 0;
  const off = idx + indexCount + 1;
  for (let j = 0; j < header.nctoc; j++) {
    if (off + j >= records.length) break;
    for (const [k, v] of readCncx(records[off + j])) cncx.set(k + recOff, v);
    recOff += 0x10000;
  }
  const { controlByteCount, tags } = readTagx(main, header.len);
  for (let i = idx + 1; i <= idx + indexCount && i < records.length; i++) {
    const data = records[i];
    const { header: h, ordt2 } = parseIndxHeader(data);
    const idxtPos = h.start;
    const entryCount = h.count;
    const positions = [];
    for (let j = 0; j < entryCount; j++) positions.push(data.readUInt16BE(idxtPos + 4 + j * 2));
    positions.push(idxtPos);
    for (let j = 0; j < entryCount; j++) {
      const startPos = positions[j];
      const textLength = data[startPos];
      let label = data.subarray(startPos + 1, startPos + 1 + textLength);
      if (ordt2) label = Buffer.from([...label].map((b) => ordt2[b] & 0xff));
      const tagMap = getTagMap(controlByteCount, tags, data, startPos + 1 + textLength);
      entries.push({ label, tags: tagMap });
    }
  }
  return { entries, cncx };
}

export function fromBase32(s) {
  let v = 0;
  for (const ch of s.toUpperCase()) {
    const d = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    v = v * 32 + d;
  }
  return v;
}
