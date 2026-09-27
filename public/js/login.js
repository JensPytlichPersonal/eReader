import { api, guessDeviceName, registerServiceWorker } from './api.js';
import { loadSettings, saveSettings } from './settings.js';

registerServiceWorker();
const form = document.getElementById('form');
const errorEl = document.getElementById('error');
const heading = document.getElementById('heading');
const setupNote = document.getElementById('setup-note');
const displayField = document.getElementById('display-field');
const submit = document.getElementById('submit');
const toggle = document.getElementById('toggle-register');
const deviceInput = document.getElementById('device');
const settings = loadSettings();
deviceInput.value = settings.device || guessDeviceName();
let mode = 'login';
let state = { setupRequired: false, allowRegistration: false };

function setMode(m) {
  mode = m;
  const registering = m === 'register';
  heading.textContent = state.setupRequired ? 'Create the first account' : registering ? 'Create account' : 'Sign in';
  submit.textContent = registering ? 'Create account' : 'Sign in';
  displayField.classList.toggle('hidden', !registering);
  toggle.textContent = registering ? 'I already have an account' : 'Create account';
  toggle.classList.toggle('hidden', state.setupRequired || !state.allowRegistration);
}

async function init() {
  try {
    const me = await api('/api/auth/me', { noRedirect: true });
    if (me?.user) return redirect();
  } catch (err) {
    state.setupRequired = !!err.body?.setupRequired;
    state.allowRegistration = !!err.body?.allowRegistration;
  }
  setupNote.classList.toggle('hidden', !state.setupRequired);
  setMode(state.setupRequired ? 'register' : 'login');
}

function redirect() {
  const next = new URLSearchParams(location.search).get('next');
  location.href = next && next.startsWith('/') ? next : '/';
}

toggle.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');
  submit.disabled = true;
  const device = deviceInput.value.trim() || guessDeviceName();
  saveSettings({ ...loadSettings(), device });
  const body = { username: form.username.value.trim(), password: form.password.value, device };
  if (mode === 'register') body.displayName = form.displayName.value.trim();
  try {
    await api(mode === 'register' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body, noRedirect: true });
    redirect();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    submit.disabled = false;
  }
});

init();
