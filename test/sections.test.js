import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomUtils } from 'htmlparser2';
import { makeEpub } from './helpers/make-epub.mjs';
import { normalizeDocument, chunkNodes, serialize, textLength } from '../server/converters/html.js';
import { mergePages } from '../server/converters/pdf.js';
import { convertEpub } from '../server/converters/epub.js';
import { assembleSections, SECTION_BUDGET } from '../server/converters/bundle.js';

const root = (body) => normalizeDocument(`<body>${body}</body>`).root;
// A paragraph of exactly `n` characters of text.
const para = (n, attrs = '') => `<p${attrs}>${'x'.repeat(n - 1)}.</p>`;
const paras = (count, n = 1000) => Array.from({ length: count }, () => para(n)).join('');
const tags = (chunk) => chunk.filter((n) => n.type === 'tag');
const firstTag = (chunk) => tags(chunk)[0];
const lastTag = (chunk) => tags(chunk).at(-1);

test('the section budget is 150,000 characters', () => {
  assert.equal(SECTION_BUDGET, 150000);
});

test('chunker: a chapter that fits stays whole, wrappers and all', () => {
  const chunks = chunkNodes(root(`<div id="all">${paras(9)}</div><p>End.</p>`), 10000);
  assert.equal(chunks.length, 1);
  assert.match(serialize(chunks[0]), /^<div id="all"><p>/);
  assert.equal(textLength(chunks[0]), 9004);
});

test('chunker: a chapter of 2.2 budgets is cut into three near-equal parts, not two full ones and a scrap', () => {
  const chunks = chunkNodes(root(paras(22)), 10000);
  assert.deepEqual(chunks.map(textLength), [7000, 8000, 7000]);
  assert.equal(chunks.flat().filter((n) => n.name === 'p').length, 22);
});

test('chunker: a cut goes before a nearby heading, else after a nearby scene break, else nearest the middle', () => {
  // 30 paragraphs of 1,000 with a budget of 20,000: two parts, ideally cut at 15,000, near meaning within 3,750.
  const body = ({ heading, rule }) => Array.from({ length: 30 }, (_, i) => (i === heading ? '<h2>Part</h2>' : '')
    + para(1000) + (i === rule ? '<p>* * *</p>' : '')).join('');
  let chunks = chunkNodes(root(body({ heading: 12, rule: 16 })), 20000);
  assert.equal(chunks.length, 2);
  assert.equal(firstTag(chunks[1]).name, 'h2');
  assert.equal(textLength(chunks[0]), 12000);

  chunks = chunkNodes(root(body({ rule: 16 })), 20000);
  assert.equal(lastTag(chunks[0]).name, 'hr');
  assert.equal(lastTag(chunks[0]).attribs.class, 'scene-break');
  assert.equal(textLength(chunks[0]), 17000);

  // A heading and a break too far from the middle are passed over.
  chunks = chunkNodes(root(body({ heading: 4, rule: 25 })), 20000);
  assert.equal(textLength(chunks[0]), 15004);
  assert.equal(firstTag(chunks[1]).name, 'p');
});

test('chunker: never cuts right after a heading, even where that is the only place that keeps to the budget', () => {
  // The only place that leaves two parts of 10,000 is right after the headings, so the cut goes before them.
  const chunks = chunkNodes(root(`${para(996)}${paras(9)}<h1>Pa</h1><h2>rt</h2>${paras(10)}`), 10000);
  assert.equal(chunks.length, 2);
  assert.deepEqual(tags(chunks[1]).slice(0, 2).map((n) => n.name), ['h1', 'h2']);
  assert.equal(lastTag(chunks[0]).name, 'p');
  // Nor after a wrapper that ends with one.
  const wrapped = chunkNodes(root(`${para(996)}${paras(9)}<div class="head"><h2>Head</h2></div>${paras(10)}`), 10000);
  assert.equal(firstTag(wrapped[1]).name, 'div');
});

test('chunker: a wrapper larger than the budget is unwrapped and cut inside, its id kept as an anchor with what follows it', () => {
  const chunks = chunkNodes(root(`<div id="all" style="text-align:center">${paras(30)}</div>`), 10000);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(textLength), [10000, 10000, 10000]);
  assert.match(serialize(chunks[0]), /^<span id="all" class="anchor"><\/span><p style="text-align:center">/);

  // The second wrapper starts with a heading: the first cut goes before it, and its anchor goes with it.
  const three = chunkNodes(root(`<div id="one">${paras(8)}</div><section id="two"><h2>Two</h2>${paras(12)}</section>${paras(10)}`), 12000);
  assert.equal(three.length, 3);
  assert.deepEqual(serialize(three[0]), `<div id="one">${paras(8)}</div>`);
  assert.match(serialize(three[1]), /^<span id="two" class="anchor"><\/span><h2>Two<\/h2>/);
});

