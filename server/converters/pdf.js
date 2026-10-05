// PDF -> reflowable text. Pages are merged into normal-sized sections; invisible page markers
// (<span class="pg" id="pgN">) let the "original pages" view and the reflowed view share positions.
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeDocument, isSceneBreak, SCENE_BREAK, chooseCuts } from './html.js';
import { assembleSections, SECTION_BUDGET, isChapterTitle, isChapterLine, chooseTitles } from './bundle.js';
import { encodePng } from './png.js';
import { isWatermark } from './watermarks.js';
import { seriesFromXmp } from './series.js';

const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const BULLET_RE = /^([•·▪◦‣■□●○◆◇➢➤►▸-]|[-–—*]|\(?\d{1,3}[.)]|[a-zA-Z][.)]|[ivxIVX]{1,5}[.)])\s+\S/;
const BULLET_ONLY_RE = /^([•·▪◦‣■□●○◆◇➢➤►▸]|[-–—])$/; // a lone "*" is a scene break (see isSceneBreak)
const LEADER_RE = /(\.\s?){4,}\s*[\divxlc]{1,5}\s*$/i; // "Chapter title ........ 123" (printed tables of contents)
// Words that usually keep their hyphen when a line breaks after it ("self-", "four-", "non-").
const COMPOUND_PREFIXES = new Set(['self', 'well', 'non', 'anti', 'multi', 'semi', 'half', 'quasi', 'pseudo', 'cross', 'high', 'low', 'long', 'short', 'full', 'part', 'real', 'free', 'open', 'first', 'second', 'third', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'single', 'double', 'triple', 'large', 'small', 'old', 'new', 'left', 'right', 'hand', 'hard', 'soft', 'wide', 'deep', 'best', 'worst', 'vice', 'so', 'ever', 'ill']);

function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.floor(a.length / 2)];
}

function styleOf(styles, fontName) {
  const fam = `${styles?.[fontName]?.fontFamily || ''} ${styles?.[fontName]?.realName || ''}`;
  return { italic: /italic|oblique/i.test(fam), bold: /bold|black|heavy|semibold|demibold/i.test(fam) };
}

/** Join two line fragments where the first ends with a hyphen. */
export function joinHyphenated(prevText, nextText) {
  const m = /(\S+?)-$/.exec(prevText);
  if (!m) return null;
  const before = m[1];
  const lowerNext = /^[a-z]/.test(nextText);
  if (/\d$/.test(before) || /^[A-Z0-9]/.test(nextText)) return { text: prevText + nextText, dropHyphen: false };
  if (!lowerNext) return { text: prevText + nextText, dropHyphen: false };
  const stem = before.replace(/^.*[^A-Za-z]/, '').toLowerCase();
  if (COMPOUND_PREFIXES.has(stem) || /[A-Za-z]-[A-Za-z]/.test(before)) return { text: prevText + nextText, dropHyphen: false };
  return { text: prevText.slice(0, -1) + nextText, dropHyphen: true };
}

function textRuns(items, styles) {
  const runs = [];
  for (const it of items) {
    if (it.str == null || !it.transform) continue;
    const size = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || it.height || 10;
    runs.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, size, font: it.fontName, ...styleOf(styles, it.fontName) });
  }
  return runs;
}
const runsBodySize = (runs) => median(runs.filter((r) => r.str.trim().length > 3).map((r) => r.size)) || median(runs.map((r) => r.size));

/** The body text size of one page on its own; the document's median of these is what pageLines wants. */
export function pageBodySize(items) {
  const runs = textRuns(items);
  return runs.length ? runsBodySize(runs) : NaN;
}

/**
 * Group a page's text runs into lines. Small raised runs (footnote markers) are attached to
 * the line they belong to as superscripts instead of forming lines of their own.
 * @param {object} [opts] {bodySize}: the document's body size. Without it the page's own median is used,
 *   which misjudges pages that are mostly footnotes (the markers in the body no longer look small there).
 * @returns {{lines: Array, bodySize: number}}
 */
export function pageLines(items, viewport, styles = {}, opts = {}) {
  if (opts.ocr) return ocrPageLines(items, viewport, styles);
  const runs = textRuns(items, styles);
  if (!runs.length) return { lines: [], bodySize: NaN };
  const bodySize = opts.bodySize || runsBodySize(runs);
  const isSmall = (r) => r.size < bodySize * 0.78 && r.str.trim().length <= 4;
  const big = runs.filter((r) => !isSmall(r)).sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines = [];
  for (const r of big) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) <= Math.max(2, Math.min(last.size, r.size) * 0.4)) last.items.push(r);
    else lines.push({ y: r.y, size: r.size, items: [r] });
  }
  for (const r of runs.filter(isSmall)) {
    let best = null;
    let bestD = Infinity;
    for (const l of lines) {
      const d = r.y - l.y;
      if (d >= -1.5 && d <= l.size * 0.75 && Math.abs(d) < bestD) { best = l; bestD = Math.abs(d); }
    }
    if (best) { best.items.push({ ...r, sup: r.y - best.y > best.size * 0.15 }); continue; }
    const near = lines.find((l) => Math.abs(l.y - r.y) <= Math.max(2, l.size * 0.4));
    if (near) near.items.push(r); else lines.push({ y: r.y, size: r.size, items: [r] });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    Object.assign(line, joinRuns(line.items));
    line.startsWithSup = !!line.items[0]?.sup;
    const bodyItems = line.items.filter((i) => !i.sup);
    line.x = (bodyItems[0] || line.items[0]).x;
    line.right = Math.max(...line.items.map((i) => i.x + i.w));
    line.size = median(bodyItems.map((i) => i.size)) || line.size;
    line.width = viewport.width;
    line.height = viewport.height;
  }
  return { lines: lines.filter((l) => l.text), bodySize };
}

