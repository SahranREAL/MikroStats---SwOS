/**
 * The single owner of one device's traffic.
 *
 * Exactly one polling loop exists per device, no matter how many browsers are
 * watching: the device is polled once and the result is fanned out over SSE.
 * The loop is a setTimeout *chain* (never setInterval), so a slow device can
 * never cause overlapping requests, and a failed poll backs off instead of
 * hammering an unreachable device.
 */
import { EventEmitter } from 'node:events';
import config from '../config.js';
import logger from './logger.js';
import { SwitchClient, counter } from './swos.js';
import { GLOBAL_PORT } from './history.js';

export const STATUS = { CONNECTED: 'connected', DEGRADED: 'degraded', DISCONNECTED: 'disconnected' };

export class Poller extends EventEmitter {
  /**
   * @param {import('./history.js').HistoryStore} store
   * @param {{id?:string, client?:object, intervalMs?:number}} [opts]
   */
  constructor(store, opts = {}) {
    super();
    this.setMaxListeners(50);
    this.store = store;
    this.id = opts.id || 'switch';
    this.client = opts.client || new SwitchClient();
    this.intervalMs = opts.intervalMs || config.poll.defaultIntervalMs;
    this.running = false;
    this.timer = null;
    this.cycle = 0;
    this.inFlight = false;

    this.status = STATUS.DISCONNECTED;
    this.startedAt = Date.now();
    this.lastSuccessAt = 0;
    this.lastErrorAt = 0;
    this.lastError = null;
    this.lastSample = null;    // last good sample, served as "last known data"
    this.stale = true;
    this.counters = {
      successful: 0,
      failed: 0,
      consecutiveErrors: 0,
      lastDurationMs: 0,
      lastRequestAt: 0,
    };
    this.backoffMs = 0;

    // Per-port baseline used to turn cumulative counters into rates.
    this.baseline = new Map();
    this.portCount = 0;

    // Multi-resolution history lives in HistoryStore (RAM tiers + journal).
    this.history = store.device(this.id);
  }

