/**
 * Link-rate tests: the direction convention (A->B is A's OUT counter), counter
 * wrap / device reboot handling, "down" links, and the load colour classes.
 *
 * Run with `npm run test:linkrates`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Poller } = await import(path.join(ROOT, 'lib/poller.js'));
const { loadClass, indexRates, linkRates, compactLinks, THRESHOLD_WARN, THRESHOLD_CRIT } =
  await import(path.join(ROOT, 'lib/links.js'));

const LINK = { id: 'l1', a: { device: 'a', port: 1 }, b: { device: 'b', port: 24 }, capacityBps: null, label: null };

/** Poller with no history store attached (we only exercise buildSample). */
function makePoller() {
  const store = { device: () => ({ ingest() {}, query: () => ({}), stats: () => null, peaks: () => null }) };
  return new Poller(store, { id: 'a', driver: { host: '10.0.0.1', device: { name: 'a' } }, intervalMs: 1000 });
}

/* ------------------------------------------------------------ rate colours */

test('loadClass thresholds follow the agreed bands', () => {
  assert.equal(THRESHOLD_WARN, 0.6);
  assert.equal(THRESHOLD_CRIT, 0.85);
  assert.equal(loadClass(0, true), 'ok');
  assert.equal(loadClass(0.59, true), 'ok');
  assert.equal(loadClass(0.6, true), 'warn');
  assert.equal(loadClass(0.85, true), 'warn');
  assert.equal(loadClass(0.851, true), 'critical');
  assert.equal(loadClass(1.4, true), 'critical');
  assert.equal(loadClass(null, true), 'unknown');
  assert.equal(loadClass(0.1, false), 'down', 'a down link is always red-dashed');
  assert.equal(loadClass(null, false), 'down');
});

/* ------------------------------------------------------- direction & maths */

function sampleOf(ports) {
  return { ports: ports.map(([index, inBps, outBps, link, speed]) => ({
    index, inBps, outBps, link: link ?? null, speed: speed ?? null, rxBytes: 0, txBytes: 0, name: `p${index}`,
  })) };
}

test('link rate = OUT on side A (forward) and OUT on side B (reverse)', () => {
  const rates = indexRates(new Map([
    ['a', sampleOf([[1, 900, 1000]])],
    ['b', sampleOf([[24, 1000, 400]])],
  ]));
  const [l] = linkRates([LINK], rates);
  assert.equal(l.forwardBps, 1000, 'a->b must be A\'s OUT counter');
  assert.equal(l.reverseBps, 400, 'b->a must be B\'s OUT counter');
  assert.equal(l.totalBps, 1400);
  assert.equal(l.capacityBps, null, 'no negotiated speed and no stored capacity');
  assert.equal(l.ratio, null);
  assert.equal(l.klass, 'unknown');
  assert.equal(l.up, true);
});

test('capacity falls back to the slowest negotiated port speed', () => {
  const rates = indexRates(new Map([
    ['a', sampleOf([[1, 0, 900_000_000, true, 1_000_000_000]])],
    ['b', sampleOf([[24, 0, 0, true, 100_000_000]])],
  ]));
  const [l] = linkRates([LINK], rates);
  assert.equal(l.capacityBps, 100_000_000, 'a 1G port wired to a 100M port is a 100M link');
  assert.equal(l.ratio, 1.5, '900 Mbps over 100 Mbps, clamped for the UI');
  assert.equal(l.klass, 'critical');
  assert.ok(l.ratio <= 1.5, 'ratio is clamped for the UI');
});

test('an explicit capacityBps wins over the negotiated speed', () => {
  const explicit = { ...LINK, capacityBps: 10_000_000_000 };
  const rates = indexRates(new Map([
    ['a', sampleOf([[1, 0, 1_000_000_000, true, 1_000_000_000]])],
    ['b', sampleOf([[24, 0, 0, true, 1_000_000_000]])],
  ]));
  const [l] = linkRates([explicit], rates);
  assert.equal(l.capacityBps, 10_000_000_000);
  assert.equal(l.klass, 'ok');
});

test('a link is down when either side reports link=false', () => {
  const rates = indexRates(new Map([
    ['a', sampleOf([[1, 0, 500, false, 1_000_000_000]])],
    ['b', sampleOf([[24, 0, 0, true, 1_000_000_000]])],
  ]));
  const [l] = linkRates([LINK], rates);
  assert.equal(l.up, false);
  assert.equal(l.klass, 'down');
});

test('a link with an unknown link state is not painted down', () => {
  const rates = indexRates(new Map([
    ['a', sampleOf([[1, 0, 500, null, 1_000_000_000]])],
    ['b', sampleOf([[24, 0, 0, null, 1_000_000_000]])],
  ]));
  const [l] = linkRates([LINK], rates);
  assert.equal(l.up, true, 'null means "unknown", which must not read as down');
  assert.equal(l.klass, 'ok');
});

