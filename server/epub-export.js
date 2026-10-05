// Download EPUB: a book as an EPUB 3 file made from the library's own copy, the sections the reader
// shows, so it holds the fixes to the text, with the details as the library shows them, edited ones
// included. The uploaded original is never changed and stays the other download. The EPUB is plainer than
// a publisher's own, as the library's copy keeps only a few styling hints and no fonts.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DomUtils, ElementType } from 'htmlparser2';
import render from 'dom-serializer';
import { writeZip } from './converters/zip.js';
import { sniffImage } from './converters/bundle.js';
import { parseSection } from './fixes.js';
// Plain browser code that never touches the page, so the server can use it too: the same rule that puts
// a book under each of its authors in Group by author.
import { authorNames } from '../public/js/groups.js';

const { isTag, isText, textContent, removeElement, findAll } = DomUtils;

const XHTML = 'application/xhtml+xml';
// The media types of the pictures a book can hold, by the type sniffImage gives them.
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
// Covers every reading app shows. Another picture is left out rather than named as the cover.
const COVER_TYPES = ['jpg', 'png', 'gif', 'webp', 'svg'];
// The most characters of a file name before ".epub".
const MAX_NAME = 150;

// ---- the file name ----

// What a file name cannot hold on one system or another: these characters, and controls.
const NOT_IN_NAMES = /[/\\:*?"<>|\u0000-\u001F\u007F-\u009F]/g;
const namePart = (text) => String(text ?? '').toWellFormed().replace(NOT_IN_NAMES, ' ').replace(/\s+/g, ' ').trim();

/**
 * The name a book downloads under: "<author>-<title>.epub" with the author and title as the library shows
 * them, or "<title>.epub" for a book without an author. Characters a file name cannot hold become spaces,
 * and a long name is cut at a word.
 */
export function epubFileName({ title, author }) {
  let name = [namePart(author), namePart(title)].filter(Boolean).join('-').replace(/^[\s.]+|[\s.]+$/g, '');
  const chars = [...name];
  if (chars.length > MAX_NAME) {
    // One more than fits, so a word that ends right at the limit is kept.
    const cut = chars.slice(0, MAX_NAME + 1).join('');
    const space = cut.lastIndexOf(' ');
    name = (space > MAX_NAME / 2 ? cut.slice(0, space) : chars.slice(0, MAX_NAME).join('')).replace(/[\s.-]+$/, '');
  }
  return `${name || 'Untitled'}.epub`;
}

// Danish letters as they are written without them, before other letters lose their accents.
const PLAIN = { æ: 'ae', Æ: 'Ae', ø: 'oe', Ø: 'Oe', å: 'aa', Å: 'Aa', ß: 'ss' };

/** A file name in printable ASCII, for apps that cannot read the UTF-8 one: "Blåbær" is "Blaabaer". */
export function asciiFileName(name) {
  // Taking accents apart can also give characters a file name cannot hold, such as "/" from a wide "／".
  return name.replace(/[æÆøØåÅß]/g, (c) => PLAIN[c]).normalize('NFKD').replace(/\p{M}+/gu, '')
    .replace(/[^\x20-\x7E]|[/\\:*?"<>|]/g, '_');
}

/** The Content-Disposition of a download named `name`: the name in ASCII for older apps, and in UTF-8. */
export function attachmentHeader(name) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${encoded}`;
}

// ---- the package ----

/**
 * The book's identifier in its EPUB, the same on every download, so a reading app knows a new download
 * is the same book: a UUID made from the book's id the way a version 5 UUID is.
 */
export function bookUuid(id) {
  const hash = crypto.createHash('sha1').update(`ereader:${id}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex', 0, 16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Characters with no place in XML: controls other than tab, newline and carriage return, U+FFFE and
// U+FFFF, and half of a character pair on its own.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Text without the characters XML cannot hold. */
export const xmlSafe = (text) => String(text ?? '').replace(NOT_XML, '');
// Text and attribute values escaped for XML by hand, so every other character stays as it is, in UTF-8.
const escText = (text) => xmlSafe(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const esc = (text) => escText(text).replace(/"/g, '&quot;');

// A language tag such as "en" or "da-DK". Anything else is taken as no language, as reading apps need a tag.
const languageOf = (value) => (/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(value || '') ? value : '');
const langAttrs = (lang) => (lang ? ` lang="${esc(lang)}" xml:lang="${esc(lang)}"` : '');

const partName = (i) => `part-${i + 1}.xhtml`;
// A bundle path ("images/x.jpg") as a link.
const hrefOf = (file) => file.split('/').map(encodeURIComponent).join('/');
const imageType = (file, data) => IMAGE_TYPES[sniffImage(data) || path.extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg')] || 'application/octet-stream';

/** The size of a picture in pixels, so the cover page can fit it to the screen; null when it cannot be read. */
function imageSize(data, type) {
  try {
    if (type === 'png') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (type === 'gif') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (type === 'webp') {
      const kind = data.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = data.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    }
    if (type === 'jpg') {
      // The size is in the frame header, after markers of other kinds, each with its length.
      for (let i = 2; i + 9 < data.length;) {
        if (data[i] !== 0xff) return null;
        const marker = data[i + 1];
        if (marker === 0xff) { i++; continue; }
        if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
        i += 2 + data.readUInt16BE(i + 2);
      }
    }
  } catch { /* cut short */ }
  return null;
}

// ---- the text ----

const hasClass = (el, name) => (el.attribs?.class || '').split(/\s+/).includes(name);
// The notes a PDF's text gathers at the end of a section: p.footnote with an id, in section.endnotes.
const isEndnotes = (el) => el.name === 'section' && hasClass(el, 'endnotes');
const isNote = (node) => isTag(node) && node.name === 'p' && hasClass(node, 'footnote') && !!node.attribs.id;
const inSup = (el) => {
  for (let p = el.parent; p; p = p.parent) if (p.name === 'sup') return true;
  return false;
};
const OUTSIDE = /^(https?:|mailto:)/i;
const EMPTY_PAGE = /^\[Page (\d+) has no extractable text - use the page view\]$/;
const textNode = (data, parent) => ({ type: ElementType.Text, data, parent });
// What a book said its own elements are (its epub:type, which the converter keeps as data-type), such as its
// notes and the links to them. A value with a prefix of its own is left out, as the EPUB would have to declare it.
const ownTypes = (value) => value.split(/\s+/).filter((t) => t && !t.includes(':')).join(' ');

/**
 * Where links in the sections (as parseSection gives them) can lead: `ids`, the ids in each section, and
 * `notes`, the ids of the PDF's footnotes.
 */
export function linkTargets(roots) {
  const ids = roots.map((root) => new Set(findAll((e) => !!e.attribs.id, root.children).map((e) => e.attribs.id)));
  const notes = new Set();
  for (const root of roots) {
    for (const endnotes of findAll(isEndnotes, root.children)) for (const p of endnotes.children.filter(isNote)) notes.add(p.attribs.id);
  }
  return { ids, notes };
}

/**
 * Makes the nodes of a section (as parseSection gives them) the text of an EPUB part, in place, escaped
 * for renderPart. `book`: { ids and notes, as linkTargets gives them; images, the pictures there are by
 * bundle path; used, a Set the pictures used are added to }.
 */
export function exportNodes(nodes, book) {
  for (const node of [...nodes]) {
    if (isText(node)) { node.data = escText(node.data); continue; }
    if (!isTag(node)) { removeElement(node); continue; }
    const a = node.attribs;
    if (node.name === 'img') {
      // A picture whose file is missing is left out.
      if (!book.images.has(a['data-src'])) { removeElement(node); continue; }
      book.used.add(a['data-src']);
      a.src = `../${hrefOf(a['data-src'])}`;
      a.alt ??= '';
      delete a.loading;
    } else if (node.name === 'a') {
      const sec = /^\d+$/.test(a['data-sec'] || '') ? Number(a['data-sec']) : -1;
      if (sec >= 0 && sec < book.ids.length) {
        // A link to a place its book does not have leads to the top of the part.
        const id = book.ids[sec].has(a['data-id']) ? a['data-id'] : '';
        a.href = `${partName(sec)}${id ? `#${id}` : ''}`;
        // Reading apps that know footnotes then show the note over the text.
        if (id && book.notes.has(id) && inSup(node)) a['epub:type'] = 'noteref';
      } else if (!OUTSIDE.test(a.href || '')) delete a.href;
    } else if (node.name === 'span' && hasClass(node, 'pdf-empty')) {
      // The page view is the app's, not the reading app's.
      const page = EMPTY_PAGE.exec(textContent(node).trim())?.[1];
      if (page) node.children = [textNode(`[Page ${page} has no text]`, node)];
    } else if (node.name === 'hr' && hasClass(node, 'scene-break')) {
      // As text, so apps that draw nothing a stylesheet adds still show the break. The app reads it back as one.
      node.name = 'p';
      node.children = [textNode('* * *', node)];
    } else if (isEndnotes(node)) {
      a['epub:type'] = 'footnotes';
      for (const p of node.children.filter(isNote)) {
        const aside = { type: ElementType.Tag, name: 'aside', attribs: { 'epub:type': 'footnote', id: p.attribs.id }, children: [p], parent: node };
        node.children[node.children.indexOf(p)] = aside;
        p.parent = aside;
        delete p.attribs.id;
      }
    }
    // Reading apps that know a book's notes show them over the text.
    const types = ownTypes(a['data-type'] || '');
    if (types && !a['epub:type']) a['epub:type'] = types;
    for (const k of Object.keys(a)) {
      if (k.startsWith('data-')) delete a[k];
      else a[k] = esc(a[k]);
    }
    exportNodes(node.children, book);
  }
}

/** The nodes exportNodes made as XHTML: already escaped, so written as they are. */
export const renderPart = (nodes) => render(nodes, { xmlMode: true, encodeEntities: false });

/**
 * The contents as the EPUB links them: [{ title, href, children }], `ids` the ids in each part (see
 * linkTargets). An entry without a part is left out, and its own entries take its place.
 */
function contentsOf(toc, ids) {
  const out = [];
  for (const e of toc || []) {
    const children = contentsOf(e.children, ids);
    if (Number.isInteger(e.section) && e.section >= 0 && e.section < ids.length) {
      const id = e.id && ids[e.section].has(e.id) ? e.id : '';
      out.push({ title: xmlSafe(e.title).trim() || 'Untitled', href: `text/${partName(e.section)}${id ? `#${id}` : ''}`, children });
    } else out.push(...children);
  }
  return out;
}

// ---- the files ----

// The EPUB's own styles: the rules of the reader's look (public/css/reader.css) a book needs to read as it
// does in the app, without its themes, fonts or columns, so the reading app's own settings apply. The
// book's kept styles follow them.
const BOOK_CSS = `/* A break between scenes: three spaced asterisks, as print sets them */
.book-content p.scene-break { text-align: center; text-indent: 0; margin: 0.9em 0; }
/* A page break the book asks for */
.book-content hr.pagebreak { border: 0; margin: 0; page-break-after: always; break-after: page; }
/* Footnotes smaller, and the notes at the end of a part set apart. No rule above them: apps that show a
   note over the text hide the notes, and would draw the rule alone. */
.book-content p.footnote { font-size: 0.85em; text-indent: 0; }
.book-content .endnotes { margin-top: 1.5em; padding-top: 0.6em; }
/* Pictures no wider than the screen */
.book-content img { max-width: 100%; height: auto; }
/* The places links lead to, and the hidden page marks of a PDF, take no space */
.book-content .anchor, .book-content span.pg { display: inline; margin: 0; padding: 0; border: 0; }
/* What a PDF page without text says */
.book-content .pdf-empty { font-style: italic; opacity: 0.6; }
/* The cover page: the picture alone, whole, as large as the screen allows */
html.cover-page, html.cover-page body, html.cover-page div.cover { height: 100%; margin: 0; padding: 0; }
html.cover-page body { text-align: center; }
html.cover-page img { max-width: 100%; max-height: 100%; }
`;

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`;

const xhtmlDocument = ({ title, lang, body, pageClass, stylesheet = '../styles/book.css' }) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"${langAttrs(lang)}${pageClass ? ` class="${pageClass}"` : ''}>
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
${stylesheet ? `<link rel="stylesheet" type="text/css" href="${stylesheet}"/>\n` : ''}</head>
<body>
${body}
</body>
</html>
`;

// The cover alone. With its size known it is drawn in an SVG the size of the screen, which every reading
// app fits whole, as calibre and Pandoc do; without, as a picture no larger than the screen.
function coverBody(cover) {
  const href = `../${cover.name}`;
  const size = cover.size;
  const picture = size
    ? `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${size.width} ${size.height}" preserveAspectRatio="xMidYMid meet"><image width="${size.width}" height="${size.height}" xlink:href="${href}"/></svg>`
    : `<img src="${href}" alt="Cover"/>`;
  return `<div class="cover" epub:type="cover">${picture}</div>`;
}

function navDocument({ lang, contents, cover }) {
  const list = (entries) => `<ol>\n${entries.map((e) => `<li><a href="${esc(e.href)}">${esc(e.title)}</a>${e.children.length ? `\n${list(e.children)}\n` : ''}</li>`).join('\n')}\n</ol>`;
  const landmarks = [
    cover ? '<li><a epub:type="cover" href="text/cover.xhtml">Cover</a></li>' : '',
    `<li><a epub:type="bodymatter" href="text/${partName(0)}">Start</a></li>`,
  ].filter(Boolean).join('\n');
  const body = `<nav epub:type="toc" id="toc">
<h1>Contents</h1>
${list(contents)}
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<h2>Landmarks</h2>
<ol>
${landmarks}
</ol>
</nav>`;
  return xhtmlDocument({ title: 'Contents', lang, body, stylesheet: '' });
}

// The contents again for older e-readers. Entries that lead to the same place share their number in the
// reading order, as the format asks.
function ncxDocument({ uuid, title, lang, contents }) {
  const order = new Map();
  let points = 0;
  let depth = 1;
  const navPoints = (entries, level) => entries.map((e) => {
    depth = Math.max(depth, level);
    if (!order.has(e.href)) order.set(e.href, order.size + 1);
    return `<navPoint id="np-${++points}" playOrder="${order.get(e.href)}"><navLabel><text>${esc(e.title)}</text></navLabel><content src="${esc(e.href)}"/>${e.children.length ? `\n${navPoints(e.children, level + 1)}\n` : ''}</navPoint>`;
  }).join('\n');
  const map = navPoints(contents, 1);
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"${lang ? ` xml:lang="${esc(lang)}"` : ''}>
<head>
<meta name="dtb:uid" content="${uuid}"/>
<meta name="dtb:depth" content="${depth}"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${map}
</navMap>
</ncx>
`;
}

// The package's details, as the library shows them. The series are written both as EPUB 3 collections and
// as calibre writes them, so reading apps of either kind, and this app, read them back.
function metadataOf({ uuid, book, title, lang, series, modified, cover }) {
  const lines = [`<dc:identifier id="book-id">${uuid}</dc:identifier>`];
  for (const isbn of (book.isbns || '').split(/\s+/).filter((x) => /^\d{13}$/.test(x))) lines.push(`<dc:identifier>urn:isbn:${isbn}</dc:identifier>`);
  lines.push(`<dc:title>${esc(title)}</dc:title>`);
  authorNames(xmlSafe(book.author)).forEach((name, i) => {
    lines.push(`<dc:creator id="author-${i + 1}">${esc(name)}</dc:creator>`, `<meta refines="#author-${i + 1}" property="role" scheme="marc:relators">aut</meta>`);
  });
  lines.push(`<dc:language>${esc(lang || 'und')}</dc:language>`);
  const genre = xmlSafe(book.genre).trim();
  if (genre) lines.push(`<dc:subject>${esc(genre)}</dc:subject>`);
  lines.push(`<meta property="dcterms:modified">${modified}</meta>`);
  series.forEach((s, i) => {
    const id = `c${i + 1}`;
    lines.push(`<meta property="belongs-to-collection" id="${id}">${esc(s.name)}</meta>`,
      `<meta refines="#${id}" property="collection-type">${s.position != null ? 'series' : 'set'}</meta>`);
    // A book holding several, such as an omnibus, is placed by its first number.
    if (s.position != null) lines.push(`<meta refines="#${id}" property="group-position">${s.position}</meta>`);
  });
  const numbered = series.find((s) => s.position != null);
  if (numbered) lines.push(`<meta name="calibre:series" content="${esc(numbered.name)}"/>`, `<meta name="calibre:series_index" content="${numbered.position}"/>`);
  if (cover) lines.push('<meta name="cover" content="cover-image"/>');
  return lines.join('\n');
}

/**
 * Reads what a book's EPUB is made from out of its folder `dir`: the manifest (book.json), the sections'
 * HTML, the pictures by bundle path, the kept styles, and the cover the library shows, as `book` (its row
 * in books) says. Read it under the book's lock (see fixes.js), so no fix or conversion is halfway through.
 */
export async function readBookFiles(dir, book) {
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'book.json'), 'utf8'));
  const sections = [];
  for (let i = 0; i < manifest.sections.length; i++) sections.push(await fsp.readFile(path.join(dir, 'sections', `${i}.html`), 'utf8'));
  const images = new Map();
  let names = [];
  try { names = await fsp.readdir(path.join(dir, 'images'), { recursive: true }); } catch { /* no pictures */ }
  for (const name of names) {
    const data = await fsp.readFile(path.join(dir, 'images', name)).catch(() => null); // null for a folder
    if (data) images.set(`images/${name.split(path.sep).join('/')}`, data);
  }
  const styles = manifest.hasStyles ? await fsp.readFile(path.join(dir, 'styles.css'), 'utf8').catch(() => '') : '';
  // As the /:id/cover route in routes/books.js finds it: one picked by hand, or the one in the book's file.
  const prefix = book.cover_source === 'custom' ? 'custom-cover.' : book.cover_source === 'file' && book.has_cover ? 'cover.' : null;
  const coverName = prefix && (await fsp.readdir(dir)).find((f) => f.startsWith(prefix));
  const cover = coverName ? await fsp.readFile(path.join(dir, coverName)) : null;
  return { manifest, sections, images, styles, cover };
}

/**
 * The book as an EPUB file (a Buffer): `book` its row in books, `series` its series and collections as
 * series.forBook gives them, `files` what readBookFiles read. `now` is the time it is made.
 */
export function buildEpub({ book, series = [], files }, now = new Date()) {
  const { manifest } = files;
  const lang = languageOf(book.language);
  const title = xmlSafe(book.title).trim() || 'Untitled';
  const uuid = bookUuid(book.id);

  const roots = files.sections.map(parseSection);
  const targets = linkTargets(roots);
  const text = { ...targets, images: files.images, used: new Set() };
  const texts = roots.map((root, i) => {
    exportNodes(root.children, text);
    const body = `<div class="book-content">${renderPart(root.children)}</div>`;
    return xhtmlDocument({ title: xmlSafe(manifest.sections[i]?.title).trim() || title, lang, body });
  });
  const pictures = [...text.used].map((file, i) => ({ id: `img-${i + 1}`, file, data: files.images.get(file), type: imageType(file, files.images.get(file)) }));

  const coverType = files.cover && sniffImage(files.cover);
  const cover = COVER_TYPES.includes(coverType)
    ? { name: `cover.${coverType}`, type: IMAGE_TYPES[coverType], data: files.cover, size: coverType === 'svg' ? null : imageSize(files.cover, coverType) }
    : null;
  if (cover?.size && !(cover.size.width > 0 && cover.size.height > 0)) cover.size = null;

  let contents = contentsOf(manifest.toc, targets.ids);
  if (!contents.length) contents = [{ title, href: `text/${partName(0)}`, children: [] }];

  const items = [
    { id: 'nav', href: 'nav.xhtml', type: XHTML, properties: 'nav' },
    { id: 'ncx', href: 'toc.ncx', type: 'application/x-dtbncx+xml' },
    { id: 'css', href: 'styles/book.css', type: 'text/css' },
    ...(cover ? [
      { id: 'cover-image', href: cover.name, type: cover.type, properties: 'cover-image' },
      { id: 'cover-page', href: 'text/cover.xhtml', type: XHTML, properties: cover.size ? 'svg' : '' },
    ] : []),
    ...texts.map((t, i) => ({ id: `part-${i + 1}`, href: `text/${partName(i)}`, type: XHTML })),
    ...pictures.map((p) => ({ id: p.id, href: hrefOf(p.file), type: p.type })),
  ];
  const spine = [...(cover ? ['cover-page'] : []), ...texts.map((t, i) => `part-${i + 1}`)];
  const modified = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"${lang ? ` xml:lang="${esc(lang)}"` : ''}>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${metadataOf({ uuid, book, title, lang, series, modified, cover })}
</metadata>
<manifest>
${items.map((it) => `<item id="${it.id}" href="${esc(it.href)}" media-type="${it.type}"${it.properties ? ` properties="${it.properties}"` : ''}/>`).join('\n')}
</manifest>
<spine toc="ncx">
${spine.map((id) => `<itemref idref="${id}"/>`).join('\n')}
</spine>
</package>
`;

  return writeZip([
    // First, and stored as it is, so a reading app can tell what the file is from its first bytes.
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: navDocument({ lang, contents, cover }) },
    { name: 'OEBPS/toc.ncx', data: ncxDocument({ uuid, title, lang, contents }) },
    { name: 'OEBPS/styles/book.css', data: files.styles ? `${BOOK_CSS}\n${files.styles}\n` : BOOK_CSS },
    ...(cover ? [
      { name: `OEBPS/${cover.name}`, data: cover.data, store: true },
      { name: 'OEBPS/text/cover.xhtml', data: xhtmlDocument({ title: 'Cover', lang, body: coverBody(cover), pageClass: 'cover-page' }) },
    ] : []),
    ...texts.map((data, i) => ({ name: `OEBPS/text/${partName(i)}`, data })),
    // Pictures are compressed already.
    ...pictures.map((p) => ({ name: `OEBPS/${p.file}`, data: p.data, store: true })),
  ]);
}
