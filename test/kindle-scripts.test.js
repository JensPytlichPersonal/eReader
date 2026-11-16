import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.js';
import { PUBLIC_DIR } from '../server/config.js';
import { FALLBACKS, kindleScripts } from '../server/kindle-scripts.js';

// The user agent a Kindle Paperwhite (10th generation) always sends, and a current Chrome's.
const KINDLE = 'Mozilla/5.0 (X11; U; Linux armv7l like Android; en-us) AppleWebKit/531.2+ (KHTML, like Gecko) Version/5.0 Safari/533.2+ Kindle/3.0+';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JS_DIR = path.join(PUBLIC_DIR, 'js');
const SCRIPTS = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));

// esbuild is an optional dependency. Without it the Kindle gets the scripts as they are, and the tests
// of the conversion itself are skipped.
const esbuild = await import('esbuild').catch(() => null);
const needsEsbuild = { skip: !esbuild && 'esbuild is not installed' };

/**
 * The script with its comments and the text of its strings, templates and regular expressions blanked,
 * so a search for syntax finds only code. A rough scanner, enough for the scripts in public/js.
 */
function codeOnly(js) {
  let out = '';
  let i = 0;
  // Braces open inside each template's ${ } being read, so the } that ends one is known.
  const templates = [];
  const blank = (end, fill = 'x') => { out += fill.repeat(end - i); i = end; };
  // The first index from j where `stop` holds, stepping over escaped characters.
  const find = (j, stop) => { while (j < js.length && !stop(js[j], j)) j += js[j] === '\\' ? 2 : 1; return j; };
  // The end of a regular expression that starts at j - 1, or -1 when the slash is a division.
  const regexEnd = (j) => {
    for (let inClass = false; j < js.length && js[j] !== '\n'; j++) {
      if (js[j] === '\\') j++;
      else if (js[j] === '[') inClass = true;
      else if (js[j] === ']') inClass = false;
      else if (js[j] === '/' && !inClass) return j + 1;
    }
    return -1;
  };
  while (i < js.length) {
    const c = js[i];
    if (c === '/' && js[i + 1] === '/') blank(find(i, (ch) => ch === '\n'), ' ');
    else if (c === '/' && js[i + 1] === '*') blank(js.indexOf('*/', i) + 2, ' ');
    else if (c === '"' || c === "'") blank(find(i + 1, (ch) => ch === c || ch === '\n') + 1);
    else if (c === '`' || (c === '}' && templates.at(-1) === 0)) {
      if (c === '}') templates.pop();
      const end = find(i + 1, (ch, j) => ch === '`' || (ch === '$' && js[j + 1] === '{'));
      if (js[end] === '`') blank(end + 1);
      else { blank(end + 2); templates.push(0); }
    } else if (c === '/' && /(^|[(,=:[!&|?{};+\-*%<>~^]|\b(return|typeof|case|throw))\s*$/.test(out.slice(-12)) && regexEnd(i + 1) > 0) {
      blank(regexEnd(i + 1));
    } else {
      if (templates.length && c === '{') templates[templates.length - 1]++;
      if (templates.length && c === '}') templates[templates.length - 1]--;
      out += c;
      i++;
    }
  }
  return out;
}

/** The optional chaining, nullish coalescing and logical assignment in a script's code. */
const modern = (js) => codeOnly(js).match(/\?\.(?!\d)|\?\?|\|\|=|&&=/g) ?? [];

const dirs = [];
const servers = [];
/** Starts the app on an unused port on a new data directory, with `options` for createApp. */
async function start(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-kindle-'));
  dirs.push(dataDir);
  const created = createApp({ quiet: true, dataDir, ...options });
  const server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  servers.push(() => { server.close(); created.db.close(); });
  const { port } = server.address();
  // node:http sends no user agent unless given one, and sends the path as it is written, `..` and all.
  return (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

/** The headers of a response but the date, to compare two answers. */
const headersOf = ({ headers: { date, ...rest } }) => rest;

let app;
before(async () => {
  app = await start();
});
after(() => {
  for (const stop of servers) stop();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('other browsers get the scripts exactly as they are on disk', async () => {
  const source = fs.readFileSync(path.join(JS_DIR, 'library.js'));
  for (const headers of [{ 'user-agent': CHROME }, {}]) {
    const r = await app('/js/library.js', headers);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(source));
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.ok(r.headers['last-modified'], 'answered by the static handler');
    assert.doesNotMatch(r.headers.vary ?? '', /user-agent/i);
  }
});

test('a request from another browser passes on without the response being touched', async () => {
  const middleware = kindleScripts({ publicDir: PUBLIC_DIR, log: {}, transform: () => assert.fail('converted') });
  const untouchable = new Proxy({}, { get: (target, key) => assert.fail(`res.${String(key)} was used`) });
  for (const ua of [CHROME, '', 'Mozilla/5.0 (Linux; Android 11; KFTRWI) Chrome/120 Kindle Fire']) {
    let passed = false;
    await middleware({ method: 'GET', path: '/js/library.js', get: () => ua }, untouchable, () => { passed = true; });
    assert.ok(passed, ua);
  }
});

test('the Kindle gets library.js converted, with the fallbacks first', needsEsbuild, async () => {
  const source = fs.readFileSync(path.join(JS_DIR, 'library.js'), 'utf8');
  const r = await app('/js/library.js', { 'user-agent': KINDLE });
  const text = r.body.toString('utf8');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match(r.headers.vary, /user-agent/i);
  assert.notEqual(text, source);
  assert.ok(text.startsWith(FALLBACKS));
  // The scanner finds the syntax in the source, so finding none in the copy means something.
  assert.ok(modern(source).length > 20);
  assert.deepEqual(modern(text), []);
  // The imports stay as they are, with esbuild's double quotes, and pdf-view.js is still loaded on demand.
  const imports = source.match(/^import .+;$/gm);
  assert.ok(imports.length > 0);
  for (const line of imports) assert.ok(text.includes(line.replaceAll("'", '"')), line);
  assert.ok(text.includes('import("./pdf-view.js")'));
});

test('every script converts for the Kindle into a valid module', needsEsbuild, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-kindle-js-'));
  dirs.push(dir);
  for (const name of SCRIPTS) {
    const r = await app(`/js/${name}`, { 'user-agent': KINDLE });
    const text = r.body.toString('utf8');
    assert.equal(r.status, 200, name);
    assert.ok(text.startsWith(FALLBACKS), name);
    assert.deepEqual(modern(text), [], name);
    const file = path.join(dir, name.replace(/\.js$/, '.mjs'));
    fs.writeFileSync(file, text);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${name}: ${check.stderr}`);
  }
});

test('a Kindle that has a script gets "not modified" while it is unchanged', needsEsbuild, async () => {
  const first = await app('/js/api.js', { 'user-agent': KINDLE });
  assert.equal(first.status, 200);
  assert.ok(first.headers.etag);
  const again = await app('/js/api.js', { 'user-agent': KINDLE, 'if-none-match': first.headers.etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  const head = await app('/js/api.js', { 'user-agent': KINDLE }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.etag, first.headers.etag);
  assert.equal(head.body.length, 0);
});

test('a script that cannot be converted reaches the Kindle as it is', async () => {
  const broken = await start({ kindleTransform: async () => { throw new Error('stand-in failure'); } });
  const source = fs.readFileSync(path.join(JS_DIR, 'library.js'));
  for (let i = 0; i < 2; i++) {
    const r = await broken('/js/library.js', { 'user-agent': KINDLE });
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(source));
    assert.doesNotMatch(r.headers.vary ?? '', /user-agent/i);
  }
});

test('Kindle requests outside /js/<name>.js get the same answer as any browser', async () => {
  let converted = 0;
  const counted = await start({ kindleTransform: async (source) => { converted++; return { code: source }; } });
  for (const p of ['/js/../server/app.js', '/js/%2e%2e/server/app.js', '/js/nope.js', '/js/sub/api.js', '/css/app.css', '/check.html', '/sw.js']) {
    const kindle = await counted(p, { 'user-agent': KINDLE });
    const chrome = await counted(p, { 'user-agent': CHROME });
    assert.equal(kindle.status, chrome.status, p);
    assert.ok(kindle.body.equals(chrome.body), p);
    assert.deepEqual(headersOf(kindle), headersOf(chrome), p);
  }
  const post = await counted('/js/api.js', { 'user-agent': KINDLE }, 'POST');
  assert.equal(post.status, 404);
  assert.equal(converted, 0);
  // A script the Kindle asks for twice is converted once.
  for (let i = 0; i < 2; i++) {
    const r = await counted('/js/api.js', { 'user-agent': KINDLE });
    assert.equal(r.body.toString('utf8'), FALLBACKS + fs.readFileSync(path.join(JS_DIR, 'api.js'), 'utf8'));
  }
  assert.equal(converted, 1);
});

test('a changed script is converted again, and a failure is logged once', async () => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-kindle-public-'));
  dirs.push(publicDir);
  fs.mkdirSync(path.join(publicDir, 'js'));
  const file = path.join(publicDir, 'js', 'a.js');
  fs.writeFileSync(file, 'export const a = 1;\n');
  const errors = [];
  const seen = [];
  const middleware = kindleScripts({
    publicDir,
    log: { error: (message) => errors.push(message) },
    transform: async (source) => {
      seen.push(source);
      if (source.includes('broken')) throw new Error('stand-in failure');
      return { code: source };
    },
  });
  // What the middleware sends, or null when it passes the request on.
  const ask = () => new Promise((resolve) => {
    const res = { type() { return this; }, set() { return this; }, vary() { return this; }, send: resolve };
    middleware({ method: 'GET', path: '/js/a.js', get: () => KINDLE }, res, () => resolve(null));
  });

  assert.equal(await ask(), `${FALLBACKS}export const a = 1;\n`);
  assert.equal(await ask(), `${FALLBACKS}export const a = 1;\n`);
  assert.equal(seen.length, 1);
  fs.writeFileSync(file, 'export const a = 22;\n');
  assert.equal(await ask(), `${FALLBACKS}export const a = 22;\n`);
  assert.equal(seen.length, 2);

  fs.writeFileSync(file, 'export const broken = 1;\n');
  assert.equal(await ask(), null);
  assert.equal(await ask(), null);
  assert.equal(seen.length, 3);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /a\.js could not be converted/);
});

test('the fallbacks add at() and replaceAll() where they are missing, and work like the real ones', () => {
  const context = vm.createContext({});
  vm.runInContext('delete Array.prototype.at; delete String.prototype.replaceAll;', context);
  assert.equal(vm.runInContext('typeof [].at + typeof "".replaceAll', context), 'undefinedundefined');
  vm.runInContext(`'use strict';\n${FALLBACKS}`, context);
  const cases = [
    '[1, 2, 3].at(-1)',
    '[1, 2, 3].at(0)',
    '[1, 2, 3].at(5)',
    '[1, 2, 3].at(-4)',
    '[1, 2, 3].at(1.7)',
    '[1, 2, 3].at(-1.7)',
    '[1, 2, 3].at()',
    '[].at(0)',
    `'a.b.c'.replaceAll('.', '-')`,
    `'a+b?c*(d)[e]$f^g|h\\\\i'.replaceAll('+', ' ').replaceAll('?', ' ').replaceAll('*(', ' ').replaceAll('[e]', 'E').replaceAll('$', 'S').replaceAll('\\\\', '/')`,
    `'(1+1)(1+1)'.replaceAll('(1+1)', '2')`,
    `'cat cat'.replaceAll('cat', '[$&]')`,
    `'bob'.replaceAll('o', '$$')`,
    `'bob'.replaceAll('o', '$1')`,
    `'abc'.replaceAll('', '-')`,
    `'a-b-c'.replaceAll('-', (match, at) => at)`,
    `'aXbx'.replaceAll(/x/gi, '_')`,
    // As in heavierFamily() in public/js/settings.js
    `'"Literata", Georgia, serif'.split(',')[0].replaceAll('"', '')`,
  ];
  for (const code of cases) assert.deepEqual(vm.runInContext(code, context), vm.runInNewContext(code), code);
  assert.throws(() => vm.runInContext(`'a'.replaceAll(/a/, 'b')`, context), { name: 'TypeError' });
  // Not enumerable, so for...in lists only the items.
  assert.equal(vm.runInContext('var keys = []; for (var k in [7]) keys.push(k); for (var k in "x") keys.push(k); keys.join()', context), '0,0');
  // Where the browser has them, the real ones stay.
  const modernContext = vm.createContext({});
  vm.runInContext(FALLBACKS, modernContext);
  assert.match(vm.runInContext('String([].at) + String("".replaceAll)', modernContext), /\[native code\][\s\S]*\[native code\]/);
});
