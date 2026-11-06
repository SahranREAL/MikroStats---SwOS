import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import config from './config.js';
import logger from './lib/logger.js';
import { HistoryStore, GLOBAL_PORT } from './lib/history.js';
import { SseHub } from './lib/sse.js';
import * as alerts from './lib/alerts.js';
import { TopologyStore, ValidationError, RevMismatch } from './lib/topology.js';
import { DeviceManager } from './lib/manager.js';
import { initAuth, requireToken, requireRead, writeLimiter, rateLimitHealth } from './lib/auth.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));

/* ------------------------------------------------------------------ ranges */

const RANGES = {
  '5m': 5 * 60e3,
  '15m': 15 * 60e3,
  '1h': 60 * 60e3,
  '6h': 6 * 60 * 60e3,
  '24h': 24 * 60 * 60e3,
  '7d': 7 * 24 * 60 * 60e3,
  '30d': 30 * 24 * 60 * 60e3,
};
const RANGE_KEYS = Object.keys(RANGES);

function parseRange(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!RANGE_KEYS.includes(key)) return null;
  return { key, ms: RANGES[key] };
}

function parsePort(value) {
  if (value === undefined || value === '' || value === 'all') return GLOBAL_PORT;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value);
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  if (n > 512) return null;
  return n;
}

/* -------------------------------------------------------------------- boot */

const token = initAuth();
const topology = new TopologyStore();
topology.load();

const history = new HistoryStore();
history.loadAll();

const manager = new DeviceManager(topology, history);
manager.reconcile();

const sse = new SseHub();
let server = null;
let shuttingDown = false;

/* ------------------------------------------------------------------ express */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

app.use((req, res, next) => {
  // The dashboard serves only its own assets and JSON: lock everything else down.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  next();
});

const api = express.Router();
api.use(express.json({ limit: config.http.bodyLimitBytes, strict: true }));
api.use(requireRead);
// Modification routes ALWAYS need the token (unless AUTH_MODE=none).
if (config.auth.mode !== 'none') {
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return requireToken(req, res, next);
  });
}
api.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/** Every error funnels through here so responses stay uniform. */
function fail(res, err) {
  if (err instanceof ValidationError || err.code === 'VALIDATION' || err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({
      success: false,
      error: err.message || 'invalid request',
      fields: err.fields || undefined,
    });
    return;
  }
  if (err instanceof RevMismatch || err.code === 'REV_MISMATCH') {
    res.status(412).json({ success: false, error: err.message, rev: err.actual, expected: err.expected });
    return;
  }
  if (err && err.code === 'ECONNREFUSED' || (err && err.code === 'TIMEOUT')) {
    res.status(502).json({ success: false, error: err.message });
    return;
  }
  logger.error('api error:', err);
  res.status(500).json({ success: false, error: 'internal error' });
}

