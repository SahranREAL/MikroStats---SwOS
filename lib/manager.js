/**
 * Device manager: the single owner of every polling loop.
 *
 * One Poller per enabled device, whatever the number of browsers. Devices are
 * reconciled against the topology file, so adding/removing a switch in the UI
 * starts or stops exactly one loop - no restart, no duplicated requests.
 *
 * Requests to the devices are bounded (config.poll.concurrency) and spread
 * with jitter so fifty devices do not all fire in the same millisecond.
 */
import { EventEmitter } from 'node:events';
import config from '../config.js';
import logger from './logger.js';
import { Poller } from './poller.js';
import { createDriver } from './drivers.js';
import { indexRates, linkRates, compactLinks } from './links.js';

export class DeviceManager extends EventEmitter {
  /**
   * @param {import('./topology.js').TopologyStore} topology
   * @param {import('./history.js').HistoryStore} history
   */
  constructor(topology, history) {
    super();
    this.setMaxListeners(200);
    this.topology = topology;
    this.history = history;
    this.pollers = new Map();       // deviceId -> Poller
    this.drivers = new Map();       // deviceId -> driver
    this.semaphore = 0;
    this.queue = [];
    this.stats = { started: 0, stopped: 0, rejected: 0 };
  }

  /** Bring the poller set in line with the topology (idempotent). */
  reconcile() {
    const wanted = new Map();
    for (const dev of this.topology.topology.devices) {
      if (dev.enabled !== false) wanted.set(dev.id, dev);
    }

    // Stop pollers for removed / disabled devices.
    for (const [id, poller] of this.pollers) {
      if (!wanted.has(id)) {
        poller.stop();
        const drv = this.drivers.get(id);
        if (drv && typeof drv.close === 'function') { try { drv.close(); } catch { /* ignore */ } }
        this.pollers.delete(id);
        this.drivers.delete(id);
        this.stats.stopped++;
        logger.info(`manager: stopped poller for ${id}`);
      }
    }

    // Start pollers for new devices; refresh settings for existing ones.
    for (const [id, dev] of wanted) {
      const existing = this.pollers.get(id);
      if (existing) {
        existing.intervalMs = dev.intervalMs || config.poll.defaultIntervalMs;
        continue;
      }
      this.startDevice(dev);
    }
    return this.pollers.size;
  }

  startDevice(dev) {
    let driver;
    try {
      const creds = this.topology.credentials.get(dev.id);
      driver = createDriver(dev, creds);
    } catch (err) {
      logger.error(`manager: cannot build driver for ${dev.id}: ${err.message}`);
      return null;
    }
    const poller = new Poller(this.history, {
      id: dev.id,
      driver,
      intervalMs: dev.intervalMs || config.poll.defaultIntervalMs,
    });

    poller.on('sample', (sample) => this.#onSample(dev.id, sample));
    poller.on('status', (snap) => this.emit('status', snap));
    poller.on('statusChange', (change) => this.emit('statusChange', { deviceId: dev.id, ...change }));

    this.pollers.set(dev.id, poller);
    this.drivers.set(dev.id, driver);
    this.stats.started++;
    poller.start();
    return poller;
  }

  /** Replace one device's driver+poller (credentials or host changed). */
  restartDevice(id) {
    const dev = this.topology.getDevice(id);
    const old = this.pollers.get(id);
    if (!dev || dev.enabled === false) {
      if (old) {
        old.stop();
        const drv = this.drivers.get(id);
        if (drv && typeof drv.close === 'function') { try { drv.close(); } catch { /* ignore */ } }
        this.pollers.delete(id);
        this.drivers.delete(id);
      }
      return null;
      }
    if (old) {
      old.stop();
      const drv = this.drivers.get(id);
      if (drv && typeof drv.close === 'function') { try { drv.close(); } catch { /* ignore */ } }
    }
    return this.startDevice(dev);
  }

  stopAll() {
    for (const [id, poller] of this.pollers) {
      poller.stop();
      const drv = this.drivers.get(id);
      if (drv && typeof drv.close === 'function') { try { drv.close(); } catch { /* ignore */ } }
      this.drivers.delete(id);
    }
    this.pollers.clear();
    this.queue.length = 0;
  }

  get(id) {
    return this.pollers.get(id) || null;
  }

  /** Root device (first one flagged `root`, else the first enabled). */
  rootDevice() {
    const devices = this.topology.topology.devices;
    return devices.find((d) => d.root && d.enabled !== false)
      || devices.find((d) => d.enabled !== false)
      || devices[0]
      || null;
  }

  #onSample(deviceId, sample) {
    this.emit('sample', deviceId, sample);
    // Link load changes only when a sample arrives, so the map is refreshed
    // exactly once per poll, never per browser.
    this.emit('links', this.linkSnapshot());
  }

  /** Live rates for every topology link (computed on demand, never cached stale). */
  linkSnapshot() {
    const samples = new Map();
    for (const [id, poller] of this.pollers) {
      if (poller.lastSample) samples.set(id, poller.lastSample);
    }
    return linkRates(this.topology.topology.links, indexRates(samples));
  }

  /** Compact link frame for SSE. */
  linkFrame() {
    return compactLinks(this.linkSnapshot());
  }

  /** Aggregated counters across every device (top-level KPIs). */
  totals() {
    let inBps = 0;
    let outBps = 0;
    let rx = 0;
    let tx = 0;
    let connected = 0;
    let stale = 0;
    for (const poller of this.pollers.values()) {
      if (poller.status === 'connected') connected++;
      else stale++;
      if (poller.lastSample) {
        inBps += poller.lastSample.inBps;
        outBps += poller.lastSample.outBps;
        rx += poller.lastSample.totalRxBytes;
        tx += poller.lastSample.totalTxBytes;
      }
    }
    return {
      inBps: Math.round(inBps),
      outBps: Math.round(outBps),
      totalRxBytes: rx,
      totalTxBytes: tx,
      devices: this.pollers.size,
      connected,
      stale,
    };
  }

  /**
   * Run `fn` under the shared device-request budget. Excess callers wait
   * instead of piling concurrent requests onto the LAN.
   */
  async withSlot(fn) {
    if (this.semaphore >= config.poll.concurrency) {
      this.stats.rejected++;
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.semaphore++;
    const jitter = config.poll.jitterMs > 0 ? Math.random() * config.poll.jitterMs : 0;
    try {
      if (jitter > 0) await new Promise((r) => setTimeout(r, jitter));
      return await fn();
    } finally {
      this.semaphore--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** Test connectivity to a device without touching its poller. */
  async testDevice(device, creds) {
    const driver = createDriver(device, creds);
    try {
      return await this.withSlot(() => driver.test());
    } finally {
      if (typeof driver.close === 'function') { try { driver.close(); } catch { /* ignore */ } }
    }
  }

  health() {
    const perDevice = [];
    for (const [id, poller] of this.pollers) {
      perDevice.push({ id, ...poller.statusSnapshot() });
    }
    return {
      devices: this.pollers.size,
      started: this.stats.started,
      stopped: this.stats.stopped,
      rejected: this.stats.rejected,
      inFlight: this.semaphore,
      queued: this.queue.length,
      perDevice,
    };
  }
}
