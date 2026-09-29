import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeEpub } from './helpers/make-epub.mjs';
import { makeMobi, fixtureMobiHtml, palmdocCompress } from './helpers/make-mobi.mjs';
import { buildZip, TINY_PNG } from './helpers/zipwriter.mjs';
import { ZipReader } from '../server/converters/zip.js';
import { palmdocDecompress, trailingSize, readVarint, fromBase32 } from '../server/converters/mobi-codec.js';
import { filterStylesheet, filterInlineStyle } from '../server/converters/css.js';
import { normalizeDocument, chunkNodes, serialize, removeCreditLines } from '../server/converters/html.js';
import { textToHtml } from '../server/converters/text.js';
import { convertMarkdown } from '../server/converters/markdown.js';
import { convertEpub } from '../server/converters/epub.js';
import { convertMobi } from '../server/converters/mobi.js';
import { convertPdf, pageItemsToBlocks, pageLines, linesToBlocks, lineKey, edgeBand, blocksToHtml, joinHyphenated, mergePages, readOperators, numberedRunningLines, numberVariants, isOcrNoise } from '../server/converters/pdf.js';
const pdfInternals = { pageLines, linesToBlocks, lineKey, edgeBand, blocksToHtml, joinHyphenated, mergePages };
import { convert, detectFormat } from '../server/converters/index.js';
import { writeBundle, sniffImage, imageExt } from '../server/converters/bundle.js';
import { makePdf, makeScannedPdf, ocrLine } from './helpers/make-pdf.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-conv-'));
const sectionHtml = (dir, i) => fs.readFileSync(path.join(dir, 'sections', `${i}.html`), 'utf8');

test('zip reader reads stored and deflated entries', () => {
  const zip = new ZipReader(buildZip([{ name: 'a.txt', data: 'hello', store: true }, { name: 'dir/b.txt', data: 'world '.repeat(100) }]));
  assert.deepEqual(zip.names(), ['a.txt', 'dir/b.txt']);
  assert.equal(zip.readText('a.txt'), 'hello');
  assert.equal(zip.readText('dir/b.txt'), 'world '.repeat(100));
  assert.throws(() => zip.read('missing'));
});

test('palmdoc round trip and trailing entries', () => {
  const sample = Buffer.from('Hello hello hello world, the world says hello. '.repeat(30) + 'Ünïcödé ✓ \x01\x02 bytes', 'utf8');
  assert.ok(palmdocDecompress(palmdocCompress(sample)).equals(sample));
  // multibyte flag: last byte low bits + 1
  assert.equal(trailingSize(Buffer.from([1, 2, 3, 0x02]), 1), 3);
  // one extra trailing entry of size 2 (1 payload byte + backward varint 0x82) plus a 1-byte multibyte entry
  assert.equal(trailingSize(Buffer.from([9, 9, 9, 9, 0x00, 0x55, 0x82]), 0b11), 2 + 1);
  assert.deepEqual(readVarint(Buffer.from([0x01, 0x82]), 0), { value: 130, consumed: 2 });
  assert.equal(fromBase32('0001'), 1);
  assert.equal(fromBase32('V'), 31);
});

test('css filter keeps typographic hints only', () => {
  const css = `@font-face { font-family: X; src: url(x.ttf) }
  body { margin: 20px; font-family: Verdana } p.first { text-indent: 0 !important; color: red; font-size: 12pt; font-weight: bold; margin-top: 16px }
  @media screen { h1 { text-align: center; font-family: Foo } } @media print { h2 { display: none } }`;
  const out = filterStylesheet(css, '.book-content');
  assert.match(out, /\.book-content p\.first\{text-indent:0;font-weight:bold;margin-top:1em\}/);
  assert.match(out, /\.book-content h1\{text-align:center\}/);
  assert.doesNotMatch(out, /Verdana|color|font-size|print|h2/);
  assert.equal(filterInlineStyle('color: red; text-align: center; font-family: X'), 'text-align:center');
});

test('html normaliser sanitises and keeps structure', () => {
  const { root, images } = normalizeDocument(`<html><head><style>p{}</style></head><body>
    <div id="wrap"><h1>Title</h1><p class="x" style="color:red;text-align:center" onclick="x()">Hi <b>there</b><script>bad()</script></p>
    <center>c</center><font size="3">f</font><img src="a.png"/><img src="missing.png"/>
    <a href="http://x.y/z">ext</a><a href="ch2.xhtml#f">int</a><svg><image xlink:href="a.png"/></svg><mbp:pagebreak/></div></body></html>`,
  { resolveImage: (s) => (s === 'a.png' ? 'images/a.png' : null), resolveLink: (h) => `key:${h}` });
  const html = serialize(root.children);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p class="x" style="text-align:center">Hi <b>there<\/b><\/p>/);
  assert.doesNotMatch(html, /script|onclick|<font|<center|missing/);
  assert.match(html, /<div style="text-align:center">c<\/div>/);
  assert.match(html, /<a href="http:\/\/x.y\/z" target="_blank" rel="noopener">ext<\/a>/);
  assert.match(html, /<a data-link="key:ch2.xhtml#f">int<\/a>/);
  assert.match(html, /<hr class="pagebreak"/);
  assert.equal((html.match(/data-src="images\/a.png"/g) || []).length, 2);
  assert.deepEqual(images, ['images/a.png']);
});

