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

/** Group text items into lines, then lines into paragraphs. */
export function pageItemsToBlocks(items, viewport) {
  const glyphs = items.filter((it) => it.str != null && it.transform);
  if (!glyphs.length) return [];
  // Lines: cluster by baseline y (in PDF units, y grows upward)
  const lines = [];
  const sorted = glyphs.map((it) => ({
    str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0,
    size: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || it.height || 10, eol: it.hasEOL, font: it.fontName,
  })).sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  for (const g of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - g.y) <= Math.max(2, last.size * 0.4)) {
      last.items.push(g);
    } else {
      lines.push({ y: g.y, size: g.size, items: [g] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prev = null;
    for (const it of line.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        if (gap > prev.size * 0.15 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      }
      text += it.str;
      prev = it;
    }
    line.text = text.replace(/\s+/g, ' ').trim();
    line.x = line.items[0].x;
    line.right = Math.max(...line.items.map((i) => i.x + i.w));
    line.size = median(line.items.map((i) => i.size));
  }
  const good = lines.filter((l) => l.text);
  if (!good.length) return [];
  const bodySize = median(good.filter((l) => l.text.length > 20).map((l) => l.size)) || median(good.map((l) => l.size));
  const pageTop = viewport.height;
  const leftEdge = median(good.filter((l) => l.text.length > 40).map((l) => l.x));
  const rightEdge = median(good.filter((l) => l.text.length > 40).map((l) => l.right));

  const blocks = [];
  let para = null;
  const flush = () => { if (para) { blocks.push(para); para = null; } };
  for (let i = 0; i < good.length; i++) {
    const l = good[i];
    const prev = good[i - 1];
    // Running headers/footers and page numbers at the very top or bottom.
    const nearEdge = l.y > pageTop * 0.94 || l.y < pageTop * 0.06;
    if (nearEdge && (l.text.length < 60) && (/^\d+$/.test(l.text.replace(/[\s|·•—-]/g, '')) || good.length > 5)) continue;
    const isHeading = l.size > bodySize * 1.15 && l.text.length < 120;
    const gap = prev ? prev.y - l.y : 0;
    const bigGap = prev && gap > Math.max(prev.size, l.size) * 1.7;
    const indented = Number.isFinite(leftEdge) && l.x > leftEdge + bodySize * 0.8 && l.x < leftEdge + bodySize * 6;
    const prevShort = prev && Number.isFinite(rightEdge) && prev.right < rightEdge - bodySize * 4;
    const prevEndsSentence = prev && /[.!?"'”’)\]:]$/.test(prev.text);
    if (isHeading) {
      flush();
      const level = l.size > bodySize * 1.6 ? 1 : 2;
      if (blocks.length && blocks[blocks.length - 1].type === 'h' && Math.abs(blocks[blocks.length - 1].size - l.size) < 0.5 && !bigGap) {
        blocks[blocks.length - 1].text += ' ' + l.text;
      } else blocks.push({ type: 'h', level, text: l.text, size: l.size });
      continue;
    }
    const startsNew = !para || bigGap || indented || (prevShort && prevEndsSentence) || (prev && prev.size > bodySize * 1.15);
    if (startsNew) { flush(); para = { type: 'p', text: l.text, cont: !indented && i === 0 && !/^[A-Z“"(\[]/.test(l.text) }; }
    else {
      if (/[A-Za-z]-$/.test(para.text) && /^[a-z]/.test(l.text)) para.text = para.text.slice(0, -1) + l.text;
      else para.text += ' ' + l.text;
    }
  }
  flush();
  return blocks;
}

function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.floor(a.length / 2)];
}

export function blocksToHtml(blocks) {
  return blocks.map((b) => {
    if (b.type === 'h') return `<h${b.level}>${escape(b.text)}</h${b.level}>`;
    return `<p${b.cont ? ' class="cont"' : ''}>${escape(b.text)}</p>`;
  }).join('\n');
}

export async function convertPdf(buffer, { filename }) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
    cMapPacked: true,
    verbosity: 0,
  }).promise;
  let title = '';
  let author = '';
  try {
    const meta = await doc.getMetadata();
    title = (meta.info?.Title || '').trim();
    author = (meta.info?.Author || '').trim();
  } catch { /* ignore */ }
  if (!title || /^(untitled|microsoft word|document)\b/i.test(title)) title = titleFromFilename(filename);

  const chapters = [];
  const outlineToc = [];
  let emptyPages = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const blocks = pageItemsToBlocks(tc.items, viewport);
    if (!blocks.length) emptyPages++;
    const html = blocks.length ? blocksToHtml(blocks) : `<p class="pdf-empty">[Page ${p} has no extractable text - use the page view]</p>`;
    const { root } = normalizeDocument(`<body>${html}</body>`);
    chapters.push({ root, key: `page${p}`, page: p, title: `Page ${p}` });
    page.cleanup();
  }
  // Outline (bookmarks) -> toc
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
  await doc.destroy();
  return {
    meta: { title, author, language: '', format: 'pdf' },
    sections,
    toc: toc.length ? toc : [],
    extra: { pageCount: doc.numPages, textPages: doc.numPages - emptyPages, original: 'original.pdf' },
  };
}
