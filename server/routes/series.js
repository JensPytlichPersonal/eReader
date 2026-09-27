import { Router } from 'express';
import { cleanSeriesName } from '../converters/series.js';

// Series and collections span books added by different people, so changing one as a whole is for admins.
// A single book's series are edited with PATCH /api/books/:id.
export function seriesRoutes(auth, series) {
  const r = Router();
  r.use(auth.requireAdmin);

  const find = (req, res) => {
    const found = /^\d+$/.test(req.params.id) ? series.get(Number(req.params.id)) : null;
    if (!found) res.status(404).json({ error: 'No such series or collection' });
    return found;
  };

  // Rename. Renaming to the name of another series or collection merges the two.
  r.patch('/:id', (req, res) => {
    const s = find(req, res);
    if (!s) return;
    const name = cleanSeriesName(typeof req.body?.name === 'string' ? req.body.name : '');
    if (!name) return res.status(400).json({ error: 'Give the series or collection a name' });
    res.json({ series: series.get(series.rename(s.id, name)) });
  });

  // Dissolve. The books stay in the library.
  r.delete('/:id', (req, res) => {
    const s = find(req, res);
    if (!s) return;
    series.remove(s.id);
    res.json({ ok: true });
  });

  return r;
}
