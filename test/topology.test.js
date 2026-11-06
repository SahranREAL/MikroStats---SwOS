/**
 * Topology model tests: input validation, link rules (duplicates, orphans),
 * atomic persistence (no write when nothing changed), migration of the legacy
 * single-switch config, and the guarantee that no credential ever leaks into a
 * public view.
 *
 * Run with `npm run test:topology`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrostats-topo-'));
process.env.DATA_DIR = TMP;
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.LOG_TARGET = 'stdout';
process.env.LOG_LEVEL = 'error';
// Legacy config used by the migration test.
process.env.SWITCH_NAME = 'CSS326 «Principal»';
process.env.SWITCH_HOST = '172.22.22.2';
process.env.SWITCH_USER = 'admin';
process.env.SWITCH_PASS = 'legacy-secret-pass';
process.env.POLL_INTERVAL_MS = '5000';

const {
  ValidationError, RevMismatch, normalizeDevice, normalizeLink,
  writeAtomic, TopologyStore, isPrivateHost,
} = await import(path.join(ROOT, 'lib/topology.js'));
const config = (await import(path.join(ROOT, 'config.js'))).default;

/* ------------------------------------------------------------- validation */

test('isPrivateHost accepts LAN addresses only', () => {
  for (const h of ['172.22.22.2', '10.0.0.1', '192.168.1.1', '127.0.0.1', 'switch', 'core.lan']) {
    assert.equal(isPrivateHost(h), true, `${h} should be private`);
  }
  for (const h of ['example.com', '8.8.8.8', '1.2.3.4', 'api.github.com']) {
    assert.equal(isPrivateHost(h), false, `${h} should be rejected`);
  }
});

test('normalizeDevice rejects malformed input', () => {
  const bad = [
    [{ id: 'x', type: 'bridge', host: '10.0.0.1' }, 'type'],
    [{ id: 'x', type: 'switch', host: 'example.com' }, 'host'],   // anti-SSRF
    [{ id: 'x', type: 'switch', host: '10.0.0.1', intervalMs: 10 }, 'intervalMs'],
    [{ id: 'x', type: 'switch', host: '10.0.0.1', driver: 'snmp' }, 'driver'],
    [{ id: 'bad id!', type: 'switch', host: '10.0.0.1' }, 'id'],
    [{ id: 'x', type: 'switch', host: '10.0.0.1', tls: 'yes' }, 'tls'],
  ];
  for (const [input, field] of bad) {
    assert.throws(() => normalizeDevice(input, {}), (err) => {
      assert.ok(err instanceof ValidationError, `${field}: expected ValidationError`);
      assert.ok(err.fields.includes(field), `${field}: expected in ${JSON.stringify(err.fields)}`);
      return true;
    }, `should reject ${JSON.stringify(input)}`);
  }
  assert.throws(() => normalizeDevice(null, {}), ValidationError);
  assert.throws(() => normalizeDevice(['x'], {}), ValidationError);
});

test('normalizeDevice accepts a minimal switch and applies defaults', () => {
  const dev = normalizeDevice({ id: 'sw1', host: '172.22.22.2' }, {});
  assert.equal(dev.type, 'switch');
  assert.equal(dev.driver, 'swos');
  assert.equal(dev.auth, 'digest');
  assert.equal(dev.portsMode, 'auto');
  assert.equal(dev.root, false);
  assert.equal(dev.enabled, true);
  assert.equal(dev.intervalMs, config.poll.defaultIntervalMs);
});

test('normalizeDevice keeps a router on the routeros driver', () => {
  const dev = normalizeDevice({ id: 'gw', type: 'router', host: '192.168.88.1' }, {});
  assert.equal(dev.driver, 'routeros');
  assert.equal(dev.auth, 'basic');
});

test('normalizeDevice manual ports are sorted and de-duplicated', () => {
  const dev = normalizeDevice({
    id: 'sw1', host: '10.0.0.2', portsMode: 'manual',
    ports: [{ index: 3 }, { index: 1, kind: 'sfp', speedBps: 10e9 }, { index: 3 }],
  }, {});
  assert.deepEqual(dev.ports.map((p) => p.index), [1, 3]);
  assert.equal(dev.ports[0].kind, 'sfp');
  assert.equal(dev.ports[0].speedBps, 10e9);
});

test('normalizeDevice rejects an out-of-range manual port', () => {
  assert.throws(() => normalizeDevice({
    id: 'sw1', host: '10.0.0.2', portsMode: 'manual', ports: [{ index: 0 }],
  }, {}), (err) => err.fields.includes('ports'));
});

/* ------------------------------------------------------------------ links */

