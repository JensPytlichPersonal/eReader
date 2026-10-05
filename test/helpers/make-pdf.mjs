// Builds a small text-only PDF for tests, optionally with a document title/author and an XMP metadata packet. A
// line is its text, in 12 point, or { text, size } for another size, as a heading.
export function makePdf(pages, { title, author, xmp } = {}) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const contentIds = [];
  for (const lines of pages) {
    let stream = 'BT /F1 12 Tf 72 720 Td 14 TL\n';
    for (const l of lines) {
      const { text, size = 12 } = typeof l === 'string' ? { text: l } : l;
      const line = `(${text.replace(/[()\\]/g, '\\$&')}) Tj T*`;
      stream += size === 12 ? `${line}\n` : `/F1 ${size} Tf ${size + 2} TL ${line} /F1 12 Tf 14 TL\n`;
    }
    stream += 'ET';
    contentIds.push(add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    pageIds.push(objs.length + 1);
    add('');
  }
  const pagesId = objs.length + 1;
  pageIds.forEach((pid, i) => {
    objs[pid - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
  });
  add(`<< /Type /Pages /Kids [${pageIds.map((p) => p + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
  const str = (v) => `(${v.replace(/[()\\]/g, '\\$&')})`;
  const infoId = title || author ? add(`<< ${title ? `/Title ${str(title)}` : ''} ${author ? `/Author ${str(author)}` : ''} >>`) : null;
  const xmpId = xmp ? add(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp, 'latin1')} >>\nstream\n${xmp}\nendstream`) : null;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R${xmpId ? ` /Metadata ${xmpId} 0 R` : ''} >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R${infoId ? ` /Info ${infoId} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Builds a PDF laid out like a scanned book: each page a page-sized image (one grey pixel, stretched) with the OCR
 * engine's text over it, drawn invisibly one word at a time, in Courier stretched to fill the word's box. Words are
 * { text, x, y, size, width } in PDF space; use ocrLine() to set a line the way OCR layers do.
 */
export function makeScannedPdf(pages, { width = 300, height = 480 } = {}) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const imageId = add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xf0\nendstream');
  const str = (v) => `(${v.replace(/[()\\]/g, '\\$&')})`;
  const pageIds = [];
  const contentIds = [];
  for (const words of pages) {
    let stream = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q\nBT 3 Tr\n`;
    for (const w of words) {
      const stretch = w.width / (0.6 * w.size * w.text.length); // Courier is 0.6 em a letter
      stream += `/F1 ${w.size.toFixed(2)} Tf ${stretch.toFixed(4)} 0 0 1 ${w.x.toFixed(2)} ${w.y.toFixed(2)} Tm ${str(`${w.text} `)} Tj\n`;
    }
    stream += 'ET';
    contentIds.push(add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    pageIds.push(objs.length + 1);
    add('');
  }
  const pagesId = objs.length + 1;
  pageIds.forEach((pid, i) => {
    objs[pid - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> >>`;
  });
  add(`<< /Type /Pages /Kids [${pageIds.map((p) => p + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * The words of one printed line as an OCR layer places them: each at the bottom of the box around its letters and
 * sized to that box, so words with descenders sit lower, words without ascenders come out small and a quote mark
 * read as a word of its own sits high. Letters are half the type size wide, and a quote mark sits next to its word.
 * `x` is where the line starts, `baseline` where it stands, `size` its type size.
 */
export function ocrLine(text, x, baseline, size) {
  const words = [];
  const tokens = text.split(' ').filter(Boolean);
  tokens.forEach((token, i) => {
    const tall = /[A-Zbdfhiklt0-9!?]/.test(token);
    const quote = /^["'“”‘’]+$/.test(token);
    const deep = /[gjpqy,;]/.test(token);
    const top = baseline + size * (quote ? 0.95 : tall ? 0.72 : 0.5);
    const bottom = quote ? baseline + size * 0.45 : baseline - (deep ? size * 0.22 : 0);
    const width = size * (quote ? 0.25 : 0.5 * token.length);
    words.push({ text: token, x, y: bottom, size: top - bottom, width });
    // A quote mark touches the word it belongs to: an opening one the next, a closing one the last.
    const opening = quote && i === 0 || (quote && /[.!?,;:]$/.test(tokens[i - 1]) === false);
    const glued = (quote && opening) || /^["'“”‘’]+$/.test(tokens[i + 1] || '') && /[.!?,;:]$/.test(token);
    x += width + (glued ? size * 0.06 : size * 0.3);
  });
  return words;
}
