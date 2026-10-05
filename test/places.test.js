import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { placeMover, placeAtPercent, readPlaceTexts } from '../server/places.js';

// A place in the whole text of a book's sections.
const absolute = (texts, { section, offset }) => texts.slice(0, section).join('').length + offset;
// The text at a place, as far as `n` characters.
const textAt = (texts, place, n = 12) => texts.join('').slice(absolute(texts, place), absolute(texts, place) + n);
const placeOf = (texts, words) => {
  for (let section = 0; section < texts.length; section++) {
    const offset = texts[section].indexOf(words);
    if (offset >= 0) return { section, offset };
  }
  throw new Error(`"${words}" is not in the book`);
};

test('the same text cut into other sections keeps every place at the same words', () => {
  const before = ['Chapter One. The king rode out. ', 'He came to a river. It was wide. ', 'Chapter Two. The queen waited.'];
  const after = [before[0], before[1] + before[2]];
  const move = placeMover(before, after);
  for (let section = 0; section < before.length; section++) {
    for (let offset = 0; offset <= before[section].length; offset++) {
      const to = move(section, offset);
      assert.equal(absolute(after, to), absolute(before, { section, offset }), `${section}:${offset}`);
      // A place is in the section that holds its text, never at the end of the one before.
      if (absolute(after, to) < after.join('').length) assert.ok(to.offset < after[to.section].length, `${section}:${offset}`);
    }
  }
  assert.deepEqual(move(1, 3), { section: 1, offset: 3 });
  assert.deepEqual(move(2, 0), { section: 1, offset: before[1].length });
  assert.deepEqual(move(2, 13), { section: 1, offset: before[1].length + 13 });
  assert.equal(textAt(after, move(2, 13)), 'The queen wa');

  // And the other way: two sections cut as three.
  const back = placeMover(after, before);
  assert.deepEqual(back(1, before[1].length + 13), { section: 2, offset: 13 });
  assert.deepEqual(back(1, 5), { section: 1, offset: 5 });
});

test('a place moves with the text when text changes before or after it', () => {
  const before = ['Chapter One. Tbe king rode out. ', 'He came to a river at night. ', 'Chapter Two. Tbe queen waited.'];
  const after = ['Chapter One. The old king rode out. ', 'He came to a river at night. Chapter Two. The queen waited.'];
  const move = placeMover(before, after);
  // After the first change and before the last one, the text is found by the words at the place.
  const river = placeOf(before, 'river');
  assert.deepEqual(move(river.section, river.offset), placeOf(after, 'river'));
  // Before the first change, nothing moves; after the last, it moves by what the changes added.
  assert.deepEqual(move(0, 8), { section: 0, offset: 8 });
  const waited = placeOf(before, 'waited');
  assert.deepEqual(move(waited.section, waited.offset), placeOf(after, 'waited'));
});

test('a place among changes is found by the text after it, or before it, nearest to its place in proportion', () => {
  const middle = 'and he rode on through the wood until the light was gone, and the road was long and dark. ';
  const tail = 'The night came on, and the stars came out one by one over the hills and the sleeping town.';
  const before = [`Tbe king. ${middle}`, `Tbe end came. ${tail}`];
  const after = [`The king. ${middle}Tbe end came. `, tail];
  // Only the first "Tbe" changed, so the places after it move with the text.
  const move = placeMover(before, after);
  const stars = placeOf(before, 'stars');
  assert.deepEqual(move(stars.section, stars.offset), placeOf(after, 'stars'));

  // Both changed: places between them are found by their words.
  const fixed = [`The king. ${middle}`, `The end came. ${tail}`];
  const both = placeMover(before, fixed);
  for (const words of ['and he rode', 'the light', 'dark. ']) {
    const at = placeOf(before, words);
    assert.deepEqual(both(at.section, at.offset), placeOf(fixed, words), words);
  }
  // Right before a change, the text after the place is not there as it was, but the text before it is.
  const end = placeOf(before, 'end came');
  assert.deepEqual(both(end.section, end.offset - 4), placeOf(fixed, 'The end'));
  // On a changed letter, the text before it finds where it is.
  assert.deepEqual(both(1, 1), { section: 1, offset: 1 });

  // The same words more than once: the one nearest to the place in proportion.
  const line = 'The bells rang out across the water while the ferry crossed in the rain. ';
  const old = [`${line}A. ${line}B. ${line}`];
  const now = [`${line}AA. `, `${line}BB. ${line}`];
  const again = placeMover(old, now);
  assert.deepEqual(again(0, line.length + 3), { section: 1, offset: 0 });
  assert.deepEqual(again(0, line.length + 3 + 10), { section: 1, offset: 10 });

  // Text not found at all goes to its place in proportion.
  const gone = placeMover(['aaaa bbbb cccc dddd eeee'], ['aaaa xxxxxxxxxxxxxxxxxxxx eeee']);
  assert.deepEqual(gone(0, 12), { section: 0, offset: 15 });
});

