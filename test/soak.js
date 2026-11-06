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

const poller = new Poller(store, { id: 'soak' });
if (SIM) {
  // Synthetic counters: a random walk, so aggregation is testable without
  // depending on real traffic.
  let rx = 1e12;
  let tx = 1e12;
  poller.client.fetchStats = async () => {
    const n = 26;
    const rb = new Array(n).fill(0);
    const tb = new Array(n).fill(0);
    const rbh = new Array(n).fill(0);
    const tbh = new Array(n).fill(0);
    rb[0] = (rx % 4294967296) >>> 0; rbh[0] = Math.floor(rx / 4294967296);
    tb[0] = (tx % 4294967296) >>> 0; tbh[0] = Math.floor(tx / 4294967296);
    return { rb, rbh, tb, tbh };
  };
  const bump = () => {
    rx += Math.random() * 40e6;   // 0..320 Mbit bursts
    tx += Math.random() * 12e6;
  };
  setInterval(bump, 1000).unref();
  poller.client.fetchLinks = async () => {
    poller.client.linksAt = Date.now();
    return poller.client.links || {
      prt: 26, sfpo: 24, spd: new Array(26).fill(2),
      nm: new Array(26).fill('506f7274'), lnk: 1, en: 67108863, dpx: 1, an: 67108863,
    };
  };
  poller.client.portMeta ??= () => ({ name: 'Port', link: true, speed: 1e9, duplex: 'full', sfp: false });
}

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
