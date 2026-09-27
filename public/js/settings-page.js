import { api, requireUser, guessDeviceName } from './api.js';
import { loadSettings, saveSettings, applyTheme } from './settings.js';

const s = loadSettings();
const device = document.getElementById('device');
const theme = document.getElementById('theme');
const eink = document.getElementById('eink');
device.value = s.device || guessDeviceName();
theme.value = s.theme;
eink.checked = !!s.eink;
function persist() {
  const next = { ...loadSettings(), device: device.value.trim(), theme: theme.value, eink: eink.checked };
  saveSettings(next);
  applyTheme(next);
}
device.addEventListener('change', persist);
theme.addEventListener('change', persist);
eink.addEventListener('change', persist);

requireUser().then((user) => {
  document.getElementById('who').textContent = `Signed in as ${user.displayName || user.username} (${user.username})${user.isAdmin ? ' - administrator' : ''}`;
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

document.getElementById('clear-cache').addEventListener('click', async () => {
  if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  alert('Cached books removed from this device.');
});
