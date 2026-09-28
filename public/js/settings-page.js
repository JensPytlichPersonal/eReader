import { api, requireUser, guessDeviceName, formatDate } from './api.js';
import { loadSettings, saveSettings, applyTheme, resolveSkin, fontOptions, adoptAccountFont, saveAccountFont } from './settings.js';

const s = loadSettings();
const device = document.getElementById('device');
const theme = document.getElementById('theme');
const skin = document.getElementById('skin');
const eink = document.getElementById('eink');
device.value = s.device || guessDeviceName();
theme.value = s.theme;
// The look in use, which is this device's own until one is picked (see resolveSkin()). Only picking one
// here stores it: the other fields leave 'auto' alone, so a new Boox device name still counts.
skin.value = resolveSkin(s);
let chosenSkin = s.skin;
eink.checked = !!s.eink;
// High contrast belongs to the e-ink look, so it only shows with it.
const showEink = () => eink.closest('.field').classList.toggle('hidden', skin.value !== 'eink');
showEink();
function persist() {
  const next = { ...loadSettings(), device: device.value.trim(), theme: theme.value, skin: chosenSkin, eink: eink.checked };
  saveSettings(next);
  applyTheme(next);
  skin.value = resolveSkin(next);
  showEink();
}
device.addEventListener('change', persist);
theme.addEventListener('change', persist);
skin.addEventListener('change', () => { chosenSkin = skin.value; persist(); });
// Turning high contrast off must not swap the whole look, so under 'auto' the look shown is kept.
eink.addEventListener('change', () => { if (chosenSkin === 'auto') chosenSkin = skin.value; persist(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(loadSettings()));

// The font belongs to the account, so it is the same on every device.
const font = document.getElementById('font');
font.innerHTML = fontOptions();
font.value = s.font;
font.addEventListener('change', () => { saveSettings({ ...loadSettings(), font: font.value }); saveAccountFont(font.value); });

requireUser().then((user) => {
  document.getElementById('who').textContent = `Signed in as ${user.displayName || user.username} (${user.username})${user.isAdmin ? ' - administrator' : ''}`;
  if (adoptAccountFont(user)) font.value = user.font;
  if (user.isAdmin) showCatalogues();
});

document.getElementById('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('error');
  const ok = document.getElementById('ok');
  err.classList.add('hidden'); ok.classList.add('hidden');
  try {
    await api('/api/auth/password', { method: 'POST', body: { currentPassword: document.getElementById('cur').value, newPassword: document.getElementById('new').value } });
    ok.classList.remove('hidden');
    e.target.reset();
  } catch (error) {
    err.textContent = error.message;
    err.classList.remove('hidden');
  }
});

// The Hardcover token, for admins. The server says where the token in use comes from and how it ends,
// never the token itself.
const hc = {
  section: document.getElementById('catalogues'),
  status: document.getElementById('hc-status'),
  form: document.getElementById('hc-form'),
  token: document.getElementById('hc-token'),
  error: document.getElementById('hc-error'),
  ok: document.getElementById('hc-ok'),
  check: document.getElementById('hc-check'),
  remove: document.getElementById('hc-remove'),
};

function hcSay({ ok = '', error = '' } = {}) {
  hc.ok.textContent = ok;
  hc.ok.classList.toggle('hidden', !ok);
  hc.error.textContent = error;
  hc.error.classList.toggle('hidden', !error);
}

function showStatus({ source, hint, updatedAt, updatedBy }) {
  const ends = `(ends in …${hint})`;
  hc.status.textContent = source === 'settings' ? `Set ${formatDate(updatedAt)}${updatedBy ? ` by ${updatedBy}` : ''} ${ends}.`
    : source === 'env' ? `Set on the server as HARDCOVER_TOKEN ${ends}.`
    : 'Not set. Books are looked up on Open Library alone.';
  hc.remove.classList.toggle('hidden', source !== 'settings');
  hc.check.classList.toggle('hidden', source === 'none');
}

async function showCatalogues() {
  hc.section.classList.remove('hidden');
  try {
    showStatus((await api('/api/settings')).hardcover);
  } catch (error) {
    hcSay({ error: error.message });
  }
}

// Asks Hardcover whether it takes the token in use.
async function checkHardcover() {
  hc.check.disabled = true;
  try {
    const answer = await api('/api/settings/hardcover/check', { method: 'POST' });
    hcSay(answer.ok ? { ok: 'Hardcover answers.' } : { error: answer.error });
  } catch (error) {
    hcSay({ error: error.message });
  } finally {
    hc.check.disabled = false;
  }
}

hc.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // An empty field would remove the token; that is what Remove is for.
  if (!hc.token.value.trim()) return hcSay({ error: 'Paste a token first.' });
  const save = hc.form.querySelector('[type=submit]');
  save.disabled = true;
  hcSay();
  try {
    const { hardcover } = await api('/api/settings', { method: 'PUT', body: { hardcoverToken: hc.token.value } });
    hc.token.value = '';
    showStatus(hardcover);
    await checkHardcover();
  } catch (error) {
    hcSay({ error: error.message });
  } finally {
    save.disabled = false;
  }
});

hc.check.addEventListener('click', () => { hcSay(); checkHardcover(); });

hc.remove.addEventListener('click', async () => {
  if (!confirm('Remove the Hardcover token from this server?')) return;
  hcSay();
  try {
    showStatus((await api('/api/settings', { method: 'PUT', body: { hardcoverToken: '' } })).hardcover);
  } catch (error) {
    hcSay({ error: error.message });
  }
});

// On the home screen the app has no browser buttons, so this is its reload: it starts again from the library.
document.getElementById('reload').addEventListener('click', () => { location.href = '/'; });

document.getElementById('clear-cache').addEventListener('click', async () => {
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  alert('Cached books removed from this device.');
});
