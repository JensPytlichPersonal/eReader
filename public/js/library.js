import { api, ApiError, requireUser, escapeHtml, formatDate, toast, registerServiceWorker } from './api.js';
import { loadSettings, applyTheme, adoptAccountFont } from './settings.js';

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
  layout: document.getElementById('layout'),
  display: document.getElementById('display'),
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
let offline = false; // no connection: showing the books from the last time, with `kept` the ones this device can open
let kept = new Set();
let pollTimer = null;
let coverEditor = null; // the cover dialog, which takes images pasted or dropped on the page while it is open
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

function savePrefs() { localStorage.setItem('ereader.library', JSON.stringify({ sort: els.sort.value, filter: els.filter.value, view, layout, display })); }

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

async function load() {
  loadedAt = Date.now();
  let data;
  try {
    data = await api('/api/books');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return showOffline();
  }
  offline = false;
  books = data.books;
  supported = new Set(data.supported);
  try { if (me) localStorage.setItem(SAVED, JSON.stringify({ me, books })); } catch { /* storage full */ }
  render();
  const processing = books.some((b) => b.status === 'processing');
  clearTimeout(pollTimer);
  if (processing) pollTimer = setTimeout(load, 3000);
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
  }
  const here = 'caches' in window ? await Promise.all(books.map((b) => caches.match(`/books/${b.id}/book.json`).then((hit) => hit && b.id, () => null))) : [];
  kept = new Set(here.filter(Boolean));
  offline = true;
  render();
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

// Books and series sort alike: a series by its most recently read and newest book, its name and main author.
const sortKeys = (x) => (x.items
  ? { read: x.lastRead, added: x.lastAdded, title: x.name, author: x.author }
  : { read: x.progress?.updatedAt || 0, added: x.addedAt, title: x.title, author: x.author });

function sorter() {
  const by = {
    recent: (a, b) => b.read - a.read || b.added - a.added,
    added: (a, b) => b.added - a.added,
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.title.localeCompare(b.title),
  }[els.sort.value];
  return (a, b) => by(sortKeys(a), sortKeys(b));
}

const matchesSearch = (b, q) => `${b.title} ${b.author} ${b.series.map((s) => s.name).join(' ')}`.toLowerCase().includes(q);
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
const coverHtml = (b) => (b.hasCover && (b.status === 'ready' || b.coverSource === 'custom')
  ? `<img class="cover" loading="lazy" alt="" src="/books/${b.id}/cover?v=${b.coverVersion}">`
  : `<div class="cover placeholder"><div class="t">${escapeHtml(b.title)}</div><div class="a">${escapeHtml(b.author)}</div></div>`);

// A book that looks like another in the library says so, and the flag opens them side by side.
const dupFlag = (b) => (flagged(b) ? `<button type="button" class="dup-flag" data-dups="${b.id}">Possible duplicate</button>` : '');

