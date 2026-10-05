// Readers' places when a book is converted again. A place is a section and an offset in it, counted the
// way the reader counts (positionText in fixes.js). New converters may cut the text into other sections, or
// read it a little differently, so each place and bookmark is found again by its words: where the text
// before or after every change is the same, a place moves with it; among the changes, the text at the place
// is looked for in the new book. See processing/queue.js, which moves them in the transaction that saves the book.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseSection, positionShift, positionText, shiftOffset } from './fixes.js';

// How much of the old text at a place is looked for in the new text: 64 characters, then fewer, until found.
const LOOK_FOR = [64, 32, 16, 8];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * A converted book in `dir` as the reader counts places in it: one string per section (see positionText),
 * in the order of its book.json. Null when it has no book.json or no sections, or a section file is missing,
 * as before its first conversion.
 */
export async function readPlaceTexts(dir) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'book.json'), 'utf8'));
    if (!Array.isArray(manifest?.sections) || !manifest.sections.length) return null;
    const texts = [];
    for (let i = 0; i < manifest.sections.length; i++) {
      const html = await fsp.readFile(path.join(dir, 'sections', `${i}.html`), 'utf8');
      texts.push(positionText(parseSection(html).children));
    }
    return texts;
  } catch {
    return null;
  }
}

// Where each section starts in the whole text.
function startsOf(texts) {
  let at = 0;
  return texts.map((t) => {
    const start = at;
    at += t.length;
    return start;
  });
}

// The occurrence of `part` in `text` nearest to `target`, or -1.
function nearest(text, part, target) {
  let best = -1;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) {
    if (best < 0 || Math.abs(at - target) < Math.abs(best - target)) best = at;
    if (at > target) break; // the ones after are further away
  }
  return best;
}

/**
 * How places move from the sections `before` to the sections `after` of a book, both from positionText.
 * Returns a function from a stored place (section, offset) to { section, offset } in the new sections.
 *
 * A section out of range is taken as the nearest one, an offset as the nearest in its section. Where the
 * whole text is the same, a place keeps its place in it, whatever the sections. Else a place before the
 * first difference or after the last moves with the text (see positionShift); one between them is found by
 * the text after it (or before it), the occurrence nearest to its place in proportion, else goes to that place
 * in proportion. A place where one section ends and the next begins is the start of the next one with text,
 * and the very end of the book is the end of its last section.
 */
export function placeMover(before, after) {
  const oldStarts = startsOf(before);
  const newStarts = startsOf(after);
  const oldText = before.join('');
  const newText = after.join('');
  const shift = positionShift(oldText, newText);

  // A place in the whole old text, in the whole new text.
  const moveInText = (a) => {
    if (oldText === newText) return a;
    if (a <= shift.start || a >= shift.end) return shiftOffset(a, shift);
    const guess = (a * newText.length) / oldText.length;
    for (const n of LOOK_FOR) {
      if (a + n <= oldText.length) {
        const at = nearest(newText, oldText.slice(a, a + n), guess);
        if (at >= 0) return at;
      }
      if (a >= n) {
        const at = nearest(newText, oldText.slice(a - n, a), guess - n);
        if (at >= 0) return at + n;
      }
    }
    return clamp(Math.round(guess), 0, newText.length);
  };

  // The section holding a place in the whole new text, and the offset in it.
  const placeIn = (x) => {
    const last = after.length - 1;
    for (let i = 0; i < last; i++) if (x < newStarts[i] + after[i].length) return { section: i, offset: x - newStarts[i] };
    return { section: last, offset: clamp(x - newStarts[last], 0, after[last].length) };
  };

  return (section, offset) => {
    const s = clamp(Number.isInteger(section) ? section : 0, 0, before.length - 1);
    const a = oldStarts[s] + clamp(Number.isInteger(offset) ? offset : 0, 0, before[s].length);
    return placeIn(moveInText(a));
  };
}

/**
 * The place at `percent` (0 to 1) of a book, from its book.json, the way the reader finds it
 * (positionFromPercent in public/js/reader.js): the last section that starts at or before it, and the
 * characters into that section, rounded so the percent of a place gives that place back. Null when the
 * manifest has no sections or the percent is not a number.
 */
export function placeAtPercent(manifest, percent) {
  const sections = manifest?.sections;
  if (!Array.isArray(sections) || !sections.length || !Number.isFinite(manifest.totalChars) || !Number.isFinite(percent)) return null;
  const target = clamp(percent, 0, 1) * manifest.totalChars;
  let section = 0;
  sections.forEach((s, i) => { if (s.start <= target) section = i; });
  return { section, offset: Math.max(0, Math.round(target - (sections[section].start || 0))) };
}
