// Fixing the text of a book. An admin corrects what a book got wrong, such as a word misread by OCR or a
// footnote that landed in the middle of a sentence, as plain text: the paragraphs as they were and as
// fixed. The fix is written into the section the reader reads, and kept apart in text_fixes, so it is
// applied again, in the order fixes were made, each time the book is converted. Each paragraph keeps its
// element, and with it its look; words not changed keep their formatting, and pictures, anchors and page
// marks stay where they are. The section as converted is kept in unfixed/ the first time a fix touches it,
// so a fix is undone by applying the other fixes to that copy again.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseDocument, DomUtils, ElementType } from 'htmlparser2';
import { BLOCK_TAGS, isEmptyNode, serialize, textLength } from './converters/html.js';
import { now, transaction } from './db.js';

const { isTag, isText, textContent, findAll, findOne } = DomUtils;

// The sections as converted, kept beside sections/ while a fix is in them.
export const UNFIXED_DIR = 'unfixed';

// What counts as a paragraph, and its text. The reader finds paragraphs and reads their text the same
// way (public/js/reader.js), so the two must stay in step: an element with one of these tags, holding no
// block (BLOCK_TAGS in converters/html.js) other than br and img, not inside a pre, with text.
export const PARAGRAPH_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'td', 'th', 'caption', 'figcaption',
  'blockquote', 'div', 'section', 'article', 'aside', 'header', 'footer', 'address', 'summary'];
const PARAGRAPHS = new Set(PARAGRAPH_TAGS);
/** A paragraph's text: its text content, every run of white space one space, none around it. */
export const collapse = (text) => text.replace(/\s+/g, ' ').trim();

const HEADING = /^h[1-6]$/;
const STALE = 'The text has changed since it was opened. Reload the book and try again.';
// The most paragraphs fixed at once, and characters sent.
const MAX_BEFORE = 20;
const MAX_AFTER = 40;
const MAX_AFTER_CHARS = 200000;
// Text moved this long or longer keeps its formatting (see applyFix). Shorter, it could be any common phrase.
const MOVED_MIN = 20;
// Beyond this many cells, comparing word by word takes too long, and the change is taken as one block.
const MAX_CELLS = 2000000;
// Control characters other than tab and newline, which no one types into a book.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** A refusal, with the HTTP status to answer it with. */
export class FixError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Checks the body of a fix: { section, paragraph, before, after }, the texts of the paragraphs as shown
 * and as fixed. Returns them collapsed, without empty paragraphs in `after`, or { error }.
 */
export function parseFixInput(body) {
  const { section, paragraph, before, after } = body || {};
  if (!Number.isInteger(section) || section < 0 || !Number.isInteger(paragraph) || paragraph < 0) {
    return { error: 'section and paragraph must be whole numbers.' };
  }
  const texts = (list) => Array.isArray(list) && list.every((t) => typeof t === 'string');
  if (!texts(before) || !texts(after)) return { error: 'before and after must be lists of paragraphs.' };
  if (!before.length) return { error: 'Send the paragraphs as they were.' };
  if (before.length > MAX_BEFORE || after.length > MAX_AFTER || after.reduce((n, t) => n + t.length, 0) > MAX_AFTER_CHARS) {
    return { error: 'That is too much text to fix at once.' };
  }
  const old = before.map(collapse);
  if (old.some((t) => !t)) return { error: 'Send the paragraphs as they were.' };
  // Half a character pair could not be written to the file as it is.
  const next = after.map((t) => collapse(t.replace(CONTROL, '').toWellFormed())).filter(Boolean);
  if (old.length === next.length && old.every((t, i) => t === next[i])) return { error: 'Nothing has changed.' };
  return { section, paragraph, before: old, after: next };
}

// ---- paragraphs ----

/** A section's HTML as nodes, read the way the converters wrote it. */
export const parseSection = (html) => parseDocument(html, { decodeEntities: true });

const holdsBlock = (el) => !!findOne((e) => BLOCK_TAGS.has(e.name) && e.name !== 'br' && e.name !== 'img', el.children, true);

/** The paragraphs of a section in document order: [{ el, text }]. */
export function paragraphsOf(root) {
  const out = [];
  const visit = (nodes) => {
    for (const node of nodes) {
      if (!isTag(node) || node.name === 'pre') continue;
      if (PARAGRAPHS.has(node.name) && !holdsBlock(node)) {
        const text = collapse(textContent(node));
        if (text) out.push({ el: node, text });
      } else visit(node.children);
    }
  };
  visit(root.children);
  return out;
}

const inTable = (el) => {
  for (let p = el.parent; p; p = p.parent) if (p.name === 'table') return true;
  return false;
};

/** A paragraph's first five words, lower case: how it is recognised when its text changed further on. */
export function startKey(text) {
  return (text.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 5).join(' ').toLowerCase();
}

