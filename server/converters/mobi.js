// Mobipocket (.mobi / .prc / .azw / .azw3) converter.
import { readPdb, palmdocDecompress, HuffCdic, trailingSize, readIndex, fromBase32 } from './mobi-codec.js';
import { normalizeDocument } from './html.js';
import { filterStylesheet } from './css.js';
import { assembleSections, imageExt } from './bundle.js';
import { uniqueIsbns } from './isbn.js';

const NONE = 0xffffffff;

function parseHeader(records, start) {
  const r0 = records[start];
  if (!r0 || r0.length < 16) throw new Error('Missing MOBI header record');
  const h = {
    start,
    compression: r0.readUInt16BE(0),
    textLength: r0.readUInt32BE(4),
    textRecordCount: r0.readUInt16BE(8),
    recordSize: r0.readUInt16BE(10),
    encryption: r0.readUInt16BE(12),
    isMobi: r0.length >= 24 && r0.toString('latin1', 16, 20) === 'MOBI',
    encoding: 1252, version: 0, headerLength: 0, extraFlags: 0, exth: new Map(),
    firstImage: NONE, huffOffset: NONE, huffCount: 0, ncxIndex: NONE, fdst: NONE, fdstCount: 0, fragIndex: NONE, skelIndex: NONE, guideIndex: NONE,
    fullName: '',
  };
  if (!h.isMobi) return h;
  const len = h.headerLength = r0.readUInt32BE(20);
  const has = (off, size = 4) => off + size <= 16 + len && off + size <= r0.length;
  h.mobiType = r0.readUInt32BE(24);
  h.encoding = r0.readUInt32BE(28);
  h.version = has(36) ? r0.readUInt32BE(36) : 0;
  h.firstNonBook = has(80) ? r0.readUInt32BE(80) : NONE;
  if (has(88)) {
    const off = r0.readUInt32BE(84);
    const n = r0.readUInt32BE(88);
    if (off + n <= r0.length) h.fullName = decodeText(r0.subarray(off, off + n), h.encoding).replace(/\0+$/, '');
  }
  h.locale = has(92) ? r0.readUInt32BE(92) : 0;
  h.firstImage = has(108) ? r0.readUInt32BE(108) : NONE;
  h.huffOffset = has(112) ? r0.readUInt32BE(112) : NONE;
  h.huffCount = has(116) ? r0.readUInt32BE(116) : 0;
  h.exthFlags = has(128) ? r0.readUInt32BE(128) : 0;
  if (h.version >= 5 && has(0xf0)) h.extraFlags = r0.readUInt16BE(0xf2);
  if (has(0xf4)) h.ncxIndex = r0.readUInt32BE(0xf4);
  if (h.version >= 8) {
    if (has(0xc0)) { h.fdst = r0.readUInt32BE(0xc0); h.fdstCount = r0.readUInt32BE(0xc4); if (h.fdstCount <= 1) h.fdst = NONE; }
    if (has(0xf8)) h.fragIndex = r0.readUInt32BE(0xf8);
    if (has(0xfc)) h.skelIndex = r0.readUInt32BE(0xfc);
    if (has(0x104)) h.guideIndex = r0.readUInt32BE(0x104);
  }
  if (h.exthFlags & 0x40) {
    const p = 16 + len;
    if (r0.toString('latin1', p, p + 4) === 'EXTH') {
      const count = r0.readUInt32BE(p + 8);
      let q = p + 12;
      for (let i = 0; i < count && q + 8 <= r0.length; i++) {
        const type = r0.readUInt32BE(q);
        const l = r0.readUInt32BE(q + 4);
        if (l < 8) break;
        const data = r0.subarray(q + 8, q + l);
        if (!h.exth.has(type)) h.exth.set(type, []);
        h.exth.get(type).push(data);
        q += l;
      }
    }
  }
  return h;
}

function decodeText(buf, encoding) {
  if (encoding === 65001) return buf.toString('utf8');
  try { return new TextDecoder('windows-1252').decode(buf); } catch { return buf.toString('latin1'); }
}

function exthString(h, type) {
  const v = h.exth.get(type);
  return v ? decodeText(v[0], h.encoding).replace(/\0+$/, '').trim() : '';
}

