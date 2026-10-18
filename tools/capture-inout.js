/**
 * Diagnostic IN/OUT - determine whether a traffic event is genuinely
 * bidirectional or whether the dashboard is coupling the two directions.
 *
 * It samples /api/stats at high frequency and records, per port, the IN and
 * OUT rates, then classifies each sample:
 *
 *   unidirectional    only one direction is significant   -> normal (speedtest)
 *   symmetric         IN and OUT are close               -> real bidirectional
 *   transit mirroring pA.in ~= pB.out and pA.out ~= pB.in for two ports
 *                                                         -> the same bytes cross
 *                                                            the switch: normal
 *
 * "Transit mirroring" is NOT a fault and does not mean port mirroring (SPAN) is
 * configured. A switch counts every packet twice: RX on the port that receives
 * it, TX on the port that forwards it. Two machines talking to each other look
 * exactly like this. Only a physical loop would be suspicious, and that shows up
 * as traffic on ports with nothing plugged in, or that never stops.
 *
 * Usage:
 *   node tools/capture-inout.js [seconds] [csv-path]
 *   node tools/capture-inout.js 60 | tee out.txt
 *   CAPTURE_THRESHOLD_BPS=1e6 node tools/capture-inout.js 30   # seuil bas
 *
 * Start it, then run the speedtest while it records.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.CAPTURE_BASE || 'http://127.0.0.1:3000';
const SECONDS = Number(process.argv[2]) || 60;
const CSV = process.argv[3] || path.join(process.cwd(), 'inout-capture.csv');
// Threshold above which a direction counts as "significant". Lower it to study
// background traffic, raise it to isolate a speedtest.
const HIGH = Number(process.env.CAPTURE_THRESHOLD_BPS || 20e6);

const pad = (s, n) => String(s).padStart(n);

(async () => {
  process.stdout.write(`Recording ${SECONDS}s from ${BASE}\nCSV: ${CSV}\n`);
  process.stdout.write('Start your speedtest now.\n\n');
  process.stdout.write('  time      port    IN bps     OUT bps   verdict\n');
  process.stdout.write('  ' + '-'.repeat(62) + '\n');

  const out = fs.createWriteStream(CSV, { flags: 'w' });
  out.write('t,port,in_bps,out_bps\n');
  const samples = [];
  const t0 = Date.now();
  let lastSampleAt = 0;

  while (Date.now() - t0 < SECONDS * 1000) {
    let d;
    try {
      d = await (await fetch(`${BASE}/api/stats`)).json();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!d || !d.ports) { await new Promise((r) => setTimeout(r, 500)); continue; }
    // The backend polls every few seconds, so several rapid requests return the
    // very same sample. Recording it repeatedly would skew the averages.
    if (d.lastUpdate === lastSampleAt) { await new Promise((r) => setTimeout(r, 120)); continue; }
    lastSampleAt = d.lastUpdate;

    const per = d.ports.map((p) => ({ port: p.port, i: p.inBps, o: p.outBps, link: p.link }));
    samples.push({ t: d.lastUpdate, per, g: { i: d.inBps, o: d.outBps } });

    for (const p of per) {
      if (Math.max(p.i, p.o) < HIGH) continue;
      const ratio = Math.max(p.i, p.o) > 0 ? Math.min(p.i, p.o) / Math.max(p.i, p.o) : 0;
      const verdict = ratio < 0.10 ? 'IN dominant'
        : ratio > 0.90 ? 'SYMMETRIC (both directions)'
          : 'mixed';
      process.stdout.write(`  ${new Date(d.lastUpdate).toISOString().slice(11, 19)}` +
        `  ${pad(p.port, 4)}  ${pad(p.i, 10)}  ${pad(p.o, 10)}   ${verdict}\n`);
      out.write(`${d.lastUpdate},${p.port},${p.i},${p.o}\n`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  out.end();

  // ---- verdict -------------------------------------------------------------
  console.log('\n================ VERDICT ================');
  const active = new Map();
  for (const s of samples) {
    for (const p of s.per) {
      if (Math.max(p.i, p.o) < HIGH) continue;
      const e = active.get(p.port) || { in: 0, out: 0, n: 0 };
      e.in += p.i; e.out += p.o; e.n++;
      active.set(p.port, e);
    }
  }
  if (active.size === 0) {
    console.log('No port exceeded the threshold (CAPTURE_THRESHOLD_BPS). Run the speedtest during the capture.');
  }

  const ports = [...active.keys()].sort((a, b) => a - b);
  for (const port of ports) {
    const e = active.get(port);
    const share = (e.in + e.out) > 0 ? e.out / (e.in + e.out) : 0;
    const flag = Math.abs(share - 0.5) < 0.10 ? '  <-- SYMMETRIC' : '';
    console.log(`  port ${pad(port, 2)}: avg IN ${pad(Math.round(e.in / e.n), 10)} | avg OUT ${pad(Math.round(e.out / e.n), 10)} | out-share ${(share * 100).toFixed(0)}%${flag}`);
  }

  // Loop detection: for two ports, A.in should match B.out.
  for (let x = 0; x < ports.length; x++) {
    for (let y = x + 1; y < ports.length; y++) {
      const A = samples.map((s) => s.per.find((p) => p.port === ports[x]) || { i: 0, o: 0 });
      const B = samples.map((s) => s.per.find((p) => p.port === ports[y]) || { i: 0, o: 0 });
      const rel = (a, b) => {
        let acc = 0, n = 0;
        for (let i = 0; i < a.length; i++) {
          const m = Math.max(a[i], b[i]);
          if (m > HIGH) { acc += Math.abs(a[i] - b[i]) / m; n++; }
        }
        return n ? acc / n : 1;
      };
      const cross1 = rel(A.map((p) => p.i), B.map((p) => p.o));
      const cross2 = rel(A.map((p) => p.o), B.map((p) => p.i));
      if (cross1 < 0.10 || cross2 < 0.10) {
        console.log(`\n  TRANSIT MIRRORING between port ${ports[x]} and port ${ports[y]}:`);
        console.log(`    ${ports[x]}.in ~= ${ports[y]}.out  (deviation ${(cross1 * 100).toFixed(1)}%)`);
        console.log(`    ${ports[x]}.out ~= ${ports[y]}.in  (deviation ${(cross2 * 100).toFixed(1)}%)`);
        console.log('    -> the same bytes are counted as IN on one port and OUT on the other.');
        console.log('    -> This is what a switch does with traffic passing through it, and');
        console.log('       what two machines talking to each other look like.');
        console.log('    -> Normal when no port mirroring (SPAN) is configured. It is only a');
        console.log('       physical loop if it happens on ports nothing is plugged into, or');
        console.log('       keeps running with every device powered off.');
      }
    }
  }

  // Unidirectional check: was there ever a moment where only one direction moved?
  let uni = 0, sym = 0;
  for (const s of samples) {
    const i = s.per.reduce((a, p) => a + p.i, 0);
    const o = s.per.reduce((a, p) => a + p.o, 0);
    if (Math.max(i, o) < HIGH) continue;
    const r = Math.min(i, o) / Math.max(i, o);
    if (r < 0.10) uni++;
    if (r > 0.90) sym++;
  }
  console.log(`\n  samples clearly unidirectional : ${uni}`);
  console.log(`  samples clearly symmetric      : ${sym}`);
  console.log('=====================================\n');
})();
