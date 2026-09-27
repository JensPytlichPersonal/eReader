// Thin fetch wrapper. Redirects to the login page when the session is gone.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, raw = false, keepalive = false, noRedirect = false } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin', keepalive };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(path, opts);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (res.status === 401 && !noRedirect && !location.pathname.startsWith('/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export async function requireUser() {
  const me = await api('/api/auth/me');
  return me.user;
}

export function toast(message, ms = 2500) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

// Timestamps read the same on every device: Danish time (CET, CEST in summer) on a 24-hour clock. Browsers often ignore the
// system's 24-hour and region settings and format by their own language (typically 12-hour US English), so the browser's locale is not used.
const TIME_ZONE = 'Europe/Copenhagen';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const danishClock = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const inDenmark = (d) => Object.fromEntries(danishClock.formatToParts(d).map((p) => [p.type, p.value]));

// Today's timestamps show the time ("14:05"), older ones the date ("27 Sep", or "27 Sep 2025" in other years).
export function formatDate(ts, now = Date.now()) {
  if (!ts) return '';
  const t = inDenmark(new Date(ts));
  const today = inDenmark(now);
  if (t.year === today.year && t.month === today.month && t.day === today.day) return `${t.hour}:${t.minute}`;
  const date = `${Number(t.day)} ${MONTHS[t.month - 1]}`;
  return t.year === today.year ? date : `${date} ${t.year}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Boox|Onyx/i.test(ua)) return 'Boox';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

export function registerServiceWorker() {
  // Service workers need a secure context (https, or localhost). On plain http over a LAN the app still works, just without offline caching.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
