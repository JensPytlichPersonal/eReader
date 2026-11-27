import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldQuery, searchText, findIn, percentOf, MAX_HITS } from '../server/search.js';
import { parseSection, positionText } from '../server/fixes.js';
import { textLength } from '../server/converters/html.js';

const nodes = (html) => parseSection(html).children;
// A book of these sections, with a title and a contents entry for each, as book.json has them.
function book(htmls, toc) {
  const sections = htmls.map((h) => searchText(nodes(h)));
  let start = 0;
  const manifest = {
    sections: htmls.map((h, i) => {
      const chars = textLength(nodes(h));
      const s = { title: `Chapter ${i + 1}`, start, chars };
      start += chars;
      return s;
    }),
    toc: toc ?? htmls.map((_, i) => ({ title: `Chapter ${i + 1}`, section: i, id: null })),
  };
  manifest.totalChars = start;
  return { sections, manifest, find: (q) => findIn(sections, manifest, q) };
}
// The words a hit stands for, cut out of the section as the reader counts its places.
const cut = (html, hit) => positionText(nodes(html)).slice(hit.offset, hit.offset + hit.length);

test('a search is folded: lower case, one space between words, straight quotes, no soft hyphens', () => {
  assert.equal(foldQuery('  The   WHALE\n\tswam  '), 'the whale swam');
  assert.equal(foldQuery('the\u00A0whale'), 'the whale');
  assert.equal(foldQuery('\u201CCall me\u201D \u2018Ishmael\u2019'), '"call me" \'ishmael\'');
  assert.equal(foldQuery('\u201Esi\u201F \u201Aja\u201B'), '"si" \'ja\'');
  assert.equal(foldQuery('whale\u00ADbone'), 'whalebone');
  assert.equal(foldQuery(''), '');
  assert.equal(foldQuery(undefined), '');
});

test('accents and Danish letters stay as they are, only in lower case', () => {
  assert.equal(foldQuery('GÅRD Ærø Øl café'), 'gård ærø øl café');
  assert.notEqual(foldQuery('gård'), foldQuery('gard'));
});

test('a letter that is longer in lower case keeps every character after it in its place', () => {
  // "İ" is one character, and two in lower case.
  const sec = searchText(nodes('<p>\u0130stanbul and Izmir</p>'));
  assert.equal(sec.text, '\ni\u0307stanbul and izmir\n');
  const at = sec.text.indexOf('izmir');
  assert.equal(sec.raw.slice(sec.from[at], sec.to[at + 4]), 'Izmir');
  const { hits } = book(['<p>\u0130stanbul and Izmir</p>']).find('\u0130STANBUL and');
  assert.equal(hits.length, 1);
  assert.equal(cut('<p>\u0130stanbul and Izmir</p>', hits[0]), '\u0130stanbul and');
});

test('the text searched counts places as positionText does, pictures, page marks and <pre> included', () => {
  const html = '<h1 id="c1">One</h1>\r\n<p>A <em>b</em><span class="pg" id="pg3"></span> c<img src="x.png"/>d</p><pre>\nline one\r\nline two</pre><p>\u00A0end\u00AD.</p>';
  const sec = searchText(nodes(html));
  assert.equal(sec.raw, positionText(nodes(html)));
  // A break between blocks and for the picture, which no search holds.
  assert.equal(sec.text, '\none\na b c\nd\nline one line two\nend.\n');
  assert.equal(sec.ids.get('c1'), 0);
  assert.equal(sec.ids.get('pg3'), sec.raw.indexOf(' c'));
  // Every character of the folded text stands for the places it came from.
  for (let i = 0; i < sec.text.length; i++) {
    if (sec.text[i] === '\n') continue;
    const piece = sec.raw.slice(sec.from[i], sec.to[i]);
    if (sec.text[i] === ' ') assert.match(piece, /^\s+$/);
    else assert.equal(piece.toLowerCase(), sec.text[i]);
  }
});

test('a hit is the whole of the words as the book has them, across tags and line breaks', () => {
  const html = '<p>Call me <em>Ish</em>mael.  Some years\n   ago, never <a href="#x">mind how</a> long.</p>';
  const { hits, total } = book([html]).find('ishmael. some years ago');
  assert.equal(total, 1);
  assert.equal(cut(html, hits[0]), 'Ishmael.  Some years\n   ago');
  assert.equal(hits[0].match, 'Ishmael. Some years ago');
  assert.equal(cut(html, book([html]).find('never mind how long').hits[0]), 'never mind how long');
});

