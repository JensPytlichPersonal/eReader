import { api, requireUser, guessDeviceName } from './api.js';
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

// On the home screen the app has no browser buttons, so this is its reload: it starts again from the library.
document.getElementById('reload').addEventListener('click', () => { location.href = '/'; });

document.getElementById('clear-cache').addEventListener('click', async () => {
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  alert('Cached books removed from this device.');
});
