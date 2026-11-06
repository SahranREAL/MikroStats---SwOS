/**
 * HTTP-level tests: the whole API surface against a real server process.
 *
 * Focus:
 *   - writes always need the token, reads never leak credentials;
 *   - optimistic concurrency (If-Match) and input validation;
 *   - no disk write when a layout payload changes nothing;
 *   - body size and write rate limits.
 *
 * Run with `npm run test:api`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrostats-api-'));
const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'sup3r-secret-password';

// Empty topology on disk: this suite owns the topology, no legacy seeding.
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'data', 'topology.json'),
  JSON.stringify({ version: 1, rev: 1, updatedAt: 0, devices: [], links: [] }),
  { mode: 0o600 },
);

const child = spawn(process.execPath, ['--throw-deprecation', 'server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: path.join(TMP, 'data'),
    LOG_DIR: path.join(TMP, 'logs'),
    LOG_TARGET: 'stdout',
    LOG_LEVEL: 'error',
    DASHBOARD_TOKEN: TOKEN,
    POLL_INTERVAL_MS: '60000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childLog = [];
child.stdout.on('data', (d) => childLog.push(String(d)));
child.stderr.on('data', (d) => childLog.push(String(d)));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${childLog.join('')}`);
}

test.before(async () => { await waitForServer(); });
test.after(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } });

const get = (p, opts) => fetch(`${BASE}${p}`, opts);
const json = (method, p, body, opts = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: { 'content-type': 'application/json', ...(opts.token === false ? {} : { authorization: `Bearer ${TOKEN}` }), ...opts.headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/* ------------------------------------------------------------- topology */

test('GET /api/topology succeeds without any credential', async () => {
  const res = await get('/api/topology');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.devices));
  assert.ok(Number.isInteger(body.rev));
});

test('every non-GET route requires the token', async () => {
  const cases = [
    ['POST', '/api/devices', { id: 'x', host: '10.0.0.1' }],
    ['PUT', '/api/topology/layout', { devices: [] }],
    ['POST', '/api/links', { id: 'x', a: { device: 'a', port: 1 }, b: { device: 'b', port: 1 } }],
    ['DELETE', '/api/devices/x', undefined],
    ['PATCH', '/api/devices/x', {}],
    ['DELETE', '/api/links/x', undefined],
  ];
  for (const [method, url, body] of cases) {
    const res = await json(method, url, body, { token: false });
    assert.equal(res.status, 401, `${method} ${url} must be refused without a token`);
  }
  // A wrong token is refused too.
  const res = await fetch(`${BASE}/api/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body: JSON.stringify({ id: 'x', host: '10.0.0.1' }),
  });
  assert.equal(res.status, 401);
});

/* -------------------------------------------------------------- devices */

test('creating a device stores credentials out of band and never echoes them', async () => {
  const res = await json('POST', '/api/devices', {
    id: 'sw1',
    name: 'Switch «Bureau» & Co',
    type: 'switch',
    host: '172.22.22.2',
    intervalMs: 5000,
    credentials: { username: 'admin', password: SECRET },
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const body = JSON.parse(text);
  assert.equal(body.device.id, 'sw1');
  assert.equal(body.device.username, 'admin');
  assert.equal(body.device.hasCredentials, true);
  assert.ok(!JSON.stringify(body).includes(SECRET), 'password echoed back');

  // topology.json holds no secret...
  const topoRaw = fs.readFileSync(path.join(TMP, 'data', 'topology.json'), 'utf8');
  assert.ok(!topoRaw.includes(SECRET), 'password written to topology.json');
  // ...credentials.json holds it encrypted, not in clear text.
  const credsRaw = fs.readFileSync(path.join(TMP, 'data', 'credentials.json'), 'utf8');
  assert.ok(!credsRaw.includes(SECRET), 'password stored in clear text');
  assert.ok(credsRaw.includes('"sw1"'));
  assert.equal(fs.statSync(path.join(TMP, 'data', 'credentials.json')).mode & 0o777, 0o600);
});

test('no API response ever contains the password', async () => {
  const routes = [
    '/api/topology', '/api/devices', '/api/links', '/api/stats',
    '/api/status', '/api/alerts', '/api/history?range=5m',
    '/api/devices/sw1/stats', '/api/devices/sw1/history?range=5m',
  ];
  for (const url of routes) {
    const res = await get(url);
    const text = await res.text();
    assert.ok(!text.includes(SECRET), `${url} leaked the password`);
    assert.ok(!text.includes('"password"'), `${url} exposes a password field`);
  }
  // The SSE hello frame carries the same topology, with the same guarantee.
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/stream`, { signal: ac.signal });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const hello = Buffer.from(value).toString('utf8');
  ac.abort();
  assert.ok(hello.includes('event: hello'), 'the stream must open with a hello frame');
  assert.ok(!hello.includes(SECRET), 'the SSE hello leaked the password');
});