function twoDevices() {
  return {
    version: 1, rev: 1, updatedAt: 0,
    devices: [
      normalizeDevice({ id: 'a', host: '10.0.0.1' }, {}),
      normalizeDevice({ id: 'b', host: '10.0.0.2' }, {}),
    ],
    links: [],
  };
}

test('normalizeLink rejects an unknown device', () => {
  const topo = twoDevices();
  assert.throws(() => normalizeLink({ id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'ghost', port: 1 } }, topo, {}),
    (err) => err instanceof ValidationError && err.fields.includes('b'));
});

test('normalizeLink rejects a self-loop on the same port', () => {
  const topo = twoDevices();
  assert.throws(() => normalizeLink({ id: 'l1', a: { device: 'a', port: 5 }, b: { device: 'a', port: 5 } }, topo, {}),
    (err) => err.fields.includes('a'));
});

test('normalizeLink rejects a duplicate port (same port linked twice)', () => {
  const topo = twoDevices();
  topo.links.push(normalizeLink({ id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 1 } }, topo, {}));
  // Same port on side A...
  assert.throws(() => normalizeLink({ id: 'l2', a: { device: 'a', port: 1 }, b: { device: 'b', port: 2 } }, topo, {}),
    (err) => err.fields.includes('a'));
  // ...and the mirrored form on side B (the conflict is reported on the side
  // of the payload that carries the reused port).
  assert.throws(() => normalizeLink({ id: 'l3', a: { device: 'b', port: 1 }, b: { device: 'a', port: 3 } }, topo, {}),
    (err) => err instanceof ValidationError && err.message.includes('already linked') && err.fields.includes('a'));
});

test('normalizeLink accepts a valid link and derives no capacity by itself', () => {
  const topo = twoDevices();
  const link = normalizeLink({ id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 24 } }, topo, {});
  assert.equal(link.capacityBps, null);
  assert.deepEqual(link.a, { device: 'a', port: 1 });
  assert.deepEqual(link.b, { device: 'b', port: 24 });
});

test('normalizeLink tolerates a bad capacity by falling back to null', () => {
  const topo = twoDevices();
  const link = normalizeLink({
    id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 2 }, capacityBps: -5,
  }, topo, {});
  assert.equal(link.capacityBps, null);
});

test('updating a link may reuse its own ports', () => {
  const topo = twoDevices();
  topo.links.push(normalizeLink({ id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 1 } }, topo, {}));
  const next = normalizeLink({ id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 2 } }, topo,
    { partial: true, current: topo.links[0] });
  assert.equal(next.b.port, 2);
});

/* ------------------------------------------------------- atomic writing */

