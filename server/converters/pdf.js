// PDF -> reflowable text. Pages are merged into normal-sized sections; invisible page markers
// (<span class="pg" id="pgN">) let the "original pages" view and the reflowed view share positions.
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeDocument } from './html.js';
import { assembleSections, titleFromFilename } from './bundle.js';
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
const BULLET_ONLY_RE = /^([•·▪◦‣■□●○◆◇➢➤►▸]|[-–—*])$/;
const LEADER_RE = /(\.\s?){4,}\s*[\divxlc]{1,5}\s*$/i; // "Chapter title ........ 123" (printed tables of contents)
const SECTION_BUDGET = 40000;
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

/**
 * Group a page's text runs into lines. Small raised runs (footnote markers) are attached to
 * the line they belong to as superscripts instead of forming lines of their own.
 * @returns {{lines: Array, bodySize: number}}
 */
export function pageLines(items, viewport, styles = {}) {
  const runs = [];
  for (const it of items) {
    if (it.str == null || !it.transform) continue;
    const size = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || it.height || 10;
    runs.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, size, font: it.fontName, ...styleOf(styles, it.fontName) });
  }
  if (!runs.length) return { lines: [], bodySize: NaN };
  const bodySize = median(runs.filter((r) => r.str.trim().length > 3).map((r) => r.size)) || median(runs.map((r) => r.size));
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
    let text = '';
    let html = '';
    let prev = null;
    for (const it of line.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        if (gap > Math.min(prev.size, it.size) * 0.15 && !text.endsWith(' ') && !it.str.startsWith(' ')) { text += ' '; html += ' '; }
      }
      const clean = it.str.replace(/\s+/g, ' ');
      text += clean;
      let frag = escape(clean);
      if (it.bold && clean.trim()) frag = `<b>${frag}</b>`;
      if (it.italic && clean.trim()) frag = `<i>${frag}</i>`;
      if (it.sup && clean.trim()) frag = `<sup>${frag.trim()}</sup>`;
      html += frag;
      prev = it;
    }
    line.text = text.replace(/\s+/g, ' ').trim();
    line.html = html.replace(/\s+/g, ' ').replace(/<\/(b|i)> <\1>/g, ' ').trim();
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

/** Normalised key used to spot running headers and footers repeated across pages. */
export function lineKey(line) {
  return line.text.replace(/\d+/g, '#').replace(/[\s|·•—–-]+/g, ' ').trim().toLowerCase();
}
export function edgeBand(line) {
  if (line.y > line.height * 0.86) return 'top';
  if (line.y < line.height * 0.1) return 'bottom';
  return null;
}

/**
 * Turn a page's lines (and image placeholders) into blocks (headings, paragraphs, footnotes, images).
 * @param {object} ctx {bodySize, isRunning(line) -> boolean}
 */
