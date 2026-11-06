/**
 * Topology model + persistence.
 *
 * One file (`data/topology.json`) holds devices, links and layout. It is
 * written atomically (tmp + rename, 0600) and ONLY when something actually
 * changed: a drag that ends where it started writes nothing.
 *
 * Credentials never live here. They are stored separately in
 * `data/credentials.json`, encrypted with AES-256-GCM under `data/secrets.key`
 * (0600), and are never returned by any API route.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import logger from './logger.js';

export const TOPOLOGY_VERSION = 1;

/** Well-formed input problem: maps to HTTP 400 and carries a field list. */
export class ValidationError extends Error {
  constructor(message, fields = []) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
    this.fields = fields;
  }
}

/** Optimistic-concurrency mismatch: maps to HTTP 412. */
export class RevMismatch extends Error {
  constructor(expected, actual) {
    super(`topology revision ${expected} is stale (current ${actual})`);
    this.name = 'RevMismatch';
    this.code = 'REV_MISMATCH';
    this.expected = expected;
    this.actual = actual;
  }
}

/* ----------------------------------------------------------------- helpers */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Private / loopback / link-local ranges only, unless explicitly opted out. */
function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  let ip = h;
  // Strip an IPv6 zone id and brackets.
  ip = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return false;
    return false;
  }
  // IPv6: loopback, ULA, link-local, IPv4-mapped private.
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateHost(lower.slice(7));
    return false;
  }
  // Hostnames: only resolvable on the LAN in practice; still require a dot
  // -less label or an .local/.lan/.internal suffix to avoid public DNS names.
  if (!h.includes('.')) return true;
  return /\.(local|lan|internal|home|intranet|corp)$/.test(h);
}

function str(value, field, { min = 0, max = 255, re = null, fallback = null } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== null) return fallback;
    throw new ValidationError(`${field} is required`, [field]);
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, [field]);
  const v = value.trim();
  if (v.length < min) throw new ValidationError(`${field} must be at least ${min} characters`, [field]);
  if (v.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, [field]);
  if (re && !re.test(v)) throw new ValidationError(`${field} has an invalid format`, [field]);
  return v;
}