test('a device that was never polled yields an unknown link, not a down one', () => {
  const rates = indexRates(new Map([['a', sampleOf([[1, 0, 500]])]]));
  const [l] = linkRates([LINK], rates);
  assert.equal(l.up, null);
  assert.equal(l.forwardBps, null);
  assert.equal(l.totalBps, null);
  assert.equal(l.klass, 'unknown');
});

test('compactLinks emits only the map fields', () => {
  const rates = indexRates(new Map([
    ['a', sampleOf([[1, 10, 20, true, 1_000_000_000]])],
    ['b', sampleOf([[24, 20, 5, true, 1_000_000_000]])],
  ]));
  const [frame] = compactLinks(linkRates([LINK], rates));
  assert.deepEqual(Object.keys(frame).sort(), ['c', 'f', 'id', 'k', 'r', 't', 'u']);
  assert.equal(frame.id, 'l1');
  assert.equal(frame.f, 20);
  assert.equal(frame.r, 5);
  assert.equal(frame.k, 'ok');
});

/* -------------------------------------------------- counter regress/wrap */

test('first sample establishes a baseline without inventing a rate', () => {
  const p = makePoller();
  const s1 = p.buildSample({ ports: [{ index: 1, rxBytes: 1000, txBytes: 2000 }] }, 1000);
  assert.equal(s1.first, true);
  assert.equal(s1.inBps, 0);
  assert.equal(s1.outBps, 0);
  assert.equal(s1.totalRxBytes, 1000);

  const s2 = p.buildSample({ ports: [{ index: 1, rxBytes: 1100, txBytes: 2200 }] }, 2000);
  assert.equal(s2.first, false);
  // 100 bytes over 1 s = 800 bps, 200 bytes = 1600 bps.
  assert.equal(s2.ports[0].inBps, 800);
  assert.equal(s2.ports[0].outBps, 1600);
});

test('a counter going backwards (wrap or reboot) reports 0, never a spike', () => {
  const p = makePoller();
  p.buildSample({ ports: [{ index: 1, rxBytes: 4_000_000_000, txBytes: 4_000_000_000 }] }, 1000);

  // 32-bit wrap: the counter restarts near 0.
  const wrapped = p.buildSample({ ports: [{ index: 1, rxBytes: 10, txBytes: 20 }] }, 2000);
  assert.equal(wrapped.ports[0].inBps, 0, 'wrap must not produce a negative or huge rate');
  assert.equal(wrapped.ports[0].outBps, 0);
  assert.equal(wrapped.inBps, 0);

  // Reboot: counters restart small, then grow again from the new baseline.
  const after = p.buildSample({ ports: [{ index: 1, rxBytes: 110, txBytes: 220 }] }, 3000);
  assert.equal(after.ports[0].inBps, 800, 'rate resumes from the fresh baseline');
  assert.equal(after.ports[0].outBps, 1600);
});

test('rates use the real elapsed time, not the nominal interval', () => {
  const p = makePoller();
  p.buildSample({ ports: [{ index: 1, rxBytes: 0, txBytes: 0 }] }, 1000);
  // Poll took 3 s instead of the nominal 1 s: 1000 bytes / 3 s = 2666 bps.
  const s = p.buildSample({ ports: [{ index: 1, rxBytes: 1000, txBytes: 0 }] }, 4000);
  assert.equal(s.ports[0].inBps, Math.round((1000 * 8000) / 3000));
});

test('port metadata from listPorts is attached to the matching port', () => {
  const p = makePoller();
  p.portMeta = [
    { index: 1, name: 'uplink', link: true, speed: 1_000_000_000, duplex: 'full', sfp: false },
    { index: 2, name: 'srv', link: false, speed: 100_000_000, duplex: 'full', sfp: false },
  ];
  const s = p.buildSample({ ports: [{ index: 1, rxBytes: 0, txBytes: 0 }, { index: 2, rxBytes: 0, txBytes: 0 }] }, 1000);
  assert.equal(s.ports[0].name, 'uplink');
  assert.equal(s.ports[0].speed, 1_000_000_000);
  assert.equal(s.ports[1].link, false);
  assert.equal(s.ports[1].name, 'srv');
});

test('the aggregate sample equals the sum of its ports', () => {
  const p = makePoller();
  p.buildSample({ ports: [{ index: 1, rxBytes: 0, txBytes: 0 }, { index: 2, rxBytes: 0, txBytes: 0 }] }, 1000);
  const s = p.buildSample({ ports: [{ index: 1, rxBytes: 100, txBytes: 10 }, { index: 2, rxBytes: 50, txBytes: 5 }] }, 2000);
  assert.equal(s.inBps, s.ports[0].inBps + s.ports[1].inBps);
  assert.equal(s.outBps, s.ports[0].outBps + s.ports[1].outBps);
  assert.equal(s.totalRxBytes, 150);
  assert.equal(s.totalTxBytes, 15);
});
