/**
 * Long-run / stability soak for the storage layer + rate calculation.
 * Runs the real Poller + HistoryStore against the real switch (or a simulated
 * counter source) and reports memory, write rate and aggregation accuracy.
 *
 * Usage: node test/soak.js [minutes] [--sim]
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrostats-soak-'));
process.env.DATA_DIR = process.env.SOAK_DATA || TMP;
process.env.LOG_DIR = path.join(process.env.DATA_DIR, 'logs');
process.env.LOG_TARGET = 'stdout';
process.env.LOG_LEVEL = 'warn';

const config = (await import(path.join(ROOT, 'config.js'))).default;
const { HistoryStore, GLOBAL_PORT } = await import(path.join(ROOT, 'lib/history.js'));
const { Poller } = await import(path.join(ROOT, 'lib/poller.js'));

const MINUTES = Number(process.argv[2]) || 3;
const SIM = process.argv.includes('--sim');
const INTERVAL = SIM ? 1000 : config.poll.defaultIntervalMs;

const store = new HistoryStore();
store.startTimers();

/** Synthetic driver: a random walk, testable without real traffic. */
function simDriver() {
  let rx = 1e12;
  let tx = 1e12;
  const N = 26;
  return {
    host: 'sim.test',
    device: { name: 'soak' },
    async listPorts() {
      return Array.from({ length: N }, (_, i) => ({
        index: i + 1, name: `Port${i + 1}`, link: true, speed: 1e9, duplex: 'full', sfp: false,
      }));
    },
    async readCounters() {
      const ports = [{ index: 1, rxBytes: rx, txBytes: tx }];
      for (let i = 2; i <= N; i++) ports.push({ index: i, rxBytes: 0, txBytes: 0 });
      return { t: Date.now(), ports };
    },
    bump() {
      rx += Math.random() * 40e6;   // 0..320 Mbit bursts
      tx += Math.random() * 12e6;
    },
  };
}

const driver = SIM ? simDriver() : null;
if (SIM) setInterval(() => driver.bump(), 1000).unref();

const poller = new Poller(store, {
  id: 'soak',
  driver: driver || (await import(path.join(ROOT, 'lib/drivers.js'))).createDriver(
    { id: 'soak', type: 'switch', driver: 'swos', host: process.env.SWITCH_HOST || '172.22.22.2', port: null, tls: false, auth: 'digest', intervalMs: INTERVAL },
    { username: process.env.SWITCH_USER || 'admin', password: process.env.SWITCH_PASS || '' },
  ),
});

const start = Date.now();
let samples = 0;
let lastReport = 0;
let peakRss = 0;

poller.on('sample', () => {
  samples++;
  const now = Date.now();
  if (now - lastReport < 15000) return;
  lastReport = now;
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  const h = store.health();
  const elapsed = (now - start) / 1000;
  console.log(
    `[${(elapsed / 60).toFixed(1)}m] samples=${samples} rss=${(rss / 1048576).toFixed(1)}MB ` +
    `heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MB ` +
    `buckets=${h.buckets} flushes=${h.flushes} written=${h.bytesWritten}B file=${h.bytes}B`
  );
});

poller.start();

setTimeout(() => {
  console.log('\n=== soak finished ===');
  const h = store.health();
  const minutes = (Date.now() - start) / 60000;
  console.log('samples ingested :', samples);
  console.log('rss peak         :', (peakRss / 1048576).toFixed(1), 'MB');
  console.log('rss final        :', (process.memoryUsage().rss / 1048576).toFixed(1), 'MB');
  console.log('history files    :', h.devices, 'ports:', h.ports, 'buckets:', h.buckets);
  console.log('flushes          :', h.flushes, 'bytes written:', h.bytesWritten);
  console.log('bytes/sample     :', samples ? (h.bytesWritten / samples).toFixed(2) : '0');
  console.log('writes/minute    :', minutes ? (h.flushes / minutes).toFixed(1) : '0');
  console.log('bytes/minute     :', minutes ? (h.bytesWritten / minutes).toFixed(0) : '0');
  console.log('history size     :', (h.bytes / 1024).toFixed(1), 'KB');
  console.log('compactions      :', h.compactions);

  const q = poller.series({ port: GLOBAL_PORT, from: Date.now() - 3600e3, to: Date.now() + 1, maxPoints: 700 });
  let inMax = 0; let outMax = 0;
  for (let i = 0; i < q.points; i++) {
    if (q.inMax[i] > inMax) inMax = q.inMax[i];
    if (q.outMax[i] > outMax) outMax = q.outMax[i];
  }
  console.log('global IN max    :', (inMax / 1e6).toFixed(2), 'Mbps');
  console.log('global OUT max   :', (outMax / 1e6).toFixed(2), 'Mbps');
  console.log('series points    :', q.points, 'source:', q.source);

  poller.stop();
  store.close();
  process.exit(0);
}, MINUTES * 60 * 1000);
