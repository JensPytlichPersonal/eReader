import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PUBLIC_DIR, loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createAuth } from './auth.js';
import { createProcessor } from './processing/queue.js';
import { createSeriesStore } from './series.js';
import { createOpenLibrary } from './openlibrary.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { bookRoutes, bookFiles } from './routes/books.js';
import { seriesRoutes } from './routes/series.js';
import { fontsCss, fontsDir, heavierFontCss } from './fonts.js';

const require = createRequire(import.meta.url);

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.booksDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  const auth = createAuth(db, config);
  const log = overrides.quiet ? { info() {}, error() {} } : console;
  const series = createSeriesStore(db);
  const processor = createProcessor(db, config, series, log);
  // Tests hand in a client for a stand-in Open Library.
  const openLibrary = overrides.openLibrary ?? createOpenLibrary();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(auth.middleware);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/api/auth', authRoutes(db, auth, config));
  app.use('/api/users', userRoutes(db, auth));
  app.use('/api/books', bookRoutes(db, auth, config, processor, series, openLibrary));
  app.use('/api/series', seriesRoutes(auth, series));
  app.use('/books', bookFiles(db, auth, config));
  app.get('/api/health', (req, res) => res.json({ ok: true, processing: processor.isBusy() }));

  // Third-party client libraries served straight from node_modules.
  const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  app.use('/vendor/pdfjs/legacy', express.static(path.join(pdfjsDir, 'legacy', 'build'), { immutable: true, maxAge: '30d' }));
  app.use('/vendor/pdfjs/cmaps', express.static(path.join(pdfjsDir, 'cmaps'), { immutable: true, maxAge: '30d' }));
  app.use('/vendor/pdfjs/standard_fonts', express.static(path.join(pdfjsDir, 'standard_fonts'), { immutable: true, maxAge: '30d' }));
  // The decoders for the images of most scans (JBIG2, CCITT fax, JPEG 2000) and colour profiles. Without them such pages draw blank.
  app.use('/vendor/pdfjs/wasm', express.static(path.join(pdfjsDir, 'wasm'), { immutable: true, maxAge: '30d' }));
  app.use('/vendor/pdfjs/iccs', express.static(path.join(pdfjsDir, 'iccs'), { immutable: true, maxAge: '30d' }));
  app.use('/vendor/fonts', express.static(fontsDir, { immutable: true, maxAge: '30d' }));
  const fonts = fontsCss();
  app.get('/css/fonts.css', (req, res) => res.type('text/css').set('Cache-Control', 'no-cache').send(fonts));
  // A bundled font drawn heavier, for the text weight setting: /css/fonts/literata-600.css
  const heavier = new Map();
  app.get('/css/fonts/:file', (req, res, next) => {
    const [file, name, weight] = /^([a-z-]+)-(\d{3})\.css$/.exec(req.params.file) || [];
    if (!file) return next();
    if (!heavier.has(file)) {
      const css = heavierFontCss(name, Number(weight));
      if (!css) return next();
      heavier.set(file, css);
    }
    res.type('text/css').set('Cache-Control', 'no-cache').send(heavier.get(file));
  });

  // App pages
  const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name), { headers: { 'Cache-Control': 'no-cache' } });
  app.get('/', page('index.html'));
  app.get('/login', page('login.html'));
  app.get('/read/:id', page('reader.html'));
  app.get('/users', page('users.html'));
  app.get('/settings', page('settings.html'));
  app.get('/sw.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'sw.js'), { headers: { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' } }));
  // Scripts and styles are checked for changes on every load, like the pages, so after an update a device never runs
  // old scripts with a new page and a reload always gets the new version. Unchanged files cost a short "not modified".
  const revalidate = (res, file) => { if (/\.(js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); };
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false, setHeaders: revalidate }));

  // Errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: `File is too large (limit ${Math.round((err.limit ?? config.maxUploadBytes) / 1048576)} MB)` });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    log.error?.(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, db, auth, config, processor, series };
}
