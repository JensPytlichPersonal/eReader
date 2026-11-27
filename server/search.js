// Searching a book. A search reads the book's sections as the reader shows them and finds every place
// where the words typed occur, as places the reader can go to: (section, offset), the offset counted as the
// reader counts places in a section (positionText in fixes.js, indexNodes() in public/js/reader.js).
// Case does not matter, nor curly or straight quotes, nor how many spaces or line breaks stand between two
// words. Accents do: "gard" does not find "gård". A phrase is found across italics, links and the like, but
// never across two paragraphs, headings or other blocks.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DomUtils } from 'htmlparser2';
import { BLOCK_TAGS } from './converters/html.js';
import { parseSection } from './fixes.js';

const { isTag, isText } = DomUtils;

// The shortest and longest search, in characters as folded (see foldQuery), and the most places answered.
export const MIN_QUERY = 2;
export const MAX_QUERY = 200;
export const MAX_HITS = 200;
// About how many characters of the text around a place a hit shows.
const BEFORE = 40;
const AFTER = 60;
// How far into the section's text those are looked for, enough for runs of white space.
const BEFORE_RAW = BEFORE * 4;
const AFTER_RAW = AFTER * 4;
// Where one block ends and the next begins, in the text searched. No search holds it (see folder).
const BREAK = '\n';
const SOFT_HYPHEN = 0xAD;
// A picture, as positionText() counts it.
const PICTURE = '\uFFFC';

// The white space of \s in a regular expression.
const isSpace = (c) => c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A)
  || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;

// One character folded for searching: lower case, and curly quotes straight. Lower case is taken one character
// at a time, so a letter reads the same wherever it stands, and can come out longer, as "İ" does.
function foldChar(c, data, k, n) {
  if (c < 128) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : data[k];
  if (c >= 0x2018 && c <= 0x201B) return "'";
  if (c >= 0x201C && c <= 0x201F) return '"';
  return data.slice(k, k + n).toLowerCase();
}

/**
 * Folds text for searching, piece by piece: every run of white space one space, none at the start or the end,
 * soft hyphens out (see foldChar for the rest), and a break between blocks. Remembers where each character
 * of the folded text comes from: character i stands for the places from[i] up to to[i] of the text it was
 * given, so a space covers its whole run of white space, and a break no place at all.
 */
function folder() {
  const chars = [];
  const from = [];
  const to = [];
  let spaceFrom = -1;
  let spaceTo = -1;
  const push = (s, a, b) => {
    for (let i = 0; i < s.length; i++) {
      chars.push(s[i]);
      from.push(a);
      to.push(b);
    }
  };
  return {
    /** The characters of a text node whose first character is place `at`. */
    text(data, at) {
      for (let k = 0; k < data.length; k++) {
        const c = data.charCodeAt(k);
        if (isSpace(c)) {
          if (spaceFrom < 0) spaceFrom = at + k;
          spaceTo = at + k + 1;
          continue;
        }
        if (c === SOFT_HYPHEN) continue;
        if (spaceFrom >= 0) {
          if (chars.length && chars[chars.length - 1] !== BREAK) push(' ', spaceFrom, spaceTo);
          spaceFrom = -1;
        }
        const n = c >= 0xD800 && c < 0xDC00 && (data.charCodeAt(k + 1) & 0xFC00) === 0xDC00 ? 2 : 1;
        push(foldChar(c, data, k, n), at + k, at + k + n);
        k += n - 1;
      }
    },
    /** A break, standing for the places `a` up to `b`: none, or a picture. Breaks in a row are one. */
    brk(a, b) {
      spaceFrom = -1;
      if (chars[chars.length - 1] === BREAK) to[to.length - 1] = b;
      else push(BREAK, a, b);
    },
    done: () => ({ text: chars.join(''), from, to }),
  };
}

/** A search as it is looked for: folded like the text (see folder), on one line. */
export function foldQuery(query) {
  const f = folder();
  f.text(String(query ?? ''), 0);
  return f.done().text;
}

/**
 * A section's text for searching, from its nodes: `text`, folded (see folder), with a break between blocks
 * and in place of each picture, and `from` and `to`, the places in the section each of its characters stands
 * for; `raw`, the section as positionText() in fixes.js counts it, which the places are in; and `ids`, the
 * place where each element with an id starts, as the reader finds the contents' entries.
 * Blocks are the elements of BLOCK_TAGS, line breaks among them; everything else runs on.
 */
export function searchText(nodes) {
  const f = folder();
  let raw = '';
  const ids = new Map();
  // As positionText() reads a section, which the reader's places follow.
  const visit = (list, parent) => {
    list.forEach((n, i) => {
      if (isText(n)) {
        let data = n.data.replace(/\r\n?/g, '\n');
        if (i === 0 && parent?.name === 'pre' && data.startsWith('\n')) data = data.slice(1);
        f.text(data, raw.length);
        raw += data;
      } else if (isTag(n)) {
        const id = n.attribs.id;
        if (id && !ids.has(id)) ids.set(id, raw.length);
        if (n.name === 'img') {
          f.brk(raw.length, raw.length + 1);
          raw += PICTURE;
        } else if (BLOCK_TAGS.has(n.name)) {
          f.brk(raw.length, raw.length);
          visit(n.children, n);
          f.brk(raw.length, raw.length);
        } else visit(n.children, n);
      }
    });
  };
  visit(nodes, null);
  return { ...f.done(), raw, ids };
}

// Snippet text: white space collapsed, without soft hyphens.
const tidy = (s) => s.replace(/\u00AD/g, '').replace(/\s+/g, ' ');