/**
 * Pairs the paragraphs as they were with the paragraphs as fixed, in order: first those that start the
 * same (the most of them, in order), then the rest between them by place. Returns `oldOf`, for each new
 * paragraph the old one it continues (-1 for one added), and `removed`, the old ones left over.
 */
export function pairParagraphs(before, after) {
  const a = before.map(startKey);
  const b = after.map(startKey);
  const k = a.length;
  const m = b.length;
  // most[i][j]: how many of a[i..] and b[j..] can be matched by their starts.
  const most = Array.from({ length: k + 1 }, () => new Array(m + 1).fill(0));
  for (let i = k - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      most[i][j] = a[i] && a[i] === b[j] ? most[i + 1][j + 1] + 1 : Math.max(most[i + 1][j], most[i][j + 1]);
    }
  }
  const matches = [];
  for (let i = 0, j = 0; i < k && j < m;) {
    if (a[i] && a[i] === b[j]) matches.push([i++, j++]);
    else if (most[i + 1][j] >= most[i][j + 1]) i++;
    else j++;
  }
  const oldOf = new Array(m).fill(-1);
  const removed = [];
  let i0 = 0;
  let j0 = 0;
  for (const [i, j] of [...matches, [k, m]]) {
    const n = Math.min(i - i0, j - j0);
    for (let d = 0; d < n; d++) oldOf[j0 + d] = i0 + d;
    for (let x = i0 + n; x < i; x++) removed.push(x);
    if (j < m) oldOf[j] = i;
    i0 = i + 1;
    j0 = j + 1;
  }
  return { oldOf, removed };
}

// ---- word by word ----

// Words (letters, digits and marks, with apostrophes inside), runs of white space, and any other single character.
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|\s+|[^]/gu;

/**
 * What changed between two texts, word by word: [{ start, end, text }], the characters start to end of
 * `before` replaced by `text` (a deletion when it is empty, an insertion when start is end), in order.
 * Only the characters that differ are in a change.
 */
export function diffText(before, after) {
  const a = before.match(TOKEN) || [];
  const b = after.match(TOKEN) || [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (!n && !m) return [];
  const startAt = a.slice(0, pre).join('').length;
  if (n * m > MAX_CELLS) return [trimChange(before, { start: 0, end: before.length, text: after })];
  // Tokens as numbers, so the table compares numbers.
  const ids = new Map();
  const id = (t) => { if (!ids.has(t)) ids.set(t, ids.size); return ids.get(t); };
  const A = a.slice(pre, pre + n).map(id);
  const B = b.slice(pre, pre + m).map(id);
  // most[i * w + j]: the longest run of tokens A[i..] and B[j..] have in common.
  const w = m + 1;
  const most = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      most[i * w + j] = A[i] === B[j] ? most[(i + 1) * w + j + 1] + 1 : Math.max(most[(i + 1) * w + j], most[i * w + j + 1]);
    }
  }
  const changes = [];
  let change = null;
  let at = startAt;
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && A[i] === B[j]) {
      if (change) changes.push(change);
      change = null;
      at += a[pre + i].length;
      i++;
      j++;
    } else if (j >= m || (i < n && most[(i + 1) * w + j] >= most[i * w + j + 1])) {
      change ??= { start: at, end: at, text: '' };
      at += a[pre + i].length;
      change.end = at;
      i++;
    } else {
      change ??= { start: at, end: at, text: '' };
      change.text += b[pre + j];
      j++;
    }
  }
  if (change) changes.push(change);
  return mergeChanges(before, changes.map((c) => trimChange(before, c))).filter((c) => c.end > c.start || c.text);
}

// A stretch the same in both texts that is no longer than the changes on both sides of it is taken into
// them, so a word or a mark that happens to be in both does not cut a passage replaced as a whole into
// pieces: a passage moved elsewhere is then found whole (see applyFix), and new words go in one place.
function mergeChanges(before, changes) {
  const size = (c) => Math.max(c.end - c.start, c.text.length);
  const out = [];
  for (const c of changes) {
    const last = out[out.length - 1];
    const same = last && before.slice(last.end, c.start);
    if (last && same.length <= size(last) && same.length <= size(c)) {
      out[out.length - 1] = trimChange(before, { start: last.start, end: c.end, text: last.text + same + c.text });
    } else out.push(c);
  }
  return out;
}

// Leaves out the characters a change begins and ends with that are the same before and after it.
function trimChange(before, { start, end, text }) {
  const old = before.slice(start, end);
  const most = Math.min(old.length, text.length);
  let p = 0;
  while (p < most && old[p] === text[p]) p++;
  let s = 0;
  while (s < most - p && old[old.length - 1 - s] === text[text.length - 1 - s]) s++;
  return { start: start + p, end: end - s, text: text.slice(p, text.length - s) };
}

