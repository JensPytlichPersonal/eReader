import path from 'node:path/posix';
import { ZipReader } from './zip.js';
import { parseXml, findAllLocal, findFirstLocal, attr, text, children, localName } from './xml.js';
import { normalizeDocument } from './html.js';
import { filterStylesheet } from './css.js';
import { assembleSections, imageExt } from './bundle.js';
import { opfTitleAndSeries } from './series.js';
import { uniqueIsbns } from './isbn.js';

const HTML_TYPES = new Set(['application/xhtml+xml', 'text/html', 'application/x-dtbook+xml']);

function resolvePath(base, href) {
  // base is a zip path of the referencing document; href may be relative and percent-encoded
  let clean = href.split('#')[0].split('?')[0];
  try { clean = decodeURIComponent(clean); } catch { /* keep as-is */ }
  if (!clean) return path.dirname(base) === '.' ? '' : base;
  if (clean.startsWith('/')) return clean.slice(1);
  return path.normalize(path.join(path.dirname(base), clean));
}

function fragmentOf(href) {
  const i = href.indexOf('#');
  return i >= 0 ? href.slice(i + 1) : '';
}

/** Locates and parses the OPF package document. */
function openPackage(zip) {
  let opfPath = null;
  if (zip.has('META-INF/container.xml')) {
    const container = parseXml(zip.readText('META-INF/container.xml'));
    const rootfile = findAllLocal(container, 'rootfile').find((r) => /oebps-package|opf/i.test(attr(r, 'media-type') || '') || attr(r, 'full-path'));
    opfPath = attr(rootfile, 'full-path');
  }
  if (!opfPath || !zip.has(opfPath)) {
    opfPath = zip.names().find((n) => n.toLowerCase().endsWith('.opf'));
  }
  if (!opfPath) throw new Error('EPUB has no OPF package document');
  return { opf: parseXml(zip.readText(opfPath)), opfPath };
}

/** Title, author, language, series and ISBNs from a package's <metadata>, '' where it names none. */
function packageDetails(opf) {
  const metadata = findFirstLocal(opf, 'metadata') || opf;
  const { title, series } = opfTitleAndSeries(metadata);
  const creators = findAllLocal(metadata, 'creator').map(text).filter(Boolean);
  const language = text(findFirstLocal(metadata, 'language'));
  // The e-book's own ISBN first, then the printed book's (dc:source).
  const isbns = uniqueIsbns([...findAllLocal(metadata, 'identifier'), ...findAllLocal(metadata, 'source')]
    .map((el) => ({ value: text(el), isbn: /^isbn$/i.test(attr(el, 'scheme') || '') })));
  return { title, author: creators.join(', '), language, series, isbns };
}

/** Title, author, language, series and ISBNs from the package's <metadata>, the title '' when it names none. */
function packageMetadata(opf) {
  return { ...packageDetails(opf), format: 'epub' };
}

/**
 * The details in an OPF file of its own, such as the one calibre keeps beside each book: title, author,
 * language, series and ISBNs, '' where it names none. null when it is not an OPF file or names nothing.
 */
export function readOpfDetails(data) {
  const opf = parseXml(String(data));
  if (!findFirstLocal(opf, 'metadata')) return null;
  const details = packageDetails(opf);
  return details.title || details.author || details.series.length || details.isbns.length ? details : null;
}

/** Reads only the book's details, without converting it. */
export async function readEpubMetadata(buffer) {
  return packageMetadata(openPackage(new ZipReader(buffer)).opf);
}

