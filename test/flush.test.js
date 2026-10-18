/**
 * Regression: history queries must see the newest (not yet flushed) samples and
 * must NOT double count once those buckets have been committed.
 */
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const DB = path.join(os.tmpdir(), 'mikrostats-flush-invariance.db');
for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(DB + s); } catch { /* fresh */ }
process.env.DB_FILE = DB;
process.env.LOG_DIR = path.join(os.tmpdir(), 'mikrostats-test-logs');
const fs = require('fs');
const { Store } = require(ROOT + '/lib/store');

const store = new Store().open();
const now = Date.now();
const N = 600;
for (let i = 0; i < N; i++) store.ingest(now - i * 5000, 0, 1000 + (i % 5) * 200, 400);

const q = { port: 0, from: now - 2 * 3600e3, to: now + 1000 };

// 1. Before any flush: the query must already return the data.
const before = store.query(q);
console.log(`  avant flush : points=${before.points}  inMax=${Math.round(before.inMax.reduce((a, b) => Math.max(a, b), 0))}`);

// 2. Flush, then query again: the result must be identical, not doubled.
store.flush(true);
const after = store.query(q);
const peakBefore = Math.round(before.inMax.reduce((a, b) => Math.max(a, b), 0));
const peakAfter = Math.round(after.inMax.reduce((a, b) => Math.max(a, b), 0));
console.log(`  apres flush : points=${after.points}  inMax=${peakAfter}`);

const ok = [
  ['unflushed data is visible', before.points > 10, `${before.points} points before any flush`],
  ['flush does not change the result', before.points === after.points && peakBefore === peakAfter,
    `${before.points}/${peakBefore} -> ${after.points}/${peakAfter}`],
  ['no double counting of samples', peakAfter < 5000, `inMax=${peakAfter} (doubling would exceed it)`],
];
let fail = 0;
for (const [name, pass, detail] of ok) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!pass) fail++;
}
store.close();
process.exit(fail ? 1 : 0);
