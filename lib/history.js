/**
 * Multi-resolution circular history, backed by typed arrays, persisted with an
 * append journal + periodic compaction.
 *
 * Design goals (in priority order):
 *   1. no disk read per HTTP request - snapshots are loaded once at startup;
 *   2. minimal disk writes - a flush appends only the buckets that changed
 *      since the previous flush (a few kB per minute), and the file is
 *      rewritten in full only when compaction is due;
 *   3. constant memory - every buffer is allocated once and never grows.
 *
 * Layout per port:
 *   raw   one point per sample (RAM only, never persisted: after a restart the
 *         finest persisted tier takes over),
 *   tiers bucketed by `res` seconds. Each bucket keeps sum/max/sample-count so
 *         a query can return avg AND peak without re-reading samples.
 *
 * File (one per device, `data/history/<id>.hst`):
 *   [ 'MSH1' | u16 version | u16 tierCount | f64 savedAt | tiers... ]  snapshot
 *   [ 'R' u8 | u16 port | u8 tier | i32 bucket | 4×f32 | u16 n ]        record
 * The snapshot is written atomically (tmp + rename); records are appended.
 * On load, parsing stops at the first malformed record (torn tail after a
 * crash), so a partially written batch never corrupts the rest.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import logger from './logger.js';

export const GLOBAL_PORT = 0;

const SNAPSHOT_MAGIC = 'MSH1';
const SNAPSHOT_VERSION = 1;
const RECORD_MAGIC = 0x52; // 'R'
const PORT_MAGIC = 0x50;   // 'P'
const RECORD_SIZE = 26;

const EMPTY = -1;

/* --------------------------------------------------------------------- raw */

/** One point per sample. RAM only. */
class RawRing {
  constructor(cap) {
    this.cap = cap;
    this.t = new Float64Array(cap);
    this.in = new Float32Array(cap);
    this.out = new Float32Array(cap);
    this.count = 0;
  }

  get size() { return Math.min(this.count, this.cap); }

  push(ts, inBps, outBps) {
    const idx = this.count % this.cap;
    this.t[idx] = ts;
    this.in[idx] = inBps;
    this.out[idx] = outBps;
    this.count++;
  }

  /** Absolute index -> physical slot (0 = oldest retained). */
  slot(abs) {
    const oldest = this.count - this.size;
    if (abs < oldest || abs >= this.count) return -1;
    return abs % this.cap;
  }

  oldestT() {
    if (this.size === 0) return Infinity;
    return this.t[(this.count - this.size) % this.cap];
  }

  newestT() {
    if (this.size === 0) return -Infinity;
    return this.t[(this.count - 1) % this.cap];
  }
}

/* -------------------------------------------------------------------- tier */

class Tier {
  constructor(res, cap) {
    this.res = res;
    this.resMs = res * 1000;
    this.cap = cap;
    this.bucket = new Int32Array(cap).fill(EMPTY);
    this.inSum = new Float32Array(cap);
    this.outSum = new Float32Array(cap);
    this.inMax = new Float32Array(cap);
    this.outMax = new Float32Array(cap);
    this.n = new Uint16Array(cap);
    this.openBucket = EMPTY;
    this.openIdx = -1;
    /** Bucket ids touched since the last flush, in write order (never repeats). */
    this.pending = [];
  }

  bucketOf(ts) { return Math.floor(ts / this.resMs); }

  push(ts, inBps, outBps) {
    const b = this.bucketOf(ts);
    let idx;
    if (b === this.openBucket) {
      idx = this.openIdx;
    } else {
      idx = b % this.cap;
      if (this.bucket[idx] !== b) {
        this.bucket[idx] = b;
        this.inSum[idx] = 0;
        this.outSum[idx] = 0;
        this.inMax[idx] = 0;
        this.outMax[idx] = 0;
        this.n[idx] = 0;
      }
      this.openBucket = b;
      this.openIdx = idx;
    }

    const cnt = this.n[idx] + 1;
    this.inSum[idx] += inBps;
    this.outSum[idx] += outBps;
    if (inBps > this.inMax[idx]) this.inMax[idx] = inBps;
    if (outBps > this.outMax[idx]) this.outMax[idx] = outBps;
    this.n[idx] = cnt;

    const pending = this.pending;
    if (pending[pending.length - 1] !== b) pending.push(b);
  }