/** Resolve a record index stored in a header: header-relative first, absolute as fallback, validated by `check`. */
function pickRecord(records, h, idx, check) {
  if (idx === NONE || idx == null) return -1;
  const candidates = [h.start + idx, idx];
  for (const c of candidates) {
    if (c >= 0 && c < records.length && (!check || check(records[c]))) return c;
  }
  return -1;
}

const magic = (tag) => (r) => r.length >= 4 && r.toString('latin1', 0, 4) === tag;
const isImageRecord = (r) => r.length > 8 && ['jpg', 'png', 'gif', 'bmp', 'webp'].includes(imageExt('', r)) && !/^(FONT|RESC|CRES|CONT|kind|BOUN|FLIS|FCIS|SRCS|DATP|CMET)/.test(r.toString('latin1', 0, 4));

function extractText(records, h) {
  if (h.encryption !== 0) throw new Error('This MOBI file is DRM protected and cannot be read');
  let decompress;
  if (h.compression === 1) decompress = (d) => d;
  else if (h.compression === 2) decompress = palmdocDecompress;
  else if (h.compression === 17480) {
    const huffIdx = pickRecord(records, h, h.huffOffset, magic('HUFF'));
    if (huffIdx < 0) throw new Error('HUFF record missing');
    const cdics = [];
    for (let i = 1; i < h.huffCount; i++) cdics.push(records[huffIdx + i]);
    const codec = new HuffCdic(records[huffIdx], cdics);
    decompress = (d) => codec.decompress(d);
  } else throw new Error(`Unknown MOBI compression ${h.compression}`);
  const parts = [];
  for (let i = 1; i <= h.textRecordCount; i++) {
    const rec = records[h.start + i];
    if (!rec) break;
    const trim = h.extraFlags ? trailingSize(rec, h.extraFlags) : 0;
    parts.push(decompress(rec.subarray(0, Math.max(0, rec.length - trim))));
  }
  return Buffer.concat(parts);
}

/** Move a byte position outside of any tag it may fall inside. */
function safeInsertPos(bytes, pos, bodyStart = 0) {
  pos = Math.max(bodyStart, Math.min(pos, bytes.length));
  let lt = -1;
  let gt = -1;
  for (let i = pos - 1; i >= 0 && i > pos - 4000; i--) {
    const c = bytes[i];
    if (c === 0x3e) { gt = i; break; }
    if (c === 0x3c) { lt = i; break; }
  }
  if (lt >= 0 && gt < 0) {
    // inside a tag: skip to just after it
    const close = bytes.indexOf(0x3e, pos);
    return close >= 0 ? close + 1 : pos;
  }
  return pos;
}

/** Insert `<a id="...">` markers. `markers` is a list of {at, id} with byte offsets into `bytes`. */
function insertMarkers(bytes, markers, prefix) {
  const byPos = new Map();
  for (const m of markers) {
    const at = typeof m === 'number' ? m : m.at;
    const id = typeof m === 'number' ? m : m.id;
    if (!Number.isFinite(at) || at < 0 || at > bytes.length) continue;
    if (!byPos.has(at)) byPos.set(at, new Set());
    byPos.get(at).add(id);
  }
  const positions = [...byPos.keys()].sort((a, b) => b - a);
  // Markers must live inside <body>; anything earlier is moved to just after the body tag.
  let bodyStart = 0;
  const bodyIdx = bytes.indexOf('<body', 0, 'latin1');
  if (bodyIdx >= 0) { const close = bytes.indexOf(0x3e, bodyIdx); if (close >= 0) bodyStart = close + 1; }
  const chunks = [];
  let end = bytes.length;
  for (const pos of positions) {
    const at = Math.min(safeInsertPos(bytes, pos, bodyStart), end);
    chunks.push(bytes.subarray(at, end));
    chunks.push(Buffer.from([...byPos.get(pos)].map((id) => `<a id="${prefix}${id}"></a>`).join(''), 'latin1'));
    end = at;
  }
  chunks.push(bytes.subarray(0, end));
  chunks.reverse();
  return Buffer.concat(chunks);
}

