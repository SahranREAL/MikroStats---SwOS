/**
 * Device drivers behind one interface:
 *
 *   test()        -> prove reachability + credentials, report the port list
 *   listPorts()   -> [{index, name, kind, link, speed, duplex, sfp}]
 *   readCounters() -> {t, ports:[{index, rxBytes, txBytes}]}
 *   readSystem()  -> {identity, version, uptime, ...} or null when unsupported
 *
 * Two implementations ship:
 *   - swos      : the existing SwOS HTTP data endpoints (lib/swos.js)
 *   - routeros  : RouterOS v7 REST when the device answers it, otherwise the
 *                 binary API on 8728/8729. REST is the default because it is
 *                 plain HTTP with Basic auth - one round trip, no handshake -
 *                 while the binary API needs a login sentence exchange first.
 */
import crypto from 'node:crypto';
import logger from './logger.js';
import { request as httpRequest } from './net.js';
import { SwitchClient, counter, SPEED_BY_CODE } from './swos.js';

const U32 = 4294967296;

/* ------------------------------------------------------------- swos driver */

export class SwosDriver {
  constructor(device, creds) {
    this.device = device;
    this.client = new SwitchClient({
      host: device.host,
      username: creds?.username ?? '',
      password: creds?.password ?? '',
      timeoutMs: config_timeout(device),
      statsPath: undefined,
      linkPath: undefined,
    });
    this.kind = 'swos';
  }

  get host() { return this.client.host; }

  async test() {
    const started = Date.now();
    await this.client.fetchStats();
    try { await this.client.fetchLinks(); } catch (err) { this.client.logError(err, 'link.b'); }
    const ports = this.client.describePorts();
    return {
      ok: true,
      latencyMs: Date.now() - started,
      portCount: ports.length,
      ports: ports.map((p, i) => ({ index: i + 1, ...p })),
      system: await this.readSystem(),
    };
  }

  async listPorts() {
    try { await this.client.fetchLinks(); } catch (err) { this.client.logError(err, 'link.b'); }
    const count = this.client.stats ? Math.max(this.client.stats.rb.length, this.client.stats.tb.length) : 0;
    return this.client.describePorts(count).map((p, i) => ({ index: i + 1, ...p }));
  }

  async readCounters() {
    const raw = await this.client.fetchStats();
    const n = Math.max(raw.rb.length, raw.tb.length);
    const ports = [];
    for (let i = 0; i < n; i++) {
      ports.push({ index: i + 1, rxBytes: counter('rb', 'rbh', raw, i), txBytes: counter('tb', 'tbh', raw, i) });
    }
    return { t: Date.now(), ports };
  }

  async readSystem() {
    // SwOS has no system endpoint: report what we can prove.
    return {
      identity: this.device.name || null,
      platform: 'SwOS',
      version: null,
      uptime: null,
      model: this.device.model || null,
    };
  }
}

function config_timeout(device) {
  return Number(device.timeoutMs) || 8000;
}

/* -------------------------------------------------------- routeros driver */

const ROUTEROS_API_PORT = 8728;
const ROUTEROS_TLS_PORT = 8729;

export class RouterOsDriver {
  constructor(device, creds) {
    this.device = device;
    this.username = creds?.username ?? '';
    this.password = creds?.password ?? '';
    this.tls = device.tls === true;
    this.basePort = device.port || (this.tls ? ROUTEROS_TLS_PORT : 80);
    this.timeoutMs = config_timeout(device);
    this.kind = 'routeros';
    this.mode = null;          // 'rest' | 'api' once probed
    this.host = device.host;
    this.session = null;       // binary API socket state
  }

  /* ------------------------------------------------------------------ REST */

