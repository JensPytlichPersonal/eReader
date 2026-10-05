import { api, ApiError, requireUser, escapeHtml, formatDate, toast, registerServiceWorker } from './api.js';
import { loadSettings, applyTheme, adoptAccountFont } from './settings.js';
import { gaps, inOrder, missingBooks } from './missing.js';
import { authorKey, authorNames, authorOrder, genreKey, mostCommon, sections } from './groups.js';

registerServiceWorker();
applyTheme(loadSettings());
// A theme that follows the device changes with it.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(loadSettings()));

const els = {
  library: document.getElementById('library'),
  tabs: document.getElementById('tabs'),
  search: document.getElementById('search'),
  filter: document.getElementById('filter'),
  sort: document.getElementById('sort'),
  group: document.getElementById('group'),
  layout: document.getElementById('layout'),
  display: document.getElementById('display'),
  select: document.getElementById('btn-select'),
  selectBar: document.getElementById('select-bar'),
  menu: document.getElementById('btn-menu'),
  sectionName: document.getElementById('section-name'),
  activeFilters: document.getElementById('active-filters'),
  offlineNote: document.getElementById('offline-note'),
  upload: document.getElementById('btn-upload'),
  uploadFolder: document.getElementById('btn-upload-folder'),
  file: document.getElementById('file-input'),
  folderInput: document.getElementById('folder-input'),
  drop: document.getElementById('dropzone'),
  uploads: document.getElementById('uploads'),
  dialogRoot: document.getElementById('dialog-root'),
};
let me = null;
let books = [];
// The numbers at which an admin removed a book a series lacks, by series id: no outline shows there (see missing.js).
let removedMissing = {};
let offline = false; // no connection: showing the books from the last time, with `kept` the ones this device can open
let kept = new Set();
let pollTimer = null;
let coverEditor = null; // a book's menu, open for someone who can change the book: it takes images pasted or dropped on the page as the cover
const prefs = JSON.parse(localStorage.getItem('ereader.library') || '{}');
els.sort.value = prefs.sort || 'recent';
els.filter.value = prefs.filter || 'all';
// The library shows every book, or books grouped into their series and collections.
let view = prefs.view === 'series' ? 'series' : 'books';
// How the Books tab shows a series: folded into a stack, as a shelf with every title, or as separate books.
let layout = ['stacks', 'shelves', 'every'].includes(prefs.layout) ? prefs.layout : 'stacks';
els.layout.value = layout;
// The View menu: a list, or cards in three sizes (2, 3 or 4 across on a phone).
let display = ['list', 'cards-2', 'cards-3', 'cards-4'].includes(prefs.display) ? prefs.display : 'cards-3';
els.display.value = display;
// The Group by menu: every book together, or in sections by author or by genre.
let groupBy = ['author', 'genre'].includes(prefs.group) ? prefs.group : 'none';
els.group.value = groupBy;
// Choosing books to change together, such as to give them a genre: the ids of the books chosen.
let selecting = false;
const selected = new Set();

function savePrefs() { localStorage.setItem('ereader.library', JSON.stringify({ sort: els.sort.value, filter: els.filter.value, view, layout, display, group: groupBy })); }

// On a phone the card sizes are columns across the screen; wider screens fit more cards of each size.
const phone = matchMedia('(max-width: 599px)');
function labelViews() {
  const names = phone.matches ? ['Cards, 2 across', 'Cards, 3 across', 'Cards, 4 across'] : ['Large cards', 'Cards', 'Small cards'];
  ['cards-2', 'cards-3', 'cards-4'].forEach((value, i) => { els.display.querySelector(`option[value="${value}"]`).textContent = names[i]; });
}
labelViews();
phone.addEventListener?.('change', labelViews);

// Books and series in the chosen view: a grid of cards, or a list.
const tiles = (html) => `<div class="${display === 'list' ? 'list' : 'grid'}">${html}</div>`;

// The books as the library last loaded them, for opening it without a connection.
const SAVED = 'ereader.library-books';

// While books are being prepared the library asks for them every few seconds (a "quiet" load). It is only drawn
// again when something changed, and a book that became ready has its own card swapped, so the others do not
// move while the rest of the batch is still being prepared. `settled` is false until the whole library is
// drawn again from the latest books.
let shownBooks = '';
let settled = true;

async function load({ quiet = false } = {}) {
  loadedAt = Date.now();
  let data;
  try {
    data = await api('/api/books');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return showOffline();
  }
  const wasOffline = offline;
  offline = false;
  const before = books;
  books = data.books;
  removedMissing = data.removedMissing || {};
  supported = new Set(data.supported);
  const ids = new Set(books.map((b) => b.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id); // deleted meanwhile
  try { if (me) localStorage.setItem(SAVED, JSON.stringify({ me, books, removedMissing })); } catch { /* storage full */ }
  const processing = books.some((b) => b.status === 'processing');
  const fresh = JSON.stringify([books, removedMissing]);
  if (!quiet || wasOffline) render();
  else if (fresh !== shownBooks && !(processing && swapReady(before))) render();
  else if (!processing && !settled) render();
  shownBooks = fresh;
  restoreFirst();
  clearTimeout(pollTimer);
  if (processing) pollTimer = setTimeout(() => load({ quiet: true }), 3000);
}

/**
 * Swaps the cards of books that became ready since `before` for their new ones, in place, and says whether
 * that was all that changed. Anything else, such as a book added or removed, or one that is not on the
 * page as a card of its own (on a shelf, say), needs the library drawn again.
 */
function swapReady(before) {
  if (offline || before.length !== books.length) return false;
  const old = new Map(before.map((b) => [b.id, b]));
  const changed = books.filter((b) => JSON.stringify(b) !== JSON.stringify(old.get(b.id)));
  if (changed.some((b) => old.get(b.id)?.status !== 'processing')) return false;
  const found = changed.map((b) => [b, [...els.library.querySelectorAll(`[data-id="${b.id}"]`)]]);
  if (found.some(([, places]) => !places.length)) return false;
  const seriesId = openSeriesId();
  const tpl = document.createElement('template');
  for (const [b, places] of found) {
    const inSeries = seriesId != null && b.series.find((s) => s.id === seriesId);
    tpl.innerHTML = card(b, inSeries ? { seriesId, position: numberIn(inSeries) } : {}).trim();
    for (const el of places) el.replaceWith(tpl.content.firstElementChild.cloneNode(true));
  }
  settled = false;
  return true;
}

/**
 * Without a connection: the books from the last time the library loaded. The ones this device keeps (every book
 * opened here, see keepOffline in reader.js) can be read; the others are faded.
 */
async function showOffline() {
  if (!me) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SAVED)); } catch { /* none */ }
    if (!saved?.me) {
      els.library.innerHTML = '<div class="empty"><p>No connection.</p><p>Once this device has opened the library online, it shows here offline too.</p></div>';
      return;
    }
    ({ me, books } = saved);
    removedMissing = saved.removedMissing || {};
  }
  const here = 'caches' in window ? await Promise.all(books.map((b) => caches.match(`/books/${b.id}/book.json`).then((hit) => hit && b.id, () => null))) : [];
  kept = new Set(here.filter(Boolean));
  offline = true;
  render();
  restoreFirst();
}
const faded = (b) => offline && !kept.has(b.id);

