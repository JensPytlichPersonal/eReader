// The reader: paginates normalised book sections with CSS columns, tracks the position as
// (section, character offset) so it is stable across devices, fonts and screen sizes, and
// keeps that position in sync with the server.
import { api, toast, escapeHtml, guessDeviceName, registerServiceWorker, formatDate } from './api.js';
import { loadSettings, saveSettings, applyTheme, applyTypography, FONTS } from './settings.js';
import { PdfPageView } from './pdf-view.js';

registerServiceWorker();

const bookId = location.pathname.split('/')[2];
const base = `/books/${bookId}/`;
const $ = (id) => document.getElementById(id);
const els = {
  viewport: $('viewport'), content: $('content'), pdfview: $('pdfview'), pdfcanvas: $('pdfcanvas'),
  topbar: $('topbar'), bottombar: $('bottombar'), title: $('title'), slider: $('slider'), pos: $('pos'),
  statusLeft: $('status-left'), statusRight: $('status-right'), loading: $('loading'),
  toc: $('toc'), bookmarks: $('bookmarks'), backdrop: $('panel-backdrop'), tapHint: $('tap-hint'),
};

let settings = loadSettings();
if (!settings.device) { settings.device = guessDeviceName(); saveSettings(settings); }

const state = {
  book: null, manifest: null,
  section: 0, page: 0, pageCount: 1, cols: 1, colW: 0, gap: 0, width: 0, height: 0,
  nodes: [], starts: [], totalNodes: 0,
  locator: { section: 0, offset: 0 },
  known: 0, syncTimer: null, syncing: false, dirty: false,
  cache: new Map(), loadToken: 0,
  mode: 'text', pdf: null,
  bookmarks: [], history: [],
  barsVisible: false,
};

// ---------------------------------------------------------------- utilities
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sections = () => state.manifest.sections;
const localKey = `rreader.pos.${bookId}`;

function percentOf(section, offset) {
  const m = state.manifest;
  if (!m || !m.totalChars) return 0;
  const s = m.sections[section];
  if (!s) return 0;
  return clamp((s.start + Math.min(offset, s.chars)) / m.totalChars, 0, 1);
}

function positionFromPercent(p) {
  const m = state.manifest;
  const target = clamp(p, 0, 1) * m.totalChars;
  let idx = 0;
  for (let i = 0; i < m.sections.length; i++) if (m.sections[i].start <= target) idx = i;
  return { section: idx, offset: Math.max(0, Math.floor(target - m.sections[idx].start)) };
}

// ---------------------------------------------------------------- layout
function layout() {
  applyTypography(settings);
  const vp = els.viewport;
  const cs = getComputedStyle(vp);
  const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight), padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom);
  const innerW = Math.max(100, Math.floor(vp.clientWidth - padL - padR));
  const innerH = Math.max(100, Math.floor(vp.clientHeight - padT - padB));
  let cols = settings.columns === 'auto' ? (innerW >= 900 ? 2 : 1) : parseInt(settings.columns, 10) || 1;
  const gap = Math.max(32, Math.round(padL + padR));
  let width = innerW;
  if (cols === 1) width = Math.min(innerW, Math.round(settings.fontSize * 42));
  if (cols === 2) width = Math.min(innerW, Math.round(settings.fontSize * 42) * 2 + gap);
  const colW = Math.floor((width - gap * (cols - 1)) / cols);
  width = colW * cols + gap * (cols - 1);
  Object.assign(state, { cols, colW, gap, width, height: innerH });
  const root = document.documentElement.style;
  root.setProperty('--page-w', `${colW}px`);
  root.setProperty('--page-h', `${innerH}px`);
  root.setProperty('--gap', `${gap}px`);
  els.content.style.width = `${width}px`;
  els.content.style.marginLeft = `${Math.floor((innerW - width) / 2)}px`;
  els.content.style.columnCount = String(cols);
}

const stride = () => state.width + state.gap;

function measure() {
  const c = els.content;
  const totalCols = Math.max(1, Math.round((c.scrollWidth + state.gap) / (state.colW + state.gap)));
  state.pageCount = Math.max(1, Math.ceil(totalCols / state.cols));
}

