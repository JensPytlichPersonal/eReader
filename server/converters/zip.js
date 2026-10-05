// Minimal ZIP archive reader and writer (stored + deflate), enough for EPUB containers.
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

// A time as a ZIP entry keeps it: DOS date and time fields, in the server's local time, to two seconds.
function dosDateTime(when) {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * Writes a ZIP archive of `entries`, [{ name, data, store? }], `data` a Buffer or text. An entry is
 * compressed unless `store` is set, and none has an extra field, as an EPUB's mimetype entry must not.
 * Every entry is dated now. EPUB downloads and the tests' fixtures are written with it.
 */
export function writeZip(entries) {
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(data);
    const method = e.store ? 0 : 8;
    const comp = e.store ? data : zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // names in UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CEN_SIG, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