test('chunker splits large wrappers at block boundaries', () => {
  const paras = Array.from({ length: 50 }, (_, i) => `<p id="p${i}">${'x'.repeat(1000)}</p>`).join('');
  const { root } = normalizeDocument(`<body><div id="all">${paras}</div></body>`);
  const chunks = chunkNodes(root, 10000);
  assert.ok(chunks.length >= 5, `expected >=5 chunks, got ${chunks.length}`);
  assert.match(serialize(chunks[0]), /id="all"/);
  assert.equal(chunks.flat().filter((n) => n.name === 'p').length, 50);
});

test('plain text: hard-wrapped paragraphs and headings', () => {
  const html = textToHtml('CHAPTER I\n\n' + 'It was a bright cold day in April, and the clocks were striking\nthirteen. Winston Smith, his chin nuzzled into his breast in an\neffort to escape the vile wind, slipped quickly through the glass\ndoors of Victory Mansions.\n\n'.repeat(12));
  assert.match(html, /^<h2>CHAPTER I<\/h2>/);
  assert.match(html, /<p>It was a bright cold day in April, and the clocks were striking thirteen\./);
});

test('text conversion produces a bundle', async () => {
  const book = await convert(Buffer.from('Hello\n\nWorld & <friends>'), { filename: 'my_book.txt' });
  const m = await writeBundle(path.join(tmp, 'txt'), book);
  assert.equal(m.title, 'my book');
  assert.equal(m.format, 'txt');
  assert.match(sectionHtml(path.join(tmp, 'txt'), 0), /World &amp; &lt;friends&gt;/);
});

test('markdown conversion with front matter, slugs and internal links', async () => {
  const md = '---\ntitle: The Test Book\nauthor: A. Writer\n---\n# Chapter One\n\nSee [two](#chapter-two).\n\n# Chapter Two\n\nText.';
  const book = await convertMarkdown(Buffer.from(md), { filename: 't.md' });
  const m = await writeBundle(path.join(tmp, 'md'), book);
  assert.equal(m.title, 'The Test Book');
  assert.equal(m.author, 'A. Writer');
  assert.deepEqual(m.toc.map((t) => [t.title, t.section, t.id]), [['Chapter One', 0, 'chapter-one'], ['Chapter Two', 0, 'chapter-two']]);
  assert.match(sectionHtml(path.join(tmp, 'md'), 0), /<a href="#sec=0&amp;id=chapter-two" data-sec="0" data-id="chapter-two">two<\/a>/);
});