// Index every text node (and image) so a position can be expressed as a character offset.
function indexNodes() {
  const nodes = [];
  const starts = [];
  let total = 0;
  const walker = document.createTreeWalker(els.content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.TEXT_NODE ? (n.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) : (n.tagName === 'IMG' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)),
  });
  let n;
  while ((n = walker.nextNode())) {
    nodes.push(n);
    starts.push(total);
    total += n.nodeType === Node.TEXT_NODE ? n.data.length : 1;
  }
  state.nodes = nodes;
  state.starts = starts;
  state.totalNodes = total;
}

function nodeIndexForOffset(offset) {
  const { starts } = state;
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function rectForOffset(offset) {
  if (!state.nodes.length) return null;
  const i = nodeIndexForOffset(offset);
  const node = state.nodes[i];
  if (node.nodeType !== Node.TEXT_NODE) return node.getBoundingClientRect();
  const k = clamp(offset - state.starts[i], 0, Math.max(0, node.data.length - 1));
  const r = document.createRange();
  try {
    r.setStart(node, k);
    r.setEnd(node, Math.min(node.data.length, k + 1));
    const rects = r.getClientRects();
    if (rects.length) return rects[0];
    return r.getBoundingClientRect();
  } catch { return node.parentElement?.getBoundingClientRect() || null; }
}

function pageForRect(rect) {
  if (!rect) return 0;
  const contentLeft = els.content.getBoundingClientRect().left;
  const x = rect.left - contentLeft + els.content.scrollLeft;
  const col = Math.floor((x + 1) / (state.colW + state.gap));
  return clamp(Math.floor(col / state.cols), 0, state.pageCount - 1);
}

function pageForElement(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    // Empty anchors: use the next node with a box.
    const range = document.createRange();
    range.selectNode(el);
    const rr = range.getClientRects();
    if (rr.length) return pageForRect(rr[0]);
    let n = el;
    while (n && (n = nextNode(n))) {
      if (n.nodeType === Node.TEXT_NODE && n.data.trim()) { const rg = document.createRange(); rg.selectNodeContents(n); return pageForRect(rg.getBoundingClientRect()); }
      if (n.nodeType === Node.ELEMENT_NODE) { const b = n.getBoundingClientRect(); if (b.width || b.height) return pageForRect(b); }
    }
    return state.page;
  }
  return pageForRect(r);
}
function nextNode(n) {
  if (n.firstChild) return n.firstChild;
  while (n && !n.nextSibling) n = n.parentNode;
  return n ? n.nextSibling : null;
}

/** Find the (section, offset) of the first visible character on the current page. */
function locatorForCurrentPage() {
  const section = state.section;
  if (!state.nodes.length) return { section, offset: 0 };
  const contentRect = els.content.getBoundingClientRect();
  const left = contentRect.left;
  const right = left + state.width;
  const top = contentRect.top;
  const offsetOf = (node, k) => {
    const i = state.nodes.indexOf(node);
    return i < 0 ? null : state.starts[i] + k;
  };
  // Fast path: probe caret positions near the top-left of the page.
  const caret = document.caretRangeFromPoint ? (x, y) => { const r = document.caretRangeFromPoint(x, y); return r ? { node: r.startContainer, offset: r.startOffset } : null; }
    : document.caretPositionFromPoint ? (x, y) => { const p = document.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, offset: p.offset } : null; } : null;
  if (caret) {
    const lh = settings.fontSize * settings.lineHeight;
    const colW = state.colW;
    for (let dy = 2; dy < Math.min(state.height, lh * 12); dy += lh / 2) {
      for (const dx of [2, colW * 0.15, colW * 0.35, colW * 0.6]) {
        const hit = caret(left + dx, top + dy);
        if (!hit || !els.content.contains(hit.node)) continue;
        if (hit.node.nodeType === Node.TEXT_NODE) {
          const off = offsetOf(hit.node, hit.offset);
          if (off == null) continue;
          const r = rectForOffset(off);
          if (r && r.right > left - 1 && r.left < right + 1) return { section, offset: off };
        }
      }
    }
  }
  // Slow path: scan nodes for the first one with a box inside the visible page.
  const range = document.createRange();
  for (let i = 0; i < state.nodes.length; i++) {
    const node = state.nodes[i];
    let rects;
    if (node.nodeType === Node.TEXT_NODE) { range.selectNodeContents(node); rects = range.getClientRects(); }
    else rects = [node.getBoundingClientRect()];
    for (const r of rects) {
      if (r.width <= 0 && r.height <= 0) continue;
      if (r.right > left + 0.5 && r.left < right - 0.5) {
        if (node.nodeType !== Node.TEXT_NODE) return { section, offset: state.starts[i] };
        // Binary search for the first character on this page.
        let lo = 0, hi = node.data.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const rr = rectForOffset(state.starts[i] + mid);
          if (rr && rr.left >= left - 0.5) hi = mid; else lo = mid + 1;
        }
        return { section, offset: state.starts[i] + lo };
      }
    }
  }
  return { section, offset: 0 };
}

