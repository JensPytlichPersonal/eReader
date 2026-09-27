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
- **Your font everywhere, the rest per device.** The font you pick is saved to your account and used
  on all your devices. Six reading fonts come with the app, so they look the same on every device:
  Literata (the default), Merriweather, Libre Baskerville, Bitter, Atkinson Hyperlegible and
  OpenDyslexic, all under the SIL Open Font License. The fonts installed on a device can be picked
  too. Text size, text weight, line spacing, margins, alignment, hyphenation, the theme (light, sepia,
  dark, or following the device, which is the default) and a high-contrast e-ink switch are stored on
  each device separately, so your Boox can be light and large while your phone is dark and small,
  both in the same font.
- **Heavier text for e-ink.** E-ink screens draw thin strokes as light grey, so the text weight
  (normal, medium, semibold or bold) makes letters darker. Literata, Merriweather, Libre Baskerville
  and Bitter switch to their own heavier faces, bold text included, up to the heaviest each font has.
  Atkinson Hyperlegible, OpenDyslexic and the fonts installed on a device get a thin outline instead,
  which adds about as much ink.
- **Any screen size.** Single column on phones and e-readers, two columns on wide screens (or force
  either). Turn pages by tapping the left/right edge, swiping, or with the keyboard.
- **Series and collections.** In the library a series is one stack of books, topped by the one you're
  on; opening it lists the books in reading order with a button that continues where you are. Series
  are picked up from the books themselves, and any books can be grouped by hand.
- **List or cards.** The View menu shows the library as a list or as cards in three sizes. On a phone
  the cards are 2, 3 or 4 across, and the tabs, search, menus, upload and account links sit behind
  the ☰ button so the books fill the screen.
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

### Deploying on merge

`.github/workflows/deploy.yml` deploys `main` whenever a pull request is merged (or on demand from
the **Actions** tab with **Run workflow**). It runs the tests, then connects to the server over SSH
with a key that is allowed to do exactly one thing: run `deploy/ereader-deploy.sh`. That script
fetches `main`, reinstalls dependencies unless `node_modules` matches the current lockfile, restarts the service and waits for
`/api/health` to answer, rolling back to the previous commit if it does not. Pull requests get the
same tests as a check from `.github/workflows/test.yml`.

One-time setup, assuming the checkout in `/opt/ereader` and the unit above:

1. On the server, create a user that owns the checkout and may restart the service, and nothing else:

   ```bash
   sudo adduser --disabled-password --gecos "eReader deploys" deploy
   sudo chown -R deploy:deploy /opt/ereader
   echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart ereader' | sudo tee /etc/sudoers.d/ereader-deploy
   sudo chmod 440 /etc/sudoers.d/ereader-deploy && sudo visudo -cf /etc/sudoers.d/ereader-deploy
   ```

2. On your own machine, make a key for GitHub Actions, without a passphrase:

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'github-actions ereader deploy' -f ereader-deploy
   ```

   Put the public half (`ereader-deploy.pub`) on the server as the single line of
   `/home/deploy/.ssh/authorized_keys` (directory mode 700, file mode 600, both owned by `deploy`),
   prefixed with the options that pin it to the deploy script:

   ```
   command="/opt/ereader/deploy/ereader-deploy.sh",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA… github-actions ereader deploy
   ```

   Whatever a client asks for, this key only ever runs that script. Try it from your machine:
   `ssh -i ereader-deploy deploy@books.pytlich.dk` should print `already at …` or deploy.

3. In the repository on GitHub, under **Settings → Secrets and variables → Actions**, add two secrets:

   - `DEPLOY_SSH_KEY`: the contents of the private key file `ereader-deploy`
   - `DEPLOY_KNOWN_HOSTS`: the server's host key, the output of `ssh-keyscan -t ed25519 books.pytlich.dk`.
     Check it against `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server before trusting it.

   The host, user and port are the `env` block at the top of the workflow file. Once the secret is
   in place you can delete the private key from your machine; only the workflow needs it.

The server must accept SSH from GitHub's runners, whose addresses change, so port 22 cannot be
limited to your own network. Because `deploy` owns the checkout, run manual deploys and git
commands there as that user: `sudo -u deploy /opt/ereader/deploy/ereader-deploy.sh`. The script
reads `EREADER_DIR`, `EREADER_BRANCH`, `EREADER_SERVICE` and `EREADER_HEALTH` for other layouts; set
them in the `command=` of the authorized key, for example
`command="EREADER_SERVICE=books /opt/ereader/deploy/ereader-deploy.sh"`.

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