/** A book card. In a series view (`ctx.seriesId`) the cover shows the book's number in that series (`ctx.position`, as numberIn() gives it). */
function card(b, ctx = {}) {
  if (display === 'list') return bookRow(b, ctx);
  const pct = b.progress ? Math.round(b.progress.percent * 100) : 0;
  const cover = coverHtml(b);
  const number = ctx.position != null ? `<span class="cover-tag">#${ctx.position}</span>` : '';
  const st = b.status === 'processing' ? '<div class="status">Preparing…</div>' : b.status === 'error' ? `<div class="status err" title="${escapeHtml(b.error || '')}">Could not convert</div>` : '';
  const link = b.status === 'ready' ? `<a class="link" href="/read/${b.id}" aria-label="Read ${escapeHtml(b.title)}"></a>` : '';
  const others = b.series.filter((s) => s.id !== ctx.seriesId);
  const seriesHtml = others.length ? `<div class="series-line">${others.map(seriesLink).join(', ')}</div>` : '';
  const progressHtml = b.progress ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : '';
  const when = b.progress ? `Read ${formatDate(b.progress.updatedAt)}` : `Added ${formatDate(b.addedAt)}`;
  return `<div class="card${faded(b) ? ' unavailable' : ''}" data-id="${b.id}">
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
  return `<div class="list-row${ctx.current ? ' current' : ''}${faded(b) ? ' unavailable' : ''}" data-id="${b.id}">
    <div class="thumb">${coverHtml(b)}</div>
    ${b.status === 'ready' ? `<a class="link" href="/read/${b.id}" aria-label="Read ${escapeHtml(b.title)}"></a>` : ''}
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

/** A series or collection as one tile: a stack of books with the one you're on as the top cover. */
function stackCard(g) {
  if (display === 'list') return groupRow(g);
  const n = g.items.length;
  const place = seriesPlace(g);
  const cover = coverHtml((place.item || g.items[0]).book);
  const pct = groupPct(g);
  return `<div class="card group${n > 1 ? ' pile' : ''}">
    ${n > 1 ? `<div class="stack">${cover}</div>` : cover}<span class="cover-tag">${plural(n, 'book', 'books')}</span>
    <a class="link" href="/?series=${g.id}" data-series="${g.id}" aria-label="${escapeHtml(g.name)}, ${plural(n, 'book', 'books')}"></a>
    <div class="info">
      <div class="title">${escapeHtml(g.name)}</div>
      <div class="author">${escapeHtml(g.author)}</div>
      ${g.state !== 'unread' ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : ''}
      <div class="meta"><span class="place">${escapeHtml(place.text)}</span></div>
    </div>
  </div>`;
}

/** A series or collection as a row of the list view. */
function groupRow(g) {
  const n = g.items.length;
  const place = seriesPlace(g);
  const about = [g.author, plural(n, 'book', 'books')].filter(Boolean).map(escapeHtml).join(' · ');
  return `<div class="list-row group">
    <div class="thumb${n > 1 ? ' stack' : ''}">${coverHtml((place.item || g.items[0]).book)}</div>
    <a class="link" href="/?series=${g.id}" data-series="${g.id}" aria-label="${escapeHtml(g.name)}, ${plural(n, 'book', 'books')}"></a>
    <div class="body">
      <div class="title">${escapeHtml(g.name)}</div>
      <div class="about">${about}</div>
      <div class="meta">${g.state !== 'unread' ? `<div class="progress"><div style="width:${groupPct(g)}%"></div></div>` : ''}<span class="place">${escapeHtml(place.text)}</span></div>
    </div>
    <span class="chevron" aria-hidden="true">&#8250;</span>
  </div>`;
}

/** A series as a shelf: every book in order with its title, and the book you're on outlined. */
function shelf(g) {
  const place = seriesPlace(g);
  const facts = [g.author, plural(g.items.length, 'book', 'books'), place.text].filter(Boolean).map(escapeHtml).join(' · ');
  const shelfBook = ({ book: b, ...place }, current) => {
    const st = status(b);
    const pct = b.progress ? Math.round(b.progress.percent * 100) : 0;
    const state = { finished: '&#10003; Finished', reading: `${pct}% read`, unread: 'Not started', processing: 'Preparing…', error: 'Could not convert' }[st];
    return `<div class="shelf-book${current ? ' current' : ''}">
      ${coverHtml(b)}${place.position != null ? `<span class="cover-tag">#${numberIn(place)}</span>` : ''}
      ${b.status === 'ready' ? `<a class="link" href="/read/${b.id}" aria-label="Read ${escapeHtml(b.title)}"></a>` : ''}
      <div class="title">${escapeHtml(b.title)}</div>
      ${st === 'reading' ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : ''}
      <div class="state">${state}</div>
    </div>`;
  };
  const current = (i) => i === place.item && g.state !== 'unread';
  const books = display === 'list'
    ? tiles(g.items.map((i) => bookRow(i.book, { seriesId: g.id, position: numberIn(i), current: current(i) })).join(''))
    : `<div class="shelf-row">${g.items.map((i) => shelfBook(i, current(i))).join('')}</div>`;
  return `<section class="shelf">
    <div class="shelf-head"><h2><a href="/?series=${g.id}" data-series="${g.id}">${escapeHtml(g.name)}</a></h2><span class="muted">${facts}</span></div>
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
      <p>Books join a series by themselves when their details name one. To group any books, choose <b>Edit details</b> in a book's &#8943; menu.</p></div>`;
    return;
  }
  const q = els.search.value.trim().toLowerCase();
  const f = els.filter.value;
  const list = all.filter((g) => {
    if (q && !`${g.name} ${g.items.map((i) => `${i.book.title} ${i.book.author}`).join(' ')}`.toLowerCase().includes(q)) return false;
    if (f === 'duplicates') return g.items.some((i) => flagged(i.book));
    return f === 'all' || g.state === f;
  });
  if (!list.length) { els.library.innerHTML = '<div class="empty">No series or collections match.</div>'; return; }
  els.library.innerHTML = tiles(list.sort(sorter()).map(stackCard).join(''));
}

function renderSeries(id) {
  const g = groupSeries().find((x) => x.id === id);
  if (!g) {
    els.library.innerHTML = '<div class="empty"><p>This series or collection is no longer in the library.</p><p><button class="btn" data-back>Show all series and collections</button></p></div>';
    return;
  }
  const place = seriesPlace(g);
  const next = place.item && `${place.verb} ${place.item.position != null ? `#${numberIn(place.item)} ` : ''}${place.item.book.title}`;
  const facts = [g.numbered ? 'Series' : 'Collection', plural(g.items.length, 'book', 'books'), g.author, g.finished ? `${g.finished} finished` : ''];
  els.library.innerHTML = `<div class="series-head">
      <button class="btn small" data-back>&#8592; All series and collections</button>
      <h1>${escapeHtml(g.name)}</h1>
      <p class="muted">${facts.filter(Boolean).map(escapeHtml).join(' · ')}</p>
      <div class="row">
        ${next ? `<a class="btn primary" href="/read/${place.item.book.id}">${escapeHtml(next)}</a>` : ''}
        ${me.isAdmin ? `<button class="btn" data-edit-series="${g.id}">Rename or remove</button>` : ''}
      </div>
    </div>
    ${tiles(g.items.map((i) => card(i.book, { seriesId: g.id, position: numberIn(i) })).join(''))}`;
}

const heading = (text, count) => `<div class="section-title"><h2 style="margin:0">${text}</h2><span class="muted">${count}</span></div>`;

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
  const allBooks = cont && `${cont}${heading('All books', books.length)}`;
  // Searching always lists the matching books themselves.
  if (layout === 'every' || els.search.value.trim()) {
    const list = visible();
    els.library.innerHTML = list.length ? `${allBooks}${tiles(list.map((b) => card(b)).join(''))}` : '<div class="empty">No books match.</div>';
    return;
  }
  // A series matches a filter as a whole: Reading means started but not finished.
  const keep = (state) => els.filter.value === 'all' || state === els.filter.value;
  const { series, singles } = foldSeries();
  const shownSeries = series.filter((g) => keep(g.state)).sort(sorter());
  const shownBooks = singles.filter((b) => keep(status(b))).sort(sorter());
  if (!shownSeries.length && !shownBooks.length) { els.library.innerHTML = '<div class="empty">No books match.</div>'; return; }
  if (layout === 'shelves') {
    const others = shownBooks.length ? `${heading(shownSeries.length ? 'Other books' : 'Books', shownBooks.length)}${tiles(shownBooks.map((b) => card(b)).join(''))}` : '';
    els.library.innerHTML = `${cont}${shownSeries.map(shelf).join('')}${others}`;
    return;
  }
  const items = [...shownSeries, ...shownBooks].sort(sorter());
  els.library.innerHTML = `${allBooks}${tiles(items.map((x) => (x.items ? stackCard(x) : card(x))).join(''))}`;
}