function buildTocTree(entries, labelOf, keyOf) {
  // entries: [{tags}] with tags 21 (parent), 22 (first child), 23 (last child), 4 (depth)
  const nodes = entries.map((e, i) => ({ title: labelOf(e) || `Section ${i + 1}`, key: keyOf(e), children: [], parent: e.tags[21]?.[0], depth: e.tags[4]?.[0] ?? 0, idx: i }));
  const roots = [];
  const hasParents = nodes.some((n) => n.parent != null);
  if (hasParents) {
    for (const n of nodes) {
      const p = n.parent != null ? nodes[n.parent] : null;
      if (p && p !== n) p.children.push(n); else roots.push(n);
    }
  } else {
    const stack = [];
    for (const n of nodes) {
      while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(n); else roots.push(n);
      stack.push(n);
    }
  }
  const strip = (list) => list.map((n) => {
    const out = { title: n.title, key: n.key };
    if (n.children.length) out.children = strip(n.children);
    return out;
  });
  return strip(roots);
}

function readImages(records, h) {
  // Returns a resolver from resource number (1-based) to {out, data}
  let first = pickRecord(records, h, h.firstImage, isImageRecord);
  if (first < 0) first = pickRecord(records, h, h.firstImage, null);
  if (first < 0) first = records.findIndex(isImageRecord);
  const images = new Map();
  const outFor = new Map();
  const resolve = (n) => {
    if (first < 0 || !Number.isFinite(n) || n < 1) return null;
    const idx = first + n - 1;
    const rec = records[idx];
    if (!rec || !isImageRecord(rec)) return null;
    if (!outFor.has(idx)) {
      const out = `images/${idx}.${imageExt('', rec)}`;
      outFor.set(idx, out);
      images.set(out, Buffer.from(rec));
    }
    return outFor.get(idx);
  };
  const cover = () => {
    const tryExth = (type) => {
      const v = h.exth.get(type);
      if (!v || v[0].length < 4 || first < 0) return null;
      const rec = records[first + v[0].readUInt32BE(0)];
      return rec && isImageRecord(rec) ? rec : null;
    };
    const rec = tryExth(201) || tryExth(202) || (first >= 0 && isImageRecord(records[first]) ? records[first] : null);
    return rec ? { ext: imageExt('', rec), data: Buffer.from(rec) } : null;
  };
  return { resolve, images, cover };
}

// The title is '' when the book names none.
function metaFrom(h) {
  const title = exthString(h, 503) || h.fullName;
  const exthStrings = (type) => (h.exth.get(type) || []).map((b) => decodeText(b, h.encoding).replace(/\0+$/, '').trim()).filter(Boolean);
  const authors = exthStrings(100);
  const language = exthString(h, 524);
  // EXTH 104 is the ISBN; 112, the source, can name the printed book ("urn:isbn:…").
  const isbns = uniqueIsbns([...exthStrings(104).map((value) => ({ value, isbn: true })), ...exthStrings(112).map((value) => ({ value }))]);
  return { title, author: authors.join(', '), language, format: 'mobi', isbns };
}