  /* --------------------------------------------------------------- lifecycle */

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    logger.info(`poller[${this.id}] started: ${this.client.host} every ${this.intervalMs}ms`);
    this.schedule(0);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    logger.info(`poller[${this.id}] stopped`);
  }

  schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  async tick() {
    if (!this.running) return;
    if (this.inFlight) { this.schedule(this.nextDelay()); return; }
    this.inFlight = true;
    const started = Date.now();
    try {
      await this.poll();
      this.counters.lastDurationMs = Date.now() - started;
      this.backoffMs = 0;
    } catch (err) {
      this.counters.lastDurationMs = Date.now() - started;
      this.onFailure(err);
    } finally {
      this.inFlight = false;
      this.schedule(this.nextDelay());
    }
  }

  nextDelay() {
    if (this.backoffMs > 0) return this.backoffMs;
    // Never issue the next request before the previous one could have finished.
    const floor = this.intervalMs - this.counters.lastDurationMs;
    return Math.max(250, floor);
  }

  onFailure(err) {
    this.counters.failed++;
    this.counters.consecutiveErrors++;
    this.lastErrorAt = Date.now();
    this.lastError = err && err.message ? err.message : String(err);
    logger.throttleError(`poller:${this.id}`, `poll failed: ${this.lastError}`, 60000);

    const interval = this.intervalMs;
    this.backoffMs = Math.min(config.poll.backoffMaxMs, interval * Math.pow(2, Math.min(6, this.counters.consecutiveErrors - 1)));

    this.recomputeStatus();
    this.emit('status', this.statusSnapshot());
  }

  recomputeStatus() {
    const interval = this.intervalMs;
    let next;
    if (!this.lastSuccessAt) {
      // Never connected: reporting "connected" here would be a lie, and the UI
      // is explicitly forbidden from showing a live status without real data.
      next = STATUS.DISCONNECTED;
    } else if (this.counters.consecutiveErrors === 0) {
      next = STATUS.CONNECTED;
    } else if (this.counters.consecutiveErrors >= config.poll.offlineAfter) {
      next = STATUS.DISCONNECTED;
    } else {
      next = STATUS.DEGRADED;
    }
    // A single failure right after a success is only "degraded", never "offline",
    // regardless of the counter - otherwise one hiccup blanks the dashboard.
    if (this.counters.consecutiveErrors === 1 && this.lastSuccessAt > 0 && (Date.now() - this.lastSuccessAt) < interval * 2) {
      next = STATUS.DEGRADED;
    }
    this.stale = next !== STATUS.CONNECTED;
    if (next !== this.status) {
      this.status = next;
      logger.info(`poller[${this.id}] status -> ${next}`);
      this.emit('statusChange', { status: next, at: Date.now() });
    }
  }

  /* -------------------------------------------------------------------- poll */

  async poll() {
    this.counters.lastRequestAt = Date.now();

    const raw = await this.client.fetchStats();

    // Link data is optional and slow-moving: refresh it rarely and never let a
    // failure here break the traffic sample.
    this.cycle++;
    if (this.client.links === null || this.cycle % config.poll.linkEvery === 0) {
      try {
        await this.client.fetchLinks();
      } catch (err) {
        this.client.logError(err, 'link.b');
      }
    }

    const now = Date.now();
    const sample = this.buildSample(raw, now);
    if (!sample) throw new Error('no usable counters in device response');

    this.lastSample = sample;
    this.lastSuccessAt = now;
    this.counters.successful++;
    this.counters.consecutiveErrors = 0;
    this.recomputeStatus();

    this.history.ingest(sample.t, GLOBAL_PORT, sample.inBps, sample.outBps);
    for (const p of sample.ports) {
      this.history.ingest(sample.t, p.index, p.inBps, p.outBps);
    }

    this.emit('sample', sample);
    this.emit('status', this.statusSnapshot());
  }

  /**
   * Turn cumulative counters into a full snapshot.
   * Rates use the real elapsed time between two measurements, never the nominal
   * polling period, and a counter that went backwards invalidates the baseline
   * for that port instead of producing a huge negative spike.
   */
  buildSample(raw, now) {
    const count = Math.max(raw.rb.length, raw.tb.length);
    this.portCount = count;

    const ports = [];
    let totalIn = 0;
    let totalOut = 0;
    let inBps = 0;
    let outBps = 0;
    let anyRate = false;

    for (let i = 0; i < count; i++) {
      const rx = counter('rb', 'rbh', raw, i);
      const tx = counter('tb', 'tbh', raw, i);
      const prev = this.baseline.get(i);
      let pin = 0;
      let pout = 0;

      if (prev && now > prev.t) {
        const dtMs = now - prev.t;
        if (rx >= prev.rx && tx >= prev.tx) {
          pin = ((rx - prev.rx) * 8000) / dtMs;   // bytes -> bits per second
          pout = ((tx - prev.tx) * 8000) / dtMs;
          anyRate = true;
        }
        // rx < prev.rx (or tx) => reboot / counter reset: keep the fresh reading
        // as the new baseline and report 0 for this interval.
      }
      this.baseline.set(i, { t: now, rx, tx });

      totalIn += rx;
      totalOut += tx;
      inBps += pin;
      outBps += pout;

      const meta = this.client.portMeta(i);
      ports.push({
        index: i + 1,
        name: meta.name,
        link: meta.link,
        speed: meta.speed,
        duplex: meta.duplex,
        sfp: meta.sfp,
        rxBytes: rx,
        txBytes: tx,
        inBps: Math.round(pin),
        outBps: Math.round(pout),
      });
    }

    if (!anyRate) {
      // First poll after boot: counters are known, rates are not yet.
      return {
        t: now, first: true, ports,
        inBps: 0, outBps: 0, totalRxBytes: totalIn, totalTxBytes: totalOut,
        status: this.status, portCount: count,
      };
    }

    return {
      t: now,
      first: false,
      ports,
      inBps: Math.round(inBps),
      outBps: Math.round(outBps),
      totalRxBytes: totalIn,
      totalTxBytes: totalOut,
      status: this.status,
      portCount: count,
    };
  }

  /* ------------------------------------------------------------------ output */

  statusSnapshot() {
    const snap = {
      id: this.id,
      status: this.status,
      stale: this.stale,
      switchName: config.legacy.name,
      switchIp: this.client.host,
      lastUpdate: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      lastDurationMs: this.counters.lastDurationMs,
      pollIntervalMs: this.intervalMs,
      consecutiveErrors: this.counters.consecutiveErrors,
      successfulPolls: this.counters.successful,
      failedPolls: this.counters.failed,
      appUptimeMs: Date.now() - this.startedAt,
      startedAt: this.startedAt,
      linkUpdatedAt: this.client.linksAt || 0,
    };
    if (this.lastSample) {
      snap.totalRxBytes = this.lastSample.totalRxBytes;
      snap.totalTxBytes = this.lastSample.totalTxBytes;
      snap.inBps = this.lastSample.inBps;
      snap.outBps = this.lastSample.outBps;
    }
    return snap;
  }

  /**
   * Full real-time payload for GET /api/stats.
   * `stale` is explicit so the UI can never claim to be live on old data.
   */
  statsPayload() {
    const snap = this.statusSnapshot();
    if (!this.lastSample) {
      return {
        ...snap,
        inBps: 0, outBps: 0, totalRxBytes: 0, totalTxBytes: 0, ports: [],
      };
    }
    const s = this.lastSample;
    return {
      ...snap,
      inBps: s.inBps,
      outBps: s.outBps,
      totalRxBytes: s.totalRxBytes,
      totalTxBytes: s.totalTxBytes,
      portCount: s.ports.length,
      ports: s.ports.map((p) => ({
        port: p.index,
        name: p.name,
        link: p.link,
        speed: p.speed,
        duplex: p.duplex,
        sfp: p.sfp,
        inBps: p.inBps,
        outBps: p.outBps,
        rxBytes: p.rxBytes,
        txBytes: p.txBytes,
      })),
    };
  }

  /* ---------------------------------------------------------------- history */

  /** IN/OUT series for a window. Always served from the in-memory tiers. */
  series({ port = GLOBAL_PORT, from, to, maxPoints = config.history.maxPointsPerResponse }) {
    return this.history.query({ port, from, to, maxPoints });
  }

  /** Aggregate over a window (avg/max), no disk access. */
  seriesStats({ port = GLOBAL_PORT, from, to }) {
    return this.history.stats({ port, from, to });
  }

  /** Peak IN/OUT per port over a window (table cards need one request). */
  peaks({ from, to }) {
    return this.history.peaks({ from, to });
  }
}