test('validation rejects a public host, a bad interval and a bad type', async () => {
  const bad = [
    { id: 'bad1', host: 'example.com' },
    { id: 'bad2', host: '10.0.0.3', intervalMs: 10 },
    { id: 'bad3', host: '10.0.0.3', type: 'bridge' },
    { id: 'bad id', host: '10.0.0.3' },
  ];
  for (const body of bad) {
    const res = await json('POST', '/api/devices', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} should be 400`);
    const parsed = await res.json();
    assert.equal(parsed.success, false);
    assert.ok(Array.isArray(parsed.fields) && parsed.fields.length > 0, 'a field list is returned');
  }
});

test('duplicate device ids are refused', async () => {
  const res = await json('POST', '/api/devices', { id: 'sw1', host: '172.22.22.3' });
  assert.equal(res.status, 400);
});

test('a malformed JSON body is a 400, not a crash', async () => {
  const res = await fetch(`${BASE}/api/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: '{ not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await fetch(`${BASE}/api/status`)).status, 200, 'server must survive');
});

test('an oversized body is a 413', async () => {
  const res = await fetch(`${BASE}/api/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ id: 'big', host: '10.0.0.4', name: 'x'.repeat(64 * 1024) }),
  });
  assert.equal(res.status, 413);
});

/* ---------------------------------------------------------------- links */

test('links are validated: unknown device and duplicate port', async () => {
  await json('POST', '/api/devices', { id: 'sw2', host: '172.22.22.4' });

  const ghost = await json('POST', '/api/links', {
    id: 'l-ghost', a: { device: 'sw1', port: 1 }, b: { device: 'ghost', port: 1 },
  });
  assert.equal(ghost.status, 400);

  const ok = await json('POST', '/api/links', {
    id: 'l1', a: { device: 'sw1', port: 1 }, b: { device: 'sw2', port: 1 },
  });
  assert.equal(ok.status, 201, await ok.text());

  // Same port on sw1 again -> refused.
  const dup = await json('POST', '/api/links', {
    id: 'l2', a: { device: 'sw1', port: 1 }, b: { device: 'sw2', port: 2 },
  });
  assert.equal(dup.status, 400);

  // The same physical pair reversed is a duplicate too.
  const mirrored = await json('POST', '/api/links', {
    id: 'l3', a: { device: 'sw2', port: 1 }, b: { device: 'sw1', port: 2 },
  });
  assert.equal(mirrored.status, 400);

  const links = await (await get('/api/links')).json();
  assert.equal(links.links.length, 1);
  assert.equal(links.links[0].id, 'l1');
});

test('deleting a device removes its links', async () => {
  const res = await json('DELETE', '/api/devices/sw2');
  assert.equal(res.status, 200);
  const links = await (await get('/api/links')).json();
  assert.equal(links.links.length, 0, 'orphan links must be pruned');
  const topo = await (await get('/api/topology')).json();
  assert.equal(topo.devices.length, 1);
});

/* ----------------------------------------------------- concurrency & I/O */

test('If-Match refuses a stale revision with 412', async () => {
  const topo = await (await get('/api/topology')).json();
  const stale = await json('PATCH', '/api/devices/sw1', { name: 'renamed' }, {
    headers: { 'if-match': String(topo.rev - 1) },
  });
  assert.equal(stale.status, 412);

  const fresh = await json('PATCH', '/api/devices/sw1', { name: 'renamed' }, {
    headers: { 'if-match': String(topo.rev) },
  });
  const freshText = await fresh.text();
  assert.equal(fresh.status, 200, freshText);
  assert.equal(JSON.parse(freshText).device.name, 'renamed');
});

test('an unchanged layout writes nothing to disk', async () => {
  // Establish the position first (the device starts with no layout at all).
  const seed = await json('PUT', '/api/topology/layout', { devices: [{ id: 'sw1', x: 120, y: 120, locked: false }] });
  assert.equal((await seed.json()).written, true);

  const before = await (await get('/api/status')).json();
  const file = path.join(TMP, 'data', 'topology.json');
  const mtime = fs.statSync(file).mtimeMs;

  const res = await json('PUT', '/api/topology/layout', { devices: [{ id: 'sw1', x: 120, y: 120, locked: false }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, 0, 'nothing actually moved');
  assert.equal(body.written, false, 'no disk write');

  const after = await (await get('/api/status')).json();
  assert.equal(after.topology.writes, before.topology.writes, 'write counter must not move');
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'file mtime must not move');

  // Moving it DOES write, exactly once.
  const moved = await json('PUT', '/api/topology/layout', { devices: [{ id: 'sw1', x: 400, y: 260, locked: false }] });
  const movedBody = await moved.json();
  assert.equal(movedBody.changed, 1);
  assert.equal(movedBody.written, true);
  assert.ok(fs.statSync(file).mtimeMs >= mtime);
});

test('the write rate limiter kicks in', async () => {
  let limited = 0;
  for (let i = 0; i < 75; i++) {
    const res = await json('PUT', '/api/topology/layout', { devices: [{ id: 'sw1', x: 400 + i, y: 260 }] });
    if (res.status === 429) limited++;
    else assert.equal(res.status, 200);
  }
  assert.ok(limited > 0, 'the limiter must trigger within 75 writes');
  const retry = await json('PUT', '/api/topology/layout', { devices: [] });
  assert.equal(retry.status, 429);
  assert.ok(retry.headers.get('retry-after'));
});

/* ------------------------------------------------------------- cleanup */

test('server shuts down cleanly on SIGTERM', async () => {
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('did not exit')), 8000)),
  ]);
  assert.equal(code, 0, `exit code, log:\n${childLog.join('')}`);
});