test('a place on a section boundary, at the very end, or out of range', () => {
  const texts = ['abc', '', 'def'];
  const same = placeMover(texts, texts);
  // The end of a section is the start of the next one with text.
  assert.deepEqual(same(0, 3), { section: 2, offset: 0 });
  assert.deepEqual(same(1, 0), { section: 2, offset: 0 });
  assert.deepEqual(same(0, 2), { section: 0, offset: 2 });
  // The very end is the end of the last section.
  assert.deepEqual(same(2, 3), { section: 2, offset: 3 });
  assert.deepEqual(placeMover(['abc', 'def'], ['abcdef', ''])(1, 3), { section: 1, offset: 0 });
  assert.deepEqual(placeMover(['abc', 'def'], ['abcdef'])(1, 3), { section: 0, offset: 6 });
  // A section out of range is the nearest one, and an offset the nearest in its section.
  assert.deepEqual(same(9, 1), { section: 2, offset: 1 });
  assert.deepEqual(same(-1, 1), { section: 0, offset: 1 });
  assert.deepEqual(same(0, 99), { section: 2, offset: 0 });
  assert.deepEqual(same(2, 99), { section: 2, offset: 3 });
  assert.deepEqual(same(2, -5), { section: 2, offset: 0 });
  assert.deepEqual(same(null, undefined), { section: 0, offset: 0 });
});

test('a place by its percent is found the way the reader finds it', () => {
  const manifest = { totalChars: 100, sections: [{ start: 0, chars: 40 }, { start: 40, chars: 0 }, { start: 40, chars: 60 }] };
  assert.deepEqual(placeAtPercent(manifest, 0), { section: 0, offset: 0 });
  assert.deepEqual(placeAtPercent(manifest, 0.25), { section: 0, offset: 25 });
  assert.deepEqual(placeAtPercent(manifest, 0.4), { section: 2, offset: 0 });
  assert.deepEqual(placeAtPercent(manifest, 0.5), { section: 2, offset: 10 });
  assert.deepEqual(placeAtPercent(manifest, 1), { section: 2, offset: 60 });
  assert.deepEqual(placeAtPercent(manifest, 7), { section: 2, offset: 60 });
  // Rounded, not cut off: a percent the reader worked out from a place gives that place back.
  assert.deepEqual(placeAtPercent({ totalChars: 3, sections: [{ start: 0, chars: 3 }] }, (1 / 3) * (1 - 1e-12)), { section: 0, offset: 1 });
  assert.equal(placeAtPercent({ totalChars: 0, sections: [] }, 0.5), null);
  assert.equal(placeAtPercent(null, 0.5), null);
  assert.equal(placeAtPercent(manifest, undefined), null);
});

test('a converted book is read as the reader counts places, and not at all when a file is missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-places-'));
  try {
    assert.equal(await readPlaceTexts(dir), null);
    fs.mkdirSync(path.join(dir, 'sections'));
    fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ sections: [{ chars: 3 }, { chars: 5 }] }));
    fs.writeFileSync(path.join(dir, 'sections', '0.html'), '<h1>One</h1>');
    assert.equal(await readPlaceTexts(dir), null);
    fs.writeFileSync(path.join(dir, 'sections', '1.html'), '<p>Two <img data-src="x.png" /> &amp; more</p>');
    assert.deepEqual(await readPlaceTexts(dir), ['One', 'Two \uFFFC & more']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
