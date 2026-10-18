'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('./logger');

const GLOBAL_PORT = 0; // synthetic port id holding the switch-wide aggregate

/**
 * History store.
 *
 * Writing a row per port per poll would mean thousands of writes per minute on
 * a device with no business doing that. Instead every raw sample is folded into
 * time buckets in memory, and only *closed* buckets are written to disk, in a
 * single transaction per flush (§12/§14).
 *
 *   raw sample (3s)  ->  open bucket (RAM)
 *   every 60s        ->  one transaction, closed buckets only
 *   every 6h         ->  retention purge + WAL checkpoint
 */
class Store {
  constructor() {
    this.db = null;
    this.ready = false;
    this.lastError = null;
    this.tiers = config.store.tiers.map((t) => ({ ...t, resMs: t.res * 1000 }));
    this.flushIntervalMs = config.store.flushIntervalMs;
    this.buckets = new Map(); // "res:ts:port" -> partial aggregate
    this.flushTimer = null;
    this.maintTimer = null;
    this.stats = { flushes: 0, rowsWritten: 0, purges: 0, errors: 0, lastFlushAt: 0, lastFlushRows: 0 };
  }

  open() {
    const file = config.store.dbFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    // Durability vs. I/O: WAL + NORMAL is crash-safe against process death
    // (the realistic failure mode) and avoids an fsync on every commit.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -2000');        // ~2 MB page cache
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 0');              // mmap on SD cards is a liability
    db.pragma('wal_autocheckpoint = 512');
    db.pragma(`journal_size_limit = ${1024 * 1024}`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        res      INTEGER NOT NULL,
        ts       INTEGER NOT NULL,
        port     INTEGER NOT NULL,
        n        INTEGER NOT NULL DEFAULT 1,
        in_avg   REAL    NOT NULL DEFAULT 0,
        in_max   REAL    NOT NULL DEFAULT 0,
        out_avg  REAL    NOT NULL DEFAULT 0,
        out_max  REAL    NOT NULL DEFAULT 0,
        PRIMARY KEY (res, ts, port)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_samples_port ON samples (port, res, ts);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema', '1');
    this.db = db;
    this.ready = true;
    this.lastError = null;
    logger.info('store opened', file);
    return this;
  }

  close() {
    this.stopTimers();
    if (this.db) {
      try { this.flush(true); } catch (err) { logger.warn('final flush failed:', err.message); }
      try { this.db.close(); } catch { /* already closed */ }
    }
    this.db = null;
    this.ready = false;
    this.buckets.clear();
  }

  startTimers() {
    if (!this.ready || this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
    // Delay the first purge so startup stays cheap.
    this.maintTimer = setTimeout(() => this.maintenance(), 30000);
    if (this.maintTimer.unref) this.maintTimer.unref();
  }

  stopTimers() {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.maintTimer) { clearTimeout(this.maintTimer); this.maintTimer = null; }
  }

  /* ------------------------------------------------------------------ ingest */

  /**
   * Fold one raw sample into every open bucket. Allocation-free in steady state.
   * @param {number} ts epoch ms
   * @param {number} portId 0 = global, 1..N = physical port
   * @param {number} inBps
   * @param {number} outBps
   */
  ingest(ts, portId, inBps, outBps) {
    if (!this.ready) return;
    const inSafe = Number.isFinite(inBps) && inBps > 0 ? inBps : 0;
    const outSafe = Number.isFinite(outBps) && outBps > 0 ? outBps : 0;
    for (const tier of this.tiers) {
      const bucketTs = Math.floor(ts / tier.resMs) * tier.resMs;
      const key = `${tier.res}:${bucketTs}:${portId}`;
      let b = this.buckets.get(key);
      if (b === undefined) {
        // Bound the map: a stuck timer or clock jump must not leak memory.
        if (this.buckets.size > 4096) this.evictOldest(tier.resMs);
        b = { res: tier.res, ts: bucketTs, port: portId, n: 0, inSum: 0, inMax: 0, outSum: 0, outMax: 0 };
        this.buckets.set(key, b);
      }
      b.n += 1;
      b.inSum += inSafe;
      b.outSum += outSafe;
      if (inSafe > b.inMax) b.inMax = inSafe;
      if (outSafe > b.outMax) b.outMax = outSafe;
    }
  }

  evictOldest(resMs) {
    const cutoff = Date.now() - resMs * 2;
    for (const [key, b] of this.buckets) {
      if (b.ts < cutoff) this.buckets.delete(key);
    }
    // Still oversized (pathological): drop everything, we are only losing detail.
    if (this.buckets.size > 4096) this.buckets.clear();
  }

  /** Write every closed bucket in one transaction. */
  flush(force = false) {
    if (!this.ready || !this.db) return 0;
    const now = Date.now();
    const closed = [];
    const stillOpen = new Map();
    for (const [key, b] of this.buckets) {
      if (force || b.ts + b.res * 1000 <= now) closed.push(b);
      else stillOpen.set(key, b);
    }
    if (closed.length === 0) {
      this.buckets = stillOpen;
      return 0;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO samples (res, ts, port, n, in_avg, in_max, out_avg, out_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const run = this.db.transaction((rows) => {
      for (const b of rows) {
        const n = b.n > 0 ? b.n : 1;
        stmt.run(b.res, b.ts, b.port, n, b.inSum / n, b.inMax, b.outSum / n, b.outMax);
      }
    });

    try {
      run(closed);
      this.buckets = stillOpen;
      this.stats.flushes++;
      this.stats.rowsWritten += closed.length;
      this.stats.lastFlushAt = now;
      this.stats.lastFlushRows = closed.length;
      this.lastError = null;
      return closed.length;
    } catch (err) {
      // Keep the buckets in RAM: a later flush may succeed.
      this.stats.errors++;
      this.lastError = err.message;
      logger.throttleError('store.flush', `history flush failed: ${err.message}`, 300000);
      return 0;
    }
  }

  /* ------------------------------------------------------------------- query */

  /** Finest tier whose retention covers the requested window. */
  tierFor(rangeMs) {
    for (const tier of this.tiers) {
      if (tier.keep >= rangeMs) return tier;
    }
    return this.tiers[this.tiers.length - 1];
  }

  /**
   * History for a port (0 = global) over [from, to], downsampled server-side to
   * at most maxPoints buckets while preserving min/avg/max so peaks survive.
   */
  query({ port = GLOBAL_PORT, from, to, maxPoints = config.store.maxPointsPerResponse }) {
    const range = Math.max(1000, to - from);
    const tier = this.tierFor(range);
    const raw = this.queryRaw({ port, from, to, res: tier.res });

    // window >= tier size, so at least one stored row maps to one output point.
    const window = Math.max(tier.resMs, Math.ceil(range / Math.max(1, maxPoints)));
    const slots = Math.min(maxPoints, Math.ceil(range / window) + 1);

    const t = new Array(slots);
    const inAvg = new Array(slots);
    const inMax = new Array(slots);
    const outAvg = new Array(slots);
    const outMax = new Array(slots);

    const acc = new Array(slots);
    for (let i = 0; i < slots; i++) acc[i] = { n: 0, iS: 0, iM: 0, oS: 0, oM: 0 };

    for (const r of raw) {
      let idx = Math.floor((r.ts - from) / window);
      if (idx < 0) idx = 0;
      if (idx >= slots) idx = slots - 1;
      const a = acc[idx];
      a.n += r.n;
      a.iS += r.in_avg * r.n;
      a.iM = Math.max(a.iM, r.in_max);
      a.oS += r.out_avg * r.n;
      a.oM = Math.max(a.oM, r.out_max);
    }

    let count = 0;
    for (let i = 0; i < slots; i++) {
      const a = acc[i];
      if (a.n === 0) continue;
      const n = a.n;
      t[count] = from + i * window;
      inAvg[count] = a.iS / n;
      inMax[count] = a.iM;
      outAvg[count] = a.oS / n;
      outMax[count] = a.oM;
      count++;
    }

    return {
      from,
      to,
      res: tier.res,
      windowMs: window,
      points: count,
      t: t.slice(0, count),
      in: inAvg.slice(0, count),
      inMax: inMax.slice(0, count),
      out: outAvg.slice(0, count),
      outMax: outMax.slice(0, count),
      truncated: count >= maxPoints,
    };
  }

  /**
   * Raw per-res rows for a port and time range.
   *
   * SQLite only, PLUS the buckets still buffered in memory. `flush()` removes a
   * bucket from the map once it is committed, so a buffered bucket is by
   * definition absent from the table: merging cannot double count. Without this
   * the newest samples (up to one flush interval) would be missing from every
   * history view, and the right edge of the graph would stall.
   */
  queryRaw({ port, from, to, res }) {
    const rows = [];
    if (this.ready) {
      try {
        rows.push(...this.db.prepare(`
          SELECT ts, n, in_avg, in_max, out_avg, out_max
          FROM samples
          WHERE res = ? AND port = ? AND ts >= ? AND ts < ?
          ORDER BY ts ASC
        `).all(res, port, from, to));
      } catch (err) {
        this.lastError = err.message;
        logger.throttleError('store.query', `history query failed: ${err.message}`, 300000);
      }
    }
    for (const b of this.buckets.values()) {
      if (b.res !== res || b.port !== port) continue;
      if (b.ts < from || b.ts >= to) continue;
      const n = b.n > 0 ? b.n : 1;
      rows.push({ ts: b.ts, n, in_avg: b.inSum / n, in_max: b.inMax, out_avg: b.outSum / n, out_max: b.outMax });
    }
    // Callers expect exactly one row per timestamp. `flush()` removes a bucket
    // once committed, so a same-timestamp pair should not happen, but coalescing
    // keeps the invariant true even if a bucket is replayed.
    rows.sort((a, b) => a.ts - b.ts);
    const merged = [];
    for (const r of rows) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.ts === r.ts) {
        const n = last.n + r.n;
        last.in_avg = (last.in_avg * last.n + r.in_avg * r.n) / n;
        last.out_avg = (last.out_avg * last.n + r.out_avg * r.n) / n;
        last.in_max = Math.max(last.in_max, r.in_max);
        last.out_max = Math.max(last.out_max, r.out_max);
        last.n = n;
      } else {
        merged.push({ ...r });
      }
    }
    return merged;
  }

  /** Instantaneous (per range-res bucket) statistics: current / avg / max. */
  statsForRange({ port = GLOBAL_PORT, from, to }) {
    const tier = this.tierFor(Math.max(1000, to - from));
    const rows = this.queryRaw({ port, from, to, res: tier.res });
    if (rows.length === 0) return null;
    let inSum = 0, inMax = 0, outSum = 0, outMax = 0, n = 0;
    for (const r of rows) {
      inSum += r.in_avg * r.n;
      outSum += r.out_avg * r.n;
      if (r.in_max > inMax) inMax = r.in_max;
      if (r.out_max > outMax) outMax = r.out_max;
      n += r.n;
    }
    return {
      res: tier.res,
      samples: n,
      inAvg: n ? inSum / n : 0,
      inMax,
      outAvg: n ? outSum / n : 0,
      outMax,
    };
  }

  /**
   * Per-port peak/current over a window, in ONE grouped query.
   * The UI needs peaks for all 26 cards; fetching them port by port would mean
   * 27 HTTP round trips on every range change.
   */
  peaksForRange({ from, to }) {
    const tier = this.tierFor(Math.max(1000, to - from));
    if (!this.ready) return null;
    try {
      return this.db.prepare(`
        SELECT port,
               MAX(in_max)  AS inMax,
               MAX(out_max) AS outMax
        FROM samples
        WHERE res = ? AND port > 0 AND ts >= ? AND ts < ?
        GROUP BY port
      `).all(tier.res, from, to);
    } catch (err) {
      this.lastError = err.message;
      logger.throttleError('store.peaks', `peak query failed: ${err.message}`, 300000);
      return null;
    }
  }

  /* -------------------------------------------------------------- maintenance */

  maintenance() {
    if (!this.ready) return;
    let removed = 0;
    for (const tier of this.tiers) {
      removed += this.purgeTier(tier);
    }
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.pragma('optimize');
    } catch (err) {
      logger.throttleError('store.checkpoint', `wal checkpoint failed: ${err.message}`, 3600000);
    }
    this.stats.purges++;
    if (removed > 0) logger.info(`retention: removed ${removed} old rows`);
    // Re-arm: setTimeout chain, never setInterval, so a long run cannot pile up.
    this.maintTimer = setTimeout(() => this.maintenance(), config.store.maintenanceIntervalMs);
    if (this.maintTimer.unref) this.maintTimer.unref();
  }