// ---------------------------------------------------------------- sections
async function fetchSection(idx) {
  if (state.cache.has(idx)) return state.cache.get(idx);
  const res = await fetch(`${base}sections/${idx}.html`, { credentials: 'same-origin' });
  if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; throw new Error('Signed out'); }
  if (!res.ok) throw new Error(`Could not load section ${idx}`);
  const html = await res.text();
  state.cache.set(idx, html);
  if (state.cache.size > 12) state.cache.delete(state.cache.keys().next().value);
  return html;
}

function prefetch(idx) {
  if (idx >= 0 && idx < sections().length && !state.cache.has(idx)) fetchSection(idx).catch(() => {});
}

function waitForImages(root, timeout = 2500) {
  const imgs = [...root.querySelectorAll('img[data-src]')];
  const pending = [];
  for (const img of imgs) {
    img.src = base + img.dataset.src;
    img.removeAttribute('data-src');
    img.removeAttribute('loading');
    if (!img.complete) pending.push(new Promise((resolve) => { img.onload = img.onerror = resolve; }));
  }
  if (!pending.length) return Promise.resolve();
  return Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, timeout))]);
}

async function loadSection(idx) {
  idx = clamp(idx, 0, sections().length - 1);
  const token = ++state.loadToken;
  els.content.classList.add('loading');
  const html = await fetchSection(idx);
  if (token !== state.loadToken) return false;
  els.content.innerHTML = html;
  els.content.lang = state.manifest.language || 'en';
  if (idx === sections().length - 1) {
    const end = document.createElement('p');
    end.className = 'section-end';
    end.textContent = '— The end —';
    els.content.appendChild(end);
  }
  state.section = idx;
  els.content.scrollLeft = 0;
  await waitForImages(els.content);
  if (token !== state.loadToken) return false;
  indexNodes();
  measure();
  els.content.classList.remove('loading');
  prefetch(idx + 1);
  prefetch(idx - 1);
  return true;
}

// ---------------------------------------------------------------- navigation
function showPage(page, { record = true } = {}) {
  state.page = clamp(page, 0, state.pageCount - 1);
  els.content.scrollLeft = state.page * stride();
  if (record) {
    state.locator = locatorForCurrentPage();
    onPositionChanged();
  }
  updateStatus();
}

function onPositionChanged() {
  const { section, offset } = state.locator;
  const last = section === sections().length - 1 && state.page === state.pageCount - 1;
  state.percent = last ? 1 : percentOf(section, offset);
  try { localStorage.setItem(localKey, JSON.stringify({ section, offset, percent: state.percent, updatedAt: Date.now() })); } catch { /* ignore */ }
  state.dirty = true;
  scheduleSync();
}

async function restore(locator, { record = false } = {}) {
  if (state.mode === 'pages') return showPdfPage(locator.section, { record });
  if (locator.section !== state.section || !state.nodes.length) {
    const ok = await loadSection(locator.section);
    if (!ok) return;
  }
  const rect = rectForOffset(locator.offset || 0);
  const page = rect ? pageForRect(rect) : 0;
  state.page = page;
  els.content.scrollLeft = page * stride();
  state.locator = { section: state.section, offset: locator.offset || 0 };
  if (record) onPositionChanged();
  updateStatus();
}

