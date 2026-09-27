// Writes a converted book to disk in the layout the reader consumes:
//   <booksDir>/<id>/book.json, sections/N.html, images/*, styles.css, cover.<ext>
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkNodes, collectHeadings, serialize, textLength, isTag } from './html.js';
import { DomUtils } from 'htmlparser2';

export const SECTION_BUDGET = 40000;

/**
 * @typedef {object} Chapter
 * @property {object} root normalised DOM container (from normalizeDocument)
 * @property {string} [key] identifier links resolve to (e.g. zip path)
 * @property {string} [title]
 * @property {number} [page] source page number (pdf)
 */

/**
 * Build final sections from chapters: chunk, assign ids, resolve links, compute stats.
 * @param {Chapter[]} chapters
 * @param {object} opts
 * @param {Array<{title:string, key?:string, id?:string, section?:number, children?:any[]}>} [opts.toc]
 */
export function assembleSections(chapters, opts = {}) {
  const sections = [];
  const keyToSection = new Map(); // chapter key -> first section index
  const idToSection = new Map(); // "key#id" -> section index; also "#id" for global ids
  let counter = 0;

  for (const ch of chapters) {
    const chunks = chunkNodes(ch.root, opts.budget ?? SECTION_BUDGET);
    chunks.forEach((nodes, i) => {
      const idx = sections.length;
      if (i === 0 && ch.key != null && !keyToSection.has(ch.key)) keyToSection.set(ch.key, idx);
      const fake = { children: nodes };
      const headings = collectHeadings(fake, `rr${idx}`);
      for (const el of DomUtils.findAll((e) => !!e.attribs?.id, nodes)) {
        idToSection.set(`${ch.key ?? ''}#${el.attribs.id}`, idx);
      }
      sections.push({ nodes, headings, chars: textLength(nodes), title: i === 0 ? ch.title : undefined, key: ch.key, page: ch.page });
      counter++;
    });
  }

  const resolveKey = (key) => {
    // key forms: "path", "path#frag", "#frag"
    if (!key) return null;
    const hash = key.indexOf('#');
    const file = hash >= 0 ? key.slice(0, hash) : key;
    const frag = hash >= 0 ? key.slice(hash + 1) : '';
    if (frag) {
      const hit = idToSection.get(`${file}#${frag}`);
      if (hit != null) return { section: hit, id: frag };
      if (!file) {
        for (const [k, v] of idToSection) if (k.endsWith(`#${frag}`)) return { section: v, id: frag };
      }
    }
    if (keyToSection.has(file)) return { section: keyToSection.get(file), id: frag || undefined };
    return null;
  };

  // Resolve internal links now that every id has a home.
  for (const sec of sections) {
    for (const a of DomUtils.findAll((e) => e.name === 'a' && e.attribs['data-link'] != null, sec.nodes)) {
      const target = resolveKey(a.attribs['data-link']);
      delete a.attribs['data-link'];
      if (target) {
        a.attribs.href = `#sec=${target.section}${target.id ? `&id=${encodeURIComponent(target.id)}` : ''}`;
        a.attribs['data-sec'] = String(target.section);
        if (target.id) a.attribs['data-id'] = target.id;
      }
    }
  }

  // Table of contents: use the provided one when it resolves; otherwise headings.
  let toc = [];
  const mapToc = (entries, depth) => entries.map((e) => {
    let target = e.section != null ? { section: e.section, id: e.id } : resolveKey(e.key);
    const node = { title: (e.title || '').trim() || 'Untitled', section: target?.section ?? null, id: target?.id ?? null };
    if (e.children?.length && depth < 4) node.children = mapToc(e.children, depth + 1).filter(Boolean);
    return node.section == null && !node.children?.length ? null : node;
  }).filter(Boolean);
  if (opts.toc?.length) toc = mapToc(opts.toc, 0);
  if (!toc.length) toc = tocFromHeadings(sections);
  if (!toc.length && sections.length > 1) {
    toc = sections.map((s, i) => ({ title: s.title || `Section ${i + 1}`, section: i, id: null }));
  }

  // Give each section a title for the progress display.
  const flat = flattenToc(toc);
  let lastTitle = sections[0]?.title || '';
  sections.forEach((s, i) => {
    const entry = flat.find((t) => t.section === i);
    if (entry) lastTitle = entry.title;
    else if (s.title) lastTitle = s.title;
    else if (s.headings[0]) lastTitle = s.headings[0].text;
    s.title = lastTitle || s.title || '';
  });

  return { sections, toc };
}

