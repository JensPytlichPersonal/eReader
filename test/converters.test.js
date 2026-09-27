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
import { normalizeDocument, chunkNodes, serialize } from '../server/converters/html.js';
import { textToHtml, convertText } from '../server/converters/text.js';
import { convertMarkdown } from '../server/converters/markdown.js';
import { convertEpub } from '../server/converters/epub.js';
import { convertMobi } from '../server/converters/mobi.js';
import { convertPdf, pageItemsToBlocks, pageLines, linesToBlocks, lineKey, edgeBand, blocksToHtml } from '../server/converters/pdf.js';
const pdfInternals = { pageLines, linesToBlocks, lineKey, edgeBand, blocksToHtml };
import { convert, detectFormat } from '../server/converters/index.js';
import { writeBundle } from '../server/converters/bundle.js';
import { makePdf } from './helpers/make-pdf.mjs';

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
  const book = await convertText(Buffer.from('Hello\n\nWorld & <friends>'), { filename: 'my_book.txt' });
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

test('pdf conversion: one section per page, paragraphs merged, outline toc', async () => {
  const buf = makePdf([
    ['Chapter One', '', 'It was a bright cold day in April, and the clocks were', 'striking thirteen. Winston Smith, his chin nuzzled into his', 'breast in an effort to escape the vile wind.', '', 'The hallway smelt of boiled cabbage.'],
    ['Second page text.'],
  ]);
  const book = await convertPdf(buf, { filename: 'sample.pdf' });
  const dir = path.join(tmp, 'pdf');
  const m = await writeBundle(dir, book);
  assert.equal(m.format, 'pdf');
  assert.equal(m.pageCount, 2);
  assert.equal(m.sections.length, 2);
  assert.equal(m.sections[1].page, 2);
  const s0 = sectionHtml(dir, 0);
  assert.match(s0, /<p>It was a bright cold day in April, and the clocks were striking thirteen\. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind\.<\/p>/);
  assert.match(s0, /<p>The hallway smelt of boiled cabbage\.<\/p>/);
});

test('pdf block heuristics: headings by size, indentation starts paragraphs', () => {
  const item = (str, x, y, size, w) => ({ str, transform: [size, 0, 0, size, x, y], width: w, height: size, hasEOL: false });
  const items = [
    item('Big Title', 72, 700, 20, 100),
    item('First line of a paragraph that is long enough to count', 72, 670, 10, 300),
    item('second line continues here with more words in it', 72, 658, 10, 300),
    item('Indented start of new paragraph with more words', 90, 646, 10, 280),
    item('42', 300, 30, 10, 10),
  ];
  const blocks = pageItemsToBlocks(items, { width: 612, height: 792 });
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'p']);
  assert.equal(blocks[1].text, 'First line of a paragraph that is long enough to count second line continues here with more words in it');
  assert.equal(blocks[2].text, 'Indented start of new paragraph with more words');
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
    item('respect of any computer game', 85, 412, 12, 157), item('21', 242, 416, 7.9, 7), item('.', 249, 412, 12, 3),
    item('21', 85, 75, 6.5, 6), item('Actually, it used a', 93, 71, 10.1, 76), item('DOOM', 171, 71, 10.1, 30, 'fi'),
    item('-like engine.', 201, 71, 10.1, 60),
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
  assert.match(html, /<p>respect of any computer game<sup>21<\/sup>\.<\/p>/);
  assert.match(html, /<p class="footnote"><sup>21<\/sup> Actually, it used a <i>DOOM<\/i>-like engine\.<\/p>/);
});