// The end of the text before a hit, about BEFORE characters, from the start of a word where it is cut. `cut`:
// the block holds more before it. An ellipsis says the text goes on.
function lead(text, cut) {
  let s = tidy(text);
  if (!cut) s = s.trimStart();
  if (s.length > BEFORE) {
    const inWord = s[s.length - BEFORE - 1] !== ' ' && s[s.length - BEFORE] !== ' ';
    s = s.slice(-BEFORE);
    const space = s.indexOf(' ');
    if (inWord && space >= 0 && space < s.length - 1) s = s.slice(space + 1);
    cut = true;
  }
  return (cut ? `…${s.trimStart()}` : s).toWellFormed();
}

// The start of the text after a hit, about AFTER characters, to the end of a word where it is cut.
function tail(text, cut) {
  let s = tidy(text);
  if (!cut) s = s.trimEnd();
  if (s.length > AFTER) {
    const inWord = s[AFTER] !== ' ' && s[AFTER - 1] !== ' ';
    s = s.slice(0, AFTER);
    const space = s.lastIndexOf(' ');
    if (inWord && space > 0) s = s.slice(0, space);
    cut = true;
  }
  return (cut ? `${s.trimEnd()}…` : s).toWellFormed();
}

/** How far into the book a place is, from 0 to 1, as percentOf() in the reader has it. */
export function percentOf(manifest, section, offset) {
  const s = manifest.sections[section];
  if (!s || !manifest.totalChars) return 0;
  return Math.min(1, Math.max(0, (s.start + Math.min(offset, s.chars)) / manifest.totalChars));
}

// The contents' entries that point at an element, by section: [{ title, id }], in the order of the contents.
function entriesBySection(toc, out = new Map()) {
  for (const e of toc || []) {
    if (e.section != null && e.id) {
      if (!out.has(e.section)) out.set(e.section, []);
      out.get(e.section).push({ title: e.title, id: e.id });
    }
    entriesBySection(e.children, out);
  }
  return out;
}

/**
 * The name of the chapter each place in a section is in, as the reader names it at the foot of the page
 * (currentTitle() in public/js/reader.js): the section's title, or that of the last entry of the contents
 * that starts before the place. A section without a title is named by its number, as the contents does.
 */
function titles(manifest, section, ids, entries) {
  const name = manifest.sections[section]?.title || '';
  const starts = (entries.get(section) || []).filter((e) => ids.has(e.id)).map((e) => ({ title: e.title, offset: ids.get(e.id) }));
  starts.sort((a, b) => a.offset - b.offset);
  return (offset) => {
    let title = name;
    for (const t of starts) if (t.offset <= offset + 1) title = t.title; else break;
    return title || `Section ${section + 1}`;
  };
}

/**
 * Finds `query` in the sections of a book with this `manifest`, given one at a time to `look`, in order, as
 * searchText made them. Every place it occurs counts, in book order, none overlapping the one before.
 * `result()` gives { total, hits }, `hits` the first MAX_HITS of them:
 * [{ section, offset, length, title, percent, before, match, after }], `offset` and `length` in the section's
 * places, so they take in the whole of the words as the book has them, and `before`, `match` and `after` the
 * words with some of the text around them in their block, as text.
 */
function finder(manifest, query) {
  const q = foldQuery(query);
  const entries = entriesBySection(manifest.toc);
  const hits = [];
  let total = 0;
  const look = (sec, n) => {
    if (!q) return;
    let titleAt = null;
    for (let at = sec.text.indexOf(q); at >= 0; at = sec.text.indexOf(q, at + q.length)) {
      total++;
      if (hits.length >= MAX_HITS) continue;
      titleAt ??= titles(manifest, n, sec.ids, entries);
      const start = sec.from[at];
      const end = sec.to[at + q.length - 1];
      // The block the place is in, from the break before it to the break after it.
      const b = sec.text.lastIndexOf(BREAK, at);
      const blockStart = b >= 0 ? sec.to[b] : 0;
      const e = sec.text.indexOf(BREAK, at + q.length);
      const blockEnd = e >= 0 ? sec.from[e] : sec.raw.length;
      const leadFrom = Math.max(blockStart, start - BEFORE_RAW);
      const tailTo = Math.min(blockEnd, end + AFTER_RAW);
      hits.push({
        section: n, offset: start, length: end - start, title: titleAt(start), percent: percentOf(manifest, n, start),
        before: lead(sec.raw.slice(leadFrom, start), leadFrom > blockStart),
        match: tidy(sec.raw.slice(start, end)).toWellFormed(),
        after: tail(sec.raw.slice(end, tailTo), tailTo < blockEnd),
      });
    }
  };
  return { look, result: () => ({ total, hits }) };
}

/** Finds `query` in sections from searchText, by number, of a book with this `manifest` (see finder). */
export function findIn(sections, manifest, query) {
  const f = finder(manifest, query);
  sections.forEach(f.look);
  return f.result();
}

/**
 * Finds `query` in the book in folder `dir`, whose book.json is `manifest` (see finder). Every search reads
 * the sections again, one at a time: a long novel takes some tens of milliseconds.
 */
export async function searchBook(dir, manifest, query) {
  const f = finder(manifest, query);
  for (let n = 0; n < manifest.sections.length; n++) {
    const html = await fsp.readFile(path.join(dir, 'sections', `${n}.html`), 'utf8');
    f.look(searchText(parseSection(html).children), n);
  }
  return f.result();
}
