import { api, requireUser, escapeHtml, formatDate, toast, registerServiceWorker } from './api.js';
import { loadSettings, applyTheme } from './settings.js';

registerServiceWorker();
applyTheme(loadSettings());

const els = {
  library: document.getElementById('library'),
  tabs: document.getElementById('tabs'),
  search: document.getElementById('search'),
  filter: document.getElementById('filter'),
  sort: document.getElementById('sort'),
  upload: document.getElementById('btn-upload'),
  file: document.getElementById('file-input'),
  drop: document.getElementById('dropzone'),
  uploads: document.getElementById('uploads'),
  dialogRoot: document.getElementById('dialog-root'),
};
let me = null;
let books = [];
let pollTimer = null;
const prefs = JSON.parse(localStorage.getItem('ereader.library') || '{}');
els.sort.value = prefs.sort || 'recent';
els.filter.value = prefs.filter || 'all';
// The library shows every book, or books grouped into their series and collections.
let view = prefs.view === 'series' ? 'series' : 'books';

function savePrefs() { localStorage.setItem('ereader.library', JSON.stringify({ sort: els.sort.value, filter: els.filter.value, view })); }

async function load() {
  const data = await api('/api/books');
  books = data.books;
  render();
  const processing = books.some((b) => b.status === 'processing');
  clearTimeout(pollTimer);
  if (processing) pollTimer = setTimeout(load, 3000);
}

