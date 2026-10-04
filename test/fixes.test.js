import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixHtml, paragraphsOf, parseSection, collapse, startKey, pairParagraphs, diffText, parseFixInput,
  positionText, positionShift, shiftOffset, findRun, renameTitles, FixError,
} from '../server/fixes.js';

const texts = (html) => paragraphsOf(parseSection(html)).map((p) => p.text);
// Fixes the paragraphs of `html` that read as `before` (one run of them) to read as `after`.
const fix = (html, before, after) => {
  const all = texts(html);
  const start = all.indexOf(before[0]);
  assert.ok(start >= 0, `"${before[0]}" is not a paragraph of ${html}`);
  const result = fixHtml(html, start, before.length, after);
  assert.deepEqual(texts(result.html), [...all.slice(0, start), ...after, ...all.slice(start + before.length)]);
  return result;
};

test('paragraphs are the elements holding text and no other blocks, read with white space collapsed', () => {
  const html = '<h1 id="c1">Chapter\n  One</h1><div><p>First\u00a0 one.</p><p>  </p></div><ul><li>An <i>item</i></li><li><p>Inside</p></li></ul>'
    + '<pre><p>code</p></pre><blockquote>Quoted <br/>text</blockquote><table><tr><td>Cell</td></tr></table><span class="pg" id="pg2"></span>';
  assert.deepEqual(texts(html), ['Chapter One', 'First one.', 'An item', 'Inside', 'Quoted text', 'Cell']);
  assert.equal(collapse(' a \n\t b\u00a0 '), 'a b');
});

test('a line break reads as a space, and stays where it is unless the space it stands for is taken out', () => {
  assert.deepEqual(texts('<p>one<br/>two</p><p>one <br/>\n two</p><p><i>one</i><br/><br/>two<br/></p>'), ['one two', 'one two', 'one two']);
  // A word fixed next to a line break keeps it.
  assert.equal(fix('<p>line onf<br/>lime two</p>', ['line onf lime two'], ['line one line two']).html, '<p>line one<br />line two</p>');
  assert.equal(fix('<p>line one<br/>two</p>', ['line one two'], ['line one, two']).html, '<p>line one,<br />two</p>');
  assert.equal(fix('<p>line one<br/>two</p>', ['line one two'], ['line one and two']).html, '<p>line one<br />and two</p>');
  assert.equal(fix('<p><i>one</i> <br/>two</p>', ['one two'], ['one too']).html, '<p><i>one</i> <br />too</p>');
  // Taking out the space it stands for takes the line break out; text never goes into it.
  assert.equal(fix('<p>one<br/>two</p>', ['one two'], ['onetwo']).html, '<p>onetwo</p>');
  assert.equal(fix('<p>one <br/>\ntwo</p>', ['one two'], ['one-two']).html, '<p>one-two</p>');
  // Before a line break the only text node is the italic word, so a mark added there is italic too.
  assert.equal(fix('<p><i>one</i><br/>two</p>', ['one two'], ['one, two']).html, '<p><i>one,</i><br />two</p>');
  assert.equal(fix('<p><i>one</i><br/>two</p>', ['one two'], ['one/two']).html, '<p><i>one</i>/two</p>');
  // A passage moved across a line break keeps its words apart, and its formatting; the break stays behind.
  const poem = '<p>Start here.</p><p class="v"><i>The first line of a poem<br/>and the second line too</i></p>';
  assert.equal(fix(poem, ['Start here.', 'The first line of a poem and the second line too'], ['Start here. The first line of a poem and the second line too']).html,
    '<p>Start here. <i>The first line of a poem and the second line too</i></p>');
  // The reader counts nothing for a line break.
  assert.equal(positionText(parseSection('<p>one<br/>two</p>').children), 'onetwo');
});

