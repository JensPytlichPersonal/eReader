// PDF -> reflowable text. Each PDF page becomes one section so the "original layout"
// view (client-side pdf.js) and the reflowed view share the same location space.
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeDocument } from './html.js';
import { assembleSections, titleFromFilename } from './bundle.js';

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

function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.floor(a.length / 2)];
}

function styleOf(styles, fontName) {
  const fam = `${styles?.[fontName]?.fontFamily || ''} ${styles?.[fontName]?.realName || ''}`;
  return { italic: /italic|oblique/i.test(fam), bold: /bold|black|heavy|semibold|demibold/i.test(fam) };
}

/** Real font names (e.g. "ZillaSlab-Italic") become known once the page's operators are parsed. */
async function fontStyles(page, textContent) {
  const styles = {};
  try {
    await page.getOperatorList();
    for (const [name, st] of Object.entries(textContent.styles || {})) {
      let real = '';
      try { real = page.commonObjs.has(name) ? (page.commonObjs.get(name)?.name || '') : ''; } catch { real = ''; }
      styles[name] = { ...st, realName: real };
    }
  } catch { return textContent.styles || {}; }
  return styles;
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
  // Attach small runs: raised above a baseline -> superscript on that line; else nearest line; else own line.
  for (const r of runs.filter(isSmall)) {
    let best = null;
    let bestD = Infinity;
    for (const l of lines) {
      const d = r.y - l.y; // positive when raised above the baseline
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
 * Turn a page's lines into blocks (headings, paragraphs, footnotes).
 * @param {object} ctx {bodySize, isRunning(line) -> boolean}
 */
export function linesToBlocks(lines, ctx = {}) {
  if (!lines.length) return [];
  const bodySize = ctx.bodySize || median(lines.filter((l) => l.text.length > 20).map((l) => l.size)) || median(lines.map((l) => l.size));
  const isRunning = ctx.isRunning || (() => false);
  const leftEdge = median(lines.filter((l) => l.text.length > 40).map((l) => l.x));
  const rightEdge = median(lines.filter((l) => l.text.length > 40).map((l) => l.right));

  // Drop running headers/footers and lone page numbers at the page edges.
  const kept = lines.filter((l) => {
    const band = edgeBand(l);
    if (!band) return true;
    if (/^[\divxlc]+$/i.test(l.text.replace(/[\s|·•—–-]/g, ''))) return false;
    if (isRunning(l)) return false;
    return true;
  });

  // Footnote zone: small-print lines at the foot of the page, the first starting with a marker.
  let footStart = kept.length;
  for (let i = kept.length - 1; i >= 0; i--) {
    const l = kept[i];
    const small = l.size < bodySize * 0.92;
    if (!small) break;
    if (l.startsWithSup || /^\d{1,3}\s/.test(l.text) || /^[*†‡§]/.test(l.text)) footStart = i;
  }

  const blocks = [];
  let para = null;
  const flush = () => { if (para) { blocks.push(para); para = null; } };
  const startPara = (l, type = 'p') => { para = { type, text: l.text, html: l.html, firstX: l.x, bodyX: null, lines: 1, bullet: BULLET_RE.test(l.text) || BULLET_ONLY_RE.test(l.text) }; };
  const append = (l) => {
    const endsHyphen = /[A-Za-z]-$/.test(para.text);
    if (endsHyphen && /^[a-z]/.test(l.text)) { para.text = para.text.slice(0, -1) + l.text; para.html = para.html.replace(/-$/, '') + l.html; }
    else if (endsHyphen) { para.text += l.text; para.html += l.html; }
    else { para.text += ' ' + l.text; para.html += ' ' + l.html; }
    para.html = para.html.replace(/<\/(b|i)> ?<\1>/g, ' ').replace(/<\/(b|i)><\1>/g, '');
    if (para.lines === 1) para.bodyX = l.x;
    para.lines++;
  };

  for (let i = 0; i < kept.length; i++) {
    const l = kept[i];
    const prev = kept[i - 1];
    const inFoot = i >= footStart;
    const isHeading = !inFoot && l.size > bodySize * 1.15 && l.text.length < 120;
    const gap = prev ? prev.y - l.y : 0;
    const bigGap = prev && gap > Math.max(prev.size, l.size) * 1.7;
    const em = bodySize * 0.6;

    if (isHeading) {
      flush();
      const level = l.size > bodySize * 1.6 ? 1 : 2;
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'h' && Math.abs(last.size - l.size) < 0.5 && !bigGap) { last.text += ' ' + l.text; last.html += ' ' + l.html; }
      else blocks.push({ type: 'h', level, text: l.text, html: l.html, size: l.size });
      continue;
    }
    if (inFoot) {
      const marker = l.startsWithSup || /^\d{1,3}\s/.test(l.text) || /^[*†‡§]/.test(l.text);
      if (!para || para.type !== 'fn' || marker || bigGap) { flush(); startPara(l, 'fn'); } else append(l);
      continue;
    }
    if (!para || para.type !== 'p' || bigGap || (prev && prev.size > bodySize * 1.15)) { flush(); startPara(l); continue; }

    // Decide between continuing the paragraph and starting a new one from the line geometry.
    const bullet = BULLET_RE.test(l.text) || BULLET_ONLY_RE.test(l.text);
    const prevShort = Number.isFinite(rightEdge) && prev.right < rightEdge - bodySize * 3;
    const prevEndsSentence = /[.!?"'”’)\]:;]$/.test(prev.text);
    let startsNew;
    if (bullet) startsNew = true;
    else if (para.lines >= 2) startsNew = Math.abs(l.x - para.bodyX) > em || (prevShort && prevEndsSentence && l.x > para.bodyX + em);
    else if (l.x > para.firstX + em) startsNew = !para.bullet; // hanging indent under a bullet continues
    else if (l.x < para.firstX - em) startsNew = false; // first-line indent style: body returns to the margin
    else startsNew = prevShort && prevEndsSentence;
    if (startsNew) { flush(); startPara(l); } else append(l);
  }
  flush();
  for (const b of blocks) {
    if (b.type === 'p' && b.bullet && BULLET_ONLY_RE.test(b.text.split(' ')[0])) b.text = b.text.replace(/^(\S+)\s+/, '$1 ');
    b.cont = b.type === 'p' && blocks.indexOf(b) === 0 && !b.bullet && Number.isFinite(leftEdge) && b.firstX <= leftEdge + bodySize * 0.6 && /^[a-z]/.test(b.text);
  }
  return blocks;
}

/** Compatibility helper: lines and blocks for a single page without cross-page context. */
export function pageItemsToBlocks(items, viewport, styles) {
  const { lines, bodySize } = pageLines(items, viewport, styles);
  return linesToBlocks(lines, { bodySize });
}

export function blocksToHtml(blocks) {
  return blocks.map((b) => {
    if (b.type === 'h') return `<h${b.level}>${b.html}</h${b.level}>`;
    if (b.type === 'fn') return `<p class="footnote">${b.html}</p>`;
    const cls = [b.cont ? 'cont' : '', b.bullet ? 'list-item' : ''].filter(Boolean).join(' ');
    return `<p${cls ? ` class="${cls}"` : ''}>${b.html}</p>`;
  }).join('\n');
}

export async function convertPdf(buffer, { filename }) {
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
  const doc = await task.promise;
  let title = '';
  let author = '';
  try {
    const meta = await doc.getMetadata();
    title = (meta.info?.Title || '').trim();
    author = (meta.info?.Author || '').trim();
  } catch { /* ignore */ }
  if (!title || /^(untitled|microsoft word|document)\b/i.test(title)) title = titleFromFilename(filename);

  // Pass 1: lines for every page, so running headers/footers can be recognised across pages.
  const pages = [];
  const keyCounts = new Map();
  const bodySizes = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const { lines, bodySize } = pageLines(tc.items, viewport, await fontStyles(page, tc));
    if (Number.isFinite(bodySize)) bodySizes.push(bodySize);
    for (const l of lines) {
      const band = edgeBand(l);
      if (!band) continue;
      const k = `${band}:${lineKey(l)}`;
      keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
    pages.push({ p, lines });
    page.cleanup();
  }
  const bodySize = median(bodySizes);
  const threshold = Math.max(3, Math.ceil(doc.numPages * 0.02));
  const isRunning = (l) => (keyCounts.get(`${edgeBand(l)}:${lineKey(l)}`) || 0) >= threshold && l.text.length < 120;

  // Pass 2: blocks and sections.
  const chapters = [];
  let emptyPages = 0;
  for (const { p, lines } of pages) {
    const blocks = linesToBlocks(lines, { bodySize, isRunning });
    if (!blocks.length) emptyPages++;
    const html = blocks.length ? blocksToHtml(blocks) : `<p class="pdf-empty">[Page ${p} has no extractable text - use the page view]</p>`;
    const { root } = normalizeDocument(`<body>${html}</body>`);
    chapters.push({ root, key: `page${p}`, page: p, title: `Page ${p}` });
  }

  // Outline (bookmarks) -> toc
  const outlineToc = [];
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
          const entry = { title: it.title || 'Untitled', key: pageIndex != null ? `page${pageIndex + 1}` : null };
          if (it.items?.length && depth < 3) entry.children = await walk(it.items, depth + 1);
          out.push(entry);
        }
        return out;
      };
      outlineToc.push(...await walk(outline, 0));
    }
  } catch { /* ignore */ }

  const { sections, toc } = assembleSections(chapters, { toc: outlineToc, budget: Infinity });
  await task.destroy();
  return {
    meta: { title, author, language: '', format: 'pdf' },
    sections,
    toc: toc.length ? toc : [],
    extra: { pageCount: doc.numPages, textPages: doc.numPages - emptyPages, original: 'original.pdf' },
  };
}
