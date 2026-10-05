import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomUtils } from 'htmlparser2';
import { makeEpub } from './helpers/make-epub.mjs';
import { normalizeDocument, chunkNodes, serialize, textLength } from '../server/converters/html.js';
import { mergePages } from '../server/converters/pdf.js';
import { convertEpub } from '../server/converters/epub.js';
import { assembleSections, SECTION_BUDGET, isChapterTitle } from '../server/converters/bundle.js';
import { convert } from '../server/converters/index.js';
import { makePdf } from './helpers/make-pdf.mjs';

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

const byId = (r, id) => DomUtils.findOne((e) => e.attribs?.id === id, r.children, true);
const names = (chunk) => tags(chunk).map((n) => n.name).join(' ');

test('chunker: each chapter the contents points to begins a chunk, with the headings just before it', () => {
  const r = root(`<h2 id="c1">One</h2>${paras(3)}<h1>Part Two</h1><h2 id="c2">Two</h2>${paras(2)}<h2 id="c3">Three</h2>${paras(2)}`);
  const chunks = chunkNodes(r, 150000, new Set(['c1', 'c2', 'c3'].map((id) => byId(r, id))));
  assert.deepEqual(chunks.map(names), ['h2 p p p', 'h1 h2 p p', 'h2 p p']);

  // An entry that points at an empty anchor at the end of the paragraph before: the chapter begins at the text after
  // it, and the anchor goes there too, so the contents leads to the chapter.
  const quirk = root(`${paras(2)}<p>The end of one.<a id="c2"></a></p><h2>Two</h2>${paras(2)}`);
  const two = chunkNodes(quirk, 150000, new Set([byId(quirk, 'c2')]));
  assert.deepEqual(two.map(names), ['p p p', 'a h2 p p']);
  assert.match(serialize(two[0]), /<p>The end of one\.<\/p>$/);
  assert.match(serialize(two[1]), /^<a id="c2"><\/a><h2>Two<\/h2>/);

  // One that starts inside a wrapper, after other text: the wrapper is unwrapped there, its id kept as an anchor.
  const wrapped = root(`<div id="part">${paras(2)}<h2 id="c2">Two</h2>${paras(2)}</div>`);
  const three = chunkNodes(wrapped, 150000, new Set([byId(wrapped, 'c2')]));
  assert.deepEqual(three.map(names), ['span p p', 'h2 p p']);
  assert.match(serialize(three[0]), /^<span id="part" class="anchor"><\/span>/);

  // An anchor alone in a paragraph before a chapter's heading goes with the chapter, and leaves no empty chunk.
  const lone = root(`<p><a id="c1"></a></p><h2>One</h2>${paras(2)}<p><a id="c2"></a></p><h2>Two</h2>${paras(2)}`);
  const alone = chunkNodes(lone, 150000, new Set([byId(lone, 'c1'), byId(lone, 'c2')]));
  assert.deepEqual(alone.map(names), ['p a h2 p p', 'p a h2 p p']);

  // A chapter longer than the budget is still cut into near-equal parts; one at the very start makes no cut.
  const long = root(`<h2 id="c1">One</h2>${paras(22)}<h2 id="c2">Two</h2>${paras(3)}`);
  const four = chunkNodes(long, 10000, new Set([byId(long, 'c1'), byId(long, 'c2')]));
  assert.deepEqual(four.map(textLength), [7003, 8000, 7000, 3003]);
});