  /** Values of one bucket, or null when the slot is empty/stale. */
  read(idx) {
    const b = this.bucket[idx];
    if (b === EMPTY) return null;
    const n = this.n[idx];
    if (n === 0) return null;
    return {
      bucket: b,
      inSum: this.inSum[idx],
      outSum: this.outSum[idx],
      inMax: this.inMax[idx],
      outMax: this.outMax[idx],
      n,
    };
  }

  /** Write one bucket record (used by the journal and by compaction). */
  encodeRecord(portId, idx, out) {
    const r = this.read(idx);
    if (!r) return 0;
    out.writeUInt8(RECORD_MAGIC, 0);
    out.writeUInt16LE(portId, 1);
    out.writeUInt8(this.tierIndex, 3);
    out.writeInt32LE(r.bucket, 4);
    out.writeFloatLE(r.inSum, 8);
    out.writeFloatLE(r.outSum, 12);
    out.writeFloatLE(r.inMax, 16);
    out.writeFloatLE(r.outMax, 20);
    out.writeUInt16LE(r.n, 24);
    return RECORD_SIZE;
  }

  applyRecord(r) {
    if (r.bucket < 0 || r.n === 0) return;
    const idx = r.bucket % this.cap;
    // Records arrive in chronological order; a replayed stale record must not
    // overwrite a newer bucket stored in the same slot.
    if (this.bucket[idx] > r.bucket) return;
    this.bucket[idx] = r.bucket;
    this.inSum[idx] = r.inSum;
    this.outSum[idx] = r.outSum;
    this.inMax[idx] = r.inMax;
    this.outMax[idx] = r.outMax;
    this.n[idx] = r.n;
    if (r.bucket >= this.openBucket) {
      this.openBucket = r.bucket;
      this.openIdx = idx;
    }
  }
}

/* ----------------------------------------------------------- port history */

class PortHistory {
  constructor(tierSpecs, rawPoints) {
    this.raw = new RawRing(rawPoints);
    this.tiers = tierSpecs.map((t, i) => {
      const tier = new Tier(t.res, t.cap);
      tier.tierIndex = i;
      return tier;
    });
  }

  push(ts, inBps, outBps) {
    this.raw.push(ts, inBps, outBps);
    for (const tier of this.tiers) tier.push(ts, inBps, outBps);
  }

  get pendingTiers() {
    const out = [];
    for (let i = 0; i < this.tiers.length; i++) {
      if (this.tiers[i].pending.length > 0) out.push(i);
    }
    return out;
  }
}

/* ------------------------------------------------------------ helpers */

function downsample(t, a, am, b, bm, maxPoints) {
  const count = t.length;
  if (count <= maxPoints) return null;
  const chunk = Math.ceil(count / maxPoints);
  const ot = [];
  const oa = [];
  const oam = [];
  const ob = [];
  const obm = [];
  for (let i = 0; i < count; i += chunk) {
    const end = Math.min(i + chunk, count);
    let sumA = 0;
    let sumB = 0;
    let maxA = 0;
    let maxB = 0;
    let n = 0;
    for (let k = i; k < end; k++) {
      sumA += a[k];
      sumB += b[k];
      if (am[k] > maxA) maxA = am[k];
      if (bm[k] > maxB) maxB = bm[k];
      n++;
    }
    ot.push(t[i]);
    oa.push(sumA / n);
    oam.push(maxA);
    ob.push(sumB / n);
    obm.push(maxB);
  }
  return { t: ot, in: oa, inMax: oam, out: ob, outMax: obm };
}

const EMPTY_SERIES = () => ({ t: [], in: [], inMax: [], out: [], outMax: [], points: 0, source: 'none' });

/* --------------------------------------------------------- device history */

