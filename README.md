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
  both in the same font. The app has two looks, also chosen per device: *Soft* for phones, tablets and
  laptops (warm and muted) and *E-ink* for e-ink readers (black on white, thick lines, no motion). It
  picks E-ink on a Boox, Kobo or similar and when high contrast is on, Soft everywhere else, and the
  *Look* setting in the **Aa** panel or under Settings changes it.
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
- **Grouped by author or genre.** The *Group by* menu shows the library in a section per author or per
  genre. A book's genre is set in its details, or for many books at once: *Select* picks books, or a
  series with all its books, and *Set genre* gives them one.
- **Details from Open Library and Hardcover.** When a book's title, author, series or cover is missing
  or wrong, look it up online from its details and pick the matching book to fill them in.
- **Covers.** EPUB and MOBI books bring their own. Where one is missing (most PDFs) or wrong, pick an
  image, use a page of the PDF, or show the title instead.
- **List or cards.** The View menu shows the library as a list or as cards in three sizes. On a phone
  the cards are 2, 3 or 4 across, and the tabs, search, menus, upload and account links sit behind
  the ☰ button so the books fill the screen. Coming back from a book returns you to where you were in
  the library, the same tab or series page, at the same place.
- **Table of contents, bookmarks, progress slider, chapter titles** and a "who else is reading" peek.
- **Upload from the app**: books, or whole folders of them, with a button or by drag and drop.
  Conversion runs in the background. The same file is never added twice, and the same book in another
  file is flagged as a possible duplicate.
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
| `MAX_UPLOAD_MB` | `500` | Maximum size of an uploaded file |
| `SECURE_COOKIES` | `false` | Set to `true` when the server is only reachable over https |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy that sets `X-Forwarded-*` |
| `HARDCOVER_TOKEN` | (none) | A Hardcover API token. Admins can also enter one under Settings in the app, which is kept in the database and wins over this variable (see below) |

Run it behind a reverse proxy with https (Caddy, nginx, Traefik) for use outside your home network.
https also enables the offline cache and lets the app be installed as a proper web app.

Times in the app are shown in Danish time (CET/CEST) on a 24-hour clock on every device, whatever
its own language, clock and time zone settings. To use another zone, change `TIME_ZONE` at the top
of `public/js/api.js`.

## Using it on your devices

**Boox Go 6 (and other e-ink Android devices).** Open the address in the built-in browser or Chrome,
sign in once (sessions last a year), then use the browser's "Add to home screen" so it opens full
screen. The app opens in its *E-ink* look there; if it did not, *Look* under **Aa** in the reader
switches it. In the same panel pick *Light* and turn on *High contrast (e-ink)*; if the letters
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

## Adding books

*Upload books* picks one or more files. On a computer, *Upload a folder* (in the drop area) picks a
whole folder, and files or folders can be dropped on the page. A folder brings every book in it and in
its subfolders, in the order of their paths. Hidden files (such as `.DS_Store`) and files in other
formats are left out, and the upload says how many there were of each kind.