async function navigateTo(target, { pushHistory = false } = {}) {
  if (pushHistory) state.history.push({ ...state.locator });
  if (state.mode === 'pages') { await showPdfPage(target.section, { record: true }); return; }
  if (target.section !== state.section) { const ok = await loadSection(target.section); if (!ok) return; }
  if (target.id) {
    const el = els.content.querySelector(`[id="${CSS.escape(target.id)}"]`);
    if (el) { showPage(pageForElement(el)); updateReturnButton(); return; }
  }
  await restore({ section: state.section, offset: target.offset || 0 }, { record: true });
  updateReturnButton();
}

async function next() {
  if (state.mode === 'pages') return showPdfPage(state.section + 1, { record: true });
  if (state.page < state.pageCount - 1) showPage(state.page + 1);
  else if (state.section < sections().length - 1) { if (await loadSection(state.section + 1)) showPage(0); }
  else toast('End of book');
}

async function prev() {
  if (state.mode === 'pages') return showPdfPage(state.section - 1, { record: true });
  if (state.page > 0) showPage(state.page - 1);
  else if (state.section > 0) { if (await loadSection(state.section - 1)) showPage(state.pageCount - 1); }
}

async function relayout() {
  const loc = { ...state.locator };
  if (state.mode === 'pages') { await showPdfPage(state.section, { record: false }); return; }
  layout();
  measure();
  await restore(loc);
}

// ---------------------------------------------------------------- status / progress ui
function updateStatus() {
  const m = state.manifest;
  const sec = m.sections[state.section] || {};
  const pct = Math.round((state.percent ?? percentOf(state.locator.section, state.locator.offset)) * 100);
  const title = sec.title || '';
  if (state.mode === 'pages') {
    els.statusLeft.textContent = title;
    els.statusRight.textContent = `Page ${sec.page} of ${m.pageCount} · ${pct}%`;
    els.pos.textContent = `${title} · page ${sec.page} of ${m.pageCount}`;
  } else {
    els.statusLeft.textContent = title;
    els.statusRight.textContent = `${pct}% · ${state.page + 1}/${state.pageCount}`;
    els.pos.textContent = `${pct}% · ${title} · page ${state.page + 1} of ${state.pageCount} in this section`;
  }
  els.slider.value = String(Math.round((state.percent ?? 0) * 1000));
  document.title = `${m.title} - rReader`;
}

// ---------------------------------------------------------------- sync
function scheduleSync(ms = 1200) {
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => flushSync(), ms);
}

async function flushSync({ keepalive = false } = {}) {
  if (!state.dirty || state.syncing || !state.manifest) return;
  state.syncing = true;
  const { section, offset } = state.locator;
  const body = { section, offset, percent: state.percent ?? percentOf(section, offset), device: settings.device, knownUpdatedAt: state.known };
  state.dirty = false;
  try {
    const r = await api(`/api/books/${bookId}/progress`, { method: 'PUT', body, keepalive });
    state.known = r.progress.updatedAt;
  } catch (err) {
    if (err.status === 409 && err.body?.progress) {
      await adoptRemote(err.body.progress);
    } else if (err.status !== 401) {
      state.dirty = true; // retry later (offline)
      scheduleSync(15000);
    }
  } finally {
    state.syncing = false;
  }
}

async function adoptRemote(p) {
  state.known = p.updatedAt;
  const same = p.section === state.locator.section && Math.abs(p.offset - state.locator.offset) < 40;
  if (same) return;
  state.dirty = false;
  await restore({ section: p.section, offset: p.offset });
  state.percent = p.percent;
  try { localStorage.setItem(localKey, JSON.stringify({ section: p.section, offset: p.offset, percent: p.percent, updatedAt: p.updatedAt })); } catch { /* ignore */ }
  updateStatus();
  toast(`Moved to your latest position${p.device ? ` from ${p.device}` : ''}`, 3500);
}

async function checkRemote() {
  if (document.visibilityState !== 'visible' || !state.manifest) return;
  try {
    const { progress } = await api(`/api/books/${bookId}/progress`, { noRedirect: true });
    if (progress && progress.updatedAt > state.known) {
      if (state.dirty) await flushSync(); // our own newer change wins if it was made after
      else await adoptRemote(progress);
    }
  } catch { /* offline */ }
}