const page = (text) => ({ type: 'p', text, html: text, bullet: false, cont: false });
// Pages of 1,000 characters: one that ends its paragraph, one that runs it on to the next page, and one that
// carries on the paragraph from the page before (and ends it, or runs it on in turn).
const whole = () => page(`${'x'.repeat(999)}.`);
const runsOn = () => page(`${'x'.repeat(999)}y`);
const carried = (end = '.') => page(`and ${'z'.repeat(995)}${end}`);

test('pdf: a long run of pages without chapter pages is cut into near-equal sections', () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({ p: i + 1, blocks: [whole()] }));
  const out = mergePages(pages, { budget: 4000 });
  assert.deepEqual(out.map((s) => [s.first, s.last]), [[1, 3], [4, 7], [8, 10]]);
  // Chapter pages still start sections, and a short run between them is not cut.
  const chapters = mergePages(pages.map((pg) => ({ ...pg, blocks: [whole()] })), { budget: 4000, startsChapter: (p) => p === 3 || p === 6 });
  assert.deepEqual(chapters.map((s) => [s.first, s.last]), [[1, 2], [3, 5], [6, 7], [8, 10]]);
});

test('pdf: a run is not cut where a paragraph runs over the page when another page is near', () => {
  // The middle is the start of page 6, which carries on the paragraph from page 5.
  const pages = Array.from({ length: 10 }, (_, i) => ({ p: i + 1, blocks: [i === 4 ? runsOn() : i === 5 ? carried() : whole()] }));
  let out = mergePages(pages, { budget: 6000 });
  assert.deepEqual(out.map((s) => [s.first, s.last]), [[1, 4], [5, 10]]);
  assert.match(out[1].html, /<p>x+y <span class="pg" id="pg6"><\/span>and z+\.<\/p>/);

  // A page that starts with a heading or a scene break is better still.
  const heading = { type: 'h', level: 2, text: 'Part', html: 'Part', size: 14 };
  out = mergePages(pages.map((pg) => (pg.p === 7 ? { ...pg, blocks: [heading, whole()] } : pg)), { budget: 6000 });
  assert.deepEqual(out.map((s) => [s.first, s.last]), [[1, 6], [7, 10]]);
  out = mergePages(pages.map((pg) => (pg.p === 7 ? { ...pg, blocks: [{ type: 'break', text: '' }, whole()] } : pg)), { budget: 6000 });
  assert.deepEqual(out.map((s) => [s.first, s.last]), [[1, 6], [7, 10]]);

  // When every page carries on a paragraph, one is cut as near the middle as can be.
  const running = Array.from({ length: 10 }, (_, i) => ({ p: i + 1, blocks: [i ? carried(i < 9 ? 'y' : '.') : runsOn()] }));
  out = mergePages(running, { budget: 6000 });
  assert.deepEqual(out.map((s) => [s.first, s.last]), [[1, 5], [6, 10]]);
});

test('pdf: a run is not cut after a heading at the foot of a page', () => {
  const heading = { type: 'h', level: 2, text: 'Part', html: 'Part', size: 14 };
  const pages = Array.from({ length: 10 }, (_, i) => ({ p: i + 1, blocks: i === 4 ? [whole(), heading] : [whole()] }));
  const out = mergePages(pages, { budget: 7000 });
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => s.last !== 5), out.map((s) => `${s.first}-${s.last}`).join(' '));
});

test('pdf: a paragraph that runs over three pages keeps all of its text', () => {
  const pages = [
    { p: 1, blocks: [page('One begins and runs on')] },
    { p: 2, blocks: [page('across the whole of page two and on')] },
    { p: 3, blocks: [page('to its end on page three.'), whole()] },
  ];
  const [only] = mergePages(pages, { budget: 100000 });
  assert.match(only.html, /<p>One begins and runs on <span class="pg" id="pg2"><\/span>across the whole of page two and on <span class="pg" id="pg3"><\/span>to its end on page three\.<\/p>/);
});

// About 500 characters of prose, ending a sentence.
const prose = (n) => `<p>${Array.from({ length: n }, () => 'She walked on along the river road, past the mill and the bridge, and did not look back.').join(' ')}</p>`;
const chapterOne = { id: 'c1', file: 'c1.xhtml', title: 'Chapter One', body: `<h1>Chapter One</h1>${prose(6).repeat(5)}` };
const chapterTwo = { id: 'c2', file: 'c2.xhtml', title: 'Chapter Two', body: `<h1>Chapter Two</h1>${prose(2)}<p>See <a href="c1_split.xhtml#later">later</a>.</p>` };
const split = (body, extra = {}) => ({ id: 'c1s', file: 'c1_split.xhtml', title: 'Chapter One', inToc: false, body, ...extra });
const splitBody = `<p>The rain came down as she reached the gate.</p>${prose(3)}<p id="later">Later that night the mill was quiet.</p>`;
const sectionCount = async (chapters) => (await convertEpub(makeEpub({ chapters }))).sections.length;

