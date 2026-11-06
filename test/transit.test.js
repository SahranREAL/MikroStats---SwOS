/**
 * End-to-end check of IN/OUT through the whole pipeline (raw 64-bit counters ->
 * rate math -> per-port sample -> global totals -> history), with a realistic
 * switch topology.
 *
 * It pins down behaviour that looks like a bug on the dashboard but is not: a
 * download transiting the switch is counted ONCE as IN on the port that receives
 * it (the uplink) and ONCE as OUT on the port that forwards it (the device).
 * Summing every port therefore yields IN ~= OUT for a pure download.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrostats-transit-'));
process.env.DATA_DIR = TMP;
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.LOG_TARGET = 'stdout';
process.env.LOG_LEVEL = 'error';

const { Poller } = await import(path.join(ROOT, 'lib/poller.js'));
const { HistoryStore, GLOBAL_PORT } = await import(path.join(ROOT, 'lib/history.js'));

const PORTS = 26;
const BPS = 500e6;          // 500 Mbit/s, a comfortable speedtest figure
const DT = 3000;            // the real poll interval
const FULL = (BPS / 8) * (DT / 1000);
const ACK = 1.2e6;          // TCP acknowledgements coming back the other way
const ACK_BYTES = (ACK / 8) * (DT / 1000);

const idle = () => Array.from({ length: PORTS }, () => ({ rx: 0, tx: 0 }));
const mbps = (x) => Math.round((x / 1e6) * 10) / 10;

/** 32-bit split, exactly like SwOS reports rb/rbh and tb/tbh. */
const split64 = (v) => ({ low: v >>> 0, high: Math.floor(v / 4294967296) >>> 0 });

/** Counter fabric: each call to fetchStats() advances the cumulative counters. */
function fakeClient() {
  const rxTotals = new Array(PORTS).fill(0);
  const txTotals = new Array(PORTS).fill(0);
  return {
    host: 'fake.test',
    links: {},
    linksAt: Date.now(),
    logError() {},
    async fetchLinks() { this.linksAt = Date.now(); },
    portMeta: (i) => ({ name: `Port${i + 1}`, link: true, speed: 1e9, duplex: 'full', sfp: false }),
    async fetchStats(deltas) {
      const rb = [], rbh = [], tb = [], tbh = [];
      for (let i = 0; i < PORTS; i++) {
        rxTotals[i] += deltas[i].rx;
        txTotals[i] += deltas[i].tx;
        const rx = split64(rxTotals[i]);
        const tx = split64(txTotals[i]);
        rb.push(rx.low); rbh.push(rx.high);
        tb.push(tx.low); tbh.push(tx.high);
      }
      return { rb, rbh, tb, tbh };
    },
  };
}

/** Feed one interval of `deltas` to the poller and return the resulting sample. */
async function step(poller, client, deltas, t) {
  const raw = await client.fetchStats(deltas);
  const sample = poller.buildSample(raw, t);
  poller.history.ingest(sample.t, GLOBAL_PORT, sample.inBps, sample.outBps);
  for (const p of sample.ports) poller.history.ingest(sample.t, p.index, p.inBps, p.outBps);
  return sample;
}

test('IN and OUT are correct for a received and for a transiting flow', async (t) => {
  const store = new HistoryStore(path.join(TMP, 'h'));
  const poller = new Poller(store, { id: 'transit', client: fakeClient() });
  const client = poller.client;

  // Timestamps are aligned so that the baseline and the burst always fall in
  // two different buckets, otherwise the store averages them together.
  const base = Math.floor(Date.now() / 5000) * 5000 + 4000;

  await t.test('un seul port recoit le download', async () => {
    const quiet = idle();
    await step(poller, client, quiet, base);
    const burst = idle();
    burst[4] = { rx: FULL, tx: 0 };                        // port 5 receives
    const s = await step(poller, client, burst, base + DT);

    const p5 = s.ports[4];
    assert.ok(Math.abs(p5.inBps - BPS) < 1000, `port 5 IN ${mbps(p5.inBps)} Mb/s`);
    assert.equal(p5.outBps, 0, `port 5 OUT ${mbps(p5.outBps)} Mb/s`);
    assert.ok(Math.abs(s.inBps - BPS) < 1000, `total IN ${mbps(s.inBps)} Mb/s`);
    assert.equal(s.outBps, 0, `total OUT ${mbps(s.outBps)} Mb/s`);
    // global must be exactly the sum of the ports
    assert.equal(s.inBps, s.ports.reduce((a, x) => a + x.inBps, 0));
    assert.equal(s.outBps, s.ports.reduce((a, x) => a + x.outBps, 0));
  });

  await t.test('le meme download traverse le switch', async () => {
    const t0 = base + 60000;                                // a minute later
    await step(poller, client, idle(), t0);

    const transit = idle();
    transit[0] = { rx: FULL, tx: ACK_BYTES };              // uplink: receives
    transit[1] = { rx: ACK_BYTES, tx: FULL };              // device port: sends
    const s = await step(poller, client, transit, t0 + DT);

    const p1 = s.ports[0]; const p2 = s.ports[1];
    assert.ok(Math.abs(p1.inBps - BPS) < 1000 && p1.outBps < ACK * 2,
      `port 1 IN ${mbps(p1.inBps)} / OUT ${mbps(p1.outBps)}`);
    assert.ok(Math.abs(p2.outBps - BPS) < 1000 && p2.inBps < ACK * 2,
      `port 2 IN ${mbps(p2.inBps)} / OUT ${mbps(p2.outBps)}`);
    assert.ok(s.ports.slice(2).every((p) => p.inBps === 0 && p.outBps === 0), 'ports 3..26 must stay at 0');

    // The symptom reported from the dashboard: both global totals read 500.
    assert.ok(Math.abs(s.inBps - s.outBps) < ACK,
      `IN ${mbps(s.inBps)} vs OUT ${mbps(s.outBps)} Mb/s`);

    const q = poller.series({ port: GLOBAL_PORT, from: base, to: t0 + DT + 1000, maxPoints: 500 });
    const lastIn = q.in[q.in.length - 1] || 0;
    const lastOut = q.out[q.out.length - 1] || 0;
    assert.ok(Math.abs(lastIn - s.inBps) < 1000 && Math.abs(lastOut - s.outBps) < 1000,
      `historique IN ${mbps(lastIn)} / OUT ${mbps(lastOut)} Mb/s`);
    assert.ok(q.t.every((x, i) => i === 0 || x > q.t[i - 1]), 'timestamps must be strictly increasing');
  });

  store.close();
});