// ---------------------------------------------------------------- pdf page mode
async function enterPagesMode() {
  if (!state.pdf) {
    state.pdf = new PdfPageView(els.pdfview, els.pdfcanvas);
    try { await state.pdf.open(`${base}original`); } catch (err) { toast('Could not open the PDF pages: ' + err.message); state.pdf = null; return false; }
  }
  state.mode = 'pages';
  els.pdfview.classList.add('on');
  els.viewport.classList.add('hidden');
  await showPdfPage(state.locator.section, { record: false });
  return true;
}

function leavePagesMode() {
  state.mode = 'text';
  els.pdfview.classList.remove('on');
  els.viewport.classList.remove('hidden');
}

async function showPdfPage(sectionIdx, { record }) {
  const idx = clamp(sectionIdx, 0, sections().length - 1);
  if (idx !== sectionIdx && record) toast(sectionIdx < 0 ? 'Start of book' : 'End of book');
  state.section = idx;
  const pageNo = sections()[idx].page || idx + 1;
  await state.pdf.render(pageNo, settings.pdfInvert);
  state.page = 0; state.pageCount = 1;
  state.locator = { section: idx, offset: 0 };
  if (record) onPositionChanged();
  else state.percent = idx === sections().length - 1 ? 1 : percentOf(idx, 0);
  updateStatus();
}

// ---------------------------------------------------------------- panels
function openPanel(id) {
  closePanels();
  $(id).classList.remove('hidden');
  els.backdrop.classList.remove('hidden');
  if (id === 'panel-toc') markCurrentToc();
  if (id === 'panel-bookmarks') renderBookmarks();
}
function closePanels() {
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  els.backdrop.classList.add('hidden');
}
function toggleBars(force) {
  state.barsVisible = force ?? !state.barsVisible;
  els.topbar.classList.toggle('hidden', !state.barsVisible);
  els.bottombar.classList.toggle('hidden', !state.barsVisible);
  if (!state.barsVisible) closePanels();
}

function renderToc() {
  const walk = (entries, depth) => entries.map((e) => `<li class="lvl${depth}"><button data-sec="${e.section ?? ''}" data-id="${escapeHtml(e.id || '')}">${escapeHtml(e.title)}</button>${e.children?.length ? `<ul class="toc">${walk(e.children, depth + 1)}</ul>` : ''}</li>`).join('');
  const toc = state.manifest.toc || [];
  els.toc.innerHTML = toc.length ? walk(toc, 0) : '<li class="muted" style="padding:10px">This book has no table of contents.</li>';
}
function markCurrentToc() {
  const buttons = [...els.toc.querySelectorAll('button')];
  let current = null;
  for (const b of buttons) {
    const sec = parseInt(b.dataset.sec, 10);
    if (Number.isNaN(sec)) continue;
    if (sec < state.section) current = b;
    else if (sec === state.section) {
      if (!b.dataset.id) { current = b; continue; }
      const el = state.mode === 'text' ? els.content.querySelector(`[id="${CSS.escape(b.dataset.id)}"]`) : null;
      if (!el) { current = b; continue; }
      if (pageForElement(el) <= state.page) current = b;
    }
  }
  buttons.forEach((b) => b.classList.toggle('current', b === current));
  current?.scrollIntoView({ block: 'center' });
}

function renderBookmarks() {
  const list = state.bookmarks;
  els.bookmarks.innerHTML = list.length ? list.map((b) => `<div class="bm" data-id="${b.id}">
      <button class="go" data-sec="${b.section}" data-off="${b.offset}"><b>${escapeHtml(b.label || 'Bookmark')}</b><br><span class="muted" style="font-size:13px">${Math.round(b.percent * 100)}% · ${formatDate(b.created_at)}</span></button>
      <button class="del" aria-label="Delete bookmark">&times;</button></div>`).join('')
    : '<p class="muted">No bookmarks yet.</p>';
}

async function addBookmark() {
  const { section, offset } = state.locator;
  let label = sections()[section]?.title || '';
  if (state.mode === 'text' && state.nodes.length) {
    const i = nodeIndexForOffset(offset);
    const node = state.nodes[i];
    const text = node.nodeType === Node.TEXT_NODE ? node.data.slice(offset - state.starts[i], offset - state.starts[i] + 80).trim() : '';
    if (text) label = text.replace(/\s+/g, ' ').slice(0, 60) + (text.length > 60 ? '…' : '');
  }
  const { bookmark } = await api(`/api/books/${bookId}/bookmarks`, { method: 'POST', body: { section, offset, percent: state.percent ?? percentOf(section, offset), label } });
  state.bookmarks.push(bookmark);
  state.bookmarks.sort((a, b) => a.percent - b.percent);
  renderBookmarks();
  toast('Bookmark added');
}