function status(b) {
  if (b.status !== 'ready') return b.status;
  if (!b.progress) return 'unread';
  if (b.progress.percent >= 0.98) return 'finished';
  return 'reading';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// A book's number in a series: "3", or a range such as "1–3" for a book holding several (an omnibus). null for none.
const numberIn = (s) => (s.position == null ? null : s.positionEnd != null ? `${s.position}–${s.positionEnd}` : String(s.position));
const seriesLabel = (s) => (s.position != null ? `${s.name} #${numberIn(s)}` : s.name);
const seriesLink = (s) => `<a href="/?series=${s.id}" data-series="${s.id}">${escapeHtml(seriesLabel(s))}</a>`;

// Books and series sort alike: a series by its most recently read and newest book, its name and lead author.
// Authors go by surname (see authorOrder() in groups.js).
const sortKeys = (x) => (x.items
  ? { read: x.lastRead, added: x.lastAdded, title: x.name, author: authorOrder(x.lead) }
  : { read: x.progress?.updatedAt || 0, added: x.addedAt, title: x.title, author: authorOrder(x.author) });

function sorter() {
  const by = {
    recent: (a, b) => b.read - a.read || b.added - a.added,
    added: (a, b) => b.added - a.added,
    title: (a, b) => a.title.localeCompare(b.title),
    // Books without an author last.
    author: (a, b) => !a.author - !b.author || a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
  }[els.sort.value];
  return (a, b) => by(sortKeys(a), sortKeys(b));
}

const matchesSearch = (b, q) => `${b.title} ${b.author} ${b.series.map((s) => s.name).join(' ')} ${b.genre || ''}`.toLowerCase().includes(q);
// Books that look like another book in the library (see duplicates.js on the server).
const flagged = (b) => b.duplicates?.length > 0;

function visible() {
  const q = els.search.value.trim().toLowerCase();
  const f = els.filter.value;
  let list = books.filter((b) => {
    if (q && !matchesSearch(b, q)) return false;
    if (f === 'reading') return status(b) === 'reading';
    if (f === 'unread') return status(b) === 'unread';
    if (f === 'finished') return status(b) === 'finished';
    if (f === 'duplicates') return flagged(b);
    return true;
  });
  return list.sort(sorter());
}

// Converting a book again rewrites its own cover, but leaves one picked by hand in place.
const coverSrc = (b) => (b.hasCover && (b.status === 'ready' || b.coverSource === 'custom') ? `/books/${b.id}/cover?v=${b.coverVersion}` : null);
// A book's cover, or the picture at `src` in its place (a book's menu shows one not saved yet); without one, a tile with its title and author.
const coverHtml = (b, src = coverSrc(b)) => (src
  ? `<img class="cover" loading="lazy" alt="" src="${escapeHtml(src)}">`
  : `<div class="cover placeholder"><div class="t">${escapeHtml(b.title)}</div><div class="a">${escapeHtml(b.author)}</div></div>`);

// A book that looks like another in the library says so, and the flag opens them side by side.
const dupFlag = (b) => (flagged(b) ? `<button type="button" class="dup-flag" data-dups="${b.id}">Possible duplicate</button>` : '');

// ---- choosing books (Select) ----

/** Whether all, some or none of these books are chosen, as aria-pressed says it: 'true', 'mixed' or 'false'. */
function chosen(ids) {
  const n = ids.filter((id) => selected.has(id)).length;
  return n && n === ids.length ? 'true' : n ? 'mixed' : 'false';
}
const CHOSEN = { true: ' selected', mixed: ' part-selected', false: '' };
/** The class of a card or row while choosing books: chosen, or with some of its books chosen (a series). */
const chosenClass = (ids) => (selecting ? CHOSEN[chosen(ids)] : '');
const TICK = '<span class="check" aria-hidden="true"></span>';

/** What covers a book's card, row or place on a shelf: a link that opens it, or while choosing books, a button that chooses it. */
function opener(b) {
  if (selecting) return `<button type="button" class="link pick" data-pick="${b.id}" aria-pressed="${selected.has(b.id)}" aria-label="${escapeHtml(b.title)}"></button>${TICK}`;
  return b.status === 'ready' ? `<a class="link" href="/read/${b.id}" aria-label="Read ${escapeHtml(b.title)}"></a>` : '';
}

/** While choosing books, a button in a heading that chooses every book under it, or leaves them all when they are chosen (see showSelection()). */
const pickAll = () => (selecting ? '<button type="button" class="btn small" data-pick-section>Select all</button>' : '');

/**
 * What covers a series or collection shown as one: a link that opens it, or while choosing books, a
 * button that chooses all its books. Its tick goes where there is room for it (see stackCard()).
 */
function seriesOpener(g, label) {
  if (!selecting) return `<a class="link" href="/?series=${g.id}" data-series="${g.id}" aria-label="${escapeHtml(label)}"></a>`;
  return `<button type="button" class="link pick" data-pick-series="${g.id}" aria-pressed="${chosen(g.items.map((i) => i.book.id))}" aria-label="${escapeHtml(label)}"></button>`;
}

/** A book card. In a series view (`ctx.seriesId`) the cover shows the book's number in that series (`ctx.position`, as numberIn() gives it). */
function card(b, ctx = {}) {
  if (display === 'list') return bookRow(b, ctx);
  const pct = b.progress ? Math.round(b.progress.percent * 100) : 0;
  const cover = coverHtml(b);
  const number = ctx.position != null ? `<span class="cover-tag">#${ctx.position}</span>` : '';
  const st = b.status === 'processing' ? '<div class="status">Preparing…</div>' : b.status === 'error' ? `<div class="status err" title="${escapeHtml(b.error || '')}">Could not convert</div>` : '';
  const link = opener(b);
  const others = b.series.filter((s) => s.id !== ctx.seriesId);
  const seriesHtml = others.length ? `<div class="series-line">${others.map(seriesLink).join(', ')}</div>` : '';
  const progressHtml = b.progress ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : '';
  const when = b.progress ? `Read ${formatDate(b.progress.updatedAt)}` : `Added ${formatDate(b.addedAt)}`;
  return `<div class="card${faded(b) ? ' unavailable' : ''}${chosenClass([b.id])}" data-id="${b.id}">
    ${cover}${number}${st}${link}
    <div class="info">
      <div class="title">${escapeHtml(b.title)}</div>
      <div class="author">${escapeHtml(b.author || '')}</div>
      ${seriesHtml}
      ${dupFlag(b)}
      ${progressHtml}
      <div class="meta"><span>${b.progress ? `${pct}%` : ''} ${when}</span><span class="badge">${b.format}</span></div>
    </div>
    <button class="menu-btn" aria-label="Options for ${escapeHtml(b.title)}" data-menu="${b.id}">&#8943;</button>
  </div>`;
}

/** A book as a row of the list view. In a series (`ctx.position`) the title starts with its number. */
function bookRow(b, ctx = {}) {
  const pct = b.progress ? Math.round(b.progress.percent * 100) : 0;
  const about = [escapeHtml(b.author || ''), ...b.series.filter((s) => s.id !== ctx.seriesId).map(seriesLink)].filter(Boolean).join(' · ');
  const state = b.status === 'processing' ? 'Preparing…' : b.status === 'error' ? 'Could not convert'
    : b.progress ? `${pct}% · Read ${formatDate(b.progress.updatedAt)}` : `Added ${formatDate(b.addedAt)}`;
  return `<div class="list-row${ctx.current ? ' current' : ''}${faded(b) ? ' unavailable' : ''}${chosenClass([b.id])}" data-id="${b.id}">
    <div class="thumb">${coverHtml(b)}</div>
    ${opener(b)}
    <div class="body">
      <div class="title">${ctx.position != null ? `<span class="no">#${ctx.position}</span> ` : ''}${escapeHtml(b.title)}</div>
      ${about ? `<div class="about">${about}</div>` : ''}
      <div class="meta">${b.progress ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}<span>${state}</span><span class="badge">${b.format}</span>${dupFlag(b)}</div>
    </div>
    <button class="menu-btn" aria-label="Options for ${escapeHtml(b.title)}" data-menu="${b.id}">&#8943;</button>
  </div>`;
}

// ---- series and collections ----

/** The author most books in a group share; "and others" when they differ. */
function mainAuthor(authors) {
  const counts = new Map();
  for (const a of authors) if (a) counts.set(a, (counts.get(a) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return counts.size > 1 ? `${top} and others` : top;
}

/** Books grouped by series and collection, each group's books in series order. */
function groupSeries() {
  const groups = new Map();
  for (const b of books) {
    for (const s of b.series) {
      if (!groups.has(s.id)) groups.set(s.id, { id: s.id, name: s.name, items: [] });
      groups.get(s.id).items.push({ book: b, position: s.position, positionEnd: s.positionEnd });
    }
  }
  for (const g of groups.values()) {
    // A book holding several, such as an omnibus, comes after the books it holds and before the next:
    // #1, #2, #3, #1–3, #4.
    const last = (i) => i.positionEnd ?? i.position ?? Infinity;
    g.items.sort((x, y) => last(x) - last(y) || (y.position ?? 0) - (x.position ?? 0) || x.book.title.localeCompare(y.book.title));
    const states = g.items.map((i) => status(i.book));
    g.numbered = g.items.some((i) => i.position != null);
    g.finished = states.filter((st) => st === 'finished').length;
    g.state = g.finished === states.length ? 'finished' : states.some((st) => st === 'reading' || st === 'finished') ? 'reading' : 'unread';
    g.lastRead = Math.max(0, ...g.items.map((i) => i.book.progress?.updatedAt || 0));
    g.lastAdded = Math.max(...g.items.map((i) => i.book.addedAt));
    g.author = mainAuthor(g.items.map((i) => i.book.author));
    // The author and genre the series goes under when the library is grouped by them.
    g.lead = mostCommon(g.items.flatMap((i) => authorNames(i.book.author)), authorKey);
    g.genre = mostCommon(g.items.map((i) => i.book.genre), genreKey);
  }
  return [...groups.values()];
}

/**
 * Where you are in a group: the book being read, else the first unread one after the last finished.
 * `text` says it in a few words for stacks and shelves; `verb` starts the series page's button.
 */
function seriesPlace(g) {
  const st = (i) => status(i.book);
  const reading = g.items.filter((i) => st(i) === 'reading').sort((a, b) => b.book.progress.updatedAt - a.book.progress.updatedAt)[0];
  const done = g.items.map(st).lastIndexOf('finished');
  // A book whose numbers finished books already hold does not come next: an omnibus of books you have
  // read, or a book you read in an omnibus (or in another format). Numbers such as 2.5 hold no whole one.
  const numbers = (i) => {
    const out = [];
    if (i.position != null) for (let n = Math.ceil(i.position); n <= (i.positionEnd ?? i.position); n++) out.push(n);
    return out;
  };
  const read = new Set(g.items.filter((i) => st(i) === 'finished').flatMap(numbers));
  const next = (i) => st(i) === 'unread' && !(numbers(i).length && numbers(i).every((n) => read.has(n)));
  const unread = g.items.slice(done + 1).find(next) || g.items.find(next);
  const no = (i) => (i.position != null ? `#${numberIn(i)}` : '');
  if (reading) return { item: reading, verb: 'Continue', text: `Reading ${no(reading)}`.trim() };
  if (unread && done >= 0) return { item: unread, verb: 'Next up:', text: no(unread) ? `Next: ${no(unread)}` : 'Next up' };
  if (unread) return { item: unread, verb: 'Start with', text: 'Not started' };
  return { item: null, verb: '', text: g.state === 'finished' ? 'Finished' : '' };
}

/** How far through a group you are, finished books counting whole. */
const groupPct = (g) => Math.round(g.items.reduce((sum, i) => sum + (status(i.book) === 'finished' ? 1 : i.book.progress?.percent || 0), 0) / g.items.length * 100);

// ---- books a series lacks ----

// What Hardcover lists for each series (GET /api/series/:id/missing), by series id: the answer for the
// books the series had when it was asked (`key`), and whether asking failed or is under way.
const catalogued = new Map();
const RETRY = 10 * 60 * 1000;
let renderSoon = null;

/**
 * The books a series lacks, in order (see missingBooks() in missing.js), `all` of them for the series'
 * own page, leaving out those an admin removed. The server is asked what Hardcover lists the first time
 * and when the series' books change: for its page always, for a shelf only when there are gaps left to
 * put titles to.
 */
function lacking(g, { all = false } = {}) {
  if (!g.numbered) return [];
  const removed = removedMissing[g.id] || [];
  const key = `${g.name}\n${g.items.map((i) => `${i.book.id}@${numberIn(i)}`).join(' ')}`;
  const known = catalogued.get(g.id);
  const outdated = !known || known.key !== key || (known.failed && Date.now() - known.at > RETRY);
  if (outdated && !known?.asking && !offline && (all || gaps(g.items, { removed })?.length)) askCatalogue(g.id, key);
  return missingBooks(g.items, known?.answer, { all, removed });
}

/** The book a series lacks at a number, with its title, author and link when Hardcover lists it, else only its number. */
function listedMissing(seriesId, position) {
  const answer = catalogued.get(seriesId)?.answer;
  return (answer?.series && answer.missing.find((m) => m.position === position)) || { position };
}

function askCatalogue(id, key) {
  const before = catalogued.get(id);
  catalogued.set(id, { ...before, asking: true });
  api(`/api/series/${id}/missing`).then((answer) => {
    catalogued.set(id, { key, answer, at: Date.now() });
    // Without a series on Hardcover the gaps stay as they are. The answers that come at once are shown together.
    if ((answer.series || before?.answer?.series) && !renderSoon) renderSoon = setTimeout(() => { renderSoon = null; render(); }, 50);
  }, () => {
    // Hardcover could not be asked, or this device is offline: the gaps show until it is asked again.
    catalogued.set(id, { key, answer: before?.answer, at: Date.now(), failed: true });
  });
}

const missingState = (m) => (m.upcoming ? 'Not out yet' : 'Not in the library');
// An outline, with the title and author inside when Hardcover gave them.
const missingCover = (m) => `<div class="cover placeholder">${m.title ? `<div class="t">${escapeHtml(m.title)}</div><div class="a">${escapeHtml(m.author)}</div>` : ''}</div>`;
// A book Hardcover lists opens there, in another tab.
const missingLink = (m) => (m.url ? `<a class="link" href="${escapeHtml(m.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(`#${m.position} ${m.title}, ${missingState(m).toLowerCase()}: see it on Hardcover`)}"></a>` : '');
const missingMeta = (m) => (m.title ? `<div class="meta"><span>${missingState(m)}</span>${m.url ? '<span class="badge">Hardcover</span>' : ''}</div>` : '');
// "#3 Abaddon's Gate", or "#3" when only the number is known.
const missingName = (m) => `#${m.position}${m.title ? ` ${m.title}` : ''}`;
// For admins, the options of a book the series lacks, where one shown wrongly is removed (see missingOptions()).
// It comes after the link to Hardcover, so it sits above it.
const missingMenu = (m, seriesId) => (me.isAdmin && !selecting
  ? `<button class="menu-btn" aria-label="${escapeHtml(`Options for ${missingName(m)}`)}" data-missing-menu="${seriesId}:${m.position}">&#8943;</button>` : '');

/** A book series `seriesId` lacks (see lacking()) as a dashed outline in its place. */
function missingCard(m, seriesId) {
  if (display === 'list') return missingRow(m, seriesId);
  return `<div class="card missing">
    ${missingCover(m)}<span class="cover-tag">#${m.position}</span>${missingLink(m)}
    <div class="info">
      <div class="title">${escapeHtml(m.title || missingState(m))}</div>
      ${m.title ? `<div class="author">${escapeHtml(m.author)}</div>` : ''}
      ${missingMeta(m)}
    </div>
    ${missingMenu(m, seriesId)}
  </div>`;
}

/** A book the series lacks as a row of the list view. */
function missingRow(m, seriesId) {
  return `<div class="list-row missing">
    <div class="thumb">${missingCover(m)}</div>
    ${missingLink(m)}
    <div class="body">
      <div class="title"><span class="no">#${m.position}</span> ${escapeHtml(m.title || missingState(m))}</div>
      ${m.author ? `<div class="about">${escapeHtml(m.author)}</div>` : ''}
      ${missingMeta(m)}
    </div>
    ${missingMenu(m, seriesId)}
  </div>`;
}

/** A book the series lacks on its shelf. */
const missingShelfBook = (m, seriesId) => `<div class="shelf-book missing">
    ${missingCover(m)}<span class="cover-tag">#${m.position}</span>${missingLink(m)}
    ${missingMenu(m, seriesId)}
    ${m.title ? `<div class="title">${escapeHtml(m.title)}</div>` : ''}
    <div class="state">${missingState(m)}</div>
  </div>`;

/** A series or collection as one tile: a stack of books with the one you're on as the top cover. */
function stackCard(g) {
  if (display === 'list') return groupRow(g);
  const n = g.items.length;
  const place = seriesPlace(g);
  const cover = coverHtml((place.item || g.items[0]).book);
  const pct = groupPct(g);
  // While choosing books, a stack's tick sits at the foot of its top cover, clear of the number of books.
  const tick = selecting ? TICK : '';
  // The number of books: a line above the cover in the soft look, a tag on the cover in the e-ink look (see the stylesheets).
  return `<div class="card group${n > 1 ? ' pile' : ''}${chosenClass(g.items.map((i) => i.book.id))}">
    <div class="count">${plural(n, 'book', 'books')}</div>
    ${n > 1 ? `<div class="stack">${cover}${tick}</div>` : `${cover}${tick}`}<span class="cover-tag">${plural(n, 'book', 'books')}</span>
    ${seriesOpener(g, `${g.name}, ${plural(n, 'book', 'books')}`)}
    ${topMenu(place)}
    <div class="info">
      <div class="title">${escapeHtml(g.name)}</div>
      <div class="author">${escapeHtml(g.author)}</div>
      ${g.state !== 'unread' ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : ''}
      <div class="meta"><span class="place">${escapeHtml(place.text)}</span></div>
    </div>
  </div>`;
}

/** The options button of the book on top of a stack or a series row, so a book you only opened can be reset there. */
function topMenu(place) {
  const top = place.item?.book;
  return top && !selecting ? `<button class="menu-btn" aria-label="Options for ${escapeHtml(top.title)}" data-menu="${top.id}">&#8943;</button>` : '';
}

/** A series or collection as a row of the list view. */
function groupRow(g) {
  const n = g.items.length;
  const place = seriesPlace(g);
  const about = [g.author, plural(n, 'book', 'books')].filter(Boolean).map(escapeHtml).join(' · ');
  return `<div class="list-row group${chosenClass(g.items.map((i) => i.book.id))}">
    <div class="thumb${n > 1 ? ' stack' : ''}">${coverHtml((place.item || g.items[0]).book)}</div>
    ${seriesOpener(g, `${g.name}, ${plural(n, 'book', 'books')}`)}
    <div class="body">
      <div class="title">${escapeHtml(g.name)}</div>
      <div class="about">${about}</div>
      <div class="meta">${g.state !== 'unread' ? `<div class="progress"><div style="width:${groupPct(g)}%"></div></div>` : ''}<span class="place">${escapeHtml(place.text)}</span></div>
    </div>
    ${topMenu(place)}<span class="chevron" aria-hidden="true">&#8250;</span>${selecting ? TICK : ''}
  </div>`;
}

/**
 * A series as a shelf: every book in order with its title, and the book you're on outlined. Books
 * missing below the highest one the library has are dashed outlines in their place.
 */
function shelf(g) {
  const place = seriesPlace(g);
  const facts = [g.author, plural(g.items.length, 'book', 'books'), place.text].filter(Boolean).map(escapeHtml).join(' · ');
  const shelfBook = ({ book: b, ...place }, current) => {
    const st = status(b);
    const pct = b.progress ? Math.round(b.progress.percent * 100) : 0;
    const state = { finished: '&#10003; Finished', reading: `${pct}% read`, unread: 'Not started', processing: 'Preparing…', error: 'Could not convert' }[st];
    return `<div class="shelf-book${current ? ' current' : ''}${chosenClass([b.id])}">
      ${coverHtml(b)}${place.position != null ? `<span class="cover-tag">#${numberIn(place)}</span>` : ''}
      ${opener(b)}
      <button class="menu-btn" aria-label="Options for ${escapeHtml(b.title)}" data-menu="${b.id}">&#8943;</button>
      <div class="title">${escapeHtml(b.title)}</div>
      ${st === 'reading' ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : ''}
      <div class="state">${state}</div>
    </div>`;
  };
  const current = (i) => i === place.item && g.state !== 'unread';
  const items = inOrder(g.items, lacking(g));
  const books = display === 'list'
    ? tiles(items.map((i) => (i.missing ? missingRow(i.missing, g.id) : bookRow(i.book, { seriesId: g.id, position: numberIn(i), current: current(i) }))).join(''))
    : `<div class="shelf-row">${items.map((i) => (i.missing ? missingShelfBook(i.missing, g.id) : shelfBook(i, current(i)))).join('')}</div>`;
  // In a section of the Group by menu, a shelf's heading comes under the section's.
  const h = groupBy === 'none' ? 'h2' : 'h3';
  return `<section class="shelf">
    <div class="shelf-head"><${h}><a href="/?series=${g.id}" data-series="${g.id}">${escapeHtml(g.name)}</a></${h}><span class="muted">${facts}</span>${pickAll()}</div>
    ${books}
  </section>`;
}

/** In the Books tab a series (a numbered group of two or more books) folds up; its books leave the single books. */
function foldSeries() {
  const series = groupSeries().filter((g) => g.numbered && g.items.length > 1);
  const folded = new Set(series.flatMap((g) => g.items.map((i) => i.book.id)));
  return { series, singles: books.filter((b) => !folded.has(b.id)) };
}

function renderSeriesList() {
  const all = groupSeries();
  if (!all.length) {
    els.library.innerHTML = `<div class="empty"><p>No series or collections yet.</p>
      <p>Books join a series by themselves when their details name one. To group any books, use <b>Details and cover</b> in a book's &#8943; menu.</p></div>`;
    return;
  }
  const q = els.search.value.trim().toLowerCase();
  const f = els.filter.value;
  const list = all.filter((g) => {
    if (q && !`${g.name} ${g.items.map((i) => `${i.book.title} ${i.book.author} ${i.book.genre || ''}`).join(' ')}`.toLowerCase().includes(q)) return false;
    if (f === 'duplicates') return g.items.some((i) => flagged(i.book));
    return f === 'all' || g.state === f;
  });
  if (!list.length) { els.library.innerHTML = '<div class="empty">No series or collections match.</div>'; return; }
  els.library.innerHTML = grouped(list.sort(sorter()), (things) => tiles(things.map((g) => stackCard(g)).join('')));
}

function renderSeries(id) {
  const g = groupSeries().find((x) => x.id === id);
  if (!g) {
    els.library.innerHTML = '<div class="empty"><p>This series or collection is no longer in the library.</p><p><button class="btn" data-back>Show all series and collections</button></p></div>';
    return;
  }
  const place = seriesPlace(g);
  const next = place.item && `${place.verb} ${place.item.position != null ? `#${numberIn(place.item)} ` : ''}${place.item.book.title}`;
  // Every book of the series the library lacks, from Hardcover when it knows the series.
  const missing = lacking(g, { all: true });
  const facts = [g.numbered ? 'Series' : 'Collection', plural(g.items.length, 'book', 'books'), g.author, g.genre, g.finished ? `${g.finished} finished` : '',
    missing.length ? `${missing.length} not in the library` : ''];
  els.library.innerHTML = `<div class="series-head">
      <button class="btn small" data-back>&#8592; All series and collections</button>
      <h1>${escapeHtml(g.name)}</h1>
      <p class="muted">${facts.filter(Boolean).map(escapeHtml).join(' · ')}</p>
      <div class="row">
        ${next ? `<a class="btn primary" href="/read/${place.item.book.id}">${escapeHtml(next)}</a>` : ''}
        ${g.items.some((i) => mayEdit(i.book)) ? `<button class="btn" data-genre-series="${g.id}">Set genre</button>` : ''}
        ${me.isAdmin ? `<button class="btn" data-edit-series="${g.id}">Rename or remove</button>` : ''}
      </div>
    </div>
    ${tiles(inOrder(g.items, missing).map((i) => (i.missing ? missingCard(i.missing, g.id) : card(i.book, { seriesId: g.id, position: numberIn(i) }))).join(''))}`;
}

// Under a section of the Group by menu, a heading is one level down.
const heading = (text, count, h = groupBy === 'none' ? 'h2' : 'h3') => `<div class="section-title"><${h} style="margin:0">${text}</${h}><span class="muted">${count}</span></div>`;

// ---- grouping by author or genre ----

/**
 * The names a book goes under in the Group by menu: its authors, or its genre. A series shown as one goes
 * under its lead author, or the genre most of its books have (see groupSeries()).
 */
const groupNames = (x) => (groupBy === 'author' ? (x.items ? [x.lead] : authorNames(x.author)) : [x.genre]);
/** How many books there are among books and series shown as one. */
const bookCount = (things) => things.reduce((n, x) => n + (x.items ? x.items.length : 1), 0);

/**
 * Books and series as the Group by menu has them: all together, or in a section per author or genre
 * (see sections() in groups.js), each under a heading with its number of books. `show` draws the books
 * and series of one section, in the order they come.
 */
function grouped(things, show) {
  if (groupBy === 'none') return show(things);
  const none = groupBy === 'author' ? 'No author' : 'No genre';
  return sections(things, groupNames, groupBy).map((s) => `<section class="group-section">
      <div class="group-head"><h2>${escapeHtml(s.name || none)}</h2><span class="muted">${plural(bookCount(s.items), 'book', 'books')}</span>${pickAll()}</div>
      ${show(s.items)}
    </section>`).join('');
}

/** The books you're in the middle of, one card each, above the library when it is sorted by Recently read. */
function continueReading() {
  if (els.sort.value !== 'recent' || els.search.value.trim() || els.filter.value !== 'all') return '';
  const reading = books.filter((b) => status(b) === 'reading').sort(sorter()).slice(0, 6);
  return reading.length ? `<div class="section-title"><h2 style="margin:0">Continue reading</h2></div>${tiles(reading.map((b) => card(b)).join(''))}` : '';
}

/** Books that look alike, in groups: a book, the books it looks like, theirs in turn. Oldest first in a group, groups by title. */
function duplicateGroups() {
  const byId = new Map(books.map((b) => [b.id, b]));
  const seen = new Set();
  const groups = [];
  for (const b of books.filter(flagged)) {
    if (seen.has(b.id)) continue;
    const group = [];
    const todo = [b];
    seen.add(b.id);
    while (todo.length) {
      const x = todo.pop();
      group.push(x);
      for (const d of x.duplicates) {
        const y = byId.get(d.id);
        if (y && !seen.has(y.id)) { seen.add(y.id); todo.push(y); }
      }
    }
    groups.push(group.sort((x, y) => x.addedAt - y.addedAt));
  }
  return groups.sort((x, y) => x[0].title.localeCompare(y[0].title));
}

// Why two books look alike, as the server says (see duplicates.js).
const likeness = (reason, a, b) => ({ file: 'the same file', isbn: 'the same ISBN', title: a.author && b.author ? 'the same title and author' : 'the same title' }[reason]);

/** The Duplicates filter: each group of books that look alike under a heading, with what they have in common. */
function renderDuplicates() {
  const q = els.search.value.trim().toLowerCase();
  const groups = duplicateGroups().filter((g) => !q || g.some((b) => matchesSearch(b, q)));
  if (!groups.length) {
    els.library.innerHTML = q ? '<div class="empty">No possible duplicates match.</div>'
      : '<div class="empty"><p>No possible duplicates.</p><p>Books that share an ISBN, or have the same title and author, are listed here.</p></div>';
    return;
  }
  els.library.innerHTML = groups.map((g) => {
    const alike = new Set(g.flatMap((b) => b.duplicates.map((d) => { const o = g.find((x) => x.id === d.id); return o ? likeness(d.reason, b, o) : null; })).filter(Boolean));
    return `<section class="shelf dup-group">
      <div class="shelf-head"><h2>${escapeHtml(g[0].title)}</h2><span class="muted">${plural(g.length, 'book', 'books')} with ${escapeHtml([...alike].join(', '))}</span></div>
      ${tiles(g.map((b) => card(b)).join(''))}
    </section>`;
  }).join('');
}

function renderBooks() {
  if (els.filter.value === 'duplicates') { renderDuplicates(); return; }
  const cont = continueReading();
  // In sections by author or genre, their headings take the place of "All books".
  const allBooks = cont && groupBy === 'none' ? `${cont}${heading('All books', books.length)}` : cont;
  const cards = (things) => tiles(things.map((x) => (x.items ? stackCard(x) : card(x))).join(''));
  // Searching always lists the matching books themselves, and so does Reading: the books being read, not their series.
  if (layout === 'every' || els.search.value.trim() || els.filter.value === 'reading') {
    const list = visible();
    els.library.innerHTML = list.length ? `${allBooks}${grouped(list, cards)}` : '<div class="empty">No books match.</div>';
    return;
  }
  // A series matches the other filters as a whole: Not started, or Finished.
  const keep = (state) => els.filter.value === 'all' || state === els.filter.value;
  const { series, singles } = foldSeries();
  const shownSeries = series.filter((g) => keep(g.state)).sort(sorter());
  const shownBooks = singles.filter((b) => keep(status(b))).sort(sorter());
  if (!shownSeries.length && !shownBooks.length) { els.library.innerHTML = '<div class="empty">No books match.</div>'; return; }
  if (layout === 'shelves') {
    // The series on shelves, then the other books. In a section without shelves its heading says it all.
    const shelves = (things) => {
      const inSeries = things.filter((x) => x.items);
      const alone = things.filter((x) => !x.items);
      const title = inSeries.length || groupBy === 'none' ? heading(inSeries.length ? 'Other books' : 'Books', alone.length) : '';
      return `${inSeries.map((g) => shelf(g)).join('')}${alone.length ? `${title}${cards(alone)}` : ''}`;
    };
    els.library.innerHTML = `${cont}${grouped([...shownSeries, ...shownBooks], shelves)}`;
    return;
  }
  const items = [...shownSeries, ...shownBooks].sort(sorter());
  els.library.innerHTML = `${allBooks}${grouped(items, cards)}`;
}

// The open series is part of the address (/?series=12), so reloading and the back button work.
const openSeriesId = () => { const v = new URLSearchParams(location.search).get('series'); return /^\d+$/.test(v || '') ? Number(v) : null; };
let openedHere = false; // the series page was opened from this page, so "back" returns to where we were

// ---- where the library was scrolled to ----
// Coming back from a book loads the library afresh, and it renders only once the books have come, too late for the
// browser to put the page back where it was. So this tab keeps the place of each view itself: the Books tab, the
// Series & collections tab, and each series page by its address.
history.scrollRestoration = 'manual';
const SCROLL = 'ereader.scroll';
const scrollKey = () => (openSeriesId() != null ? location.search : view);
// Only the first render after the page loads goes back to the view's place (see restoreFirst()).
let restorePending = true;

/** Where each view was last scrolled to in this tab, by scrollKey(). */
function scrollPlaces() {
  try { return JSON.parse(sessionStorage.getItem(SCROLL)) || {}; } catch { return {}; }
}

/** Keeps `y` as the place of the view shown, or with null forgets it. Without storage (private mode, full) nothing is put back. */
function keepPlace(y) {
  const places = scrollPlaces();
  if (y == null) delete places[scrollKey()];
  else places[scrollKey()] = y;
  try { sessionStorage.setItem(SCROLL, JSON.stringify(places)); } catch { /* nothing to go back to */ }
}

// Until the first render has put the page back, it is not anywhere worth keeping.
function saveScroll() { if (!restorePending) keepPlace(window.scrollY); }

// The browser holds the page within its height, should the view be shorter now. A view entered with no place kept
// starts at `orElse` (the top) when one is given, and is otherwise left where it is.
function restoreScroll(orElse) {
  const y = scrollPlaces()[scrollKey()] ?? orElse;
  if (y != null) window.scrollTo(0, y);
}

/** After the first render of the page, back to where the view was. Later ones, while books convert or after an edit, leave the page where it is. */
function restoreFirst() {
  if (!restorePending) return;
  restorePending = false;
  restoreScroll();
}

function openSeries(id) {
  saveScroll();
  history.pushState(null, '', `/?series=${id}`);
  openedHere = true;
  // A series page opens at the top, not where it was the last time.
  keepPlace(null);
  render();
  window.scrollTo(0, 0);
}

function closeSeries() {
  saveScroll();
  view = 'series';
  savePrefs();
  if (openedHere) { history.back(); return; }
  history.replaceState(null, '', '/');
  render();
  restoreScroll(0);
}

// The covers on the page that have loaded, by their markup: a new picture just like one of them takes its place.
function loadedCovers() {
  const covers = new Map();
  for (const img of els.library.querySelectorAll('img')) {
    if (!img.complete || !img.naturalWidth) continue;
    const key = img.outerHTML;
    covers.set(key, [...(covers.get(key) || []), img]);
  }
  return covers;
}
function keepCovers(covers) {
  if (!covers.size) return;
  for (const img of [...els.library.querySelectorAll('img')]) {
    const old = covers.get(img.outerHTML)?.shift();
    if (old) img.replaceWith(old);
  }
}

function render() {
  const seriesId = openSeriesId();
  const shown = seriesId != null ? 'series' : view;
  for (const tab of els.tabs.querySelectorAll('[data-view]')) tab.setAttribute('aria-pressed', String(tab.dataset.view === shown));
  els.tabs.querySelector('[data-view="books"] .n').textContent = books.length || '';
  els.tabs.querySelector('[data-view="series"] .n').textContent = new Set(books.flatMap((b) => b.series.map((s) => s.id))).size || '';
  document.body.classList.toggle('series-open', seriesId != null);
  // While choosing books, tapping one chooses it, and the bar at the bottom says what can be done with them.
  document.body.classList.toggle('selecting', selecting);
  els.select.setAttribute('aria-pressed', String(selecting));
  els.selectBar.classList.toggle('hidden', !selecting);
  els.layout.closest('.control').classList.toggle('hidden', shown !== 'books');
  els.sectionName.textContent = shown === 'series' ? 'Series & collections' : 'Books';
  const dupCount = books.filter(flagged).length;
  els.filter.querySelector('[value="duplicates"]').textContent = dupCount ? `Duplicates (${dupCount})` : 'Duplicates';
  els.library.className = display === 'list' ? 'view-list' : `cols-${display.slice(-1)}`;
  // With the controls folded away on a phone, say when a search or filter hides books.
  const q = els.search.value.trim();
  const narrowing = seriesId == null ? [els.filter.value !== 'all' ? els.filter.selectedOptions[0].textContent : '', q ? `"${q}"` : ''].filter(Boolean) : [];
  els.activeFilters.innerHTML = narrowing.length ? `<span>Showing ${escapeHtml(narrowing.join(' · '))}</span><button type="button" class="btn small" data-show-all>Show all</button>` : '';
  els.activeFilters.classList.toggle('hidden', !narrowing.length);
  els.offlineNote.classList.toggle('hidden', !offline);
  // Covers already on the page are kept, so drawing the library again does not make them flash.
  const covers = loadedCovers();
  if (!books.length) els.library.innerHTML = '<div class="empty"><p>The library is empty.</p><p>Upload EPUB, MOBI, PDF, Markdown or text files to get started.</p></div>';
  else if (seriesId != null) renderSeries(seriesId);
  else if (view === 'series') renderSeriesList();
  else renderBooks();
  keepCovers(covers);
  settled = true;
  if (selecting) showSelection();
}

// ---- choosing books to change together (Select) ----

/** Whether you can change a book's details: a book you added, or any as an admin. */
const mayEdit = (b) => me.isAdmin || b.addedById === me.id;

/** The ids of the books in each series and collection, by its id. */
function seriesBookIds() {
  const out = new Map();
  for (const b of books) {
    for (const s of b.series) {
      if (!out.has(s.id)) out.set(s.id, []);
      out.get(s.id).push(b.id);
    }
  }
  return out;
}

/** The books shown in part of the page: each book, and every book of a series or collection shown as one. */
function booksIn(root, inSeries = seriesBookIds()) {
  const ids = new Set([...root.querySelectorAll('[data-pick]')].map((el) => el.dataset.pick));
  for (const el of root.querySelectorAll('[data-pick-series]')) for (const id of inSeries.get(Number(el.dataset.pickSeries)) || []) ids.add(id);
  return [...ids];
}

/**
 * Shows which books are chosen without drawing the library again, which would redraw every cover (slow
 * on e-ink): on each book and series, on the buttons that choose a section, and in the bar.
 */
function showSelection() {
  const inSeries = seriesBookIds();
  const mark = (el, state) => {
    el.setAttribute('aria-pressed', state);
    const tile = el.closest('.card, .list-row, .shelf-book');
    tile?.classList.toggle('selected', state === 'true');
    tile?.classList.toggle('part-selected', state === 'mixed');
  };
  for (const el of els.library.querySelectorAll('[data-pick]')) mark(el, String(selected.has(el.dataset.pick)));
  for (const el of els.library.querySelectorAll('[data-pick-series]')) mark(el, chosen(inSeries.get(Number(el.dataset.pickSeries)) || []));
  for (const el of els.library.querySelectorAll('[data-pick-section]')) {
    el.textContent = chosen(booksIn(el.closest('section'), inSeries)) === 'true' ? 'Deselect all' : 'Select all';
  }
  const n = selected.size;
  els.selectBar.querySelector('[data-count]').textContent = n ? `${plural(n, 'book', 'books')} selected` : 'Choose books, or a series for all its books';
  for (const btn of els.selectBar.querySelectorAll('[data-sel="genre"], [data-sel="clear"]')) btn.disabled = !n;
}

/** Chooses these books, or leaves them all when every one of them is chosen already. */
function toggle(ids) {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  for (const id of ids) {
    if (all) selected.delete(id);
    else selected.add(id);
  }
  showSelection();
}

function stopSelecting() {
  selecting = false;
  selected.clear();
  render();
}

// ---- uploads ----
// Books go up one at a time, in order, and files added meanwhile join the queue. A folder brings the books
// in it and in its subfolders, each with the OPF file and cover picture that go with it; hidden files and
// files in other formats stay behind. One line sums up the batch as it goes, with a line under it for each
// file that could not be added or was in the library already.

// The formats the server takes, by extension, as the library lists them; until it has loaded, those the picker offers.
let supported = new Set(els.file.accept.split(',').filter((a) => a.startsWith('.')).map((a) => a.slice(1)));
const queue = []; // { file, path, opf, cover } waiting to go up, the last two the files that go with it or null
let batch = null; // what the files added since the uploads line was last closed came to
let sending = null; // the file going up now: { path, abort }

// Pictures that can be the cover of a book beside them.
const COVER_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const extOf = (name) => /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? '';
const baseOf = (name) => name.replace(/\.[^.]*$/, '').toLowerCase();

/**
 * The books among files, in the order of their paths, each with the OPF file and cover picture that go
 * with it, and how many other files there were of each extension. What goes with a book is named like it
 * ("Dune.opf", "Dune.jpg", as calibre saves books to disk), or, in a folder holding one book (in one or
 * more formats, as in a calibre library), is metadata.opf and cover.jpg.
 */
function booksAmong(files) {
  const folders = new Map();
  for (const f of files) {
    if (f.path.split('/').some((part) => part.startsWith('.'))) continue; // hidden, such as .DS_Store
    const folder = f.path.slice(0, f.path.lastIndexOf('/') + 1);
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(f);
  }
  const found = [];
  const skipped = new Map();
  for (const inFolder of folders.values()) {
    const byName = new Map(inFolder.map((f) => [f.file.name.toLowerCase(), f]));
    const books = new Set(inFolder.filter((f) => supported.has(extOf(f.file.name))));
    const oneBook = new Set([...books].map((f) => baseOf(f.file.name))).size === 1;
    const used = new Set();
    const first = (names) => {
      const f = names.map((n) => byName.get(n)).find((x) => x && !books.has(x));
      if (f) used.add(f);
      return f?.file ?? null;
    };
    for (const b of books) {
      const base = baseOf(b.file.name);
      const opf = first([`${base}.opf`, ...(oneBook ? ['metadata.opf'] : [])]);
      const cover = first([...COVER_EXTS.map((e) => `${base}.${e}`), ...(oneBook ? COVER_EXTS.map((e) => `cover.${e}`) : [])]);
      found.push({ ...b, opf, cover });
    }
    for (const f of inFolder) {
      if (books.has(f) || used.has(f)) continue;
      const ext = extOf(f.file.name);
      skipped.set(ext, (skipped.get(ext) || 0) + 1);
    }
  }
  found.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { found, skipped };
}

function startBatch() {
  batch = { total: 0, handled: 0, added: 0, withOpf: 0, withCover: 0, already: 0, failed: 0, skipped: new Map(), looking: null, lastPath: '', ended: null };
  els.uploads.innerHTML = `<div class="item summary"><span data-summary></span><button type="button" class="btn small" data-act="stop">Stop</button></div>
    <div class="upload-lines"><div data-failed></div><div data-already></div></div>`;
}

/** Sums the batch up in its line: the file going up, or how it ended, and what was not added. */
function showBatch() {
  const b = batch;
  const others = [...b.skipped.values()].reduce((sum, n) => sum + n, 0);
  const kinds = [...b.skipped].sort((x, y) => y[1] - x[1]).map(([ext]) => (ext ? `.${ext}` : 'no extension'));
  const head = sending ? `Uploading ${b.total > 1 ? `${b.handled + 1} of ${b.total}: ` : ''}${sending.path}`
    : b.looking != null ? `Looking through the folder: ${plural(b.looking, 'file', 'files')} so far`
    : !b.total ? 'No books found. The library takes EPUB, MOBI, PDF, Markdown and text files'
    : b.ended === 'stopped' ? `Stopped after adding ${b.added} of ${b.total} books`
    : b.ended === 'lost' ? `Lost the connection to the server after adding ${b.added} of ${b.total} books`
    : !b.added ? 'No books added'
    : b.total === 1 ? `Added ${b.lastPath}`
    : b.added === b.total ? `Added ${plural(b.added, 'book', 'books')}` : `Added ${b.added} of ${b.total} books`;
  const notes = [
    b.withOpf && `${b.withOpf} with an .opf file`,
    b.withCover && `${b.withCover} with a cover picture`,
    b.already && `${b.already} already in the library`,
    b.failed && `${b.failed} could not be added`,
    others && `${plural(others, 'other file', 'other files')} left out (${kinds.slice(0, 4).join(', ')}${kinds.length > 4 ? ' …' : ''})`,
  ];
  const cut = !sending && (b.ended === 'stopped' || b.ended === 'lost');
  els.uploads.querySelector('[data-summary]').textContent = [head, ...notes].filter(Boolean).join(' · ')
    + (cut ? '. Upload the same files again to add the rest: the books already in the library are skipped.' : '');
  const button = els.uploads.querySelector('[data-act]');
  const done = !sending && b.looking == null && !!b.ended;
  button.dataset.act = done ? 'close' : 'stop';
  button.textContent = done ? 'Close' : 'Stop';
  button.classList.toggle('hidden', !sending && !done);
}

/** A line under the summary for a file that was not added, saying why, or which book it already is. */
function addLine(kind, path, message) {
  const item = document.createElement('div');
  item.className = 'item';
  item.innerHTML = `<span>${escapeHtml(path)}</span><span class="${kind === 'failed' ? 'error' : 'muted'}">${escapeHtml(message)}</span>`;
  els.uploads.querySelector(`[data-${kind}]`).appendChild(item);
}

/** Queues books to go up, as booksAmong() finds them, with `skipped` the other files found beside them. */
function upload(files, skipped = new Map()) {
  if (!batch || (batch.ended && !sending)) startBatch();
  batch.total += files.length;
  for (const [ext, n] of skipped) batch.skipped.set(ext, (batch.skipped.get(ext) || 0) + n);
  queue.push(...files);
  if (sending) showBatch();
  else sendQueue();
}

async function sendQueue() {
  while (queue.length) {
    const { file, path, opf, cover } = queue.shift();
    const abort = new AbortController();
    sending = { path, abort };
    batch.lastPath = path;
    showBatch();
    try {
      if (!file.size) throw new ApiError(400, { error: 'The file is empty' });
      // What goes with the book goes ahead of it in the body, its size saying where it ends. A cover is
      // scaled down first like one picked by hand; one the browser cannot read stays behind.
      const picture = cover && await coverImage(cover).catch(() => null);
      const headers = { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) };
      if (opf) headers['X-Opf-Size'] = String(opf.size);
      if (picture) headers['X-Cover-Size'] = String(picture.size);
      const body = opf || picture ? new Blob([opf, picture, file].filter(Boolean)) : file;
      const answer = await api('/api/books', { method: 'POST', raw: true, body, signal: abort.signal, headers });
      batch.added++;
      if (answer.used?.opf) batch.withOpf++;
      if (answer.used?.cover) batch.withCover++;
    } catch (err) {
      if (abort.signal.aborted) continue; // stopped: the queue is empty, unless files were added since
      if (err.status === 409 && err.body?.book) {
        batch.already++;
        addLine('already', path, `already in the library as "${err.body.book.title}"`);
      } else if (err instanceof ApiError) {
        batch.failed++;
        addLine('failed', path, err.message);
      } else {
        // No answer at all, so the files after it would fare no better.
        batch.ended = 'lost';
        queue.length = 0;
      }
    }
    batch.handled++;
    reloadSoon();
  }
  sending = null;
  if (batch.looking != null) return; // a folder still being read adds its books to this batch
  batch.ended ||= 'done';
  showBatch();
  // A single book that went in as planned folds away by itself; a batch stays, to be read, until it is closed.
  const ended = batch;
  if (ended.ended === 'done' && ended.total === 1 && ended.added === 1 && !ended.skipped.size) setTimeout(() => { if (batch === ended) closeBatch(); }, 4000);
  clearTimeout(reloadTimer);
  reloadTimer = null;
  load({ quiet: true });
}

/** Stops the batch: the file going up now is cut off, and the files after it stay behind. */
function stopUploads() {
  queue.length = 0;
  batch.ended = 'stopped';
  sending?.abort.abort();
}

function closeBatch() {
  if (sending || batch?.looking != null) return;
  batch = null;
  els.uploads.innerHTML = '';
}

const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

/** Adds the files in a dropped folder and in its subfolders to `found`, as { file, path }, leaving hidden ones out. */
async function readFolder(dir, found) {
  const reader = dir.createReader();
  try {
    // A folder is read some entries at a time (100 in Chrome), until none come back.
    for (let entries = await readBatch(reader); entries.length; entries = await readBatch(reader)) {
      const shown = entries.filter((e) => !e.name.startsWith('.'));
      found.push(...await Promise.all(shown.filter((e) => e.isFile).map(async (e) => ({ file: await fileOf(e), path: e.fullPath.slice(1) }))));
      batch.looking = found.length;
      showBatch();
      for (const sub of shown.filter((e) => e.isDirectory)) await readFolder(sub, found);
    }
  } catch (err) {
    batch.failed++;
    addLine('failed', dir.fullPath.slice(1), `The folder could not be read (${err.message})`);
  }
}

/** Uploads the books among files: [{ file, path }]. */
function uploadFiles(files) {
  const { found, skipped } = booksAmong(files);
  upload(found, skipped);
}

/** Uploads what was dropped: loose files, and the books in folders and their subfolders. */
async function uploadDropped(entries) {
  if (!batch || (batch.ended && !sending)) startBatch();
  batch.looking = 0;
  showBatch();
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory) await readFolder(entry, files);
    else {
      await fileOf(entry).then((file) => files.push({ file, path: entry.name }), (err) => {
        batch.failed++;
        addLine('failed', entry.name, `The file could not be read (${err.message})`);
      });
    }
  }
  batch.looking = null;
  uploadFiles(files);
}