// The open series is part of the address (/?series=12), so reloading and the back button work.
const openSeriesId = () => { const v = new URLSearchParams(location.search).get('series'); return /^\d+$/.test(v || '') ? Number(v) : null; };
let openedHere = false; // the series page was opened from this page, so "back" returns to where we were

function openSeries(id) {
  history.pushState(null, '', `/?series=${id}`);
  openedHere = true;
  render();
  window.scrollTo(0, 0);
}

function closeSeries() {
  view = 'series';
  savePrefs();
  if (openedHere) { history.back(); return; }
  history.replaceState(null, '', '/');
  render();
}

function render() {
  const seriesId = openSeriesId();
  const shown = seriesId != null ? 'series' : view;
  for (const tab of els.tabs.querySelectorAll('[data-view]')) tab.setAttribute('aria-pressed', String(tab.dataset.view === shown));
  els.tabs.querySelector('[data-view="books"] .n').textContent = books.length || '';
  els.tabs.querySelector('[data-view="series"] .n').textContent = new Set(books.flatMap((b) => b.series.map((s) => s.id))).size || '';
  document.body.classList.toggle('series-open', seriesId != null);
  els.layout.classList.toggle('hidden', shown !== 'books');
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
  if (!books.length) {
    els.library.innerHTML = '<div class="empty"><p>The library is empty.</p><p>Upload EPUB, MOBI, PDF, Markdown or text files to get started.</p></div>';
    return;
  }
  if (seriesId != null) renderSeries(seriesId);
  else if (view === 'series') renderSeriesList();
  else renderBooks();
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
  load();
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
  if (!reloadTimer) reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, Math.max(0, loadedAt + 3000 - Date.now()));
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
// While the cover dialog is open, an image dropped or pasted on the page becomes the cover instead.
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
  const file = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
  if (!file) return;
  e.preventDefault();
  coverEditor.useFile(file);
});