export function linesToBlocks(lines, ctx = {}) {
  if (!lines.length) return [];
  const textLines = lines.filter((l) => !l.image);
  const bodySize = ctx.bodySize || median(textLines.filter((l) => l.text.length > 20).map((l) => l.size)) || median(textLines.map((l) => l.size)) || 10;
  const isRunning = ctx.isRunning || (() => false);
  const leftEdge = median(textLines.filter((l) => l.text.length > 40).map((l) => l.x));
  const rightEdge = median(textLines.filter((l) => l.text.length > 40).map((l) => l.right));

  const kept = lines.filter((l) => {
    if (l.image) return true;
    if (isWatermark(l.text)) return false;
    const band = edgeBand(l);
    if (!band) return true;
    if (/^[\divxlc]+$/i.test(l.text.replace(/[\s|·•—–-]/g, ''))) return false;
    if (isRunning(l)) return false;
    return true;
  });

  let footStart = kept.length;
  for (let i = kept.length - 1; i >= 0; i--) {
    const l = kept[i];
    if (l.image) break;
    const small = l.size < bodySize * 0.92;
    if (!small) break;
    if (l.startsWithSup || /^\d{1,3}\s/.test(l.text) || /^[*†‡§]/.test(l.text)) footStart = i;
  }

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
    const isHeading = !inFoot && l.size > bodySize * 1.15 && l.text.length < 120;
    const gap = prev ? prev.y - l.y : 0;
    const bigGap = !prev || gap > Math.max(prev.size, l.size) * 1.7;
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
      const marker = l.startsWithSup || /^\d{1,3}\s/.test(l.text) || /^[*†‡§]/.test(l.text);
      if (!para || para.type !== 'fn' || marker || bigGap) { flush(); startPara(l, 'fn'); } else append(l);
      continue;
    }
    if (!para || para.type !== 'p' || bigGap || (prev && prev.size > bodySize * 1.15)) { flush(); startPara(l); continue; }

    const bullet = BULLET_RE.test(l.text) || BULLET_ONLY_RE.test(l.text);
    const prevShort = Number.isFinite(rightEdge) && prev.right < rightEdge - bodySize * 3;
    const prevEndsSentence = /[.!?"'”’)\]:;]$/.test(prev.text);
    let startsNew;
    if (bullet) startsNew = true;
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

/** Turn footnote markers in a page's body blocks into links to that page's notes, and give the notes ids and back links. */
function linkFootnotes(pageNo, blocks) {
  const notes = blocks.filter((b) => b.type === 'fn');
  const byNum = new Map();
  for (const n of notes) {
    const m = NOTE_NUM_RE.exec(n.text);
    if (!m || byNum.has(m[1])) continue;
    byNum.set(m[1], n);
    n.id = `fn-${pageNo}-${m[1].replace(/[^\w]/g, (c) => c.charCodeAt(0))}`;
    n.refs = 0;
  }
  if (!byNum.size) return;
  for (const b of blocks) {
    if (b.type === 'fn' || !b.html) continue;
    b.html = b.html.replace(/<sup>(\d{1,3}|[*†‡§])<\/sup>/g, (m, num) => {
      const note = byNum.get(num);
      if (!note) return m;
      note.refs++;
      const refId = `${note.id.replace(/^fn-/, 'fnref-')}-${note.refs}`;
      if (note.refs === 1) note.backTo = refId;
      return `<sup><a id="${refId}" href="#${note.id}">${num}</a></sup>`;
    });
  }
  for (const n of notes) {
    if (!n.id) continue;
    n.html = n.html.replace(/^<sup>(\d{1,3}|[*†‡§])<\/sup>/, (m, num) => (n.backTo ? `<sup><a href="#${n.backTo}">${num}</a></sup>` : m));
  }
}

/**
 * Merge per-page block lists into sections, adding page markers and joining paragraphs that
 * run across page breaks. Returns [{first, last, html}].
 */
export function mergePages(pages, { budget = SECTION_BUDGET, startsChapter = () => false } = {}) {
  const sections = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const parts = [...cur.parts];
    if (cur.notes.length) parts.push(`<section class="endnotes">${cur.notes.join('\n')}</section>`);
    sections.push({ first: cur.first, last: cur.last, html: parts.join('\n') });
    cur = null;
  };
  for (const { p, blocks } of pages) {
    const firstText = blocks.find((b) => b.type !== 'img');
    const chapterStart = startsChapter(p) || (firstText?.type === 'h' && firstText.level === 1);
    if (cur && (cur.chars >= budget || (chapterStart && cur.chars > 0))) flush();
    const marker = `<span class="pg" id="pg${p}"></span>`;
    if (!cur) cur = { first: p, last: p, chars: 0, parts: [], notes: [], prevBlocks: null };
    cur.last = p;
    linkFootnotes(p, blocks);
    const body = blocks.filter((b) => b.type !== 'fn');
    const notes = blocks.filter((b) => b.type === 'fn');
    if (cur.prevBlocks && cur.parts.length && continues(cur.prevBlocks, body)) {
      // The paragraph that ended the previous page carries on: replace its output with the joined paragraph.
      const lastBlock = cur.prevBlocks.filter((b) => b.type !== 'fn').pop();
      cur.parts.pop();
      const first = body.shift();
      cur.parts.push(blockHtml(joinAcrossPages(lastBlock, first, marker)));
      cur.chars += first.text.length;
    } else {
      cur.parts.push(marker);
    }
    for (const b of body) { cur.parts.push(blockHtml(b)); cur.chars += b.text.length; }
    for (const n of notes) { cur.notes.push(blockHtml(n)); cur.chars += n.text.length; }
    cur.prevBlocks = blocks;
  }
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

/** Raster images on the page, as pseudo-lines positioned in PDF space, with PNG data. */
async function pageImages(page, viewport, ops, OPS, pageNo, images) {
  const out = [];
  const seen = new Set();
  const stack = [];
  let ctm = viewport.transform.slice();
  const mul = (m1, m2) => [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
  const pageArea = viewport.width * viewport.height;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const id = args[0];
      if (typeof id === 'string' && seen.has(id)) continue;
      if (typeof id === 'string') seen.add(id);
      let img = null;
      try { img = typeof id === 'string' ? (page.objs.has(id) ? page.objs.get(id) : null) : id; } catch { img = null; }
      if (!img || !img.data || !img.width || !img.height) continue;
      const xs = [0, ctm[0], ctm[2], ctm[0] + ctm[2]].map((v) => v + ctm[4]);
      const ys = [0, ctm[1], ctm[3], ctm[1] + ctm[3]].map((v) => v + ctm[5]);
      const x = Math.min(...xs), w = Math.max(...xs) - x, top = Math.min(...ys), h = Math.max(...ys) - top;
      if (w < 24 || h < 24 || w * h > pageArea * 0.85) continue; // decorations and full-page scans
      let png;
      try { png = encodePng(img); } catch { continue; }
      const name = `images/p${pageNo}_${out.length + 1}.png`;
      images.set(name, png);
      // Pseudo-line: y is the image top in PDF space so it sorts into reading order with text lines.
      out.push({ image: name, y: viewport.height - top, x, right: x + w, size: 0, text: '', html: '', width: viewport.width, height: viewport.height });
    }
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

/** Title and author from the document information, series from calibre's XMP metadata. */
async function documentMetadata(doc, filename) {
  let title = '';
  let author = '';
  let series = [];
  try {
    const meta = await doc.getMetadata();
    title = (meta.info?.Title || '').trim();
    author = (meta.info?.Author || '').trim();
    series = seriesFromXmp(meta.metadata?.getRaw());
  } catch { /* ignore */ }
  if (!title || /^(untitled|microsoft word|document)\b/i.test(title)) title = titleFromFilename(filename);
  return { title, author, series };
}

/** Reads only the book's details, without converting it. */
export async function readPdfMetadata(buffer, { filename }) {
  const { task, doc } = await openPdf(buffer);
  try {
    return { ...(await documentMetadata(doc, filename)), language: '', format: 'pdf' };
  } finally {
    await task.destroy();
  }
}

export async function convertPdf(buffer, { filename }) {
  const { OPS } = await loadPdfjs();
  const { task, doc } = await openPdf(buffer);
  const { title, author, series } = await documentMetadata(doc, filename);

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

  // Pass 1: lines and images for every page, so running headers/footers can be recognised across pages.
  const pages = [];
  const keyCounts = new Map();
  const bodySizes = [];
  const images = new Map();
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    let ops = null;
    try { ops = await page.getOperatorList(); } catch { ops = null; }
    const tc = await page.getTextContent();
    const { lines, bodySize } = pageLines(tc.items, viewport, await fontStyles(page, tc));
    if (Number.isFinite(bodySize)) bodySizes.push(bodySize);
    for (const l of lines) {
      const band = edgeBand(l);
      if (!band) continue;
      const k = `${band}:${lineKey(l)}`;
      keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
    let imgs = [];
    if (ops && lines.length) { try { imgs = await pageImages(page, viewport, ops, OPS, p, images); } catch { imgs = []; } }
    pages.push({ p, lines: [...lines, ...imgs].sort((a, b) => b.y - a.y) });
    page.cleanup();
  }
  const bodySize = median(bodySizes);
  const threshold = Math.max(3, Math.ceil(doc.numPages * 0.02));
  const isRunning = (l) => (keyCounts.get(`${edgeBand(l)}:${lineKey(l)}`) || 0) >= threshold && l.text.length < 120;

  // Pass 2: blocks per page, merged into sections.
  let emptyPages = 0;
  const pageBlocks = pages.map(({ p, lines }) => {
    const blocks = linesToBlocks(lines, { bodySize, isRunning });
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
    return { root, key: `pages${s.first}`, page: s.first, pageStart: s.first, pageEnd: s.last, title: s.first === s.last ? `Page ${s.first}` : `Pages ${s.first}–${s.last}` };
  });

  const { sections, toc } = assembleSections(chapters, { toc: outlineToc, budget: Infinity });
  await task.destroy();
  return {
    meta: { title, author, language: '', format: 'pdf', series },
    sections,
    toc: toc.length ? toc : [],
    images,
    extra: { pageCount: doc.numPages, textPages: doc.numPages - emptyPages, original: 'original.pdf' },
  };
}