// While books go up, the library reloads every few seconds rather than after each one.
let reloadTimer = null;
let loadedAt = 0;
function reloadSoon() {
  if (!reloadTimer) reloadTimer = setTimeout(() => { reloadTimer = null; load({ quiet: true }); }, Math.max(0, loadedAt + 3000 - Date.now()));
}

els.upload.addEventListener('click', () => { setMenu(false); els.file.click(); });
els.file.addEventListener('change', () => { uploadFiles([...els.file.files].map((file) => ({ file, path: file.name }))); els.file.value = ''; });
// A folder is picked where the browser can, with a mouse: on a phone the picker only picks files.
if ('webkitdirectory' in els.folderInput && matchMedia('(pointer: fine)').matches) els.uploadFolder.classList.remove('hidden');
els.uploadFolder.addEventListener('click', () => els.folderInput.click());
els.folderInput.addEventListener('change', () => {
  const files = [...els.folderInput.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  els.folderInput.value = '';
  uploadFiles(files);
});
els.uploads.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'stop') stopUploads();
  else if (act === 'close') closeBatch();
});
// Leaving the page stops the upload, so the browser asks first.
window.addEventListener('beforeunload', (e) => { if (sending) { e.preventDefault(); e.returnValue = ''; } });
// While a book's menu is open for someone who can change the book, an image dropped or pasted on the page
// becomes its cover instead.
const coverOpen = () => !!coverEditor?.root.isConnected;
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); if (!coverOpen()) els.drop.classList.add('active'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) els.drop.classList.remove('active'); });
document.addEventListener('drop', (e) => {
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  if (coverOpen()) { coverEditor.useFile(files[0]); return; }
  // A folder's files are read through its entry, which has to be taken while the drop lasts.
  const entries = [...e.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.some((entry) => entry.isDirectory)) uploadDropped(entries);
  else uploadFiles([...files].map((file) => ({ file, path: file.name })));
});
document.addEventListener('paste', (e) => {
  if (!coverOpen()) return;
  const items = [...(e.clipboardData?.items || [])];
  // In a field, text wins: cells copied from a spreadsheet come as text with a picture of them. An image alone is the cover.
  if (e.target.closest?.('input, textarea') && items.some((i) => i.kind === 'string' && i.type === 'text/plain')) return;
  const file = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
  if (!file) return;
  e.preventDefault();
  coverEditor.useFile(file);
});

