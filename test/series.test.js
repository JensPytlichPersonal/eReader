import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEpub } from './helpers/make-epub.mjs';
import { makeMobi, fixtureMobiHtml } from './helpers/make-mobi.mjs';
import { makePdf } from './helpers/make-pdf.mjs';
import { seriesFromTitle, withTitleSeries, parsePosition, parsePlace, uniqueSeries, seriesKey, seriesFromXmp, cleanSeriesName } from '../server/converters/series.js';
import { convert, readMetadata, withOpfDetails } from '../server/converters/index.js';
import { detailsFromFilename } from '../server/converters/bundle.js';
import { convertEpub } from '../server/converters/epub.js';
import { convertMarkdown } from '../server/converters/markdown.js';
import { convertPdf } from '../server/converters/pdf.js';

const calibreXmp = (name, index) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Ignored</rdf:li></rdf:Alt></dc:title></rdf:Description>
<rdf:Description rdf:about="" xmlns:calibre="http://calibre-ebook.com/xmp-namespace" xmlns:calibreSI="http://calibre-ebook.com/xmp-namespace-series-index">
<calibre:series rdf:parseType="Resource"><rdf:value>${name}</rdf:value><calibreSI:series_index>${index}</calibreSI:series_index></calibre:series>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

test('series named in titles', () => {
  const cases = [
    ['Leviathan Wakes (The Expanse Book 1)', 'Leviathan Wakes', 'The Expanse', 1],
    ["Caliban's War (The Expanse, #2)", "Caliban's War", 'The Expanse', 2],
    ['Novella (The Expanse #1.5)', 'Novella', 'The Expanse', 1.5],
    ['The Way of Kings (The Stormlight Archive, Book 1 of 10)', 'The Way of Kings', 'The Stormlight Archive', 1],
    ['Dune Messiah (Dune Chronicles, Book II)', 'Dune Messiah', 'Dune Chronicles', 2],
    ['Mistborn (Mistborn Book One)', 'Mistborn', 'Mistborn', 1],
    ['Kvinden i buret (Afdeling Q, bind 1)', 'Kvinden i buret', 'Afdeling Q', 1],
    ['Harry Potter og De Vises Sten (Bind 1 i Harry Potter-serien)', 'Harry Potter og De Vises Sten', 'Harry Potter', 1],
    ['The Hobbit (Illustrated) (Middle-earth, Book 0)', 'The Hobbit (Illustrated)', 'Middle-earth', 0],
    ['A Game of Thrones: A Song of Ice and Fire: Book One', 'A Game of Thrones', 'A Song of Ice and Fire', 1],
    ['The Eye of the World: Book One of The Wheel of Time', 'The Eye of the World', 'The Wheel of Time', 1],
    ['Leviathan Wakes: Book 1 of the Expanse (now a Prime Original series)', 'Leviathan Wakes', 'Expanse', 1],
    ['The Expanse 01 - Leviathan Wakes', 'Leviathan Wakes', 'The Expanse', 1],
    ['Discworld #5 - Sourcery', 'Sourcery', 'Discworld', 5],
    ['Discworld, Book 5: Sourcery', 'Sourcery', 'Discworld', 5],
  ];
  for (const [title, rest, name, position] of cases) {
    assert.deepEqual(seriesFromTitle(title), { title: rest, name, position }, title);
  }
  // Numbers that are part of the title, editions, volumes without a series name, plain numbers.
  for (const title of ['Windows 10 (Python 3)', 'Selected Poems (1950-1980)', 'Nineteen Eighty-Four (Penguin Modern Classics)',
    'Python Crash Course (2nd Edition)', 'Collected Poems (Volume 1)', 'Harry Potter (Book 2)', 'Kids (Ages 9 - 12)',
    'Sherlock Holmes: The Complete Novels and Stories, Volume 1', 'Windows 10 - The Missing Manual', 'Catch 22 - Joseph Heller',
    'Star Wars: Episode IV', '2001 - A Space Odyssey', 'Revolution #9', 'Kvinden i buret [Afdeling Q 1]', 'The Expanse 1 - Leviathan Wakes', '']) {
    assert.equal(seriesFromTitle(title), null, title);
  }
});