export async function convertEpub(buffer) {
  const zip = new ZipReader(buffer);
  // 1. container -> OPF
  const { opf, opfPath } = openPackage(zip);
  const abs = (href) => resolvePath(opfPath, href);

  // 2. metadata
  const meta = packageMetadata(opf);
  const metaCoverId = findAllLocal(findFirstLocal(opf, 'metadata') || opf, 'meta').find((m) => (attr(m, 'name') || '').toLowerCase() === 'cover');

  // 3. manifest
  const manifest = new Map();
  for (const item of findAllLocal(findFirstLocal(opf, 'manifest') || opf, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    manifest.set(id, { id, href, path: abs(href), type: (attr(item, 'media-type') || '').toLowerCase(), properties: (attr(item, 'properties') || '').split(/\s+/) });
  }
  const byPath = new Map([...manifest.values()].map((i) => [i.path, i]));

  // 4. spine
  const spineEl = findFirstLocal(opf, 'spine');
  const spineItems = [];
  for (const ref of findAllLocal(spineEl || opf, 'itemref')) {
    const item = manifest.get(attr(ref, 'idref'));
    if (item && (HTML_TYPES.has(item.type) || /\.x?html?$/i.test(item.path)) && zip.has(item.path)) spineItems.push({ ...item, linear: (attr(ref, 'linear') || 'yes') !== 'no' });
  }
  if (!spineItems.length) {
    // Fall back to any html documents in the archive, in name order.
    for (const n of zip.names().filter((n) => /\.x?html?$/i.test(n)).sort()) spineItems.push({ id: n, href: n, path: n, type: 'application/xhtml+xml', linear: true });
  }
  if (!spineItems.length) throw new Error('EPUB contains no readable chapters');

  // 5. images and css collection
  const images = new Map(); // bundle path -> Buffer
  const imagePathFor = new Map(); // zip path -> bundle path
  let imgCounter = 0;
  const resolveImageFrom = (docPath) => (src) => {
    if (!src || /^(data:|https?:)/i.test(src)) return null;
    const zp = resolvePath(docPath, src);
    if (!zip.has(zp)) return null;
    if (!imagePathFor.has(zp)) {
      const data = zip.read(zp);
      const ext = imageExt(zp, data);
      const base = path.basename(zp).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'img';
      const out = `images/${imgCounter++}_${base}.${ext}`;
      imagePathFor.set(zp, out);
      images.set(out, data);
    }
    return imagePathFor.get(zp);
  };
  const resolveLinkFrom = (docPath) => (href) => {
    if (!href || /^[a-z]+:/i.test(href)) return null;
    if (href.startsWith('#')) return `${docPath}${href}`;
    const zp = resolvePath(docPath, href);
    const frag = fragmentOf(href);
    return frag ? `${zp}#${frag}` : zp;
  };

  const cssParts = [];
  for (const item of manifest.values()) {
    if (item.type === 'text/css' && zip.has(item.path)) {
      try { cssParts.push(zip.readText(item.path)); } catch { /* ignore */ }
    }
  }

  // 6. chapters
  const chapters = [];
  for (const item of spineItems) {
    let html;
    try { html = zip.readText(item.path); } catch { continue; }
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) cssParts.push(m[1]);
    const { root } = normalizeDocument(html, { resolveImage: resolveImageFrom(item.path), resolveLink: resolveLinkFrom(item.path) });
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    chapters.push({ root, key: item.path, title: titleMatch ? titleMatch[1].trim() : undefined, linear: item.linear });
  }
  // Chapter <title> elements are often the book title; only keep them as section titles if they vary.
  const distinctTitles = new Set(chapters.map((c) => c.title).filter(Boolean));
  if (distinctTitles.size <= 1) for (const c of chapters) c.title = undefined;

  // 7. table of contents (EPUB3 nav, then NCX)
  let toc = [];
  const navItem = [...manifest.values()].find((i) => i.properties.includes('nav') && zip.has(i.path));
  if (navItem) toc = parseNav(zip.readText(navItem.path), navItem.path);
  if (!toc.length) {
    const ncxId = attr(spineEl, 'toc');
    let ncxItem = ncxId ? manifest.get(ncxId) : null;
    if (!ncxItem) ncxItem = [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml' || /\.ncx$/i.test(i.path));
    if (ncxItem && zip.has(ncxItem.path)) toc = parseNcx(zip.readText(ncxItem.path), ncxItem.path);
  }

  // 8. cover
  let cover = null;
  let coverItem = null;
  if (metaCoverId) coverItem = manifest.get(attr(metaCoverId, 'content'));
  if (!coverItem) coverItem = [...manifest.values()].find((i) => i.properties.includes('cover-image'));
  if (!coverItem) coverItem = [...manifest.values()].find((i) => /image\//.test(i.type) && /cover/i.test(i.id + ' ' + i.href));
  if (!coverItem) {
    // Cover page document referencing a single image
    const guideCover = findAllLocal(findFirstLocal(opf, 'guide') || { children: [] }, 'reference').find((r) => /cover/i.test(attr(r, 'type') || ''));
    const coverDoc = guideCover ? abs(attr(guideCover, 'href') || '') : spineItems[0]?.path;
    if (coverDoc && zip.has(coverDoc)) {
      const m = zip.readText(coverDoc).match(/(?:src|xlink:href|href)=["']([^"']+\.(?:jpe?g|png|gif|webp))["']/i);
      if (m) { const zp = resolvePath(coverDoc, m[1]); if (byPath.has(zp) || zip.has(zp)) coverItem = { path: zp }; }
    }
  }
  if (coverItem && zip.has(coverItem.path)) {
    const data = zip.read(coverItem.path);
    cover = { ext: imageExt(coverItem.path, data), data };
  }

  const { sections, toc: finalToc } = assembleSections(chapters, { toc });
  const css = filterStylesheet(cssParts.join('\n'), '.book-content');
  return {
    meta,
    sections,
    toc: finalToc,
    images,
    cover,
    css,
  };
}

function parseNav(html, navPath) {
  const doc = parseXml(html);
  const navs = findAllLocal(doc, 'nav');
  const tocNav = navs.find((n) => /\btoc\b/i.test(attr(n, 'epub:type') || attr(n, 'type') || '')) || navs[0];
  if (!tocNav) return [];
  const ol = children(tocNav).find((c) => localName(c) === 'ol');
  if (!ol) return [];
  const walk = (olEl) => children(olEl).filter((li) => localName(li) === 'li').map((li) => {
    const a = children(li).find((c) => localName(c) === 'a' || localName(c) === 'span');
    const href = a && localName(a) === 'a' ? attr(a, 'href') : null;
    const sub = children(li).find((c) => localName(c) === 'ol');
    const entry = { title: text(a) || text(li).slice(0, 100), key: href ? `${resolvePath(navPath, href)}${fragmentOf(href) ? '#' + fragmentOf(href) : ''}` : null };
    if (sub) entry.children = walk(sub);
    return entry;
  });
  return walk(ol);
}

function parseNcx(xml, ncxPath) {
  const doc = parseXml(xml);
  const navMap = findFirstLocal(doc, 'navmap');
  if (!navMap) return [];
  const walk = (parent) => children(parent).filter((c) => localName(c) === 'navpoint').map((np) => {
    const label = text(findFirstLocal(np, 'text'));
    const content = children(np).find((c) => localName(c) === 'content');
    const src = attr(content, 'src');
    const entry = { title: label, key: src ? `${resolvePath(ncxPath, src)}${fragmentOf(src) ? '#' + fragmentOf(src) : ''}` : null };
    const kids = walk(np);
    if (kids.length) entry.children = kids;
    return entry;
  });
  return walk(navMap);
}
