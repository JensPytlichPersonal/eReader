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
    this.task = pdfjs.getDocument({ url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' });
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
    const canvas = this.canvas;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.classList.remove('inverted');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (this.rendering) { try { this.rendering.cancel(); } catch { /* ignore */ } }
    // Render the page as printed onto an offscreen canvas first.
    const off = this.offscreen ||= document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const offCtx = off.getContext('2d', { alpha: false });
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const task = page.render({ canvasContext: offCtx, viewport });
    this.rendering = task;
    try { await task.promise; } catch (err) { if (err?.name !== 'RenderingCancelledException') throw err; return; }
    this.rendering = null;
    if (token !== this.renderToken) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (invert) {
      // Dark theme: invert the page but paste the photographs back as they were.
      let rects = [];
      try { rects = await this.imageRects(page, viewport); } catch { rects = []; }
      if (token !== this.renderToken) return;
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
