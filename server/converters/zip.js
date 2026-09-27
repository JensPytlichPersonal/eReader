// Minimal ZIP archive reader (stored + deflate), enough for EPUB containers.
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_LOC_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

export class ZipReader {
  constructor(buffer) {
    this.buf = buffer;
    this.entries = new Map();
    this._readCentralDirectory();
  }

  _readCentralDirectory() {
    const buf = this.buf;
    // Find the End Of Central Directory record scanning back over a possible comment.
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= minPos; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end of central directory)');
    let count = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);
    let cdSize = buf.readUInt32LE(eocd + 12);
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      // ZIP64
      const locPos = eocd - 20;
      if (locPos >= 0 && buf.readUInt32LE(locPos) === ZIP64_EOCD_LOC_SIG) {
        const z64Pos = Number(buf.readBigUInt64LE(locPos + 8));
        if (buf.readUInt32LE(z64Pos) === ZIP64_EOCD_SIG) {
          count = Number(buf.readBigUInt64LE(z64Pos + 32));
          cdSize = Number(buf.readBigUInt64LE(z64Pos + 40));
          cdOffset = Number(buf.readBigUInt64LE(z64Pos + 48));
        }
      }
    }
    let pos = cdOffset;
    for (let n = 0; n < count && pos + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(pos) !== CEN_SIG) break;
      const flags = buf.readUInt16LE(pos + 8);
      const method = buf.readUInt16LE(pos + 10);
      let compressedSize = buf.readUInt32LE(pos + 20);
      let uncompressedSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      let localOffset = buf.readUInt32LE(pos + 42);
      const utf8 = (flags & 0x800) !== 0;
      const name = buf.toString(utf8 ? 'utf8' : 'latin1', pos + 46, pos + 46 + nameLen);
      // ZIP64 extra field
      let ep = pos + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = buf.readUInt16LE(ep);
        const len = buf.readUInt16LE(ep + 2);
        if (id === 0x0001) {
          let q = ep + 4;
          if (uncompressedSize === 0xffffffff && q + 8 <= ep + 4 + len) { uncompressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff && q + 8 <= ep + 4 + len) { compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff && q + 8 <= ep + 4 + len) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
        }
        ep += 4 + len;
      }
      if (!name.endsWith('/')) {
        this.entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`ZIP entry not found: ${name}`);
    const buf = this.buf;
    const p = e.localOffset;
    if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) throw new Error(`Corrupt ZIP local header for ${name}`);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compressedSize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${e.method} for ${name}`);
  }

  readText(name) {
    return this.read(name).toString('utf8').replace(/^﻿/, '');
  }
}
