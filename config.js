'use strict';

const path = require('path');

function num(value, fallback, { min, max, int = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (int) n = Math.trunc(n);
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const root = __dirname;

const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  logDir: process.env.LOG_DIR || path.join(root, 'logs'),

  http: {
    host: process.env.HOST || '0.0.0.0',
    port: num(process.env.PORT, 3000, { min: 1, max: 65535, int: true }),
  },

  switch: {
    name: process.env.SWITCH_NAME || 'MikroTik CSS326',
    host: process.env.SWITCH_HOST || '172.22.22.2',
    username: process.env.SWITCH_USER || 'admin',
    password: process.env.SWITCH_PASS || '',
    // Request timeout for a single switch poll. Kept above the poll interval on
    // purpose: the poller is single-flight, a slow switch must not stack requests.
    timeoutMs: num(process.env.SWITCH_TIMEOUT_MS, 8000, { min: 1000, max: 60000, int: true }),
    // SwOS >= 2.19 serves the data files without the "!" prefix; older
    // firmwares only answer the prefixed ones. lib/swos.js probes both, this
    // value is only the first candidate.
    statsPath: process.env.SWITCH_STATS_PATH || '/stats.b',
    linkPath: process.env.SWITCH_LINK_PATH || '/link.b',
  },

  poll: {
    intervalMs: num(process.env.POLL_INTERVAL_MS, 3000, { min: 1000, max: 600000, int: true }),
    // /link.b changes slowly: refresh it every N cycles to spare the switch.
    linkEvery: num(process.env.LINK_EVERY, 10, { min: 1, max: 1000, int: true }),
    // Consecutive failures before we stop considering the switch reachable.
    degradedAfter: num(process.env.DEGRADED_AFTER, 2, { min: 1, max: 100, int: true }),
    offlineAfter: num(process.env.OFFLINE_AFTER, 5, { min: 1, max: 1000, int: true }),
    // Backoff applied to the poll interval while the switch is failing.
    backoffMaxMs: num(process.env.POLL_BACKOFF_MAX_MS, 30000, { min: 2000, max: 300000, int: true }),
  },

  ram: {
    // Points kept in RAM (ring buffers). 1200 @ 3s = 1h of live history.
    maxPoints: num(process.env.RAM_MAX_POINTS, 1200, { min: 60, max: 20000, int: true }),
  },

  store: {
    dbFile: process.env.DB_FILE || null, // resolved to dataDir/history.db
    flushIntervalMs: num(process.env.FLUSH_INTERVAL_MS, 60000, { min: 10000, max: 3600000, int: true }),
    maintenanceIntervalMs: num(process.env.MAINTENANCE_INTERVAL_MS, 6 * 3600000, { min: 600000, max: 86400000, int: true }),
    // Tiered aggregation. res = bucket size in seconds, keep = raw retention.
    tiers: [
      { res: 5, keep: 2 * 3600e3 },
      { res: 30, keep: 3 * 24 * 3600e3 },
      { res: 300, keep: 30 * 24 * 3600e3 },
    ],
    // Maximum number of points returned to the browser for a range request.
    maxPointsPerResponse: num(process.env.MAX_POINTS_PER_RESPONSE, 700, { min: 50, max: 5000, int: true }),
  },

  sse: {
    maxClients: num(process.env.SSE_MAX_CLIENTS, 32, { min: 1, max: 500, int: true }),
    heartbeatMs: num(process.env.SSE_HEARTBEAT_MS, 20000, { min: 2000, max: 300000, int: true }),
  },

  log: {
    level: process.env.LOG_LEVEL || 'info', // error | warn | info | debug
    maxBytes: num(process.env.LOG_MAX_BYTES, 2 * 1024 * 1024, { min: 64 * 1024, max: 128 * 1024 * 1024, int: true }),
    maxFiles: num(process.env.LOG_MAX_FILES, 2, { min: 1, max: 10, int: true }),
  },

  // Optional shared secret. Disabled unless DASHBOARD_TOKEN is set.
  token: process.env.DASHBOARD_TOKEN || null,

  // Hard ceiling on request body size (we do not need bodies at all).
  bodyLimit: '8kb',
};

config.store.dbFile = config.store.dbFile || path.join(config.dataDir, 'history.db');

module.exports = config;