function status(b) {
  if (b.status !== 'ready') return b.status;
  if (!b.progress) return 'unread';
  if (b.progress.percent >= 0.98) return 'finished';
  return 'reading';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const seriesLabel = (s) => (s.position != null ? `${s.name} #${s.position}` : s.name);
const seriesLink = (s) => `<a href="/?series=${s.id}" data-series="${s.id}">${escapeHtml(seriesLabel(s))}</a>`;

function visible() {
  const q = els.search.value.trim().toLowerCase();
  const f = els.filter.value;
  let list = books.filter((b) => {
    if (q && !(`${b.title} ${b.author} ${b.series.map((s) => s.name).join(' ')}`.toLowerCase().includes(q))) return false;
    if (f === 'reading') return status(b) === 'reading';
    if (f === 'unread') return status(b) === 'unread';
    if (f === 'finished') return status(b) === 'finished';
    return true;
  });
  const s = els.sort.value;
  const cmp = {
    recent: (a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0) || b.addedAt - a.addedAt,
    added: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.title.localeCompare(b.title),
  }[s];
  return list.sort(cmp);
}

/** A book card. In a series view (`ctx.seriesId`) the cover shows the book's number in that series. */
function card(b, ctx = {}) {
  const pct = b.progress ? Math.round(b.progress.percent * 100) : 0;
  const cover = b.hasCover && b.status === 'ready'
    ? `<img class="cover" loading="lazy" alt="" src="/books/${b.id}/cover?v=${b.convertedAt || b.addedAt}">`
    : `<div class="cover placeholder"><div class="t">${escapeHtml(b.title)}</div><div class="a">${escapeHtml(b.author)}</div></div>`;
  const number = ctx.position != null ? `<span class="cover-tag">#${ctx.position}</span>` : '';
  const st = b.status === 'processing' ? '<div class="status">Preparing…</div>' : b.status === 'error' ? `<div class="status err" title="${escapeHtml(b.error || '')}">Could not convert</div>` : '';
  const link = b.status === 'ready' ? `<a class="link" href="/read/${b.id}" aria-label="Read ${escapeHtml(b.title)}"></a>` : '';
  const others = b.series.filter((s) => s.id !== ctx.seriesId);
  const seriesHtml = others.length ? `<div class="series-line">${others.map(seriesLink).join(', ')}</div>` : '';
  const progressHtml = b.progress ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : '';
  const when = b.progress ? `Read ${formatDate(b.progress.updatedAt)}` : `Added ${formatDate(b.addedAt)}`;
  return `<div class="card" data-id="${b.id}">
    ${cover}${number}${st}${link}
    <div class="info">
      <div class="title">${escapeHtml(b.title)}</div>
      <div class="author">${escapeHtml(b.author || '')}</div>
      ${seriesHtml}
      ${progressHtml}
      <div class="meta"><span>${b.progress ? `${pct}%` : ''} ${when}</span><span class="badge">${b.format}</span></div>
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
      groups.get(s.id).items.push({ book: b, position: s.position });
    }
  }
  for (const g of groups.values()) {
    g.items.sort((x, y) => (x.position ?? Infinity) - (y.position ?? Infinity) || x.book.title.localeCompare(y.book.title));
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

/** What to read next in a group: the book being read, else the first unread one after the last finished. */
function nextInSeries(g) {
  const reading = g.items.filter((i) => status(i.book) === 'reading').sort((a, b) => b.book.progress.updatedAt - a.book.progress.updatedAt)[0];
  const done = g.items.map((i) => status(i.book)).lastIndexOf('finished');
  const unread = g.items.slice(done + 1).find((i) => status(i.book) === 'unread') || g.items.find((i) => status(i.book) === 'unread');
  const item = reading || unread;
  if (!item) return null;
  const verb = reading ? 'Continue' : done >= 0 ? 'Next up:' : 'Start with';
  return { book: item.book, label: `${verb} ${item.position != null ? `#${item.position} ` : ''}${item.book.title}` };
}

function seriesCard(g) {
  const coverBook = g.items.map((i) => i.book).find((b) => b.hasCover && b.status === 'ready');
  const cover = coverBook
    ? `<img class="cover" loading="lazy" alt="" src="/books/${coverBook.id}/cover?v=${coverBook.convertedAt || coverBook.addedAt}">`
    : `<div class="cover placeholder"><div class="t">${escapeHtml(g.name)}</div></div>`;
  const n = g.items.length;
  const pct = Math.round(g.items.reduce((sum, i) => sum + (status(i.book) === 'finished' ? 1 : i.book.progress?.percent || 0), 0) / n * 100);
  const started = g.state !== 'unread';
  return `<div class="card">
    ${cover}<span class="cover-tag">${plural(n, 'book', 'books')}</span>
    <a class="link" href="/?series=${g.id}" data-series="${g.id}" aria-label="${escapeHtml(g.name)}, ${plural(n, 'book', 'books')}"></a>
    <div class="info">
      <div class="title">${escapeHtml(g.name)}</div>
      <div class="author">${escapeHtml(g.author)}</div>
      ${started ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : ''}
      <div class="meta"><span>${started ? `${g.finished} of ${n} finished` : g.numbered ? 'Series' : 'Collection'}</span></div>
    </div>
  </div>`;
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
    return f === 'all' || g.state === f;
  });
  if (!list.length) { els.library.innerHTML = '<div class="empty">No series or collections match.</div>'; return; }
  const cmp = {
    recent: (a, b) => b.lastRead - a.lastRead || b.lastAdded - a.lastAdded,
    added: (a, b) => b.lastAdded - a.lastAdded,
    title: (a, b) => a.name.localeCompare(b.name),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.name.localeCompare(b.name),
  }[els.sort.value];
  els.library.innerHTML = `<div class="grid">${list.sort(cmp).map(seriesCard).join('')}</div>`;
}

function renderSeries(id) {
  const g = groupSeries().find((x) => x.id === id);
  if (!g) {
    els.library.innerHTML = '<div class="empty"><p>This series or collection is no longer in the library.</p><p><button class="btn" data-back>Show all series and collections</button></p></div>';
    return;
  }
  const next = nextInSeries(g);
  const facts = [g.numbered ? 'Series' : 'Collection', plural(g.items.length, 'book', 'books'), g.author, g.finished ? `${g.finished} finished` : ''];
  els.library.innerHTML = `<div class="series-head">
      <button class="btn small" data-back>&#8592; All series and collections</button>
      <h1>${escapeHtml(g.name)}</h1>
      <p class="muted">${facts.filter(Boolean).map(escapeHtml).join(' · ')}</p>
      <div class="row">
        ${next ? `<a class="btn primary" href="/read/${next.book.id}">${escapeHtml(next.label)}</a>` : ''}
        ${me.isAdmin ? `<button class="btn" data-edit-series="${g.id}">Rename or remove</button>` : ''}
      </div>
    </div>
    <div class="grid">${g.items.map((i) => card(i.book, { seriesId: g.id, position: i.position })).join('')}</div>`;
}

function renderBooks() {
  const list = visible();
  if (!list.length) { els.library.innerHTML = '<div class="empty">No books match.</div>'; return; }
  const reading = els.sort.value === 'recent' && !els.search.value && els.filter.value === 'all' ? list.filter((b) => status(b) === 'reading').slice(0, 6) : [];
  let html = '';
  if (reading.length) {
    html += `<div class="section-title"><h2 style="margin:0">Continue reading</h2></div><div class="grid">${reading.map((b) => card(b)).join('')}</div>`;
    html += `<div class="section-title"><h2 style="margin:0">All books</h2><span class="muted">${books.length}</span></div>`;
  }
  html += `<div class="grid">${list.map((b) => card(b)).join('')}</div>`;
  els.library.innerHTML = html;
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
  if (!books.length) {
    els.library.innerHTML = '<div class="empty"><p>The library is empty.</p><p>Upload EPUB, MOBI, PDF, Markdown or text files to get started.</p></div>';
    return;
  }
  if (seriesId != null) renderSeries(seriesId);
  else if (view === 'series') renderSeriesList();
  else renderBooks();
}

// ---- uploads ----
async function uploadFiles(files) {
  const list = [...files];
  if (!list.length) return;
  for (const f of list) {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span>${escapeHtml(f.name)}</span><span class="muted">uploading…</span>`;
    els.uploads.appendChild(item);
    try {
      await api('/api/books', { method: 'POST', raw: true, body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) } });
      item.lastElementChild.textContent = 'uploaded - preparing';
      setTimeout(() => item.remove(), 4000);
    } catch (err) {
      item.lastElementChild.textContent = err.message;
      item.lastElementChild.classList.add('error');
    }
    load();
  }
}
els.upload.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => { uploadFiles(els.file.files); els.file.value = ''; });
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('active'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) els.drop.classList.remove('active'); });
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files); });

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
      <button class="btn" data-act="readers">Who is reading this</button>
      <a class="btn" href="/books/${b.id}/original" download="${escapeHtml(b.originalName)}">Download original file</a>
      ${canEdit ? '<button class="btn" data-act="edit">Edit details and series</button>' : ''}
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