test('series names, keys and positions', () => {
  assert.equal(cleanSeriesName('  The   Expanse, '), 'The Expanse');
  assert.equal(seriesKey('The Expanse'), seriesKey('  the  EXPANSE '));
  assert.equal(seriesKey('Ender’s Saga'), seriesKey("Ender's Saga"));
  assert.equal(seriesKey('ØRNEN'), seriesKey('ørnen'));
  assert.notEqual(seriesKey('Expanse'), seriesKey('The Expanse'));
  assert.deepEqual(['3', ' 03 ', '2,5', '2.50', 4, '', null, 'abc', '1e3', -1, '-2', 100000].map(parsePosition), [3, 3, 2.5, 2.5, 4, null, null, null, null, null, null, null]);
});

test('a book holding several, such as an omnibus, has a range of numbers', () => {
  assert.deepEqual(['1-3', '1–3', ' 1 - 3 ', '2,5-4', '3-3', 4, '3-1', '1-', '-3', 'one-three', ''].map(parsePlace), [
    { position: 1, positionEnd: 3 }, { position: 1, positionEnd: 3 }, { position: 1, positionEnd: 3 }, { position: 2.5, positionEnd: 4 },
    { position: 3 }, { position: 4 }, null, null, null, null, null,
  ]);
  const cases = [
    ['The Expanse Omnibus (The Expanse, #1-3)', 'The Expanse Omnibus'],
    ['Box Set (The Expanse, Books 1–3)', 'Box Set'],
    ['Trilogy (Books 1-3 of The Expanse)', 'Trilogy'],
    ['Omnibus: The Expanse: Books 1 - 3', 'Omnibus'],
    ['The Expanse #1-3 - Omnibus', 'Omnibus'],
  ];
  for (const [title, rest] of cases) assert.deepEqual(seriesFromTitle(title), { title: rest, name: 'The Expanse', position: 1, positionEnd: 3 }, title);
  assert.deepEqual(seriesFromTitle('Afdeling Q 1-3 (Afdeling Q, bind 1-3)'), { title: 'Afdeling Q 1-3', name: 'Afdeling Q', position: 1, positionEnd: 3 });
  // Before the title, a range has no spaces: this is book 5, "1066 and All That". Plain numbers stay titles.
  assert.deepEqual(seriesFromTitle('Discworld #5 - 1066 and All That'), { title: '1066 and All That', name: 'Discworld', position: 5 });
  for (const title of ['Selected Poems (1950-1980)', 'Kids (Ages 9 - 12)', 'Omnibus (The Expanse, #3-1)']) assert.equal(seriesFromTitle(title), null, title);
  // A range stays a range through the details: from the title, or as positionEnd beside the position.
  assert.deepEqual(withTitleSeries({ title: 'Omnibus (Expanse, #1-3)', series: [{ name: 'The Expanse', position: null }] }),
    { title: 'Omnibus', series: [{ name: 'The Expanse', position: 1, positionEnd: 3 }] });
  assert.deepEqual(uniqueSeries([{ name: 'A', position: 1, positionEnd: 3 }, { name: 'B', position: '2-4' }, { name: 'C', position: 5, positionEnd: 2 }, { name: 'D', position: null, positionEnd: 2 }]),
    [{ name: 'A', position: 1, positionEnd: 3 }, { name: 'B', position: 2, positionEnd: 4 }, { name: 'C', position: 5 }, { name: 'D', position: null }]);
});

test('epub 3: an omnibus as a range in its collection', async () => {
  const book = await convert(makeEpub({ title: 'The Expanse Omnibus', metadata: '<meta property="belongs-to-collection" id="c">The Expanse</meta><meta refines="#c" property="group-position">1-3</meta>' }), { filename: 'omnibus.epub' });
  assert.deepEqual(book.meta.series, [{ name: 'The Expanse', position: 1, positionEnd: 3 }]);
});