// ---- the DOM ----

const textNode = (data, parent = null) => ({ type: ElementType.Text, data, parent });
const element = (name, attribs, parent = null) => ({ type: ElementType.Tag, name, attribs, children: [], parent });
const withoutId = ({ id, ...attribs }) => attribs;
const isMark = (e) => e.name === 'span' && /(^|\s)pg(\s|$)/.test(e.attribs.class || '');
// What is not text but stays where it is when the text around it goes.
const isFixture = (e) => e.name === 'img' || !!e.attribs.id || isMark(e);
const keepsEmpty = (e) => isFixture(e) || e.name === 'br' || !!findOne((d) => isFixture(d) || d.name === 'br', e.children, true);

function detach(node) {
  const siblings = node.parent?.children;
  const at = siblings ? siblings.indexOf(node) : -1;
  if (at >= 0) siblings.splice(at, 1);
  node.parent = null;
}
function insertAt(parent, index, nodes) {
  for (const n of nodes) n.parent = parent;
  parent.children.splice(index, 0, ...nodes);
}
const insertAfter = (ref, nodes) => insertAt(ref.parent, ref.parent.children.indexOf(ref) + 1, nodes);
const insertBefore = (ref, nodes) => insertAt(ref.parent, ref.parent.children.indexOf(ref), nodes);

function textNodesOf(el, out = []) {
  for (const c of el.children) {
    if (isText(c)) out.push(c);
    else if (isTag(c)) textNodesOf(c, out);
  }
  return out;
}

/**
 * Where each character of a paragraph's collapsed text comes from in its text nodes: character i is
 * raw[from[i]] up to raw[to[i]], raw being the text nodes one after the other. A space covers its whole
 * run of white space, which may go across text nodes.
 */
function textMap(el) {
  const nodes = [];
  let raw = '';
  for (const node of textNodesOf(el)) {
    nodes.push({ node, start: raw.length, length: node.data.length });
    raw += node.data;
  }
  const from = [];
  const to = [];
  for (const m of raw.matchAll(/\s+|\S/g)) {
    from.push(m.index);
    to.push(m.index + m[0].length);
  }
  // White space before and after the text is not in it.
  let first = 0;
  let last = from.length;
  if (first < last && /\s/.test(raw[from[first]])) first++;
  if (last > first && /\s/.test(raw[from[last - 1]])) last--;
  return { el, nodes, from: from.slice(first, last), to: to.slice(first, last) };
}

// The text node holding the raw character at `pos`, or, with `ending`, the one ending at `pos`.
function locate(map, pos, ending = false) {
  let lo = 0;
  let hi = map.nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const n = map.nodes[mid];
    if (ending ? n.start < pos : n.start <= pos) lo = mid; else hi = mid - 1;
  }
  const n = map.nodes[lo];
  return { node: n.node, offset: pos - n.start };
}

function depthIn(node, el) {
  let d = 0;
  for (let p = node.parent; p && p !== el; p = p.parent) d++;
  return d;
}

// Takes the raw characters `from` up to `to` out of the paragraph's text nodes.
function removeRaw(map, from, to) {
  for (const n of map.nodes) {
    const a = Math.max(from, n.start);
    const b = Math.min(to, n.start + n.length);
    if (a < b) n.node.data = n.node.data.slice(0, a - n.start) + n.node.data.slice(b - n.start);
  }
}

// Puts text, or a copy of moved text (see applyFix), at a place in a text node.
function put({ node, offset }, { lead, nodes, trail }) {
  const rest = node.data.slice(offset);
  if (!nodes.length) {
    node.data = node.data.slice(0, offset) + lead + trail + rest;
    return;
  }
  node.data = node.data.slice(0, offset) + lead;
  insertAfter(node, trail + rest ? [...nodes, textNode(trail + rest)] : nodes);
}

/** Writes one change (see diffText) into a paragraph, through its map. */
function applyChange(map, change) {
  const { from, to } = map;
  let place;
  if (change.end > change.start) {
    // New words go where the first of the words they replace was, and take its formatting.
    place = locate(map, from[change.start]);
    removeRaw(map, from[change.start], to[change.end - 1]);
  } else if (change.start === 0) {
    place = locate(map, from[0]);
  } else if (change.start === from.length) {
    place = locate(map, to[from.length - 1], true);
  } else {
    // Between two text nodes, the one in fewer inline elements, so words added at the edge of italics are plain.
    const before = locate(map, to[change.start - 1], true);
    const after = locate(map, from[change.start]);
    place = before.node === after.node || depthIn(before.node, map.el) <= depthIn(after.node, map.el) ? before : after;
  }
  if (change.content) put(place, change.content);
}