// ---- dialogs ----
// Close and the backdrop ask `mayLeave()` first, set by a dialog with something that would be lost.
function dialog(html) {
  els.dialogRoot.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet" role="dialog">${html}</div>`;
  const close = () => { els.dialogRoot.innerHTML = ''; };
  const d = { root: els.dialogRoot.querySelector('.sheet'), close, mayLeave: () => true };
  const leave = () => { if (d.mayLeave()) close(); };
  els.dialogRoot.querySelector('.sheet-backdrop').addEventListener('click', leave);
  els.dialogRoot.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', leave));
  return d;
}

// A plain click on a series link opens it in place; modified clicks keep their usual meaning.
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * A book's menu: Read, Save and Close in a bar that stays at the top while the rest scrolls; who is reading
 * the book; the details and the cover, for the uploader or an admin (see editBook()), where other readers
 * see the book's cover and details; and at the foot the book's file and what can be done with it. The
 * uploader and admins see the title and author in the form, so the head then holds only what went wrong.
 */
function bookMenu(b) {
  const canEdit = mayEdit(b);
  const menu = dialog(`
    <div class="sheet-bar">
      ${b.status === 'ready' ? `<a class="btn small primary read" href="/read/${b.id}" data-read>Read</a>` : ''}
      ${canEdit ? '<button type="submit" class="btn small save" form="bk-edit" data-save disabled>Save</button>' : ''}
      <button type="button" class="btn small close" data-close>Close</button>
    </div>
    <header class="book-head${canEdit && b.status !== 'error' && !flagged(b) ? ' hidden' : ''}">
      ${canEdit ? '' : coverSrc(b) ? `<button type="button" class="cover-preview cover-button" data-full-cover aria-label="Show the cover at full size">${coverHtml(b)}</button>` : `<div class="cover-preview">${coverHtml(b)}</div>`}
      <div class="about">
        <h2 id="bk-title"${canEdit ? ' class="sr-only"' : ''}>${escapeHtml(b.title)}</h2>
        ${!canEdit && b.author ? `<p class="muted">${escapeHtml(b.author)}</p>` : ''}
        ${!canEdit && b.series.length ? `<p class="series-links">Part of ${b.series.map(seriesLink).join(', ')}</p>` : ''}
        ${!canEdit && b.genre ? `<p class="muted">${escapeHtml(b.genre)}</p>` : ''}
        ${b.status === 'error' ? `<p class="error">${escapeHtml(b.error || 'Conversion failed')}</p>` : ''}
        ${flagged(b) ? '<p class="flag"><button type="button" class="dup-flag" data-act="duplicates">Compare with possible duplicates</button></p>' : ''}
      </div>
    </header>
    <section class="readers">
      <h3 class="area-name">Who is reading</h3>
      <div data-readers aria-live="polite"></div>
      ${b.progress ? '<button type="button" class="btn small" data-act="reset">Reset my reading position</button>' : ''}
    </section>
    ${canEdit ? bookFormHtml(b) : ''}
    ${me.isAdmin && b.status === 'ready' ? `<section class="fixes hidden">
      <h3 class="area-name">Fixes to the text</h3>
      <div data-fixes aria-live="polite"></div>
    </section>` : ''}
    <footer class="book-foot">
      <section class="file">
        <h3 class="area-name">File</h3>
        <p>${b.format.toUpperCase()} · ${(b.size / 1048576).toFixed(1)} MB · added by ${escapeHtml(b.addedBy || 'unknown')} ${formatDate(b.addedAt)}</p>
        <p class="muted">${escapeHtml(b.originalName)}</p>
      </section>
      <div class="file-actions">
        <a class="btn small" href="/books/${b.id}/original" download="${escapeHtml(b.originalName)}">Download original file</a>
        ${b.status === 'ready' ? `<a class="btn small" href="/api/books/${b.id}/epub" download>Download EPUB</a>` : ''}
        ${canEdit ? '<button type="button" class="btn small" data-act="reprocess">Convert again</button>' : ''}
        ${canEdit ? '<button type="button" class="btn small danger" data-act="delete">Delete from library</button>' : ''}
      </div>
    </footer>`);
  const { root, close } = menu;
  root.classList.add('book');
  root.classList.toggle('editable', canEdit);
  root.setAttribute('aria-labelledby', 'bk-title');
  showReaders(b, root.querySelector('[data-readers]'));
  const fixes = root.querySelector('.fixes');
  if (fixes) showFixes(b, fixes);
  root.addEventListener('click', async (ev) => {
    // Reading the book or going to a series leaves unsaved changes behind too, so they ask first as well.
    if (ev.target.closest('a[data-read]') && !menu.mayLeave()) { ev.preventDefault(); return; }
    const link = ev.target.closest('a[data-series]');
    if (link && !menu.mayLeave()) { ev.preventDefault(); return; }
    if (link && plainClick(ev)) { ev.preventDefault(); close(); openSeries(Number(link.dataset.series)); return; }
    if (ev.target.closest('[data-full-cover]')) {
      const img = root.querySelector('.cover-preview img.cover');
      if (img) showFullCover(img.src);
      return;
    }
    const act = ev.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'duplicates') { compareCopies(b); return; }
      // A fix is undone, or one not applied removed, and the list shows again in place.
      if (act === 'undo-fix' || act === 'remove-fix') {
        if (!confirm(act === 'undo-fix' ? 'Undo this fix? The text goes back to how it was.' : 'Remove this fix from the list?')) return;
        const button = ev.target.closest('button[data-act]');
        button.disabled = true;
        try {
          await api(`/api/books/${b.id}/fixes/${button.dataset.fix}`, { method: 'DELETE' });
        } finally {
          button.disabled = false;
        }
        await showFixes(b, fixes);
        return;
      }
      if (act === 'delete') {
        if (!confirm(`Delete "${b.title}" for everyone? This cannot be undone.`)) return;
        await api(`/api/books/${b.id}`, { method: 'DELETE' });
      } else if (act === 'reprocess') {
        await api(`/api/books/${b.id}/reprocess`, { method: 'POST' });
      } else if (act === 'reset') {
        if (!confirm('Forget your reading position for this book?')) return;
        await api(`/api/books/${b.id}/progress`, { method: 'DELETE' });
      }
      close();
      await load();
    } catch (err) { toast(err.message); }
  });
  if (canEdit) editBook(b, menu);
}

