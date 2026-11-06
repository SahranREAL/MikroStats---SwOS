/**
 * History store: multi-resolution tiers, atomic persistence, and the
 * "never write when nothing changed" guarantee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrostats-history-'));
process.env.DATA_DIR = TMP;
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.LOG_TARGET = 'stdout';
process.env.LOG_LEVEL = 'error';

const { HistoryStore, DeviceHistory, GLOBAL_PORT } = await import(path.join(ROOT, 'lib/history.js'));

const NOW = 1700000000000; // fixed, aligned to every tier boundary
const DAY = 86400e3;

function freshStore(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return new HistoryStore(dir);
}

/* ------------------------------------------------------------------ tiers */

test('raw ring holds one point per sample and never grows', () => {
  const s = freshStore('raw');
  const d = s.device('dev');
  for (let i = 0; i < 5000; i++) d.ingest(NOW - (5000 - i) * 3000, GLOBAL_PORT, i, i * 2);
  const q = d.query({ from: NOW - 10 * 60e3, to: NOW + 1, maxPoints: 10000 });
  assert.ok(q.points <= 900, `raw cap exceeded: ${q.points}`);
  assert.equal(q.source, 'raw');
  // chronological and monotonic timestamps
  for (let i = 1; i < q.t.length; i++) assert.ok(q.t[i] > q.t[i - 1]);
});

test('tiered aggregation preserves avg and peak', () => {
  const s = freshStore('tiers');
  const d = s.device('dev');
  // Six hours in the past so the RAM-only raw ring cannot cover the window.
  const t0 = Math.floor((NOW - 6 * 3600e3) / 10000) * 10000;
  for (let i = 0; i < 6; i++) d.ingest(t0 + i * 100, GLOBAL_PORT, i === 5 ? 1000 : 100, 10);
  const q = d.query({ from: t0 - 30 * 60e3, to: t0 + 10000, maxPoints: 100 });
  assert.ok(q.source.startsWith('tier:'), `source=${q.source}`);
  const idx = q.t.indexOf(t0);
  assert.ok(idx >= 0, `bucket ${t0} missing from ${JSON.stringify(q.t)}`);
  assert.equal(q.inMax[idx], 1000);
  assert.ok(Math.abs(q.in[idx] - 250) < 1, `avg ${q.in[idx]}`);
});

test('query picks the finest tier that covers the window', () => {
  const s = freshStore('pick');
  const d = s.device('dev');
  // 6 days of hourly samples -> only the 300s / 1800s tiers can hold them
  for (let i = 0; i < 6 * 24; i++) d.ingest(NOW - i * 3600e3, GLOBAL_PORT, 100, 1);
  const q = d.query({ from: NOW - 5 * DAY, to: NOW + 1, maxPoints: 500 });
  assert.ok(q.points > 10, `points=${q.points}`);
  assert.ok(q.source.startsWith('tier:'), `source=${q.source}`);
  // peaks survive
  assert.ok(q.inMax.reduce((a, b) => Math.max(a, b), 0) >= 100);
});

test('query downsamples and never exceeds maxPoints', () => {
  const s = freshStore('down');
  const d = s.device('dev');
  for (let i = 0; i < 1440; i++) d.ingest(NOW - i * 5000, GLOBAL_PORT, 1000 + (i % 7) * 100, 500);
  const out = d.query({ from: NOW - 2 * 3600e3, to: NOW + 1, maxPoints: 100 });
  assert.ok(out.points <= 100, `points=${out.points}`);
  assert.ok(out.points > 10, `points=${out.points}`);
  assert.equal(out.inMax.length, out.in.length);
  assert.equal(out.outMax.length, out.out.length);
  // Tier buckets are floor-aligned, so the first one may start just before `from`.
  assert.ok(out.t[0] >= NOW - 2 * 3600e3 - 60000, `t0=${out.t[0]}`);
  assert.ok(out.inMax.reduce((a, b) => Math.max(a, b), 0) >= 1600, 'peak lost');
  for (let i = 1; i < out.t.length; i++) assert.ok(out.t[i] > out.t[i - 1]);
});

test('stats and peaks agree with the series', () => {
  const s = freshStore('stats');
  const d = s.device('dev');
  for (let i = 0; i < 300; i++) {
    d.ingest(NOW - i * 1000, GLOBAL_PORT, 1000, 500);
    d.ingest(NOW - i * 1000, 5, 7000, 3000);
  }
  const st = d.stats({ from: NOW - 300e3, to: NOW + 1 });
  assert.ok(st.samples > 10);
  assert.ok(Math.abs(st.inAvg - 1000) < 1, `avg ${st.inAvg}`);
  assert.equal(st.inMax, 1000);

  const peaks = d.peaks({ from: NOW - 300e3, to: NOW + 1 });
  const p5 = peaks.find((p) => p.port === 5);
  assert.ok(p5, 'port 5 peak missing');
  assert.equal(p5.inMax, 7000);
  assert.equal(p5.outMax, 3000);
});

/* ------------------------------------------------------------ persistence */

