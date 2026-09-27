import { api, requireUser, escapeHtml, formatDate, toast, registerServiceWorker } from './api.js';
import { loadSettings, applyTheme } from './settings.js';

registerServiceWorker();
applyTheme(loadSettings());

const els = {
  library: document.getElementById('library'),
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

function savePrefs() { localStorage.setItem('ereader.library', JSON.stringify({ sort: els.sort.value, filter: els.filter.value })); }

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

function visible() {
  const q = els.search.value.trim().toLowerCase();
  const f = els.filter.value;
  let list = books.filter((b) => {
    if (q && !(`${b.title} ${b.author}`.toLowerCase().includes(q))) return false;
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

function card(b) {
  const pct = b.progress ? Math.round(b.progress.percent * 100) : 0;
  const cover = b.hasCover && b.status === 'ready'
    ? `<img class="cover" loading="lazy" alt="" src="/books/${b.id}/cover?v=${b.convertedAt || b.addedAt}">`
    : `<div class="cover placeholder"><div class="t">${escapeHtml(b.title)}</div><div class="a">${escapeHtml(b.author)}</div></div>`;
  const st = b.status === 'processing' ? '<div class="status">Preparing…</div>' : b.status === 'error' ? `<div class="status err" title="${escapeHtml(b.error || '')}">Could not convert</div>` : '';
  const link = b.status === 'ready' ? `<a class="link" href="/read/${b.id}" aria-label="Read ${escapeHtml(b.title)}"></a>` : '';
  const progressHtml = b.progress ? `<div class="progress" title="${pct}%"><div style="width:${pct}%"></div></div>` : '';
  const when = b.progress ? `Read ${formatDate(b.progress.updatedAt)}` : `Added ${formatDate(b.addedAt)}`;
  return `<div class="card" data-id="${b.id}">
    ${cover}${st}${link}
    <div class="info">
      <div class="title">${escapeHtml(b.title)}</div>
      <div class="author">${escapeHtml(b.author || '')}</div>
      ${progressHtml}
      <div class="meta"><span>${b.progress ? `${pct}%` : ''} ${when}</span><span class="badge">${b.format}</span></div>
    </div>
    <button class="menu-btn" aria-label="Options for ${escapeHtml(b.title)}" data-menu="${b.id}">&#8943;</button>
  </div>`;
}

function render() {
  const list = visible();
  if (!books.length) {
    els.library.innerHTML = '<div class="empty"><p>The library is empty.</p><p>Upload EPUB, MOBI, PDF, Markdown or text files to get started.</p></div>';
    return;
  }
  if (!list.length) { els.library.innerHTML = '<div class="empty">No books match.</div>'; return; }
  const reading = els.sort.value === 'recent' && !els.search.value && els.filter.value === 'all' ? list.filter((b) => status(b) === 'reading').slice(0, 6) : [];
  let html = '';
  if (reading.length) {
    html += `<div class="section-title"><h2 style="margin:0">Continue reading</h2></div><div class="grid">${reading.map(card).join('')}</div>`;
    html += `<div class="section-title"><h2 style="margin:0">All books</h2><span class="muted">${books.length}</span></div>`;
  }
  html += `<div class="grid">${list.map(card).join('')}</div>`;
  els.library.innerHTML = html;
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

// ---- menu ----
function dialog(html) {
  els.dialogRoot.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet" role="dialog">${html}</div>`;
  const close = () => { els.dialogRoot.innerHTML = ''; };
  els.dialogRoot.querySelector('.sheet-backdrop').addEventListener('click', close);
  els.dialogRoot.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { root: els.dialogRoot.querySelector('.sheet'), close };
}

els.library.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-menu]');
  if (!btn) return;
  e.preventDefault();
  const b = books.find((x) => x.id === btn.dataset.menu);
  if (!b) return;
  const canEdit = me.isAdmin || b.addedById === me.id;
  const { root, close } = dialog(`
    <h2>${escapeHtml(b.title)}</h2>
    <p class="muted">${escapeHtml(b.author || '')}<br>${b.format.toUpperCase()} · ${(b.size / 1048576).toFixed(1)} MB · added by ${escapeHtml(b.addedBy || 'unknown')} ${formatDate(b.addedAt)}</p>
    ${b.status === 'error' ? `<p class="error">${escapeHtml(b.error || 'Conversion failed')}</p>` : ''}
    <div class="menu">
      ${b.status === 'ready' ? `<a class="btn" href="/read/${b.id}">Open</a>` : ''}
      ${b.progress ? '<button class="btn" data-act="reset">Reset my reading position</button>' : ''}
      <button class="btn" data-act="readers">Who is reading this</button>
      <a class="btn" href="/books/${b.id}/original" download="${escapeHtml(b.originalName)}">Download original file</a>
      ${canEdit ? '<button class="btn" data-act="edit">Edit title and author</button>' : ''}
      ${canEdit ? '<button class="btn" data-act="reprocess">Convert again</button>' : ''}
      ${canEdit ? '<button class="btn danger" data-act="delete">Delete from library</button>' : ''}
      <button class="btn" data-close>Close</button>
    </div>`);
  root.addEventListener('click', async (ev) => {
    const act = ev.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'delete') {
        if (!confirm(`Delete "${b.title}" for everyone? This cannot be undone.`)) return;
        await api(`/api/books/${b.id}`, { method: 'DELETE' });
      } else if (act === 'reprocess') {
        await api(`/api/books/${b.id}/reprocess`, { method: 'POST' });
      } else if (act === 'reset') {
        if (!confirm('Forget your reading position for this book?')) return;
        await api(`/api/books/${b.id}/progress`, { method: 'DELETE' });
      } else if (act === 'edit') {
        const title = prompt('Title', b.title);
        if (title == null) return;
        const author = prompt('Author', b.author || '');
        if (author == null) return;
        await api(`/api/books/${b.id}`, { method: 'PATCH', body: { title, author } });
      } else if (act === 'readers') {
        const { readers } = await api(`/api/books/${b.id}/readers`);
        alert(readers.length ? readers.map((r) => `${r.displayName || r.username}: ${Math.round(r.percent * 100)}% (${formatDate(r.updatedAt)})`).join('\n') : 'Nobody has started this book yet.');
        return;
      }
      close();
      await load();
    } catch (err) { toast(err.message); }
  });
});

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