/**
 * A copy of the part of a paragraph from raw character `from` up to `to`, the way Range.cloneContents
 * copies it: an element cut by the edges is copied with only its part. Only text and the elements around
 * it are copied, without ids: pictures, anchors and page marks stay where they were.
 */
function copyRange(el, from, to) {
  let pos = 0;
  const copy = (node) => {
    if (isText(node)) {
      const start = pos;
      pos += node.data.length;
      const a = Math.max(from, start);
      const b = Math.min(to, pos);
      return a < b ? textNode(node.data.slice(a - start, b - start)) : null;
    }
    if (!isTag(node)) return null;
    const out = element(node.name, withoutId(node.attribs));
    for (const c of node.children) {
      const part = copy(c);
      if (part) insertAt(out, out.children.length, [part]);
    }
    return out.children.length ? out : null;
  };
  return el.children.map(copy).filter(Boolean);
}

// Takes out the inline elements of a paragraph that had text and have none now, unless they hold what is not text.
function removeEmptied(el, hadText) {
  for (const child of [...el.children]) {
    if (!isTag(child)) continue;
    removeEmptied(child, hadText);
    if (hadText.has(child) && !textContent(child) && !keepsEmpty(child)) detach(child);
  }
}

/**
 * Applies a fix to a section's nodes: the `count` paragraphs from number `start` become the paragraphs
 * `after` (collapsed text; none removes them). Returns the headings whose text changed, [{ from, to }].
 * Throws a FixError when the fix cannot be made; `root` may then be half changed and must not be kept.
 *
 * Old and new paragraphs are paired (pairParagraphs), and each pair changed word by word (diffText),
 * so the words not changed keep their formatting. New words take the formatting of the words they
 * replace. Text taken out in one place and put in another, such as a sentence moved back from a
 * footnote, is copied with its formatting. A paragraph left over is removed, unless it holds a picture,
 * an anchor or a page mark, which stay. A new paragraph takes the look of the one before it.
 */
export function applyFix(root, start, count, after) {
  const paras = paragraphsOf(root);
  const run = paras.slice(start, start + count);
  if (!count || run.length !== count) throw new FixError(409, STALE);
  if ((count !== 1 || after.length !== 1) && run.some((p) => inTable(p.el))) {
    throw new FixError(400, 'A paragraph in a table is fixed on its own.');
  }
  const { oldOf, removed } = pairParagraphs(run.map((p) => p.text), after);
  const maps = run.map((p) => textMap(p.el));
  const hadText = new Set();
  for (const p of run) for (const e of findAll(() => true, p.el.children)) if (textContent(e)) hadText.add(e);

  // What each pair changes, and the text taken out of the passage.
  const edits = [];
  const deleted = [];
  after.forEach((text, j) => {
    const i = oldOf[j];
    if (i < 0) return;
    const changes = diffText(run[i].text, text);
    edits.push({ i, j, changes });
    for (const c of changes) if (c.end > c.start) deleted.push({ i, start: c.start, text: run[i].text.slice(c.start, c.end) });
  });
  for (const i of removed) deleted.push({ i, start: 0, text: run[i].text });

  // Text put in that was taken out elsewhere keeps its formatting: a copy of it goes in, not plain text.
  // Copied before anything changes, while the maps still hold.
  const content = (text) => {
    const core = text.trim();
    if (core.length >= MOVED_MIN) {
      for (const d of deleted) {
        const at = d.text.indexOf(core);
        if (at < 0) continue;
        const { from, to } = maps[d.i];
        const nodes = copyRange(run[d.i].el, from[d.start + at], to[d.start + at + core.length - 1]);
        if (!nodes.length) break;
        return { lead: text.slice(0, text.length - text.trimStart().length), nodes, trail: text.slice(text.trimEnd().length) };
      }
    }
    return { lead: text, nodes: [], trail: '' };
  };
  for (const { changes } of edits) for (const c of changes) if (c.text) c.content = content(c.text);
  const added = after.map((text, j) => (oldOf[j] < 0 ? content(text) : null));

  // The changes, from the last to the first, so the places of those before them still hold.
  for (const { i, changes } of edits) for (let x = changes.length - 1; x >= 0; x--) applyChange(maps[i], changes[x]);

  // New paragraphs, right after the one before them, or before the first old one when they come first.
  const els = [];
  after.forEach((text, j) => {
    if (oldOf[j] >= 0) { els[j] = run[oldOf[j]].el; return; }
    const base = j ? els[j - 1] : run[0].el;
    const el = HEADING.test(base.name) ? element('p', {}) : element(base.name, withoutId(base.attribs));
    insertAt(el, 0, added[j].nodes.length ? added[j].nodes : [textNode(text)]);
    if (j) insertAfter(base, [el]); else insertBefore(base, [el]);
    els[j] = el;
  });

  // Paragraphs left over lose their text. One holding a picture, an anchor or a page mark stays for them,
  // else it goes, with what it leaves empty around it, such as a list item.
  for (const i of removed) {
    const { el } = run[i];
    for (const t of textNodesOf(el)) detach(t);
    removeEmptied(el, hadText);
    if (el.attribs.id || findOne(isFixture, el.children, true)) continue;
    let parent = el.parent;
    detach(el);
    while (isTag(parent) && isEmptyNode(parent)) {
      const up = parent.parent;
      detach(parent);
      parent = up;
    }
  }
  for (const { i } of edits) {
    removeEmptied(run[i].el, hadText);
    for (const t of textNodesOf(run[i].el)) if (!t.data) detach(t);
  }

  // A guard against mistakes here: the section must now read as asked, and the same everywhere else.
  const texts = paragraphsOf(root).map((p) => p.text);
  const expected = [...paras.slice(0, start).map((p) => p.text), ...after, ...paras.slice(start + count).map((p) => p.text)];
  if (texts.length !== expected.length || texts.some((t, x) => t !== expected[x])) throw new FixError(500, 'The text could not be fixed.');

  const renames = [];
  for (const { i, j } of edits) {
    if (HEADING.test(run[i].el.name) && run[i].text !== after[j]) renames.push({ from: run[i].text, to: after[j] });
  }
  return renames;
}