// ---- dialogs ----
function dialog(html) {
  els.dialogRoot.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet" role="dialog">${html}</div>`;
  const close = () => { els.dialogRoot.innerHTML = ''; };
  els.dialogRoot.querySelector('.sheet-backdrop').addEventListener('click', close);
  els.dialogRoot.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { root: els.dialogRoot.querySelector('.sheet'), close };
}

// A plain click on a series link opens it in place; modified clicks keep their usual meaning.
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function bookMenu(b) {
  const canEdit = me.isAdmin || b.addedById === me.id;
  const { root, close } = dialog(`
    <h2>${escapeHtml(b.title)}</h2>
    <p class="muted">${escapeHtml(b.author || '')}<br>${b.format.toUpperCase()} · ${(b.size / 1048576).toFixed(1)} MB · added by ${escapeHtml(b.addedBy || 'unknown')} ${formatDate(b.addedAt)}</p>
    ${b.series.length ? `<p class="series-links">Part of ${b.series.map(seriesLink).join(', ')}</p>` : ''}
    ${b.status === 'error' ? `<p class="error">${escapeHtml(b.error || 'Conversion failed')}</p>` : ''}
    <div class="menu">
      ${b.status === 'ready' ? `<a class="btn" href="/read/${b.id}">Open</a>` : ''}
      ${b.progress ? '<button class="btn" data-act="reset">Reset my reading position</button>' : ''}
      ${flagged(b) ? '<button class="btn" data-act="duplicates">Compare with possible duplicates</button>' : ''}
      <button class="btn" data-act="readers">Who is reading this</button>
      <a class="btn" href="/books/${b.id}/original" download="${escapeHtml(b.originalName)}">Download original file</a>
      ${canEdit ? '<button class="btn" data-act="edit">Edit details and series</button>' : ''}
      ${canEdit ? `<button class="btn" data-act="cover">${b.hasCover ? 'Change cover' : 'Add a cover'}</button>` : ''}
      ${canEdit ? '<button class="btn" data-act="reprocess">Convert again</button>' : ''}
      ${canEdit ? '<button class="btn danger" data-act="delete">Delete from library</button>' : ''}
      <button class="btn" data-close>Close</button>
    </div>`);
  root.addEventListener('click', async (ev) => {
    const link = ev.target.closest('a[data-series]');
    if (link && plainClick(ev)) { ev.preventDefault(); close(); openSeries(Number(link.dataset.series)); return; }
    const act = ev.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'edit') { editDetails(b); return; }
      if (act === 'duplicates') { compareCopies(b); return; }
      if (act === 'cover') { editCover(b); return; }
      if (act === 'delete') {
        if (!confirm(`Delete "${b.title}" for everyone? This cannot be undone.`)) return;
        await api(`/api/books/${b.id}`, { method: 'DELETE' });
      } else if (act === 'reprocess') {
        await api(`/api/books/${b.id}/reprocess`, { method: 'POST' });
      } else if (act === 'reset') {
        if (!confirm('Forget your reading position for this book?')) return;
        await api(`/api/books/${b.id}/progress`, { method: 'DELETE' });
      } else if (act === 'readers') {
        const { readers } = await api(`/api/books/${b.id}/readers`);
        alert(readers.length ? readers.map((r) => `${r.displayName || r.username}: ${Math.round(r.percent * 100)}% (${formatDate(r.updatedAt)})`).join('\n') : 'Nobody has started this book yet.');
        return;
      }
      close();
      await load();
    } catch (err) { toast(err.message); }
  });
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