/** A line's text and markup from its runs, left to right, with a space where the runs stand apart or one ends in a space. */
function joinRuns(items) {
  let text = '';
  let html = '';
  let prev = null;
  for (const it of items) {
    if (prev && !prev.glueNext && !it.gluePrev) {
      const gap = it.x - (prev.x + prev.w);
      if ((prev.spaceAfter || gap > Math.min(prev.size, it.size) * 0.15) && !text.endsWith(' ') && !it.str.startsWith(' ')) { text += ' '; html += ' '; }
    }
    const clean = it.str.replace(/\s+/g, ' ');
    text += clean;
    let frag = escape(clean);
    if (it.sup && clean.trim()) {
      frag = `<sup>${frag.trim()}</sup>`; // markers carry no bold/italic, whatever font the run inherited
    } else {
      if (it.bold && clean.trim()) frag = `<b>${frag}</b>`;
      if (it.italic && clean.trim()) frag = `<i>${frag}</i>`;
    }
    html += frag;
    prev = it;
  }
  return { text: text.replace(/\s+/g, ' ').trim(), html: html.replace(/\s+/g, ' ').replace(/<\/(b|i)> <\1>/g, ' ').trim() };
}

const WORDLIKE_RE = /[\p{L}\p{N}]/u;
const QUOTES_RE = /^["'`“”‘’„«»]+$/;

/**
 * Lines of an OCR text layer: the invisible text over a scanned page. Such a layer places each word by the box the OCR
 * engine drew around it and sizes it to that box, so the words of one line differ in size and height (those without
 * ascenders come out small, a quote mark sits above the line) and the spaces between them have no meaningful width.
 * Words are grouped into lines by how much their boxes overlap vertically; a line takes the median size and position
 * of its words, and no run is taken for a superscript.
 * @returns {{lines: Array, bodySize: number}}
 */
function ocrPageLines(items, viewport, styles = {}) {
  const words = [];
  for (const r of textRuns(items, styles)) {
    if (r.str.trim()) words.push({ ...r, spaceAfter: /\s$/.test(r.str), top: r.y + r.size });
    else if (words.length) words[words.length - 1].spaceAfter = true; // a space, or the end of a line, in reading order
  }
  if (!words.length) return { lines: [], bodySize: NaN };
  const wordSize = median(words.filter((w) => WORDLIKE_RE.test(w.str)).map((w) => w.size)) || median(words.map((w) => w.size));
  // A drop cap spans several lines; it is placed at the start of the first one afterwards.
  const tall = (w) => w.size > wordSize * 2.2 && w.str.trim().length <= 2;
  const lines = [];
  const setBand = (l) => {
    const core = l.items.filter((i) => WORDLIKE_RE.test(i.str));
    const ref = core.length ? core : l.items;
    l.bottom = median(ref.map((i) => i.y));
    l.top = median(ref.map((i) => i.top));
  };
  const overlap = (l, w) => (Math.min(l.top, w.top) - Math.max(l.bottom, w.y)) / Math.max(0.01, Math.min(l.top - l.bottom, w.size));
  const sorted = words.filter((w) => !tall(w)).sort((a, b) => (b.y + b.top) - (a.y + a.top) || a.x - b.x);
  for (const w of sorted) {
    let best = null;
    let bestScore = 0.5; // the boxes share at least half the height of the lower one
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
      const score = overlap(lines[i], w);
      if (score > bestScore) { best = lines[i]; bestScore = score; }
    }
    if (best) { best.items.push(w); setBand(best); } else { const l = { items: [w] }; setBand(l); lines.push(l); }
  }
  for (const w of words.filter(tall)) {
    const first = lines.find((l) => overlap(l, w) > 0.5);
    if (first) first.items.push({ ...w, dropCap: true }); else { const l = { items: [w] }; setBand(l); lines.push(l); }
  }
  // Punctuation the OCR placed apart from its line (a quote mark above it) joins the nearest line with words.
  const hasWords = (l) => l.items.some((i) => WORDLIKE_RE.test(i.str));
  for (const l of lines.filter((x) => !hasWords(x))) {
    const mid = (l.bottom + l.top) / 2;
    let near = null;
    for (const o of lines) if (o !== l && hasWords(o) && (!near || Math.abs((o.bottom + o.top) / 2 - mid) < Math.abs((near.bottom + near.top) / 2 - mid))) near = o;
    if (near && Math.abs((near.bottom + near.top) / 2 - mid) < wordSize) { near.items.push(...l.items); l.items = []; }
  }
  // A box set lower or higher than the rest can split a line in two. Pieces closer together than lines are, whose words
  // stand side by side rather than one above the other, are one line.
  const pieces = lines.filter((l) => l.items.length).sort((a, b) => (b.bottom + b.top) - (a.bottom + a.top));
  const centre = (l) => (l.bottom + l.top) / 2;
  const pitch = median(pieces.slice(1).map((l, i) => centre(pieces[i]) - centre(l)));
  const sideBySide = (a, b) => b.items.every((w) => a.items.every((v) => w.x >= v.x + v.w || v.x >= w.x + w.w));
  for (let i = 0; pieces.length >= 3 && i < pieces.length - 1; i++) {
    const [a, b] = [pieces[i], pieces[i + 1]];
    if (centre(a) - centre(b) < pitch * 0.6 && sideBySide(a, b)) { a.items.push(...b.items); b.items = []; setBand(a); pieces.splice(i + 1, 1); i--; }
  }
  const out = [];
  for (const line of lines) {
    if (!line.items.length) continue;
    line.items.sort((a, b) => a.x - b.x);
    // Specks, or the ornament of a drop cap, read as "*" before a line that carries on a sentence.
    let junk = 0;
    while (junk < line.items.length && /^[*^~|°•]+$/.test(line.items[junk].str.trim())) junk++;
    if (junk && /^\p{Ll}/u.test(line.items[junk]?.str.trim() || '')) line.items.splice(0, junk);
    // A drop cap and the rest of its word: "T" + "HE SUMMER" is "THE SUMMER".
    const cap = line.items[0].dropCap && line.items[1];
    if (cap && line.items[1].x - (line.items[0].x + line.items[0].w) < wordSize) line.items[0].glueNext = true;
    // A quote mark read as a word of its own belongs to the word it is closer to: "Why?" rather than " Why? ".
    line.items.forEach((it, k) => {
      if (!QUOTES_RE.test(it.str.trim())) return;
      const prev = line.items[k - 1];
      const next = line.items[k + 1];
      const before = prev ? it.x - (prev.x + prev.w) : Infinity;
      const after = next ? next.x - (it.x + it.w) : Infinity;
      if (after < before) it.glueNext = true; else if (prev) it.gluePrev = true;
    });
    Object.assign(line, joinRuns(line.items));
    if (!line.text) continue;
    const core = line.items.filter((i) => WORDLIKE_RE.test(i.str) && !i.dropCap);
    const ref = core.length ? core : line.items;
    line.y = median(ref.map((i) => i.y));
    line.size = median(ref.map((i) => i.size));
    line.x = line.items[0].x;
    line.right = Math.max(...line.items.map((i) => i.x + i.w));
    line.startsWithSup = false;
    line.ocr = true;
    line.width = viewport.width;
    line.height = viewport.height;
    out.push(line);
  }
  out.sort((a, b) => b.y - a.y);
  return { lines: out, bodySize: median(out.map((l) => l.size)) };
}