test('case does not matter, and the match is as the book writes it', () => {
  const html = '<p>The WHALE and the whale and the Whale.</p>';
  const { hits } = book([html]).find('Whale');
  assert.deepEqual(hits.map((h) => h.match), ['WHALE', 'whale', 'Whale']);
  assert.deepEqual(hits.map((h) => cut(html, h)), ['WHALE', 'whale', 'Whale']);
});

test('a phrase is never found across two blocks, a <br> or a picture', () => {
  const b = book(['<p>It was the end.</p>\n<p>Start again.</p><h2>Head</h2><p>line<br/>break</p><p>pic<img src="a.png"/>ture</p><ul><li>one</li><li>two</li></ul>']);
  assert.equal(b.find('end.start').total, 0);
  assert.equal(b.find('end. start').total, 0);
  assert.equal(b.find('end.').total, 1);
  assert.equal(b.find('again. head').total, 0);
  assert.equal(b.find('line break').total, 0);
  assert.equal(b.find('picture').total, 0);
  assert.equal(b.find('one two').total, 0);
  assert.equal(b.find('linebreak').total, 0);
});

test('curly quotes in the book are found with straight ones, and the other way round', () => {
  const html = '<p>\u201CIt\u2019s mine,\u201D he said. "Don\'t."</p>';
  const b = book([html]);
  const hit = b.find('"it\'s mine,"').hits[0];
  assert.equal(cut(html, hit), '\u201CIt\u2019s mine,\u201D');
  assert.equal(b.find('don\u2019t').total, 1);
});

test('"gard" does not find "gård", nor "a" an "å"', () => {
  const b = book(['<p>Han gik hjem til gården i Århus.</p>']);
  assert.equal(b.find('gard').total, 0);
  assert.equal(b.find('arhus').total, 0);
  assert.equal(b.find('gård').total, 1);
  assert.equal(b.find('ÅRHUS').total, 1);
});

test('places are found in book order and do not overlap', () => {
  const b = book(['<p>aaaa aa</p>', '<p>aa</p>']);
  const { hits, total } = b.find('aa');
  assert.equal(total, 4);
  assert.deepEqual(hits.map((h) => [h.section, h.offset]), [[0, 0], [0, 2], [0, 5], [1, 0]]);
});

test('only the first places are answered, with how many there are', () => {
  const html = `<p>${'whale '.repeat(150)}</p><p>${'whale '.repeat(100)}</p>`;
  const { hits, total } = book([html, '<p>A whale.</p>']).find('whale');
  assert.equal(total, 251);
  assert.equal(hits.length, MAX_HITS);
  assert.ok(hits.every((h, i) => !i || h.offset > hits[i - 1].offset));
});

test('a hit shows some of its block around it, cut at words', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const html = `<p>${words} WHALE ${words}</p><p>Next paragraph.</p>`;
  const [hit] = book([html]).find('whale').hits;
  assert.equal(hit.match, 'WHALE');
  assert.ok(hit.before.startsWith('…') && hit.before.endsWith(' '), hit.before);
  assert.ok(hit.before.length <= 42, hit.before);
  assert.ok(words.endsWith(hit.before.slice(1).trimEnd()), hit.before);
  assert.ok(hit.after.startsWith(' ') && hit.after.endsWith('…'), hit.after);
  assert.ok(hit.after.length <= 62, hit.after);
  assert.ok(words.startsWith(hit.after.slice(1, -1)), hit.after);
  assert.ok(!hit.after.includes('Next'));
  // A short block is shown whole.
  const [short] = book(['<p>A  little\n whale here.</p>']).find('whale').hits;
  assert.deepEqual([short.before, short.match, short.after], ['A little ', 'whale', ' here.']);
});

test('a hit is named by the chapter it is in, and says how far into the book it is', () => {
  const htmls = ['<h1 id="a">Part One</h1><p>whale</p><h2 id="b">The Sea</h2><p>whale</p>', '<p>whale</p>'];
  const b = book(htmls, [{ title: 'Part One', section: 0, id: 'a', children: [{ title: 'The Sea', section: 0, id: 'b' }] }]);
  b.manifest.sections[0].title = 'Part One';
  b.manifest.sections[1].title = '';
  const { hits } = b.find('whale');
  assert.deepEqual(hits.map((h) => h.title), ['Part One', 'The Sea', 'Section 2']);
  assert.deepEqual(hits.map((h) => h.percent), hits.map((h) => percentOf(b.manifest, h.section, h.offset)));
  assert.equal(hits[2].percent, b.manifest.sections[1].start / b.manifest.totalChars);
});

test('a search of nothing finds nothing', () => {
  assert.deepEqual(book(['<p>Text.</p>']).find('   '), { total: 0, hits: [] });
});