let returnBtn = null;
function updateReturnButton() {
  if (!returnBtn) {
    returnBtn = document.createElement('button');
    returnBtn.className = 'btn small';
    returnBtn.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:calc(28px + var(--safe-bottom));z-index:11;font-family:var(--ui-font)';
    returnBtn.textContent = '↩ Back to where I was';
    returnBtn.addEventListener('click', async () => { const loc = state.history.pop(); if (loc) await navigateTo(loc); updateReturnButton(); });
    document.body.appendChild(returnBtn);
  }
  returnBtn.classList.toggle('hidden', !state.history.length);
}

// ---------------------------------------------------------------- settings panel
function seg(id, key, onChange) {
  const el = $(id);
  const sync = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(settings[key]) === b.dataset.v));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    settings[key] = key === 'lineHeight' ? parseFloat(b.dataset.v) : b.dataset.v;
    saveSettings(settings);
    sync();
    onChange();
  });
  sync();
}
function check(id, key, onChange) {
  const el = $(id);
  el.checked = !!settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(settings); onChange(); });
}

function bindSettings() {
  const typo = () => { applyTheme(settings); relayout(); };
  seg('theme-seg', 'theme', typo);
  check('opt-eink', 'eink', typo);
  seg('lh-seg', 'lineHeight', typo);
  seg('margin-seg', 'margin', typo);
  seg('align-seg', 'align', typo);
  check('opt-hyphens', 'hyphens', typo);
  check('opt-swipe', 'swipe', () => {});
  check('opt-tapzones', 'tapZones', () => {});
  const font = $('font');
  font.innerHTML = FONTS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
  font.value = settings.font;
  font.addEventListener('change', () => { settings.font = font.value; saveSettings(settings); typo(); });
  const out = $('size-out');
  const showSize = () => { out.textContent = `${settings.fontSize}px`; };
  showSize();
  $('size-minus').addEventListener('click', () => { settings.fontSize = clamp(settings.fontSize - 1, 12, 36); saveSettings(settings); showSize(); typo(); });
  $('size-plus').addEventListener('click', () => { settings.fontSize = clamp(settings.fontSize + 1, 12, 36); saveSettings(settings); showSize(); typo(); });
  // Columns control is added dynamically below the margins group.
  const colGroup = document.createElement('div');
  colGroup.className = 'group';
  colGroup.innerHTML = '<span class="lbl">Layout on wide screens</span><div class="seg" id="cols-seg"><button data-v="auto">Auto</button><button data-v="1">One column</button><button data-v="2">Two columns</button></div>';
  $('margin-seg').parentElement.after(colGroup);
  seg('cols-seg', 'columns', typo);
  const dev = $('device-name');
  dev.value = settings.device;
  dev.addEventListener('change', () => { settings.device = dev.value.trim() || guessDeviceName(); saveSettings(settings); });
  $('btn-show-zones').addEventListener('click', () => { closePanels(); toggleBars(false); els.tapHint.classList.remove('hidden'); setTimeout(() => els.tapHint.classList.add('hidden'), 2500); });
  if (state.manifest.format === 'pdf') {
    $('pdf-group').classList.remove('hidden');
    seg('pdfmode-seg', 'pdfMode', async () => { if (settings.pdfMode === 'pages') { if (!(await enterPagesMode())) { settings.pdfMode = 'text'; saveSettings(settings); } } else { leavePagesMode(); await relayout(); } });
    check('opt-pdf-invert', 'pdfInvert', () => { if (state.mode === 'pages') showPdfPage(state.section, { record: false }); });
  }
  $('btn-download').href = `${base}original`;
  $('btn-download').setAttribute('download', state.book.originalName || 'book');
  $('btn-readers').addEventListener('click', async () => {
    const { readers } = await api(`/api/books/${bookId}/readers`);
    alert(readers.length ? readers.map((r) => `${r.displayName || r.username}: ${Math.round(r.percent * 100)}% (${formatDate(r.updatedAt)})`).join('\n') : 'Nobody else has started this book.');
  });
  const b = state.book;
  $('book-info').textContent = `${b.format.toUpperCase()} · ${(b.size / 1048576).toFixed(1)} MB · ${sections().length} sections · added by ${b.addedBy || 'unknown'}`;
}

