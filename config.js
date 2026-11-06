import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function num(value, fallback, { min, max, int = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = int ? Math.trunc(n) : n;
  if (min !== undefined && v < min) return fallback;
  if (max !== undefined && v > max) return fallback;
  return v;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function list(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  logDir: process.env.LOG_DIR || path.join(root, 'logs'),

  http: {
    host: process.env.HOST || '0.0.0.0',
    port: num(process.env.PORT, 3000, { min: 1, max: 65535, int: true }),
    // Hard ceiling on request body size (topology edits are tiny).
    bodyLimitBytes: num(process.env.BODY_LIMIT_BYTES, 32 * 1024, { min: 1024, max: 1024 * 1024, int: true }),
  },

  /* ------------------------------------------------------------ authentication
   * Modification routes ALWAYS require a token (auto-generated on first run when
   * DASHBOARD_TOKEN is not set, stored 0600). Reads are open on the LAN unless
   * AUTH_REQUIRED=1. `basic` mode is only sensible behind TLS. */
  auth: {
    mode: process.env.AUTH_MODE || 'token',           // token | basic | none
    token: process.env.DASHBOARD_TOKEN || null,
    tokenFile: process.env.TOKEN_FILE || null,         // resolved to dataDir/token
    requireForRead: bool(process.env.AUTH_REQUIRED, false),
  },

  /* --------------------------------------------------------------- topology */
  topology: {
    file: process.env.TOPOLOGY_FILE || null,           // resolved to dataDir/topology.json
    credentialsFile: process.env.CREDENTIALS_FILE || null, // resolved to dataDir/credentials.json
    secretKeyFile: process.env.SECRETS_KEY_FILE || null,   // resolved to dataDir/secrets.key
    maxDevices: num(process.env.MAX_DEVICES, 50, { min: 1, max: 500, int: true }),
    maxLinks: num(process.env.MAX_LINKS, 200, { min: 1, max: 2000, int: true }),
    // Anti-SSRF: device addresses are restricted to private ranges unless opted out.
    allowPublicTargets: bool(process.env.ALLOW_PUBLIC_TARGETS, false),
  },

  limits: {
    // Writes per minute per client address (topology edits are rare).
    writeRatePerMin: num(process.env.WRITE_RATE_PER_MIN, 60, { min: 1, max: 10000, int: true }),
  },

  /* ------------------------------------------------------------------ devices
   * One polling cycle per device, whatever the number of browsers. */
  poll: {
    defaultIntervalMs: num(process.env.POLL_INTERVAL_MS, 3000, { min: 1000, max: 600000, int: true }),
    minIntervalMs: num(process.env.POLL_MIN_INTERVAL_MS, 1000, { min: 200, max: 600000, int: true }),
    maxIntervalMs: num(process.env.POLL_MAX_INTERVAL_MS, 600000, { min: 1000, max: 3600000, int: true }),
    // Device requests are bounded and spread with jitter to avoid bursts.
    concurrency: num(process.env.POLL_CONCURRENCY, 4, { min: 1, max: 64, int: true }),
    jitterMs: num(process.env.POLL_JITTER_MS, 400, { min: 0, max: 10000, int: true }),
    timeoutMs: num(process.env.DEVICE_TIMEOUT_MS, 8000, { min: 500, max: 60000, int: true }),
    // /link.b changes slowly: refresh it every N cycles to spare the switch.
    linkEvery: num(process.env.LINK_EVERY, 10, { min: 1, max: 1000, int: true }),
    degradedAfter: num(process.env.DEGRADED_AFTER, 2, { min: 1, max: 100, int: true }),
    offlineAfter: num(process.env.OFFLINE_AFTER, 5, { min: 1, max: 1000, int: true }),
    backoffMaxMs: num(process.env.POLL_BACKOFF_MAX_MS, 30000, { min: 2000, max: 300000, int: true }),
    // SwOS >= 2.19 serves the data files without the "!" prefix; older
    // firmwares only answer the prefixed ones. lib/swos.js probes both.
    statsPath: process.env.SWITCH_STATS_PATH || '/stats.b',
    linkPath: process.env.SWITCH_LINK_PATH || '/link.b',
  },

  /* ----------------------------------------------------------------- history
   * Circular multi-resolution buffers in typed arrays. Nothing here is read
   * from disk per HTTP request: snapshots are loaded once at startup. */
  history: {
    dir: process.env.HISTORY_DIR || null,              // resolved to dataDir/history
    flushIntervalMs: num(process.env.HISTORY_FLUSH_MS, 60000, { min: 1000, max: 3600000, int: true }),
    // Raw sample ring (one point per poll). 900 points @3s = 45 min.
    rawPoints: num(process.env.HISTORY_RAW_POINTS, 900, { min: 60, max: 100000, int: true }),
    // Bucketed tiers: res (seconds) -> number of retained buckets.
    tiers: [
      { res: 10, cap: num(process.env.HISTORY_TIER_10S, 360, { min: 30, max: 100000, int: true }) },      // 1 h
      { res: 60, cap: num(process.env.HISTORY_TIER_60S, 1440, { min: 60, max: 100000, int: true }) },     // 24 h
      { res: 300, cap: num(process.env.HISTORY_TIER_300S, 8640, { min: 120, max: 200000, int: true }) },  // 30 d
    ],
    // Per-port 30-day tier. Disable on very large installations to save RAM
    // (per-port history then stops at 24 h, global history keeps 30 d).
    portLongTier: bool(process.env.HISTORY_PORT_LONG_TIER, true),
    maxPointsPerResponse: num(process.env.MAX_POINTS_PER_RESPONSE, 700, { min: 50, max: 5000, int: true }),
  },

  sse: {
    maxClients: num(process.env.SSE_MAX_CLIENTS, 32, { min: 1, max: 500, int: true }),
    heartbeatMs: num(process.env.SSE_HEARTBEAT_MS, 20000, { min: 2000, max: 300000, int: true }),
    // Samples arriving within this window are coalesced into a single frame.
    coalesceMs: num(process.env.SSE_COALESCE_MS, 250, { min: 0, max: 5000, int: true }),
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',            // error | warn | info | debug
    target: process.env.LOG_TARGET || 'file',           // file | stdout | both
    maxBytes: num(process.env.LOG_MAX_BYTES, 2 * 1024 * 1024, { min: 64 * 1024, max: 128 * 1024 * 1024, int: true }),
    maxFiles: num(process.env.LOG_MAX_FILES, 2, { min: 1, max: 10, int: true }),
  },

  /* Legacy single-switch settings: used only to seed/migrate the topology. */
  legacy: {
    name: process.env.SWITCH_NAME || 'MikroTik CSS326',
    host: process.env.SWITCH_HOST || '172.22.22.2',
    username: process.env.SWITCH_USER || 'admin',
    password: process.env.SWITCH_PASS || '',
    intervalMs: num(process.env.POLL_INTERVAL_MS, 3000, { min: 1000, max: 600000, int: true }),
  },
};

config.topology.file = config.topology.file || path.join(config.dataDir, 'topology.json');
config.topology.credentialsFile = config.topology.credentialsFile || path.join(config.dataDir, 'credentials.json');
config.topology.secretKeyFile = config.topology.secretKeyFile || path.join(config.dataDir, 'secrets.key');
config.auth.tokenFile = config.auth.tokenFile || path.join(config.dataDir, 'token');
config.history.dir = config.history.dir || path.join(config.dataDir, 'history');

export default config;