test('a word fixed in a plain paragraph changes only those characters', () => {
  const { html } = fix('<p>Alorn sat in tbe hall.</p>', ['Alorn sat in tbe hall.'], ['Alorn sat in the hall.']);
  assert.equal(html, '<p>Alorn sat in the hall.</p>');
  assert.deepEqual(diffText('Alorn sat in tbe hall.', 'Alorn sat in the hall.'), [{ start: 14, end: 15, text: 'h' }]);
  assert.deepEqual(diffText('a b c', 'a c'), [{ start: 2, end: 4, text: '' }]);
  // Small fixes far apart stay apart; a mark in both texts does not cut a passage replaced as a whole.
  assert.deepEqual(diffText('Tbe qnick fox', 'The quick fox'), [{ start: 1, end: 2, text: 'h' }, { start: 5, end: 6, text: 'u' }]);
  assert.deepEqual(diffText('Old, said he. And more words!', 'Old.'), [{ start: 3, end: 29, text: '.' }]);
  assert.deepEqual(diffText("it's here", "it's not here"), [{ start: 5, end: 5, text: 'not ' }]);
});

test('formatting stays with the words: a fix inside italics stays italic, a word added after them is plain', () => {
  const html = '<p>The <i>Book</i> of Alorn tbe end</p>';
  assert.equal(fix(html, ['The Book of Alorn tbe end'], ['The Book of Alorn the end']).html, '<p>The <i>Book</i> of Alorn the end</p>');
  assert.equal(fix('<p>The <i>Bok</i> of Alorn</p>', ['The Bok of Alorn'], ['The Book of Alorn']).html, '<p>The <i>Book</i> of Alorn</p>');
  assert.equal(fix(html, ['The Book of Alorn tbe end'], ['The Books of Alorn tbe end']).html, '<p>The <i>Book</i>s of Alorn tbe end</p>');
  // A word added before italics is plain too, and a word replacing an italic one is italic.
  assert.equal(fix(html, ['The Book of Alorn tbe end'], ['The Old Book of Alorn tbe end']).html, '<p>The Old <i>Book</i> of Alorn tbe end</p>');
  assert.equal(fix(html, ['The Book of Alorn tbe end'], ['The Tale of Alorn tbe end']).html, '<p>The <i>Tale</i> of Alorn tbe end</p>');
  // An italic word removed takes its element with it.
  assert.equal(fix(html, ['The Book of Alorn tbe end'], ['The of Alorn tbe end']).html, '<p>The of Alorn tbe end</p>');
});

test('paragraphs are joined in the first one, split with the look of the one before, and removed', () => {
  const two = '<p class="a">First half,</p>\n<p class="b">second half.</p>';
  assert.equal(fix(two, ['First half,', 'second half.'], ['First half, second half.']).html, '<p class="a">First half, second half.</p>\n');
  const split = fix('<p class="x" id="p1">One sentence. Two sentence.</p>', ['One sentence. Two sentence.'], ['One sentence.', 'Two sentence.']);
  assert.equal(split.html, '<p class="x" id="p1">One sentence.</p><p class="x">Two sentence.</p>');
  // After a heading the new paragraph is a plain p.
  const heading = fix('<h2 class="t" id="h">Chapter Two The road</h2>', ['Chapter Two The road'], ['Chapter Two', 'The road']);
  assert.equal(heading.html, '<h2 class="t" id="h">Chapter Two</h2><p>The road</p>');
  assert.deepEqual(heading.renames, [{ from: 'Chapter Two The road', to: 'Chapter Two' }]);
  // A new first paragraph goes before the first old one, with its look.
  assert.equal(fix('<p class="x">Body text here.</p>', ['Body text here.'], ['A new start.', 'Body text here.']).html,
    '<p class="x">A new start.</p><p class="x">Body text here.</p>');
  assert.equal(fix('<p>Stay.</p><p>Go away.</p><p>Stay too.</p>', ['Go away.'], []).html, '<p>Stay.</p><p>Stay too.</p>');
  // A wrapper the paragraph leaves empty goes with it.
  assert.equal(fix('<ul><li><p>Gone.</p></li><li>Kept.</li></ul>', ['Gone.'], []).html, '<ul><li>Kept.</li></ul>');
});

