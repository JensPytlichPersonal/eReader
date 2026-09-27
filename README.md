# eReader

A self-hosted web e-reader for the whole household. Upload EPUB, MOBI, PDF, Markdown and
text files once; everyone with an account can read every book, and each reader's position
in each book follows them between their e-ink reader, phone, tablet and laptop.

Built for e-ink first (Boox and friends), and just as usable in Safari on iOS or in any
desktop browser. No animations, big tap targets, high contrast, paginated text.

## What it does

- **One library, many readers.** Every user sees every book. Reading position and bookmarks are kept per user.
- **Your place follows you.** The server stores the latest position per user and book. Opening a
  book on any device jumps to the newest position, and a device that fell behind catches up
  automatically (with a small "moved to your latest position from Boox" note).
- **Every format looks the same.** EPUB, MOBI/AZW/AZW3, PDF, Markdown and plain text are converted
  on the server into the same normalised HTML, so the reader renders them all with one consistent
  look: your font, your size, your margins. PDFs get a reflowed text view plus an "original pages"
  view for figures, tables and scans.
- **Per-device appearance.** Font, text size, line spacing, margins, alignment, hyphenation, light /
  sepia / dark / system theme and a high-contrast e-ink switch are stored on each device
  separately. Your Boox can be light, large and serif while your phone is dark and sans-serif.
- **Any screen size.** Single column on phones and e-readers, two columns on wide screens (or force
  either). Turn pages by tapping the left/right edge, swiping, or with the keyboard.
- **Table of contents, bookmarks, progress slider, chapter titles** and a "who else is reading" peek.
- **Upload from the app** (button or drag and drop). Conversion runs in the background.
- **Installable.** Add it to the home screen on iOS or Android for a full-screen app. Books you have
  opened are cached for offline reading when served over https.

## Quick start

Requires Node.js 22.13 or newer (it uses the built-in SQLite module).

```bash
npm install
npm start
```

Open http://localhost:8080. The first account you create becomes the administrator, who can add
other readers under **Users**. Registration is otherwise closed unless you start the server with
`ALLOW_REGISTRATION=true`.

### Keeping it running

eReader is a single Node process, so any process manager works. On a Linux server, a systemd
unit is enough. Create a user for it, clone the repository somewhere it can read, and save this as
`/etc/systemd/system/ereader.service`:

```ini
[Unit]
Description=eReader web e-reader
After=network.target

[Service]
User=ereader
WorkingDirectory=/opt/ereader
Environment=PORT=8080
Environment=DATA_DIR=/var/lib/ereader
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning server/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo mkdir -p /var/lib/ereader && sudo chown ereader /var/lib/ereader
sudo systemctl daemon-reload
sudo systemctl enable --now ereader
```

Everything the app stores (database, uploaded originals, converted books) lives in `DATA_DIR`.
Back up that directory and you have everything.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `./data` | Where the database and books are stored |
| `ALLOW_REGISTRATION` | `false` | Let anyone create an account (the very first account is always allowed) |
| `SESSION_DAYS` | `365` | How long a sign-in lasts on a device |
| `MAX_UPLOAD_MB` | `500` | Maximum upload size |
| `SECURE_COOKIES` | `false` | Set to `true` when the server is only reachable over https |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy that sets `X-Forwarded-*` |

Run it behind a reverse proxy with https (Caddy, nginx, Traefik) for use outside your home network.
https also enables the offline cache and lets the app be installed as a proper web app.

## Using it on your devices

**Boox Go 6 (and other e-ink Android devices).** Open the address in the built-in browser or Chrome,
sign in once (sessions last a year), then use the browser's "Add to home screen" so it opens full
screen. In the reader's **Aa** panel pick *Light* and turn on *High contrast (e-ink)*. Tap the right
third of the screen for the next page, the left third for the previous page, the middle for the menu.
Swiping can be turned off there if your device registers accidental swipes.

**iPhone and iPad.** Open it in Safari, tap Share, then *Add to Home Screen*. It runs full screen
without browser chrome; the safe areas around the notch and home indicator are respected.

**Laptop.** Arrow keys, space, Page Up/Down turn pages; `t` opens the contents, `b` bookmarks, `s`
the display settings, `m` the menu, `+`/`-` change the text size, Home/End jump to the start or end.
Wide windows show two columns; switch to one column in the display settings if you prefer.

## Formats

| Format | Notes |
| --- | --- |
| EPUB 2 and 3 | Chapters, images, table of contents (nav or NCX), footnote links. Publisher CSS is reduced to a few typographic hints so every book follows your settings. |
| MOBI, PRC, AZW, AZW3/KF8 | PalmDOC and HUFF/CDIC compression, images, table of contents from the NCX index, hybrid MOBI7+KF8 files. DRM-protected files are rejected. |
| PDF | Text is extracted per page into paragraphs (running headers, page numbers and hyphenation are cleaned up); each PDF page is one section so the reflowed view and the *Original pages* view share the same position. Scanned PDFs without text can still be read in the page view. |
| Markdown | CommonMark + GitHub tables, YAML front matter for title/author, headings become the table of contents. |
| Text | Paragraph and heading detection, including hard-wrapped Gutenberg-style text; UTF-8, UTF-16 and Latin-1. |

Converted books are stored as small HTML sections under `data/books/<id>/`. If a book converts
badly, choose *Convert again* from its menu, or re-run every book with `npm run reprocess` after an
update to the converters.

## How position sync works

A position is `(section, character offset)` into the normalised text, not a page number, so it is
independent of screen size and font. When you turn a page the reader records the first visible
character and sends it to the server (debounced, and again when the app goes to the background).
The server keeps the newest position per user and book. If another device has written a newer
position since this device last synced, the server answers with that position and the reader jumps
there. The reader also checks for a newer position when it comes back to the foreground and every
30 seconds while open.

## Development

```bash
npm run dev      # restart on changes
npm test         # converter unit tests and API integration tests
```

Layout of the code:

- `server/` Express app, SQLite schema (`node:sqlite`), session auth, upload and progress API
- `server/converters/` one module per format plus the shared HTML normaliser, chunker and bundle writer
- `public/` the web app: library, reader (`js/reader.js`), settings, users, service worker
- `test/` tests and fixture builders (a tiny ZIP/EPUB writer, a MOBI writer with PalmDOC compression, a PDF writer)

## License

MIT
