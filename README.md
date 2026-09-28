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
  are picked up from the books themselves, and any books can be grouped by hand. A book missing from
  a series shows as a dashed outline in its place, with its title from Hardcover.
- **Details from Open Library and Hardcover.** When a book's title, author, series or cover is missing
  or wrong, look it up online from its details and pick the matching book to fill them in.
- **Covers.** EPUB and MOBI books bring their own. Where one is missing (most PDFs) or wrong, pick an
  image, use a page of the PDF, or show the title instead.
- **List or cards.** The View menu shows the library as a list or as cards in three sizes. On a phone
  the cards are 2, 3 or 4 across, and the tabs, search, menus, upload and account links sit behind
  the ☰ button so the books fill the screen.
- **Table of contents, bookmarks, progress slider, chapter titles** and a "who else is reading" peek.
- **Upload from the app** (button or drag and drop). Conversion runs in the background.
- **Installable, and readable offline.** Add it to the home screen on iOS or Android for a full-screen
  app. When served over https, every book you open is kept on the device, all of it, so it can be read
  without a connection.

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
| `HARDCOVER_TOKEN` | (none) | A Hardcover API token, so looking books up asks Hardcover as well as Open Library, and the books a series lacks get their titles (see below) |

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

**Reloading.** On the home screen the app has no browser button to reload it, so it has its own: in a
book, *Reload* in the **Aa** panel reopens it where you are, and *Reload the app* in Settings starts
again from the library. A book that can't be shown offers *Reload* and the way back to the library.
After an update, the new version arrives with the next page the app loads: scripts and styles are
checked for changes every time, like the pages.

**Offline.** Every book you open is kept on the device, with all its chapters and pictures, so it opens
and reads without a connection (this needs https). Offline, the library shows the books from the last
time it was online, and fades the ones this device doesn't have. Books opened before this was added are
kept the next time they open online. Reading positions sync when the connection is back. A PDF's
*Original pages* view needs a connection.

**Laptop.** Arrow keys, space, Page Up/Down turn pages; `t` opens the contents, `b` bookmarks, `s`
the display settings, `m` the menu, `+`/`-` change the text size, Home/End jump to the start or end.
Wide windows show two columns; switch to one column in the display settings if you prefer.

## Formats

| Format | Notes |
| --- | --- |
| EPUB 2 and 3 | Chapters, images, table of contents (nav or NCX), footnote links. Publisher CSS is reduced to a few typographic hints so every book follows your settings. |
| MOBI, PRC, AZW, AZW3/KF8 | PalmDOC and HUFF/CDIC compression, images, table of contents from the NCX index, hybrid MOBI7+KF8 files. DRM-protected files are rejected. |
| PDF | Text is extracted per page and merged into normal-sized sections, so wide screens fill both columns. Running headers and footers repeated across pages or carrying the page number, page numbers and line-break hyphenation are removed; bulleted lists, italic/bold runs and embedded images are kept, and footnotes are collected at the end of each section with links from the markers and back. Each top-level heading starts a new section. Invisible page markers tie the reflowed text to the *Original pages* view, so both views share the same position, and each PDF opens in the view last used for it on the device. In the dark theme the page view inverts the page, scans included, but leaves photographs and colour plates as printed. See below for scanned books. |
| Markdown | CommonMark + GitHub tables, YAML front matter for title/author, headings become the table of contents. |
| Text | Paragraph and heading detection, including hard-wrapped Gutenberg-style text; UTF-8, UTF-16 and Latin-1. |

**Scanned books.** A PDF of page images, such as a book from the Internet Archive, opens in the *Original pages*
view, which draws the JBIG2, CCITT fax and JPEG 2000 images scans are usually stored as. Most scans also carry the
text an OCR engine read from the pages, invisible under the images, and that text is what the *Text* view reflows. OCR
places each word by the box around it, so on a scan the converter groups words into lines by how their boxes overlap,
tells headings by their size together with their centring or the space around them, starts paragraphs at indented
lines, keeps quote marks with their words, and drops what the engine read into pictures and specks. Running heads go
even when the engine misread their page number. Mistakes in the words themselves stay as the engine made them.

Books from OceanofPDF have an "OceanofPDF.com" link stamped into every chapter (or onto the pages
of a PDF) and the site's name at the start of the file name. Conversion removes the stamp in every
format and keeps the site's name out of titles taken from the file name. The uploaded original is
kept as it is, so a PDF's *Original pages* view still shows the stamp.

Converted books are stored as small HTML sections under `data/books/<id>/`. If a book converts
badly, choose *Convert again* from its menu, or re-run every book with `npm run reprocess` after an
update to the converters. Details edited by hand (title, author, series, cover) are kept when a book
is converted again.

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