test('a removed paragraph holding a picture, an anchor or a page mark keeps them in its element', () => {
  const removed = (inner) => fix(`<p>Before.</p><p class="r">${inner}</p><p>After.</p>`, ['Before.', collapse(texts(`<p>${inner}</p>`)[0])], ['Before.']).html;
  assert.equal(removed('Text <img alt="" data-src="images/a.png" /> here'), '<p>Before.</p><p class="r"><img alt="" data-src="images/a.png" /></p><p>After.</p>');
  assert.equal(removed('Text <a id="note1">here</a>'), '<p>Before.</p><p class="r"><a id="note1"></a></p><p>After.</p>');
  assert.equal(removed('Te<span class="pg" id="pg4"></span>xt here'), '<p>Before.</p><p class="r"><span class="pg" id="pg4"></span></p><p>After.</p>');
  assert.equal(removed('Plain <i>text</i> here'), '<p>Before.</p><p>After.</p>');
  assert.equal(fix('<p>Before.</p><p id="x">Text.</p>', ['Text.'], []).html, '<p>Before.</p><p id="x"></p>');
});

test('the footnote that landed in a sentence: moved back, or removed', () => {
  const p1 = 'floor. "You have done us much honor tonight, my old';
  const note = '* Several shorter, less formal versions of the story existed, similar to the adaptation used here in the Prologue. '
    + 'Even <i>The Book of Alorn</i> was said to be an abridgment of a much older document';
  const speech = 'friend," he said, his voice thick with emotion. "This is an event we will remember all our lives. '
    + 'You have told us a kingly <em>story</em>, not usually wasted on ordinary people."';
  const html = `<p>${p1}</p>\n<p class="note" style="margin-left:2em">${note}, ${speech}</p>\n<p>He bowed.</p>`;
  const [t1, t2] = texts(html);
  const spoken = collapse(texts(`<p>${speech}</p>`)[0]);
  const noted = `${collapse(texts(`<p>${note}</p>`)[0])}.`;

  // Keep the note: two paragraphs to two, each in its own element.
  const kept = fix(html, [t1, t2], [`${t1} ${spoken}`, noted]);
  assert.equal(kept.html, `<p>${p1} ${speech}</p>\n<p class="note" style="margin-left:2em">${note}.</p>\n<p>He bowed.</p>`);
  // Empty the note: the speech is in the first paragraph, still with its emphasis, and the note is gone.
  const emptied = fix(html, [t1, t2], [`${t1} ${spoken}`]);
  assert.equal(emptied.html, `<p>${p1} ${speech}</p>\n\n<p>He bowed.</p>`);

  assert.deepEqual(pairParagraphs([t1, t2], [`${t1} ${spoken}`, noted]), { oldOf: [0, 1], removed: [] });
  assert.deepEqual(pairParagraphs([t1, t2], [`${t1} ${spoken}`]), { oldOf: [0], removed: [1] });
});

test('paragraphs are paired by how they start, and by place where that changed', () => {
  // The middle of three removed: the third keeps its own element and look.
  const html = '<p class="a">Alpha one here.</p><p class="b">Beta two here.</p><p class="c">Gamma three here.</p>';
  assert.equal(fix(html, ['Alpha one here.', 'Beta two here.', 'Gamma three here.'], ['Alpha one here.', 'Gamma three here!']).html,
    '<p class="a">Alpha one here.</p><p class="c">Gamma three here!</p>');
  assert.deepEqual(pairParagraphs(['Alpha one here.', 'Beta two here.', 'Gamma three here.'], ['Alpha one here.', 'Gamma three here!']), { oldOf: [0, 2], removed: [1] });
  // The first word fixed: the starts differ, so they are paired by place.
  assert.deepEqual(pairParagraphs(['Tbe start of it.'], ['The start of it.']), { oldOf: [0], removed: [] });
  assert.equal(fix('<p class="q">Tbe start of it.</p>', ['Tbe start of it.'], ['The start of it.']).html, '<p class="q">The start of it.</p>');
  // Split and joined.
  assert.deepEqual(pairParagraphs(['One. Two.'], ['One.', 'Two.']), { oldOf: [0, -1], removed: [] });
  assert.deepEqual(pairParagraphs(['One.', 'Two.'], ['One. Two.']), { oldOf: [0], removed: [1] });
  assert.equal(startKey('“Well, I’ve 2 of THEM,” he said, at last.'), 'well i ve 2 of');
  assert.equal(startKey('* * *'), '');
});