  /**
   * Delete rows older than the tier retention.
   * The work is split into at most `maxChunks` bounded transactions so a purge
   * never blocks the poller for long and never allocates a huge rollback journal.
   */
  purgeTier(tier, maxChunks = 20) {
    const cutoff = Date.now() - tier.keep;
    let removed = 0;
    try {
      const minRow = this.db.prepare('SELECT MIN(ts) AS m FROM samples WHERE res = ?').get(tier.res);
      if (minRow == null || minRow.m == null || minRow.m >= cutoff) return 0;

      const span = cutoff - minRow.m;
      const chunkMs = Math.max(tier.resMs * 50, Math.ceil(span / maxChunks));
      const stmt = this.db.prepare('DELETE FROM samples WHERE res = ? AND ts >= ? AND ts < ?');
      let cursor = minRow.m;
      for (let i = 0; i < maxChunks && cursor < cutoff; i++) {
        const info = stmt.run(tier.res, cursor, cursor + chunkMs);
        removed += info.changes;
        cursor += chunkMs;
      }
    } catch (err) {
      this.stats.errors++;
      this.lastError = err.message;
      logger.throttleError('store.purge', `retention purge failed: ${err.message}`, 3600000);
    }
    return removed;
  }

  /* ------------------------------------------------------------------- misc */

  /** On-disk size in MB, including the WAL when present. */
  dbSizeMb() {
    try {
      let bytes = 0;
      for (const f of [config.store.dbFile, `${config.store.dbFile}-wal`]) {
        if (fs.existsSync(f)) bytes += fs.statSync(f).size;
      }
      return +(bytes / 1048576).toFixed(2);
    } catch {
      return 0;
    }
  }

  health() {
    const out = { ready: this.ready, lastError: this.lastError, ...this.stats, openBuckets: this.buckets.size, dbBytes: 0, rows: 0 };
    if (!this.ready) return out;
    try {
      out.dbBytes = fs.existsSync(config.store.dbFile) ? fs.statSync(config.store.dbFile).size : 0;
      const r = this.db.prepare('SELECT COUNT(*) AS c FROM samples').get();
      out.rows = r ? r.c : 0;
    } catch { /* health must never throw */ }
    return out;
  }
}

module.exports = { Store, GLOBAL_PORT };