test('flush writes atomically and a second flush writes nothing', () => {
  const s = freshStore('flush');
  const d = s.device('dev');
  for (let i = 0; i < 120; i++) d.ingest(NOW - i * 1000, GLOBAL_PORT, 100, 10);

  // No file before the first flush.
  assert.equal(fs.existsSync(d.file()), false);

  const bytes1 = s.flushAll();
  assert.ok(bytes1 > 0, 'first flush must write');
  assert.ok(fs.existsSync(d.file()));
  const size1 = fs.statSync(d.file()).size;
  assert.ok(size1 > 0);

  // Nothing changed -> zero bytes, file untouched.
  const mtime1 = fs.statSync(d.file()).mtimeMs;
  const bytes2 = s.flushAll();
  assert.equal(bytes2, 0, 'no change must mean no write');
  assert.equal(fs.statSync(d.file()).mtimeMs, mtime1, 'file must not be rewritten');

  // New samples -> only the new buckets are appended.
  for (let i = 0; i < 120; i++) d.ingest(NOW + 3600e3 + i * 1000, GLOBAL_PORT, 200, 20);
  const bytes3 = s.flushAll();
  assert.ok(bytes3 > 0, 'changed buckets must be written');
  assert.ok(bytes3 <= bytes1, `incremental ${bytes3} must not exceed the initial ${bytes1}`);
});

test('history survives a restart with identical data', () => {
  const dir = path.join(TMP, 'reload');
  fs.mkdirSync(dir, { recursive: true });

  const s1 = new HistoryStore(dir);
  const d1 = s1.device('dev');
  for (let i = 0; i < 300; i++) d1.ingest(NOW - i * 1000, GLOBAL_PORT, 1000 + i, 500);
  d1.ingest(NOW - 500, 7, 4242, 2424);
  s1.close();

  const s2 = new HistoryStore(dir);
  const files = s2.loadAll();
  assert.equal(files, 1, 'one history file expected');
  const d2 = s2.device('dev');
  assert.ok(d2.hasPort(7), 'per-port history must be restored');
  const q = d2.query({ from: NOW - 300e3, to: NOW + 1, maxPoints: 500 });
  assert.ok(q.points > 25, `points=${q.points}`);
  const qp = d2.query({ port: 7, from: NOW - 300e3, to: NOW + 1, maxPoints: 500 });
  assert.ok(qp.points > 0, 'port 7 series missing after reload');
  assert.equal(qp.inMax.reduce((a, b) => Math.max(a, b), 0), 4242);
});

test('a torn journal tail is truncated on load, valid records survive', () => {
  const dir = path.join(TMP, 'torn');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'dev';

  const s1 = new HistoryStore(dir);
  const d1 = s1.device(id);
  for (let i = 0; i < 300; i++) d1.ingest(NOW - i * 1000, GLOBAL_PORT, 1000, 500);
  s1.flushAll();

  // Simulate a crash in the middle of an append: half a record at the end.
  const f = path.join(dir, `${id}.hst`);
  const before = fs.statSync(f).size;
  fs.appendFileSync(f, Buffer.alloc(13, 0xab));
  assert.equal(fs.statSync(f).size, before + 13);

  const s2 = new HistoryStore(dir);
  assert.equal(s2.loadAll(), 1);
  const d2 = s2.device(id);
  const q = d2.query({ from: NOW - 300e3, to: NOW + 1, maxPoints: 500 });
  assert.ok(q.points > 25, `records lost by the torn tail: ${q.points}`);

  // And the store is writable again after the repair.
  for (let i = 0; i < 30; i++) d2.ingest(NOW + 60000 + i * 1000, GLOBAL_PORT, 300, 300);
  assert.ok(s2.flushAll() > 0);
  const s3 = new HistoryStore(dir);
  assert.equal(s3.loadAll(), 1);
});

test('compaction shrinks the journal and keeps the data', () => {
  const dir = path.join(TMP, 'compact');
  fs.mkdirSync(dir, { recursive: true });
  const s1 = new HistoryStore(dir);
  const d1 = s1.device('dev');
  // Many buckets touched over and over -> the journal grows with each flush.
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 20; i++) d1.ingest(NOW + round * 10000 + i * 500, GLOBAL_PORT, 100 + round, 10);
    s1.flushAll();
  }
  const f = path.join(dir, 'dev.hst');
  const journalSize = fs.statSync(f).size;

  const written = d1.compact();
  assert.ok(written > 0, 'compaction must rewrite the snapshot');
  const compactSize = fs.statSync(f).size;
  assert.ok(compactSize < journalSize, `${compactSize} !< ${journalSize}`);

  const s2 = new HistoryStore(dir);
  s2.loadAll();
  const q = s2.device('dev').query({ from: NOW, to: NOW + 600e3, maxPoints: 500 });
  assert.ok(q.points > 20, `data lost during compaction: ${q.points}`);
});

test('history files are created with 0600 permissions', () => {
  const s = freshStore('perm');
  const d = s.device('dev');
  d.ingest(NOW, GLOBAL_PORT, 1, 1);
  s.flushAll();
  const mode = fs.statSync(d.file()).mode & 0o777;
  assert.equal(mode, 0o600, `mode=${mode.toString(8)}`);
});

test('device ids are sanitised into safe file names', () => {
  const s = freshStore('safe');
  const d = s.device('../../etc/passwd');
  d.ingest(NOW, GLOBAL_PORT, 1, 1);
  s.flushAll();
  const name = path.basename(d.file());
  assert.ok(!name.includes('..') && !name.includes('/'), `unsafe name: ${name}`);
  assert.ok(fs.existsSync(d.file()));
});