// ---------------- MOBI7 ----------------
function convertMobi7(records, h) {
  const raw = extractText(records, h);
  const latin = raw.toString('latin1');
  const positions = [];
  for (const m of latin.matchAll(/filepos=["']?(\d+)/gi)) positions.push(parseInt(m[1], 10));

  // NCX index for the table of contents
  let toc = [];
  try {
    const ncxIdx = pickRecord(records, h, h.ncxIndex, magic('INDX'));
    if (ncxIdx >= 0) {
      const { entries, cncx } = readIndex(records, ncxIdx);
      const labelOf = (e) => { const off = e.tags[3]?.[0]; const b = off != null ? cncx.get(off) : null; return b ? decodeText(b, h.encoding).trim() : ''; };
      const keyOf = (e) => { const pos = e.tags[1]?.[0]; if (pos == null) return null; positions.push(pos); return `mobi#filepos${pos}`; };
      toc = buildTocTree(entries.filter((e) => e.tags[1] != null), labelOf, keyOf);
    }
  } catch { toc = []; }

  const marked = insertMarkers(raw, positions, 'filepos');
  let html = decodeText(marked, h.encoding);
  html = html.replace(/<a([^>]*?)\sfilepos=["']?(\d+)["']?/gi, (m, pre, n) => `<a${pre} href="#filepos${parseInt(n, 10)}"`)
    .replace(/<img([^>]*?)\s(?:hi|lo)?recindex=["']?(\d+)["']?/gi, '<img$1 src="rec:$2"');

  const { resolve, images, cover } = readImages(records, h);
  const pieces = html.split(/<mbp:pagebreak\s*\/?>/i);
  const chapters = [];
  let acc = '';
  for (const piece of pieces) {
    acc += piece;
    if (acc.replace(/<[^>]+>/g, '').length > 2000) { chapters.push(acc); acc = ''; }
  }
  if (acc.trim()) chapters.push(acc);
  const chapterRoots = chapters.map((c) => normalizeDocument(c, {
    resolveImage: (src) => { const m = /^rec:(\d+)$/.exec(src); return m ? resolve(parseInt(m[1], 10)) : null; },
    resolveLink: (href) => (href.startsWith('#') ? `mobi${href}` : null),
  }).root).map((root) => ({ root, key: 'mobi' }));

  const { sections, toc: finalToc } = assembleSections(chapterRoots, { toc });
  return { meta: metaFrom(h), sections, toc: finalToc, images, cover: cover() };
}

// ---------------- KF8 ----------------
function convertKf8(records, h) {
  const raw = extractText(records, h);
  let flows = [raw];
  const fdstIdx = pickRecord(records, h, h.fdst, magic('FDST'));
  if (fdstIdx >= 0) {
    const fd = records[fdstIdx];
    const n = fd.readUInt32BE(8);
    flows = [];
    for (let i = 0; i < n; i++) {
      const s = fd.readUInt32BE(12 + i * 8);
      const e = fd.readUInt32BE(16 + i * 8);
      flows.push(raw.subarray(s, Math.min(e, raw.length)));
    }
  }
  const text = flows[0];

  // Skeleton + fragment tables
  const parts = [];
  const fragTable = [];
  const skelIdx = pickRecord(records, h, h.skelIndex, magic('INDX'));
  const fragIdx = pickRecord(records, h, h.fragIndex, magic('INDX'));
  if (skelIdx >= 0 && fragIdx >= 0) {
    const skel = readIndex(records, skelIdx).entries;
    const frag = readIndex(records, fragIdx).entries;
    for (const f of frag) fragTable.push({ insertPos: parseInt(f.label.toString('latin1'), 10), start: f.tags[6]?.[0] ?? 0, length: f.tags[6]?.[1] ?? 0 });
    let fragPtr = 0;
    for (const s of skel) {
      const fragCount = s.tags[1]?.[0] ?? 0;
      const skelPos = s.tags[6]?.[0] ?? 0;
      const skelLen = s.tags[6]?.[1] ?? 0;
      let basePtr = skelPos + skelLen;
      let skeleton = text.subarray(skelPos, basePtr);
      for (let i = 0; i < fragCount && fragPtr < fragTable.length; i++) {
        const f = fragTable[fragPtr++];
        const slice = text.subarray(basePtr, basePtr + f.length);
        let insertPos = f.insertPos - skelPos;
        insertPos = Math.max(0, Math.min(insertPos, skeleton.length));
        const head = skeleton.subarray(0, insertPos);
        const tail = skeleton.subarray(insertPos);
        skeleton = Buffer.concat([head, slice, tail]);
        basePtr += f.length;
      }
      parts.push({ start: skelPos, end: basePtr, data: skeleton });
    }
  }
  if (!parts.length) parts.push({ start: 0, end: text.length, data: text });

  const locate = (pos) => {
    for (let i = 0; i < parts.length; i++) if (pos >= parts[i].start && pos < parts[i].end) return { part: i, offset: pos - parts[i].start };
    return null;
  };
  const posFromFid = (fid, off) => {
    const f = fragTable[fid];
    return f ? f.insertPos + off : off;
  };

  // Collect anchor positions from links and the NCX.
  const needed = parts.map(() => []);
  const addPos = (pos) => { const loc = locate(pos); if (loc) needed[loc.part].push({ at: loc.offset, id: pos }); return loc ? pos : null; };
  for (const p of parts) {
    const s = p.data.toString('latin1');
    for (const m of s.matchAll(/kindle:pos:fid:([0-9A-V]+):off:([0-9A-V]+)/gi)) addPos(posFromFid(fromBase32(m[1]), fromBase32(m[2])));
  }
  let toc = [];
  try {
    const ncxIdx = pickRecord(records, h, h.ncxIndex, magic('INDX'));
    if (ncxIdx >= 0) {
      const { entries, cncx } = readIndex(records, ncxIdx);
      const labelOf = (e) => { const off = e.tags[3]?.[0]; const b = off != null ? cncx.get(off) : null; return b ? decodeText(b, h.encoding).trim() : ''; };
      const keyOf = (e) => {
        if (e.tags[6]) { const pos = addPos(posFromFid(e.tags[6][0], e.tags[6][1] ?? 0)); return pos != null ? `mobi#kpos${pos}` : null; }
        if (e.tags[1]) { const pos = addPos(e.tags[1][0]); return pos != null ? `mobi#kpos${pos}` : null; }
        return null;
      };
      toc = buildTocTree(entries.filter((e) => e.tags[6] || e.tags[1]), labelOf, keyOf);
    }
  } catch { toc = []; }

  const { resolve, images, cover } = readImages(records, h);
  const cssParts = [];
  for (let i = 1; i < flows.length; i++) {
    const s = flows[i].toString('utf8');
    if (!/^\s*</.test(s)) cssParts.push(s);
  }

  const chapters = parts.map((p, i) => {
    const bytes = insertMarkers(p.data, needed[i], 'kpos');
    let html = decodeText(bytes, h.encoding);
    html = html.replace(/kindle:pos:fid:([0-9A-V]+):off:([0-9A-V]+)/gi, (m, fid, off) => `#kpos${posFromFid(fromBase32(fid), fromBase32(off))}`)
      .replace(/kindle:embed:([0-9A-V]+)(\?mime=[^"'\s]*)?/gi, (m, n) => `res:${fromBase32(n)}`);
    for (const st of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) cssParts.push(st[1]);
    const { root } = normalizeDocument(html, {
      resolveImage: (src) => { const m = /^res:(\d+)$/.exec(src); return m ? resolve(parseInt(m[1], 10)) : null; },
      resolveLink: (href) => (href.startsWith('#') ? `mobi${href}` : null),
    });
    return { root, key: 'mobi' };
  });

  const { sections, toc: finalToc } = assembleSections(chapters, { toc });
  return { meta: metaFrom(h), sections, toc: finalToc, images, cover: cover(), css: filterStylesheet(cssParts.join('\n'), '.book-content') };
}

/** Reads only the book's details, without converting it. MOBI has no series field; the title may name one. */
export async function readMobiMetadata(buffer) {
  const pdb = readPdb(buffer);
  const h0 = parseHeader(pdb.records, 0);
  if (!h0.isMobi) return { title: pdb.name, author: '', language: '', format: 'mobi' };
  return metaFrom(h0);
}

export async function convertMobi(buffer) {
  const pdb = readPdb(buffer);
  const records = pdb.records;
  if (pdb.type !== 'BOOK' && pdb.type !== 'TEXt') throw new Error('Not a Mobipocket file');
  const h0 = parseHeader(records, 0);
  if (!h0.isMobi) {
    // Plain PalmDOC text
    const raw = extractText(records, h0);
    const { convertText } = await import('./text.js');
    const out = await convertText(raw);
    out.meta.title = pdb.name;
    out.meta.format = 'mobi';
    return out;
  }
  let kf8 = h0.version >= 8 ? h0 : null;
  if (!kf8) {
    for (let i = 1; i < records.length; i++) {
      if (records[i].length === 8 && records[i].toString('latin1') === 'BOUNDARY' && i + 1 < records.length) {
        try { const k = parseHeader(records, i + 1); if (k.isMobi && k.version >= 8) kf8 = k; } catch { /* ignore */ }
        break;
      }
    }
  }
  if (kf8) {
    try {
      const out = convertKf8(records, kf8);
      if (out.sections.some((s) => s.chars > 0)) return out;
    } catch (err) {
      if (h0.version >= 8) throw err;
    }
  }
  return convertMobi7(records, h0);
}
