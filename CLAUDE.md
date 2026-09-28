# eReader

A self-hosted web e-reader for a household: a Node/Express server that converts EPUB, MOBI, PDF, Markdown and text into one reading format, and a plain static front end with an e-ink look and a Soft look.

## Working rules

- The README is the specification. It describes what the app does in detail; read its section for the area you touch before changing it, and change that section with the code.
- Every piece of UI is styled twice: the e-ink look in `public/css/app.css` and `public/css/reader.css`, and the Soft look in `public/css/soft.css`, where every rule is prefixed `:root[data-skin="soft"]`. Read `design/skin-mockups.html` before work on the Soft look.
- The boot script in the head of the five HTML pages (`index`, `reader`, `settings`, `login`, `users`) stays byte-identical across them and in step with `resolveSkin()` in `public/js/settings.js`.
- What an admin sets in the app lives in the `settings` table through `server/settings.js`, never only in code or the environment. Only the server talks to the catalogues, and a token never leaves it.
- `server/db.js` runs its SCHEMA with `CREATE TABLE IF NOT EXISTS` on every start, so a new column for an existing table also goes in `migrate()`, for databases made before it.
- Covers are `img.cover` in a slot of `--cover-ratio`, shown whole; what decorates them is a `drop-shadow` filter, never a box border, radius or box-shadow on the image.
- Node 22 or newer, ES modules, Express, no framework, no build step, no TypeScript; browser code in `public/js` runs as served. No new dependency without agreeing it first.
- Code style: 2-space indent, single quotes, semicolons, short comments that say why in plain words. Tests go with the code in `test/*.test.js` (node:test; API tests start the app with `createApp({ dataDir, quiet: true })` on a temporary directory, with stand-ins for the catalogues through the `hardcover`, `openLibrary`, `missingBooks` and `hardcoverFetch` overrides).
- Text, in code, comments, UI copy and docs: no em or en dashes (a plain hyphen), no emojis. Copy reads like the README: short plain sentences. Times are shown in Danish time.
- Checks: `node --check` on every changed JS file and `npm test`. There is no lint or typecheck.
- Commits: one imperative sentence saying what changed for the reader, body in plain prose, no Claude attribution. Work happens on a branch with a pull request; merging `main` deploys.

## Developing with agents

- The main session plans, designs and reviews, whatever model it runs on (Fable 5.1 by default). Code is written by the `implementer` agent (`.claude/agents/implementer.md`, `model: opus`, effort `xhigh`), started with the Agent tool and a self-contained brief: the agreed plan, the files involved, the rules of this file that bear on it, and what done means. The agent does not see the conversation.
- Exceptions the main session does itself: trivial edits (a few lines, a config or data tweak, a doc fix), and reading, planning and review of any size. A main session that itself runs Opus may write the code directly, since the code is Opus's either way.
- The main session reviews the agent's change before anything is reported done, stages by explicit path and commits it; the agent never commits, stages, pushes or deploys.