/** A store on a fresh, explicitly-empty topology file (no legacy seeding). */
function newStore(name) {
  const file = path.join(TMP, `topo-${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, rev: 1, updatedAt: 0, devices: [], links: [] }), { mode: 0o600 });
  return new TopologyStore({
    file,
    credentialsFile: path.join(TMP, `creds-${name}.json`),
    secretKeyFile: path.join(TMP, `key-${name}`),
  });
}

test('writeAtomic writes once and skips byte-identical content', () => {
  const file = path.join(TMP, 'atomic.json');
  assert.equal(writeAtomic(file, '{"a":1}'), true);
  assert.equal(writeAtomic(file, '{"a":1}'), false, 'identical content must not rewrite');
  assert.equal(writeAtomic(file, '{"a":2}'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');

  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  // No stray temp files left behind.
  const leftovers = fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('TopologyStore.save() does not touch the disk when nothing changed', () => {
  const store = newStore('save');
  const file = store.file;
  store.load();
  store.addDevice({ id: 'sw1', host: '10.0.0.9' });
  assert.equal(store.save(), true);

  const mtime = fs.statSync(file).mtimeMs;
  const before = store.writes;
  assert.equal(store.save(), false, 'unchanged topology must not be rewritten');
  assert.equal(store.writes, before);
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'mtime must be untouched');

  // Touching a device DOES write.
  store.updateDevice('sw1', { name: 'renamed' });
  assert.equal(store.save(), true);
  assert.ok(store.writes > before);
});

test('TopologyStore enforces optimistic concurrency', () => {
  const store = newStore('rev');
  store.load();
  store.addDevice({ id: 'sw1', host: '10.0.0.9' });
  store.save();
  const rev = store.topology.rev;

  store.assertRev(rev);
  store.assertRev(undefined);   // optional header
  assert.throws(() => store.assertRev(rev - 1), RevMismatch);
  assert.throws(() => store.assertRev('abc'), ValidationError);
});

/* ------------------------------------------------------------- migration */

test('legacy single-switch config migrates to a one-device topology', () => {
  const file = path.join(TMP, 'topo-migrate.json');
  assert.ok(!fs.existsSync(file), 'precondition: no topology file yet');

  const store = new TopologyStore({
    file,
    credentialsFile: path.join(TMP, 'creds-migrate.json'),
    secretKeyFile: path.join(TMP, 'key-migrate'),
  });
  store.load();

  assert.equal(store.topology.devices.length, 1);
  const dev = store.topology.devices[0];
  assert.equal(dev.id, 'switch');
  assert.equal(dev.name, 'CSS326 «Principal»', 'name must survive the migration');
  assert.equal(dev.host, '172.22.22.2');
  assert.equal(dev.intervalMs, 5000, 'poll interval must survive the migration');
  assert.equal(dev.root, true);
  assert.equal(dev.driver, 'swos');
  assert.deepEqual(dev.layout, { x: 120, y: 120, locked: false });

  // Credentials moved to the encrypted store, not to topology.json.
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('legacy-secret-pass'), 'password must not be in topology.json');
  const creds = store.credentials.get('switch');
  assert.equal(creds.username, 'admin');
  assert.equal(creds.password, 'legacy-secret-pass');

  // The file exists on disk, 0600, and a second load is a plain read.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const store2 = new TopologyStore({
    file,
    credentialsFile: path.join(TMP, 'creds-migrate.json'),
    secretKeyFile: path.join(TMP, 'key-migrate'),
  });
  store2.load();
  assert.equal(store2.topology.devices.length, 1);
  assert.equal(store2.topology.devices[0].name, 'CSS326 «Principal»');
});

/* ------------------------------------------------------- credentials view */

test('publicView never exposes a password', () => {
  const store = newStore('view');
  store.load();
  const dev = store.addDevice({ id: 'sw1', host: '10.0.0.9' });
  store.credentials.set('sw1', 'admin', 'sup3r-secret');
  store.save();

  const view = store.publicView();
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes('sup3r-secret'), 'password leaked into the public view');
  assert.ok(!serialised.includes('"password"'), 'a password field leaked into the public view');
  assert.ok(!serialised.includes('"credentials"'), 'a credentials object leaked into the public view');

  const shown = view.devices.find((d) => d.id === dev.id);
  assert.equal(shown.username, 'admin', 'username is not a secret and may be shown');
  assert.equal(shown.hasCredentials, true);
  assert.ok(!('password' in shown));
});

test('removing a device drops its links and its credentials', () => {
  const store = newStore('del');
  store.load();
  store.addDevice({ id: 'a', host: '10.0.0.1' });
  store.addDevice({ id: 'b', host: '10.0.0.2' });
  store.addLink({ id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 1 } });
  store.credentials.set('a', 'admin', 'pass');

  assert.equal(store.removeDevice('a'), true);
  assert.equal(store.topology.devices.length, 1);
  assert.equal(store.topology.links.length, 0, 'links touching the device must go too');
  assert.equal(store.credentials.get('a'), null);
  assert.equal(store.removeDevice('nope'), false);
});

test('renaming a device keeps its links pointing at it', () => {
  const store = newStore('rename');
  store.load();
  store.addDevice({ id: 'a', host: '10.0.0.1' });
  store.addDevice({ id: 'b', host: '10.0.0.2' });
  store.addLink({ id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 1 } });

  store.updateDevice('a', { id: 'core' });
  assert.equal(store.topology.links[0].a.device, 'core');
  assert.equal(store.getDevice('a'), null);
  assert.equal(store.getDevice('core').id, 'core');
});

test('duplicate device ids are rejected', () => {
  const store = newStore('dup');
  store.load();
  store.addDevice({ id: 'sw1', host: '10.0.0.1' });
  assert.throws(() => store.addDevice({ id: 'sw1', host: '10.0.0.2' }),
    (err) => err instanceof ValidationError && err.fields.includes('id'));
});

test('corrupt topology file falls back to the legacy seed instead of crashing', () => {
  const file = path.join(TMP, 'topo-corrupt.json');
  fs.writeFileSync(file, '{ this is not json', { mode: 0o600 });
  const store = new TopologyStore({
    file,
    credentialsFile: path.join(TMP, 'creds-corrupt.json'),
    secretKeyFile: path.join(TMP, 'key-corrupt'),
  });
  store.load();
  assert.equal(store.topology.devices.length, 1);
  assert.equal(store.topology.devices[0].id, 'switch');
  // The fallback was persisted, so the next boot reads a valid file.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(parsed.devices));
});