/** Applies a fix to a section's HTML (see applyFix). Returns { html, renames, nodes }, `nodes` the fixed section. */
export function fixHtml(html, start, count, after) {
  const doc = parseSection(html);
  const renames = applyFix(doc, start, count, after);
  return { html: serialize(doc.children), renames, nodes: doc.children };
}

// ---- finding a fix again ----

/** The paragraph numbers where the texts `want` follow one another in `texts`. */
export function runsOf(texts, want) {
  const out = [];
  for (let i = 0; i + want.length <= texts.length; i++) if (want.every((t, j) => texts[i + j] === t)) out.push(i);
  return out;
}

/**
 * Finds the paragraphs a stored fix was made to, among sections [{ section, texts }]: where its old texts
 * are, the place whose paragraphs before and after read as they did first, then one in the same section,
 * then the nearest paragraph number. Returns { section, index }, or null when the text is not there.
 */
export function findRun(sections, fix) {
  let best = null;
  const better = (a, b) => {
    for (let x = 0; x < a.length; x++) if (a[x] !== b[x]) return a[x] > b[x];
    return false;
  };
  for (const { section, texts } of sections) {
    for (const index of runsOf(texts, fix.before)) {
      const score = [
        ((texts[index - 1] ?? '') === fix.contextBefore) + ((texts[index + fix.before.length] ?? '') === fix.contextAfter),
        section === fix.section ? 1 : 0,
        -Math.abs(index - fix.paragraph),
      ];
      if (!best || better(score, best.score)) best = { section, index, score };
    }
  }
  return best && { section: best.section, index: best.index };
}

// ---- positions ----

/**
 * A section as the reader counts places in it, one character for each it counts: indexNodes() in
 * public/js/reader.js counts every text node by its length and every picture as one, and PDF page marks
 * as nothing. This must stay in step with it. The browser reads a section without carriage returns and
 * without a newline right after <pre>.
 */
export function positionText(nodes) {
  let out = '';
  const visit = (list, parent) => {
    list.forEach((n, i) => {
      if (isText(n)) {
        let data = n.data.replace(/\r\n?/g, '\n');
        if (i === 0 && parent?.name === 'pre' && data.startsWith('\n')) data = data.slice(1);
        out += data;
      } else if (isTag(n)) {
        if (n.name === 'img') out += '\uFFFC';
        else visit(n.children, n);
      }
    });
  };
  visit(nodes, null);
  return out;
}

/**
 * How places move when a section changes from `before` to `after` (from positionText): those after the
 * change move by `delta`, and those inside it go to its `start`.
 */
export function positionShift(before, after) {
  const most = Math.min(before.length, after.length);
  let p = 0;
  while (p < most && before[p] === after[p]) p++;
  let s = 0;
  while (s < most - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return { start: p, end: before.length - s, delta: after.length - before.length };
}

/** A place in a section after a change (see positionShift). */
export function shiftOffset(offset, { start, end, delta }) {
  if (offset >= end) return Math.max(0, offset + delta);
  if (offset > start) return start;
  return offset;
}

// ---- the book's manifest ----

/**
 * Gives a renamed chapter its new title in the contents, at any depth, where an entry for the section
 * reads as the old title, and in the section titles from it on while they read as the old title.
 */
export function renameTitles(manifest, section, renames) {
  const visit = (entries, from, to) => {
    for (const e of entries || []) {
      if (e.section === section && collapse(e.title || '') === from) e.title = to;
      visit(e.children, from, to);
    }
  };
  for (const { from, to } of renames) {
    visit(manifest.toc, from, to);
    for (let i = section; i < manifest.sections.length && collapse(manifest.sections[i].title || '') === from; i++) manifest.sections[i].title = to;
  }
}

// Where each section starts, and the whole length, from their lengths.
function restack(manifest) {
  let at = 0;
  for (const s of manifest.sections) {
    s.start = at;
    at += s.chars;
  }
  manifest.totalChars = at;
}

// Written whole or not at all: a reader never gets half a file.
async function writeAtomic(file, data) {
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temp, data);
  try {
    await fsp.rename(temp, file);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err;
  }
}

