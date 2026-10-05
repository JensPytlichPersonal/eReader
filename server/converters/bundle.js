// Writes a converted book to disk in the layout the reader consumes:
//   <booksDir>/<id>/book.json, sections/N.html, images/*, styles.css, cover.<ext>
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkNodes, collectHeadings, serialize, textLength, isTag, isText, removeCreditLines, anchorSpan, BLOCK_TAGS } from './html.js';
import { stripWatermarks } from './watermarks.js';
import { seriesFromFileTitle } from './series.js';
import { DomUtils } from 'htmlparser2';

// The most text a section holds. A chapter that fits is one section; a longer one is cut into near-equal
// parts. Measured with a CPU slowed 6x: a section this size opens in about 0.9 s and turns pages as quickly
// as one of 40,000; at twice this size page turns slow down.
export const SECTION_BUDGET = 150000;

/**
 * @typedef {object} Chapter
 * @property {object} root normalised DOM container (from normalizeDocument)
 * @property {string} [key] identifier links resolve to (e.g. zip path)
 * @property {string} [title]
 * @property {number} [page] source page number (pdf)
 * @property {boolean} [continues] carries on the chapter before it, as when an EPUB splits a chapter over two files
 */

/**
 * Build final sections from chapters: chunk, assign ids, resolve links, compute stats.
 * @param {Chapter[]} chapters
 * @param {object} opts
 * @param {Array<{title:string, key?:string, id?:string, section?:number, children?:any[]}>} [opts.toc]
 */
export function assembleSections(chapters, opts = {}) {
  // Every format comes through here with the whole book, so this is where its start is known.
  removeCreditLines(chapters.map((ch) => ch.root));
  const sections = [];
  const keyToSection = new Map(); // chapter key -> first section index
  const idToSection = new Map(); // "key#id" -> section index; also "#id" for global ids
  const { groups, anchors, renamed } = joinContinued(chapters);
  const budget = opts.budget ?? SECTION_BUDGET;
  // A PDF comes in sections already, at its chapter pages (see mergePages).
  const starts = Number.isFinite(budget) ? chapterStarts(groups, opts.toc, budget, renamed) : new Map();
  let counter = 0;

  for (const [gi, ch] of groups.entries()) {
    const chunks = chunkNodes(ch.root, budget, starts.get(gi));
    // A section that begins with a chapter's title found in the text is named by it. In a file of several such
    // chapters, these names win over the contents' entry for the file.
    const named = chunks.map((nodes) => leadingTitle(nodes, starts.get(gi)));
    const several = named.filter(Boolean).length > 1;
    chunks.forEach((nodes, i) => {
      const title = (i === 0 && !several ? ch.title : undefined) ?? named[i];
      const idx = sections.length;
      if (i === 0 && ch.key != null && !keyToSection.has(ch.key)) keyToSection.set(ch.key, idx);
      const fake = { children: nodes };
      const headings = collectHeadings(fake, `rr${idx}`);
      for (const el of DomUtils.findAll((e) => !!e.attribs?.id, nodes)) {
        idToSection.set(`${ch.idKeys?.get(el.attribs.id) ?? ch.key ?? ''}#${el.attribs.id}`, idx);
      }
      sections.push({ nodes, headings, chars: textLength(nodes), title, several: several && !!named[i], key: ch.key, page: ch.page, pageStart: ch.pageStart, pageEnd: ch.pageEnd });
      counter++;
    });
    // A chapter read as part of the one before is found at the anchor where it begins.
    for (const key of ch.joined || []) {
      const at = idToSection.get(`${key}#${anchors.get(key)}`);
      if (at != null && !keyToSection.has(key)) keyToSection.set(key, at);
    }
  }

  const resolveKey = (key) => {
    // key forms: "path", "path#frag", "#frag"
    if (!key) return null;
    const hash = key.indexOf('#');
    const file = hash >= 0 ? key.slice(0, hash) : key;
    let frag = hash >= 0 ? key.slice(hash + 1) : '';
    if (frag) {
      frag = renamed.get(`${file}#${frag}`) ?? frag;
      const hit = idToSection.get(`${file}#${frag}`);
      if (hit != null) return { section: hit, id: frag };
      if (!file) {
        for (const [k, v] of idToSection) if (k.endsWith(`#${frag}`)) return { section: v, id: frag };
      }
    }
    if (keyToSection.has(file)) return { section: keyToSection.get(file), id: frag || anchors.get(file) };
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
    if (entry && !(s.several && !entry.id)) lastTitle = entry.title;
    else if (s.title) lastTitle = s.title;
    else if (s.headings[0]) lastTitle = s.headings[0].text;
    s.title = lastTitle || s.title || '';
  });

  return { sections, toc };
}

