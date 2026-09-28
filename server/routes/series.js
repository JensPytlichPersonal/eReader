import { Router } from 'express';
import { cleanSeriesName } from '../converters/series.js';
import { LookupError } from '../lookup.js';

// Series and collections span books added by different people, so changing one as a whole is for admins.
// A single book's series are edited with PATCH /api/books/:id.
// `missingBooks` finds the books a series lacks on Hardcover (see missing.js); null without a Hardcover token.
export function seriesRoutes(auth, series, missingBooks = null) {
  const r = Router();
  r.use(auth.requireUser);

  const find = (req, res) => {
    const found = /^\d+$/.test(req.params.id) ? series.get(Number(req.params.id)) : null;
    if (!found) res.status(404).json({ error: 'No such series or collection' });
    return found;
  };

  // The books of a series the library does not have, as Hardcover lists them: { series, missing },
  // where `series` is the Hardcover series they are from, or null when none fits. A collection
  // without numbers lacks none.
  r.get('/:id/missing', async (req, res) => {
    const s = find(req, res);
    if (!s) return;
    const books = series.books(s.id);
    if (!missingBooks || !books.some((b) => b.position != null)) return res.json({ series: null, missing: [] });
    try {
      res.json(await missingBooks.forSeries({ name: s.name, books }));
    } catch (err) {
      if (err instanceof LookupError) return res.status(502).json({ error: err.message });
      throw err;
    }
  });

  // Rename. Renaming to the name of another series or collection merges the two.
  r.patch('/:id', auth.requireAdmin, (req, res) => {
    const s = find(req, res);
    if (!s) return;
    const name = cleanSeriesName(typeof req.body?.name === 'string' ? req.body.name : '');
    if (!name) return res.status(400).json({ error: 'Give the series or collection a name' });
    res.json({ series: series.get(series.rename(s.id, name)) });
  });

  // Dissolve. The books stay in the library.
  r.delete('/:id', auth.requireAdmin, (req, res) => {
    const s = find(req, res);
    if (!s) return;
    series.remove(s.id);
    res.json({ ok: true });
  });

  return r;
}
