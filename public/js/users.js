import { api, requireUser, escapeHtml, formatDate, toast } from './api.js';

const list = document.getElementById('list');
const form = document.getElementById('add-form');
const error = document.getElementById('error');
let me = null;

async function load() {
  const { users } = await api('/api/users');
  list.innerHTML = `<table class="list"><thead><tr><th>User</th><th>Role</th><th>Reading</th><th></th></tr></thead><tbody>${users.map((u) => `
    <tr data-id="${u.id}">
      <td><b>${escapeHtml(u.displayName)}</b><br><span class="muted">${escapeHtml(u.username)}</span></td>
      <td>${u.isAdmin ? 'Admin' : 'Reader'}</td>
      <td>${u.booksStarted} book${u.booksStarted === 1 ? '' : 's'}${u.lastRead ? `<br><span class="muted">last ${formatDate(u.lastRead)}</span>` : ''}</td>
      <td class="row" style="justify-content:flex-end">
        <button class="btn small" data-act="password">Reset password</button>
        <button class="btn small" data-act="admin">${u.isAdmin ? 'Make reader' : 'Make admin'}</button>
        ${u.id === me.id ? '' : '<button class="btn small danger" data-act="delete">Delete</button>'}
      </td>
    </tr>`).join('')}</tbody></table>`;
}

list.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('tr');
  const id = row.dataset.id;
  const name = row.querySelector('b').textContent;
  try {
    if (btn.dataset.act === 'delete') {
      if (!confirm(`Delete ${name}? Their reading progress and bookmarks will be removed. Books stay in the library.`)) return;
      await api(`/api/users/${id}`, { method: 'DELETE' });
    } else if (btn.dataset.act === 'password') {
      const pw = prompt(`New password for ${name}:`);
      if (!pw) return;
      await api(`/api/users/${id}`, { method: 'PATCH', body: { password: pw } });
      toast('Password updated');
    } else if (btn.dataset.act === 'admin') {
      await api(`/api/users/${id}`, { method: 'PATCH', body: { isAdmin: btn.textContent.includes('admin') } });
    }
    await load();
  } catch (err) { alert(err.message); }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.classList.add('hidden');
  try {
    await api('/api/users', { method: 'POST', body: { username: form.u.value.trim(), displayName: form.d.value.trim(), password: form.p.value, isAdmin: form.a.checked } });
    form.reset();
    await load();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});

requireUser().then((u) => { me = u; if (!u.isAdmin) { location.href = '/'; return; } load(); });