function flattenToc(toc, out = []) {
  for (const t of toc) { out.push(t); if (t.children) flattenToc(t.children, out); }
  return out;
}

function tocFromHeadings(sections) {
  const all = [];
  sections.forEach((s, i) => s.headings.forEach((h) => all.push({ ...h, section: i })));
  if (!all.length) return [];
  // Use the two most significant heading levels present.
  const levels = [...new Set(all.map((h) => h.level))].sort();
  const top = levels[0];
  const second = levels[1];
  const toc = [];
  for (const h of all) {
    if (h.level === top) toc.push({ title: h.text, section: h.section, id: h.id, children: [] });
    else if (h.level === second && toc.length) toc[toc.length - 1].children.push({ title: h.text, section: h.section, id: h.id });
    else if (h.level === second) toc.push({ title: h.text, section: h.section, id: h.id, children: [] });
  }
  for (const t of toc) if (!t.children.length) delete t.children;
  return toc.slice(0, 2000);
}

/**
 * Write the bundle to disk.
 * @param {string} dir target directory
 * @param {object} book
 * @param {object} book.meta {title, author, language, format, series}
 * @param {Array} book.sections from assembleSections
 * @param {Array} book.toc
 * @param {Map<string, Buffer>} [book.images] bundle path -> data
 * @param {{ext:string, data:Buffer}} [book.cover]
 * @param {string} [book.css]
 * @param {object} [book.extra] anything else to store in the manifest
 */
export async function writeBundle(dir, book) {
  // Remove previous output but keep anything else in the directory (the uploaded original).
  for (const name of ['sections', 'images', 'styles.css', 'book.json']) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  try { for (const f of await fs.readdir(dir)) if (/^cover\./.test(f)) await fs.rm(path.join(dir, f), { force: true }); } catch { /* new dir */ }
  await fs.mkdir(path.join(dir, 'sections'), { recursive: true });
  const usedImages = new Set();
  const manifestSections = [];
  let cum = 0;
  for (let i = 0; i < book.sections.length; i++) {
    const s = book.sections[i];
    for (const img of DomUtils.findAll((e) => e.name === 'img', s.nodes)) usedImages.add(img.attribs['data-src']);
    const html = serialize(s.nodes);
    await fs.writeFile(path.join(dir, 'sections', `${i}.html`), html, 'utf8');
    manifestSections.push({ title: s.title || '', chars: s.chars, start: cum, page: s.page });
    cum += s.chars;
  }
  if (book.images?.size) {
    await fs.mkdir(path.join(dir, 'images'), { recursive: true });
    for (const [p, data] of book.images) {
      if (!usedImages.has(p)) continue;
      const target = path.join(dir, p);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
  }
  let coverName = null;
  if (book.cover?.data?.length) {
    coverName = `cover.${book.cover.ext || 'jpg'}`;
    await fs.writeFile(path.join(dir, coverName), book.cover.data);
  }
  if (book.css) await fs.writeFile(path.join(dir, 'styles.css'), book.css, 'utf8');
  const manifest = {
    version: 1,
    title: book.meta.title,
    author: book.meta.author || '',
    language: book.meta.language || '',
    format: book.meta.format,
    series: (book.meta.series || []).map((s) => ({ name: s.name, position: s.position ?? null })),
    totalChars: cum,
    sections: manifestSections,
    toc: book.toc,
    cover: coverName,
    hasStyles: !!book.css,
    convertedAt: Date.now(),
    ...(book.extra || {}),
  };
  await fs.writeFile(path.join(dir, 'book.json'), JSON.stringify(manifest), 'utf8');
  return manifest;
}

/** Utility for converters: guess a title from a filename. */
export function titleFromFilename(name) {
  return path.basename(name).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

export function imageExt(nameOrMime, data) {
  if (data && data.length > 4) {
    if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
    if (data[0] === 0x89 && data[1] === 0x50) return 'png';
    if (data[0] === 0x47 && data[1] === 0x49) return 'gif';
    if (data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
    if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    if (/^\s*<(\?xml|svg)/i.test(data.subarray(0, 100).toString('utf8'))) return 'svg';
  }
  const m = String(nameOrMime || '').toLowerCase().match(/(jpe?g|png|gif|webp|svg|bmp)/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  return 'jpg';
}

export { isTag };