test('epub conversion: metadata, spine, links, images, cover, css, toc', async () => {
  const book = await convertEpub(makeEpub({}), { filename: 'f.epub' });
  const dir = path.join(tmp, 'epub');
  const m = await writeBundle(dir, book);
  assert.equal(m.title, 'Fixture Book');
  assert.equal(m.author, 'Test Author');
  assert.equal(m.language, 'en');
  assert.equal(m.sections.length, 2);
  assert.equal(m.cover, 'cover.png');
  assert.deepEqual(m.toc.map((t) => [t.title, t.section]), [['Chapter One', 0], ['Chapter Two', 1]]);
  const s0 = sectionHtml(dir, 0);
  assert.match(s0, /<a href="#sec=1&amp;id=note1" data-sec="1" data-id="note1">note<\/a>/);
  assert.match(s0, /<img alt="pic" data-src="images\/0_pic.png"/);
  assert.ok(fs.existsSync(path.join(dir, 'images', '0_pic.png')));
  const s1 = sectionHtml(dir, 1);
  assert.match(s1, /<aside id="note1" data-type="footnote">/);
  assert.doesNotMatch(s1, /script|alert|color:red/);
  assert.match(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'), /\.book-content p\.first\{text-indent:0;font-weight:bold\}/);
});

test('epub without nav falls back to ncx, then headings', async () => {
  const b1 = await convertEpub(makeEpub({ withNav: false }), { filename: 'f.epub' });
  assert.deepEqual(b1.toc.map((t) => t.title), ['Chapter One', 'Chapter Two']);
  const b2 = await convertEpub(makeEpub({ withNav: false, withNcx: false }), { filename: 'f.epub' });
  assert.deepEqual(b2.toc.map((t) => t.title), ['Chapter One', 'Chapter Two']);
});

test('mobi conversion: palmdoc text, filepos links, recindex images, exth metadata, cover', async () => {
  const book = await convertMobi(makeMobi({ html: fixtureMobiHtml() }), { filename: 'f.mobi' });
  const dir = path.join(tmp, 'mobi');
  const m = await writeBundle(dir, book);
  assert.equal(m.title, 'Mobi Fixture');
  assert.equal(m.author, 'Mobi Author');
  assert.equal(m.sections.length, 2);
  assert.equal(m.cover, 'cover.png');
  const s0 = sectionHtml(dir, 0);
  const s1 = sectionHtml(dir, 1);
  assert.match(s0, /href="#sec=1&amp;id=filepos\d+"/);
  assert.match(s1, /href="#sec=0&amp;id=filepos0"/);
  assert.match(s1, /<img data-src="images\/\d+\.png"/);
  assert.match(s0, /Ünïcödé text ✓ works/);
  assert.deepEqual(m.toc.map((t) => t.title), ['Chapter One', 'Chapter Two']);
});

test('mobi uncompressed and without trailing entries', async () => {
  const book = await convertMobi(makeMobi({ html: fixtureMobiHtml(), compress: false, trailing: false }), { filename: 'f.mobi' });
  assert.equal(book.sections.length, 2);
  assert.ok(book.sections[0].chars > 5000);
});

test('pdf conversion: pages merged into one section with page markers, paragraphs merged', async () => {
  const buf = makePdf([
    ['Chapter One', '', 'It was a bright cold day in April, and the clocks were', 'striking thirteen. Winston Smith, his chin nuzzled into his', 'breast in an effort to escape the vile wind.', '', 'The hallway smelt of boiled cabbage and it', 'continued on the next page because the sentence'],
    ['runs across the page break like this.', '', 'Second page text.'],
  ]);
  const book = await convertPdf(buf, { filename: 'sample.pdf' });
  const dir = path.join(tmp, 'pdf');
  const m = await writeBundle(dir, book);
  assert.equal(m.format, 'pdf');
  assert.equal(m.pageCount, 2);
  assert.equal(m.sections.length, 1);
  assert.equal(m.sections[0].pageStart, 1);
  assert.equal(m.sections[0].pageEnd, 2);
  const s0 = sectionHtml(dir, 0);
  assert.match(s0, /<span class="pg" id="pg1"><\/span>/);
  assert.match(s0, /<p>It was a bright cold day in April, and the clocks were striking thirteen\. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind\.<\/p>/);
  // The paragraph that runs over the page break is joined, with the page-2 marker inside it.
  assert.match(s0, /<p>The hallway smelt of boiled cabbage and it continued on the next page because the sentence <span class="pg" id="pg2"><\/span>runs across the page break like this\.<\/p>/);
  assert.match(s0, /<p>Second page text\.<\/p>/);
});

test('pdf hyphenation joins', () => {
  const { joinHyphenated } = pdfInternals;
  assert.deepEqual(joinHyphenated('one or more ex-', 'isting systems'), { text: 'one or more existing systems', dropHyphen: true });
  assert.deepEqual(joinHyphenated('a basic four-', 'profession model'), { text: 'a basic four-profession model', dropHyphen: false });
  assert.deepEqual(joinHyphenated('Would a 500-', 'player game'), { text: 'Would a 500-player game', dropHyphen: false });
  assert.deepEqual(joinHyphenated('the term Multi-', 'User Dungeon'), { text: 'the term Multi-User Dungeon', dropHyphen: false });
  assert.deepEqual(joinHyphenated('The co-ordinate-', 'based Mosaic system'), { text: 'The co-ordinate-based Mosaic system', dropHyphen: false });
  assert.equal(joinHyphenated('no hyphen here', 'next'), null);
});

test('pdf page merging: chapter starts split sections, images kept, notes moved to the end and linked', () => {
  const { mergePages } = pdfInternals;
  const p = (text, html = text) => ({ type: 'p', text, html, bullet: false, cont: false });
  const pages = [
    { p: 1, blocks: [p('x'.repeat(3000))] },
    { p: 2, blocks: [{ type: 'img', src: 'images/p2_1.png', text: '' }, p('This was fair<sup>4</sup> royalty and in 1984–', 'This was fair<sup>4</sup> royalty and in 1984–'), { type: 'fn', text: '4 A fact.', html: '<sup>4</sup> A fact.' }] },
    { p: 3, blocks: [p('85, there were articles.')] },
    { p: 4, blocks: [{ type: 'h', level: 1, text: 'Chapter 2', html: 'Chapter 2', size: 20 }, p('z'.repeat(30))] },
  ];
  // A note printed on the page after its marker, and a marker whose number sits on its own line above a long URL.
  pages[2].blocks.push({ type: 'p', text: 'See the site<sup>9</sup>.', html: 'See the site<sup>9</sup>.', bullet: false, cont: false });
  pages[3].blocks.push({ type: 'fn', text: '9 http://example.com/a/very/long/url', html: '<sup>9</sup> http://example.com/a/very/long/url' });
  const out = mergePages(pages, { budget: 100000, startsChapter: () => false });
  assert.deepEqual(out.map((s) => [s.first, s.last]), [[1, 3], [4, 4]]);
  assert.match(out[0].html, /See the site<sup><a id="fnref-4-9-1" href="#fn-4-9">9<\/a><\/sup>\./);
  assert.match(out[1].html, /<p class="footnote" id="fn-4-9"><sup><a href="#fnref-4-9-1">9<\/a><\/sup> http:\/\/example.com/);
  assert.match(out[0].html, /<figure><img src="images\/p2_1.png" alt=""\/><\/figure>/);
  // The dash-ended paragraph is joined across the page break, with the marker inside, and the note is linked and moved to the end.
  assert.match(out[0].html, /<p>This was fair<sup><a id="fnref-2-4-1" href="#fn-2-4">4<\/a><\/sup> royalty and in 1984–<span class="pg" id="pg3"><\/span>85, there were articles\.<\/p>/);
  assert.match(out[0].html, /<section class="endnotes"><p class="footnote" id="fn-2-4"><sup><a href="#fnref-2-4-1">4<\/a><\/sup> A fact\.<\/p><\/section>$/);
  assert.match(out[1].html, /^<span class="pg" id="pg4"><\/span>\n<h1>Chapter 2<\/h1>/);
});

test('format detection and dispatcher', async () => {
  assert.equal(detectFormat('x.epub', makeEpub({})), 'epub');
  assert.equal(detectFormat('x.bin', makeMobi({ html: '<html><body><p>a</p></body></html>' })), 'mobi');
  assert.equal(detectFormat('x.PDF', Buffer.from('%PDF-1.4')), 'pdf');
  assert.equal(detectFormat('notes.markdown', Buffer.from('# hi')), 'md');
  assert.equal(detectFormat('notes.txt', Buffer.from('hi')), 'txt');
  assert.equal(detectFormat('x.exe', Buffer.from('MZ')), null);
  const out = await convert(Buffer.from('# T\n\nbody'), { filename: 'a.md' });
  assert.equal(out.meta.format, 'md');
  await assert.rejects(convert(Buffer.from('x'), { filename: 'a.docx' }), /Unsupported/);
});

test('mobi with DRM is rejected clearly', async () => {
  const buf = makeMobi({ html: '<html><body><p>secret</p></body></html>' });
  // encryption type lives at record 0 offset 12; record 0 starts after the pdb header
  const rec0 = buf.readUInt32BE(78);
  buf.writeUInt16BE(2, rec0 + 12);
  await assert.rejects(convertMobi(buf, { filename: 'drm.mobi' }), /DRM/);
});

test('pdf reflow: running headers, hanging-indent lists, footnotes, hyphens, superscripts', () => {
  const { pageLines, linesToBlocks, lineKey, edgeBand, blocksToHtml } = pdfInternals;
  const item = (str, x, y, size, w, font = 'f1') => ({ str, transform: [size, 0, 0, size, x, y], width: w, height: size, hasEOL: false, fontName: font });
  const vp = { width: 531, height: 657 };
  const items = [
    item('Introduction to Virtual Worlds', 287, 612, 12, 160), item('31', 461, 612, 12, 14),
    item('•', 85, 570, 12, 6), item('It was a victim of its own success. Although OSI was', 103, 570, 12, 269),
    item('expecting tens of thousands of players, they were not', 103, 556, 12, 268),
    item('expecting hundreds of thousands of them. The sheer end.', 103, 541, 12, 271),
    item('All in all, this was a game ahead of its time in Multi-', 85, 512, 12, 300),
    item('User terms, but not so far ahead as to be a total fail-', 85, 498, 12, 300),
    item('ure as such things go in the industry at large.', 85, 484, 12, 200),
    item('The same could not be said of Meridian', 85, 455, 12, 250), item('59', 85, 441, 12, 12), item('.', 97, 441, 12, 3),
    item('respect of any computer game', 85, 412, 12, 157), item('21', 242, 416, 7.9, 7, 'fi'), item('.', 249, 412, 12, 3),
    item('21', 85, 75, 6.5, 6), item('Actually, it used a', 93, 71, 10.1, 76), item('DOOM', 171, 71, 10.1, 30, 'fi'),
    item('-like engine.', 201, 71, 10.1, 60),
    item('22', 85, 55, 6.5, 7), item('http://www.example.com/a/very/long/path/that/wraps.html', 85, 41, 10.1, 325), item('11 anything has a list.', 85, 29, 10.1, 110),
  ];
  const styles = { f1: { fontFamily: 'serif', realName: 'ZillaSlab-Regular' }, fi: { fontFamily: 'serif', realName: 'ZillaSlab-Italic' } };
  const { lines, bodySize } = pageLines(items, vp, styles);
  assert.equal(bodySize, 12);
  const header = lines[0];
  assert.equal(header.text, 'Introduction to Virtual Worlds 31');
  assert.equal(edgeBand(header), 'top');
  assert.equal(lineKey(header), 'introduction to virtual worlds #');
  const blocks = linesToBlocks(lines, { bodySize, isRunning: (l) => lineKey(l) === 'introduction to virtual worlds #' });
  const html = blocksToHtml(blocks);
  assert.doesNotMatch(html, /Introduction to Virtual Worlds 31/);
  assert.match(html, /<p class="list-item">• It was a victim of its own success\. Although OSI was expecting tens of thousands of players, they were not expecting hundreds of thousands of them\. The sheer end\.<\/p>/);
  assert.match(html, /<p>All in all, this was a game ahead of its time in Multi-User terms, but not so far ahead as to be a total failure as such things go in the industry at large\.<\/p>/);
  assert.match(html, /<p>The same could not be said of Meridian 59\.<\/p>/);
  assert.match(html, /<p>respect of any computer game<sup>21<\/sup>\.<\/p>/); // italic font on the marker run is ignored
  const merged = pdfInternals.mergePages([{ p: 41, blocks }], { budget: 100000 });
  assert.match(merged[0].html, /<sup><a id="fnref-41-21-1" href="#fn-41-21">21<\/a><\/sup>\./);
  assert.match(merged[0].html, /<p class="footnote" id="fn-41-21"><sup><a href="#fnref-41-21-1">21<\/a><\/sup> Actually/);
  assert.match(html, /<p class="footnote"><sup>21<\/sup> Actually, it used a <i>DOOM<\/i>-like engine\.<\/p>/);
  assert.match(html, /<p class="footnote"><sup>22<\/sup> http:\/\/www\.example\.com\/a\/very\/long\/path\/that\/wraps\.html 11 anything has a list\.<\/p>/); // a wrapped note line opening with a number is not note 11
});

test('OceanofPDF.com watermarks are removed whatever the markup around them', () => {
  const html = (body) => serialize(normalizeDocument(`<body>${body}</body>`).root.children);
  // The usual stamp at the end of a chapter leaves no empty paragraph behind, even inside a wrapper.
  assert.equal(html('<div class="calibre1"><p>The end.</p><p class="calibre3"><a href="https://oceanofpdf.com"><i>OceanofPDF.com</i></a></p></div>'),
    '<div class="calibre1"><p>The end.</p></div>');
  // Run into a paragraph, written as a URL, or letter-spaced as on some PDF pages.
  assert.equal(html('<p>The end. OceanofPDF.com</p>'), '<p>The end.</p>');
  assert.equal(html('<p>Visit https://www.oceanofpdf.com/ now</p>'), '<p>Visit now</p>');
  assert.equal(html('<p>O c e a n o f P D F . c o m</p><p>Next</p>'), '<p>Next</p>');
  // A link to the site is unlinked but keeps any other text it wraps, and its id.
  assert.equal(html('<p>Read <a id="k" href="http://oceanofpdf.com/authors/x/">more</a>.</p>'), '<p>Read <span id="k">more</span>.</p>');
  assert.equal(html('<p>An ocean of PDF. Complete.</p>'), '<p>An ocean of PDF. Complete.</p>');
});

test('epub stamped with OceanofPDF.com converts exactly like the clean book', async () => {
  // As found in a real OceanofPDF book, at the end of every chapter file.
  const stamp = '<div style="float: none; margin: 10px 0px 10px 0px; text-align: center;"><p><a href="https://oceanofpdf.com"><i>OceanofPDF.com</i></a></p></div>';
  const chapters = [
    { id: 'ch1', file: 'ch1.xhtml', title: 'Chapter One', body: '<h1 class="calibre2">Chapter One</h1><div class="calibre10"> </div>\n' },
    { id: 'ch2', file: 'ch2.xhtml', title: 'Chapter Two', body: '<div class="calibre1"><h1>Chapter Two</h1><p>It ends.</p></div>' },
  ];
  const stamped = [
    { ...chapters[0], body: chapters[0].body + stamp },
    { ...chapters[1], body: chapters[1].body.replace('</div>', `${stamp}</div>`) },
  ];
  const clean = await convertEpub(makeEpub({ chapters }), { filename: 'f.epub' });
  const book = await convertEpub(makeEpub({ chapters: stamped }), { filename: 'f.epub' });
  const html = (b) => b.sections.map((s) => serialize(s.nodes));
  assert.deepEqual(html(book), html(clean));
  assert.deepEqual(book.sections.map((s) => s.chars), clean.sections.map((s) => s.chars));
});

test('pdf: OceanofPDF.com lines are dropped before paragraphs are built', async () => {
  const buf = makePdf([
    ['Chapter One', '', 'The hallway smelt of boiled cabbage and it', 'continued on the next page because the sentence', '', 'OceanofPDF.com'],
    ['runs across the page break like this.'],
    ['O c e a n o f P D F . c o m'],
  ]);
  const book = await convert(buf, { filename: '_OceanofPDF.com_Nineteen_Eighty-Four_-_George_Orwell.pdf' });
  assert.equal(book.meta.title, 'Nineteen Eighty-Four - George Orwell');
  const html = book.sections.map((s) => serialize(s.nodes)).join('\n');
  assert.doesNotMatch(html, /OceanofPDF|O c e a n/i);
  // A stamp between a paragraph and its continuation on the next page does not split it.
  assert.match(html, /<p>The hallway smelt of boiled cabbage and it continued on the next page because the sentence <span class="pg" id="pg2"><\/span>runs across the page break like this\.<\/p>/);
  // A page holding only the stamp gets the page-view hint rather than coming out blank.
  assert.match(html, /<span class="pg" id="pg3"><\/span>\n<p><span class="pdf-empty">\[Page 3 has no extractable text/);
  assert.equal(book.extra.textPages, 2);
});

test('images are told apart by their first bytes, and only file names fill the gaps', () => {
  assert.equal(sniffImage(TINY_PNG), 'png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a\x01\x00', 'latin1')), 'gif');
  assert.equal(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(sniffImage(Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg');
  for (const data of [Buffer.from('plain text'), Buffer.from('RIFF\x10\x00\x00\x00WAVE', 'latin1'), Buffer.from([0xff]), null]) assert.equal(sniffImage(data), null);
  assert.equal(imageExt('images/photo.jpeg', Buffer.from('plain text')), 'jpg');
  assert.equal(imageExt('image/webp', null), 'webp');
  assert.equal(imageExt('', TINY_PNG), 'png');
});

test('pdf: a scanned book is read from its OCR text, by chapters and paragraphs, without running heads or noise', async () => {
  const W = 320;
  const centred = (text, y, size) => ocrLine(text, W / 2 - (text.length * 0.56 + 0.3) * size / 2, y, size);
  // Body type is 9 pt on 13 pt, paragraphs are indented by 10 pt from the margin at 30.
  const body = (y, rows) => rows.flatMap(([x, text, size = 9], i) => ocrLine(text, x, y - i * 13 - (rows[i].gap || 0), size));
  const rows = (...list) => list;
  const pages = [
    centred('THE MILLER', 330, 22),
    [...centred('CHAPTER I', 420, 18), ...centred('THE MILL', 392, 11), ...body(362, rows(
      [40, 'Mary lived by the river where the old mill'],
      [30, 'turned all day long, and her father kept all'],
      [30, 'the sacks of grain in the loft above it.'],
      [40, '" Why did you come? " she asked the strange'],
      [30, 'woman at the gate. The woman only stared at'],
      [30, 'her and said nothing at all.'],
      [40, 'Go away!', 11], // the OCR engine drew its boxes large: still a line of the text
      [40, 'Mary said it again, but the woman did not'],
      [30, 'move from the gate where she stood, and the'],
    )), ...ocrLine('mill went on turning', 30, 150, 9), ...ocrLine('u', 30, 60, 9)], // a picture above, a speck below
    [...ocrLine('2 THE MILLER OF ASHVALE', 30, 470, 10), ...body(440, rows(
      [30, 'all through the night, as it always did.'],
      [40, 'In the morning the woman had gone, and only'],
      [30, 'her footprints were left in the frost by the'],
      [30, 'gate of the mill.'],
    ))],
    [...ocrLine('THE MILL 3', 200, 470, 10), ...body(440, rows(
      [40, 'Mary followed the footprints down to the'],
      [30, 'water, where they ended at the edge of the'],
      [30, 'river.'],
    ))],
    [...ocrLine('4 THE MILLER OF ASHVALE', 30, 470, 10), ...body(440, rows(
      [40, 'She stood there until her father called her'],
      [30, 'back to the mill for supper that evening.'],
    ))],
    [...centred('CHAPTER II', 420, 18), ...centred('THE RIVER', 392, 11), ...body(362, rows(
      [40, 'The river was high that spring, higher than'],
      [30, 'anyone in the valley could remember.'],
    ))],
  ];
  const book = await convertPdf(makeScannedPdf(pages, { width: W, height: 500 }), { filename: 'The Miller.pdf' });
  assert.equal(book.extra.scanned, true);
  assert.equal(book.extra.textPages, 6);
  const html = book.sections.map((s) => serialize(s.nodes)).join('\n');
  // The chapters start sections, headed by their number and title.
  assert.deepEqual(book.sections.map((s) => [s.pageStart, s.pageEnd]), [[1, 1], [2, 5], [6, 6]]);
  assert.match(html, /<h1[^>]*>CHAPTER I<\/h1>\n<h2[^>]*>THE MILL<\/h2>/);
  assert.match(html, /<h1[^>]*>CHAPTER II<\/h1>\n<h2[^>]*>THE RIVER<\/h2>/);
  // Paragraphs by their indent; quote marks with their words; a big line of text is no heading.
  assert.match(html, /<p>Mary lived by the river where the old mill turned all day long, and her father kept all the sacks of grain in the loft above it\.<\/p>/);
  assert.match(html, /<p>"Why did you come\?" she asked the strange woman at the gate\. The woman only stared at her and said nothing at all\.<\/p>/);
  assert.match(html, /<p>Go away!<\/p>/);
  // A sentence carries on past a picture and over the page break.
  assert.match(html, /<p>Mary said it again, but the woman did not move from the gate where she stood, and the mill went on turning <span class="pg" id="pg3"><\/span>all through the night, as it always did\.<\/p>/);
  assert.match(html, /<p>Mary followed the footprints down to the water, where they ended at the edge of the river\.<\/p>/);
  // Running heads that carry the page number go, whatever their title; so does a speck read as a letter.
  assert.doesNotMatch(html, /ASHVALE|THE MILL 3|<p>u<\/p>|<sup>/);
  const m = await writeBundle(path.join(tmp, 'scan'), book);
  assert.equal(m.scanned, true);
});

test('pdf: a page is a scan when images cover it, and its text is OCR when invisible or under the scan', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const vp = { width: 300, height: 480, transform: [1, 0, 0, -1, 0, 480] };
  const ops = (...list) => ({ fnArray: list.map(([name]) => OPS[name]), argsArray: list.map(([, args]) => args ?? null) });
  const image = (id, m) => [['save'], ['transform', m], ['paintImageXObject', [id, 1, 1]], ['restore']];
  const scan = image('scan', [300, 0, 0, 480, 0, 0]);
  const text = [['beginText'], ['showText', [[]]], ['showText', [[]]], ['endText']];
  const facts = (...list) => { const f = readOperators(ops(...list), OPS, vp); return { scan: f.scan, ocr: f.ocr }; };
  assert.deepEqual(facts(...scan, ['setTextRenderingMode', [3]], ...text), { scan: true, ocr: true });
  assert.deepEqual(facts(...text, ...scan), { scan: true, ocr: true }); // drawn first and covered: "text under the image"
  assert.deepEqual(facts(...scan, ...text), { scan: true, ocr: false }); // printed over a picture that fills the page
  assert.deepEqual(facts(...[0, 1, 2, 3].flatMap((i) => image(`strip${i}`, [300, 0, 0, 120, 0, i * 120])), ['setTextRenderingMode', [3]], ...text), { scan: true, ocr: true });
  const figure = readOperators(ops(...text, ...image('fig', [100, 0, 0, 80, 50, 200])), OPS, vp);
  assert.deepEqual([figure.scan, figure.ocr], [false, false]);
  assert.deepEqual(figure.images.map((i) => [i.id, i.x, i.top, i.w, i.h]), [['fig', 50, 200, 100, 80]]);
});

test('pdf: OCR words make lines by their boxes, with quote marks and split running heads put back together', () => {
  // As found in an Internet Archive scan: each word at the bottom of its box and sized to it, spaces as wide as they like.
  const item = (str, x, y, size, w) => ({ str, transform: [size, 0, 0, size, x, y], width: w, height: size, hasEOL: false, fontName: 'f' });
  const vp = { width: 303, height: 490 };
  const items = [
    item('MOTHER!', 121.6, 454.6, 14, 64.7), item(' ', 186.3, 454.6, 14, 30), item("'IT'S", 87.8, 449.8, 9.2, 30), item('341', 240, 449.8, 9.1, 17.3),
    item('woman.', 26.9, 135.1, 9.94, 35.8), item(' ', 62.7, 135.1, 9.94, 94), item('"', 76.0, 140.0, 7.91, 4.7), item('I', 84.7, 135.1, 6.95, 4.2),
    item(' ', 88.9, 135.1, 6.95, 25), item('will', 92.4, 135.0, 7.13, 17.1), item(' ', 109.5, 135.0, 7.13, 26), item('not', 112.4, 135.0, 8.54, 15.4),
    item(' ', 127.8, 135.0, 8.54, 27), item('let', 130.8, 135.0, 6.55, 11.8), item(' ', 142.6, 135.0, 6.55, 25), item('you', 145.5, 132.5, 9.02, 16.2),
    item(' ', 161.7, 132.5, 9.02, 25), item('stay.', 165.2, 132.5, 6.8, 20.4),
    item('', 27.2, 122.0, 7.07, 0), item('to', 27.2, 122.0, 7.07, 8.5), item(' ', 35.7, 122.0, 7.07, 26), item('me."', 40.1, 122.0, 7.79, 18.7),
  ];
  const { lines } = pageLines(items, vp, {}, { ocr: true });
  assert.deepEqual(lines.map((l) => l.text), ["'IT'S MOTHER! 341", 'woman. "I will not let you stay.', 'to me."']);
  assert.ok(lines.every((l) => l.ocr && !/<sup>/.test(l.html)));
  // A line's right edge is where its last word ends, not where a space claims to.
  assert.equal(Math.round(lines[1].right), 186);
});

test('pdf: running heads carrying the page number, misread or not, and what OCR reads into specks', () => {
  const line = (text, y) => ({ text, y, height: 480, x: 30, right: 200, size: 10 });
  const pages = [10, 11, 12, 13].map((p) => ({
    p,
    lines: [line(p % 2 ? `A CHAPTER TITLE ${p - 4}` : `${p - 4} THE BOOK`, 450), line('Some text in the middle of the page, 12 lines of it.', 300), line(p === 13 ? '9' : 'the last line of text', 60)],
  }));
  const numbered = numberedRunningLines(pages);
  assert.deepEqual(pages.map(({ lines }) => numbered.has(lines[0])), [true, true, true, true]);
  assert.equal(numbered.has(pages[3].lines[2]), true); // a page number on its own, a little above the foot of the page
  assert.ok(!numbered.has(pages[0].lines[1]) && !numbered.has(pages[0].lines[2]));
  assert.ok(numberVariants('ib the book').includes('# the book'));
  assert.ok(numberVariants('the book').includes('# the book'));
  assert.ok(numberVariants('a chapter title n').includes('a chapter title #'));
  assert.equal(lineKey({ text: '"I AM COLIN" 1 65' }), lineKey({ text: "'I AM COLIN 161" }));
  for (const noise of ['u', "''u", '7*.', ', . , m']) assert.equal(isOcrNoise(noise), true, noise);
  for (const kept of ['IV', '7', '* * *', 'No.', 'I am.']) assert.equal(isOcrNoise(kept), false, kept);
});

test('credit lines of scanners and download sites go at the start of a book, and only there', async () => {
  const html = (body) => { const { root } = normalizeDocument(`<body>${body}</body>`); removeCreditLines([root]); return serialize(root.children); };
  const credits = ['Formatted by Someone (someone42) Exclusively for Demonoid.com', 'Scanned by Nobody', 'Scanned &amp; proofed by The Group',
    'Scanned and proofed by The Group', 'Scanned, proofed and formatted by X', '- Proofread by Y -', 'Uploaded by Z', 'Converted by Q', 'Downloaded from z-library.org'];
  for (const line of credits) assert.equal(html(`<div class="title"><p class="c">${line}</p></div><p>Text.</p>`), '<p>Text.</p>', line);
  // The people who made the book stay, as do such words in a longer paragraph and a paragraph links may point to.
  const kept = ['Translated by A. Person', 'Edited by B. Person', 'Illustrated by C. Person', `Scanned by the harbour lights, ${'the boats came home one by one, '.repeat(6)}and slept.`];
  for (const line of kept) assert.equal(html(`<p>${line}</p>`), `<p>${line}</p>`, line);
  assert.equal(html('<p id="k">Scanned by Nobody</p>'), '<p id="k">Scanned by Nobody</p>');

  // A text file: gone at the start, kept further in.
  const story = ['Scanned and proofed by Nobody', 'Translated by A. Person', 'CHAPTER ONE', ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} of the story.`), 'Formatted by the narrator, who liked tidy pages.'];
  const txt = await convert(Buffer.from(story.join('\n\n')), { filename: 'story.txt' });
  const txtHtml = txt.sections.map((s) => serialize(s.nodes)).join('\n');
  assert.doesNotMatch(txtHtml, /Scanned and proofed/);
  assert.match(txtHtml, /<p>Translated by A\. Person<\/p>/);
  assert.match(txtHtml, /<p>Formatted by the narrator, who liked tidy pages\.<\/p>/);

  // A PDF keeps its page marker; an EPUB comes out like the book without the line.
  const pdf = await convert(makePdf([['Formatted by Someone (someone42) Exclusively for Demonoid.com', '', 'The Glass Road'], ['Chapter text on the next page.']]), { filename: 'g.pdf' });
  const pdfHtml = pdf.sections.map((s) => serialize(s.nodes)).join('\n');
  assert.doesNotMatch(pdfHtml, /Demonoid|Formatted by/);
  assert.match(pdfHtml, /^<span class="pg" id="pg1"><\/span>\n+<p>The Glass Road<\/p>/);
  assert.match(pdfHtml, /<span class="pg" id="pg2"><\/span>/);
  const chapters = [{ id: 'ch1', file: 'ch1.xhtml', title: 'Chapter One', body: '<h1>Chapter One</h1><p>It begins.</p>' }];
  const credited = [{ ...chapters[0], body: `<div class="calibre1"><p class="calibre3">Scanned &amp; proofed by The Group</p></div>${chapters[0].body}` }];
  const clean = await convertEpub(makeEpub({ chapters }));
  const book = await convertEpub(makeEpub({ chapters: credited }));
  assert.deepEqual(book.sections.map((s) => serialize(s.nodes)), clean.sections.map((s) => serialize(s.nodes)));
});

test('a paragraph holding only a mark such as "* * *" is a scene break in every format, while lists stay lists', async () => {
  const hr = '<hr class="scene-break" />';
  const html = (body) => serialize(normalizeDocument(`<body>${body}</body>`).root.children);
  for (const mark of ['*', '* * *', '***', '#', '# # #', '~', '~ ~ ~', '⁂', '• • •', '*&nbsp;&nbsp;*&nbsp;&nbsp;*']) {
    assert.equal(html(`<p>One.</p><p class="center" style="text-align:center">${mark}</p><p>Two.</p>`), `<p>One.</p>${hr}<p>Two.</p>`, mark);
  }
  assert.equal(html('<div class="break"><p id="b1"><span>* * *</span></p></div>'), '<div class="break"><hr class="scene-break" id="b1" /></div>');
  assert.equal(html('<h3>* * *</h3>'), hr);
  // A bullet alone, a note marker, a link, a mark with words and a list item stay.
  for (const kept of ['<p>•</p>', '<p>-</p>', '<p><sup>*</sup></p>', '<p><a href="http://x.y/">*</a></p>', '<p>* A note.</p>', '<p>***Boom***</p>', '<ul><li>*</li></ul>']) {
    assert.doesNotMatch(html(kept), /scene-break/, kept);
  }
  const epub = await convertEpub(makeEpub({ chapters: [{ id: 'c', file: 'c.xhtml', title: 'C', body: '<p>One.</p><p class="calibre5">* * *</p><p>Two.</p>' }] }));
  assert.match(serialize(epub.sections[0].nodes), /<p>One\.<\/p><hr class="scene-break" \/><p>Two\.<\/p>/);

  // Markdown: a break of asterisks is a scene break, one of dashes or underscores a plain rule.
  const md = await convertMarkdown(Buffer.from('One.\n\n* * *\n\nTwo.\n\n***\n\nThree.\n\n---\n\nFour.\n\n___\n\nFive.'));
  const mdHtml = serialize(md.sections[0].nodes);
  assert.equal((mdHtml.match(/<hr class="scene-break" \/>/g) || []).length, 2, mdHtml);
  assert.equal((mdHtml.match(/<hr \/>/g) || []).length, 2, mdHtml);

  // Text: a centred mark is not preformatted text, and a mark stands alone between wrapped lines.
  const text = textToHtml('The first scene ends.\n\n            * * *\n\nThe second scene.\n\n#\n\nThe third.\n\n* one item\n* another item');
  assert.equal(text, '<p>The first scene ends.</p>\n<hr class="scene-break"/>\n<p>The second scene.</p>\n<hr class="scene-break"/>\n<p>The third.</p>\n<p>* one item</p>\n<p>* another item</p>');
  const wrapped = textToHtml(`${'A line of hard-wrapped text that runs on to the next line and\n'.repeat(12)}*\n${'the story carries on after the break, wrapped just the same way\n'.repeat(12)}`);
  assert.match(wrapped, / and<\/p>\n<hr class="scene-break"\/>\n<p>the story carries on/);
  const txt = await convert(Buffer.from('One.\n\n~ ~ ~\n\nTwo.'), { filename: 't.txt' });
  assert.equal(serialize(txt.sections[0].nodes), `<p>One.</p>\n${hr}\n<p>Two.</p>`);

  // PDF: a lone "*" is a break, set apart or not, while "* item" and "- item" lines are list items.
  const pdf = await convert(makePdf([
    ['The first scene ends here.', '', '*', '', 'The second scene starts here.', '*', 'the third scene follows close.', '', '* first item', '* second item', '- item one', '- item two'],
    ['* * *', 'Another page.'],
  ]), { filename: 'scenes.pdf' });
  assert.equal(pdf.sections.map((s) => serialize(s.nodes)).join('\n'), [
    '<span class="pg" id="pg1"></span>', '<p>The first scene ends here.</p>', hr, '<p>The second scene starts here.</p>', hr, '<p>the third scene follows close.</p>',
    '<p class="list-item">* first item</p>', '<p class="list-item">* second item</p>', '<p class="list-item">- item one</p>', '<p class="list-item">- item two</p>',
    '<span class="pg" id="pg2"></span>', hr, '<p>Another page.</p>',
  ].join('\n'));
});