// ---------------------------------------------------------------- input
function bindInput() {
  // Taps: left/right zones turn pages, the middle toggles the bars.
  let touch = null;
  const vp = els.viewport;
  const onTap = (x, y, target) => {
    if (target.closest('a, button, input, select')) return;
    const w = window.innerWidth;
    if (settings.tapZones && x < w * 0.3) { toggleBars(false); prev(); }
    else if (settings.tapZones && x > w * 0.7) { toggleBars(false); next(); }
    else toggleBars();
  };
  vp.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) {
      if (a.dataset.sec != null) {
        e.preventDefault();
        navigateTo({ section: parseInt(a.dataset.sec, 10), id: a.dataset.id }, { pushHistory: true });
      }
      return;
    }
    if (touch?.handled) { touch = null; return; }
    onTap(e.clientX, e.clientY, e.target);
  });
  els.pdfview.addEventListener('click', (e) => onTap(e.clientX, e.clientY, e.target));
  const swipeRoot = document.body;
  swipeRoot.addEventListener('touchstart', (e) => { if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), handled: false }; }, { passive: true });
  swipeRoot.addEventListener('touchend', (e) => {
    if (!touch || !settings.swipe || e.target.closest('.panel, .bar')) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 80 && Date.now() - touch.t < 800) {
      touch.handled = true;
      toggleBars(false);
      if (dx < 0) next(); else prev();
      setTimeout(() => { touch = null; }, 400);
    }
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const anyPanel = [...document.querySelectorAll('.panel')].some((p) => !p.classList.contains('hidden'));
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter': case 'l': case 'j': if (anyPanel) return; e.preventDefault(); next(); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': case 'h': case 'k': if (anyPanel) return; e.preventDefault(); prev(); break;
      case 'Home': e.preventDefault(); navigateTo({ section: 0, offset: 0 }); break;
      case 'End': e.preventDefault(); navigateTo({ section: sections().length - 1, offset: 1e9 }); break;
      case 'Escape': if (anyPanel) closePanels(); else toggleBars(false); break;
      case 't': openPanel('panel-toc'); break;
      case 'b': openPanel('panel-bookmarks'); break;
      case 's': openPanel('panel-settings'); break;
      case 'm': toggleBars(); break;
      case '+': case '=': settings.fontSize = clamp(settings.fontSize + 1, 12, 36); saveSettings(settings); $('size-out').textContent = `${settings.fontSize}px`; relayout(); break;
      case '-': settings.fontSize = clamp(settings.fontSize - 1, 12, 36); saveSettings(settings); $('size-out').textContent = `${settings.fontSize}px`; relayout(); break;
      default: return;
    }
  });

  $('btn-toc').addEventListener('click', () => openPanel('panel-toc'));
  $('btn-bookmark').addEventListener('click', () => openPanel('panel-bookmarks'));
  $('btn-settings').addEventListener('click', () => openPanel('panel-settings'));
  $('btn-add-bookmark').addEventListener('click', () => addBookmark().catch((e) => toast(e.message)));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
  els.backdrop.addEventListener('click', closePanels);
  els.toc.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sec]');
    if (!b || b.dataset.sec === '') return;
    closePanels(); toggleBars(false);
    navigateTo({ section: parseInt(b.dataset.sec, 10), id: b.dataset.id || undefined });
  });
  els.bookmarks.addEventListener('click', async (e) => {
    const row = e.target.closest('.bm');
    if (!row) return;
    if (e.target.closest('.del')) {
      await api(`/api/books/${bookId}/bookmarks/${row.dataset.id}`, { method: 'DELETE' });
      state.bookmarks = state.bookmarks.filter((b) => String(b.id) !== row.dataset.id);
      renderBookmarks();
      return;
    }
    const go = e.target.closest('.go');
    if (go) { closePanels(); toggleBars(false); navigateTo({ section: parseInt(go.dataset.sec, 10), offset: parseInt(go.dataset.off, 10) }); }
  });
  $('btn-prev-chapter').addEventListener('click', () => navigateTo({ section: Math.max(0, state.section - 1), offset: 0 }));
  $('btn-next-chapter').addEventListener('click', () => navigateTo({ section: Math.min(sections().length - 1, state.section + 1), offset: 0 }));
  els.slider.addEventListener('change', () => {
    const pos = positionFromPercent(parseInt(els.slider.value, 10) / 1000);
    navigateTo(pos);
  });
  els.slider.addEventListener('input', () => {
    const pos = positionFromPercent(parseInt(els.slider.value, 10) / 1000);
    els.pos.textContent = `${Math.round(parseInt(els.slider.value, 10) / 10)}% · ${sections()[pos.section]?.title || ''}`;
  });

  window.addEventListener('resize', debounce(relayout, 150));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(settings));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSync({ keepalive: true });
    else checkRemote();
  });
  window.addEventListener('pagehide', () => flushSync({ keepalive: true }));
  window.addEventListener('online', () => { if (state.dirty) flushSync(); });
  setInterval(checkRemote, 30000);
}