/** If-Match: optional on reads, required semantics when present. */
function checkRev(req, res) {
  const h = req.get('if-match');
  if (h === undefined) return true;
  try {
    topology.assertRev(String(h).replace(/^W\//, '').replace(/"/g, ''));
    return true;
  } catch (err) {
    fail(res, err);
    return false;
  }
}

/* --------------------------------------------------------------- topology */

/** Topology without any credential material. */
api.get('/topology', (_req, res) => {
  res.json({ success: true, ...topology.publicView() });
});

/** Batch layout save: sent once when a drag ends, never per frame. */
api.put('/topology/layout', writeLimiter, (req, res) => {
  if (!checkRev(req, res)) return;
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.devices)) {
    res.status(400).json({ success: false, error: 'body must be {devices:[{id,x,y,locked}]}' });
    return;
  }
  if (body.devices.length > config.topology.maxDevices) {
    res.status(400).json({ success: false, error: 'too many devices in one payload' });
    return;
  }
  let changed = 0;
  for (const entry of body.devices) {
    if (!entry || typeof entry !== 'object') continue;
    const dev = topology.getDevice(String(entry.id || ''));
    if (!dev) continue;
    const x = Number(entry.x);
    const y = Number(entry.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const layout = {
      x: Math.max(-100000, Math.min(100000, Math.round(x))),
      y: Math.max(-100000, Math.min(100000, Math.round(y))),
      locked: entry.locked === true,
    };
    const prev = dev.layout;
    if (!prev || prev.x !== layout.x || prev.y !== layout.y || prev.locked !== layout.locked) {
      dev.layout = layout;
      dev.updatedAt = Date.now();
      changed++;
    }
  }
  // Nothing actually moved -> no disk write at all.
  const written = changed > 0 ? topology.save() : false;
  res.json({ success: true, changed, written, rev: topology.topology.rev });
});

/* ---------------------------------------------------------------- devices */

api.get('/devices', (_req, res) => {
  res.json({ success: true, ...topology.publicView() });
});

function devicePayload(dev) {
  const poller = manager.get(dev.id);
  return {
    ...topology.publicView().devices.find((d) => d.id === dev.id),
    live: poller ? poller.statsPayload() : null,
  };
}

api.post('/devices', writeLimiter, (req, res) => {
  if (!checkRev(req, res)) return;
  const body = req.body || {};
  const creds = body.credentials;
  // Credentials are stripped from the model before validation: they live in
  // the encrypted store, never in topology.json.
  const { credentials: _drop, ...rest } = body;
  try {
    const dev = topology.addDevice(rest);
    if (creds && typeof creds === 'object') {
      topology.credentials.set(dev.id, String(creds.username || ''), String(creds.password || ''));
    }
    topology.save();
    manager.reconcile();
    sse.broadcast('topology', topology.publicView());
    res.status(201).json({ success: true, device: devicePayload(dev), rev: topology.topology.rev });
  } catch (err) {
    fail(res, err);
  }
});

api.patch('/devices/:id', writeLimiter, (req, res) => {
  if (!checkRev(req, res)) return;
  const id = req.params.id;
  const existing = topology.getDevice(id);
  if (!existing) { res.status(404).json({ success: false, error: 'device not found' }); return; }
  const { credentials: creds, ...rest } = req.body || {};
  // Never allow an id change through a PATCH: it would orphan the history file
  // and every link. Use DELETE + POST for a rename.
  delete rest.id;
  try {
    const dev = topology.updateDevice(id, rest);
    if (creds && typeof creds === 'object') {
      topology.credentials.set(id, String(creds.username || ''), String(creds.password || ''));
    }
    topology.save();
    manager.reconcile();
    sse.broadcast('topology', topology.publicView());
    res.json({ success: true, device: devicePayload(dev), rev: topology.topology.rev });
  } catch (err) {
    fail(res, err);
  }
});

api.delete('/devices/:id', writeLimiter, (req, res) => {
  if (!checkRev(req, res)) return;
  const id = req.params.id;
  if (!topology.getDevice(id)) { res.status(404).json({ success: false, error: 'device not found' }); return; }
  try {
    topology.removeDevice(id);
    topology.save();
    manager.reconcile();
    history.remove(id);
    sse.broadcast('topology', topology.publicView());
    res.json({ success: true, removed: id, rev: topology.topology.rev });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Connectivity test. Runs against a throwaway driver so a bad password can
 * never disturb the live poller.
 */
api.post('/devices/test', writeLimiter, async (req, res) => {
  const body = req.body || {};
  let device = null;
  let creds = null;
  if (body.id) {
    device = topology.getDevice(String(body.id));
    if (!device) { res.status(404).json({ success: false, error: 'device not found' }); return; }
    creds = topology.credentials.get(device.id);
    // The form may send new credentials: use them for the test only.
    if (body.credentials && typeof body.credentials === 'object') {
      creds = { username: String(body.credentials.username || ''), password: String(body.credentials.password || '') };
    }
  } else if (body.device && typeof body.device === 'object') {
    // Test-before-save: validate the same way a real save would.
    const { credentials, ...rest } = body.device;
    try {
      const { normalizeDevice } = await import('./lib/topology.js');
      device = normalizeDevice(rest, {});
      creds = credentials && typeof credentials === 'object'
        ? { username: String(credentials.username || ''), password: String(credentials.password || '') }
        : null;
    } catch (err) { fail(res, err); return; }
  } else {
    res.status(400).json({ success: false, error: 'send {id} or {device}' });
    return;
  }

  try {
    const result = await manager.testDevice(device, creds);
    // Never echo credentials back, even on success.
    res.json({ success: true, ...result, credentials: undefined });
  } catch (err) {
    const status = err && (err.code === 'HTTP_STATUS' && (err.status === 401 || err.status === 403)) ? 401
      : err && err.code === 'TIMEOUT' ? 504
        : 502;
    res.status(status).json({
      success: false,
      error: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : undefined,
    });
  }
});

/* ------------------------------------------------------------------ links */

api.post('/links', writeLimiter, (req, res) => {
  if (!checkRev(req, res)) return;
  try {
    const link = topology.addLink(req.body || {});
    topology.save();
    sse.broadcast('topology', topology.publicView());
    res.status(201).json({ success: true, link, rev: topology.topology.rev });
  } catch (err) {
    fail(res, err);
  }
});

api.patch('/links/:id', writeLimiter, (req, res) => {
  if (!checkRev(req, res)) return;
  const { id: _drop, ...rest } = req.body || {};
  try {
    const link = topology.updateLink(req.params.id, rest);
    if (!link) { res.status(404).json({ success: false, error: 'link not found' }); return; }
    topology.save();
    sse.broadcast('topology', topology.publicView());
    res.json({ success: true, link, rev: topology.topology.rev });
  } catch (err) {
    fail(res, err);
  }
});

api.delete('/links/:id', writeLimiter, (req, res) => {
  if (!checkRev(req, res)) return;
  if (!topology.removeLink(req.params.id)) {
    res.status(404).json({ success: false, error: 'link not found' });
    return;
  }
  topology.save();
  sse.broadcast('topology', topology.publicView());
  res.json({ success: true, removed: req.params.id, rev: topology.topology.rev });
});

/* ------------------------------------------------------------------ stats */

/** Live link loads (the map's traffic layer). */
api.get('/links', (_req, res) => {
  res.json({ success: true, links: manager.linkSnapshot(), rev: topology.topology.rev });
});

/**
 * Aggregate across every device. Never triggers a device request.
 * The root device's port list is included so a single-SwOS install (the
 * historical frontend) keeps working off this one call.
 */
api.get('/stats', (_req, res) => {
  const root = manager.rootDevice();
  const rootPoller = root ? manager.get(root.id) : null;
  res.json({
    success: true,
    ...manager.totals(),
    ports: rootPoller ? rootPoller.statsPayload().ports : [],
    status: rootPoller ? rootPoller.status : 'disconnected',
    stale: rootPoller ? rootPoller.stale : true,
    lastUpdate: rootPoller ? rootPoller.lastSuccessAt : 0,
    switchIp: root ? root.host : null,
    switchName: root ? root.name : null,
    pollIntervalMs: root ? root.intervalMs : null,
    sseClients: sse.size,
  });
});

/** One device's real-time snapshot. */
api.get('/devices/:id/stats', (req, res) => {
  const poller = manager.get(req.params.id);
  if (!poller) { res.status(404).json({ success: false, error: 'device not polled' }); return; }
  res.json({ success: true, ...poller.statsPayload() });
});

/* ---------------------------------------------------------------- history */

function historyFor(req, res, deviceId) {
  const range = parseRange(req.query.range);
  if (!range) {
    res.status(400).json({ success: false, error: `range must be one of: ${RANGE_KEYS.join(', ')}` });
    return;
  }
  const port = parsePort(req.query.port);
  if (port === null) {
    res.status(400).json({ success: false, error: 'port must be "all" or an integer 0-512' });
    return;
  }

  const poller = manager.get(deviceId);
  const hist = poller ? poller.history : history.device(deviceId, { persist: false });
  const to = Date.now();
  const from = to - range.ms;
  const maxPoints = config.history.maxPointsPerResponse;

  const series = hist.query({ port, from, to, maxPoints });
  let stats = hist.stats({ port, from, to });
  if (!stats && series.points) {
    let inSum = 0, inMax = 0, outSum = 0, outMax = 0;
    for (let i = 0; i < series.points; i++) {
      inSum += series.in[i]; outSum += series.out[i];
      if (series.inMax[i] > inMax) inMax = series.inMax[i];
      if (series.outMax[i] > outMax) outMax = series.outMax[i];
    }
    stats = {
      samples: series.points,
      inAvg: inSum / series.points, inMax,
      outAvg: outSum / series.points, outMax,
      source: series.source || 'derived',
    };
  }

  res.json({
    success: true,
    device: deviceId,
    range: range.key,
    rangeMs: range.ms,
    port,
    stale: poller ? poller.stale : true,
    status: poller ? poller.status : 'disconnected',
    ...series,
    stats,
    peaks: port === GLOBAL_PORT ? hist.peaks({ from, to }) : null,
  });
}

api.get('/devices/:id/history', (req, res) => historyFor(req, res, req.params.id));
// Legacy single-device route (the root switch) kept for the current frontend.
api.get('/history', (req, res) => {
  const root = manager.rootDevice();
  if (!root) { res.status(404).json({ success: false, error: 'no device configured' }); return; }
  historyFor(req, res, root.id);
});

/* ------------------------------------------------------------------ stream */

/**
 * ONE SSE stream for the whole dashboard: samples, statuses, topology changes
 * and link loads are multiplexed into it. Serialised once per tick, no matter
 * how many browsers are attached.
 */
api.get('/stream', (req, res) => {
  const client = sse.attach(req, res);
  if (!client) return;
  const view = topology.publicView();
  sse.sendRaw(`event: hello\ndata: ${JSON.stringify({
    ...manager.totals(),
    rev: view.rev,
    sseClients: sse.size,
    topology: view,
    links: manager.linkFrame(),
  })}\n\n`);
});

api.get('/alerts', (_req, res) => {
  res.json({ success: true, active: alerts.active(), rules: alerts.list(), notifiers: alerts.notifierNames() });
});

api.get('/status', (_req, res) => {
  const mem = process.memoryUsage();
  const h = history.health();
  const root = manager.rootDevice();
  const rootPoller = root ? manager.get(root.id) : null;
  res.json({
    success: true,
    // Legacy single-device fields the current frontend reads directly.
    ...(rootPoller ? rootPoller.statusSnapshot() : {
      status: 'disconnected', stale: true, lastUpdate: 0,
      switchName: root ? root.name : null, switchIp: root ? root.host : null,
      pollIntervalMs: root ? root.intervalMs : null,
    }),
    version: pkg.version,
    node: process.version,
    server: {
      version: pkg.version,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1),
    },
    history: h,
    topology: topology.health(),
    manager: manager.health(),
    rateLimit: rateLimitHealth(),
    sseClients: sse.size,
    alerts: alerts.active(),
    // The token itself is never included: only whether one is configured.
    auth: { mode: config.auth.mode, tokenConfigured: Boolean(token), requireForRead: config.auth.requireForRead },
  });
});

api.use((_req, res) => {
  res.status(404).json({ success: false, error: 'not found' });
});

app.use('/api', api);

/* ---------------------------------------------------------- event bridge */

/**
 * Serialise ONE frame per sample and hand it to every browser. Nothing here
 * runs when nobody is listening.
 */
manager.on('sample', (deviceId, sample) => {
  if (sse.size === 0) {
    // Still evaluate alerts: they must fire even with no browser open.
    runAlerts({
      deviceId,
      status: manager.get(deviceId)?.status,
      consecutiveErrors: manager.get(deviceId)?.counters.consecutiveErrors ?? 0,
      portIndex: 0,
      inBps: sample.inBps,
      outBps: sample.outBps,
    });
    return;
  }
  sse.broadcast('sample', {
    device: deviceId,
    t: sample.t,
    inBps: sample.inBps,
    outBps: sample.outBps,
    totalRxBytes: sample.totalRxBytes,
    totalTxBytes: sample.totalTxBytes,
    status: sample.status,
    stale: sample.status !== 'connected',
    first: sample.first,
    ports: sample.ports.map((p) => ({
      port: p.index, inBps: p.inBps, outBps: p.outBps,
      rxBytes: p.rxBytes, txBytes: p.txBytes, link: p.link, speed: p.speed,
    })),
  });
  runAlerts({
    deviceId,
    status: sample.status,
    consecutiveErrors: manager.get(deviceId)?.counters.consecutiveErrors ?? 0,
    portIndex: 0,
    inBps: sample.inBps,
    outBps: sample.outBps,
  });
});

manager.on('links', (frame) => {
  if (sse.size === 0) return;
  sse.broadcast('links', { links: frame });
});

manager.on('status', (snap) => {
  if (sse.size === 0) return;
  sse.broadcast('status', snap);
});

manager.on('statusChange', (change) => {
  if (sse.size > 0) sse.broadcast('statusChange', { ...change, lastError: manager.get(change.deviceId)?.lastError });
  runAlerts({
    deviceId: change.deviceId,
    status: change.status,
    consecutiveErrors: manager.get(change.deviceId)?.counters.consecutiveErrors ?? 0,
    portIndex: 0,
    inBps: manager.get(change.deviceId)?.lastSample?.inBps || 0,
    outBps: manager.get(change.deviceId)?.lastSample?.outBps || 0,
  });
});

function runAlerts(context) {
  alerts.evaluate(context).then((events) => {
    if (events.length > 0 && sse.size > 0) sse.broadcast('alerts', { events });
  }).catch((err) => logger.throttleError('alerts', `alert evaluation failed: ${err.message}`, 600000));
}

/* ------------------------------------------------------------- static */

const indexFile = path.join(config.publicDir, 'index.html');

/**
 * Static assets are read ONCE at startup and served from memory with a
 * content hash as the ETag: no per-request stat() and no per-request read.
 * `immutable` applies to /vendor (Chart.js), which never changes under a
 * running install; our own JS/CSS revalidate with the hash.
 */
const assetCache = new Map();

function loadAsset(rel) {
  const hit = assetCache.get(rel);
  if (hit) return hit;
  const file = path.join(config.publicDir, rel);
  try {
    const buf = fs.readFileSync(file);
    const etag = `"${cryptoHash(buf)}"`;
    const entry = { buf, etag, type: contentTypeFor(rel), mtimeMs: fs.statSync(file).mtimeMs };
    assetCache.set(rel, entry);
    return entry;
  } catch {
    return null;
  }
}

function cryptoHash(buf) {
  // Cheap, stable, and only ever compared for equality - not a security check.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < buf.length; i++) {
    h1 = Math.imul(h1 ^ buf[i], 0x01000193);
    h2 = Math.imul(h2 + buf[i], 0x85ebca6b);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + buf.length.toString(36);
}

function contentTypeFor(rel) {
  if (rel.endsWith('.html')) return 'text/html; charset=utf-8';
  if (rel.endsWith('.css')) return 'text/css; charset=utf-8';
  if (rel.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (rel.endsWith('.json')) return 'application/json; charset=utf-8';
  if (rel.endsWith('.svg')) return 'image/svg+xml';
  if (rel.endsWith('.png')) return 'image/png';
  if (rel.endsWith('.ico')) return 'image/x-icon';
  if (rel.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function sendAsset(req, res, rel, { immutable = false } = {}) {
  const entry = loadAsset(rel);
  if (!entry) { res.status(404).end('not found'); return; }
  if (req.get('if-none-match') === entry.etag) {
    res.status(304).end();
    return;
  }
  res.setHeader('ETag', entry.etag);
  res.setHeader('Content-Type', entry.type);
  res.setHeader('Cache-Control', immutable
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');
  res.setHeader('Content-Length', String(entry.buf.length));
  res.end(entry.buf);
}

// /vendor is immutable: the file name/content only changes with an upgrade and
// the ETag makes revalidation free anyway.
app.use('/vendor', (req, res, next) => {
  const rel = `vendor${req.path}`;
  if (rel.includes('..')) { next(); return; }
  sendAsset(req, res, rel, { immutable: true });
});

app.get('/', (req, res) => {
  const entry = loadAsset('index.html');
  if (!entry) { res.status(500).type('text/plain').send('index.html unreadable'); return; }
  let html = entry.buf.toString('utf8');
  // Cache-busting ?v= on our own assets so an upgrade is picked up immediately.
  html = html
    .replace(/(href|src)="\/((?:vendor\/)?[A-Za-z0-9._-]+\.(?:js|css))"/g,
      (_m, attr, file) => `${attr}="/${file}?v=${cryptoHash(loadAsset(file)?.buf || Buffer.alloc(0))}"`)
    .replace(/<meta http-equiv="refresh"[^>]*>/g, '');
  const buf = Buffer.from(html, 'utf8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
});

app.use((req, res, next) => {
  const rel = req.path.replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.includes('\0')) { next(); return; }
  const entry = loadAsset(rel);
  if (!entry) { next(); return; }
  sendAsset(req, res, rel);
});

// Final safety net: an unexpected error must not take the process down.
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    fail(res, err);
    return;
  }
  logger.error('unhandled request error:', err);
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.status(500).json({ success: false, error: 'internal error' });
});

/* ------------------------------------------------------------- lifecycle */

server = app.listen(config.http.port, config.http.host, () => {
  logger.info(`listening on http://${config.http.host}:${config.http.port}`);
  logger.info(`topology: ${topology.topology.devices.length} device(s), ${topology.topology.links.length} link(s), rev ${topology.topology.rev}`);
  logger.info(`polling ${manager.pollers.size} device(s), tiers ${config.history.tiers.map((t) => t.res + 's').join('/')}`);
  if (config.auth.mode !== 'none' && token) {
    logger.info('auth: write routes require a token (see data/token)');
  }
  history.startTimers();
});

server.on('error', (err) => {
  logger.error('http server error:', err);
  if (err && err.code === 'EADDRINUSE') process.exit(1);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
// SSE connections are long-lived: do not let Node time them out.
server.requestTimeout = 0;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);

  // Deadline for the whole sequence. Deliberately NOT unref()'d: this timer is
  // the only guarantee the process cannot survive a wedged socket.
  const guard = setTimeout(() => {
    logger.error('forced exit after shutdown timeout');
    logger.close().finally(() => process.exit(1));
  }, 5000);

  // 1. Stop producing data before anything else.
  try { manager.stopAll(); } catch (err) { logger.warn('manager stop failed:', err.message); }

  // 2. Persist history and topology IMMEDIATELY. This must not wait for HTTP
  //    connections to drain, otherwise a long-lived SSE client holds them.
  try { history.close(); } catch (err) { logger.warn('history close failed:', err.message); }
  try { topology.save(); } catch (err) { logger.warn('topology save failed:', err.message); }

  // 3. Release the long-lived responses that would otherwise block close().
  try { sse.closeAll(); } catch (err) { logger.warn('sse close failed:', err.message); }
  try { server.closeAllConnections(); } catch { /* not available everywhere */ }

  const done = async () => {
    try { server.close(); } catch { /* ignore */ }
    clearTimeout(guard);
    logger.info('shutdown complete');
    await logger.close();
    process.exit(0);
  };

  if (server) server.close(done);
  else done();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Process-level safety net. A monitoring tool that dies with its process is
// useless: log and keep serving. Only unrecoverable state exits.
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

process.on('exit', () => logger.close());

export { app, manager, topology, history, sse };
