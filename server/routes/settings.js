import { Router } from 'express';
import { SettingError } from '../catalogues.js';

// Settings of the whole server that an admin changes from the app. So far the Hardcover token: what
// is sent back says where the token in use comes from and how it ends, never the token itself.
export function settingsRoutes(auth, catalogues) {
  const r = Router();
  r.use(auth.requireAdmin);

  r.get('/', (req, res) => res.json({ hardcover: catalogues.hardcoverStatus() }));

  // Body: { hardcoverToken }, the token as Hardcover shows it (with or without "Bearer "), or '' to
  // remove the one saved here. It is used at once.
  r.put('/', (req, res) => {
    const token = req.body?.hardcoverToken;
    if (typeof token !== 'string') return res.status(400).json({ error: "hardcoverToken must be the token as text, or '' to remove it" });
    try {
      res.json({ hardcover: catalogues.setHardcoverToken(token, req.user.id) });
    } catch (err) {
      if (err instanceof SettingError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  // Whether Hardcover takes the token in use: { ok: true }, or { ok: false, error } saying why not.
  // Either way it is an answer to show, so the status is 200.
  r.post('/hardcover/check', async (req, res) => res.json(await catalogues.checkHardcover()));

  return r;
}
