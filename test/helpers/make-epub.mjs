import { buildZip, TINY_PNG } from './zipwriter.mjs';

// `metadata` is extra OPF metadata (e.g. series); `titleXml` replaces the <dc:title> element; `cover` is the
// cover image ({ href, type, data }); `files` are more files beside the chapters ([{ name, data }]). A chapter
// with `inToc: false` is left out of the nav and the NCX. `toc` ([{ title, href }]) is the contents instead of one
// entry for each chapter, as for chapters that share a file.
const PNG_COVER = { href: 'images/cover.png', type: 'image/png', data: TINY_PNG };
export function makeEpub({ title = 'Fixture Book', author = 'Test Author', language = 'en', chapters, withNav = true, withNcx = true, css = '', metadata = '', titleXml, cover = PNG_COVER, files = [], toc } = {}) {
  chapters ??= [
    { id: 'ch1', file: 'ch1.xhtml', title: 'Chapter One', body: '<h1 id="c1">Chapter One</h1><p class="first">Hello <em>world</em>. See <a href="ch2.xhtml#note1">note</a>.</p><p><img src="images/pic.png" alt="pic"/></p>' },
    { id: 'ch2', file: 'ch2.xhtml', title: 'Chapter Two', body: '<h1>Chapter Two</h1><p>Second chapter.</p><aside id="note1" epub:type="footnote"><p>A footnote. <a href="ch1.xhtml">back</a></p></aside><script>alert(1)</script><style>p{color:red}</style>' },
  ];
  const xhtml = (c) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${c.title}</title><link rel="stylesheet" href="style.css"/></head><body>${c.body}</body></html>`;
  const manifestItems = chapters.map((c) => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('');
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:1234</dc:identifier>${titleXml ?? `<dc:title>${title}</dc:title>`}<dc:creator>${author}</dc:creator><dc:language>${language}</dc:language>
<meta name="cover" content="cover-img"/>${metadata}
</metadata>
<manifest>
<item id="cover-img" href="${cover.href}" media-type="${cover.type}" properties="cover-image"/>
<item id="pic" href="images/pic.png" media-type="image/png"/>
<item id="css" href="style.css" media-type="text/css"/>
${withNav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
${withNcx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ''}
${manifestItems}
</manifest>
<spine ${withNcx ? 'toc="ncx"' : ''}>${spine}</spine>
</package>`;
  const listed = toc ?? chapters.filter((c) => c.inToc !== false).map((c) => ({ title: c.title, href: c.file }));
  const nav = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${listed.map((c) => `<li><a href="${c.href}">${c.title}</a></li>`).join('')}</ol></nav></body></html>`;
  const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${listed.map((c, i) => `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${c.title}</text></navLabel><content src="${c.href}"/></navPoint>`).join('')}</navMap></ncx>`;
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/style.css', data: css || 'p.first { text-indent: 0; font-weight: bold; color: #333; font-family: Verdana } h1 { text-align: center; font-size: 2em } @font-face { font-family: X; src: url(x.ttf) }' },
    { name: `OEBPS/${cover.href}`, data: cover.data },
    { name: 'OEBPS/images/pic.png', data: TINY_PNG },
    ...files.map((f) => ({ name: `OEBPS/${f.name}`, data: f.data })),
    ...chapters.map((c) => ({ name: `OEBPS/${c.file}`, data: xhtml(c) })),
  ];
  if (withNav) entries.push({ name: 'OEBPS/nav.xhtml', data: nav });
  if (withNcx) entries.push({ name: 'OEBPS/toc.ncx', data: ncx });
  return buildZip(entries);
}