/**
 * Page numbers, and running heads and feet that carry one, such as "12 THE SECRET GARDEN" or "THERE IS NO ONE LEFT 13".
 * Their titles change with the chapter, so they are not repeated often enough to be caught like other running lines.
 * Such a line is the first or last on its page and starts or ends with a number that keeps step with the page count:
 * two other pages close by carry a number just as far from their own page number. A page number on its own may stand
 * a little above the foot of the page, as on the first page of a chapter.
 * @param {Array<{p: number, lines: Array}>} pages
 * @returns {Set} the lines
 */
export function numberedRunningLines(pages) {
  const found = [];
  const pagesByOffset = new Map();
  for (const { p, lines } of pages) {
    const text = lines.filter((l) => !l.image);
    for (const l of new Set([text[0], text[text.length - 1]])) {
      if (!l || l.text.length > 100) continue;
      for (const n of pageNumberCandidates(l)) {
        const offset = p - n;
        found.push({ l, p, offset });
        if (!pagesByOffset.has(offset)) pagesByOffset.set(offset, new Set());
        pagesByOffset.get(offset).add(p);
      }
    }
  }
  const out = new Set();
  for (const { l, p, offset } of found) {
    if ([...pagesByOffset.get(offset)].filter((q) => q !== p && Math.abs(q - p) <= 8).length >= 2) out.add(l);
  }
  return out;
}

/** The numbers a line may carry as its page number: all of it ("85", or "1 1 5" as OCR splits it), or, at the edge of the page, its first or last word. */
function pageNumberCandidates(l) {
  if (/^\d(\s?\d){0,3}$/.test(l.text)) return [Number(l.text.replace(/\s/g, ''))];
  if (!edgeBand(l)) return [];
  const out = [];
  const head = /^(\d(?:\s?\d){0,3})\s+\S/.exec(l.text);
  const tail = /\S\s((?:\d\s?){0,3}\d)[.,]?$/.exec(l.text);
  for (const m of [head, tail]) {
    if (!m) continue;
    out.push(Number(m[1].replace(/\s/g, '')));
    const word = m === head ? /^\d+/.exec(m[1])[0] : /\d+$/.exec(m[1])[0];
    if (word !== m[1]) out.push(Number(word)); // "IT HAS COME! 3 247": the stray 3 is not part of it
  }
  return out;
}

/**
 * What an OCR engine reads into a picture or a speck of dirt: a line without a word of two letters or digits. A
 * chapter number ("7", "IV") and a break between scenes ("* * *") stay.
 */
export function isOcrNoise(text) {
  const t = text.trim();
  return !/[\p{L}\p{N}]{2}/u.test(t) && !/^(\d{1,3}|[IVXLC]{1,6})\.?$/.test(t) && !/^([*•·.–—-]\s*){3,}$/.test(t);
}

/**
 * A line key as it would be with its page number read right: one or two short words at its start or end taken for a
 * misread number ("ib the garden" -> "# the garden"), or a number added where the OCR engine missed it.
 */
export function numberVariants(key) {
  const words = key.split(' ');
  const out = [`# ${key}`, `${key} #`];
  for (let n = 1; n <= 2 && n < words.length; n++) {
    if (words.slice(0, n).every((w) => w.length <= 3)) out.push(['#', ...words.slice(n)].join(' '));
    if (words.slice(-n).every((w) => w.length <= 3)) out.push([...words.slice(0, -n), '#'].join(' '));
  }
  return out;
}