test('text moved to another paragraph keeps its formatting, without the anchors and marks that stay behind', () => {
  const html = '<p>He said nothing.</p><p class="s">Then <i>the long italic title of a book</i><span class="pg" id="pg3"></span> came <a id="n2" href="#sec=1">at last</a>.</p>';
  const [t1, t2] = texts(html);
  const { html: out } = fix(html, [t1, t2], [`${t1} ${t2}`]);
  assert.equal(out, '<p>He said nothing. Then <i>the long italic title of a book</i> came <a href="#sec=1">at last</a>.</p>'
    + '<p class="s"><span class="pg" id="pg3"></span><a id="n2" href="#sec=1"></a></p>');
  // Cut in the middle of an italic run, only that part is copied, still italic.
  const part = fix('<p>Start here.</p><p>And <i>so they went on and on and on</i> forever.</p>',
    ['Start here.', 'And so they went on and on and on forever.'], ['Start here. they went on and on and on forever.', 'And so']);
  assert.equal(part.html, '<p>Start here. <i>they went on and on and on</i> forever.</p><p>And <i>so</i></p>');
  // Short text is not taken for moved text: it is plain.
  assert.equal(fix('<p>A.</p><p><b>Bold bit.</b></p>', ['A.', 'Bold bit.'], ['A. Bold bit.']).html, '<p>A. Bold bit.</p>');
});

test('a page mark inside a word stays where it is when a word near it is fixed', () => {
  const html = '<p>A won<span class="pg" id="pg5"></span>derful tbe day</p>';
  assert.equal(fix(html, ['A wonderful tbe day'], ['A wonderful the day']).html, '<p>A won<span class="pg" id="pg5"></span>derful the day</p>');
  assert.equal(fix(html, ['A wonderful tbe day'], ['A wonderfull the day']).html, '<p>A won<span class="pg" id="pg5"></span>derfull the day</p>');
});

test('a paragraph in a table is fixed on its own', () => {
  const html = '<table><tr><td>One</td><td>Twoo</td></tr></table>';
  assert.equal(fix(html, ['Twoo'], ['Two']).html, '<table><tr><td>One</td><td>Two</td></tr></table>');
  for (const [start, count, after] of [[0, 2, ['One Two']], [0, 1, ['One', 'Uno']], [1, 1, []]]) {
    assert.throws(() => fixHtml(html, start, count, after), (err) => err instanceof FixError && err.status === 400 && err.message === 'A paragraph in a table is fixed on its own');
  }
});

test('a heading change is reported, and renames the contents and section titles that read as it did', () => {
  assert.deepEqual(fix('<h1 id="c">Chaptr One</h1><p>Text.</p>', ['Chaptr One', 'Text.'], ['Chapter One', 'Text!']).renames, [{ from: 'Chaptr One', to: 'Chapter One' }]);
  assert.deepEqual(fix('<p>Text.</p>', ['Text.'], ['Text!']).renames, []);
  // Entries for that section at any depth, and the section titles from it on while they read as the old title.
  const manifest = {
    toc: [{ title: 'Chaptr One', section: 1, id: 'c', children: [{ title: 'Chaptr  One', section: 1, id: 'd' }] }, { title: 'Chaptr One', section: 4, id: null }],
    sections: [{ title: 'Chaptr One' }, { title: 'Chaptr One' }, { title: 'Chaptr One' }, { title: 'Two' }, { title: 'Chaptr One' }],
  };
  renameTitles(manifest, 1, [{ from: 'Chaptr One', to: 'Chapter One' }]);
  assert.deepEqual(manifest.toc.map((t) => t.title), ['Chapter One', 'Chaptr One']);
  assert.equal(manifest.toc[0].children[0].title, 'Chapter One');
  assert.deepEqual(manifest.sections.map((s) => s.title), ['Chaptr One', 'Chapter One', 'Chapter One', 'Two', 'Chaptr One']);
});

