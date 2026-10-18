'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const logger = require('./lib/logger');
const { Store, GLOBAL_PORT } = require('./lib/store');
const { Poller } = require('./lib/poller');
const { SseHub } = require('./lib/sse');
const alerts = require('./lib/alerts');

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
// Ranges the RAM ring can satisfy on its own (1h of @3s live samples).
const RAM_RANGES = new Set(['5m', '15m', '1h']);

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

const store = new Store();
let poller = null;
const sse = new SseHub();
let server = null;
let shuttingDown = false;

try {
  store.open();
} catch (err) {
  logger.error('fatal: cannot open history database:', err);
  process.exit(1);
}

poller = new Poller(store);

/* ------------------------------------------------------------------ express */

const app = express();
app.disable('x-powered-by');
app.disable('etag');
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

// Optional shared secret (opt-in via DASHBOARD_TOKEN). Constant-time compare.
if (config.token) {
  const expected = Buffer.from(String(config.token));
  app.use('/api', (req, res, next) => {
    const header = req.get('authorization') || '';
    const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }
    next();
  });
}

const api = express.Router();

api.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/** Real-time snapshot. Never triggers a switch request. */
api.get('/stats', (_req, res) => {
  const payload = poller.statsPayload();
  res.json({ success: true, ...payload });
});

/** System / switch health. */
api.get('/status', (_req, res) => {
  // This tool is expected to run on small hardware forever, so surface the
  // resources it actually consumes instead of making the operator guess.
  const mem = process.memoryUsage();
  res.json({
    success: true,
    ...poller.statusSnapshot(),
    store: store.health(),
    sseClients: sse.size,
    alerts: alerts.active(),
    ram: {
      maxPoints: config.ram.maxPoints,
      globalPoints: poller.globalRing.size,
      portPoints: poller.portRing ? poller.portRing.size : 0,
      series: poller.portRing ? poller.portRing.fields : 0,
    },
    process: {
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1),
      uptimeSec: Math.round(process.uptime()),
      dbMb: store.dbSizeMb(),
    },
    version: require('./package.json').version,
    node: process.version,
  });
});

/** Fallback aggregates computed from an already-downsampled series. */
function statsFromSeries(series) {
  if (!series || !series.points) return null;
  let inSum = 0, inMax = 0, outSum = 0, outMax = 0;
  for (let i = 0; i < series.points; i++) {
    inSum += series.in[i];
    outSum += series.out[i];
    if (series.inMax[i] > inMax) inMax = series.inMax[i];
    if (series.outMax[i] > outMax) outMax = series.outMax[i];
  }
  return {
    samples: series.points,
    inAvg: inSum / series.points,
    inMax,
    outAvg: outSum / series.points,
    outMax,
    source: series.source || 'derived',
  };
}

/**
 * History. `range` picks the window, `port` picks a port (0/absent = switch).
 * Served from RAM for the last hour, from SQLite beyond that, always downsampled.
 */
api.get('/history', (req, res) => {
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

  const to = Date.now();
  const from = to - range.ms;
  const maxPoints = config.store.maxPointsPerResponse;

  let series;
  if (RAM_RANGES.has(range.key)) {
    series = port === GLOBAL_PORT
      ? poller.ramSeries({ from, to, maxPoints })
      : poller.ramPortSeries({ port, from, to, maxPoints: Math.min(maxPoints, 300) });
  } else {
    series = store.query({ port, from, to, maxPoints });
  }

  // Prefer the cheap RAM/database aggregate; fall back to the returned series so
  // the UI always has current/avg/max for the exact window it is displaying.
  let stats = port === GLOBAL_PORT && RAM_RANGES.has(range.key)
    ? poller.ramStats(range.ms)
    : store.statsForRange({ port, from, to });
  if (!stats) stats = statsFromSeries(series);

  // Global request also returns every port's peak, so 26 cards need 1 request.
  const peaks = port === GLOBAL_PORT
    ? (RAM_RANGES.has(range.key) ? poller.ramPeaks() : store.peaksForRange({ from, to }))
    : null;

  res.json({
    success: true,
    range: range.key,
    rangeMs: range.ms,
    port,
    stale: poller.stale,
    status: poller.status,
    ...series,
    stats,
    peaks,
  });
});

/** Live Server-Sent Events stream: one sample per poll, for every viewer. */
api.get('/stream', (req, res) => {
  const client = sse.attach(req, res);
  if (!client) return;
  const snap = poller.statusSnapshot();
  sse.sendRaw(`event: hello\ndata: ${JSON.stringify({ ...snap, sseClients: sse.size })}\n\n`);
});

api.get('/alerts', (_req, res) => {
  res.json({ success: true, active: alerts.active(), rules: alerts.list(), notifiers: alerts.notifierNames() });
});