export function createFixes(db, config, log = console) {
  const stmts = {
    book: db.prepare('SELECT id, status FROM books WHERE id = ?'),
    list: db.prepare(`SELECT f.*, u.display_name FROM text_fixes f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.book_id = ? ORDER BY f.id DESC`),
    get: db.prepare(`SELECT f.*, u.display_name FROM text_fixes f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.id = ? AND f.book_id = ?`),
    all: db.prepare('SELECT * FROM text_fixes WHERE book_id = ? ORDER BY id'),
    // The other fixes in a section, applied, in the order they were made.
    others: db.prepare('SELECT * FROM text_fixes WHERE book_id = ? AND section = ? AND applied = 1 AND id != ? ORDER BY id'),
    insert: db.prepare(`INSERT INTO text_fixes (book_id, old_text, new_text, context_before, context_after, section, paragraph, renames, applied, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`),
    place: db.prepare('UPDATE text_fixes SET applied = 1, section = ?, paragraph = ?, context_before = ?, context_after = ?, renames = ? WHERE id = ?'),
    notApplied: db.prepare('UPDATE text_fixes SET applied = 0 WHERE id = ?'),
    delete: db.prepare('DELETE FROM text_fixes WHERE id = ?'),
    setBook: db.prepare('UPDATE books SET total_chars = ?, converted_at = ? WHERE id = ?'),
    // Places after the change move with the text, and those inside it go to where it starts. When they
    // were last read stays as it was.
    shiftProgress: db.prepare(`UPDATE progress SET offset = CASE WHEN offset >= ? THEN MAX(0, offset + ?) WHEN offset > ? THEN ? ELSE offset END
      WHERE book_id = ? AND section = ?`),
    shiftBookmarks: db.prepare(`UPDATE bookmarks SET offset = CASE WHEN offset >= ? THEN MAX(0, offset + ?) WHEN offset > ? THEN ? ELSE offset END
      WHERE book_id = ? AND section = ?`),
  };

  // One at a time per book: a fix, an undo, a conversion and a delete never write a book's files together.
  const locks = new Map();
  function withBookLock(id, fn) {
    const result = (locks.get(id) || Promise.resolve()).then(() => fn());
    const done = result.catch(() => {});
    locks.set(id, done);
    done.then(() => { if (locks.get(id) === done) locks.delete(id); });
    return result;
  }

  const bookDir = (id) => path.join(config.booksDir, id);
  const sectionFile = (id, i) => path.join(bookDir(id), 'sections', `${i}.html`);
  const unfixedFile = (id, i) => path.join(bookDir(id), UNFIXED_DIR, `${i}.html`);
  const manifestFile = (id) => path.join(bookDir(id), 'book.json');
  const readIfThere = (file) => fsp.readFile(file, 'utf8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });

  const shape = (f) => ({
    id: f.id, before: JSON.parse(f.old_text), after: JSON.parse(f.new_text), applied: !!f.applied,
    section: f.section, paragraph: f.paragraph, createdAt: f.created_at, by: f.display_name ?? null,
  });
  const stored = (f) => ({
    id: f.id, before: JSON.parse(f.old_text), after: JSON.parse(f.new_text),
    contextBefore: f.context_before, contextAfter: f.context_after, section: f.section, paragraph: f.paragraph,
  });

  function checkBook(id) {
    const b = stmts.book.get(id);
    if (!b) throw new FixError(404, 'No such book');
    if (b.status === 'processing') throw new FixError(409, 'The book is being converted. Try again in a moment.');
    if (b.status !== 'ready') throw new FixError(409, 'The book could not be converted, so its text cannot be fixed.');
  }

  function shiftPositions(id, section, shift) {
    if (shift.start === shift.end && !shift.delta) return;
    const args = [shift.end, shift.delta, shift.start, shift.start, id, section];
    stmts.shiftProgress.run(...args);
    stmts.shiftBookmarks.run(...args);
  }

  /**
   * Applies a stored fix where it is found among `sections` ([{ section, html, texts }], changed in
   * place). Returns its new place, { section, paragraph, contextBefore, contextAfter, renames }, or null
   * when its text is not there or it cannot be made.
   */
  function applyStored(fix, sections) {
    const found = findRun(sections, fix);
    if (!found) return null;
    const sec = sections.find((s) => s.section === found.section);
    let result;
    try {
      result = fixHtml(sec.html, found.index, fix.before.length, fix.after);
    } catch (err) {
      if (!(err instanceof FixError)) throw err;
      if (err.status === 500) log.error?.(`[fixes] fix ${fix.id} could not be applied in section ${found.section}`);
      return null;
    }
    const place = {
      section: found.section, paragraph: found.index, renames: result.renames,
      contextBefore: sec.texts[found.index - 1] ?? '', contextAfter: sec.texts[found.index + fix.before.length] ?? '',
    };
    sec.html = result.html;
    sec.nodes = result.nodes;
    sec.texts = paragraphsOf({ children: result.nodes }).map((p) => p.text);
    sec.fixed = true;
    return place;
  }
  const savePlace = (id, p) => stmts.place.run(p.section, p.paragraph, p.contextBefore, p.contextAfter, JSON.stringify(p.renames), id);

  /** The fixes of a book, newest first. */
  const list = (bookId) => stmts.list.all(bookId).map(shape);

  /**
   * Makes a fix (see parseFixInput for `input`) by user `userId`. Returns { fix, manifest }, or throws a
   * FixError.
   */
  async function create(bookId, input, userId) {
    checkBook(bookId);
    return withBookLock(bookId, async () => {
      checkBook(bookId);
      const manifestJson = await readIfThere(manifestFile(bookId));
      const manifest = manifestJson && JSON.parse(manifestJson);
      const S = input.section;
      const html = manifest?.sections[S] && await readIfThere(sectionFile(bookId, S));
      if (html == null) throw new FixError(409, STALE);
      const doc = parseSection(html);
      const before = positionText(doc.children);
      const texts = paragraphsOf(doc).map((p) => p.text);
      let start = input.paragraph;
      if (!input.before.every((t, j) => texts[start + j] === t)) {
        const found = runsOf(texts, input.before);
        if (found.length !== 1) throw new FixError(409, STALE);
        start = found[0];
      }
      const contextBefore = texts[start - 1] ?? '';
      const contextAfter = texts[start + input.before.length] ?? '';
      let renames;
      try {
        renames = applyFix(doc, start, input.before.length, input.after);
      } catch (err) {
        if (err instanceof FixError && err.status === 500) log.error?.(`[fixes] a fix to ${bookId} section ${S} could not be applied`);
        throw err;
      }
      const fixed = serialize(doc.children);
      const shift = positionShift(before, positionText(doc.children));

      manifest.sections[S].chars = textLength(doc.children);
      restack(manifest);
      renameTitles(manifest, S, renames);
      manifest.convertedAt = Math.max(Date.now(), (manifest.convertedAt || 0) + 1);

      const unfixed = unfixedFile(bookId, S);
      const snapshot = (await readIfThere(unfixed)) == null;
      let fixId;
      try {
        if (snapshot) {
          await fsp.mkdir(path.dirname(unfixed), { recursive: true });
          await writeAtomic(unfixed, html);
        }
        await writeAtomic(sectionFile(bookId, S), fixed);
        await writeAtomic(manifestFile(bookId), JSON.stringify(manifest));
        transaction(db, () => {
          if (!stmts.book.get(bookId)) throw new FixError(404, 'No such book'); // deleted meanwhile
          fixId = Number(stmts.insert.run(bookId, JSON.stringify(input.before), JSON.stringify(input.after), contextBefore, contextAfter,
            S, start, JSON.stringify(renames), userId ?? null, now()).lastInsertRowid);
          stmts.setBook.run(manifest.totalChars, manifest.convertedAt, bookId);
          shiftPositions(bookId, S, shift);
        });
      } catch (err) {
        // Put the book back as it was.
        await writeAtomic(sectionFile(bookId, S), html).catch(() => {});
        await writeAtomic(manifestFile(bookId), manifestJson).catch(() => {});
        if (snapshot) await fsp.rm(unfixed, { force: true });
        throw err;
      }
      return { fix: shape(stmts.get.get(fixId, bookId)), manifest };
    });
  }

  /**
   * Undoes a fix: its section is made again from the section as converted and the other fixes in it.
   * One not applied is only forgotten. Returns { manifest }, or throws a FixError.
   */
  async function undo(bookId, fixId) {
    return withBookLock(bookId, async () => {
      const row = stmts.get.get(fixId, bookId);
      if (!row) throw new FixError(404, 'No such fix');
      if (!row.applied) {
        stmts.delete.run(row.id);
        return { manifest: JSON.parse(await readIfThere(manifestFile(bookId)) || 'null') };
      }
      checkBook(bookId);
      const S = row.section;
      const unfixed = await readIfThere(unfixedFile(bookId, S));
      if (unfixed == null) throw new FixError(409, 'This fix cannot be undone. Convert the book again first.');
      const manifestJson = await readIfThere(manifestFile(bookId));
      const current = await readIfThere(sectionFile(bookId, S));
      if (manifestJson == null || current == null || !JSON.parse(manifestJson).sections[S]) {
        throw new FixError(409, 'This fix cannot be undone. Convert the book again first.');
      }
      const manifest = JSON.parse(manifestJson);

      // The section as converted, with the other fixes in it applied again in order.
      const others = stmts.others.all(bookId, S, row.id).map(stored);
      const nodes = parseSection(unfixed).children;
      const sec = { section: S, html: unfixed, nodes, texts: paragraphsOf({ children: nodes }).map((p) => p.text) };
      const places = [];
      for (const fix of others) {
        const place = applyStored(fix, [sec]);
        if (!place) throw new FixError(409, 'A later fix changed this text. Undo that one first.');
        places.push([fix.id, place]);
      }
      const shift = positionShift(positionText(parseSection(current).children), positionText(sec.nodes));

      manifest.sections[S].chars = textLength(sec.nodes);
      restack(manifest);
      renameTitles(manifest, S, JSON.parse(row.renames).reverse().map(({ from, to }) => ({ from: to, to: from })));
      manifest.convertedAt = Math.max(Date.now(), (manifest.convertedAt || 0) + 1);

      try {
        await writeAtomic(sectionFile(bookId, S), sec.html);
        await writeAtomic(manifestFile(bookId), JSON.stringify(manifest));
        transaction(db, () => {
          if (!stmts.book.get(bookId)) throw new FixError(404, 'No such book'); // deleted meanwhile
          stmts.delete.run(row.id);
          for (const [id, place] of places) savePlace(id, place);
          stmts.setBook.run(manifest.totalChars, manifest.convertedAt, bookId);
          shiftPositions(bookId, S, shift);
        });
      } catch (err) {
        await writeAtomic(sectionFile(bookId, S), current).catch(() => {});
        await writeAtomic(manifestFile(bookId), manifestJson).catch(() => {});
        throw err;
      }
      // The copy as converted is kept only while a fix is in the section.
      if (!others.length) await fsp.rm(unfixedFile(bookId, S), { force: true });
      return { manifest };
    });
  }

  /**
   * After a book is converted (see processing/queue.js, under the book's lock): applies every fix of the
   * book again, in the order they were made, each where its text is found, and marks those not found as
   * not applied. Writes the fixed sections, keeping each as converted in unfixed/ first, and the manifest
   * with their new lengths. Positions are left as they are: they were counted in the fixed text.
   * Returns { manifest, commit }, `commit` saving the fixes' new places, to run in the same transaction
   * that saves the book.
   */
  async function reapply(bookId, dir, manifest) {
    await fsp.rm(path.join(dir, UNFIXED_DIR), { recursive: true, force: true });
    const rows = stmts.all.all(bookId);
    if (!rows.length) return { manifest, commit() {} };
    // Only the paragraphs' texts are kept for each section, to find the fixes in; a section is read whole
    // again when a fix is applied to it.
    const sections = [];
    for (let i = 0; i < manifest.sections.length; i++) {
      const html = await fsp.readFile(path.join(dir, 'sections', `${i}.html`), 'utf8');
      sections.push({ section: i, html, converted: html, nodes: null, fixed: false, texts: paragraphsOf(parseSection(html)).map((p) => p.text) });
    }
    const results = rows.map((row) => {
      const place = applyStored(stored(row), sections);
      if (place) renameTitles(manifest, place.section, place.renames);
      return [row.id, place];
    });
    // Each section a fix was applied to is kept as converted, even when a later fix put it back as it was.
    const changed = sections.filter((s) => s.fixed);
    if (changed.length) await fsp.mkdir(path.join(dir, UNFIXED_DIR), { recursive: true });
    for (const s of changed) {
      await writeAtomic(path.join(dir, UNFIXED_DIR, `${s.section}.html`), s.converted);
      await writeAtomic(path.join(dir, 'sections', `${s.section}.html`), s.html);
      manifest.sections[s.section].chars = textLength(s.nodes);
    }
    restack(manifest);
    await writeAtomic(path.join(dir, 'book.json'), JSON.stringify(manifest));
    const missed = results.filter(([, place]) => !place).length;
    if (missed) log.info?.(`[fixes] ${bookId}: ${missed} of ${rows.length} fix(es) no longer found in the text`);
    return {
      manifest,
      commit() {
        for (const [id, place] of results) {
          if (place) savePlace(id, place); else stmts.notApplied.run(id);
        }
      },
    };
  }

  return { withBookLock, list, create, undo, reapply };
}