export class DeviceHistory {
  /**
   * @param {string} id device id (also the file name stem)
   * @param {{tiers:Array<{res:number,cap:number}>, rawPoints:number, dir:string, persist:boolean}} opts
   */
  constructor(id, opts) {
    this.id = id;
    this.dir = opts.dir;
    this.tierSpecs = opts.tiers;
    this.rawPoints = opts.rawPoints;
    this.persist = opts.persist !== false;
    this.ports = new Map();       // portId -> PortHistory (created on demand)
    this.dirty = new Set();       // portId -> pending journal writes
    this.lastFlushAt = 0;
    this.lastCompactAt = 0;
    this.journalBytes = 0;
    this.io = { flushes: 0, bytesWritten: 0, compactions: 0, records: 0 };
    this.ensure(GLOBAL_PORT);
  }

  file() {
    const safe = this.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    return path.join(this.dir, `${safe}.hst`);
  }

  ensure(portId) {
    let p = this.ports.get(portId);
    if (!p) {
      p = new PortHistory(this.tierSpecs, this.rawPoints);
      this.ports.set(portId, p);
    }
    return p;
  }

  portIds() {
    return [...this.ports.keys()].filter((p) => p !== GLOBAL_PORT).sort((a, b) => a - b);
  }

  hasPort(portId) { return this.ports.has(portId); }

  /** Fold one sample into the raw ring and every tier of one port. */
  ingest(ts, portId, inBps, outBps) {
    const port = this.ensure(portId);
    port.push(ts, inBps, outBps);
    this.dirty.add(portId);
  }

  /* ------------------------------------------------------------- queries */

  /**
   * Pick the finest source that covers the requested window: raw when the
   * process has been up long enough, otherwise the first tier whose retention
   * is at least `to - from`.
   */
  pickTier(ph, from, to) {
    const span = Math.max(1000, to - from);
    let chosen = null;
    for (const tier of ph.tiers) {
      if (tier.cap * tier.resMs >= span) { chosen = tier; break; }
    }
    return chosen || ph.tiers[ph.tiers.length - 1];
  }

  query({ port = GLOBAL_PORT, from, to, maxPoints = config.history.maxPointsPerResponse }) {
    const ph = this.ports.get(port);
    if (!ph) return EMPTY_SERIES();

    const useRaw = ph.raw.size > 0 && ph.raw.oldestT() <= from;
    if (useRaw) return this.#queryRaw(ph, from, to, maxPoints);
    return this.#queryTier(ph, this.pickTier(ph, from, to), from, to, maxPoints);
  }