function int(value, field, { min, max, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    throw new ValidationError(`${field} is required`, [field]);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError(`${field} must be an integer`, [field]);
  if (min !== undefined && n < min) throw new ValidationError(`${field} must be >= ${min}`, [field]);
  if (max !== undefined && n > max) throw new ValidationError(`${field} must be <= ${max}`, [field]);
  return n;
}

function bool(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`, [field]);
  return value;
}

/* -------------------------------------------------------------- device */

export const DEVICE_TYPES = ['switch', 'router'];
export const DRIVERS = ['swos', 'routeros'];
const AUTH_MODES = ['digest', 'basic'];

/**
 * Normalise + validate a device payload (create or update).
 * @param {object} input raw request body
 * @param {{partial?:boolean, current?:object}} opts
 */
export function normalizeDevice(input, opts = {}) {
  const { partial = false, current = null } = opts;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('body must be a JSON object');
  }
  const pick = (key) => (partial && !(key in input) ? undefined : input[key]);
  const base = current || {};
  const fields = [];

  const id = base.id !== undefined && !('id' in input)
    ? base.id
    : str(pick('id'), 'id', { min: 1, max: 64, re: ID_RE, fallback: base.id ?? undefined });
  if (!ID_RE.test(id)) fields.push('id');

  const type = pick('type');
  const devType = type === undefined ? (base.type || 'switch') : str(type, 'type', { min: 1, max: 16 });
  if (!DEVICE_TYPES.includes(devType)) fields.push('type');

  const driver = pick('driver');
  const drv = driver === undefined
    ? (base.driver || (devType === 'router' ? 'routeros' : 'swos'))
    : str(driver, 'driver', { min: 1, max: 16 });
  if (!DRIVERS.includes(drv)) fields.push('driver');

  const name = pick('name');
  const devName = name === undefined ? (base.name || id) : str(name, 'name', { min: 1, max: 80 });

  const model = pick('model');
  const devModel = model === undefined ? (base.model ?? null)
    : (model === null || model === '' ? null : str(model, 'model', { max: 80 }));

  const host = pick('host');
  const devHost = host === undefined ? (base.host || undefined)
    : str(host, 'host', { min: 1, max: 253, re: HOST_RE });
  if (devHost === undefined) fields.push('host');
  else if (!config.topology.allowPublicTargets && !isPrivateHost(devHost)) fields.push('host');

  const port = pick('port');
  const devPort = port === undefined ? (base.port ?? null)
    : (port === null || port === '' ? null : int(port, 'port', { min: 1, max: 65535 }));
  if (devPort !== null && devPort !== undefined && (devPort < 1 || devPort > 65535)) fields.push('port');

  const tls = bool(pick('tls'), 'tls', base.tls ?? false);
  const authMode = pick('auth');
  const am = authMode === undefined ? (base.auth || (drv === 'routeros' ? 'basic' : 'digest'))
    : str(authMode, 'auth', { min: 1, max: 16 });
  if (!AUTH_MODES.includes(am)) fields.push('auth');

  const intervalMs = pick('intervalMs');
  const iv = intervalMs === undefined ? (base.intervalMs || config.poll.defaultIntervalMs)
    : int(intervalMs, 'intervalMs', { min: config.poll.minIntervalMs, max: config.poll.maxIntervalMs });
  if (iv < config.poll.minIntervalMs || iv > config.poll.maxIntervalMs) fields.push('intervalMs');

  const root = bool(pick('root'), 'root', base.root ?? false);
  const enabled = bool(pick('enabled'), 'enabled', base.enabled ?? true);

  // Port list: "auto" means "discover from the device".
  const portsMode = pick('portsMode');
  const pm = portsMode === undefined ? (base.portsMode || 'auto') : str(portsMode, 'portsMode', { min: 1, max: 8 });
  if (!['auto', 'manual'].includes(pm)) fields.push('portsMode');

  let ports;
  if (pm === 'auto') {
    ports = pick('ports') === undefined ? (base.ports ?? []) : normalizePortList(pick('ports'), fields);
  } else {
    ports = normalizePortList(pick('ports') ?? base.ports ?? [], fields);
  }

  const layoutRaw = pick('layout');
  const layout = layoutRaw === undefined ? (base.layout || null) : normalizeLayout(layoutRaw, fields);

  const pollEveryN = pick('pollEveryN');
  const pen = pollEveryN === undefined ? (base.pollEveryN ?? 1)
    : int(pollEveryN, 'pollEveryN', { min: 1, max: 100 });

  if (fields.length) {
    throw new ValidationError(`invalid device fields: ${fields.join(', ')}`, fields);
  }

  return {
    id,
    type: devType,
    driver: drv,
    name: devName,
    model: devModel,
    host: devHost,
    port: devPort ?? null,
    tls,
    auth: am,
    intervalMs: iv,
    pollEveryN: pen,
    root,
    enabled,
    portsMode: pm,
    ports,
    layout,
    // Filled in by the caller (never persisted here).
    createdAt: base.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

function normalizePortList(value, fields) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { fields.push('ports'); return []; }
  if (value.length > 512) { fields.push('ports'); return []; }
  const out = [];
  const seen = new Set();
  for (const p of value) {
    if (!p || typeof p !== 'object') { fields.push('ports'); continue; }
    const index = Number(p.index);
    if (!Number.isInteger(index) || index < 1 || index > 512) { fields.push('ports'); continue; }
    if (seen.has(index)) continue;
    seen.add(index);
    const kind = p.kind === 'sfp' ? 'sfp' : 'ethernet';
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 32) : null;
    const speedBps = Number.isFinite(Number(p.speedBps)) && Number(p.speedBps) > 0
      ? Math.min(Number(p.speedBps), 1e15) : null;
    out.push({ index, kind, name, speedBps });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function normalizeLayout(value, fields) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) { fields.push('layout'); return null; }
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) { fields.push('layout'); return null; }
  // Bounded canvas so a crafted payload cannot allocate an unbounded map.
  return {
    x: Math.max(-100000, Math.min(100000, Math.round(x))),
    y: Math.max(-100000, Math.min(100000, Math.round(y))),
    locked: value.locked === true,
  };
}

/* ------------------------------------------------------------------ link */

export function normalizeLink(input, topo, opts = {}) {
  const { partial = false, current = null } = opts;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('body must be a JSON object');
  }
  const pick = (key) => (partial && !(key in input) ? undefined : input[key]);
  const base = current || {};
  const fields = [];

  const id = 'id' in input || !base.id
    ? str(pick('id'), 'id', { min: 1, max: 64, re: ID_RE, fallback: base.id })
    : base.id;
  if (!ID_RE.test(id || '')) fields.push('id');

  const endpoint = (raw, label) => {
    if (raw === undefined) return base[label] ?? undefined;
    if (!raw || typeof raw !== 'object') { fields.push(label); return undefined; }
    const device = typeof raw.device === 'string' ? raw.device.trim() : '';
    const port = Number(raw.port);
    if (!ID_RE.test(device)) { fields.push(label); return undefined; }
    if (!Number.isInteger(port) || port < 1 || port > 512) { fields.push(label); return undefined; }
    return { device, port };
  };

  const a = endpoint(pick('a'), 'a');
  const b = endpoint(pick('b'), 'b');
  if (!a) fields.push('a');
  if (!b) fields.push('b');
  if (a && b && a.device === b.device && a.port === b.port) fields.push('a');

  const capacityBpsRaw = pick('capacityBps');
  let capacityBps = base.capacityBps ?? null;
  if (capacityBpsRaw !== undefined) {
    capacityBps = capacityBpsRaw === null ? null : Number(capacityBpsRaw);
    if (!Number.isFinite(capacityBps) || capacityBps <= 0) { capacityBps = null; }
    else capacityBps = Math.min(Math.round(capacityBps), 1e15);
  }

  const labelRaw = pick('label');
  const label = labelRaw === undefined ? (base.label ?? null)
    : (labelRaw === null || labelRaw === '' ? null : str(labelRaw, 'label', { max: 60 }));

  if (fields.length) throw new ValidationError(`invalid link fields: ${fields.join(', ')}`, fields);
  if (!a || !b) throw new ValidationError('link endpoints are required', ['a', 'b']);

  // Both ends must exist, and each (device, port) may only be used once:
  // two links on the same port would make the load colour ambiguous.
  const devices = new Set((topo?.devices || []).map((d) => d.id));
  if (!devices.has(a.device)) throw new ValidationError(`unknown device "${a.device}"`, ['a']);
  if (!devices.has(b.device)) throw new ValidationError(`unknown device "${b.device}"`, ['b']);

  const key = (e) => `${e.device}#${e.port}`;
  const selfKey = (e) => key(e);
  const existing = (topo?.links || []).filter((l) => l.id !== id);
  const used = new Set();
  for (const l of existing) {
    used.add(selfKey(l.a));
    used.add(selfKey(l.b));
  }
  if (used.has(key(a))) throw new ValidationError(`port ${a.device}:${a.port} is already linked`, ['a']);
  if (used.has(key(b))) throw new ValidationError(`port ${b.device}:${b.port} is already linked`, ['b']);

  return {
    id,
    a,
    b,
    capacityBps,
    label,
    createdAt: base.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

/** Delete a device: every link touching it goes too (no orphans). */
export function linksForDevice(topo, deviceId) {
  return topo.links.filter((l) => l.a.device === deviceId || l.b.device === deviceId);
}

/* ------------------------------------------------------- credentials */

const GCM_ALGO = 'aes-256-gcm';

class CredentialStore {
  constructor(file, keyFile) {
    this.file = file;
    this.keyFile = keyFile;
    this.key = null;
    this.cache = new Map();   // deviceId -> {username, password}
    this.loaded = false;
  }

  #loadKey() {
    if (this.key) return this.key;
    try {
      const raw = fs.readFileSync(this.keyFile);
      if (raw.length !== 32) throw new Error(`expected 32 bytes, got ${raw.length}`);
      this.key = raw;
      return this.key;
    } catch (err) {
      // First run: mint a key with 0600 and never log its contents.
      if (err.code === 'ENOENT') {
        const key = crypto.randomBytes(32);
        fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.keyFile, key, { mode: 0o600, flag: 'wx' });
        this.key = key;
        logger.info('credentials: created secrets.key (0600)');
        return this.key;
      }
      throw err;
    }
  }

  #read() {
    if (this.loaded) return;
    this.loaded = true;
    let buf;
    try {
      buf = fs.readFileSync(this.file);
    } catch {
      return;
    }
    if (buf.length === 0) return;
    try {
      const json = JSON.parse(buf.toString('utf8'));
      for (const [id, entry] of Object.entries(json)) {
        if (!entry || typeof entry !== 'object') continue;
        this.cache.set(id, { username: String(entry.u || ''), password: this.#decrypt(entry.p) });
      }
    } catch (err) {
      logger.warn(`credentials: unreadable (${err.message})`);
    }
  }

  #decrypt(payload) {
    if (typeof payload !== 'string' || !payload.includes('.')) return '';
    try {
      const [ivB, tagB, dataB] = payload.split('.');
      const iv = Buffer.from(ivB, 'base64url');
      const tag = Buffer.from(tagB, 'base64url');
      const data = Buffer.from(dataB, 'base64url');
      const d = crypto.createDecipheriv(GCM_ALGO, this.#loadKey(), iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    } catch {
      // Wrong key or corrupted file: treat as "no credentials" rather than
      // crashing the whole dashboard over a password.
      return '';
    }
  }

  #encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(GCM_ALGO, this.#loadKey(), iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  }

  get(deviceId) {
    this.#read();
    return this.cache.get(deviceId) || null;
  }

  set(deviceId, username, password) {
    this.#read();
    this.cache.set(deviceId, { username: String(username || ''), password: String(password || '') });
    this.#persist();
  }

  remove(deviceId) {
    this.#read();
    if (this.cache.delete(deviceId)) this.#persist();
  }

  #persist() {
    const out = {};
    for (const [id, v] of this.cache) out[id] = { u: v.username, p: this.#encrypt(v.password) };
    writeAtomic(this.file, JSON.stringify(out), 0o600);
  }
}

/* ------------------------------------------------------- atomic write */

/**
 * Write `data` to `file` atomically (tmp in the same directory + rename) with
 * `mode`. Returns true when bytes were actually written.
 */
export function writeAtomic(file, data, mode = 0o600) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  // Skip the write entirely when the content is byte-for-byte identical: this
  // is what keeps a dashboard idle from touching the disk at all.
  try {
    const existing = fs.readFileSync(file);
    if (existing.length === buf.length && existing.equals(buf)) return false;
  } catch { /* no file yet */ }

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch { /* best effort */ }
  return true;
}

/* ------------------------------------------------------------- store */

export class TopologyStore {
  constructor(opts = {}) {
    this.file = opts.file || config.topology.file;
    this.credentials = new CredentialStore(
      opts.credentialsFile || config.topology.credentialsFile,
      opts.secretKeyFile || config.topology.secretKeyFile,
    );
    this.topology = { version: TOPOLOGY_VERSION, rev: 0, updatedAt: 0, devices: [], links: [] };
    this.writes = 0;
    this.bytesWritten = 0;
    this.lastWriteAt = 0;
  }

  /** Load once at startup. Missing file => seed from the legacy config. */
  load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      this.seedFromLegacy();
      this.save(true);
      return this.topology;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.error(`topology: unreadable JSON (${err.message}), starting from the legacy config`);
      this.seedFromLegacy();
      this.save(true);
      return this.topology;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.devices)) {
      logger.error('topology: unexpected shape, starting from the legacy config');
      this.seedFromLegacy();
      this.save(true);
      return this.topology;
    }
    this.topology = {
      version: TOPOLOGY_VERSION,
      rev: Number.isInteger(parsed.rev) ? parsed.rev : 0,
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
      devices: parsed.devices.map((d) => this.#repairDevice(d)).filter(Boolean),
      links: Array.isArray(parsed.links) ? parsed.links : [],
    };
    this.#pruneLinks();
    return this.topology;
  }

  /** A device record from disk is trusted only after re-validation. */
  #repairDevice(d) {
    try {
      const dev = normalizeDevice(d, {});
      // Persisted layout survives as-is; credentials are re-linked by id.
      return dev;
    } catch (err) {
      logger.warn(`topology: dropped invalid device ${d && d.id ? d.id : '?'} (${err.message})`);
      return null;
    }
  }

  #pruneLinks() {
    const devices = new Set(this.topology.devices.map((d) => d.id));
    const before = this.topology.links.length;
    const seen = new Set();
    this.topology.links = this.topology.links.filter((l) => {
      if (!l || !l.a || !l.b) return false;
      if (!devices.has(l.a.device) || !devices.has(l.b.device)) return false;
      if (l.a.device === l.b.device && l.a.port === l.b.port) return false;
      const k = `${l.a.device}#${l.a.port}|${l.b.device}#${l.b.port}`;
      const k2 = `${l.b.device}#${l.b.port}|${l.a.device}#${l.a.port}`;
      if (seen.has(k) || seen.has(k2)) return false;
      seen.add(k);
      return true;
    });
    if (this.topology.links.length !== before) {
      logger.warn(`topology: pruned ${before - this.topology.links.length} invalid/duplicate link(s)`);
    }
  }

  /**
   * Migration: a pre-topology install has only SWITCH_* settings. Turn them
   * into a one-device topology without losing anything (name, host, interval).
   */
  seedFromLegacy() {
    const l = config.legacy;
    if (!l.host) {
      this.topology = { version: TOPOLOGY_VERSION, rev: 0, updatedAt: Date.now(), devices: [], links: [] };
      return this.topology;
    }
    let device = null;
    try {
      device = normalizeDevice({
        id: 'switch',
        type: 'switch',
        driver: 'swos',
        name: l.name,
        host: l.host,
        intervalMs: l.intervalMs,
        root: true,
        portsMode: 'auto',
        layout: { x: 120, y: 120, locked: false },
      }, {});
    } catch (err) {
      logger.error(`topology: cannot seed from the legacy config (${err.message})`);
      return this.topology;
    }
    this.topology = { version: TOPOLOGY_VERSION, rev: 1, updatedAt: Date.now(), devices: [device], links: [] };
    if (l.username || l.password) this.credentials.set(device.id, l.username, l.password);
    logger.info(`topology: migrated legacy switch ${l.name} (${l.host}) to a one-device topology`);
    return this.topology;
  }

  /**
   * Persist the current topology. Returns false when nothing changed, so an
   * unchanged save costs a single read, not a write.
   */
  save(force = false) {
    if (!force) {
      const payload = JSON.stringify(this.topology);
      // Compare against disk: identical content => no syscall beyond the read.
      try {
        const onDisk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (JSON.stringify(onDisk) === payload) return false;
      } catch { /* not written yet */ }
    }
    this.topology.rev = (this.topology.rev || 0) + 1;
    this.topology.updatedAt = Date.now();
    const written = writeAtomic(this.file, JSON.stringify(this.topology), 0o600);
    if (written) {
      this.writes++;
      this.bytesWritten += Buffer.byteLength(JSON.stringify(this.topology));
      this.lastWriteAt = Date.now();
      logger.debug(`topology: saved rev ${this.topology.rev}`);
    }
    return written;
  }

  /** Optimistic concurrency: throws RevMismatch when `expected` is stale. */
  assertRev(expected) {
    if (expected === undefined || expected === null || expected === '') return;
    const n = Number(expected);
    if (!Number.isFinite(n)) throw new ValidationError('If-Match must be a number', ['If-Match']);
    if (n !== this.topology.rev) throw new RevMismatch(n, this.topology.rev);
  }

  getDevice(id) {
    return this.topology.devices.find((d) => d.id === id) || null;
  }

  addDevice(input) {
    if (this.topology.devices.length >= config.topology.maxDevices) {
      throw new ValidationError(`device limit reached (${config.topology.maxDevices})`, []);
    }
    const dev = normalizeDevice(input, {});
    if (this.getDevice(dev.id)) throw new ValidationError(`device "${dev.id}" already exists`, ['id']);
    this.topology.devices.push(dev);
    return dev;
  }

  updateDevice(id, input) {
    const idx = this.topology.devices.findIndex((d) => d.id === id);
    if (idx < 0) return null;
    // An id change must not orphan the links that reference it.
    const next = normalizeDevice(input, { partial: true, current: this.topology.devices[idx] });
    if (next.id !== id) {
      const clash = this.getDevice(next.id);
      if (clash) throw new ValidationError(`device "${next.id}" already exists`, ['id']);
      for (const l of this.topology.links) {
        if (l.a.device === id) l.a.device = next.id;
        if (l.b.device === id) l.b.device = next.id;
      }
    }
    this.topology.devices[idx] = next;
    return next;
  }

  removeDevice(id) {
    const idx = this.topology.devices.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    this.topology.devices.splice(idx, 1);
    const before = this.topology.links.length;
    this.topology.links = this.topology.links.filter((l) => l.a.device !== id && l.b.device !== id);
    const dropped = before - this.topology.links.length;
    this.credentials.remove(id);
    if (dropped) logger.info(`topology: removed ${dropped} link(s) with device ${id}`);
    return true;
  }

  addLink(input) {
    if (this.topology.links.length >= config.topology.maxLinks) {
      throw new ValidationError(`link limit reached (${config.topology.maxLinks})`, []);
    }
    const link = normalizeLink(input, this.topology, {});
    if (this.topology.links.some((l) => l.id === link.id)) {
      throw new ValidationError(`link "${link.id}" already exists`, ['id']);
    }
    this.topology.links.push(link);
    return link;
  }

  updateLink(id, input) {
    const idx = this.topology.links.findIndex((l) => l.id === id);
    if (idx < 0) return null;
    const next = normalizeLink(input, this.topology, { partial: true, current: this.topology.links[idx] });
    if (next.id !== id && this.topology.links.some((l) => l.id === next.id)) {
      throw new ValidationError(`link "${next.id}" already exists`, ['id']);
    }
    this.topology.links[idx] = next;
    return next;
  }

  removeLink(id) {
    const idx = this.topology.links.findIndex((l) => l.id === id);
    if (idx < 0) return false;
    this.topology.links.splice(idx, 1);
    return true;
  }

  /**
   * Public view: identical to the stored topology but with every credential
   * field removed (there are none) and the revision exposed for If-Match.
   */
  publicView() {
    return {
      version: this.topology.version,
      rev: this.topology.rev,
      updatedAt: this.topology.updatedAt,
      devices: this.topology.devices.map((d) => ({
        id: d.id,
        type: d.type,
        driver: d.driver,
        name: d.name,
        model: d.model,
        host: d.host,
        port: d.port,
        tls: d.tls,
        auth: d.auth,
        intervalMs: d.intervalMs,
        pollEveryN: d.pollEveryN,
        root: d.root,
        enabled: d.enabled,
        portsMode: d.portsMode,
        ports: d.ports,
        layout: d.layout,
        hasCredentials: Boolean(this.credentials.get(d.id)),
        // Username is safe to show (it is not a secret); the password never is.
        username: (this.credentials.get(d.id) || {}).username || null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      links: this.topology.links.map((l) => ({
        id: l.id, a: l.a, b: l.b, capacityBps: l.capacityBps, label: l.label,
        createdAt: l.createdAt, updatedAt: l.updatedAt,
      })),
    };
  }

  health() {
    let bytes = 0;
    try { bytes = fs.statSync(this.file).size; } catch { /* not written yet */ }
    return {
      devices: this.topology.devices.length,
      links: this.topology.links.length,
      rev: this.topology.rev,
      writes: this.writes,
      bytesWritten: this.bytesWritten,
      lastWriteAt: this.lastWriteAt,
      fileBytes: bytes,
    };
  }
}

export { isPrivateHost };
