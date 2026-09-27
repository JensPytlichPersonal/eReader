import { Router } from 'express';
import { validPassword, validUsername, hashPassword } from '../auth.js';

export function authRoutes(db, auth, config) {
  const r = Router();
  const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

  r.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in', setupRequired: auth.userCount() === 0, allowRegistration: config.allowRegistration });
    res.json({ user: req.user, device: req.device || '' });
  });

  r.post('/login', (req, res) => {
    const { username, password, device } = req.body || {};
    if (!validUsername(username) || typeof password !== 'string') return res.status(400).json({ error: 'Invalid username or password' });
    const user = auth.authenticate(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    auth.login(res, user, device);
    res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, isAdmin: !!user.is_admin } });
  });

  r.post('/logout', (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });

  // Registration: always allowed for the very first account (which becomes admin), otherwise only when enabled.
  r.post('/register', (req, res) => {
    const first = auth.userCount() === 0;
    if (!first && !config.allowRegistration) return res.status(403).json({ error: 'Registration is disabled. Ask an admin to create your account.' });
    const { username, password, displayName, device } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    if (auth.userByName(username)) return res.status(409).json({ error: 'That username is taken' });
    const user = auth.createUser({ username, password, displayName: (displayName || '').trim().slice(0, 80), isAdmin: first });
    auth.login(res, user, device);
    res.status(201).json({ user: { id: user.id, username: user.username, displayName: user.display_name, isAdmin: !!user.is_admin } });
  });

  r.post('/password', auth.requireUser, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const user = auth.authenticate(req.user.username, currentPassword || '');
    if (!user) return res.status(401).json({ error: 'Current password is incorrect' });
    updatePassword.run(hashPassword(newPassword), user.id);
    res.json({ ok: true });
  });

  return r;
}
