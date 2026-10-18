
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), 'mikrostats-retention.db');

process.env.DB_FILE = TMP_DB;
process.env.LOG_DIR = path.join(os.tmpdir(), 'mikrostats-test-logs');
const fs = require('fs');
for (const s of ['', '-wal', '-shm']) try { fs.unlinkSync(TMP_DB + s); } catch {}
const { Store } = require(ROOT + '/lib/store');
const config = require(ROOT + '/config');
const DB = require('better-sqlite3');

const now = Date.now();
const DAY = 86400e3;
const store = new Store().open();

// A wide spread so every tier window is exercised:
//  - 60 days of hourly data (lands in the 300s tier)
//  - 5 days of 5-minute data
//  - 3 hours of 5-second data
const H = 3600e3;
store.ingest(now, 0, 10, 1);
for (let i = 1; i <= 60 * 24; i++) store.ingest(now - i * H, 0, 100, 1);
for (let i = 1; i <= 5 * 24 * 12; i++) store.ingest(now - i * 5 * 60e3, 0, 200, 2);
for (let i = 1; i <= 200; i++) store.ingest(now - 3 * H + i * 1000, 0, 300, 5);
store.flush(true);

const q = () => {
  const d = new DB(TMP_DB, { readonly: true });
  const r = d.prepare('select count(*) c, min(ts) mn, max(ts) mx from samples').get();
  const per = d.prepare('select res, count(*) c, min(ts) mn, max(ts) mx from samples group by res order by res').all();
  d.close();
  return { ...r, per };
};

const before = q();
console.log('tiers (res s / keep):', config.store.tiers.map((t) => `${t.res}s/${(t.keep / DAY).toFixed(0)}d`).join('  '));
console.log(`before: rows=${before.c} oldest=${((now - before.mn) / DAY).toFixed(2)}d`);
for (const p of before.per) console.log(`   res=${p.res}s rows=${p.c} oldest=${((now - p.mn) / DAY).toFixed(2)}d`);

store.maintenance();

const after = q();
console.log(`after:  rows=${after.c} oldest=${((now - after.mn) / DAY).toFixed(2)}d`);
for (const p of after.per) console.log(`   res=${p.res}s rows=${p.c} oldest=${((now - p.mn) / DAY).toFixed(2)}d`);

const maxKeepDays = Math.max(...config.store.tiers.map((t) => t.keep / DAY));
const ageDays = (now - after.mn) / DAY;
const checks = [
  ['purged old rows', after.c < before.c, `${before.c} -> ${after.c}`],
  ['oldest row within max retention', ageDays <= maxKeepDays + 0.01, `${ageDays.toFixed(2)}d <= ${maxKeepDays}d`],
  ['5s tier only holds ~2h', after.per.filter((p) => p.res === 5).every((p) => (now - p.mn) / H <= 2.1), '5s window'],
  ['30s tier only holds ~3d', after.per.filter((p) => p.res === 30).every((p) => (now - p.mn) / DAY <= 3.1), '30s window'],
  ['300s tier only holds ~30d', after.per.filter((p) => p.res === 300).every((p) => (now - p.mn) / DAY <= 30.1), '300s window'],
  ['recent data survived', (now - after.mx) / 1000 < 120, `newest row is ${((now - after.mx) / 1000).toFixed(0)}s old`],
];
let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!pass) ok = false;
}
store.close();
process.exit(ok ? 0 : 1);