A book the library lacks shows as a dashed outline in its place: with #1, #2 and #4 in the library, #3
sits between them, on the series' page and on its shelf. The numbers alone tell which are missing.
When the server has a [Hardcover](#hardcover) token, Hardcover says what they are: the outline gets
the title and author, and opens the book on Hardcover. The series' page then shows the whole series,
including the books after the last one the library has, marking those not out yet; a shelf keeps to
the gaps. Only a series' main books count, the ones with whole numbers, so a novella at 1.5 or a box
set is never missing. Hardcover's series is taken only when it has the library's name for it and an
author or title of its books, or two of their titles under any name; the name and author suffice for a
translation, whose titles differ. When no series fits, and without a token, the outlines show only
their number.

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

## Looking up details online

*Edit details and series* has a **Look up online** button. It searches
[Open Library](https://openlibrary.org), a free book catalogue that needs no account or key, and
[Hardcover](https://hardcover.app) when the server has a token for it. It looks for the ISBN in the
book's file (EPUB and MOBI files usually carry one) and for the title and author as they are in the
form, so a messy title can be tidied before looking up. Up to five matches are listed, the one with
the file's ISBN first, each with the catalogue it came from. A book both catalogues have is listed
once, from Hardcover, with Open Library filling in a series or cover Hardcover lacks. Choosing a match
fills in the title, author and series; nothing changes until you press *Save*.

Each match shows its cover and the cover's size in pixels, and the dialog says how large the book's
cover is now, so a sharp cover can be told from a small scan. *Cover only* takes just a match's cover
and leaves the details as they are. A match chosen for its details offers its cover with *Use this
cover*, ticked when the book has no cover yet and left for you to tick when it has one; a cover taken
with *Cover only* is ticked, and stays when the details then come from another match. On saving, the
server fetches the picture and keeps it like a cover picked by hand, so *Change cover* can still go back
to the book's own. On a wide screen the dialog grows once there are matches, to show them beside the form.

- A series the catalogue names joins the library's series of that name, however it is spelled there
  ("The Expanse" joins "Expanse").
- A translation keeps its own title: the Danish "Harry Potter og De Vises Sten" rather than the
  English original, when the ISBN or the title typed points to that edition. The book's language
  tells Open Library which edition to prefer.
- Only the server talks to the catalogues, and only when someone presses the button or saves a cover
  from one: the title, author and ISBN go out. The covers in the list of matches load from the
  catalogues' own sites, as large as they would be saved. With a Hardcover token, a series' name also
  goes to Hardcover when its page, or a shelf with a gap, is shown, to find the books it lacks (see
  below).

Like editing, looking up is for the uploader of a book or an admin.

### Hardcover

Hardcover records each book's series and its number in them, and can have books Open Library lacks.
To use it, sign in at hardcover.app and create an API token at
<https://hardcover.app/account/api/keys/new?scope=read:catalog>, which asks only for permission to read
the book catalogue. Choose how long it lasts; when it runs out, make a new one. Give it to the server as
`HARDCOVER_TOKEN`, for example in the systemd unit, without the `Bearer ` Hardcover shows in front:

```ini
Environment=HARDCOVER_TOKEN=eyJ...
```

systemd splits settings at spaces, so with `Bearer ` the whole setting goes in quotes:
`Environment="HARDCOVER_TOKEN=Bearer eyJ..."`. After changing the unit, run `sudo systemctl daemon-reload`
before restarting the service; without it systemd keeps the settings it had. The server's log says at
startup which catalogues it looks books up in, and so does `curl http://127.0.0.1:8080/api/health`,
under `lookup`.

Hardcover sometimes lists a book under another title and other authors, with its own only on an
edition: *Beyond the Dark Portal* is also listed as "World of Warcraft, Vol. 4". So the lookup searches
for the title alone as well, and looks at each book's editions. Such a book is offered with its
edition's title, authors and cover, but only when those are the authors typed, so another book with the
same title stays out. A cover is the one Hardcover's website shows for the book or edition, saved as
Hardcover stores it.

The token also tells the library which books a series lacks (see
[Series and collections](#series-and-collections)). The server asks Hardcover for the series by its name
when someone opens the series' page, or sees its shelf with a gap in it. Hardcover allows 60 requests a
minute, so the server looks series up one at a time, a few seconds apart, and keeps what it found for a
day. A book added to the library stops showing as missing at once; restarting the server forgets what
it found.

Keep the token on the server: anyone holding it can act as your Hardcover account within its
permissions. If Hardcover stops answering, for example because the token has expired, the lookup still
shows what Open Library found and says what went wrong with Hardcover.

## Covers

EPUB and MOBI books usually bring their cover along. PDFs rarely have one, and Markdown and text files
never do, so the library shows the title and author instead. To add a cover, or to replace a wrong one,
choose *Add a cover* or *Change cover* in a book's menu (the uploader or an admin can):

| Choice | What it does |
| --- | --- |
| Choose an image | Any picture on the device, or a new photo on a phone. On a laptop you can also paste an image, for example one copied from a web page, or drop one on the page. |
| Use page | PDFs only: one of the PDF's pages, the first by default, which is usually the cover. |
| Use the original cover | Goes back to the cover in the book's file. |
| Remove cover | Shows the title and author instead of a picture. |

The browser scales a large picture down to 1200 pixels on its longer side and sends it as a JPEG, so the
library stays quick on phones and e-readers; a small JPEG or PNG is sent as it is. The server takes
JPEG, PNG, GIF and WebP images of up to 10 MB. A cover picked by hand is stored beside the book as
`custom-cover.<ext>` and kept when the book is converted again. A cover can also come from Open Library
or Hardcover (see above).

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

- `server/` Express app, SQLite schema (`node:sqlite`), session auth, upload, progress and series API, the lookup online (`lookup.js`, which asks `openlibrary.js` and `hardcover.js`), and the books a series lacks (`missing.js`)
- `server/converters/` one module per format plus the shared HTML normaliser, chunker, bundle writer and watermark patterns, `series.js`, which finds series in metadata and titles, and `isbn.js`, which reads and checks ISBNs
- `public/` the web app: library (`js/library.js`, which places the books a series lacks with `js/missing.js`), reader (`js/reader.js`), settings, users, service worker
- `test/` tests and fixture builders (a tiny ZIP/EPUB writer, a MOBI writer with PalmDOC compression, a PDF writer)

## License

MIT