/** Who is reading a book, how far they are and when they last read, filled in once the server says. */
async function showReaders(b, box) {
  let html;
  try {
    const { readers } = await api(`/api/books/${b.id}/readers`);
    html = readers.length ? `<ul class="reader-list">${readers.map((r) => {
      const pct = Math.round(r.percent * 100);
      return `<li><span class="who">${escapeHtml(r.displayName || r.username)}${r.username === me.username ? ' (you)' : ''}</span><div class="progress"><div style="width:${pct}%"></div></div><span class="pct">${pct}%</span><span class="when">${formatDate(r.updatedAt)}</span></li>`;
    }).join('')}</ul>` : '<p class="muted">Nobody has started this book yet.</p>';
  } catch {
    html = '<p class="muted">The readers could not be loaded.</p>';
  }
  if (box.isConnected) box.innerHTML = html; // unless the menu was closed meanwhile
}

/**
 * The fixes made to a book's text, for admins, newest first: what each changed, who made it and when, and Undo, or
 * Remove for one whose text the last conversion did not find. The part stays hidden while the book has none.
 */
async function showFixes(b, part) {
  let html = '';
  try {
    const { fixes } = await api(`/api/books/${b.id}/fixes`);
    if (fixes.length) html = `<ul class="fix-list">${fixes.map((f) => `<li>
      <p class="change">${changeHtml(f.before, f.after)}</p>
      <p class="who">${escapeHtml([f.by, formatDate(f.createdAt)].filter(Boolean).join(', '))}</p>
      ${f.applied ? '' : '<p class="not-applied">Not applied: its text was not found when the book was last converted.</p>'}
      <button type="button" class="btn small" data-act="${f.applied ? 'undo-fix' : 'remove-fix'}" data-fix="${f.id}">${f.applied ? 'Undo' : 'Remove'}</button>
    </li>`).join('')}</ul>`;
  } catch {
    html = '<p class="muted">The fixes could not be loaded.</p>';
  }
  if (!part.isConnected) return; // the menu was closed meanwhile
  part.querySelector('[data-fixes]').innerHTML = html;
  part.classList.toggle('hidden', !html);
}

// What a fix changed, shown in one line: about this much of the text that stayed on each side, and at most about
// this much of what was taken out and of what was put in.
const AROUND = 40;
const MOST_CHANGED = 200;
const lastWords = (text) => {
  if (text.length <= AROUND) return text;
  const end = text.slice(-AROUND);
  return `…${end.slice(end.search(/\s/) + 1)}`;
};
const firstWords = (text, most = AROUND) => {
  if (text.length <= most) return text;
  const start = text.slice(0, most);
  const space = start.search(/\s\S*$/);
  return `${space > 0 ? start.slice(0, space) : start}…`;
};
// A changed part marked with `tag`, the white space at its ends left outside the mark.
const marked = (tag, text) => {
  const core = text.trim();
  if (!core) return text;
  return `${text.slice(0, text.indexOf(core))}<${tag}>${escapeHtml(firstWords(core, MOST_CHANGED))}</${tag}>${text.slice(text.indexOf(core) + core.length)}`;
};

/**
 * The words a fix took out struck through and those it put in marked, with some of the text around them. The texts
 * before and after are compared as one each, the paragraphs joined with a pilcrow; the part between where they first
 * and last differ is the change, widened to whole words.
 */
function changeHtml(before, after) {
  const was = before.join(' ¶ ');
  const now = after.join(' ¶ ');
  const edge = (s, i) => i <= 0 || i >= s.length || /\s/.test(s[i - 1]) || /\s/.test(s[i]);
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  while (!(edge(was, head) && edge(now, head))) head--;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  while (!(edge(was, was.length - tail) && edge(now, now.length - tail))) tail--;
  const out = marked('del', was.slice(head, was.length - tail));
  const into = marked('ins', now.slice(head, now.length - tail));
  return `${escapeHtml(lastWords(was.slice(0, head)))}${out}${out.trim() && into.trim() ? ' ' : ''}${into}${escapeHtml(firstWords(was.slice(was.length - tail)))}`;
}

