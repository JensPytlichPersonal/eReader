import { Router } from 'express';
import { validPassword, validUsername, hashPassword } from '../auth.js';

export function userRoutes(db, auth) {
  const r = Router();
  const list = db.prepare(`SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at,
      (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id) AS books_started,
      (SELECT MAX(updated_at) FROM progress p WHERE p.user_id = u.id) AS last_read
    FROM users u ORDER BY u.username`);
  const del = db.prepare('DELETE FROM users WHERE id = ?');
  const update = db.prepare('UPDATE users SET display_name = ?, is_admin = ? WHERE id = ?');
  const setPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  const countAdmins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');

  const shape = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin, createdAt: u.created_at, booksStarted: u.books_started, lastRead: u.last_read });

  r.use(auth.requireAdmin);

  r.get('/', (req, res) => res.json({ users: list.all().map(shape) }));

  r.post('/', (req, res) => {
    const { username, password, displayName, isAdmin } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    if (auth.userByName(username)) return res.status(409).json({ error: 'That username is taken' });
    const user = auth.createUser({ username, password, displayName: (displayName || '').trim().slice(0, 80), isAdmin: !!isAdmin });
    res.status(201).json({ user: shape({ ...user, books_started: 0, last_read: null }) });
  });

  r.patch('/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const user = auth.userById(id);
    if (!user) return res.status(404).json({ error: 'No such user' });
    const { displayName, isAdmin, password } = req.body || {};
    const nextAdmin = isAdmin == null ? !!user.is_admin : !!isAdmin;
    if (user.is_admin && !nextAdmin && countAdmins.get().n <= 1) return res.status(400).json({ error: 'Cannot remove the last admin' });
    update.run((displayName ?? user.display_name).toString().trim().slice(0, 80) || user.username, nextAdmin ? 1 : 0, id);
    if (password != null) {
      if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 4 characters' });
      setPassword.run(hashPassword(password), id);
      auth.deleteUserSessions(id);
    }
    res.json({ user: shape({ ...auth.userById(id), books_started: 0, last_read: null }) });
  });

  r.delete('/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    const user = auth.userById(id);
    if (!user) return res.status(404).json({ error: 'No such user' });
    if (user.is_admin && countAdmins.get().n <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    del.run(id);
    res.json({ ok: true });
  });

  return r;
}
