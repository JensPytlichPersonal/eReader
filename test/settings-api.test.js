import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';

/**
 * A stand-in for Hardcover's API, as in hardcover.test.js: `answer(operation, token)` gives the GraphQL
 * data, or { status, body }. `calls` has each operation asked for and the authorization it was sent with.
 */
function standIn(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const operation = /query (\w+)/.exec(JSON.parse(init.body).query)[1];
    const { authorization } = init.headers;
    calls.push({ operation, authorization });
    const reply = await answer(operation, authorization.replace(/^Bearer /, ''));
    if (reply.status) return new Response(reply.body ?? '', { status: reply.status });
    return new Response(JSON.stringify({ data: reply }));
  };
  return { calls, fetch };
}

// Hardcover takes every token but "expired", and finds a book whatever is searched for.
const hardcover = standIn((operation, token) => {
  if (token === 'expired') return { status: 401, body: '' };
  return operation === 'Search' ? { search: { ids: [427] } } : { status: 500 };
});

// Minimal cookie-aware client
function client(origin) {
  let cookie = '';
  return async (p, { method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(origin + p, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

const dirs = [];
/**
 * Starts the app on a free port with the stand-in for Hardcover and without HARDCOVER_TOKEN, unless
 * `options` gives one, on a new data directory unless it gives one.
 */
async function start(options = {}) {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ereader-settings-'));
  dirs.push(dataDir);
  const created = createApp({ quiet: true, sessionDays: 1, hardcoverToken: '', hardcoverFetch: hardcover.fetch, ...options, dataDir });
  const server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { dataDir, created, client: () => client(origin), stop: () => { server.close(); created.db.close(); } };
}

/** Signs up the first account, an admin, on a server just started. */
async function admin(app) {
  const c = app.client();
  const r = await c('/api/auth/register', { method: 'POST', body: { username: 'jens', password: 'secret1', displayName: 'Jens Pytlich' } });
  assert.equal(r.status, 201);
  return c;
}

let main, jens, anna;
before(async () => {
  main = await start();
  jens = await admin(main);
  await jens('/api/users', { method: 'POST', body: { username: 'anna', password: 'pass1234' } });
  anna = main.client();
  await anna('/api/auth/login', { method: 'POST', body: { username: 'anna', password: 'pass1234' } });
});
after(() => {
  main.stop();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const status = (hardcoverStatus) => ({ hardcover: { source: 'none', hint: '', updatedAt: null, updatedBy: null, ...hardcoverStatus } });
const check = (c) => c('/api/settings/hardcover/check', { method: 'POST' });

test('only an admin sees and changes the server\'s settings', async () => {
  const anon = main.client();
  for (const c of [anon, anna]) {
    const expected = c === anon ? 401 : 403;
    assert.equal((await c('/api/settings')).status, expected);
    assert.equal((await c('/api/settings', { method: 'PUT', body: { hardcoverToken: 'mine' } })).status, expected);
    assert.equal((await check(c)).status, expected);
  }
  assert.deepEqual((await jens('/api/settings')).data, status({ source: 'none' }));
  assert.equal(hardcover.calls.length, 0);
});

test('a Hardcover token saved under Settings is used at once', async () => {
  assert.deepEqual((await jens('/api/settings')).data, status({ source: 'none' }));
  assert.deepEqual((await jens('/api/health')).data.lookup, ['openlibrary']);
  assert.deepEqual((await check(jens)).data, { ok: false, error: 'No Hardcover token is set.' });
  assert.equal(main.created.catalogues.missingBooks, null);

  // Copied with "Bearer " in front, as Hardcover shows it.
  const saved = Date.now();
  let r = await jens('/api/settings', { method: 'PUT', body: { hardcoverToken: ' Bearer abcd1234\n' } });
  assert.equal(r.status, 200);
  const { updatedAt, ...rest } = r.data.hardcover;
  assert.deepEqual(rest, { source: 'settings', hint: '1234', updatedBy: 'Jens Pytlich' });
  assert.ok(updatedAt >= saved && updatedAt <= Date.now());
  assert.deepEqual((await jens('/api/settings')).data, r.data);
  // The token itself never leaves the server.
  assert.ok(!JSON.stringify(r.data).includes('abcd1234'));

  // The lookup asks Hardcover, and the books a series lacks come from it, without a restart.
  assert.deepEqual((await jens('/api/health')).data.lookup, ['hardcover', 'openlibrary']);
  assert.notEqual(main.created.catalogues.missingBooks, null);
  hardcover.calls.length = 0;
  r = await check(jens);
  assert.deepEqual([r.status, r.data], [200, { ok: true }]);
  assert.deepEqual(hardcover.calls, [{ operation: 'Search', authorization: 'Bearer abcd1234' }]);
});

test('checking says when Hardcover does not take the token', async () => {
  const r = await jens('/api/settings', { method: 'PUT', body: { hardcoverToken: 'expired' } });
  assert.equal(r.data.hardcover.hint, 'ired');
  const checked = await check(jens);
  assert.equal(checked.status, 200);
  assert.equal(checked.data.ok, false);
  assert.match(checked.data.error, /did not accept the token/);
});

test('what cannot be a token is refused, and the one saved stays', async () => {
  await jens('/api/settings', { method: 'PUT', body: { hardcoverToken: 'abcd1234' } });
  for (const hardcoverToken of [42, null, undefined, 'x'.repeat(5000), 'abc def', 'abc\tdef', 'abc\u0000def', 'abc\u00e9def', 'Bearer abc def', 'Bearer']) {
    const r = await jens('/api/settings', { method: 'PUT', body: { hardcoverToken } });
    assert.equal(r.status, 400, JSON.stringify(hardcoverToken));
    assert.equal(typeof r.data.error, 'string');
  }
  assert.equal((await jens('/api/settings')).data.hardcover.hint, '1234');
  // As long as a token may be, it is taken.
  assert.equal((await jens('/api/settings', { method: 'PUT', body: { hardcoverToken: 'x'.repeat(4096) } })).status, 200);
});

test('removing the saved token goes back to none, or to HARDCOVER_TOKEN', async () => {
  await jens('/api/settings', { method: 'PUT', body: { hardcoverToken: 'abcd1234' } });
  let r = await jens('/api/settings', { method: 'PUT', body: { hardcoverToken: '' } });
  assert.deepEqual([r.status, r.data], [200, status({ source: 'none' })]);
  assert.deepEqual((await jens('/api/health')).data.lookup, ['openlibrary']);
  assert.equal(main.created.catalogues.missingBooks, null);

  const withEnv = await start({ hardcoverToken: 'env-token' });
  try {
    const solo = await admin(withEnv);
    assert.deepEqual((await solo('/api/settings')).data, status({ source: 'env', hint: 'oken' }));
    assert.deepEqual((await solo('/api/health')).data.lookup, ['hardcover', 'openlibrary']);
    // The one saved here wins over the server's.
    r = await solo('/api/settings', { method: 'PUT', body: { hardcoverToken: 'abcd1234' } });
    assert.equal(r.data.hardcover.source, 'settings');
    hardcover.calls.length = 0;
    await check(solo);
    assert.deepEqual(hardcover.calls.map((c) => c.authorization), ['Bearer abcd1234']);

    r = await solo('/api/settings', { method: 'PUT', body: { hardcoverToken: '' } });
    assert.deepEqual(r.data, status({ source: 'env', hint: 'oken' }));
    assert.deepEqual((await solo('/api/health')).data.lookup, ['hardcover', 'openlibrary']);
    hardcover.calls.length = 0;
    assert.deepEqual((await check(solo)).data, { ok: true });
    assert.deepEqual(hardcover.calls.map((c) => c.authorization), ['Bearer env-token']);
  } finally {
    withEnv.stop();
  }
});

test('the saved token is kept when the server starts again', async () => {
  const first = await start();
  let solo;
  try {
    solo = await admin(first);
    await solo('/api/settings', { method: 'PUT', body: { hardcoverToken: 'Bearer abcd1234' } });
  } finally {
    first.stop();
  }
  const again = await start({ dataDir: first.dataDir });
  try {
    solo = again.client();
    await solo('/api/auth/login', { method: 'POST', body: { username: 'jens', password: 'secret1' } });
    const r = await solo('/api/settings');
    assert.equal(r.status, 200);
    assert.deepEqual({ ...r.data.hardcover, updatedAt: null }, status({ source: 'settings', hint: '1234', updatedBy: 'Jens Pytlich' }).hardcover);
    assert.deepEqual((await solo('/api/health')).data.lookup, ['hardcover', 'openlibrary']);
  } finally {
    again.stop();
  }
});