/**
 * A cover at full size over the menu, as large as the screen allows and never larger than the picture.
 * A click anywhere or Escape puts it away, and leaves the menu as it was.
 */
function showFullCover(src) {
  const view = document.createElement('div');
  view.className = 'cover-full';
  view.setAttribute('role', 'dialog');
  view.setAttribute('aria-label', 'Cover at full size');
  view.tabIndex = -1;
  view.innerHTML = `<img alt="" src="${escapeHtml(src)}"><p class="hint">Click or press Escape to close.</p>`;
  const back = document.activeElement;
  const done = () => { view.remove(); document.removeEventListener('keydown', onKey, true); back?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
  view.addEventListener('click', done);
  document.addEventListener('keydown', onKey, true);
  els.dialogRoot.append(view);
  view.focus();
}

/**
 * A book beside the books it looks like, to keep the right one: each with its format, size, who added it
 * and who is reading it, and ways to delete it or say it is a different book. The dialog stays open while
 * any of them still looks like another.
 */
function compareCopies(b) {
  const others = b.duplicates.map((d) => ({ book: books.find((x) => x.id === d.id), reason: d.reason })).filter((o) => o.book);
  const canDelete = (x) => me.isAdmin || x.addedById === me.id;
  const canSeparate = (x) => me.isAdmin || x.addedById === me.id || b.addedById === me.id;
  const copy = (x, reason) => `<div class="copy">
      <div class="thumb">${coverHtml(x)}</div>
      <div class="body">
        <div class="title">${escapeHtml(x.title)}</div>
        ${x.author ? `<div class="about">${escapeHtml(x.author)}</div>` : ''}
        <div class="about">${x.format.toUpperCase()} · ${(x.size / 1048576).toFixed(1)} MB · added by ${escapeHtml(x.addedBy || 'unknown')} ${formatDate(x.addedAt)}</div>
        ${reason ? `<div class="about why">${escapeHtml(likeness(reason, b, x).replace(/^t/, 'T'))}</div>` : ''}
        <div class="about" data-readers="${x.id}"></div>
      </div>
      <div class="row">
        ${x.status === 'ready' ? `<a class="btn small" href="/read/${x.id}">Open</a>` : ''}
        ${reason && canSeparate(x) ? `<button type="button" class="btn small" data-different="${x.id}">Not the same book</button>` : ''}
        ${canDelete(x) ? `<button type="button" class="btn small danger" data-delete="${x.id}">Delete</button>` : ''}
      </div>
    </div>`;
  const { root, close } = dialog(`
    <h2>Possible duplicates</h2>
    <p class="muted hint">These look like the same book. Keep the one you want and delete the others, or say which is a different book.</p>
    <div class="copies">${copy(b)}${others.map((o) => copy(o.book, o.reason)).join('')}</div>
    <div class="row"><button type="button" class="btn" data-close>Close</button></div>`);
  root.classList.add('compare');
  // Who is reading which: the one to keep is usually the one being read.
  for (const x of [b, ...others.map((o) => o.book)]) {
    api(`/api/books/${x.id}/readers`).then(({ readers }) => {
      const line = root.querySelector(`[data-readers="${x.id}"]`);
      if (line) line.textContent = readers.length ? `Read by ${readers.map((r) => `${r.displayName || r.username} (${Math.round(r.percent * 100)}%)`).join(', ')}` : 'Nobody has started it';
    }, () => {});
  }
  root.addEventListener('click', async (ev) => {
    const del = ev.target.closest('[data-delete]');
    const apart = ev.target.closest('[data-different]');
    if (!del && !apart) return;
    try {
      if (del) {
        const x = books.find((y) => y.id === del.dataset.delete);
        if (!confirm(`Delete this ${x.format.toUpperCase()} of "${x.title}" for everyone? Reading positions and bookmarks in it go with it. This cannot be undone.`)) return;
        await api(`/api/books/${x.id}`, { method: 'DELETE' });
      } else {
        await api(`/api/books/${b.id}/not-duplicate`, { method: 'POST', body: { of: apart.dataset.different } });
      }
      await load();
      // Go on with whatever among these books still looks like another, or close when nothing does.
      const next = [b, ...others.map((o) => o.book)].map((x) => books.find((y) => y.id === x.id)).find((x) => x && flagged(x));
      if (next) compareCopies(next);
      else close();
    } catch (err) { toast(err.message); }
  });
}

const seriesRow = (s = { name: '', position: null }) => `<div class="series-row">
    <input type="text" name="series-name" list="series-names" value="${escapeHtml(s.name)}" placeholder="Series or collection" aria-label="Series or collection" maxlength="200" autocomplete="off">
    <input type="text" name="series-no" value="${numberIn(s) ?? ''}" placeholder="No." aria-label="Number in the series" maxlength="20" autocomplete="off">
    <button type="button" class="btn icon" data-remove-row aria-label="Remove">&times;</button>
  </div>`;
/** Adds an empty row under a book's series and collections, and gives it. */
const addSeriesRow = (rows) => { rows.insertAdjacentHTML('beforeend', seriesRow()); return rows.lastElementChild; };

// The catalogues the server looks books up in.
const CATALOGUES = { hardcover: 'Hardcover', openlibrary: 'Open Library' };

/**
 * A book found online, offered in a book's menu: choosing it (anywhere on it) fills in the details, and
 * "Use cover" takes its cover. "More covers" shows the other covers the catalogue has for it, such as
 * its editions', under it; choosing one takes just that cover. The sizes of the covers are filled in
 * once they have loaded (see showSize()).
 */
const matchRow = (m, i) => {
  const about = [m.series.map(seriesLabel).join(', '), m.byIsbn ? 'Same ISBN as the file' : ''].filter(Boolean).join(' · ');
  const buttons = [
    m.cover && m.coverId ? `<button type="button" class="btn small" data-take-cover="${i}">Use cover</button>` : '',
    m.covers.length ? `<button type="button" class="btn small" data-more-covers aria-expanded="false">More covers (${m.covers.length})</button>` : '',
  ].join('');
  return `<div class="match" data-match="${i}">
    ${m.cover ? `<img class="cover" src="${escapeHtml(m.cover)}" alt="" loading="lazy">` : '<span class="cover"></span>'}
    <span class="body">
      <button type="button" class="pick">
        <span class="title">${escapeHtml(m.title)}</span>
        <span class="about">${escapeHtml([m.author, m.year, CATALOGUES[m.source]].filter(Boolean).join(' · '))}</span>
        ${about ? `<span class="about">${escapeHtml(about)}</span>` : ''}
      </button>
      ${m.cover ? '<span class="about" data-size>Cover loading…</span>' : ''}
      ${buttons ? `<span class="buttons">${buttons}</span>` : ''}
    </span>
    ${m.covers.length ? `<span class="more-covers hidden">${m.covers.map((c, j) => `<button type="button" class="cover-choice" data-cover-choice="${j}">
      <img src="${escapeHtml(c.cover)}" alt="" loading="lazy"><span class="sr-only">Cover ${j + 1}: </span><span class="about" data-size></span></button>`).join('')}</span>` : ''}
  </div>`;
};

/**
 * Writes the size of an image in pixels into `label` once it has loaded, so a sharp cover can be told
 * from a small one. `text` words it, and is given null when the image could not be loaded.
 */
function showSize(img, label, text) {
  const show = () => { label.textContent = text(img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight} pixels` : null); };
  if (img.complete) show();
  else {
    img.addEventListener('load', show, { once: true });
    img.addEventListener('error', show, { once: true });
  }
}

/** The genres in the library, each spelled as its books have it, in alphabetical order. */
const genreNames = () => [...new Map(books.filter((b) => b.genre).map((b) => [genreKey(b.genre), b.genre])).values()].sort((x, y) => x.localeCompare(y));
const genreList = (names) => `<datalist id="genre-names">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`;

/** The middle of a book's menu, for the uploader or an admin: the cover and the details, which one Save in the bar keeps. */
function bookFormHtml(b) {
  const names = [...new Set(books.flatMap((x) => x.series.map((s) => s.name)))].sort((x, y) => x.localeCompare(y));
  const page = b.format !== 'pdf' ? '' : `<div class="cover-page row">
          <button type="button" class="btn small" data-page>Use page</button>
          <span class="page-no"><input type="number" name="page" value="1" min="1"${b.pageCount ? ` max="${b.pageCount}"` : ''} aria-label="Page of the PDF">
            ${b.pageCount ? `<span class="muted">of ${b.pageCount}</span>` : ''}</span>
        </div>`;
  return `<p class="error book-error hidden" data-error></p>
  <form class="book-edit" id="bk-edit" novalidate>
    <h3 class="area-name">Details and cover</h3>
    <div class="cover-edit">
      <div class="cover-preview"><button type="button" class="cover-button" data-cover data-full-cover aria-label="Show the cover at full size"></button><p class="size" data-size></p></div>
      <div class="cover-actions">
        <p class="cover-note hidden" data-note aria-live="polite"></p>
        <button type="button" class="btn small" data-full-cover>Show at full size</button>
        <button type="button" class="btn small" data-pick>Choose an image</button>
        ${page}
        <button type="button" class="btn small" data-source="file">Use the original cover</button>
        <button type="button" class="btn small" data-source="none">Remove cover</button>
        <button type="button" class="btn small" data-undo>Keep the cover as it was</button>
        ${matchMedia('(pointer: fine)').matches ? '<p class="muted hint">Or paste an image, or drop one on the page.</p>' : ''}
        <p class="muted hint hidden" data-busy></p>
        <div class="earlier-covers hidden" role="group" aria-labelledby="ed-earlier">
          <p class="earlier-name" id="ed-earlier">Earlier covers</p>
          <div class="choices" data-earlier></div>
        </div>
      </div>
    </div>
    <div class="field f-title"><label for="ed-title">Title</label><input id="ed-title" name="title" value="${escapeHtml(b.title)}" maxlength="500"></div>
    <div class="field f-author"><label for="ed-author">Author</label><input id="ed-author" name="author" value="${escapeHtml(b.author || '')}" maxlength="500"></div>
    <div class="lookup">
      <button type="button" class="btn small" data-lookup>Look up online</button>
      <div class="found">
        <div data-matches aria-live="polite"></div>
        <div data-picked aria-live="polite"></div>
      </div>
    </div>
    <fieldset class="field f-series">
      <legend>Series and collections</legend>
      <div class="series-rows">${(b.series.length ? b.series : [undefined]).map((s) => seriesRow(s)).join('')}</div>
      <button type="button" class="btn small" data-add-row>Add to another</button>
      <p class="muted hint">The number puts a series in order (1, 2, 2.5 …); a book holding several, such as an omnibus, takes a range (1-3). Leave it empty for a collection without an order.</p>
    </fieldset>
    <div class="field f-genre"><label for="ed-genre">Genre</label><input id="ed-genre" name="genre" list="genre-names" value="${escapeHtml(b.genre || '')}" maxlength="100" autocomplete="off"></div>
    <input type="file" accept="image/*" class="hidden" data-file>
    <datalist id="series-names">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>${genreList(genreNames())}
  </form>`;
}

/**
 * The details and the cover in a book's menu at work. Nothing is sent until Save, and Save sends only what
 * was changed: a title, author or series sent counts as edited by hand, and then wins over the book's file
 * whenever it is converted again, so a new cover alone leaves them as the file has them. Save is open only
 * while something differs from the book as saved, and closing the menu then asks first.
 */
function editBook(b, menu) {
  const { root, close } = menu;
  const form = root.querySelector('.book-edit');
  const rows = form.querySelector('.series-rows');
  const error = root.querySelector('[data-error]');
  const saveBtn = root.querySelector('[data-save]');
  const coverBox = form.querySelector('[data-cover]');
  const sizeNote = form.querySelector('.cover-preview [data-size]');
  const note = form.querySelector('[data-note]');
  const busyNote = form.querySelector('[data-busy]');
  const fileInput = form.querySelector('[data-file]');
  const earlierList = form.querySelector('[data-earlier]');
  // What went wrong shows above the details, near Save in the bar.
  const fail = (message) => { error.textContent = message; error.classList.remove('hidden'); error.scrollIntoView({ block: 'nearest' }); };

  // What the form says, read as it is drawn and again on Save, which sends what differs.
  const readDetails = () => ({
    title: form.elements.title.value.trim(),
    author: form.elements.author.value.trim(),
    series: [...rows.querySelectorAll('.series-row')]
      .map((r) => ({ name: r.querySelector('[name="series-name"]').value.trim(), position: r.querySelector('[name="series-no"]').value.trim() || null }))
      .filter((s) => s.name),
    genre: form.elements.genre.value.trim(),
  });
  const before = readDetails();
  const differs = (now, key) => JSON.stringify(now[key]) !== JSON.stringify(before[key]);
  // Something to save: a detail that differs from the book as saved, or a cover chosen.
  const dirty = () => !!pending || ['title', 'author', 'series', 'genre'].some((key) => differs(readDetails(), key));
  const markDirty = () => { if (!busy && !saving) saveBtn.disabled = !dirty(); };
  menu.mayLeave = () => saving || !dirty() || confirm('Close without saving? Your changes to this book will be lost.');

  let pending = null; // the cover the book gets when saved, null to leave it: { src, source, says, body }
  let busy = false; // a picture is being prepared
  let saving = false;
  let earlier = []; // the covers the book had before, most recent first: [{ id, url }]
  const lookup = lookUpOnline(root, form, { book: () => b, matchCover });

  // The cover area, from the cover to be saved or else the book's own: the picture, its size, the note that it
  // is not saved yet, and the ways to change it that make sense from there.
  function showCover() {
    const typed = { ...b, title: form.elements.title.value, author: form.elements.author.value };
    coverBox.innerHTML = pending ? coverHtml(typed, pending.src) : coverHtml(typed);
    const img = coverBox.querySelector('img');
    sizeNote.textContent = '';
    // A picture replaced before it loaded leaves the size of the one shown now alone.
    if (img) showSize(img, sizeNote, (size) => (img.isConnected ? (size ?? '') : sizeNote.textContent));
    note.textContent = pending ? `${pending.says}. Not saved yet.` : '';
    note.classList.toggle('hidden', !pending);
    form.querySelector('[data-source="file"]').classList.toggle('hidden', (pending ? pending.source : b.coverSource) === 'file' || !b.fileHasCover);
    form.querySelector('[data-source="none"]').classList.toggle('hidden', !img);
    coverBox.disabled = !img;
    form.querySelector('.cover-actions [data-full-cover]').classList.toggle('hidden', !img);
    form.querySelector('[data-undo]').classList.toggle('hidden', !pending);
    markEarlier();
  }

  // The covers the book had before, under the ways to change it. Asked for each time the menu opens, so
  // they follow what was saved.
  async function loadEarlier() {
    try {
      ({ covers: earlier } = await api(`/api/books/${b.id}/covers`));
    } catch {
      earlier = [];
    }
    if (!root.isConnected) return; // the menu was closed meanwhile
    earlierList.innerHTML = earlier.map((c, i) => `<button type="button" class="cover-choice" data-earlier-cover="${i}"${busy || saving ? ' disabled' : ''}>
      <img class="cover" src="${escapeHtml(c.url)}" alt="" loading="lazy"><span class="sr-only">Earlier cover ${i + 1}</span></button>`).join('');
    earlierList.parentElement.classList.toggle('hidden', !earlier.length);
    markEarlier();
  }

  // Marks the earlier cover to be saved, if one is.
  function markEarlier() {
    const chosen = pending?.body?.source === 'earlier' ? pending.body.id : null;
    for (const btn of earlierList.children) btn.classList.toggle('chosen', earlier[Number(btn.dataset.earlierCover)]?.id === chosen);
  }

  // Every change of the cover to be saved comes through here, which lets go of a picture no longer shown.
  function setPending(next) {
    if (pending?.src?.startsWith('blob:') && pending.src !== next?.src) URL.revokeObjectURL(pending.src);
    pending = next;
    showCover();
    markDirty();
  }

  // A cover chosen by hand, or null for one the book has already: it takes the place of a match's cover.
  function chooseCover(next) {
    setPending(next);
    lookup.leave();
  }

  // A match's cover, taken with "Use cover" or from "More covers": the cover the book gets when saved.
  function matchCover(m) {
    setPending({ src: m.cover, source: 'custom', says: `Cover from ${CATALOGUES[m.source]}`, body: { source: m.coverSource, coverId: m.coverId } });
  }

  // While a picture is prepared or the book saved, the cover's buttons and Save wait.
  function lock(on) {
    for (const el of form.querySelectorAll('.cover-actions button, .cover-actions input')) el.disabled = on;
    saveBtn.disabled = on || !dirty();
  }

  // An image read and scaled, or a page of the PDF drawn, by `work`, which gives { blob, says }.
  async function prepare(doing, work) {
    if (busy || saving) return;
    busy = true;
    lock(true);
    error.classList.add('hidden');
    busyNote.textContent = doing;
    busyNote.classList.remove('hidden');
    try {
      const { blob, says } = await work();
      if (root.isConnected) chooseCover({ src: URL.createObjectURL(blob), source: 'custom', says, body: blob });
    } catch (err) {
      fail(err.message);
    } finally {
      busy = false;
      lock(false);
      busyNote.classList.add('hidden');
    }
  }
  const useFile = (file) => prepare('Preparing the cover…', async () => ({ blob: await coverImage(file), says: 'New cover' }));
  // Most PDFs have no cover image, but their first page usually is the cover.
  function usePage() {
    const input = form.elements.page;
    prepare(`Preparing page ${input.value || 1}…`, async () => {
      const { renderPdfPage } = await import('./pdf-view.js');
      const { canvas, page } = await renderPdfPage(`/books/${b.id}/original`, Number(input.value), COVER_SIDE);
      input.value = page;
      return { blob: await toJpeg(canvas), says: `Page ${page} of the PDF` };
    });
  }
  coverEditor = { root, useFile };
  showCover();
  loadEarlier();

  form.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-add-row]')) addSeriesRow(rows).querySelector('input').focus();
    const remove = ev.target.closest('[data-remove-row]');
    if (remove) {
      const row = remove.closest('.series-row');
      if (rows.children.length > 1) row.remove(); else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
    }
    if (ev.target.closest('[data-pick]')) fileInput.click();
    if (ev.target.closest('[data-page]')) usePage();
    const source = ev.target.closest('[data-source]')?.dataset.source;
    if (source === 'file') chooseCover(b.coverSource === 'file' ? null : { src: `/books/${b.id}/cover?source=file&v=${b.convertedAt}`, source: 'file', says: 'The original cover', body: { source: 'file' } });
    if (source === 'none') chooseCover(b.hasCover ? { src: null, source: 'none', says: 'No cover', body: { source: 'none' } } : null);
    const again = earlier[Number(ev.target.closest('[data-earlier-cover]')?.dataset.earlierCover)];
    if (again) chooseCover({ src: again.url, source: 'custom', says: 'An earlier cover', body: { source: 'earlier', id: again.id } });
    if (ev.target.closest('[data-undo]')) { setPending(null); lookup.leave(); }
  });
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (file) useFile(file);
  });
  // Enter in the page field uses the page, rather than saving the form.
  form.elements.page?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    usePage();
  });
  // Without a picture, the cover is a tile with the title and author as they are typed.
  form.addEventListener('input', (ev) => {
    if (['title', 'author'].includes(ev.target.name) && !coverBox.querySelector('img')) showCover();
    markDirty();
  });
  // A series row removed, or a match chosen, changes the form without typing; checked once every click handler has run.
  form.addEventListener('click', () => setTimeout(markDirty));

  const sendCover = (body) => api(`/api/books/${b.id}/cover`, body instanceof Blob
    ? { method: 'PUT', raw: true, body, headers: { 'Content-Type': body.type || 'application/octet-stream' } }
    : { method: 'PUT', body });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy || saving) return;
    const now = readDetails();
    const bad = now.series.find((s) => s.position != null && !/^\d{1,5}([.,]\d+)?(\s*[-–—]\s*\d{1,5}([.,]\d+)?)?$/.test(s.position));
    if (!now.title) return fail('The book needs a title.');
    if (bad) return fail(`The number for "${bad.name}" must be a number, such as 3 or 2.5, or a range for a book holding several, such as 1-3.`);
    // The title, author and series go together, and only when one of them changed; the genre goes on its own.
    const details = ['title', 'author', 'series'].some((key) => differs(now, key)) ? { title: now.title, author: now.author, series: now.series } : {};
    if (differs(now, 'genre')) details.genre = now.genre;
    saving = true;
    lock(true);
    saveBtn.textContent = 'Saving…';
    let coverSaved = false;
    try {
      // The cover first: when it cannot be kept, nothing has changed yet. Once it is, the menu shows it as
      // saved, so a failure of the details leaves the menu true to the server.
      if (pending) {
        ({ book: b } = await sendCover(pending.body));
        coverSaved = true;
        setPending(null);
      }
      if (Object.keys(details).length) await api(`/api/books/${b.id}`, { method: 'PATCH', body: details });
      close();
      await load();
    } catch (err) {
      fail(err.message);
      // The library behind the menu shows the new cover, and the menu the covers it replaced.
      if (coverSaved) { load(); loadEarlier(); }
    } finally {
      saving = false;
      lock(false);
      saveBtn.textContent = 'Save';
    }
  });
}

/**
 * Look up online, in a book's menu: a match chosen fills in the title, author and series and leaves the
 * cover alone, which changes only with "Use cover" or a cover under "More covers". `book()` is the book as
 * saved now, and `matchCover(m)` is given the match whose cover was taken. Gives `leave()`, for a cover
 * chosen by hand or the one the book had, which takes the mark off the cover taken.
 */
function lookUpOnline(root, form, { book, matchCover }) {
  const lookupBtn = form.querySelector('[data-lookup]');
  const matches = form.querySelector('[data-matches]');
  const picked = form.querySelector('[data-picked]');
  const rows = form.querySelector('.series-rows');
  let found = [];
  let filled = null; // the match the form was filled in from
  let coverFrom = null; // the match whose cover was taken, or one of its other covers
  // On a wide screen the menu grows, with the matches beside the form, once there is something to show there.
  const widen = () => root.classList.toggle('wide', found.length > 0 || !!filled);
  // The book's cover now, which the covers found are compared with.
  const currentCover = () => {
    const b = book();
    return b.hasCover ? Object.assign(new Image(), { src: `/books/${b.id}/cover?v=${b.coverVersion}` }) : null;
  };

  // Searches the catalogues for the title and author as typed (and the ISBN in the file).
  async function lookUp() {
    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Looking up…';
    matches.innerHTML = '';
    found = [];
    const current = currentCover();
    try {
      const query = new URLSearchParams({ title: form.elements.title.value.trim(), author: form.elements.author.value.trim() });
      const answer = await api(`/api/books/${book().id}/lookup?${query}`);
      found = answer.results;
      // A catalogue that could not be asked, such as Hardcover with an expired token, is said first, where it is seen.
      const notes = answer.notes.map((note) => `<p class="notice">${escapeHtml(note)}</p>`).join('');
      // Without a Hardcover token, an admin is told where to add one.
      const connect = me.isAdmin && !answer.sources.includes('hardcover')
        ? '<p class="muted hint">Hardcover is not connected. An admin can add a token under Settings to search it too.</p>' : '';
      matches.innerHTML = notes + (found.length
        ? `<p class="muted hint">Choose the matching book to fill in the details. Use cover takes its cover. Nothing changes until you save.</p>
          ${current ? '<p class="muted hint" data-current></p>' : ''}<div class="matches">${found.map(matchRow).join('')}</div>`
        : `<p class="muted hint">No match on ${escapeHtml(answer.sources.map((s) => CATALOGUES[s]).join(' or '))}. Try a shorter title, or leave out the author.</p>`) + connect;
      if (found.length && current) showSize(current, matches.querySelector('[data-current]'), (size) => (size ? `The current cover is ${size}.` : ''));
      for (const row of matches.querySelectorAll('.match')) {
        const img = row.querySelector('img.cover');
        if (img) showSize(img, row.querySelector('[data-size]'), (size) => (size ? `Cover ${size}` : 'The cover could not be loaded'));
      }
      // Under a match's other covers, their sizes without "pixels", for room.
      for (const choice of matches.querySelectorAll('.cover-choice')) {
        showSize(choice.querySelector('img'), choice.querySelector('[data-size]'), (size) => (size ? size.replace(' pixels', '') : 'Not loaded'));
      }
    } catch (err) {
      matches.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = 'Look up online';
      widen();
    }
  }

  // Says where the details came from, and marks in the list the match they came from and the cover taken.
  function showPicked() {
    picked.innerHTML = filled ? `<p class="hint">Filled in from <a href="${escapeHtml(filled.url)}" target="_blank" rel="noopener">${CATALOGUES[filled.source]}</a>. Check the details, then save.</p>` : '';
    for (const row of matches.querySelectorAll('[data-match]')) row.classList.toggle('chosen', found[Number(row.dataset.match)] === filled);
    for (const btn of matches.querySelectorAll('[data-take-cover]')) btn.classList.toggle('chosen', found[Number(btn.dataset.takeCover)] === coverFrom);
    for (const btn of matches.querySelectorAll('[data-cover-choice]')) {
      const m = found[Number(btn.closest('[data-match]').dataset.match)];
      btn.classList.toggle('chosen', !!coverFrom && m.covers[Number(btn.dataset.coverChoice)].cover === coverFrom.cover);
    }
    widen();
  }

  // Fills in the title, author and series from a match; the cover stays as it is. Its series join the
  // rows already there; a series that is already listed takes the match's number.
  function useMatch(m) {
    filled = m;
    form.elements.title.value = m.title;
    if (m.author) form.elements.author.value = m.author;
    // As if typed, so the title tile in the cover's place follows
    form.elements.title.dispatchEvent(new Event('input', { bubbles: true }));
    const nameKey = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    for (const s of m.series) {
      const all = [...rows.querySelectorAll('.series-row')];
      const nameOf = (row) => row.querySelector('[name="series-name"]');
      const row = all.find((r) => nameKey(nameOf(r).value) === nameKey(s.name)) || all.find((r) => !nameOf(r).value.trim()) || addSeriesRow(rows);
      if (!nameOf(row).value.trim()) nameOf(row).value = s.name;
      if (s.position != null) row.querySelector('[name="series-no"]').value = numberIn(s);
    }
    showPicked();
    picked.scrollIntoView({ block: 'nearest' });
  }

  // Takes only a match's cover, which shows in the cover's place: the details stay as they are.
  function takeCover(m) {
    coverFrom = m;
    matchCover(m);
    showPicked();
  }

  // Shows or hides the other covers of the match in `row`.
  function toggleCovers(row, button) {
    const hidden = row.querySelector('.more-covers').classList.toggle('hidden');
    button.setAttribute('aria-expanded', String(!hidden));
    button.textContent = hidden ? `More covers (${found[Number(row.dataset.match)].covers.length})` : 'Hide covers';
  }

  form.querySelector('.lookup').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-lookup]')) { lookUp(); return; }
    const coverButton = ev.target.closest('[data-take-cover]');
    const moreButton = ev.target.closest('[data-more-covers]');
    const choice = ev.target.closest('[data-cover-choice]');
    const match = ev.target.closest('[data-match]');
    const m = match && found[Number(match.dataset.match)];
    if (coverButton) takeCover(found[Number(coverButton.dataset.takeCover)]);
    else if (moreButton) toggleCovers(match, moreButton);
    // One of its other covers is taken like its own with "Use cover".
    else if (choice) takeCover({ ...m, ...m.covers[Number(choice.dataset.coverChoice)] });
    else if (match && !ev.target.closest('.more-covers')) useMatch(m);
  });

  return {
    // A cover chosen by hand, or the one the book had, takes the place of the one taken from a match.
    leave() {
      coverFrom = null;
      showPicked();
    },
  };
}

// Covers are shown small, so a larger image is scaled down to this many pixels on its longer side and sent as a JPEG.
const COVER_SIDE = 1200;
const COVER_BYTES = 500 * 1024;

const toJpeg = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not prepare the image'))), 'image/jpeg', 0.85);
});

/** An image file ready to send as a cover: a small JPEG or PNG as it is, anything else redrawn as a JPEG. */
async function coverImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    const readable = await img.decode().then(() => img.naturalWidth > 0 && img.naturalHeight > 0, () => false);
    if (!readable) throw new Error(`${file.name ? `"${file.name}" is` : 'That is'} not an image this browser can read. Try a JPEG or PNG.`);
    const scale = Math.min(1, COVER_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size <= COVER_BYTES && /^image\/(jpeg|png)$/.test(file.type)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // see-through parts turn white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await toJpeg(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The missing books removed from a series (see missingOptions()), each with a button that shows it again.
const removedItems = (id, numbers) => numbers.map((n) => `<li><span class="name">${escapeHtml(missingName(listedMissing(id, n)))}</span>
  <button class="btn small" type="button" data-restore="${n}">Show again</button></li>`).join('');

/** Rename (or merge) and remove a whole series or collection, and show again the missing books removed from it. Admins only. */
function editSeries(id) {
  const g = groupSeries().find((x) => x.id === id);
  if (!g) return;
  const kind = g.numbered ? 'series' : 'collection';
  const others = groupSeries().filter((x) => x.id !== id).map((x) => x.name).sort((x, y) => x.localeCompare(y));
  const removed = removedMissing[id] || [];
  const { root, close } = dialog(`
    <h2>${escapeHtml(g.name)}</h2>
    <form class="details" novalidate>
      <div class="field">
        <label for="sr-name">Name</label><input id="sr-name" name="name" value="${escapeHtml(g.name)}" list="other-series" maxlength="200" autocomplete="off">
        <p class="muted hint">Give it the name of another series or collection to merge the two.</p>
      </div>
      <datalist id="other-series">${others.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>
      <p class="error hidden" data-error></p>
      <div class="row"><button class="btn primary" type="submit">Rename</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>
    ${removed.length ? `<section data-removed>
      <hr>
      <h3 class="area-name">Removed from the missing books</h3>
      <ul class="removed-list">${removedItems(id, removed)}</ul>
      <p class="muted hint">Nothing shows as missing at these numbers.</p>
    </section>` : ''}
    <hr>
    <button class="btn danger" type="button" data-remove-series>Remove this ${kind}</button>
    <p class="muted hint">Its ${plural(g.items.length, 'book stays', 'books stay')} in the library.</p>`);
  const form = root.querySelector('form');
  const error = root.querySelector('[data-error]');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const { series } = await api(`/api/series/${id}`, { method: 'PATCH', body: { name: form.elements.name.value } });
      if (series.id !== id) history.replaceState(null, '', `/?series=${series.id}`);
      close();
      await load();
    } catch (err) { error.textContent = err.message; error.classList.remove('hidden'); }
  });
  root.querySelector('[data-remove-series]').addEventListener('click', async () => {
    if (!confirm(`Remove the ${kind} "${g.name}"? Its books stay in the library.`)) return;
    try {
      await api(`/api/series/${id}`, { method: 'DELETE' });
      close();
      view = 'series';
      savePrefs();
      openedHere = false;
      history.replaceState(null, '', '/');
      await load();
    } catch (err) { toast(err.message); }
  });
  root.querySelector('[data-removed]')?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-restore]');
    if (!btn) return;
    const position = Number(btn.dataset.restore);
    try {
      const { removed: left } = await api(`/api/series/${id}/removed/${position}`, { method: 'DELETE' });
      removedMissing[id] = left;
      render();
      // The dialog stays open, for the name and the others; the list follows what the server says is left.
      if (left.length) root.querySelector('.removed-list').innerHTML = removedItems(id, left);
      else root.querySelector('[data-removed]').remove();
      toast(`${missingName(listedMissing(id, position))} shows as missing again`);
    } catch (err) { toast(err.message); }
  });
}

/**
 * The options of a book a series lacks: see it on Hardcover, or remove it from the series when it is shown
 * wrongly. Nothing then shows as missing at its number, a gap or a book Hardcover lists, until Rename or
 * remove shows it again (see editSeries()). No need to ask first, as it can be undone. Admins only.
 */
function missingOptions(seriesId, position) {
  const g = groupSeries().find((x) => x.id === seriesId);
  if (!g) return;
  const m = listedMissing(seriesId, position);
  const { root, close } = dialog(`
    <h2>${escapeHtml(missingName(m))}</h2>
    <p class="muted">${[m.author, missingState(m)].filter(Boolean).map(escapeHtml).join(' · ')}</p>
    <p>Shown by mistake? Remove it from ${escapeHtml(g.name)}, and nothing shows as missing at #${position}. <b>Rename or remove</b> on the series' page shows it again.</p>
    <div class="row">
      ${m.url ? `<a class="btn" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">See it on Hardcover</a>` : ''}
      <button class="btn" type="button" data-remove-missing>Remove from this series</button>
      <button class="btn" type="button" data-close>Close</button>
    </div>`);
  root.querySelector('[data-remove-missing]').addEventListener('click', async () => {
    try {
      const { removed } = await api(`/api/series/${seriesId}/removed/${position}`, { method: 'PUT' });
      removedMissing[seriesId] = removed;
      close();
      render();
      toast(`${missingName(m)} removed from ${g.name}`);
    } catch (err) { toast(err.message); }
  });
}

/**
 * The genre of several books at once: the books chosen, or a whole series. The one who added a book, or
 * an admin, can change it, so the books someone else added stay as they are, and the dialog says so.
 * `done` runs once the genre is saved.
 */
function editGenre(ids, done = () => {}) {
  const wanted = new Set(ids);
  const mine = books.filter((b) => wanted.has(b.id) && mayEdit(b));
  const others = books.filter((b) => wanted.has(b.id)).length - mine.length;
  const now = [...new Set(mine.map((b) => b.genre || ''))];
  const names = genreNames();
  const note = !others ? '' : `<p class="muted hint">${mine.length
    ? `The genre of ${plural(others, 'book', 'books')} added by someone else stays as it is: only the one who added a book, or an admin, can change it.`
    : 'Someone else added these books, and only the one who added a book, or an admin, can change its genre.'}</p>`;
  const { root, close } = dialog(`
    <h2>Genre</h2>
    ${mine.length ? `<form class="details" novalidate>
      <div class="field">
        <label for="gn-genre">Genre of ${plural(mine.length, 'book', 'books')}</label>
        <input id="gn-genre" name="genre" list="genre-names" value="${now.length === 1 ? escapeHtml(now[0]) : ''}" maxlength="100" autocomplete="off"${now.length > 1 ? ' placeholder="They have different genres now"' : ''}>
        ${names.length ? `<div class="genre-choices">${names.map((n) => `<button type="button" class="btn small" data-genre="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('')}</div>` : ''}
        <p class="muted hint">Choose a genre, or type a new one. Leave it empty for no genre.</p>
        ${note}
      </div>
      <p class="error hidden" data-error></p>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>${genreList(names)}` : `<div class="field">${note}</div><div class="row"><button class="btn" type="button" data-close>Close</button></div>`}`);
  const form = root.querySelector('form');
  if (!form) return;
  const input = form.elements.genre;
  const error = root.querySelector('[data-error]');
  // The genre in the box is marked among the buttons.
  const showChoice = () => {
    for (const btn of root.querySelectorAll('[data-genre]')) btn.setAttribute('aria-pressed', String(genreKey(btn.dataset.genre) === genreKey(input.value)));
  };
  showChoice();
  input.addEventListener('input', showChoice);
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-genre]');
    if (!btn) return;
    input.value = btn.dataset.genre;
    showChoice();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const save = form.querySelector('[type="submit"]');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const { genre, updated } = await api('/api/books', { method: 'PATCH', body: { ids: mine.map((b) => b.id), genre: input.value.trim() } });
      close();
      toast(genre ? `Genre of ${plural(updated, 'book', 'books')} set to ${genre}` : `Genre of ${plural(updated, 'book', 'books')} removed`);
      done();
      await load();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      save.disabled = false;
      save.textContent = 'Save';
    }
  });
}

