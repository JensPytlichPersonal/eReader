import crypto from 'node:crypto';
import { now } from './db.js';

const SCRYPT_N = 16384;
const COOKIE = 'ereader_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, nStr, saltB64, hashB64] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: parseInt(nStr, 10) });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function validUsername(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9._-]{2,32}$/.test(name);
}

export function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 4 && pw.length <= 256;
}

export function createAuth(db, config) {
  const stmts = {
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, device, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    findSession: db.prepare(`SELECT s.token, s.expires_at, s.last_seen, s.device, u.id AS user_id, u.username, u.display_name, u.is_admin, u.font
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'),
  };

  const sessionMs = config.sessionDays * 86400 * 1000;

  function cookieHeader(token, maxAgeSeconds) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
    if (config.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function userCount() {
    return stmts.countUsers.get().n;
  }

  function createUser({ username, password, displayName, isAdmin }) {
    const t = now();
    const info = stmts.insertUser.run(username, displayName || username, hashPassword(password), isAdmin ? 1 : 0, t);
    return stmts.userById.get(info.lastInsertRowid);
  }

  function login(res, user, device) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    stmts.insertSession.run(token, user.id, (device || '').slice(0, 120), t, t, t + sessionMs);
    res.setHeader('Set-Cookie', cookieHeader(token, Math.floor(sessionMs / 1000)));
    return token;
  }

  function logout(req, res) {
    if (req.sessionToken) stmts.deleteSession.run(req.sessionToken);
    res.setHeader('Set-Cookie', cookieHeader('', 0));
  }

  // Express middleware: attaches req.user when a valid session cookie is present.
  function middleware(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE];
    req.user = null;
    req.sessionToken = null;
    if (token) {
      const row = stmts.findSession.get(token);
      const t = now();
      if (row && row.expires_at > t) {
        req.user = { id: row.user_id, username: row.username, displayName: row.display_name, isAdmin: !!row.is_admin, font: row.font };
        req.sessionToken = token;
        req.device = row.device;
        // Slide the expiry forward at most once an hour to keep writes down.
        if (t - row.last_seen > 3600 * 1000) {
          stmts.touchSession.run(t, t + sessionMs, token);
          res.setHeader('Set-Cookie', cookieHeader(token, Math.floor(sessionMs / 1000)));
        }
      } else if (row) {
        stmts.deleteSession.run(token);
      }
    }
    next();
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    next();
  }

  function authenticate(username, password) {
    const user = stmts.userByName.get(username);
    if (!user) return null;
    return verifyPassword(password, user.password_hash) ? user : null;
  }

  function purgeExpired() {
    stmts.purge.run(now());
  }

  return {
    middleware, requireUser, requireAdmin, login, logout, authenticate, createUser, userCount, purgeExpired,
    userById: (id) => stmts.userById.get(id),
    userByName: (name) => stmts.userByName.get(name),
    deleteUserSessions: (id) => stmts.deleteUserSessions.run(id),
  };
}