test('the chapters in the contents each begin a section, but not the sections of a chapter', () => {
  // Part One holds more than the budget, so its chapters begin sections. Part Two does not, nor does chapter
  // Three, so neither Three nor its section is cut from the part.
  const book = root(`<h1 id="p1">Part One</h1><h2 id="c1">One</h2>${paras(6)}<h2 id="c2">Two</h2>${paras(6)}`
    + `<h1 id="p2">Part Two</h1><h2 id="c3">Three</h2>${paras(3)}<h3 id="s1">A section</h3>${paras(3)}`);
  const toc = [
    { title: 'Part One', key: 'b#p1', children: [{ title: 'One', key: 'b#c1' }, { title: 'Two', key: 'b#c2' }] },
    { title: 'Part Two', key: 'b#p2', children: [{ title: 'Three', key: 'b#c3', children: [{ title: 'A section', key: 'b#s1' }] }] },
  ];
  const { sections, toc: out } = assembleSections([{ root: book, key: 'b' }], { toc, budget: 10000 });
  assert.deepEqual(sections.map((s) => names(s.nodes)), [`h1 h2 ${'p '.repeat(6).trim()}`, `h2 ${'p '.repeat(6).trim()}`, `h1 h2 p p p h3 p p p`]);
  const flat = (list) => list.flatMap((t) => [[t.title, t.section], ...flat(t.children || [])]);
  assert.deepEqual(flat(out), [['Part One', 0], ['One', 0], ['Two', 1], ['Part Two', 2], ['Three', 2], ['A section', 2]]);
  assert.deepEqual(sections.map((s) => s.title), ['Part One', 'Two', 'Part Two']);

  // A part's name in the contents without a place of its own holds what is under it.
  const named = [{ title: 'Part One', key: null, children: [{ title: 'One', key: 'c#c1' }, { title: 'Two', key: 'c#c2' }] }];
  const small = root(`<h2 id="c1">One</h2>${paras(2)}<h2 id="c2">Two</h2>${paras(2)}`);
  assert.equal(assembleSections([{ root: small, key: 'c' }], { toc: named, budget: 10000 }).sections.length, 2);
});

test('epub: chapters that share a file each begin a section, where the contents points', async () => {
  const body = ['One', 'Two', 'Three'].map((t, i) => `<h2 id="ch${i + 1}">Chapter ${t}</h2>${prose(4)}`).join('');
  const book = await convertEpub(makeEpub({
    chapters: [{ id: 'b', file: 'book.xhtml', title: 'The Book', body }],
    toc: ['One', 'Two', 'Three'].map((t, i) => ({ title: `Chapter ${t}`, href: `book.xhtml#ch${i + 1}` })),
  }));
  assert.equal(book.sections.length, 3);
  assert.deepEqual(book.toc.map((t) => [t.title, t.section]), [['Chapter One', 0], ['Chapter Two', 1], ['Chapter Three', 2]]);
  assert.deepEqual(book.sections.map((s) => s.title), ['Chapter One', 'Chapter Two', 'Chapter Three']);
});

test('a book without contents begins a section at each chapter heading', async () => {
  const text = ['CHAPTER I', 'CHAPTER II', 'CHAPTER III'].map((h) => `${h}\n\n${'It was a bright cold day in April, and the clocks were striking thirteen.\n\n'.repeat(5)}`).join('');
  const book = await convert(Buffer.from(text), { filename: 'b.txt' });
  assert.deepEqual(book.sections.map((s) => tags(s.nodes)[0]?.name), ['h2', 'h2', 'h2']);
  assert.deepEqual(book.toc.map((t) => [t.title, t.section]), [['CHAPTER I', 0], ['CHAPTER II', 1], ['CHAPTER III', 2]]);
});

