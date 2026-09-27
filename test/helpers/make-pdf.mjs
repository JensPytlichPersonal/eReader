// Builds a small text-only PDF for tests.
export function makePdf(pages) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const contentIds = [];
  for (const lines of pages) {
    let stream = 'BT /F1 12 Tf 72 720 Td 14 TL\n';
    for (const l of lines) stream += `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*\n`;
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