const withIds = (nodes) => DomUtils.findAll((e) => !!e.attribs?.id, nodes);
const HEADING_RE = /^h[1-6]$/;

// A heading that names a chapter: "Chapter Eleven", "CHAPTER XI", "Part Two", "Kapitel 11", "Prologue", or a bare
// number such as "11" or "XI". Numbers count as digits, Roman numerals or words, in English and Danish.
const ROMAN = '(?=[ivxlcdm])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})';
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|'
  + 'seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|'
  + 'fifth|sixth|seventh|eighth|ninth|tenth|last|en|et|to|tre|fire|fem|seks|syv|otte|ni|ti|elleve|tolv|tretten|fjorten|'
  + 'femten|seksten|sytten|atten|nitten|tyve|tredive|fyrre|halvtreds|tres|halvfjerds|firs|halvfems|hundrede|'
  + 'første|anden|andet|tredje|fjerde|femte|sjette|syvende|ottende|niende|tiende|sidste';
const NUMBER = `(?:\\d+|${ROMAN}|(?:${NUMBER_WORDS})(?:-\\p{L}+)?|(?:en|to|tre|fire|fem|seks|syv|otte|ni)og\\p{L}+)(?![\\p{L}\\d])`;
const CHAPTER_WORDS = `(?:chapter|part|book|kapitel|del|bog)\\s+${NUMBER}|(?:prologue|prolog|epilogue|epilog|interlude|efterskrift)(?![\\p{L}])`;
// A paragraph is a chapter's title by its words; a heading also by a bare number, which in a paragraph may be a
// page number a scan left in the text.
const CHAPTER_LINE_RE = new RegExp(`^(?:${CHAPTER_WORDS})`, 'iu');
const CHAPTER_TITLE_RE = new RegExp(`^(?:${CHAPTER_WORDS}|(?:\\d+|${ROMAN})\\.?$)`, 'iu');
export const isChapterTitle = (text) => CHAPTER_TITLE_RE.test(text);
// So much text, at least, follows a chapter's heading before the next one: headings closer together are a list
// of chapters, as on a contents page.
const CHAPTER_MIN = 1000;

/** The words of an element, with a line break as a space. */
function wordsOf(el) {
  let s = '';
  const visit = (list) => {
    for (const n of list) {
      if (isText(n)) s += n.data;
      else if (isTag(n)) {
        if (n.name === 'br') s += ' ';
        visit(n.children);
      }
    }
  };
  visit(el.children);
  return s.replace(/\s+/g, ' ').trim();
}

/** The chapter title (from chapterStarts' `titles`) a section's nodes begin with, within their first 200 characters. */
function leadingTitle(nodes, titles) {
  if (!titles) return undefined;
  let seen = 0;
  let found;
  const visit = (list) => {
    for (const n of list) {
      if (found || seen > 200) return;
      if (isText(n)) seen += n.data.trim().length;
      else if (isTag(n)) {
        if (titles.get(n)) { found = titles.get(n); return; }
        visit(n.children);
      }
    }
  };
  visit(nodes);
  return found;
}

/**
 * Where chapters start inside the chapters given (`groups`, from joinContinued), so each begins a section and
 * a new page. These are the elements an entry of the contents `toc` points to, and the chapter titles in the
 * text (see CHAPTER_TITLE_RE). An entry under others counts only when each of those holds more than the
 * budget, as the chapters of a part do, and the sections of a chapter don't. A book without contents goes by
 * its headings, the two most significant levels, as tocFromHeadings makes its contents. One at a group's
 * start makes no cut, as each group begins a section anyway. Returns, for each group by its index, a Map of
 * those elements to the title the text gives them, '' for none.
 */