  #queryRaw(ph, from, to, maxPoints) {
    const raw = ph.raw;
    const t = [];
    const a = [];
    const b = [];
    const oldest = raw.count - raw.size;
    for (let i = oldest; i < raw.count; i++) {
      const ts = raw.t[i % raw.cap];
      if (ts < from) continue;
      if (ts >= to) break;
      t.push(Math.round(ts));
      a.push(raw.in[i % raw.cap]);
      b.push(raw.out[i % raw.cap]);
    }
    if (t.length === 0) return EMPTY_SERIES();
    const am = a.slice();
    const bm = b.slice();
    const ds = downsample(t, a, am, b, bm, maxPoints) || { t, in: a, inMax: am, out: b, outMax: bm };
    ds.source = 'raw';
    ds.points = ds.t.length;
    ds.from = from;
    ds.to = to;
    return ds;
  }

  #queryTier(ph, tier, from, to, maxPoints) {
    const first = Math.floor(from / tier.resMs);
    const last = Math.floor(to / tier.resMs);
    const t = [];
    const a = [];
    const am = [];
    const b = [];
    const bm = [];
    for (let bucket = first; bucket <= last; bucket++) {
      const idx = bucket % tier.cap;
      if (tier.bucket[idx] !== bucket) continue;
      const n = tier.n[idx];
      if (n === 0) continue;
      t.push(bucket * tier.resMs);
      a.push(tier.inSum[idx] / n);
      am.push(tier.inMax[idx]);
      b.push(tier.outSum[idx] / n);
      bm.push(tier.outMax[idx]);
    }
    if (t.length === 0) return EMPTY_SERIES();
    const ds = downsample(t, a, am, b, bm, maxPoints) || { t, in: a, inMax: am, out: b, outMax: bm };
    ds.source = `tier:${tier.res}`;
    ds.points = ds.t.length;
    ds.from = from;
    ds.to = to;
    return ds;
  }

  /** Aggregate over an already selected window (no disk, no re-scan of raw). */
  stats({ port = GLOBAL_PORT, from, to }) {
    const s = this.query({ port, from, to, maxPoints: config.history.maxPointsPerResponse });
    if (s.points === 0) return null;
    let inSum = 0;
    let outSum = 0;
    let inMax = 0;
    let outMax = 0;
    for (let i = 0; i < s.points; i++) {
      inSum += s.in[i];
      outSum += s.out[i];
      if (s.inMax[i] > inMax) inMax = s.inMax[i];
      if (s.outMax[i] > outMax) outMax = s.outMax[i];
    }
    return {
      samples: s.points,
      inAvg: inSum / s.points,
      inMax,
      outAvg: outSum / s.points,
      outMax,
      source: s.source,
    };
  }

  /** Peak IN/OUT per port over a window (peaks for every port table card). */
  peaks({ from, to }) {
    const out = [];
    for (const portId of this.portIds()) {
      const s = this.query({ port: portId, from, to, maxPoints: config.history.maxPointsPerResponse });
      if (s.points === 0) continue;
      let inMax = 0;
      let outMax = 0;
      for (let i = 0; i < s.points; i++) {
        if (s.inMax[i] > inMax) inMax = s.inMax[i];
        if (s.outMax[i] > outMax) outMax = s.outMax[i];
      }
      out.push({ port: portId, inMax, outMax });
    }
    return out;
  }

  /* ---------------------------------------------------------- persistence */

  /** Journal records for every bucket touched since the previous flush. */
  encodePending() {
    const chunks = [];
    for (const portId of this.dirty) {
      const ph = this.ports.get(portId);
      if (!ph) continue;
      let records = 0;
      for (const tierIdx of ph.pendingTiers) records += ph.tiers[tierIdx].pending.length;
      if (records === 0) continue;
      const buf = Buffer.alloc(records * RECORD_SIZE);
      let off = 0;
      for (const tierIdx of ph.pendingTiers) {
        const tier = ph.tiers[tierIdx];
        for (const bucket of tier.pending) {
          const idx = bucket % tier.cap;
          if (tier.bucket[idx] !== bucket) continue;
          off += tier.encodeRecord(portId, idx, buf.subarray(off, off + RECORD_SIZE));
        }
        tier.pending.length = 0;
      }
      if (off > 0) chunks.push(buf.subarray(0, off));
    }
    this.dirty.clear();
    return chunks.length ? Buffer.concat(chunks) : null;
  }

  /** Full snapshot: every retained bucket of every port. */
  encodeSnapshot() {
    const tierCount = this.tierSpecs.length;
    const head = Buffer.alloc(4 + 2 + 2 + 8 + tierCount * 8);
    head.write(SNAPSHOT_MAGIC, 0, 'ascii');
    head.writeUInt16LE(SNAPSHOT_VERSION, 4);
    head.writeUInt16LE(tierCount, 6);
    head.writeDoubleLE(Date.now(), 8);
    let off = 16;
    for (const spec of this.tierSpecs) {
      head.writeUInt32LE(spec.res, off);
      head.writeUInt32LE(spec.cap, off + 4);
      off += 8;
    }

    const chunks = [head];
    const rec = Buffer.alloc(RECORD_SIZE);
    for (const [portId, ph] of this.ports) {
      let count = 0;
      for (const tier of ph.tiers) {
        for (let i = 0; i < tier.cap; i++) if (tier.bucket[i] !== EMPTY && tier.n[i] > 0) count++;
      }
      if (count === 0) continue;
      const portHead = Buffer.alloc(5);
      portHead.writeUInt8(PORT_MAGIC, 0);
      portHead.writeUInt16LE(portId, 1);
      portHead.writeUInt16LE(count, 3);
      chunks.push(portHead);
      for (let tierIdx = 0; tierIdx < ph.tiers.length; tierIdx++) {
        const tier = ph.tiers[tierIdx];
        for (let i = 0; i < tier.cap; i++) {
          if (tier.bucket[i] === EMPTY || tier.n[i] === 0) continue;
          const written = tier.encodeRecord(portId, i, rec);
          if (written) chunks.push(Buffer.from(rec.subarray(0, written)));
        }
      }
    }
    return Buffer.concat(chunks);
  }

  /**
   * Parse a snapshot/journal buffer into memory.
   * @returns {number} bytes consumed, or -1 when the file must be ignored
   */
  loadFrom(buf) {
    let off = 0;

    if (buf.length >= 16 && buf.toString('ascii', 0, 4) === SNAPSHOT_MAGIC) {
      const version = buf.readUInt16LE(4);
      if (version !== SNAPSHOT_VERSION) {
        logger.warn(`history ${this.id}: unsupported snapshot version ${version}, ignoring`);
        return -1;
      }
      const tierCount = buf.readUInt16LE(6);
      off = 16 + tierCount * 8;
    }

    let records = 0;
    let pendingPort = -1;
    let pendingCount = 0;
    while (off + RECORD_SIZE <= buf.length) {
      const tag = buf[off];

      if (tag === PORT_MAGIC) {
        if (off + 5 + RECORD_SIZE > buf.length) break;
        pendingPort = buf.readUInt16LE(off + 1);
        pendingCount = buf.readUInt16LE(off + 3);
        off += 5;
        continue;
      }

      if (tag !== RECORD_MAGIC) break;
      const portId = pendingCount > 0 ? pendingPort : buf.readUInt16LE(off + 1);
      const tierIdx = buf.readUInt8(off + 3);
      if (tierIdx >= this.tierSpecs.length) break;
      const r = {
        bucket: buf.readInt32LE(off + 4),
        inSum: buf.readFloatLE(off + 8),
        outSum: buf.readFloatLE(off + 12),
        inMax: buf.readFloatLE(off + 16),
        outMax: buf.readFloatLE(off + 20),
        n: buf.readUInt16LE(off + 24),
      };
      if (!Number.isFinite(r.inSum) || !Number.isFinite(r.outSum) || r.n === 0) break;
      const ph = this.ensure(portId);
      ph.tiers[tierIdx].applyRecord(r);
      off += RECORD_SIZE;
      records++;
      if (pendingCount > 0) {
        pendingCount--;
        if (pendingCount === 0) pendingPort = -1;
      }
    }
    this.io.records += records;
    return off;
  }

  load() {
    if (!this.persist) return false;
    const file = this.file();
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return false;
    }
    if (buf.length === 0) return false;
    const consumed = this.loadFrom(buf);
    if (consumed < 0) return false;
    if (consumed < buf.length) {
      // Torn tail (crash during append): drop it so the next append is clean.
      try { fs.truncateSync(file, consumed); } catch { /* best effort */ }
    }
    this.journalBytes = consumed;
    logger.debug(`history ${this.id}: loaded ${consumed} bytes`);
    this.lastCompactAt = Date.now();
    return true;
  }

  /** Append changed buckets. Returns bytes written (0 = nothing changed). */
  flush() {
    if (!this.persist || this.dirty.size === 0) return 0;
    const buf = this.encodePending();
    if (!buf || buf.length === 0) return 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file(), buf, { mode: 0o600 });
      this.journalBytes += buf.length;
      this.io.flushes++;
      this.io.bytesWritten += buf.length;
      this.lastFlushAt = Date.now();
      return buf.length;
    } catch (err) {
      logger.throttleError(`history.${this.id}`, `history flush failed: ${err.message}`, 300000);
      return 0;
    }
  }

  /** Rewrite the file as one compact snapshot (atomic), then start appending. */
  compact() {
    if (!this.persist) return 0;
    const buf = this.encodeSnapshot();
    const file = this.file();
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.renameSync(tmp, file);
      this.journalBytes = buf.length;
      this.io.compactions++;
      this.io.bytesWritten += buf.length;
      this.lastCompactAt = Date.now();
      this.lastFlushAt = Date.now();
      return buf.length;
    } catch (err) {
      logger.throttleError(`history.${this.id}`, `history compaction failed: ${err.message}`, 3600000);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return 0;
    }
  }

  removeFile() {
    try { fs.unlinkSync(this.file()); } catch { /* absent is fine */ }
  }
}