test('a title naming the recorded series loses that part', () => {
  assert.deepEqual(withTitleSeries({ title: 'Leviathan Wakes (Expanse Book 1)', series: [{ name: 'The Expanse', position: null }] }),
    { title: 'Leviathan Wakes', series: [{ name: 'The Expanse', position: 1 }] });
  assert.deepEqual(withTitleSeries({ title: 'Consider Phlebas (The Culture Series, Book 1)', series: [{ name: 'Culture', position: 1 }] }),
    { title: 'Consider Phlebas', series: [{ name: 'Culture', position: 1 }] });
  // A different series in the metadata wins and the title is left alone.
  assert.deepEqual(withTitleSeries({ title: 'Leviathan Wakes (Expanse Book 1)', series: [{ name: 'Orbit Classics', position: 4 }] }),
    { title: 'Leviathan Wakes (Expanse Book 1)', series: [{ name: 'Orbit Classics', position: 4 }] });
  assert.deepEqual(withTitleSeries({ title: 'Plain', series: [{ name: ' ', position: 1 }, { name: 'A', position: 'x' }, { name: 'a', position: 2 }] }),
    { title: 'Plain', series: [{ name: 'A', position: 2 }] });
});

test('epub: calibre series', async () => {
  const book = await convert(makeEpub({ title: 'Leviathan Wakes (The Expanse Book 1)', metadata: '<meta name="calibre:series" content="The Expanse"/><meta name="calibre:series_index" content="1.0"/>' }), { filename: 'lw.epub' });
  assert.equal(book.meta.title, 'Leviathan Wakes');
  assert.deepEqual(book.meta.series, [{ name: 'The Expanse', position: 1 }]);
});

test('epub 3: collections, sets and collection titles', async () => {
  const metadata = `
    <meta property="belongs-to-collection" id="c1">Great Books of the Western World</meta>
    <meta refines="#c1" property="collection-type">set</meta>
    <meta refines="#c1" property="group-position">48</meta>
    <meta property="belongs-to-collection" id="c2">Mardi Trilogy</meta>
    <meta refines="#c2" property="collection-type">series</meta>
    <meta refines="#c2" property="group-position">2</meta>
    <meta refines="#c2" property="belongs-to-collection">Nested parent is not the book's own</meta>
    <meta refines="#t1" property="title-type">collection</meta>
    <meta refines="#t2" property="title-type">main</meta>`;
  const titleXml = '<dc:title id="t1">Melville Collection</dc:title><dc:title id="t2">Moby-Dick</dc:title>';
  const book = await convertEpub(makeEpub({ metadata, titleXml }), { filename: 'm.epub' });
  assert.equal(book.meta.title, 'Moby-Dick');
  assert.deepEqual(book.meta.series, [
    { name: 'Mardi Trilogy', position: 2 },
    { name: 'Great Books of the Western World', position: 48 },
    { name: 'Melville Collection', position: null },
  ]);
  const plain = await convertEpub(makeEpub({}), { filename: 'f.epub' });
  assert.deepEqual(plain.meta.series, []);
});

test('mobi: series from the title', async () => {
  const book = await convert(makeMobi({ html: fixtureMobiHtml(), title: "Abaddon's Gate (The Expanse, #3)" }), { filename: 'ag.mobi' });
  assert.equal(book.meta.title, "Abaddon's Gate");
  assert.deepEqual(book.meta.series, [{ name: 'The Expanse', position: 3 }]);
});

test('pdf: calibre series in XMP metadata', async () => {
  const pdf = makePdf([['Some text on the only page.']], { title: 'Cibola Burn', author: 'James S. A. Corey', xmp: calibreXmp('The Expanse', '4.00') });
  const book = await convertPdf(pdf, { filename: 'cb.pdf' });
  assert.equal(book.meta.title, 'Cibola Burn');
  assert.deepEqual(book.meta.series, [{ name: 'The Expanse', position: 4 }]);
  assert.deepEqual(seriesFromXmp(calibreXmp('X', '1').replaceAll('calibre-ebook.com/xmp-namespace"', 'example.com/other"')), []);
  const noXmp = await convertPdf(makePdf([['Text.']]), { filename: 'n.pdf' });
  assert.deepEqual(noXmp.meta.series, []);
});

