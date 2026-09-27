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
    this.doc = await pdfjs.getDocument({ url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise;
    return this.doc.numPages;
  }

  get numPages() { return this.doc?.numPages || 0; }

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
    canvas.classList.toggle('inverted', !!invert);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.rendering) { try { this.rendering.cancel(); } catch { /* ignore */ } }
    const task = page.render({ canvasContext: ctx, viewport });
    this.rendering = task;
    try { await task.promise; } catch (err) { if (err?.name !== 'RenderingCancelledException') throw err; }
    this.rendering = null;
    this.scroller.scrollTop = 0;
  }

  destroy() {
    this.doc?.destroy();
    this.doc = null;
  }
}