An `.opf` file and a cover picture beside a book go up with it, as calibre keeps them: named like the
book (`Dune.opf` and `Dune.jpg`, as calibre's *Save to disk* writes them), or `metadata.opf` and
`cover.jpg` in a folder holding one book, in one or more formats (as in a calibre library). The title,
author, series, language and ISBN in the `.opf` file win over those inside the book, which fill in what
it leaves out, and it is kept with the book, so *Convert again* uses it too; details edited by hand
still win over both. The picture becomes the book's cover like one picked by hand, so *Change cover*
can still go back to the book's own. The upload says how many books came with each.

Books go up one at a time while the server converts the ones already there. A line above the library
shows how far the upload has come, with a *Stop* button; keep the page open until it is done (the
browser asks before leaving it). Files that could not be added are listed under that line with the
reason. Each file can be up to `MAX_UPLOAD_MB` (500 MB by default).

### Duplicates

A file that is already in the library is not added again, whatever its name and whoever added it: the
upload lists it as *already in the library* and names the book it is. So an upload that was stopped or
cut off can simply be started again with the same folder, and only the missing books go up.

The same book in another file, such as an EPUB and a PDF of it, can't be told for certain, so it is
added and flagged instead. Books that share an ISBN (EPUB and MOBI files usually carry one), or have
the same title and author, are marked *Possible duplicate*; so are books with the same title when one
of them names no author, as PDFs often don't. Titles and authors are compared loosely: case, accents
and punctuation don't matter, nor the order of an author's names ("Herbert, Frank").

The *Duplicates* filter lists the flagged books in groups. The mark on a book opens it side by side
with the books it looks like, each with its format, size, who added it and who is reading it, to keep
the right one: *Delete* removes a copy for everyone, with its reading positions and bookmarks, and *Not
the same book* stops flagging the two. Deleting is for the uploader or an admin, *Not the same book* for
the uploader of either book or an admin.

Books already in the library when this arrived are fingerprinted, and their ISBNs read, once in the
background when the server starts, without converting them again, so copies among them are flagged too.

## Formats

| Format | Notes |
| --- | --- |
| EPUB 2 and 3 | Chapters, images, table of contents (nav or NCX), footnote links. Publisher CSS is reduced to a few typographic hints so every book follows your settings. |
| MOBI, PRC, AZW, AZW3/KF8 | PalmDOC and HUFF/CDIC compression, images, table of contents from the NCX index, hybrid MOBI7+KF8 files. DRM-protected files are rejected. |
| PDF | Text is extracted per page and merged into normal-sized sections, so wide screens fill both columns. Running headers and footers repeated across pages or carrying the page number, page numbers and line-break hyphenation are removed; bulleted lists, italic/bold runs and embedded images are kept, and footnotes are collected at the end of each section with links from the markers and back. Each top-level heading starts a new section. Invisible page markers tie the reflowed text to the *Original pages* view, so both views share the same position, and each PDF opens in the view last used for it on the device. In the dark theme the page view inverts the page, scans included, but leaves photographs and colour plates as printed. See below for scanned books. |
| Markdown | CommonMark + GitHub tables, YAML front matter for title/author, headings become the table of contents. A break of asterisks (`* * *` or `***`) is a scene break; one of dashes or underscores (`---`) stays a plain rule. |
| Text | Paragraph and heading detection, including hard-wrapped Gutenberg-style text; UTF-8, UTF-16 and Latin-1. |

In every format, a paragraph holding only a mark such as `*`, `* * *`, `#` or `~` is a break between scenes, and
shows as three spaced asterisks. In a PDF a lone `*` line counts too, while `* item`, `- item` and `• item` lines
stay list items.

**Scanned books.** A PDF of page images, such as a book from the Internet Archive, opens in the *Original pages*
view, which draws the JBIG2, CCITT fax and JPEG 2000 images scans are usually stored as. Most scans also carry the
text an OCR engine read from the pages, invisible under the images, and that text is what the *Text* view reflows. OCR
places each word by the box around it, so on a scan the converter groups words into lines by how their boxes overlap,
tells headings by their size together with their centring or the space around them, starts paragraphs at indented
lines, keeps quote marks with their words, and drops what the engine read into pictures and specks. Running heads go
even when the engine misread their page number. Mistakes in the words themselves stay as the engine made them.

Books from OceanofPDF have an "OceanofPDF.com" link stamped into every chapter (or onto the pages
of a PDF) and the site's name at the start of the file name. Conversion removes the stamp in every
format and keeps the site's name out of titles taken from the file name. Scanners and download sites
also put a credit line at the start of a book, such as "Formatted by ... Exclusively for Demonoid.com"
or "Scanned & proofed by ...". Such a line goes too when it is a whole paragraph of under 200 characters
among the first 20 of the book, and starts with Scanned, Proofed, Proofread, Formatted, Converted or
Uploaded "by", or names Demonoid, Z-Library or Library Genesis. Lines such as "Translated by" or "Edited
by" stay, as does anything further in. The uploaded original is kept as it is, so a PDF's *Original
pages* view still shows the stamp.

Converted books are stored as small HTML sections under `data/books/<id>/`. If a book converts
badly, choose *Convert again* from its menu, or re-run every book with `npm run reprocess` after an
update to the converters. Details edited by hand (title, author, series, cover) are kept when a book
is converted again.

## Series and collections

A series is a group of books with numbers (1, 2, 2.5 …); a collection is a group without an order,
such as a book club. A book can be in several. Opening a series lists its books in order and offers
*Continue*, *Next up* or *Start with* for the book to read next. The *Series & collections* tab lists
every group. A book holding several, such as an omnibus, has a range of numbers (#1–3): type `1-3` as
its number, or let its title or EPUB metadata give it. It is listed after the books it holds, before the
next one: #1, #2, #3, #1–3, #4. *Next up* passes over a book whose numbers you have all finished, such
as an omnibus of books you have read, or a book you read in an omnibus.

The Books view shows each series in one of three ways, chosen in the toolbar and remembered per device:

| View | What you see |
| --- | --- |
| Series as stacks (default) | Each series is one tile: a stack of books with the one you're on as the top cover, and where you are ("Reading #2", "Next: #4"). Its menu button, and a series row's in the list view, opens that top book's menu, where you can reset your reading position. |
| Series as shelves | Each series gets a row with every book, its number and title in reading order, and the book you're on outlined. Each book has its own menu button. Other books follow below. |
| Every book separately | One card per book. |

Only series fold up: collections, and series with a single book in the library, stay as ordinary book
cards. The books you are reading still show one by one under *Continue reading*, and searching always
lists the matching books themselves. Filters apply to a whole series: *Reading* shows series you have
started but not finished.

A book the library lacks shows as a dashed outline in its place: with #1, #2 and #4 in the library, #3
sits between them, on the series' page and on its shelf. The numbers alone tell which are missing, and
an omnibus counts for the books it holds: with #1–3 and #5, only #4 is missing.
When the server has a [Hardcover](#hardcover) token, Hardcover says what they are: the outline gets
the title and author, and opens the book on Hardcover. The series' page then shows the whole series,
including the books after the last one the library has, marking those not out yet; a shelf keeps to
the gaps. Only a series' main books count, the ones with whole numbers, so a novella at 1.5 or a box
set is never missing. Hardcover's series is taken only when it has the library's name for it and an
author or title of its books, two of their titles under any name, or one of its books under the same
number, title and author; the name and author suffice for a translation, whose titles differ. When
nothing under the library's name fits, the series is looked for through one of its books, as Hardcover
can call it something else: the library's *Avatar* is Hardcover's *Forgotten Realms: Avatar*, found
through its #4, *Prince of Lies* by James Lowder. When no series fits, and without a token, the
outlines show only their number.

Where the series comes from:

| Source | Example |
| --- | --- |
| EPUB metadata | calibre's series and series index, EPUB 3 collections (`belongs-to-collection` with `group-position`; sets become collections), EPUB 3 collection titles |
| PDF metadata | calibre's series in the XMP metadata |
| Markdown front matter | `series: The Expanse` with `series_index: 3` (or `volume: 3`); `collection:` works too |
| The title | "Leviathan Wakes (The Expanse Book 1)", "Caliban's War (The Expanse, #2)", "A Game of Thrones: A Song of Ice and Fire: Book One", "Kvinden i buret (Afdeling Q, bind 1)", "The Expanse 03 - Abaddon's Gate", and for an omnibus "Box Set (The Expanse, #1-3)" or "(The Expanse, Books 1–3)". This is the only place MOBI files carry a series. Only explicit forms count (a `#`, or a word such as Book, Volume, Part, Bind or Band before the number), so a title like "Windows 10" is left alone. The series part is removed from the title. |
| The file name | For a book that names no title of its own, such as a text file or a PDF without details, the title comes from the file name, and so can the series: "01 - The Belgariad - Pawn Of Prophecy" is *Pawn of Prophecy* in The Belgariad, #1, and the forms above count too. Without a series name the number in front just goes ("03 - Dune" is *Dune*); a year such as "1984 - ..." stays. An underscore standing for an apostrophe comes back ("Magician_s Gambit" is *Magician's Gambit*), and a version mark such as "(v2)" goes. Capitals set on every word are tidied: small words such as "of" and "the" go lower case, except first and last. A title the book names itself keeps a number in front, as it is often part of the title. The file name's series is taken when the book records none, or gives the number in the one it records. |

Series names are matched regardless of case, spacing and quote style, so books from different
sources end up together. To add books to a series or collection by hand, or to fix one, choose
*Edit details and series* in a book's menu (the uploader or an admin can). Admins can rename a series
or collection from its page; giving it the name of another one merges the two. Removing one leaves
its books in the library.

Books already in the library when series support arrived are checked once in the background when the
server starts. Their series are read from the original files, without converting the books again.

## Genres and grouping

The *Group by* menu shows the library in a section per author or per genre, and is remembered per
device. Authors go by surname ("Frank Herbert" under H) and genres alphabetically, each with the books
that have none last; the Sort menu orders the books within a section. A series shown as a stack or a
shelf stays whole, under the author and the genre most of its books have. The *Series & collections*
tab groups its series and collections the same way.

Authors are compared loosely, as for duplicates, so "Herbert, Frank" is "Frank Herbert". A book by
several authors is under each of them. Files and catalogues name several as "Terry Pratchett, Neil
Gaiman", or with "&", "and" or ";" between them; a comma parts two authors only when both parts are
whole names, so "Herbert, Frank" and "Le Guin, Ursula K." stay one author each. *Author* in the Sort
menu goes by surname too, with the books without an author last.

A book has one genre, such as Fantasy or Crime, or none. Files bring none, so it is set by hand: under
*Edit details and series* for one book, or for many at once:

1. Press *Select* in the toolbar. Tapping a book now selects it, and tapping a series' stack selects
   all of its books, as does a series or collection in the *Series & collections* tab. With *Group by*
   on, *Select all* in a section's heading takes the whole section, such as *No genre*.
2. Press *Set genre* in the bar at the bottom, choose one of the library's genres or type a new one, and
   save. *Done* stops selecting.

A series' page has *Set genre* for all of its books. A genre typed another way joins the library's,
so "fantasy" joins "Fantasy". A new book in a series takes the genre most of the series' books have (a
collection without numbers passes on none), and converting a book again keeps its genre. As with the
other details, the uploader of a book or an admin can set its genre; among the books selected, those
someone else added stay as they are. Searching finds books by genre too.

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

*More covers* under a match from Hardcover shows the covers of the book's other editions, each with its
size; choosing one takes just that cover, like *Cover only*. Covers of editions marked as being in
another language than the book are left out, so an English book is not offered the Finnish edition's
cover; editions without a language set are offered. The book's language is the one its file gives, else
that of the edition Hardcover shows the book with. A match's own cover follows the same rule: a Danish
book comes with the cover of a Danish edition, or of one without a language set, rather than the English
one on Hardcover's website, which is used only when every cover is marked as another language. The
edition with the file's ISBN, or with the title typed, keeps its own cover.

Audiobook editions are left out altogether: their covers are square, and their titles can say
"Unabridged". A book found by an audiobook's ISBN is offered as itself, with the cover of another
edition. The same picture shared by two editions is offered once, but the same artwork in two sizes is
offered twice, since the larger one can be the better cover.

- A series the catalogue names joins the library's series of that name, however it is spelled there
  ("The Expanse" joins "Expanse").
- A translation keeps its own title: the Danish "Harry Potter og De Vises Sten" rather than the
  English original, when the ISBN or the title typed points to that edition. The book's language
  tells Open Library which edition to prefer.
- Only the server talks to the catalogues, and only when someone presses the button or saves a cover
  from one: the title, author and ISBN go out. The covers in the list of matches load from the
  catalogues' own sites, as large as they would be saved. With a Hardcover token, a series' name also
  goes to Hardcover when its page, or a shelf with a gap, is shown, to find the books it lacks, and
  when the name finds no series that fits, the title and author of one of its books (see below).

Like editing, looking up is for the uploader of a book or an admin.

### Hardcover

Hardcover records each book's series and its number in them, and can have books Open Library lacks.
To use it, sign in at hardcover.app and create an API token at
<https://hardcover.app/account/api/keys/new?scope=read:catalog>, which asks only for permission to read
the book catalogue. Choose how long it lasts; when it runs out, make a new one.

An admin pastes the token under **Settings > Catalogues** in the app, with or without the `Bearer `
Hardcover shows in front. It is used at once, and the page asks Hardcover whether it takes the token and
says so; *Check* asks again later, for example once the token may have run out. The page shows where the
token in use comes from and its last four characters, never the token itself. *Remove* takes it out
again.

The other way is to give the server the token as `HARDCOVER_TOKEN`, for example in the systemd unit,
without the `Bearer ` in front:

```ini
Environment=HARDCOVER_TOKEN=eyJ...
```

systemd splits settings at spaces, so with `Bearer ` the whole setting goes in quotes:
`Environment="HARDCOVER_TOKEN=Bearer eyJ..."`. After changing the unit, run `sudo systemctl daemon-reload`
before restarting the service; without it systemd keeps the settings it had. A token entered in the app
wins over this variable, which applies again once that one is removed. The server's log says at startup
which catalogues it looks books up in, and so does `curl http://127.0.0.1:8080/api/health`, under
`lookup`.

Hardcover sometimes lists a book under another title and other authors, with its own only on an
edition: *Beyond the Dark Portal* is also listed as "World of Warcraft, Vol. 4". So the lookup searches
for the title alone as well, and looks at each book's editions. Such a book is offered with its
edition's title, authors and cover, but only when those are the authors typed, so another book with the
same title stays out. A cover is the one Hardcover's website shows for the book or edition, saved as
Hardcover stores it.

Hardcover's search takes one that starts with "by" for books by an author, as in "by Brandon
Sanderson". So a title that starts with the word, such as *By Schism Rent Asunder*, is searched for
with "By" in quotes, which Hardcover looks for like the rest of the title.

The token also tells the library which books a series lacks (see
[Series and collections](#series-and-collections)). When someone opens a series' page, or sees its
shelf with a gap in it, the server asks Hardcover for the series by its name, and when no series of that
name fits, for the series of its first book with a number and an author. Hardcover allows 60 requests a
minute, so the server looks series up one at a time, a few seconds apart, and keeps what it found for a
day. A book added to the library stops showing as missing at once; restarting the server, or changing
the token under Settings, forgets what it found.

Keep the token on the server: anyone holding it can act as your Hardcover account within its
permissions. One entered in the app is kept in the database in `DATA_DIR`, readable by whoever can read
that directory, as an environment variable is by whoever can read the service's settings, so keep both
to the server. If Hardcover stops answering, for example because the token has expired, the lookup still
shows what Open Library found and says what went wrong with Hardcover.

## Covers

EPUB and MOBI books usually bring their cover along. PDFs rarely have one, and Markdown and text files
never do, so the library shows the title and author instead.

A cover is shown whole, at its own proportions: a taller or shorter one stands on the same line as its
neighbours instead of being cut to a common shape.

To add a cover, or to replace a wrong one, choose *Add a cover* or *Change cover* in a book's menu (the
uploader or an admin can):

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

- `server/` Express app, SQLite schema (`node:sqlite`), session auth, upload, progress and series API, the lookup online (`lookup.js`, which asks `openlibrary.js` and `hardcover.js`), `duplicates.js`, which finds books that are in the library twice, `missing.js`, which finds the books a series lacks, and `genres.js`, which keeps the books' genres
- `server/converters/` one module per format plus the shared HTML normaliser, chunker, bundle writer and the patterns for watermarks and credit lines, `series.js`, which finds series in metadata and titles, and `isbn.js`, which reads and checks ISBNs
- `public/` the web app: library (`js/library.js`, which places the books a series lacks with `js/missing.js` and sorts books into sections by author or genre with `js/groups.js`), reader (`js/reader.js`), settings, users, service worker
- `test/` tests and fixture builders (a tiny ZIP/EPUB writer, a MOBI writer with PalmDOC compression, a PDF writer)

## License

MIT