test('markdown: series in front matter', async () => {
  const book = await convertMarkdown(Buffer.from('---\ntitle: Notes\nseries: "Field Guides"\nseries_index: 2\n---\n# One\n\nText.'), { filename: 'n.md' });
  assert.deepEqual(book.meta.series, [{ name: 'Field Guides', position: 2 }]);
  const list = await convertMarkdown(Buffer.from('---\ntitle: Notes\nseries: ["Getting Started", "Other"]\n---\nText.'), { filename: 'n.md' });
  assert.deepEqual(list.meta.series, [{ name: 'Getting Started', position: null }]);
});

test('reading details without converting', async () => {
  const epub = await readMetadata(makeEpub({ title: 'Caliban’s War', metadata: '<meta name="calibre:series" content="The Expanse"/><meta name="calibre:series_index" content="2"/>' }), { filename: 'cw.epub' });
  assert.equal(epub.title, 'Caliban’s War');
  assert.deepEqual(epub.series, [{ name: 'The Expanse', position: 2 }]);
  const pdf = await readMetadata(makePdf([['Text.']], { title: 'Cibola Burn', xmp: calibreXmp('The Expanse', '4') }), { filename: 'cb.pdf' });
  assert.deepEqual([pdf.title, pdf.series], ['Cibola Burn', [{ name: 'The Expanse', position: 4 }]]);
  const mobi = await readMetadata(makeMobi({ html: fixtureMobiHtml(), title: 'Abaddon’s Gate (The Expanse, #3)' }), { filename: 'ag.mobi' });
  assert.equal(mobi.title, 'Abaddon’s Gate (The Expanse, #3)');
  const md = await readMetadata(Buffer.from('---\nseries: Field Guides\nvolume: 3\n---\n# Birds\n'), { filename: 'b.md' });
  assert.deepEqual([md.title, md.series], ['Birds', [{ name: 'Field Guides', position: 3 }]]);
  const txt = await readMetadata(Buffer.from('Hello'), { filename: 'The Expanse 05 - Nemesis Games.txt' });
  assert.equal(withTitleSeries(txt).title, 'Nemesis Games');
});

test('titles from file names: a number in front is a place in a series, and capitals set on every word are tidied', () => {
  const road = (position) => [{ name: 'The Glass Road', position }];
  const cases = [
    ['01 - The Glass Road - Keeper Of The Gate.PDF', 'Keeper of the Gate', road(1)],
    ['07. The Glass Road - A Song For The Tide.epub', 'A Song for the Tide', road(7)],
    ['12.The Glass Road – Salt And Iron.txt', 'Salt and Iron', road(12)],
    ['2.5 - The Glass Road - Between The Books.pdf', 'Between the Books', road(2.5)],
    ['_OceanofPDF.com_04_-_The_Glass_Road_-_Keeper_Of_The_Gate.pdf', 'Keeper of the Gate', road(4)],
    // Without a series name the number just goes.
    ['03 - Salt And Iron.txt', 'Salt and Iron', []],
    ['05 - Keeper Of The Gate (The Glass Road Book 5).mobi', 'Keeper of the Gate', road(5)],
    // The forms a book's own title may have work as before.
    ['The Glass Road 03 - Keeper Of The Gate.txt', 'Keeper of the Gate', road(3)],
    ['Keeper Of The Gate (The Glass Road Book 2).mobi', 'Keeper of the Gate', road(2)],
    // Four digits are a year, and part of the title.
    ['1984 - Some Author.pdf', '1984 - Some Author', []],
    ['1-3 The Glass Road.pdf', '1-3 The Glass Road', []],
    // Small words stay capitals first and last and where the title starts again; other shapes are left alone.
    ['Of Mice And Men: A Tale Of The Road.txt', 'Of Mice and Men: A Tale of the Road', []],
    ['A Thing To Think Of.txt', 'A Thing to Think Of', []],
    ['Mother-In-Law Of The Year.txt', 'Mother-in-Law of the Year', []],
    ['keeper of the gate.txt', 'keeper of the gate', []],
    ['KEEPER OF THE GATE.txt', 'KEEPER OF THE GATE', []],
    ['Keeper of The Gate.txt', 'Keeper of The Gate', []],
    ['.txt', 'Untitled', []],
    // An underscore for an apostrophe comes back, and a copy's version mark goes.
    ['03 - The Glass Road - Keeper_s Gate.PDF', "Keeper's Gate", road(3)],
    ['Don_t Look Back_s Way.txt', "Don't Look Back's Way", []],
    ['_OceanofPDF.com_The_Keeper_s_Gate.pdf', "The Keeper's Gate", []],
    ['01 - The Glass Road - Keeper Of The Gate (v2).pdf', 'Keeper of the Gate', road(1)],
    ['Salt And Iron [Version 1.1].epub', 'Salt and Iron', []],
  ];
  for (const [filename, title, series] of cases) assert.deepEqual(detailsFromFilename(filename), { title, series }, filename);
});