test('a heading that names a chapter begins a section where the contents does not point at it', async () => {
  for (const t of ['Chapter Eleven', 'CHAPTER XI', 'Chapter 11: The Road', 'Chapter Twenty-One', 'Part Two', 'Book III', 'Kapitel 11',
    'Kapitel enogtyve', 'Del to', 'Prologue', 'Epilog', 'XI', '11', '11.']) assert.ok(isChapterTitle(t), t);
  // A number after the title is a page number, on a contents page or in a scan's running head.
  for (const t of ['Part of the problem', 'Part Time Work', 'Chapter and verse', 'CIVIL', 'The Road to Sendar', '1.1', '11 The Road', 'Prologues and Plots',
    'Chapter One 1', 'CHAPTER ELEVEN 123']) {
    assert.ok(!isChapterTitle(t), t);
  }

  // The contents names only the file: its chapters are found by their headings. A descriptive heading is not one.
  const text = prose(6).repeat(3); // about 1,600 characters
  const body = `<h2>Prologue</h2>${text}<h2>Chapter One</h2>${text}<h3>The Road to Sendar</h3>${text}<h2>Chapter Two</h2>${text}`;
  const book = await convertEpub(makeEpub({ chapters: [{ id: 'b', file: 'book.xhtml', title: 'The Book', body }] }));
  // Each is named by its title, not by the file's entry in the contents.
  assert.deepEqual(book.sections.map((s) => s.title), ['Prologue', 'Chapter One', 'Chapter Two']);
  assert.equal(names(book.sections[1].nodes), 'h2 p p p h3 p p p');

  // A contents page lists them close together, or as links: those don't begin sections, and the prologue after
  // it does.
  const listed = '<h1>Contents</h1><h3>Chapter One</h3><h3>Chapter Two</h3><p><a href="#c1">Chapter One</a></p>';
  const withList = await convertEpub(makeEpub({ chapters: [{ id: 'b', file: 'book.xhtml', title: 'The Book', body: listed + body }] }));
  assert.deepEqual(withList.sections.map((s) => names(s.nodes).split(' ')[0]), ['h1', 'h2', 'h2', 'h2']);
  assert.equal(names(withList.sections[0].nodes), 'h1 h3 h3 p');
});

test('an older book marks chapters with <a name>, and the contents and links find them', async () => {
  const { root: r } = normalizeDocument('<body><p><a name="ch2"></a>Two</p></body>');
  assert.equal(byId(r, 'ch2')?.name, 'a');
  const body = ['One', 'Two', 'Three'].map((t, i) => `<p class="ct"><a name="ch${i + 1}"></a>${t}</p>${prose(4)}`).join('') + '<p>Back to <a href="#ch2">two</a>.</p>';
  const book = await convertEpub(makeEpub({
    chapters: [{ id: 'b', file: 'book.xhtml', title: 'The Book', body }],
    toc: ['One', 'Two', 'Three'].map((t, i) => ({ title: t, href: `book.xhtml#ch${i + 1}` })),
  }));
  assert.deepEqual(book.toc.map((t) => [t.title, t.section, t.id]), [['One', 0, 'ch1'], ['Two', 1, 'ch2'], ['Three', 2, 'ch3']]);
  assert.match(serialize(book.sections[2].nodes), /<a href="#sec=1&amp;id=ch2" data-sec="1" data-id="ch2">two<\/a>/);
});

test('a line of its own that names a chapter, or of the class chapter, is a title; a page number or running head is not', async () => {
  const text = prose(6).repeat(3); // about 1,600 characters
  const lines = await convertEpub(makeEpub({ chapters: [{ id: 'b', file: 'book.xhtml', title: 'The Book',
    body: `<p>Prologue</p>${text}<p class="chapter">The Road to Sendar</p>${text}<div>CHAPTER TWO</div>${text}<p>123</p>${text}` }] }));
  assert.deepEqual(lines.sections.map((s) => serialize(s.nodes).slice(0, 22)), ['<p>Prologue</p><p>She ', '<p class="chapter">The', '<div>CHAPTER TWO</div>']);

  // A scan's running head repeats the chapter's title on every page: it begins the chapter once.
  const page = `<p>Chapter Eleven</p>${text}`;
  const running = await convertEpub(makeEpub({ chapters: [{ id: 'b', file: 'book.xhtml', title: 'The Book',
    body: `${text}${page.repeat(4)}<p>Chapter Twelve</p>${text}${'<p>Chapter Twelve</p>'.concat(text).repeat(2)}` }] }));
  assert.equal(running.sections.length, 3);
});