api.use((_req, res) => {
  res.status(404).json({ success: false, error: 'not found' });
});

app.use('/api', api);

// index.html is served through a handler that appends each asset's mtime as a
// ?v= query string. Changing app.js therefore changes its URL, so browsers
// fetch the new build immediately instead of reusing a cached one - no
// hard-refresh needed after an update.
const indexFile = path.join(config.publicDir, 'index.html');
app.get('/', (_req, res) => {
  let html;
  try {
    html = fs.readFileSync(indexFile, 'utf8');
  } catch {
    res.status(500).type('text/plain').send('index.html unreadable');
    return;
  }
  const stamp = (rel) => {
    try {
      return fs.statSync(path.join(config.publicDir, rel)).mtimeMs.toString(36);
    } catch {
      return '0';
    }
  };
  html = html
    .replace(/(href|src)="\/((?:vendor\/)?[A-Za-z0-9._-]+\.(?:js|css))"/g,
      (_m, attr, file) => `${attr}="/${file}?v=${stamp(file)}"`)
    .replace(/<meta http-equiv="refresh"[^>]*>/g, '');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
});

// Cache policy. index.html and our own JS/CSS change on every update, so the
// browser must revalidate them (ETag makes that a cheap 304). Caching app.js
// for an hour would keep users on a stale build - which is exactly how a
// timestamp format fix can appear to "not work". Vendored libraries change
// rarely, so they get a short cache.
const staticOpts = {
  index: 'index.html',
  etag: true,
  maxAge: 0,
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
};
app.use(express.static(path.join(config.publicDir), staticOpts));

// Final safety net: an unexpected error must not take the process down.
app.use((err, _req, res, _next) => {
  logger.error('unhandled request error:', err);
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.status(500).json({ success: false, error: 'internal error' });
});

/* ------------------------------------------------------------- event bridge */

/**
 * Feed the alert engine. Safe to call on every sample and on every status
 * change: the engine de-duplicates, and evaluating on status change is what
 * makes "switch unreachable" fire while there is no sample to evaluate at all.
 */
function runAlerts(context) {
  alerts.evaluate(context).then((events) => {
    if (events.length > 0) sse.broadcast('alerts', { events });
  }).catch((err) => logger.throttleError('alerts', `alert evaluation failed: ${err.message}`, 600000));
}

poller.on('sample', (sample) => {
  // Compact live frame: everything the UI needs, nothing more.
  sse.broadcast('sample', {
    t: sample.t,
    inBps: sample.inBps,
    outBps: sample.outBps,
    totalRxBytes: sample.totalRxBytes,
    totalTxBytes: sample.totalTxBytes,
    status: poller.status,
    stale: poller.stale,
    first: sample.first,
    ports: sample.ports.map((p) => ({
      port: p.index, inBps: p.inBps, outBps: p.outBps,
      rxBytes: p.rxBytes, txBytes: p.txBytes, link: p.link, speed: p.speed,
    })),
  });

  runAlerts({
    status: poller.status,
    consecutiveErrors: poller.counters.consecutiveErrors,
    portIndex: 0,
    inBps: sample.inBps,
    outBps: sample.outBps,
  });
});

poller.on('status', (snap) => {
  sse.broadcast('status', snap);
});

poller.on('statusChange', (change) => {
  sse.broadcast('statusChange', { ...change, lastError: poller.lastError });
  runAlerts({
    status: change.status,
    consecutiveErrors: poller.counters.consecutiveErrors,
    portIndex: 0,
    inBps: poller.lastSample ? poller.lastSample.inBps : 0,
    outBps: poller.lastSample ? poller.lastSample.outBps : 0,
  });
});

/* ---------------------------------------------------------------- lifecycle */

server = app.listen(config.http.port, config.http.host, () => {
  logger.info(`listening on http://${config.http.host}:${config.http.port}`);
  logger.info(`switch ${config.switch.name} (${config.switch.host}), poll ${config.poll.intervalMs}ms, retention tiers ${JSON.stringify(config.store.tiers.map((t) => t.res + 's'))}`);
  store.startTimers();
  poller.start();
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
  try { poller.stop(); } catch (err) { logger.warn('poller stop failed:', err.message); }

  // 2. Persist and checkpoint the database IMMEDIATELY. This must not wait for
  //    HTTP connections to drain, otherwise a long-lived SSE client keeps the
  //    last samples stuck in the WAL.
  try { store.close(); } catch (err) { logger.warn('store close failed:', err.message); }

  // 3. Release the long-lived responses that would otherwise block server.close().
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

// Process-level safety net (§28, §30). A monitoring tool that dies with its
// process is useless: log and keep serving. Only unrecoverable state exits.
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

process.on('exit', () => logger.close());

module.exports = { app, poller, store, sse };