test('a book without a title of its own takes it from the file name, in every format, converted or read', async () => {
  const filename = (ext) => `04 - The Glass Road - Keeper Of The Gate.${ext}`;
  const books = [
    ['epub', makeEpub({ titleXml: '' })],
    ['mobi', makeMobi({ html: fixtureMobiHtml(), title: '' })],
    ['pdf', makePdf([['Some text on the only page.']])],
    ['md', Buffer.from('Some text, and no heading.')],
    ['txt', Buffer.from('Some text.')],
  ];
  for (const [ext, buf] of books) {
    const book = await convert(buf, { filename: filename(ext) });
    const read = await readMetadata(buf, { filename: filename(ext) });
    for (const meta of [book.meta, read]) {
      assert.deepEqual([meta.title, meta.series], ['Keeper of the Gate', [{ name: 'The Glass Road', position: 4 }]], ext);
    }
  }
});

test('only a title from the file name loses its number, and the series the book records wins', async () => {
  // A book's own title is left as it is: there a number in front is too often part of it.
  const epub = await convert(makeEpub({ title: '01 - The Glass Road - Keeper Of The Gate' }), { filename: '01 - The Glass Road - Keeper Of The Gate.epub' });
  assert.deepEqual([epub.meta.title, epub.meta.series], ['01 - The Glass Road - Keeper Of The Gate', []]);
  const pdf = await readMetadata(makePdf([['Text.']], { title: '03 - Salt And Iron' }), { filename: '03 - Salt And Iron.pdf' });
  assert.deepEqual([pdf.title, pdf.series], ['03 - Salt And Iron', []]);
  // The file name gives the place in the series the book records without one; another series it records wins.
  const same = await convert(makePdf([['Text.']], { xmp: calibreXmp('Glass Road', '') }), { filename: '04 - The Glass Road - Keeper Of The Gate.pdf' });
  assert.deepEqual([same.meta.title, same.meta.series], ['Keeper of the Gate', [{ name: 'Glass Road', position: 4 }]]);
  const other = await convert(makePdf([['Text.']], { xmp: calibreXmp('Harbour Lights', '2') }), { filename: '04 - The Glass Road - Keeper Of The Gate.pdf' });
  assert.deepEqual([other.meta.title, other.meta.series], ['Keeper of the Gate', [{ name: 'Harbour Lights', position: 2 }]]);
  // An OPF file that came with the book still wins.
  const opf = { title: 'The Gatekeeper', author: '', language: '', series: [{ name: 'Glass Road Saga', position: 1 }], isbns: [] };
  assert.equal(withOpfDetails(same.meta, opf).title, 'The Gatekeeper');
  assert.deepEqual(withOpfDetails(same.meta, opf).series, [{ name: 'Glass Road Saga', position: 1 }]);
});