test('pdf: a chapter title begins a section, at the top of a page or partway down, and its notes go with it', () => {
  const title = (text, level = 2) => ({ type: 'h', level, text, html: text, size: 14 });
  const long = () => page(`${'x'.repeat(1199)}.`);
  const marked = (text, n) => ({ type: 'p', text: `${text}${n}`, html: `${text}<sup>${n}</sup>`, bullet: false, cont: false });
  const note = (n, text) => ({ type: 'fn', text: `${n} ${text}`, html: `<sup>${n}</sup> ${text}` });
  const pages = [
    { p: 1, blocks: [title('Chapter Ten'), long(), long()] },
    // Chapter Ten ends partway down page 2, where Chapter Eleven begins, as in a PDF made from a document.
    { p: 2, blocks: [marked('The door closed behind him.', 1), title('Chapter Eleven'), marked('They were nine days on the road.', 2), long(), note(1, 'One.'), note(2, 'Two.')] },
    { p: 3, blocks: [long()] },
    // Chapter Twelve begins at the top of page 4, after a part's title.
    { p: 4, blocks: [title('Part Two', 1), title('Chapter Twelve'), long()] },
  ];
  const out = mergePages(pages, { budget: 150000 });
  assert.deepEqual(out.map((s) => [s.first, s.last, s.title]), [[1, 2, 'Chapter Ten'], [2, 3, 'Chapter Eleven'], [4, 4, 'Chapter Twelve']]);
  assert.match(out[0].html, /The door closed behind him\.<sup><a id="fnref-2-1-1" href="#fn-2-1">1<\/a><\/sup><\/p>\n<section class="endnotes"><p class="footnote" id="fn-2-1">/);
  assert.doesNotMatch(out[0].html, /fn-2-2/);
  // The section that begins partway down has no page mark of its own for that page: it is in the section before.
  assert.match(out[1].html, /^<h2>Chapter Eleven<\/h2>\n<p>They were nine days/);
  assert.match(out[1].html, /<p class="footnote" id="fn-2-2">/);
  assert.match(out[2].html, /^<span class="pg" id="pg4"><\/span>\n<h1>Part Two<\/h1>\n<h2>Chapter Twelve<\/h2>/);

  // A part's title just before the chapter on the same page goes with it.
  const withPart = mergePages([pages[0], { p: 2, blocks: [page('The end.'), title('Part Two', 1), title('Chapter Eleven'), long()] }], { budget: 150000 });
  assert.match(withPart[1].html, /^<h1>Part Two<\/h1>\n<h2>Chapter Eleven<\/h2>/);

  // Titles close together on a contents page begin nothing; the chapters they list do, further on.
  const contents = { p: 1, blocks: [title('Contents', 1), page('Chapter One'), page('Chapter Two'), page('Chapter Three'), long()] };
  const listed = ['One', 'Two', 'Three'].map((n, i) => ({ p: i + 2, blocks: [title(`Chapter ${n}`), long()] }));
  assert.deepEqual(mergePages([contents, ...listed], { budget: 150000 }).map((s) => [s.first, s.last, s.title]),
    [[1, 1, undefined], [2, 2, 'Chapter One'], [3, 3, 'Chapter Two'], [4, 4, 'Chapter Three']]);
});

test('pdf: a book whose chapters begin partway down a page has a section for each, named by it', async () => {
  const lines = (n, word) => Array.from({ length: n }, (_, i) => `${word} line ${i + 1} of the chapter, with enough words to fill it out.`);
  const pdf = makePdf([
    [{ text: 'Chapter Ten', size: 16 }, '', ...lines(20, 'Ten')],
    [...lines(10, 'Ten'), '', '', { text: 'Chapter Eleven', size: 16 }, '', ...lines(15, 'Eleven')],
    [...lines(25, 'Eleven')],
  ]);
  const book = await convert(pdf, { filename: 'chapters.pdf' });
  assert.deepEqual(book.sections.map((s) => [s.title, s.pageStart, s.pageEnd]), [['Chapter Ten', 1, 2], ['Chapter Eleven', 2, 3]]);
  assert.match(serialize(book.sections[1].nodes), /^<h2[^>]*>Chapter Eleven<\/h2>/);
  assert.deepEqual(book.toc.map((t) => [t.title, t.section]), [['Chapter Ten', 0], ['Chapter Eleven', 1]]);
});