// ---------------------------------------------------------------- start
async function init() {
  applyTheme(settings);
  let data = null;
  try {
    data = await api(`/api/books/${bookId}`);
  } catch (err) {
    if (err.status === 404) { els.loading.textContent = 'This book no longer exists.'; return; }
    // Offline: fall back to the cached manifest and the last local position.
    try {
      const res = await fetch(`${base}book.json`);
      if (!res.ok) throw new Error('offline');
      const manifest = await res.json();
      const local = JSON.parse(localStorage.getItem(localKey) || 'null');
      data = { book: { id: bookId, title: manifest.title, format: manifest.format, size: 0, originalName: '' }, manifest, progress: local, bookmarks: [] };
      toast('Offline - reading from this device\'s cache');
    } catch {
      els.loading.textContent = 'Could not load the book. Check your connection and try again.';
      return;
    }
  }
  const { book, manifest, progress, bookmarks } = data;
  if (!manifest) {
    els.loading.innerHTML = book.status === 'error' ? `Could not convert this book.<br><small>${escapeHtml(book.error || '')}</small>` : 'This book is still being prepared. Please try again in a moment.';
    return;
  }
  state.book = book;
  state.manifest = manifest;
  state.bookmarks = bookmarks || [];
  els.title.textContent = manifest.title;
  if (manifest.hasStyles) { const l = $('book-styles'); l.href = `${base}styles.css`; l.disabled = false; }

  // Where to start: the newest of the server position and this device's last local position.
  const local = (() => { try { return JSON.parse(localStorage.getItem(localKey) || 'null'); } catch { return null; } })();
  let start = { section: 0, offset: 0 };
  if (progress) { start = { section: progress.section, offset: progress.offset }; state.known = progress.updatedAt; }
  if (local && (!progress || local.updatedAt > progress.updatedAt + 2000)) { start = { section: local.section, offset: local.offset }; state.dirty = !!progress || local.percent > 0; }
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has('sec')) start = { section: parseInt(hash.get('sec'), 10) || 0, id: hash.get('id') || undefined, offset: 0 };

  renderToc();
  bindSettings();
  bindInput();
  layout();
  if (manifest.format === 'pdf' && settings.pdfMode === 'pages') {
    state.locator = { section: clamp(start.section, 0, sections().length - 1), offset: 0 };
    const ok = await enterPagesMode();
    if (!ok) await navigateTo(start);
  } else {
    await navigateTo(start);
  }
  state.percent = state.locator.section === sections().length - 1 && state.page === state.pageCount - 1 ? 1 : percentOf(state.locator.section, state.locator.offset);
  updateStatus();
  if (state.dirty) scheduleSync(300);
  els.loading.classList.add('hidden');
  if (!localStorage.getItem('rreader.hinted')) {
    localStorage.setItem('rreader.hinted', '1');
    els.tapHint.classList.remove('hidden');
    setTimeout(() => els.tapHint.classList.add('hidden'), 3000);
  }
}

init().catch((err) => { els.loading.textContent = `Something went wrong: ${err.message}`; console.error(err); });
