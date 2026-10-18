'use strict';

const { EventEmitter } = require('events');
const config = require('../config');
const logger = require('./logger');
const { SwitchClient, counter } = require('./swos');
const { RingBuffer } = require('./ring');
const { GLOBAL_PORT } = require('./store');

const STATUS = { CONNECTED: 'connected', DEGRADED: 'degraded', DISCONNECTED: 'disconnected' };

/**
 * The single owner of switch traffic.
 *
 * Exactly one polling loop exists for the whole process, no matter how many
 * browsers are watching: the switch is polled once and the result is fanned out
 * over SSE (§25). The loop is a setTimeout *chain* (never setInterval), so a
 * slow switch can never cause overlapping requests (§27), and a failed poll
 * backs off instead of hammering an unreachable device (§28).
 */
class Poller extends EventEmitter {
  constructor(store) {
    super();
    this.setMaxListeners(50);
    this.store = store;
    this.client = new SwitchClient();
    this.running = false;
    this.timer = null;
    this.cycle = 0;

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

    // Per-port baseline used to turn cumulative counters into rates (§21/§22).
    this.baseline = new Map();
    this.portCount = 0;

    // Fixed-size RAM history: allocated once, never grows (§13/§31).
    // globalRing: 2 series (IN, OUT). portRing: 2 series per port, interleaved.
    this.globalRing = new RingBuffer(config.ram.maxPoints, 2);
    this.portRing = null; // created once the port count is known
  }

  /** Lazily size the per-port ring to the switch's real port count. */
  ensurePortRing(count) {
    const fields = count * 2;
    if (this.portRing && this.portRing.fields === fields) return;
    this.portRing = new RingBuffer(config.ram.maxPoints, fields);
    this.portCount = count;
    logger.info(`ram buffers sized for ${count} ports`);
  }