/** Normalised key used to spot running headers and footers repeated across pages. */
export function lineKey(line) {
  return line.text.replace(/\d+(\s\d+)*/g, '#').replace(/["'`“”‘’„«»]/g, '').replace(/[\s|·•—–-]+/g, ' ').trim().toLowerCase();
}
export function edgeBand(line) {
  if (line.y > line.height * 0.86) return 'top';
  if (line.y < line.height * 0.1) return 'bottom';
  return null;
}

/**
 * Turn a page's lines (and image placeholders) into blocks (headings, paragraphs, footnotes, images).
 * @param {object} ctx {bodySize, isRunning(line) -> boolean, ocr: the lines are the OCR text of a scan,
 *   pitch: the usual distance between the lines of such text}
 */
const MARKER_ONLY_RE = /^(\d{1,3}|[*†‡§])$/; // a note number on a line of its own (the note text wrapped below it)

export function linesToBlocks(lines, ctx = {}) {
  if (!lines.length) return [];
  const textLines = lines.filter((l) => !l.image);
  const bodySize = ctx.bodySize || median(textLines.filter((l) => l.text.length > 20).map((l) => l.size)) || median(textLines.map((l) => l.size)) || 10;
  const isRunning = ctx.isRunning || (() => false);
  // Where the lines of the text start: low among them, as on a page of dialogue most long lines are first lines, indented.
  const starts = textLines.filter((l) => l.text.length > 40).map((l) => l.x).sort((a, b) => a - b);
  const leftEdge = starts.length ? starts[Math.floor(starts.length * 0.2)] : NaN;
  const rightEdge = median(textLines.filter((l) => l.text.length > 40).map((l) => l.right));
  // The sizes of OCR text are those of the boxes around its words, which vary with the letters in them: a short line of
  // tall words is as big as a small heading, and a line of short words as small as a footnote. So on a scan a heading
  // must also stand apart from the text, centred or with extra space around it; a footnote must be clearly smaller,
  // and a gap is measured against the usual distance between lines.
  const ocr = !!ctx.ocr;
  const pitch = ctx.pitch || bodySize * 1.5;
  const smallSize = bodySize * (ocr ? 0.8 : 0.92);

  // A note number printed on a line of its own (its text wrapped below it) looks like a page number
  // when it falls in the bottom band; tell them apart by size and by the small line right under it.
  const isMarkerLine = (l, i) => {
    if (!MARKER_ONLY_RE.test(l.text) || l.size >= bodySize * 0.78) return false;
    const next = lines.slice(i + 1).find((n) => !n.image);
    return !!next && next.size < smallSize && l.y - next.y < next.size * 2.2 && Math.abs(next.x - l.x) < bodySize;
  };
  const kept = lines.filter((l, i) => {
    if (l.image) return true;
    if (isWatermark(l.text)) return false;
    if (ocr && isOcrNoise(l.text)) return false;
    const band = edgeBand(l);
    if (!band) return !isRunning(l);
    if (isMarkerLine(l, i)) return true;
    if (/^[\divxlc]+$/i.test(l.text.replace(/[\s|·•—–-]/g, ''))) return false;
    if (isRunning(l)) return false;
    return true;
  });

  const startsNote = (l) => l.startsWithSup || /^\d{1,3}\s/.test(l.text) || /^[*†‡§]/.test(l.text) || MARKER_ONLY_RE.test(l.text);
  let footStart = kept.length;
  for (let i = kept.length - 1; i >= 0; i--) {
    const l = kept[i];
    if (l.image) break;
    const small = l.size < smallSize;
    if (!small) break;
    if (startsNote(l) && (!ocr || /\p{L}{2}/u.test(l.text))) footStart = i; // OCR text has no superscripts: a note is a number and words
  }
  // Space around a line is also where text meets a picture, so a heading set apart only by space must look like one.
  const standsApart = (l, i) => {
    const before = l.x - leftEdge;
    const after = rightEdge - l.right;
    const centred = before > bodySize * 2 && after > bodySize * 2 && Math.abs(before - after) < bodySize * 2;
    const above = i > 0 && !kept[i - 1].image ? kept[i - 1].y - l.y : 0;
    const below = i < kept.length - 1 && !kept[i + 1].image ? l.y - kept[i + 1].y : 0;
    const letters = l.text.replace(/\P{L}/gu, '');
    const looksLikeHeading = !/-$/.test(l.text) && (l.size > bodySize * 1.45 || letters.replace(/\P{Lu}/gu, '').length >= letters.length * 0.8);
    return centred || ((above > pitch * 1.4 || below > pitch * 1.4) && looksLikeHeading);
  };

  const blocks = [];
  let para = null;
  const flush = () => { if (para) { blocks.push(para); para = null; } };
  const startPara = (l, type = 'p') => { para = { type, text: l.text, html: l.html, firstX: l.x, bodyX: null, lines: 1, bullet: BULLET_RE.test(l.text) || BULLET_ONLY_RE.test(l.text) }; };
  const append = (l) => {
    const joined = joinHyphenated(para.text, l.text);
    if (joined) { para.text = joined.text; para.html = (joined.dropHyphen ? para.html.replace(/-(<\/(?:b|i)>)*$/, '$1') : para.html) + l.html; }
    else { para.text += ' ' + l.text; para.html += ' ' + l.html; }
    para.html = para.html.replace(/<\/(b|i)> ?<\1>/g, ' ').replace(/<\/(b|i)><\1>/g, '');
    if (para.lines === 1) para.bodyX = l.x;
    para.lines++;
  };

  for (let i = 0; i < kept.length; i++) {
    const l = kept[i];
    if (l.image) { flush(); blocks.push({ type: 'img', src: l.image, text: '' }); continue; }
    const prev = kept[i - 1] && !kept[i - 1].image ? kept[i - 1] : null;
    const inFoot = i >= footStart;
    // A scene break stands on its own, whatever its size and the lines around it.
    if (!inFoot && isSceneBreak(l.text)) { flush(); blocks.push({ type: 'break', text: '' }); continue; }
    const isHeading = !inFoot && l.size > bodySize * (ocr ? 1.1 : 1.15) && l.text.length < 120 && (!ocr || standsApart(l, i));
    const gap = prev ? prev.y - l.y : 0;
    const bigGap = !prev || gap > (ocr ? pitch * 1.4 : Math.max(prev.size, l.size) * 1.7);
    const em = bodySize * 0.6;

    if (isHeading) {
      flush();
      const level = l.size > bodySize * 1.6 ? 1 : 2;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'h' && Math.abs(last.size - l.size) < 0.5 && !bigGap) { last.text += ' ' + l.text; last.html += ' ' + l.html; }
      else blocks.push({ type: 'h', level, text: l.text, html: l.html, size: l.size });
      continue;
    }
    if (LEADER_RE.test(l.text)) {
      // A printed contents line: keep it on its own, left-aligned, with the dots condensed.
      const html = l.html.replace(/(\.\s?){4,}/g, ' … ');
      const text = l.text.replace(/(\.\s?){4,}/g, ' … ');
      if (para && para.type === 'p' && para.lines === 1 && !LEADER_RE.test(para.text) && !bigGap && !/[.!?]$/.test(para.text)) {
        // The entry's title wrapped onto the previous line.
        blocks.push({ type: 'leader', text: `${para.text} ${text}`, html: `${para.html} ${html}` });
        para = null;
      } else { flush(); blocks.push({ type: 'leader', text, html }); }
      continue;
    }
    if (inFoot) {
      // A line opening with a plain number only starts a new note when it carries the next number:
      // "…twice as powerful as a level" / "11 anything." is a wrapped note, not note 11.
      let marker = startsNote(l);
      const plainNum = !l.startsWithSup && /^(\d{1,3})\s/.exec(l.text);
      if (plainNum && para && para.type === 'fn') {
        const prevNum = /^(\d{1,3})(?!\d)/.exec(para.text);
        if (prevNum && Number(plainNum[1]) !== Number(prevNum[1]) + 1) marker = false;
      }
      if (MARKER_ONLY_RE.test(l.text)) {
        flush();
        startPara({ ...l, html: `<sup>${escape(l.text)}</sup>` }, 'fn');
        continue;
      }
      if (!para || para.type !== 'fn' || (marker && !(para.lines === 1 && MARKER_ONLY_RE.test(para.text))) || bigGap) { flush(); startPara(l, 'fn'); } else append(l);
      continue;
    }
    const prevEndsSentence = !!prev && /[.!?"'”’)\]:;]$/.test(prev.text);
    // OCR positions are rough, so on a scan a sentence that carries on in lower case carries on the paragraph, past
    // a picture or a word the OCR engine lost at the start of the line.
    const carriesOn = ocr && !!prev && !prevEndsSentence && /^\p{Ll}/u.test(l.text);
    if (!para || para.type !== 'p' || (bigGap && !carriesOn) || (prev && !ocr && prev.size > bodySize * 1.15)) { flush(); startPara(l); continue; }

    const bullet = BULLET_RE.test(l.text) || BULLET_ONLY_RE.test(l.text);
    const prevShort = Number.isFinite(rightEdge) && prev.right < rightEdge - bodySize * 3;
    let startsNew;
    if (bullet) startsNew = true;
    else if (carriesOn) startsNew = false;
    // On a scan a line is measured against the margin of the page rather than the lines before it, whose positions
    // are just as rough: indented after the end of a sentence, or after a short line that ended one, it starts a paragraph.
    else if (ocr && Number.isFinite(leftEdge)) startsNew = prevEndsSentence && (l.x > leftEdge + em || prevShort);
    else if (para.lines >= 2) startsNew = Math.abs(l.x - para.bodyX) > em || (prevShort && prevEndsSentence && l.x > para.bodyX + em);
    else if (l.x > para.firstX + em) startsNew = !para.bullet;
    else if (l.x < para.firstX - em) startsNew = false;
    else startsNew = prevShort && prevEndsSentence;
    if (startsNew) { flush(); startPara(l); } else append(l);
  }
  flush();
  for (const b of blocks) {
    if (b.type === 'p') b.cont = blocks.indexOf(b) === 0 && !b.bullet && Number.isFinite(leftEdge) && b.firstX <= leftEdge + bodySize * 0.6 && /^[a-z]/.test(b.text);
  }
  return blocks;
}

/** Compatibility helper: lines and blocks for a single page without cross-page context. */
export function pageItemsToBlocks(items, viewport, styles) {
  const { lines, bodySize } = pageLines(items, viewport, styles);
  return linesToBlocks(lines, { bodySize });
}

function blockHtml(b) {
  if (b.type === 'h') return `<h${b.level}>${b.html}</h${b.level}>`;
  if (b.type === 'fn') return `<p class="footnote"${b.id ? ` id="${b.id}"` : ''}>${b.html}</p>`;
  if (b.type === 'leader') return `<p class="leader">${b.html}</p>`;
  if (b.type === 'img') return `<figure><img src="${b.src}" alt=""/></figure>`;
  if (b.type === 'break') return SCENE_BREAK;
  const cls = [b.cont ? 'cont' : '', b.bullet ? 'list-item' : ''].filter(Boolean).join(' ');
  return `<p${cls ? ` class="${cls}"` : ''}>${b.html}</p>`;
}

export function blocksToHtml(blocks) {
  return blocks.map(blockHtml).join('\n');
}

/** Does the paragraph that ends page N continue at the top of page N+1? */
function continues(prevBlocks, nextBlocks) {
  const last = [...prevBlocks].reverse().find((b) => b.type !== 'fn');
  const first = nextBlocks[0];
  if (!last || !first || last.type !== 'p' || first.type !== 'p' || first.bullet) return false;
  if (/[-–—]$/.test(last.text)) return true;
  return !/[.!?:;"”’)\]]$/.test(last.text) && /^[a-z0-9(“"]/.test(first.text);
}

/** Join the text of a paragraph that ended one page with the block that begins the next. */
function joinAcrossPages(last, first, marker) {
  const joined = joinHyphenated(last.text, first.text);
  let text;
  let html;
  if (joined) {
    text = joined.text;
    html = (joined.dropHyphen ? last.html.replace(/-(<\/(?:b|i)>)*$/, '$1') : last.html) + marker + first.html;
  } else if (/[–—]$/.test(last.text)) {
    text = last.text + first.text;
    html = last.html + marker + first.html;
  } else {
    text = `${last.text} ${first.text}`;
    html = `${last.html} ${marker}${first.html}`;
  }
  return { ...last, text, html: html.replace(/<\/(b|i)> ?<\1>/g, ' ').replace(/<\/(b|i)><\1>/g, '') };
}

const NOTE_NUM_RE = /^(\d{1,3}|[*†‡§])\s/;

/** Give every footnote block an id keyed by page and number; returns a lookup by page. */
function indexFootnotes(pages) {
  const byPage = new Map();
  for (const { p, blocks } of pages) {
    const map = new Map();
    for (const n of blocks) {
      if (n.type !== 'fn') continue;
      const m = NOTE_NUM_RE.exec(n.text);
      if (!m || map.has(m[1])) continue;
      n.id = `fn-${p}-${m[1].replace(/[^\w]/g, (c) => c.charCodeAt(0))}`;
      n.refs = 0;
      map.set(m[1], n);
    }
    byPage.set(p, map);
  }
  return byPage;
}

/**
 * Turn the footnote markers in a page's body blocks into links to their notes. A note is normally printed on
 * the marker's page; when it is not there, the following two pages and the previous one are tried.
 */
function linkFootnotes(pageNo, blocks, byPage) {
  const find = (num) => {
    for (const p of [pageNo, pageNo + 1, pageNo + 2, pageNo - 1]) {
      const n = byPage.get(p)?.get(num);
      if (n && !n.refs) return n;
    }
    return byPage.get(pageNo)?.get(num) || null;
  };
  for (const b of blocks) {
    if (b.type === 'fn' || !b.html) continue;
    b.html = b.html.replace(/<sup>(\d{1,3}|[*†‡§])<\/sup>/g, (m, num) => {
      const note = find(num);
      if (!note) return m;
      note.refs++;
      const refId = `${note.id.replace(/^fn-/, 'fnref-')}-${note.refs}`;
      if (note.refs === 1) note.backTo = refId;
      return `<sup><a id="${refId}" href="#${note.id}">${num}</a></sup>`;
    });
  }
}

function backLinkFootnotes(blocks) {
  for (const n of blocks) {
    if (n.type !== 'fn' || !n.id || !n.backTo) continue;
    n.html = n.html.replace(/^<sup>(\d{1,3}|[*†‡§])<\/sup>/, (m, num) => `<sup><a href="#${n.backTo}">${num}</a></sup>`);
  }
}

/**
 * The chapter titles in the text, such as "Chapter Eleven" or "Prologue": a heading, or a line of its own, that
 * names a chapter (see isChapterTitle in bundle.js). Each is { i, k, title }: the page's index, and the index of
 * the block a chapter begins at among the page's body blocks, which takes in the headings and pictures just
 * before its title, such as a part's name. Which count is chooseTitles' to say.
 */
function chapterTitles(bodies) {
  const titles = [];
  let at = 0;
  bodies.forEach((body, i) => body.forEach((b, k) => {
    const text = b.text.replace(/\s+/g, ' ').trim();
    if ((b.type === 'h' && isChapterTitle(text)) || (b.type === 'p' && !b.bullet && isChapterLine(text))) titles.push({ i, k, at, title: text });
    at += b.text.length;
  }));
  const chosen = chooseTitles(titles.map((t, j) => ({ at: t.at, end: titles[j + 1]?.at ?? at, key: t.title.toLowerCase() })));
  return titles.filter((t, j) => {
    if (!chosen.has(j)) return false;
    while (t.k > 0 && (bodies[t.i][t.k - 1].type === 'h' || bodies[t.i][t.k - 1].type === 'img')) t.k--;
    return true;
  });
}

/**
 * Where sections start: `starts`, indexes into `pages` of the pages that begin one, and `splits`, the pages a
 * chapter begins partway down, by index, with where (see chapterTitles). A section begins at each chapter page,
 * and at each chapter title in the text, at the top of its page or partway down. A longer run between them is
 * cut into near-equal parts (see chooseCuts), between pages: best before a page that starts with a heading or
 * a scene break, then before any page that starts a paragraph of its own, and before a page that carries on a
 * paragraph, or follows a heading, only when no other is near.
 */
function sectionStarts(pages, budget, startsChapter) {
  const bodies = pages.map(({ blocks }) => blocks.filter((b) => b.type !== 'fn'));
  const splits = new Map();
  const titled = new Map(); // page index -> the title of the chapter it begins with
  for (const t of chapterTitles(bodies)) {
    const opening = bodies[t.i].findIndex((b) => b.type !== 'img');
    if (t.k <= Math.max(0, opening)) titled.set(t.i, t.title);
    else splits.set(t.i, [...(splits.get(t.i) || []), t]);
  }
  const info = pages.map(({ p, blocks }, i) => {
    const body = bodies[i];
    const firstText = blocks.find((b) => b.type !== 'img');
    const opening = body.find((b) => b.type !== 'img');
    return {
      // The page's text: its body, the first block included when it joins the paragraph before, and its notes.
      chars: blocks.reduce((n, b) => n + b.text.length, 0),
      chapter: startsChapter(p) || (firstText?.type === 'h' && firstText.level === 1) || titled.has(i),
      title: titled.get(i),
      carriesOn: i > 0 && continues(pages[i - 1].blocks, body),
      // A heading at the foot of the page before belongs with this page.
      afterHeading: i > 0 && pages[i - 1].blocks.filter((b) => b.type !== 'fn').at(-1)?.type === 'h',
      opens: opening?.type === 'h' || opening?.type === 'break',
    };
  });
  const starts = new Set();
  const cutRun = (from, to) => {
    const places = [];
    let pos = 0;
    let total = 0;
    for (let i = from; i < to; i++) {
      if (i > from) places.push({ at: i, pos, rank: info[i].carriesOn || info[i].afterHeading ? 3 : info[i].opens ? 1 : 2 });
      pos += info[i].chars;
      total += info[i].chars;
    }
    for (const at of chooseCuts(places, total, budget)) starts.add(at);
  };
  let from = 0;
  let chars = 0;
  info.forEach((page, i) => {
    if ((page.chapter || splits.has(i)) && chars > 0) {
      cutRun(from, i);
      if (page.chapter) starts.add(i);
      from = i;
      chars = 0;
    }
    chars += page.chars;
  });
  cutRun(from, pages.length);
  return { starts, splits, info };
}

/**
 * Merge per-page block lists into sections, adding page markers and joining paragraphs that
 * run across page breaks. Returns [{first, last, html, title}], `title` for a section that begins with a
 * chapter's title.
 */
export function mergePages(pages, { budget = SECTION_BUDGET, startsChapter = () => false } = {}) {
  const sections = [];
  let cur = null;
  // `lastBlock` is the last paragraph as it went into the section, joined when it began on an earlier page.
  const open = (p, title) => ({ first: p, last: p, parts: [], notes: [], lastBlock: null, title });
  const flush = () => {
    if (!cur) return;
    const parts = [...cur.parts];
    if (cur.notes.length) parts.push(`<section class="endnotes">${cur.notes.join('\n')}</section>`);
    sections.push({ first: cur.first, last: cur.last, html: parts.join('\n'), title: cur.title });
    cur = null;
  };
  const byPage = indexFootnotes(pages);
  for (const { p, blocks } of pages) linkFootnotes(p, blocks, byPage);
  for (const { blocks } of pages) backLinkFootnotes(blocks);
  // Measured once the notes are linked, from the blocks as they go into the sections.
  const { starts, splits, info } = sectionStarts(pages, budget, startsChapter);
  pages.forEach(({ p, blocks }, i) => {
    if (starts.has(i)) flush();
    const marker = `<span class="pg" id="pg${p}"></span>`;
    if (!cur) cur = open(p, info[i].title);
    cur.last = p;
    const body = blocks.filter((b) => b.type !== 'fn');
    const notes = blocks.filter((b) => b.type === 'fn');
    // A chapter that begins partway down the page ends the section there. Each note goes with the part of the
    // page its marker is in, and one without a marker on the page with the last part, as before.
    const here = splits.get(i) || [];
    const partOf = (k) => here.filter((t) => t.k <= k).length;
    const noteParts = notes.map((n) => {
      const k = here.length && n.id ? body.findIndex((b) => b.html?.includes(`#${n.id}"`)) : -1;
      return k < 0 ? here.length : partOf(k);
    });
    let part = 0;
    const endPart = () => {
      notes.forEach((n, j) => { if (noteParts[j] === part) cur.notes.push(blockHtml(n)); });
      part++;
    };
    let k = 0;
    if (cur.lastBlock && info[i].carriesOn) {
      // The paragraph that ended the previous page carries on: replace its output with the joined paragraph.
      // It is joined as it went in, so one that runs over a whole page keeps what came before.
      cur.parts.pop();
      cur.lastBlock = joinAcrossPages(cur.lastBlock, body[0], marker);
      cur.parts.push(blockHtml(cur.lastBlock));
      k = 1;
    } else {
      cur.parts.push(marker);
    }
    for (; k < body.length; k++) {
      const split = here.find((t) => t.k === k);
      if (split) {
        endPart();
        flush();
        // The chapter's section begins on this page, whose marker is in the section before.
        cur = open(p, split.title);
      }
      cur.parts.push(blockHtml(body[k]));
      cur.lastBlock = body[k];
    }
    endPart();
  });
  flush();
  return sections;
}

/** Real font names become known once the page's operators are parsed. */
async function fontStyles(page, textContent) {
  const styles = {};
  try {
    for (const [name, st] of Object.entries(textContent.styles || {})) {
      let real = '';
      try { real = page.commonObjs.has(name) ? (page.commonObjs.get(name)?.name || '') : ''; } catch { real = ''; }
      styles[name] = { ...st, realName: real };
    }
  } catch { return textContent.styles || {}; }
  return styles;
}

const SCAN_COVER = 0.85; // images covering this much of a page are the page itself: a scan

/**
 * What a page's operators tell that its text cannot: the raster images and their boxes (page space, top down), whether
 * they cover the page (`scan`), and whether the text is an OCR layer over them (`ocr`): drawn invisibly, or drawn first
 * and covered by the scan. Images are placed whether or not they can be decoded here.
 */
export function readOperators(ops, OPS, viewport) {
  const images = [];
  const stack = [];
  let state = { ctm: viewport.transform.slice(), mode: 0 };
  const mul = (m1, m2) => [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
  const shows = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const coverArea = viewport.width * viewport.height * SCAN_COVER;
  let covered = 0;
  let text = 0;
  let invisible = 0;
  let beforeScan = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(state);
    else if (fn === OPS.restore) state = stack.pop() || state;
    else if (fn === OPS.transform) state = { ...state, ctm: mul(state.ctm, args) };
    else if (fn === OPS.setTextRenderingMode) state = { ...state, mode: args[0] };
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(state); if (args[0]) state = { ...state, ctm: mul(state.ctm, args[0]) }; }
    else if (fn === OPS.paintFormXObjectEnd) state = stack.pop() || state;
    else if (shows.has(fn)) {
      text++;
      if (state.mode === 3 || state.mode === 7) invisible++;
      if (covered < coverArea) beforeScan++;
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const { ctm } = state;
      const xs = [0, ctm[0], ctm[2], ctm[0] + ctm[2]].map((v) => v + ctm[4]);
      const ys = [0, ctm[1], ctm[3], ctm[1] + ctm[3]].map((v) => v + ctm[5]);
      const x = Math.min(...xs), w = Math.max(...xs) - x, top = Math.min(...ys), h = Math.max(...ys) - top;
      covered += Math.max(0, Math.min(x + w, viewport.width) - Math.max(x, 0)) * Math.max(0, Math.min(top + h, viewport.height) - Math.max(top, 0));
      if (fn !== OPS.paintImageMaskXObject) images.push({ id: args[0], x, top, w, h });
    }
  }
  const scan = covered >= coverArea;
  return { images, scan, ocr: text > 0 && (invisible * 2 > text || (scan && beforeScan * 2 > text)) };
}

/** Raster images worth keeping in the text (not decorations, not the page itself), as pseudo-lines positioned in PDF space, with PNG data. */
function pageImages(page, viewport, found, pageNo, images) {
  const out = [];
  const seen = new Set();
  const pageArea = viewport.width * viewport.height;
  for (const { id, x, top, w, h } of found) {
    if (typeof id === 'string' && seen.has(id)) continue;
    if (typeof id === 'string') seen.add(id);
    if (w < 24 || h < 24 || w * h > pageArea * SCAN_COVER) continue; // decorations and full-page scans
    let img = null;
    try { img = typeof id === 'string' ? (page.objs.has(id) ? page.objs.get(id) : null) : id; } catch { img = null; }
    if (!img || !img.data || !img.width || !img.height) continue;
    let png;
    try { png = encodePng(img); } catch { continue; }
    const name = `images/p${pageNo}_${out.length + 1}.png`;
    images.set(name, png);
    // Pseudo-line: y is the image top in PDF space so it sorts into reading order with text lines.
    out.push({ image: name, y: viewport.height - top, x, right: x + w, size: 0, text: '', html: '', width: viewport.width, height: viewport.height });
  }
  return out;
}

async function openPdf(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    return { task, doc: await task.promise };
  } catch (err) {
    task.destroy();
    throw err;
  }
}