/* ------------------------------------------------------------ store */

export class HistoryStore {
  constructor(dir = config.history.dir) {
    this.dir = dir;
    this.devices = new Map();
    this.flushTimer = null;
    this.compactTimer = null;
    this.stats = { flushes: 0, bytesWritten: 0, compactions: 0, loads: 0 };
    this.lastFlushAt = 0;
  }

  device(id, opts = {}) {
    let d = this.devices.get(id);
    if (!d) {
      d = new DeviceHistory(id, {
        dir: this.dir,
        tiers: config.history.tiers,
        rawPoints: config.history.rawPoints,
        persist: opts.persist !== false,
        ...opts,
      });
      this.devices.set(id, d);
    }
    return d;
  }

  has(id) { return this.devices.has(id); }

  remove(id) {
    const d = this.devices.get(id);
    if (!d) return;
    d.removeFile();
    this.devices.delete(id);
  }

  /** Load every persisted device once, at startup. */
  loadAll() {
    let files = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.hst')) continue;
        const id = name.slice(0, -4).replace(/[^A-Za-z0-9_-]/g, '_');
        const d = this.device(id);
        if (d.load()) files++;
      }
    } catch (err) {
      logger.warn(`history load failed: ${err.message}`);
    }
    this.stats.loads = files;
    return files;
  }

  /**
   * Batched flush: only devices with changed buckets are written, each append
   * being a single syscall. Returns bytes written.
   */
  flushAll() {
    let bytes = 0;
    let files = 0;
    for (const d of this.devices.values()) {
      if (d.dirty.size === 0) continue;
      const written = d.flush();
      if (written > 0) { bytes += written; files++; }
    }
    if (files > 0) {
      this.stats.flushes++;
      this.stats.bytesWritten += bytes;
      this.lastFlushAt = Date.now();
    }
    return bytes;
  }

  /** Compaction is due when a journal grows past its snapshot or age limit. */
  compactDue(maxAgeMs = 12 * 3600e3, maxJournalBytes = 4 * 1024 * 1024) {
    const now = Date.now();
    let bytes = 0;
    for (const d of this.devices.values()) {
      if (!d.persist) continue;
      const old = now - d.lastCompactAt > maxAgeMs;
      const big = d.journalBytes > maxJournalBytes;
      if (old || big) bytes += d.compact();
    }
    if (bytes > 0) this.stats.compactions++;
    return bytes;
  }

  startTimers() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flushAll();
      this.compactDue();
    }, config.history.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stopTimers() {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.compactTimer) { clearTimeout(this.compactTimer); this.compactTimer = null; }
  }

  /** Final, clean write at shutdown (SIGTERM). */
  close() {
    this.stopTimers();
    let bytes = 0;
    for (const d of this.devices.values()) {
      if (d.dirty.size > 0) bytes += d.flush();
    }
    return bytes;
  }

  health() {
    let devices = 0;
    let ports = 0;
    let buckets = 0;
    let bytes = 0;
    for (const d of this.devices.values()) {
      devices++;
      ports += d.ports.size;
      for (const ph of d.ports.values()) {
        for (const tier of ph.tiers) {
          for (let i = 0; i < tier.cap; i++) if (tier.bucket[i] !== EMPTY) buckets++;
        }
      }
      try { bytes += fs.statSync(d.file()).size; } catch { /* not persisted yet */ }
    }
    return {
      devices,
      ports,
      buckets,
      bytes,
      flushes: this.stats.flushes,
      bytesWritten: this.stats.bytesWritten,
      compactions: this.stats.compactions,
      lastFlushAt: this.lastFlushAt,
    };
  }
}

export { Tier, PortHistory, RawRing };