test('places are counted as the reader counts them, and move with the text', () => {
  const html = '<h1>Ab</h1>\n<p>C<img data-src="x" />d<span class="pg" id="pg1"></span>e</p><pre>\nfg</pre>';
  assert.equal(positionText(parseSection(html).children), 'Ab\nC\uFFFCdefg');
  // "hello wrold, goodbye" -> "hello world, goodbye": places after the change move, those in it go to its start.
  const shift = positionShift('hello wrold, goodbye', 'hello world, goodbye');
  assert.deepEqual(shift, { start: 7, end: 9, delta: 0 });
  const grow = positionShift('one two three', 'one two and three');
  assert.deepEqual(grow, { start: 8, end: 8, delta: 4 });
  assert.equal(shiftOffset(3, grow), 3);
  assert.equal(shiftOffset(8, grow), 12);
  assert.equal(shiftOffset(10, grow), 14);
  const cut = positionShift('one two six', 'one six');
  assert.deepEqual(cut, { start: 4, end: 8, delta: -4 });
  assert.equal(shiftOffset(4, cut), 4);
  assert.equal(shiftOffset(6, cut), 4);
  assert.equal(shiftOffset(8, cut), 4);
  assert.equal(shiftOffset(10, cut), 6);
  assert.equal(shiftOffset(0, positionShift('ab', '')), 0);
});

test('a stored fix is found among repeated paragraphs by the paragraphs around it, then by its place', () => {
  const sections = [
    { section: 0, texts: ['Intro.', 'Yes.', 'Middle.', 'Yes.', 'End.'] },
    { section: 1, texts: ['Other.', 'Yes.', 'Middle.'] },
  ];
  const stored = { before: ['Yes.'], contextBefore: 'Middle.', contextAfter: 'End.', section: 1, paragraph: 1 };
  assert.deepEqual(findRun(sections, stored), { section: 0, index: 3 });
  // With nothing around it to tell them apart, the same section wins, then the nearest number.
  assert.deepEqual(findRun(sections, { ...stored, contextBefore: '', contextAfter: '' }), { section: 1, index: 1 });
  assert.deepEqual(findRun(sections, { ...stored, contextBefore: '', contextAfter: '', section: 0, paragraph: 4 }), { section: 0, index: 3 });
  assert.equal(findRun(sections, { ...stored, before: ['No.'] }), null);
});

test('a fix is checked before it is made', () => {
  const ok = parseFixInput({ section: 0, paragraph: 2, before: [' Tbe  end. '], after: ['The\nend.', '', '\u0007 '] });
  assert.deepEqual(ok, { section: 0, paragraph: 2, before: ['Tbe end.'], after: ['The end.'] });
  assert.equal(parseFixInput({ section: 0, paragraph: 0, before: ['A b.'], after: ['A  b.', ''] }).error, 'Nothing has changed');
  assert.deepEqual(parseFixInput({ section: 0, paragraph: 0, before: ['Gone.'], after: [] }).after, []);
  for (const body of [null, { section: -1, paragraph: 0, before: ['a'], after: [] }, { section: 0, paragraph: 0, before: [], after: [] },
    { section: 0, paragraph: 0, before: ['a'], after: 'b' }, { section: 0, paragraph: 0, before: [1], after: [] }, { section: 0, paragraph: 0, before: ['  '], after: ['b'] }]) {
    assert.ok(parseFixInput(body).error, JSON.stringify(body));
  }
  assert.equal(parseFixInput({ section: 0, paragraph: 0, before: ['a'], after: ['x'.repeat(200001)] }).error, 'That is too much text to fix at once');
  assert.equal(parseFixInput({ section: 0, paragraph: 0, before: new Array(21).fill('a'), after: [] }).error, 'That is too much text to fix at once');
  assert.equal(parseFixInput({ section: 0, paragraph: 0, before: ['a'], after: new Array(41).fill('b') }).error, 'That is too much text to fix at once');
});

test('a very long change is taken as one block between what stays the same', () => {
  const before = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(' ');
  const after = Array.from({ length: 1500 }, (_, i) => `v${i}`).join(' ');
  const changes = diffText(`Keep ${before} end`, `Keep ${after} end`);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].start, 5);
  const { html } = fix(`<p>Keep ${before} end</p>`, [`Keep ${before} end`], [`Keep ${after} end`]);
  assert.equal(html, `<p>Keep ${after} end</p>`);
});