function chapterStarts(groups, toc, budget, renamed) {
  // Every element with an id, as resolveKey finds it: by "key#id", and by the id alone for "#id".
  const byKey = new Map();
  const byId = new Map();
  const firstOf = new Map(); // key -> the first group with it
  groups.forEach((g, gi) => {
    if (g.key != null && !firstOf.has(g.key)) firstOf.set(g.key, gi);
    for (const el of withIds(g.root.children)) {
      const id = el.attribs.id;
      byKey.set(`${g.idKeys?.get(id) ?? g.key ?? ''}#${id}`, { gi, el });
      if (!byId.has(id)) byId.set(id, { gi, el });
    }
  });
  const target = (key) => {
    if (!key) return null;
    const hash = key.indexOf('#');
    const file = hash >= 0 ? key.slice(0, hash) : key;
    let frag = hash >= 0 ? key.slice(hash + 1) : '';
    if (frag) {
      frag = renamed.get(`${file}#${frag}`) ?? frag;
      const hit = byKey.get(`${file}#${frag}`) ?? (file ? null : byId.get(frag));
      if (hit) return hit;
    }
    return firstOf.has(file) ? { gi: firstOf.get(file), el: null } : null;
  };

  // The entries in the order of the contents, each with its depth and the entry it is under.
  let entries = [];
  const walk = (list, depth, parent) => {
    for (const e of list || []) {
      const entry = { depth, parent, at: target(e.key) };
      entries.push(entry);
      if (e.children?.length) walk(e.children, depth + 1, entry);
    }
  };
  walk(toc, 0, null);
  if (!entries.some((e) => e.at)) {
    entries = [];
    const heads = [];
    groups.forEach((g, gi) => {
      for (const el of DomUtils.findAll((e) => HEADING_RE.test(e.name), g.root.children)) heads.push({ gi, el, level: Number(el.name[1]) });
    });
    const [top, second] = [...new Set(heads.map((h) => h.level))].sort();
    let parent = null;
    for (const h of heads) {
      if (h.level === top) {
        parent = { depth: 0, parent: null, at: { gi: h.gi, el: h.el } };
        entries.push(parent);
      } else if (h.level === second) entries.push({ depth: parent ? 1 : 0, parent, at: { gi: h.gi, el: h.el } });
    }
  }

  // Chapter titles begin one too, as the contents may not point at them: some books' contents list only their
  // files. A title is a heading or a line of its own that names a chapter, or one of the class "chapter", as
  // calibre finds them. One with a link in it is an entry on a contents page, and a title met again, such as
  // a scan's running head, counts only the first time.
  const titled = [];
  groups.forEach((g, gi) => {
    const isTitle = (e) => {
      const heading = HEADING_RE.test(e.name);
      if (!heading && !((e.name === 'p' || e.name === 'div') && !e.children.some((c) => isTag(c) && BLOCK_TAGS.has(c.name)))) return false;
      const words = wordsOf(e);
      if (!words || words.length > 80 || DomUtils.findOne((a) => a.name === 'a' && (a.attribs.href != null || a.attribs['data-link'] != null), e.children, true)) return false;
      return /(?:^|\s)chapter(?:\s|$)/i.test(e.attribs.class || '') || (heading ? CHAPTER_TITLE_RE : CHAPTER_LINE_RE).test(words);
    };
    for (const el of DomUtils.findAll(isTitle, g.root.children)) titled.push({ gi, el });
  });

  // Where each entry points in the whole text, so how much it holds: up to the next entry no deeper than it.
  const targets = new Set([...entries.map((e) => e.at?.el).filter(Boolean), ...titled.map((t) => t.el)]);
  const offsets = new Map();
  const bases = [];
  let total = 0;
  for (const g of groups) {
    bases.push(total);
    const visit = (list) => {
      for (const n of list) {
        if (isText(n)) total += n.data.length;
        else if (isTag(n)) {
          if (targets.has(n)) offsets.set(n, total);
          visit(n.children);
        }
      }
    };
    visit(g.root.children);
  }
  const placed = entries.filter((e) => e.at).map((e) => Object.assign(e, { pos: e.at.el ? offsets.get(e.at.el) ?? bases[e.at.gi] : bases[e.at.gi] }));
  placed.sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < placed.length; i++) {
    let j = i + 1;
    while (j < placed.length && placed[j].depth > placed[i].depth) j++;
    placed[i].holds = (j < placed.length ? placed[j].pos : total) - placed[i].pos;
  }

  // An entry without a place of its own, such as a part's name in the contents, holds what is under it.
  const counts = (e) => { for (let p = e.parent; p; p = p.parent) if (p.at && !(p.holds > budget)) return false; return true; };
  const starts = new Map();
  // Each group's starts, with the title found in the text for those that begin with one, else ''.
  const add = (gi, el, title = '') => {
    if (!starts.has(gi)) starts.set(gi, new Map());
    if (!starts.get(gi).get(el)) starts.get(gi).set(el, title);
  };
  for (const e of placed) if (e.at.el && counts(e)) add(e.at.gi, e.at.el);
  // A chapter's title is followed by its text, up to the next title or the end of its file.
  const seen = new Set();
  titled.forEach((t, i) => {
    const pos = offsets.get(t.el);
    const next = titled[i + 1];
    const end = Math.min(next?.gi === t.gi ? offsets.get(next.el) : Infinity, bases[t.gi + 1] ?? total);
    const key = wordsOf(t.el).toLowerCase();
    if (end - pos < CHAPTER_MIN || seen.has(key)) return;
    seen.add(key);
    add(t.gi, t.el, wordsOf(t.el));
  });
  return starts;
}