Times in the app are shown in Danish time (CET/CEST) on a 24-hour clock on every device, whatever
its own language, clock and time zone settings. To use another zone, change `TIME_ZONE` at the top
of `public/js/api.js`.

## Using it on your devices

**Boox Go 6 (and other e-ink Android devices).** Open the address in the built-in browser or Chrome,
sign in once (sessions last a year), then use the browser's "Add to home screen" so it opens full
screen. In the reader's **Aa** panel pick *Light* and turn on *High contrast (e-ink)*; if the letters
still look thin, choose a heavier *Text weight* (*Medium* or *Semibold*). Tap the right
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
| PDF | Text is extracted per page and merged into normal-sized sections, so wide screens fill both columns. Running headers and footers repeated across pages, page numbers and line-break hyphenation are removed; bulleted lists, italic/bold runs and embedded images are kept, and footnotes are collected at the end of each section with links from the markers and back. Each top-level heading starts a new section. Invisible page markers tie the reflowed text to the *Original pages* view, so both views share the same position. In the dark theme the page view inverts the page but leaves photographs as printed. Scanned PDFs without text can still be read in the page view. |
| Markdown | CommonMark + GitHub tables, YAML front matter for title/author, headings become the table of contents. |
| Text | Paragraph and heading detection, including hard-wrapped Gutenberg-style text; UTF-8, UTF-16 and Latin-1. |

Books from OceanofPDF have an "OceanofPDF.com" link stamped into every chapter (or onto the pages
of a PDF) and the site's name at the start of the file name. Conversion removes the stamp in every
format and keeps the site's name out of titles taken from the file name. The uploaded original is
kept as it is, so a PDF's *Original pages* view still shows the stamp.

Converted books are stored as small HTML sections under `data/books/<id>/`. If a book converts
badly, choose *Convert again* from its menu, or re-run every book with `npm run reprocess` after an
update to the converters. Details edited by hand (title, author, series) are kept when a book is
converted again.

## Series and collections

A series is a group of books with numbers (1, 2, 2.5 …); a collection is a group without an order,
such as a book club. A book can be in several. Opening a series lists its books in order and offers
*Continue*, *Next up* or *Start with* for the book to read next. The *Series & collections* tab lists
every group.

The Books view shows each series in one of three ways, chosen in the toolbar and remembered per device:

| View | What you see |
| --- | --- |
| Series as stacks (default) | Each series is one tile: a stack of books with the one you're on as the top cover, and where you are ("Reading #2", "Next: #4"). |
| Series as shelves | Each series gets a row with every book, its number and title in reading order, and the book you're on outlined. Other books follow below. |
| Every book separately | One card per book. |

Only series fold up: collections, and series with a single book in the library, stay as ordinary book
cards. The books you are reading still show one by one under *Continue reading*, and searching always
lists the matching books themselves. Filters apply to a whole series: *Reading* shows series you have
started but not finished.

Where the series comes from:

| Source | Example |
| --- | --- |
| EPUB metadata | calibre's series and series index, EPUB 3 collections (`belongs-to-collection` with `group-position`; sets become collections), EPUB 3 collection titles |
| PDF metadata | calibre's series in the XMP metadata |
| Markdown front matter | `series: The Expanse` with `series_index: 3` (or `volume: 3`); `collection:` works too |
| The title | "Leviathan Wakes (The Expanse Book 1)", "Caliban's War (The Expanse, #2)", "A Game of Thrones: A Song of Ice and Fire: Book One", "Kvinden i buret (Afdeling Q, bind 1)", "The Expanse 03 - Abaddon's Gate". This is the only place MOBI and text files carry a series. Only explicit forms count (a `#`, or a word such as Book, Volume, Part, Bind or Band before the number), so a title like "Windows 10" is left alone. The series part is removed from the title. |

Series names are matched regardless of case, spacing and quote style, so books from different
sources end up together. To add books to a series or collection by hand, or to fix one, choose
*Edit details and series* in a book's menu (the uploader or an admin can). Admins can rename a series
or collection from its page; giving it the name of another one merges the two. Removing one leaves
its books in the library.

Books already in the library when series support arrived are checked once in the background when the
server starts. Their series are read from the original files, without converting the books again.

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

- `server/` Express app, SQLite schema (`node:sqlite`), session auth, upload, progress and series API
- `server/converters/` one module per format plus the shared HTML normaliser, chunker, bundle writer and watermark patterns, and `series.js`, which finds series in metadata and titles
- `public/` the web app: library, reader (`js/reader.js`), settings, users, service worker
- `test/` tests and fixture builders (a tiny ZIP/EPUB writer, a MOBI writer with PalmDOC compression, a PDF writer)

## License

MIT
