// Renders original PDF pages with pdf.js. Used for the "Original pages" view of PDF books.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/legacy/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

// Where pdf.js finds its data. Scanned pages are mostly JBIG2, CCITT fax or JPEG 2000 images, which it decodes
// with the WebAssembly modules in wasm/: without them those pages draw blank.
const DOCUMENT_OPTIONS = {
  cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  wasmUrl: '/vendor/pdfjs/wasm/', iccUrl: '/vendor/pdfjs/iccs/',
};

/**
 * Draws one page of a PDF on a new canvas, `maxSide` pixels along its longer side, fetching only the parts
 * of the file that page needs. The page number is kept within the document; returns { canvas, page }.
 */
export async function renderPdfPage(url, pageNumber, maxSide) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ url, ...DOCUMENT_OPTIONS, disableAutoFetch: true, disableStream: true });
  try {
    const doc = await task.promise;
    const number = Math.min(Math.max(1, Math.round(pageNumber) || 1), doc.numPages);
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: maxSide / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    return { canvas, page: number };
  } finally {
    await task.destroy();
  }
}

/** Whether part of a drawn page is in colour: a picture, rather than print on paper, however yellowed the paper. */
function colourful(canvas, r, dpr) {
  const side = 48;
  const probe = document.createElement('canvas');
  probe.width = side;
  probe.height = side;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr, 0, 0, side, side);
  const d = ctx.getImageData(0, 0, side, side).data;
  let vivid = 0;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    if (max > 40 && (max - Math.min(d[i], d[i + 1], d[i + 2])) / max > 0.35) vivid++;
  }
  return vivid > side * side * 0.15;
}

export class PdfPageView {
  constructor(container, canvas) {
    this.container = container;
    this.scroller = container.querySelector('.scroller');
    this.canvas = canvas;
    this.doc = null;
    this.rendering = null;
    this.pageNumber = 1;
    this.fit = 'page'; // page | width
  }

  async open(url) {
    const pdfjs = await loadPdfjs();
    this.task = pdfjs.getDocument({ url, ...DOCUMENT_OPTIONS });
    this.doc = await this.task.promise;
    return this.doc.numPages;
  }

  get numPages() { return this.doc?.numPages || 0; }

  /** Device-space rectangles of the raster images drawn on a page, found by walking its operator list. */
  async imageRects(page, viewport) {
    const pdfjs = await loadPdfjs();
    const { OPS } = pdfjs;
    const ops = await page.getOperatorList();
    const rects = [];
    const stack = [];
    let ctm = viewport.transform.slice();
    // Local matrix helpers: pdf.js's own point transform mutates in place since v5.
    const mul = (m1, m2) => [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
    const apply = ([x, y], m) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
    const unitBox = (m) => {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => apply(p, m));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      switch (fn) {
        case OPS.save: stack.push(ctm); break;
        case OPS.restore: ctm = stack.pop() || ctm; break;
        case OPS.transform: ctm = mul(ctm, args); break;
        case OPS.paintFormXObjectBegin: stack.push(ctm); if (args[0]) ctm = mul(ctm, args[0]); break;
        case OPS.paintFormXObjectEnd: ctm = stack.pop() || ctm; break;
        case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintJpegXObject: rects.push(unitBox(ctm)); break;
        case OPS.paintImageXObjectRepeat: {
          const [, scaleX, scaleY, positions] = args;
          for (let j = 0; j < positions.length; j += 2) rects.push(unitBox(mul(ctm, [scaleX, 0, 0, scaleY, positions[j], positions[j + 1]])));
          break;
        }
        default: break;
      }
    }
    return rects.filter((r) => r.w > 4 && r.h > 4);
  }

  async render(pageNumber, invert) {
    if (!this.doc) return;
    this.pageNumber = Math.min(Math.max(1, pageNumber), this.doc.numPages);
    const token = (this.renderToken = (this.renderToken || 0) + 1);
    const page = await this.doc.getPage(this.pageNumber);
    if (token !== this.renderToken) return;
    const base = page.getViewport({ scale: 1 });
    const availW = this.scroller.clientWidth - 8;
    const availH = this.scroller.clientHeight - 12;
    const scale = this.fit === 'width' ? availW / base.width : Math.min(availW / base.width, availH / base.height);
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (this.rendering) { try { this.rendering.cancel(); } catch { /* ignore */ } }
    // Render the page as printed onto an offscreen canvas first. The page on screen stays until the next one is ready:
    // a scan can take a moment to decode, and an e-ink screen should not flash a blank page meanwhile.
    const off = this.offscreen ||= document.createElement('canvas');
    off.width = Math.floor(viewport.width * dpr);
    off.height = Math.floor(viewport.height * dpr);
    const offCtx = off.getContext('2d', { alpha: false });
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const task = page.render({ canvasContext: offCtx, viewport });
    this.rendering = task;
    try { await task.promise; } catch (err) { if (err?.name !== 'RenderingCancelledException') throw err; return; }
    this.rendering = null;
    if (token !== this.renderToken) return;
    let rects = [];
    if (invert) {
      // Dark theme: invert the page but paste the photographs back as they were. Images that cover the page are a scan
      // of it, which is inverted along with it, but for those in colour, such as a coloured plate.
      try { rects = await this.imageRects(page, viewport); } catch { rects = []; }
      if (token !== this.renderToken) return;
      if (rects.reduce((sum, r) => sum + r.w * r.h, 0) >= viewport.width * viewport.height * 0.85) rects = rects.filter((r) => colourful(off, r, dpr));
    }
    const canvas = this.canvas;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.classList.remove('inverted');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (invert) {
      ctx.filter = 'invert(1) hue-rotate(180deg)';
      ctx.drawImage(off, 0, 0);
      ctx.filter = 'none';
      for (const r of rects) {
        const x = Math.floor(r.x * dpr), y = Math.floor(r.y * dpr), w = Math.ceil(r.w * dpr), h = Math.ceil(r.h * dpr);
        ctx.drawImage(off, x, y, w, h, x, y, w, h);
      }
    } else {
      ctx.drawImage(off, 0, 0);
    }
    this.scroller.scrollTop = 0;
  }

  destroy() {
    this.task?.destroy();
    this.task = null;
    this.doc = null;
  }
}