  #restBase() {
    const scheme = this.tls ? 'https' : 'http';
    const port = this.device.port || (this.tls ? 443 : 80);
    return `${scheme}://${this.device.host}:${port}/rest`;
  }

  async #rest(pathname, method = 'GET', body = null) {
    const res = await httpRequest({
      url: `${this.#restBase()}${pathname}`,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : null,
      auth: { username: this.username, password: this.password, mode: 'basic' },
      timeoutMs: this.timeoutMs,
      redirect: 'error',
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`routeros REST ${res.status} on ${pathname}`);
      err.code = 'HTTP_STATUS';
      err.status = res.status;
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`routeros REST ${res.status} on ${pathname}`);
      err.code = 'HTTP_STATUS';
      err.status = res.status;
      throw err;
    }
    if (!res.body) return null;
    try { return JSON.parse(res.body); } catch {
      const err = new Error('routeros REST returned non-JSON');
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
  }

  async #tryRest() {
    const sys = await this.#rest('/system/resource');
    this.mode = 'rest';
    return sys;
  }

  /* ---------------------------------------------------------- binary API */

  /** Encode one API word: [length][bytes], length < 0x80 in a single byte. */
  static #encodeWord(word) {
    const buf = Buffer.from(String(word), 'utf8');
    if (buf.length < 0x80) return Buffer.concat([Buffer.from([buf.length]), buf]);
    // Two-byte form: 0b10xxxxxx xxxxxxxx
    const len = buf.length;
    if (len > 0x3fff) throw new Error('API word too long');
    return Buffer.concat([Buffer.from([0x80 | ((len >> 8) & 0x3f), len & 0xff]), buf]);
  }

  static #encodeSentence(words) {
    return Buffer.concat([...words.map(RouterOsDriver.#encodeWord), Buffer.from([0])]);
  }

  /** Decode a length-prefixed word stream into sentences (arrays of strings). */
  static decodeSentences(buf) {
    const sentences = [];
    let current = null;
    let i = 0;
    while (i < buf.length) {
      let len = buf[i];
      if (len & 0x80) {
        if (i + 1 >= buf.length) break;
        len = ((len & 0x3f) << 8) | buf[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      if (i + len > buf.length) break;      // truncated: ignore the tail
      const word = buf.subarray(i, i + len).toString('utf8');
      i += len;
      if (len === 0) {                       // sentence terminator
        if (current) { sentences.push(current); current = null; }
        continue;
      }
      if (!current) current = [];
      current.push(word);
    }
    return sentences;
  }

  async #apiConnect() {
    const net = await import('node:net');
    const tls = await import('node:tls');
    const port = this.device.port || (this.tls ? ROUTEROS_TLS_PORT : ROUTEROS_API_PORT);

    const socket = await new Promise((resolve, reject) => {
      const s = this.tls
        ? tls.connect({ host: this.device.host, port, servername: this.device.host, rejectUnauthorized: false })
        : net.createConnection({ host: this.device.host, port });
      const timer = setTimeout(() => {
        s.destroy();
        const e = new Error(`routeros api timeout connecting to ${this.device.host}:${port}`);
        e.code = 'TIMEOUT';
        reject(e);
      }, this.timeoutMs);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    socket.setNoDelay(true);

    const state = { socket, buf: Buffer.alloc(0), waiters: [] };
    socket.on('data', (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      RouterOsDriver.#drain(state);
    });
    socket.on('error', () => { RouterOsDriver.#fail(state, new Error('routeros api socket error')); });
    socket.on('close', () => { RouterOsDriver.#fail(state, new Error('routeros api connection closed')); });
    return state;
  }

  static #drain(state) {
    const sentences = RouterOsDriver.decodeSentences(state.buf);
    // decodeSentences stops at a truncated tail; find how much was consumed by
    // re-walking so partial words stay buffered for the next chunk.
    let consumed = 0;
    {
      let i = 0;
      let cur = null;
      const buf = state.buf;
      while (i < buf.length) {
        let len = buf[i];
        if (len & 0x80) {
          if (i + 1 >= buf.length) break;
          len = ((len & 0x3f) << 8) | buf[i + 1];
          i += 2;
        } else i += 1;
        if (i + len > buf.length) break;
        const word = buf.subarray(i, i + len).toString('utf8');
        i += len;
        if (len === 0) { if (cur) { cur = null; } continue; }
        if (!cur) cur = [];
        cur.push(word);
        consumed = i;
      }
      if (consumed > 0) state.buf = state.buf.subarray(consumed);
    }

    for (const sentence of sentences) {
      const tag = sentence[0] || '';
      const waiter = state.waiters[0];
      if (!waiter) continue;
      if (tag === '!done' || tag === '!re' || tag === '!trap' || tag === '!fatal') {
        waiter.lines.push(sentence);
        if (tag === '!done' || tag === '!trap' || tag === '!fatal') {
          state.waiters.shift();
          clearTimeout(waiter.timer);
          if (tag === '!trap' || tag === '!fatal') {
            const msg = sentence.slice(1).join(' ') || tag;
            const err = new Error(`routeros: ${msg}`);
            err.code = 'API_ERROR';
            waiter.reject(err);
          } else {
            waiter.resolve(waiter.lines);
          }
        }
      }
    }
  }

  static #fail(state, err) {
    const waiters = state.waiters.splice(0);
    for (const w of waiters) { clearTimeout(w.timer); w.reject(err); }
    try { state.socket.destroy(); } catch { /* already gone */ }
  }

  #apiSend(state, words) {
    return new Promise((resolve, reject) => {
      const waiter = { lines: [], resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = state.waiters.indexOf(waiter);
        if (idx >= 0) state.waiters.splice(idx, 1);
        const err = new Error('routeros api: response timeout');
        err.code = 'TIMEOUT';
        reject(err);
      }, this.timeoutMs);
      state.waiters.push(waiter);
      state.socket.write(RouterOsDriver.#encodeSentence(words), (err) => {
        if (err) {
          const idx = state.waiters.indexOf(waiter);
          if (idx >= 0) state.waiters.splice(idx, 1);
          clearTimeout(waiter.timer);
          reject(err);
        }
      });
    });
  }

  async #apiLogin(state) {
    // RouterOS >= 6.43 accepts a plain login; older releases need the
    // challenge/response round trip. Try plain first (1 round trip).
    const plain = await this.#apiSend(state, ['/login', `name=${this.username}`, `password=${this.password}`]);
    const ret = plain.find((s) => s[0] === '=ret=')?.[0]?.slice(5);
    if (!ret) return;                       // plain login accepted

    // Legacy: ret holds the challenge hex; response = md5(challenge + password)
    const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
    const response = md5(`${ret}${this.password}`);
    await this.#apiSend(state, ['/login', `name=${this.username}`, `password=${this.password}`, `response=${response}`]);
  }

  async #withSession(fn) {
    if (this.mode === 'rest') {
      return fn({ rest: (p, m, b) => this.#rest(p, m, b) });
    }
    const state = this.session && !this.session.socket.destroyed
      ? this.session
      : await this.#apiConnect();
    this.session = state;
    try {
      if (!state.loggedIn) {
        await this.#apiLogin(state);
        state.loggedIn = true;
      }
      return await fn({ api: (words) => this.#apiSend(state, words) });
    } catch (err) {
      // A dead session must not be reused: drop it and let the next poll
      // reconnect instead of hammering a half-open socket.
      state.loggedIn = false;
      try { state.socket.destroy(); } catch { /* ignore */ }
      if (this.session === state) this.session = null;
      throw err;
    }
  }

  /** Parse `=key=value` lines of a reply into an array of objects. */
  static #records(lines) {
    const out = [];
    let cur = null;
    for (const line of lines) {
      if (line[0] !== '=') continue;
      const eq = line.indexOf('=', 1);
      const key = eq === -1 ? line.slice(1) : line.slice(1, eq);
      const val = eq === -1 ? '' : line.slice(eq + 2);
      if (key === '.id') { if (cur) out.push(cur); cur = {}; }
      if (!cur) cur = {};
      cur[key] = val;
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ------------------------------------------------------- shared interface */

  async #detect() {
    if (this.mode) return this.mode;
    try {
      await this.#tryRest();
      return this.mode;
    } catch (err) {
      if (err.code === 'HTTP_STATUS' && (err.status === 401 || err.status === 403)) {
        // REST exists but rejected the credentials: still "REST", and the
        // caller should surface an auth error rather than fall back silently.
        this.mode = 'rest';
        throw err;
      }
      logger.debug(`routeros ${this.device.host}: REST unavailable (${err.message}), falling back to the binary API`);
      this.mode = 'api';
      return this.mode;
    }
  }

  async test() {
    const started = Date.now();
    await this.#detect();
    const system = await this.readSystem();
    const ports = await this.listPorts();
    return {
      ok: true,
      latencyMs: Date.now() - started,
      portCount: ports.length,
      ports,
      system,
      mode: this.mode,
    };
  }

  async listPorts() {
    await this.#detect();
    const rows = await this.#withSession(async (c) => {
      if (c.rest) {
        const data = await c.rest('/interface');
        return Array.isArray(data) ? data : [];
      }
      const lines = await c.api(['/interface/print']);
      return RouterOsDriver.#records(lines);
    });

    return rows.map((r, i) => {
      const type = String(r.type || '');
      const sfp = /sfp|sfpp|sfpplus|optical|gpone|pon/.test(type) || /sfp/i.test(String(r.name || ''));
      const disabled = r.disabled === 'true' || r['running'] === 'false' && r['link-down'] === 'true';
      const linkDown = r['link-down'] === 'true';
      const speedBps = r.speed ? parseSpeed(r.speed) : null;
      return {
        index: i + 1,
        name: r.name || `ether${i + 1}`,
        kind: sfp ? 'sfp' : 'ethernet',
        link: disabled ? false : !linkDown,
        speed: speedBps,
        duplex: r['full-duplex'] === 'false' ? 'half' : 'full',
        autoNeg: r['auto-negotiation'] !== 'false',
        enabled: r.disabled !== 'true',
        sfp,
        // RouterOS exposes interface counters directly: no 32-bit split.
        rxBytes: Number(r['rx-byte'] || 0),
        txBytes: Number(r['tx-byte'] || 0),
        raw: r,
      };
    });
  }

  async readCounters() {
    const ports = await this.listPorts();
    return { t: Date.now(), ports: ports.map((p) => ({ index: p.index, rxBytes: p.rxBytes, txBytes: p.txBytes })) };
  }

  async readSystem() {
    await this.#detect();
    return this.#withSession(async (c) => {
      if (c.rest) {
        const r = await c.rest('/system/resource');
        return {
          identity: this.device.name || null,
          platform: 'RouterOS',
          version: r.version || null,
          uptime: r.uptime || null,
          model: r['board-name'] || r.architecture_name || this.device.model || null,
          cpuLoad: Number(r['cpu-load'] || 0) || null,
          totalMemory: Number(r['total-memory'] || 0) || null,
          freeMemory: Number(r['free-memory'] || 0) || null,
          mode: this.mode,
        };
      }
      const lines = await c.api(['/system/resource/print']);
      const rec = RouterOsDriver.#records(lines)[0] || {};
      return {
        identity: this.device.name || null,
        platform: 'RouterOS',
        version: rec.version || null,
        uptime: rec.uptime || null,
        model: rec['board-name'] || this.device.model || null,
        cpuLoad: Number(rec['cpu-load'] || 0) || 0 || null,
        totalMemory: Number(rec['total-memory'] || 0) || null,
        freeMemory: Number(rec['free-memory'] || 0) || null,
        mode: this.mode,
      };
    });
  }

  close() {
    if (this.session) {
      try { this.session.socket.destroy(); } catch { /* ignore */ }
      this.session = null;
    }
  }
}

/** "1Gbps" / "100Mbps" / "10" -> bits per second (null when unparseable). */
export function parseSpeed(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const m = String(text).trim().match(/^([\d.]+)\s*([kKmMgGtT]?)(?:bps|b\/s)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e15 }[m[2].toLowerCase()];
  return n * mult;
}

export { SPEED_BY_CODE };

/** Build the driver for a device record + its stored credentials. */
export function createDriver(device, creds) {
  if (device.driver === 'routeros') return new RouterOsDriver(device, creds);
  return new SwosDriver(device, creds);
}
