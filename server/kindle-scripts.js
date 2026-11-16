// The browser of a Kindle Paperwhite (10th generation) is Chromium 74 or 75. It loads modules, but it
// cannot parse the newer syntax in public/js (`?.`, `??`, `||=`) and lacks Array at() and String
// replaceAll(). So a request from that browser for a script gets a copy converted with esbuild, an
// optional dependency, with those two methods added. Every other browser gets the file as it is.
// An experiment: deleting this file and the lines in app.js that mount it removes it.
import fs from 'node:fs';
import path from 'node:path';

// The Kindle always sends the same user agent, and it names no Chrome version.
const KINDLE = /\bKindle\/3\.0\+/;
// Plain names only, so a path made from one stays in public/js.
const SCRIPT = /^\/js\/([a-z0-9-]+)\.js$/;
const OPTIONS = { loader: 'js', format: 'esm', target: 'chrome74' };

/**
 * Defines the two methods the Kindle's browser lacks, where they are missing. ES5, so it runs there as
 * it is, and kept as a function so it is checked like the rest of the code (see FALLBACKS).
 */
function fallbacks() {
  // Not enumerable, like the real ones, so for...in over an array or a string does not list them.
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, 'at', { configurable: true, writable: true, value: function (index) {
      var i = Number(index) || 0;
      i = i < 0 ? Math.ceil(i) + this.length : Math.floor(i);
      return i >= 0 && i < this.length ? this[i] : undefined;
    } });
  }
  if (!String.prototype.replaceAll) {
    // A string pattern becomes a global RegExp that matches it literally, so `$&` and `$$` in the
    // replacement, and a function as the replacement, work as they do in the real method.
    Object.defineProperty(String.prototype, 'replaceAll', { configurable: true, writable: true, value: function (pattern, replacement) {
      if (pattern instanceof RegExp) {
        if (!pattern.global) throw new TypeError('replaceAll needs a global RegExp');
        return this.replace(pattern, replacement);
      }
      return this.replace(new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacement);
    } });
  }
}

/** The text put at the start of every converted script. */
export const FALLBACKS = `(${fallbacks})();\n`;

/**
 * Middleware that answers a Kindle's request for a script in public/js with a converted copy, and passes
 * every other request on untouched. `transform` stands in for esbuild's in tests.
 */
export function kindleScripts({ publicDir, log, transform }) {
  const dir = path.join(publicDir, 'js');
  // esbuild is loaded on the first request from a Kindle, once. If it cannot be, that is logged once and
  // the Kindle gets the scripts as they are.
  let loading = transform ? Promise.resolve(transform) : null;
  const converter = () => (loading ??= import('esbuild').then((esbuild) => esbuild.transform, (err) => {
    log.error?.(`[kindle] esbuild could not be loaded, so the Kindle gets the scripts as they are: ${err.message}`);
    return null;
  }));

  // The converted text of each script, or null when it could not be converted, with the size and time of
  // the file it came from. So a script is converted once per run, again when it changes, and a failure
  // is logged once.
  const cache = new Map();

  async function convert(name, file) {
    const run = await converter();
    if (!run) return null;
    try {
      const { code } = await run(await fs.promises.readFile(file, 'utf8'), { ...OPTIONS, sourcefile: `${name}.js` });
      return FALLBACKS + code;
    } catch (err) {
      log.error?.(`[kindle] ${name}.js could not be converted, so the Kindle gets it as it is: ${err.message}`);
      return null;
    }
  }

  return async (req, res, next) => {
    const [, name] = ((req.method === 'GET' || req.method === 'HEAD') && SCRIPT.exec(req.path)) || [];
    if (!name || !KINDLE.test(req.get('user-agent') || '')) return next();
    let text = null;
    try {
      const file = path.join(dir, `${name}.js`);
      const stat = await fs.promises.stat(file);
      if (stat.isFile()) {
        const version = `${stat.mtimeMs}:${stat.size}`;
        let entry = cache.get(name);
        if (entry?.version !== version) cache.set(name, (entry = { version, text: convert(name, file) }));
        text = await entry.text;
      }
    } catch {
      // No such script: it is answered as for any other browser.
    }
    if (text === null) return next();
    // Same caching as the static handler gives scripts; res.send adds the ETag and answers a revalidation
    // with 304 when nothing changed.
    res.type('js').set('Cache-Control', 'no-cache').vary('User-Agent').send(text);
  };
}
