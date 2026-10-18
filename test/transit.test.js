/**
 * End-to-end check of IN/OUT through the whole pipeline (raw 64-bit counters ->
 * rate math -> per-port sample -> global totals -> store), with a realistic
 * switch topology.
 *
 * It pins down behaviour that looks like a bug on the dashboard but is not: a
 * download transiting the switch is counted ONCE as IN on the port that receives
 * it (the uplink) and ONCE as OUT on the port that forwards it (the device).
 * Summing every port therefore yields IN ~= OUT for a pure download.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const DB = path.join(os.tmpdir(), 'mikrostats-transit.db');
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix); } catch { /* fresh */ } }
// config.js resolves dbFile when it is first required, so the override has to be
// in place before the store is pulled in.
process.env.DB_FILE = DB;
process.env.LOG_DIR = path.join(os.tmpdir(), 'mikrostats-test-logs');

const { Poller } = require(ROOT + '/lib/poller');
const { Store } = require(ROOT + '/lib/store');

const PORTS = 26;
const BPS = 500e6;          // 500 Mbit/s, a comfortable speedtest figure
const DT = 3000;            // the real poll interval
const FULL = (BPS / 8) * (DT / 1000);
const ACK = 1.2e6;          // TCP acknowledgements coming back the other way
const ACK_BYTES = (ACK / 8) * (DT / 1000);

const idle = () => Array.from({ length: PORTS }, () => ({ rx: 0, tx: 0 }));
const mbps = (x) => Math.round((x / 1e6) * 10) / 10;

let failed = 0;
function check(name, pass, detail) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!pass) failed++;
}

/** 32-bit split, exactly like SwOS reports rb/rbh and tb/tbh. */
const split64 = (v) => ({ low: v >>> 0, high: Math.floor(v / 4294967296) >>> 0 });

/** Counter fabric: each call to fetchStats() advances the cumulative counters. */
function fakeClient() {
  const rxTotals = new Array(PORTS).fill(0);
  const txTotals = new Array(PORTS).fill(0);
  return {
    links: {},
    linksAt: Date.now(),
    logError() {},
    async fetchLinks() { this.linksAt = Date.now(); },
    portMeta: (i) => ({ name: `Port${i + 1}`, link: true, speed: 1000, duplex: 'full', sfp: false }),
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
  poller.store.ingest(sample.t, 0, sample.inBps, sample.outBps);
  return sample;
}

(async () => {
  const store = new Store().open();
  const poller = new Poller(store);
  const client = fakeClient();
  poller.client = client;

  // Timestamps are aligned so that the baseline and the burst always fall in
  // two different 5s buckets, otherwise the store averages them together.
  const base = Math.floor(Date.now() / 5000) * 5000 + 4000;

  // -------------------------------------------------------------- scenario 1
  // A single port RECEIVES 500 Mbit/s and nothing else moves: the shape of a
  // unidirectional flow. The dashboard must show IN ~= 500 and OUT ~= 0.
  {
    const quiet = idle();
    await step(poller, client, quiet, base);
    const burst = idle();
    burst[4] = { rx: FULL, tx: 0 };                        // port 5 receives
    const s = await step(poller, client, burst, base + DT);

    const p5 = s.ports[4];
    console.log(`\n  1) un seul port recoit le download`);
    console.log(`     port 5           : IN ${mbps(p5.inBps)} | OUT ${mbps(p5.outBps)} Mb/s`);
    console.log(`     total du switch  : IN ${mbps(s.inBps)} | OUT ${mbps(s.outBps)} Mb/s\n`);

    check('le port qui recoit affiche tout en IN', Math.abs(p5.inBps - BPS) < 1000, `${mbps(p5.inBps)} Mb/s`);
    check('... et rien en OUT', p5.outBps === 0, `${mbps(p5.outBps)} Mb/s`);
    check('le total IN vaut 500', Math.abs(s.inBps - BPS) < 1000, `${mbps(s.inBps)} Mb/s`);
    check('le total OUT vaut 0 (affichage asymetrique)', s.outBps === 0, `${mbps(s.outBps)} Mb/s`);
  }

  // -------------------------------------------------------------- scenario 2
  // The same 500 Mbit/s download TRANSITING the switch: the bytes arrive on the
  // uplink (port 1 RX) and leave towards the device (port 2 TX). Only ACKs come
  // back. This is what really happens during a speedtest on a LAN port.
  {
    const t0 = base + 60000;                                // a minute later
    await step(poller, client, idle(), t0);

    const transit = idle();
    transit[0] = { rx: FULL, tx: ACK_BYTES };              // uplink: receives
    transit[1] = { rx: ACK_BYTES, tx: FULL };              // device port: sends
    const s = await step(poller, client, transit, t0 + DT);

    const p1 = s.ports[0], p2 = s.ports[1];
    console.log(`  2) le meme download traverse le switch`);
    console.log(`     port 1 (uplink)  : IN ${mbps(p1.inBps)} | OUT ${mbps(p1.outBps)} Mb/s`);
    console.log(`     port 2 (appareil): IN ${mbps(p2.inBps)} | OUT ${mbps(p2.outBps)} Mb/s`);
    console.log(`     total du switch  : IN ${mbps(s.inBps)} | OUT ${mbps(s.outBps)} Mb/s\n`);

    check('le port 1 ne montre que de la reception', Math.abs(p1.inBps - BPS) < 1000 && p1.outBps < ACK * 2,
      `IN ${mbps(p1.inBps)} / OUT ${mbps(p1.outBps)}`);
    check('le port 2 ne montre que de l emission', Math.abs(p2.outBps - BPS) < 1000 && p2.inBps < ACK * 2,
      `IN ${mbps(p2.inBps)} / OUT ${mbps(p2.outBps)}`);
    check('tous les autres ports restent a zero', s.ports.slice(2).every((p) => p.inBps === 0 && p.outBps === 0),
      'ports 3..26 a 0');

    // The symptom reported from the dashboard: both global totals read 500.
    check('le total IN ~= le total OUT sur un flux traversant', Math.abs(s.inBps - s.outBps) < ACK,
      `IN ${mbps(s.inBps)} vs OUT ${mbps(s.outBps)} Mb/s  <- les deux affichent 500`);

    const q = store.query({ port: 0, from: base, to: t0 + DT + 1000, maxPoints: 500 });
    const lastIn = q.in[q.in.length - 1] || 0;
    const lastOut = q.out[q.out.length - 1] || 0;
    check('l historique enregistre les memes totaux', Math.abs(lastIn - s.inBps) < 1000 && Math.abs(lastOut - s.outBps) < 1000,
      `historique IN ${mbps(lastIn)} / OUT ${mbps(lastOut)} Mb/s`);
    check('un seul point par horodatage', q.t.every((t, i) => i === 0 || t > q.t[i - 1]), `${q.points} points`);
  }

  store.close();
  console.log(failed ? `\n${failed} verification(s) en echec` : '\nIN et OUT sont corrects dans les deux cas');
  process.exit(failed ? 1 : 0);
})();