els.library.addEventListener('click', (e) => {
  // While choosing books, a book, a series or a section's "Select all" chooses its books.
  const pick = selecting && e.target.closest('[data-pick], [data-pick-series], [data-pick-section]');
  if (pick) {
    const { pick: id, pickSeries } = pick.dataset;
    toggle(id ? [id] : pickSeries ? seriesBookIds().get(Number(pickSeries)) || [] : booksIn(pick.closest('section')));
    return;
  }
  const genreOf = e.target.closest('[data-genre-series]');
  if (genreOf) { editGenre(seriesBookIds().get(Number(genreOf.dataset.genreSeries)) || []); return; }
  const link = e.target.closest('a[data-series]');
  if (link && plainClick(e)) { e.preventDefault(); openSeries(Number(link.dataset.series)); return; }
  if (e.target.closest('[data-back]')) { closeSeries(); return; }
  const edit = e.target.closest('[data-edit-series]');
  if (edit) { editSeries(Number(edit.dataset.editSeries)); return; }
  const dups = e.target.closest('[data-dups]');
  if (dups) {
    const b = books.find((x) => x.id === dups.dataset.dups);
    if (b) compareCopies(b);
    return;
  }
  const lacks = e.target.closest('button[data-missing-menu]');
  if (lacks) {
    e.preventDefault();
    const [seriesId, position] = lacks.dataset.missingMenu.split(':').map(Number);
    missingOptions(seriesId, position);
    return;
  }
  const btn = e.target.closest('button[data-menu]');
  if (!btn) return;
  e.preventDefault();
  const b = books.find((x) => x.id === btn.dataset.menu);
  if (b) bookMenu(b);
});

