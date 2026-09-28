import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorKey, authorNames, authorOrder, genreKey, mostCommon, sections, surname } from '../public/js/groups.js';

test('an author line names each author once, surname first or not', () => {
  const cases = [
    ['Terry Pratchett, Neil Gaiman', ['Terry Pratchett', 'Neil Gaiman']],
    ['Brandon Sanderson & Janci Patterson', ['Brandon Sanderson', 'Janci Patterson']],
    ['Douglas Preston and Lincoln Child', ['Douglas Preston', 'Lincoln Child']],
    ['Sanderson, Brandon & Patterson, Janci', ['Sanderson, Brandon', 'Patterson, Janci']],
    ['Brandon Sanderson, Dan Wells, Mary Robinette Kowal', ['Brandon Sanderson', 'Dan Wells', 'Mary Robinette Kowal']],
    ['Plato; Aristotle', ['Plato', 'Aristotle']],
    // One author, surname first: the part after the comma is not a name of its own.
    ['Herbert, Frank', ['Herbert, Frank']],
    ['Tolkien, J.R.R.', ['Tolkien, J.R.R.']],
    ['Le Guin, Ursula K.', ['Le Guin, Ursula K.']],
    // "&" between given names is one name for two people.
    ['Ilona & Gordon Andrews', ['Ilona & Gordon Andrews']],
    ['J. R. R.  Tolkien', ['J. R. R. Tolkien']],
    ['Neil Gaiman, NEIL GAIMAN', ['Neil Gaiman']],
    ['', []],
    [null, []],
  ];
  for (const [line, names] of cases) assert.deepEqual(authorNames(line), names, line);
});

test('authors are the same however their names are written, and sorted by surname', () => {
  assert.equal(authorKey('Herbert, Frank'), authorKey('Frank Herbert'));
  assert.equal(authorKey('J.R.R. Tolkien'), authorKey('J. R. R. Tolkien'));
  assert.equal(authorKey('Jussi Adler-Olsen'), authorKey('jussi adler olsen'));
  assert.equal(authorKey('Gabriel García Márquez'), authorKey('Gabriel Garcia Marquez'));
  assert.notEqual(authorKey('Frank Herbert'), authorKey('Brian Herbert'));

  assert.equal(surname('Frank Herbert'), 'Herbert');
  assert.equal(surname('Herbert, Frank'), 'Herbert');
  assert.equal(surname('Le Guin, Ursula K.'), 'Le Guin');
  assert.equal(surname('Martin Luther King Jr.'), 'King');
  assert.equal(surname('Martin Luther King, Jr.'), 'King');
  assert.equal(surname('Plato'), 'Plato');

  const lines = ['Neil Gaiman, Terry Pratchett', 'Isaac Asimov', 'Herbert, Frank', 'Brandon Sanderson'];
  assert.deepEqual(lines.sort((a, b) => authorOrder(a).localeCompare(authorOrder(b))),
    ['Isaac Asimov', 'Neil Gaiman, Terry Pratchett', 'Herbert, Frank', 'Brandon Sanderson']);
  assert.equal(authorOrder(''), '');
});

test('the name most share, spelled as most spell it', () => {
  assert.equal(mostCommon(['Robert Jordan', 'Robert Jordan', 'Brandon Sanderson', 'Jordan, Robert'], authorKey), 'Robert Jordan');
  assert.equal(mostCommon(['Herbert, Frank', 'Frank Herbert'], authorKey), 'Frank Herbert', 'a tie goes to the name without a comma');
  assert.equal(mostCommon(['', 'fantasy', 'Fantasy', 'Fantasy', 'Crime'], genreKey), 'Fantasy');
  assert.equal(mostCommon(['Crime', 'Fantasy'], genreKey), 'Crime', 'a tie goes to the first');
  assert.equal(mostCommon(['', null], genreKey), '');
});

test('sections by author: a book under each of its authors, in order of surname, the books without one last', () => {
  const books = [
    { title: 'Good Omens', author: 'Terry Pratchett, Neil Gaiman' },
    { title: 'Mort', author: 'Terry Pratchett' },
    { title: 'Notes', author: '' },
    { title: 'Coraline', author: 'Gaiman, Neil' },
    { title: 'Dune', author: 'Frank Herbert' },
  ];
  const out = sections(books, (b) => authorNames(b.author), 'author');
  assert.deepEqual(out.map((s) => [s.name, s.items.map((b) => b.title)]), [
    ['Neil Gaiman', ['Good Omens', 'Coraline']],
    ['Frank Herbert', ['Dune']],
    ['Terry Pratchett', ['Good Omens', 'Mort']],
    ['', ['Notes']],
  ]);
});

test('sections by genre: alphabetical, spelled as most books spell it, the books without one last', () => {
  const books = [{ genre: 'fantasy' }, { genre: '' }, { genre: 'Fantasy' }, { genre: 'Crime' }, { genre: 'Fantasy' }, {}];
  const out = sections(books, (b) => [b.genre], 'genre');
  assert.deepEqual(out.map((s) => [s.name, s.items.length]), [['Crime', 1], ['Fantasy', 3], ['', 2]]);
  assert.deepEqual(sections([], (b) => [b.genre], 'genre'), []);
});