/**
 * Title and author from the document information, series from calibre's XMP metadata. The title is ''
 * when the document names none, or only a placeholder such as "Untitled" (see withFilenameDetails in index.js).
 */
async function documentMetadata(doc) {
  let title = '';
  let author = '';
  let series = [];
  try {
    const meta = await doc.getMetadata();
    title = (meta.info?.Title || '').trim();
    author = (meta.info?.Author || '').trim();
    series = seriesFromXmp(meta.metadata?.getRaw());
  } catch { /* ignore */ }
  if (/^(untitled|microsoft word|document)\b/i.test(title)) title = '';
  return { title, author, series };
}

/** Reads only the book's details, without converting it. */
export async function readPdfMetadata(buffer) {
  const { task, doc } = await openPdf(buffer);
  try {
    return { ...(await documentMetadata(doc)), language: '', format: 'pdf' };
  } finally {
    await task.destroy();
  }
}

export async function convertPdf(buffer) {
  const { OPS } = await loadPdfjs();
  const { task, doc } = await openPdf(buffer);
  const { title, author, series } = await documentMetadata(doc);

  // Outline (bookmarks) -> toc, and the set of pages where chapters start.
  const outlineToc = [];
  const chapterPages = new Set();
  try {
    const outline = await doc.getOutline();
    if (outline?.length) {
      const walk = async (items, depth) => {
        const out = [];
        for (const it of items) {
          let pageIndex = null;
          try {
            let dest = it.dest;
            if (typeof dest === 'string') dest = await doc.getDestination(dest);
            if (Array.isArray(dest) && dest[0]) pageIndex = await doc.getPageIndex(dest[0]);
          } catch { /* ignore */ }
          const entry = { title: it.title || 'Untitled', key: pageIndex != null ? `#pg${pageIndex + 1}` : null };
          if (pageIndex != null && depth === 0) chapterPages.add(pageIndex + 1);
          if (it.items?.length && depth < 3) entry.children = await walk(it.items, depth + 1);
          out.push(entry);
        }
        return out;
      };
      outlineToc.push(...await walk(outline, 0));
    }
  } catch { /* ignore */ }

  // Pass 1: text runs, font styles and images for every page. The body size is the median over the
  // whole document, so a page that is mostly footnotes still tells its markers from its text. Scanned
  // pages carry the OCR engine's text, measured apart: its sizes are those of the boxes around words.
  const raw = [];
  const bodySizes = [];
  const ocrSizes = [];
  const ocrGaps = [];
  const images = new Map();
  let scannedPages = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    let ops = null;
    try { ops = await page.getOperatorList(); } catch { ops = null; }
    const tc = await page.getTextContent();
    const styles = await fontStyles(page, tc);
    const hasText = tc.items.some((it) => it.str?.trim());
    const found = ops ? readOperators(ops, OPS, viewport) : { images: [], scan: false, ocr: false };
    const ocr = hasText && found.ocr;
    const scanned = found.scan && (!hasText || ocr); // a picture of the page, with or without OCR text over it
    if (scanned) scannedPages++;
    let ocrLines = null;
    if (ocr) {
      ({ lines: ocrLines } = pageLines(tc.items, viewport, styles, { ocr }));
      ocrLines.forEach((l, i) => { ocrSizes.push(l.size); if (i) ocrGaps.push(ocrLines[i - 1].y - l.y); });
    } else {
      const pageBody = pageBodySize(tc.items);
      if (Number.isFinite(pageBody)) bodySizes.push(pageBody);
    }
    let imgs = [];
    if (hasText && !scanned) { try { imgs = pageImages(page, viewport, found.images, p, images); } catch { imgs = []; } }
    raw.push({ p, items: tc.items, viewport, styles, imgs, ocrLines });
    page.cleanup();
  }
  const bodySize = median(bodySizes);
  const ocrBodySize = median(ocrSizes);
  const ocrPitch = median(ocrGaps);

  // Lines per page, and the running header/footer keys counted across pages.
  const pages = [];
  const keyCounts = new Map();
  for (const { p, items, viewport, styles, imgs, ocrLines } of raw) {
    const { lines } = ocrLines ? { lines: ocrLines } : pageLines(items, viewport, styles, { bodySize });
    for (const l of lines) {
      const band = edgeBand(l);
      if (!band) continue;
      const k = `${band}:${lineKey(l)}`;
      keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
    pages.push({ p, ocr: !!ocrLines, lines: [...lines, ...imgs].sort((a, b) => b.y - a.y) });
  }
  raw.length = 0;
  const threshold = Math.max(3, Math.ceil(doc.numPages * 0.02));
  const numbered = numberedRunningLines(pages);
  const runningKeys = new Set([...keyCounts].filter(([, n]) => n >= threshold).map(([k]) => k));
  for (const l of numbered) runningKeys.add(`${edgeBand(l)}:${lineKey(l)}`);
  // OCR misreads a page number now and then ("IB THE SECRET GARDEN" on page 18, "MISTRESS MARY n"): the first or last
  // line of a page that is a running line but for a short word where its number should be is one too.
  const outermost = new Set(pages.flatMap(({ lines }) => { const text = lines.filter((l) => !l.image); return [text[0], text[text.length - 1]]; }));
  const misreadNumber = (l) => outermost.has(l) && numberVariants(lineKey(l)).some((k) => runningKeys.has(`${edgeBand(l)}:${k}`));
  const isRunning = (l) => numbered.has(l) || (l.text.length < 120 && (runningKeys.has(`${edgeBand(l)}:${lineKey(l)}`) || misreadNumber(l)));

  // Pass 2: blocks per page, merged into sections.
  let emptyPages = 0;
  const pageBlocks = pages.map(({ p, ocr, lines }) => {
    const blocks = linesToBlocks(lines, ocr ? { bodySize: ocrBodySize, isRunning, ocr, pitch: ocrPitch } : { bodySize, isRunning });
    if (!blocks.some((b) => b.type !== 'img')) emptyPages++;
    if (!blocks.length) blocks.push({ type: 'p', text: '', html: `<span class="pdf-empty">[Page ${p} has no extractable text - use the page view]</span>`, cont: false, bullet: false });
    return { p, blocks };
  });
  const merged = mergePages(pageBlocks, { budget: SECTION_BUDGET, startsChapter: (p) => chapterPages.has(p) });
  const chapters = merged.map((s) => {
    const { root } = normalizeDocument(`<body>${s.html}</body>`, {
      resolveImage: (src) => (images.has(src) ? src : null),
      resolveLink: (href) => (href.startsWith('#') ? `pages${s.first}${href}` : null),
    });
    return { root, key: `pages${s.first}`, page: s.first, pageStart: s.first, pageEnd: s.last, title: s.title || (s.first === s.last ? `Page ${s.first}` : `Pages ${s.first}-${s.last}`) };
  });

  const { sections, toc } = assembleSections(chapters, { toc: outlineToc, budget: Infinity });
  await task.destroy();
  return {
    meta: { title, author, language: '', format: 'pdf', series },
    sections,
    toc: toc.length ? toc : [],
    images,
    // A scanned book is shown as its pages at first: the text of a scan is only as good as the OCR engine made it.
    extra: { pageCount: doc.numPages, textPages: doc.numPages - emptyPages, scanned: scannedPages * 2 >= doc.numPages, original: 'original.pdf' },
  };
}