// On a phone the tabs, search, menus, upload and account links sit behind the menu button.
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  els.menu.setAttribute('aria-expanded', String(open));
  els.menu.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  els.menu.innerHTML = open ? '&#10005;' : '&#9776;';
}
els.menu.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
els.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setMenu(false); els.search.blur(); } });
els.activeFilters.addEventListener('click', (e) => {
  if (!e.target.closest('[data-show-all]')) return;
  els.search.value = '';
  els.filter.value = 'all';
  savePrefs();
  render();
});

els.tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (!tab) return;
  setMenu(false);
  saveScroll();
  view = tab.dataset.view;
  savePrefs();
  if (openSeriesId() != null) { history.pushState(null, '', '/'); openedHere = false; }
  render();
  restoreScroll(0); // each tab comes back where it was
});
window.addEventListener('popstate', () => { openedHere = false; render(); restoreScroll(0); });
// Leaving the library, for a book or anything else, keeps its place; coming back to it from the back-forward
// cache puts it there again.
window.addEventListener('pagehide', saveScroll);
window.addEventListener('pageshow', (e) => { if (e.persisted) restoreScroll(); });
els.search.addEventListener('input', render);
els.filter.addEventListener('change', () => { savePrefs(); render(); });
els.sort.addEventListener('change', () => { savePrefs(); render(); });
els.group.addEventListener('change', () => { groupBy = els.group.value; savePrefs(); render(); });
els.layout.addEventListener('change', () => { layout = els.layout.value; savePrefs(); render(); });
els.display.addEventListener('change', () => { display = els.display.value; savePrefs(); render(); });
els.select.addEventListener('click', () => {
  setMenu(false);
  if (selecting) { stopSelecting(); return; }
  selecting = true;
  render();
});
els.selectBar.addEventListener('click', (e) => {
  const act = e.target.closest('[data-sel]')?.dataset.sel;
  if (act === 'all') {
    for (const id of booksIn(els.library)) selected.add(id);
    showSelection();
  } else if (act === 'clear') {
    selected.clear();
    showSelection();
  } else if (act === 'genre') editGenre([...selected], () => selected.clear());
  else if (act === 'done') stopSelecting();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selecting && !els.dialogRoot.childElementCount) stopSelecting(); });
document.getElementById('btn-logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); localStorage.removeItem(SAVED); location.href = '/login'; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') (offline ? start : load)(); });
window.addEventListener('online', () => { if (offline) start(); });

function start() {
  return requireUser().then((u) => {
    me = u;
    adoptAccountFont(u); // so books open in the account's font without a second layout
    if (u.isAdmin) document.getElementById('nav-users').classList.remove('hidden');
    return load();
  }).catch((err) => { if (!(err instanceof ApiError)) return showOffline(); });
}
start();