  /* --------------------------------------------------------------- lifecycle */

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    logger.info(`poller started: ${config.switch.host} every ${config.poll.intervalMs}ms`);
    this.schedule(0);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    logger.info('poller stopped');
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
    const floor = config.poll.intervalMs - this.counters.lastDurationMs;
    return Math.max(250, floor);
  }

  onFailure(err) {
    this.counters.failed++;
    this.counters.consecutiveErrors++;
    this.lastErrorAt = Date.now();
    this.lastError = err && err.message ? err.message : String(err);
    logger.throttleError('poller', `poll failed: ${this.lastError}`, 60000);

    const interval = config.poll.intervalMs;
    this.backoffMs = Math.min(config.poll.backoffMaxMs, interval * Math.pow(2, Math.min(6, this.counters.consecutiveErrors - 1)));

    this.recomputeStatus();
    this.emit('status', this.statusSnapshot());
  }

  recomputeStatus() {
    const interval = config.poll.intervalMs;
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
      logger.info(`switch status -> ${next}`);
      this.emit('statusChange', { status: next, at: Date.now() });
    }
  }

  /* -------------------------------------------------------------------- poll */

  async poll() {
    this.counters.lastRequestAt = Date.now();

    let raw;
    try {
      raw = await this.client.fetchStats();
    } catch (err) {
      throw err;
    }

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
    if (!sample) throw new Error('no usable counters in switch response');

    this.lastSample = sample;
    this.lastSuccessAt = now;
    this.counters.successful++;
    this.counters.consecutiveErrors = 0;
    this.recomputeStatus();

    this.store.ingest(sample.t, GLOBAL_PORT, sample.inBps, sample.outBps);
    for (const p of sample.ports) {
      this.store.ingest(sample.t, p.index, p.inBps, p.outBps);
    }

    this.globalRing.push(sample.t, [sample.inBps, sample.outBps]);
    this.portRing.push(sample.t, sample.flat);

    this.emit('sample', sample);
    this.emit('status', this.statusSnapshot());
  }

  /**
   * Turn cumulative counters into a full snapshot.
   * Rates use the real elapsed time between two measurements, never the nominal
   * polling period, and a counter that went backwards invalidates the baseline
   * for that port instead of producing a huge negative spike (§21/§22).
   */
  buildSample(raw, now) {
    const count = Math.max(raw.rb.length, raw.tb.length);
    this.ensurePortRing(count);

    const ports = [];
    const flat = new Float64Array(this.portRing.fields);
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
        t: now, first: true, ports, flat,
        inBps: 0, outBps: 0, totalRxBytes: totalIn, totalTxBytes: totalOut,
        status: this.status, portCount: count,
      };
    }

    for (let i = 0; i < ports.length; i++) {
      flat[i * 2] = ports[i].inBps;
      flat[i * 2 + 1] = ports[i].outBps;
    }

    return {
      t: now,
      first: false,
      ports,
      flat,
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
      status: this.status,
      stale: this.stale,
      switchName: config.switch.name,
      switchIp: config.switch.host,
      lastUpdate: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      lastDurationMs: this.counters.lastDurationMs,
      pollIntervalMs: config.poll.intervalMs,
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
   * `stale` is explicit so the UI can never claim to be live on old data (§29).
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

  /**
   * Global IN/OUT series straight from RAM. Used for the short ranges so the
   * common case needs no database access at all.
   */
  ramSeries({ from, to, maxPoints = config.store.maxPointsPerResponse }) {
    const ring = this.globalRing;
    if (ring.size === 0) return { t: [], in: [], inMax: [], out: [], outMax: [], points: 0, source: 'ram' };
    const size = ring.size;
    const oldest = ring.count > ring.capacity ? ring.count - ring.capacity : 0;

    const t = [];
    const inn = [];
    const inm = [];
    const outn = [];
    const outm = [];
    let skip = 0;
    for (let i = 0; i < size; i++) {
      const slot = ring.slot(oldest + i);
      const ts = ring.ts[slot];
      if (ts < from) { if (t.length === 0) skip++; continue; }
      if (ts >= to) break;
      t.push(Math.round(ts));
      inn.push(ring.data[slot * 2]);
      inm.push(ring.data[slot * 2]);
      outn.push(ring.data[slot * 2 + 1]);
      outm.push(ring.data[slot * 2 + 1]);
    }

    let series = { t, in: inn, inMax: inm, out: outn, outMax: outm, points: t.length, source: 'ram' };
    if (series.points > maxPoints) {
      const step = Math.ceil(series.points / maxPoints);
      const dt = [], di = [], dim = [], doo = [], dom = [];
      for (let i = 0; i < series.points; i += step) {
        let im = 0, om = 0;
        for (let k = i; k < Math.min(i + step, series.points); k++) {
          if (series.in[k] > im) im = series.in[k];
          if (series.out[k] > om) om = series.out[k];
        }
        dt.push(series.t[i]); di.push(series.in[i]); dim.push(im);
        doo.push(series.out[i]); dom.push(om);
      }
      series = { t: dt, in: di, inMax: dim, out: doo, outMax: dom, points: dt.length, source: 'ram' };
    }
    if (series.points === 0) series.partial = skip > 0;
    return series;
  }

  /** Per-port IN/OUT series from RAM (port 1-based, 0 = global). */
  ramPortSeries({ port, from, to, maxPoints = 300 }) {
    if (port === 0) return this.ramSeries({ from, to, maxPoints });
    const ring = this.portRing;
    if (!ring || ring.size === 0) return { t: [], in: [], inMax: [], out: [], outMax: [], points: 0, source: 'ram' };
    const f = (port - 1) * 2;
    if (f < 0 || f + 1 >= ring.fields) return { t: [], in: [], inMax: [], out: [], outMax: [], points: 0, source: 'ram' };

    const size = ring.size;
    const oldest = ring.count > ring.capacity ? ring.count - ring.capacity : 0;
    const t = [];
    const inn = [];
    const inm = [];
    const outn = [];
    const outm = [];
    const step = Math.max(1, Math.ceil(size / maxPoints));
    for (let i = 0; i < size; i += step) {
      const slot = ring.slot(oldest + i);
      const ts = ring.ts[slot];
      if (ts < from) continue;
      if (ts >= to) break;
      let im = 0, om = 0;
      for (let k = i; k < Math.min(i + step, size); k++) {
        const s2 = ring.slot(oldest + k);
        if (ring.ts[s2] >= to) break;
        if (ring.data[s2 * ring.fields + f] > im) im = ring.data[s2 * ring.fields + f];
        if (ring.data[s2 * ring.fields + f + 1] > om) om = ring.data[s2 * ring.fields + f + 1];
      }
      t.push(Math.round(ts));
      inn.push(ring.data[slot * ring.fields + f]);
      inm.push(im);
      outn.push(ring.data[slot * ring.fields + f + 1]);
      outm.push(om);
    }
    return { t, in: inn, inMax: inm, out: outn, outMax: outm, points: t.length, source: 'ram' };
  }

  /** Per-port peak IN/OUT over the RAM window, from a single pass. */
  ramPeaks() {
    const ring = this.portRing;
    if (!ring || ring.size === 0) return [];
    const size = ring.size;
    const fields = ring.fields;
    const count = fields / 2;
    const out = [];
    for (let p = 0; p < count; p++) {
      let im = 0;
      let om = 0;
      for (let i = 0; i < size; i++) {
        const slot = ring.slot(i);
        const a = ring.data[slot * fields + p * 2];
        const b = ring.data[slot * fields + p * 2 + 1];
        if (a > im) im = a;
        if (b > om) om = b;
      }
      out.push({ port: p + 1, inMax: im, outMax: om });
    }
    return out;
  }

  /** Aggregates over the RAM window (no disk involved) for the selected range. */
  ramStats(rangeMs) {
    const since = Date.now() - rangeMs;
    const size = this.globalRing.size;
    if (size === 0) return null;
    let inSum = 0, inMax = 0, outSum = 0, outMax = 0, n = 0;
    const oldest = this.globalRing.count > this.globalRing.capacity ? this.globalRing.count - this.globalRing.capacity : 0;
    for (let i = 0; i < size; i++) {
      const slot = this.globalRing.slot(oldest + i);
      const ts = this.globalRing.ts[slot];
      if (ts < since) continue;
      const inV = this.globalRing.data[slot * 2];
      const outV = this.globalRing.data[slot * 2 + 1];
      inSum += inV; outSum += outV;
      if (inV > inMax) inMax = inV;
      if (outV > outMax) outMax = outV;
      n++;
    }
    if (n === 0) return null;
    return { samples: n, inAvg: inSum / n, inMax, outAvg: outSum / n, outMax, source: 'ram' };
  }
}

module.exports = { Poller, STATUS, GLOBAL_PORT };