// The catalogues the server looks books up in.
const CATALOGUES = { hardcover: 'Hardcover', openlibrary: 'Open Library' };

/**
 * A book found online, offered in the edit dialog: choosing it (anywhere on it) fills in the form, and
 * "Cover only" takes just its cover. The size of the cover is filled in once it has loaded (see showSize()).
 */
const matchRow = (m, i) => {
  const about = [m.series.map(seriesLabel).join(', '), m.byIsbn ? 'Same ISBN as the file' : ''].filter(Boolean).join(' · ');
  return `<div class="match" data-match="${i}">
    ${m.cover ? `<img class="cover" src="${escapeHtml(m.cover)}" alt="" loading="lazy">` : '<span class="cover"></span>'}
    <span class="body">
      <button type="button" class="pick">
        <span class="title">${escapeHtml(m.title)}</span>
        <span class="about">${escapeHtml([m.author, m.year, CATALOGUES[m.source]].filter(Boolean).join(' · '))}</span>
        ${about ? `<span class="about">${escapeHtml(about)}</span>` : ''}
      </button>
      ${m.cover ? '<span class="about" data-size>Cover loading…</span>' : ''}
      ${m.cover && m.coverId ? `<button type="button" class="btn small" data-cover-only="${i}">Cover only</button>` : ''}
    </span>
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

/** Title, author and the series and collections a book is in. */
function editDetails(b) {
  const names = [...new Set(books.flatMap((x) => x.series.map((s) => s.name)))].sort((x, y) => x.localeCompare(y));
  const { root, close } = dialog(`
    <h2>Edit details</h2>
    <form class="details" novalidate>
      <div class="field"><label for="ed-title">Title</label><input id="ed-title" name="title" value="${escapeHtml(b.title)}" maxlength="500"></div>
      <div class="field"><label for="ed-author">Author</label><input id="ed-author" name="author" value="${escapeHtml(b.author || '')}" maxlength="500"></div>
      <div class="lookup">
        <button type="button" class="btn small" data-lookup>Look up online</button>
        <div class="found">
          <div data-matches aria-live="polite"></div>
          <div data-picked aria-live="polite"></div>
        </div>
      </div>
      <fieldset class="field">
        <legend>Series and collections</legend>
        <div class="series-rows">${(b.series.length ? b.series : [undefined]).map((s) => seriesRow(s)).join('')}</div>
        <button type="button" class="btn small" data-add-row>Add to another</button>
        <p class="muted hint">The number puts a series in order (1, 2, 2.5 …); a book holding several, such as an omnibus, takes a range (1-3). Leave it empty for a collection without an order.</p>
      </fieldset>
      <p class="error hidden" data-error></p>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>
    <datalist id="series-names">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`);
  const form = root.querySelector('form');
  const rows = root.querySelector('.series-rows');
  const error = root.querySelector('[data-error]');
  const lookupBtn = root.querySelector('[data-lookup]');
  const matches = root.querySelector('[data-matches]');
  const picked = root.querySelector('[data-picked]');
  const fail = (message) => { error.textContent = message; error.classList.remove('hidden'); };
  const addRow = () => { rows.insertAdjacentHTML('beforeend', seriesRow()); return rows.lastElementChild; };
  // The book's cover now, which the covers found are compared with.
  const current = b.hasCover ? Object.assign(new Image(), { src: `/books/${b.id}/cover?v=${b.coverVersion}` }) : null;
  let found = [];
  let filled = null; // the match the form was filled in from
  let coverFrom = null; // the match whose cover is offered
  let coverOnly = false; // taken with "Cover only", so filling in from another match keeps it
  // On a wide screen the dialog grows, with the matches beside the form, once there is something to show there.
  const widen = () => root.classList.toggle('wide', found.length > 0 || !!filled || !!coverFrom);

  // Searches the catalogues for the title and author as typed (and the ISBN in the file).
  async function lookUp() {
    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Looking up…';
    matches.innerHTML = '';
    found = [];
    try {
      const query = new URLSearchParams({ title: form.elements.title.value.trim(), author: form.elements.author.value.trim() });
      const answer = await api(`/api/books/${b.id}/lookup?${query}`);
      found = answer.results;
      // A catalogue that could not be asked, such as Hardcover with an expired token.
      const notes = answer.notes.map((note) => `<p class="muted hint">${escapeHtml(note)}</p>`).join('');
      matches.innerHTML = (found.length
        ? `<p class="muted hint">Choose the matching book to fill in the details, or take only its cover. Nothing changes until you save.</p>
          ${current ? '<p class="muted hint" data-current></p>' : ''}<div class="matches">${found.map(matchRow).join('')}</div>`
        : `<p class="muted hint">No match on ${escapeHtml(answer.sources.map((s) => CATALOGUES[s]).join(' or '))}. Try a shorter title, or leave out the author.</p>`) + notes;
      if (found.length && current) showSize(current, matches.querySelector('[data-current]'), (size) => (size ? `The current cover is ${size}.` : ''));
      for (const row of matches.querySelectorAll('.match')) {
        const img = row.querySelector('img.cover');
        if (img) showSize(img, row.querySelector('[data-size]'), (size) => (size ? `Cover ${size}` : 'The cover could not be loaded'));
      }
    } catch (err) {
      matches.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = 'Look up online';
      widen();
    }
  }

  // Shows what the form takes from the matches: the details, and the cover to use when ticked. The
  // rows they came from are marked in the list.
  function showPicked() {
    const from = (m) => `<a href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${CATALOGUES[m.source]}</a>`;
    picked.innerHTML = `${filled ? `<p class="hint">Filled in from ${from(filled)}. Check the details, then save.</p>` : ''}
      ${coverOnly ? `<p class="hint">Cover from ${from(coverFrom)}.</p>` : ''}
      ${coverFrom ? `<label class="use-cover"><input type="checkbox" name="useCover"${coverOnly || !b.hasCover ? ' checked' : ''}>
        <img class="cover" src="${escapeHtml(coverFrom.cover)}" alt="">
        <span><span>${b.hasCover ? 'Use this cover instead of the current one' : 'Use this cover'}</span>
          <span class="about"><span data-size></span>${current ? '<span data-current></span>' : ''}</span></span></label>` : ''}`;
    if (coverFrom) {
      showSize(picked.querySelector('.use-cover img'), picked.querySelector('[data-size]'), (size) => size ?? 'The cover could not be loaded');
      if (current) showSize(current, picked.querySelector('[data-current]'), (size) => (size ? ` · now ${size}` : ''));
    }
    for (const row of matches.querySelectorAll('[data-match]')) row.classList.toggle('chosen', found[Number(row.dataset.match)] === filled);
    for (const btn of matches.querySelectorAll('[data-cover-only]')) btn.classList.toggle('chosen', coverOnly && found[Number(btn.dataset.coverOnly)] === coverFrom);
    widen();
    picked.scrollIntoView({ block: 'nearest' });
  }

  // Fills in the form from a match. Its series join the rows already there; a series that is
  // already listed takes the match's number. Its cover is offered too, and chosen by default
  // when the book has none, unless a cover was taken with "Cover only".
  function useMatch(m) {
    filled = m;
    form.elements.title.value = m.title;
    if (m.author) form.elements.author.value = m.author;
    const nameKey = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    for (const s of m.series) {
      const all = [...rows.querySelectorAll('.series-row')];
      const nameOf = (row) => row.querySelector('[name="series-name"]');
      const row = all.find((r) => nameKey(nameOf(r).value) === nameKey(s.name)) || all.find((r) => !nameOf(r).value.trim()) || addRow();
      if (!nameOf(row).value.trim()) nameOf(row).value = s.name;
      if (s.position != null) row.querySelector('[name="series-no"]').value = numberIn(s);
    }
    if (!coverOnly) coverFrom = m.cover && m.coverId ? m : null;
    showPicked();
  }

  // Takes only a match's cover: the details stay as they are.
  function useCover(m) {
    coverFrom = m;
    coverOnly = true;
    showPicked();
  }

  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-add-row]')) addRow().querySelector('input').focus();
    const remove = ev.target.closest('[data-remove-row]');
    if (remove) {
      const row = remove.closest('.series-row');
      if (rows.children.length > 1) row.remove(); else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
    }
    if (ev.target.closest('[data-lookup]')) lookUp();
    const coverButton = ev.target.closest('[data-cover-only]');
    const match = ev.target.closest('[data-match]');
    if (coverButton) useCover(found[Number(coverButton.dataset.coverOnly)]);
    else if (match) useMatch(found[Number(match.dataset.match)]);
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = form.elements.title.value.trim();
    const series = [...rows.querySelectorAll('.series-row')]
      .map((r) => ({ name: r.querySelector('[name="series-name"]').value.trim(), position: r.querySelector('[name="series-no"]').value.trim() || null }))
      .filter((s) => s.name);
    const bad = series.find((s) => s.position != null && !/^\d{1,5}([.,]\d+)?(\s*[-–—]\s*\d{1,5}([.,]\d+)?)?$/.test(s.position));
    if (!title) return fail('The book needs a title.');
    if (bad) return fail(`The number for "${bad.name}" must be a number, such as 3 or 2.5, or a range for a book holding several, such as 1-3.`);
    const saveBtn = form.querySelector('[type="submit"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      // The cover first: when the catalogue cannot send it, nothing has changed yet.
      if (form.elements.useCover?.checked) await api(`/api/books/${b.id}/cover`, { method: 'PUT', body: { source: coverFrom.coverSource, coverId: coverFrom.coverId } });
      await api(`/api/books/${b.id}`, { method: 'PATCH', body: { title, author: form.elements.author.value.trim(), series } });
      close();
      await load();
    } catch (err) {
      fail(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });
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

/** The cover the library shows: an image, a page of the PDF, the book's own cover or none. Each change is saved at once. */
function editCover(b) {
  const { root } = dialog(`
    <h2>Cover</h2>
    <p class="muted">${escapeHtml(b.title)}</p>
    <div class="cover-edit">
      <div class="cover-preview"></div>
      <div class="menu">
        <button type="button" class="btn" data-pick>Choose an image</button>
        ${b.format === 'pdf' ? `<form class="cover-page" novalidate>
          <button type="submit" class="btn">Use page</button>
          <input type="number" name="page" value="1" min="1"${b.pageCount ? ` max="${b.pageCount}"` : ''} aria-label="Page of the PDF">
          ${b.pageCount ? `<span class="muted">of ${b.pageCount}</span>` : ''}
        </form>` : ''}
        <button type="button" class="btn" data-source="file">Use the original cover</button>
        <button type="button" class="btn" data-source="none">Remove cover</button>
        <button type="button" class="btn" data-close>Done</button>
      </div>
    </div>
    <input type="file" accept="image/*" class="hidden" data-file>
    ${matchMedia('(pointer: fine)').matches ? '<p class="muted hint">You can also paste an image, or drop one on the page.</p>' : ''}
    <p class="muted hint hidden" data-busy></p>
    <p class="error hidden" data-error></p>`);
  const preview = root.querySelector('.cover-preview');
  const busyNote = root.querySelector('[data-busy]');
  const error = root.querySelector('[data-error]');
  const fileInput = root.querySelector('[data-file]');
  const controls = [...root.querySelectorAll('.menu button:not([data-close]), .menu input')];
  const show = () => {
    preview.innerHTML = coverHtml(b);
    root.querySelector('[data-source="file"]').classList.toggle('hidden', b.coverSource === 'file' || !b.fileHasCover);
    root.querySelector('[data-source="none"]').classList.toggle('hidden', !b.hasCover);
  };
  let busy = false;
  const save = async (doing, work) => {
    if (busy) return;
    busy = true;
    controls.forEach((el) => { el.disabled = true; });
    error.classList.add('hidden');
    busyNote.textContent = doing;
    busyNote.classList.remove('hidden');
    try {
      ({ book: b } = await work());
      show();
      load();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    } finally {
      busy = false;
      controls.forEach((el) => { el.disabled = false; });
      busyNote.classList.add('hidden');
    }
  };
  const send = (body) => api(`/api/books/${b.id}/cover`, body instanceof Blob
    ? { method: 'PUT', raw: true, body, headers: { 'Content-Type': body.type || 'application/octet-stream' } }
    : { method: 'PUT', body });
  const useFile = (file) => save('Saving the cover…', async () => send(await coverImage(file)));
  coverEditor = { root, useFile };
  show();

  root.querySelector('[data-pick]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (file) useFile(file);
  });
  for (const btn of root.querySelectorAll('[data-source]')) btn.addEventListener('click', () => save('Saving…', () => send({ source: btn.dataset.source })));
  // Most PDFs have no cover image, but their first page usually is the cover.
  root.querySelector('.cover-page')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = ev.target.elements.page;
    save(`Preparing page ${input.value || 1}…`, async () => {
      const { renderPdfPage } = await import('./pdf-view.js');
      const { canvas, page } = await renderPdfPage(`/books/${b.id}/original`, Number(input.value), COVER_SIDE);
      input.value = page;
      return send(await toJpeg(canvas));
    });
  });
}

/** Rename (or merge) and remove a whole series or collection. Admins only. */
function editSeries(id) {
  const g = groupSeries().find((x) => x.id === id);
  if (!g) return;
  const kind = g.numbered ? 'series' : 'collection';
  const others = groupSeries().filter((x) => x.id !== id).map((x) => x.name).sort((x, y) => x.localeCompare(y));
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
}

els.library.addEventListener('click', (e) => {
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
  view = tab.dataset.view;
  savePrefs();
  if (openSeriesId() != null) { history.pushState(null, '', '/'); openedHere = false; }
  render();
});
window.addEventListener('popstate', () => { openedHere = false; render(); });
els.search.addEventListener('input', render);
els.filter.addEventListener('change', () => { savePrefs(); render(); });
els.sort.addEventListener('change', () => { savePrefs(); render(); });
els.layout.addEventListener('change', () => { layout = els.layout.value; savePrefs(); render(); });
els.display.addEventListener('change', () => { display = els.display.value; savePrefs(); render(); });
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
