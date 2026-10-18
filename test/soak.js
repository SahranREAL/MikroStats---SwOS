/**
 * Long-run / stability soak for the storage layer + rate calculation.
 * Runs the real Poller + Store against the real switch (or a simulated counter
 * source) and reports memory, write rate and aggregation accuracy.
 *
 * Usage: node soak.js [minutes] [--sim]
 */
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
process.env.DB_FILE = process.env.SOAK_DB || path.join(os.tmpdir(), 'mikrostats-soak.db');
process.env.LOG_DIR = path.join(os.tmpdir(), 'mikrostats-soak-logs');

const fs = require('fs');
const config = require(ROOT + '/config');
const { Store } = require(ROOT + '/lib/store');
const { Poller } = require(ROOT + '/lib/poller');

const MINUTES = Number(process.argv[2]) || 3;
const SIM = process.argv.includes('--sim');
const INTERVAL = SIM ? 1000 : config.poll.intervalMs;

try { fs.unlinkSync(process.env.DB_FILE); } catch { /* fresh */ }

const store = new Store().open();
store.flushIntervalMs = 10000; // flush more often to exercise the writer
store.startTimers();

const poller = new Poller(store);
if (SIM) {
  // Synthetic counters: 1 Gbit-ish random walk, so aggregation is testable
  // without depending on real traffic.
  let rx = 1e12;
  let tx = 1e12;
  let linked = 0;
  poller.client.fetchStats = async () => {
    const n = 26;
    const rb = new Array(n).fill(0);
    const tb = new Array(n).fill(0);
    const rbh = new Array(n).fill(0);
    const tbh = new Array(n).fill(0);
    rb[0] = (rx % 4294967296) >>> 0; rbh[0] = Math.floor(rx / 4294967296);
    tb[0] = (tx % 4294967296) >>> 0; tbh[0] = Math.floor(tx / 4294967296);
    for (let i = 0; i < n; i++) {
      rb[i] = (rb[i] + (i === 0 ? 0 : 0));
      tb[i] = (tb[i] + (i === 0 ? 0 : 0));
    }
    return { rb, rbh, tb, tbh };
  };
  const bump = () => {
    rx += Math.random() * 40e6;   // 0..320 Mbit bursts
    tx += Math.random() * 12e6;
  };
  setInterval(bump, 1000).unref();
  poller.client.fetchLinks = async () => { linked++; return poller.client.links || { prt: 26, sfpo: 24, spd: new Array(26).fill(2), nm: new Array(26).fill('506f7274'), lnk: 1, en: 67108863, dpx: 1, an: 67108863 }; };
}

const start = Date.now();
let samples = 0;
let lastReport = 0;
let peakRss = 0;

poller.on('sample', (s) => {
  samples++;
  const now = Date.now();
  if (now - lastReport < 15000) return;
  lastReport = now;
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  const elapsed = (now - start) / 1000;
  console.log(
    `[${(elapsed / 60).toFixed(1)}m] samples=${samples} rss=${(rss / 1048576).toFixed(1)}MB ` +
    `heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MB in=${(s.inBps / 1e6).toFixed(1)}Mbps ` +
    `out=${(s.outBps / 1e6).toFixed(1)}Mbps ring=${poller.globalRing.size}/${poller.globalRing.capacity} ` +
    `buckets=${store.buckets.size} rows=${store.health().rows}`
  );
});

poller.start();

setTimeout(() => {
  console.log('\n=== soak finished ===');
  const h = store.health();
  console.log('samples ingested :', samples);
  console.log('rss peak         :', (peakRss / 1048576).toFixed(1), 'MB');
  console.log('rss final        :', (process.memoryUsage().rss / 1048576).toFixed(1), 'MB');
  console.log('rows in db       :', h.rows);
  console.log('flushes          :', h.flushes, 'rows written:', h.rowsWritten);
  console.log('rows written/sample:', (h.rowsWritten / samples).toFixed(2));
  console.log('db size          :', (h.dbBytes / 1024).toFixed(1), 'KB');
  console.log('store errors     :', h.errors);
  console.log('open buckets     :', h.openBuckets);

  const byRes = require('better-sqlite3')(process.env.DB_FILE, { readonly: true })
    .prepare('select res, count(*) c, sum(n) n from samples group by res order by res').all();
  console.log('tiers            :', JSON.stringify(byRes));

  const peak = store.db.prepare('select max(in_max) i, max(out_max) o from samples where res=5 and port=0').get();
  const avg = store.db.prepare('select avg(in_avg) a from samples where res=5 and port=0').get();
  console.log('global IN max    :', (peak.i / 1e6).toFixed(2), 'Mbps  (avg', (avg.a / 1e6).toFixed(2), 'Mbps)');
  console.log('global OUT max   :', (peak.o / 1e6).toFixed(2), 'Mbps');

  poller.stop();
  store.close();
  process.exit(0);
}, MINUTES * 60 * 1000);