test('epub: a chapter split over two files is one section, and links into the second file still find their place', async () => {
  const book = await convertEpub(makeEpub({ chapters: [chapterOne, split(splitBody), chapterTwo] }));
  assert.equal(book.sections.length, 2);
  assert.deepEqual(book.toc.map((t) => [t.title, t.section]), [['Chapter One', 0], ['Chapter Two', 1]]);
  const html = serialize(book.sections[0].nodes);
  assert.match(html, /walked on along the river road[^]*<span id="rr-join1" class="anchor"><\/span><p>The rain came down/);
  assert.match(html, /<p id="later">Later that night/);
  assert.match(serialize(book.sections[1].nodes), /<a href="#sec=0&amp;id=later" data-sec="0" data-id="later">later<\/a>/);

  // A scene break before the text is passed over.
  assert.equal(await sectionCount([chapterOne, split(`<p>* * *</p>${splitBody}`), chapterTwo]), 2);
});

test('epub: a file that is a destination, has its own title or does not begin with prose stays its own section', async () => {
  // In the contents.
  assert.equal(await sectionCount([chapterOne, split(splitBody, { inToc: true }), chapterTwo]), 3);
  // Linked to as a whole, and the link goes to it.
  const linked = { ...chapterTwo, body: `<h1>Chapter Two</h1><p>Back to <a href="c1_split.xhtml">the gate</a>.</p>` };
  const book = await convertEpub(makeEpub({ chapters: [chapterOne, split(splitBody), linked] }));
  assert.equal(book.sections.length, 3);
  assert.match(serialize(book.sections[2].nodes), /<a href="#sec=1" data-sec="1">the gate<\/a>/);
  // A title of its own.
  assert.equal(await sectionCount([chapterOne, split(splitBody, { title: 'Interlude' }), chapterTwo]), 3);
  // A heading, a picture, or a line that reads as a title first.
  for (const start of ['<h2>Interlude</h2>', '<p><img src="images/pic.png" alt=""/></p>', '<p class="chapter">THE MERCHANT</p>', '<p>Chapter Five</p>']) {
    assert.equal(await sectionCount([chapterOne, split(start + splitBody), chapterTwo]), 3, start);
  }
});

test('epub: front matter after a short title page keeps its own pages', async () => {
  const front = [
    { id: 't', file: 'title.xhtml', title: 'The Book', inToc: false, body: '<p class="title">The Book</p><p class="author">A. Writer</p>' },
    { id: 'cp', file: 'copyright.xhtml', title: 'The Book', inToc: false, body: '<p>Copyright 2024 by A. Writer. All rights reserved.</p><p>First published in 2024.</p>' },
    { id: 'd', file: 'dedication.xhtml', title: 'The Book', inToc: false, body: '<p>For my mother, who read to me.</p>' },
    { ...chapterOne, title: 'The Book' },
  ];
  assert.equal(await sectionCount(front), 4);
});

test('a chapter that carries on the one before is chunked with it, and links to it go where it begins', () => {
  const a = root(`<h1 id="top">One</h1>${paras(3)}<p id="x">Mine.</p>`);
  const b = root(`<p id="x">Its own x.</p><p id="y">Why.</p>`);
  const links = '<a href="b.xhtml">whole</a> <a href="b.xhtml#x">x</a> <a href="b.xhtml#y">y</a> <a href="a.xhtml#x">a</a>';
  const c = normalizeDocument(`<body><h1>Two</h1><p>${links}</p></body>`, { resolveLink: (href) => href }).root;
  const { sections, toc } = assembleSections([{ root: a, key: 'a.xhtml' }, { root: b, key: 'b.xhtml', continues: true }, { root: c, key: 'c.xhtml' }],
    { toc: [{ title: 'One', key: 'a.xhtml' }, { title: 'Joined', key: 'b.xhtml' }, { title: 'Two', key: 'c.xhtml' }] });
  assert.equal(sections.length, 2);
  // The joined chapter's x is renamed, as the one before already has an x.
  assert.match(serialize(sections[0].nodes), /<p id="x">Mine\.<\/p><span id="rr-join1" class="anchor"><\/span><p id="x-2">Its own x\.<\/p><p id="y">Why\.<\/p>$/);
  const hrefs = DomUtils.findAll((e) => e.name === 'a', sections[1].nodes).map((e) => e.attribs.href);
  assert.deepEqual(hrefs, ['#sec=0&id=rr-join1', '#sec=0&id=x-2', '#sec=0&id=y', '#sec=0&id=x']);
  assert.deepEqual(toc.map((t) => [t.title, t.section, t.id]), [['One', 0, null], ['Joined', 0, 'rr-join1'], ['Two', 1, null]]);
});