const seriesRow = (s = { name: '', position: null }) => `<div class="series-row">
    <input type="text" name="series-name" list="series-names" value="${escapeHtml(s.name)}" placeholder="Series or collection" aria-label="Series or collection" maxlength="200" autocomplete="off">
    <input type="text" name="series-no" inputmode="decimal" value="${s.position ?? ''}" placeholder="No." aria-label="Number in the series" maxlength="8" autocomplete="off">
    <button type="button" class="btn icon" data-remove-row aria-label="Remove">&times;</button>
  </div>`;

/** Title, author and the series and collections a book is in. */
function editDetails(b) {
  const names = [...new Set(books.flatMap((x) => x.series.map((s) => s.name)))].sort((x, y) => x.localeCompare(y));
  const { root, close } = dialog(`
    <h2>Edit details</h2>
    <form class="details" novalidate>
      <div class="field"><label for="ed-title">Title</label><input id="ed-title" name="title" value="${escapeHtml(b.title)}" maxlength="500"></div>
      <div class="field"><label for="ed-author">Author</label><input id="ed-author" name="author" value="${escapeHtml(b.author || '')}" maxlength="500"></div>
      <fieldset class="field">
        <legend>Series and collections</legend>
        <div class="series-rows">${(b.series.length ? b.series : [undefined]).map((s) => seriesRow(s)).join('')}</div>
        <button type="button" class="btn small" data-add-row>Add to another</button>
        <p class="muted hint">The number puts a series in order (1, 2, 2.5 …). Leave it empty for a collection without an order.</p>
      </fieldset>
      <p class="error hidden" data-error></p>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div>
    </form>
    <datalist id="series-names">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`);
  const form = root.querySelector('form');
  const rows = root.querySelector('.series-rows');
  const error = root.querySelector('[data-error]');
  const fail = (message) => { error.textContent = message; error.classList.remove('hidden'); };
  root.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-add-row]')) {
      rows.insertAdjacentHTML('beforeend', seriesRow());
      rows.lastElementChild.querySelector('input').focus();
    }
    const remove = ev.target.closest('[data-remove-row]');
    if (remove) {
      const row = remove.closest('.series-row');
      if (rows.children.length > 1) row.remove(); else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
    }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = form.elements.title.value.trim();
    const series = [...rows.querySelectorAll('.series-row')]
      .map((r) => ({ name: r.querySelector('[name="series-name"]').value.trim(), position: r.querySelector('[name="series-no"]').value.trim() || null }))
      .filter((s) => s.name);
    const bad = series.find((s) => s.position != null && !/^\d{1,5}([.,]\d+)?$/.test(s.position));
    if (!title) return fail('The book needs a title.');
    if (bad) return fail(`The number for "${bad.name}" must be a number, such as 3 or 2.5.`);
    try {
      await api(`/api/books/${b.id}`, { method: 'PATCH', body: { title, author: form.elements.author.value.trim(), series } });
      close();
      await load();
    } catch (err) { fail(err.message); }
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
  const btn = e.target.closest('button[data-menu]');
  if (!btn) return;
  e.preventDefault();
  const b = books.find((x) => x.id === btn.dataset.menu);
  if (b) bookMenu(b);
});

els.tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (!tab) return;
  view = tab.dataset.view;
  savePrefs();
  if (openSeriesId() != null) { history.pushState(null, '', '/'); openedHere = false; }
  render();
});
window.addEventListener('popstate', () => { openedHere = false; render(); });
els.search.addEventListener('input', render);
els.filter.addEventListener('change', () => { savePrefs(); render(); });
els.sort.addEventListener('change', () => { savePrefs(); render(); });
document.getElementById('btn-logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });

requireUser().then((u) => {
  me = u;
  if (u.isAdmin) document.getElementById('nav-users').classList.remove('hidden');
  return load();
}).catch(() => {});