/**
 * Join each chapter that carries on the one before it (`continues`) to that one, so the two are chunked as one
 * chapter: its nodes go after the other's, behind an anchor where it begins, for links to it as a whole. Its
 * ids stay its own for links: a group's `idKeys` tells the key each id came from, and an id the group already
 * has is renamed. Returns the groups, each joined chapter's anchor id by key, and the renamed ids ("key#id" ->
 * the id it has now).
 */
function joinContinued(chapters) {
  const groups = [];
  const anchors = new Map();
  const renamed = new Map();
  const keys = new Set();
  let taken = null; // every id in the book, so a new one is unique
  const fresh = (base, n) => {
    while (taken.has(`${base}${n}`)) n++;
    taken.add(`${base}${n}`);
    return `${base}${n}`;
  };
  for (const ch of chapters) {
    const group = groups[groups.length - 1];
    // A key an earlier chapter has already leads there.
    const ownKey = ch.key != null && !keys.has(ch.key);
    keys.add(ch.key);
    if (!ch.continues || !group) { groups.push({ ...ch }); continue; }
    taken ??= new Set(chapters.flatMap((c) => withIds(c.root.children).map((e) => e.attribs.id)));
    group.idKeys ??= new Map(withIds(group.root.children).map((e) => [e.attribs.id, group.key ?? '']));
    for (const el of withIds(ch.root.children)) {
      if (group.idKeys.has(el.attribs.id)) {
        const id = fresh(`${el.attribs.id}-`, 2);
        renamed.set(`${ch.key ?? ''}#${el.attribs.id}`, id);
        el.attribs.id = id;
      }
      group.idKeys.set(el.attribs.id, ch.key ?? '');
    }
    const nodes = ch.root.children;
    ch.root.children = [];
    if (ownKey) {
      // The id must not be one the book has, nor one collectHeadings makes (rrN-hN).
      const anchor = anchorSpan(fresh('rr-join', 1));
      anchors.set(ch.key, anchor.attribs.id);
      group.idKeys.set(anchor.attribs.id, ch.key);
      group.joined = [...(group.joined || []), ch.key];
      nodes.unshift(anchor);
    }
    for (const n of nodes) { n.parent = group.root; group.root.children.push(n); }
    group.pageEnd = ch.pageEnd ?? group.pageEnd;
  }
  return { groups, anchors, renamed };
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
    manifestSections.push({ title: s.title || '', chars: s.chars, start: cum, page: s.page, pageStart: s.pageStart, pageEnd: s.pageEnd });
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
    series: (book.meta.series || []).map((s) => ({ name: s.name, position: s.position ?? null, ...(s.positionEnd != null ? { positionEnd: s.positionEnd } : {}) })),
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

// A file name as a title: without its folder, extension, underscores and download-site watermarks. An
// underscore standing for an apostrophe comes back ("Magician_s Gambit"), and a copy's version mark goes ("(v2)").
function titleFromFilename(name) {
  const title = path.basename(name).replace(/\.[^.]+$/, '')
    .replace(/(\p{Ll})_(s|t|d|m|ll|re|ve)(?=[\s_]|$)/gu, "$1'$2").replace(/[_]+/g, ' ');
  return stripWatermarks(title).replace(/\s*[([](?:v|ver\.?|version)\s*\d+(?:\.\d+)?[)\]]/gi, '')
    .replace(/\s+/g, ' ').trim() || 'Untitled';
}

/**
 * The title and series a file name gives, for a book that names no title of its own. A number in front is
 * the book's place in a series: "01 - The Belgariad - Pawn Of Prophecy" is Pawn of Prophecy in The
 * Belgariad, #1, and "03 - Dune" is just Dune (see seriesFromFileTitle). Capitals set on every word are tidied.
 * @returns {{title: string, series: Array<{name: string, position: number, positionEnd?: number}>}}
 */
export function detailsFromFilename(filename) {
  const { title, name, ...place } = seriesFromFileTitle(titleFromFilename(filename));
  return { title: tidyCapitals(title) || 'Untitled', series: name ? [{ name: tidyCapitals(name), ...place }] : [] };
}

// English words that stay lower case inside a title.
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with']);
// Where a title starts again: after a colon or a bracket, or a dash standing for a colon.
const TITLE_BREAK = /[:;()[\]]|\s[-–—]\s/;

/**
 * Capitals set on every word, as file names often have them, tidied: "Pawn Of Prophecy" is "Pawn of
 * Prophecy". Small words go lower case, except first and last and where the title starts again. A title
 * in any other shape (all lower case, all capitals, or mixed) is left as it is.
 */
function tidyCapitals(text) {
  const words = [...text.matchAll(/\p{L}[\p{L}\p{M}'’]*/gu)];
  if (!/\p{Ll}/u.test(text) || !words.every((m) => /^\p{Lu}/u.test(m[0]))) return text;
  let out = '';
  let at = 0;
  words.forEach((m, i) => {
    const end = m.index + m[0].length;
    const next = words[i + 1];
    const before = text.slice(at, m.index);
    const edge = i === 0 || !next || TITLE_BREAK.test(before) || TITLE_BREAK.test(text.slice(end, next.index));
    out += before + (!edge && SMALL_WORDS.has(m[0].toLowerCase()) ? m[0].toLowerCase() : m[0]);
    at = end;
  });
  return out + text.slice(at);
}

/** The type of an image from its first bytes: 'jpg', 'png', 'gif', 'bmp', 'webp' or 'svg', or null when it is none of these. */
export function sniffImage(data) {
  if (!data || data.length <= 4) return null;
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
  if (data[0] === 0x89 && data[1] === 0x50) return 'png';
  if (data[0] === 0x47 && data[1] === 0x49) return 'gif';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (/^\s*<(\?xml|svg)/i.test(data.subarray(0, 100).toString('utf8'))) return 'svg';
  return null;
}

export function imageExt(nameOrMime, data) {
  const sniffed = sniffImage(data);
  if (sniffed) return sniffed;
  const m = String(nameOrMime || '').toLowerCase().match(/(jpe?g|png|gif|webp|svg|bmp)/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  return 'jpg';
}

export { isTag };
