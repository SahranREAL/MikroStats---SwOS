/**
 * Auth for the modification routes.
 *
 * Reads are open on the LAN by default (AUTH_REQUIRED=0). Every write
 * (POST/PATCH/PUT/DELETE) ALWAYS requires a token: one is generated on first
 * run and stored 0600 in data/token when DASHBOARD_TOKEN is not set.
 *
 * The token is compared in constant time and is never logged, never echoed
 * back, and never placed in a page.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import logger from './logger.js';

let token = null;

/** Resolve (or mint) the dashboard token once, at startup. */
export function initAuth() {
  if (config.auth.token) {
    token = String(config.auth.token);
    return token;
  }
  const file = config.auth.tokenFile;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      token = existing;
      return token;
    }
  } catch { /* first run */ }

  token = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    logger.info(`auth: generated dashboard token in ${file} (0600)`);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Lost a race with a concurrent first boot: read what the winner wrote.
      try { token = fs.readFileSync(file, 'utf8').trim(); } catch { /* fall through */ }
    } else {
      logger.error(`auth: cannot persist the token (${err.message}); using an ephemeral one`);
    }
  }
  return token;
}

export function getToken() {
  return token;
}

/** Constant-time bearer/token comparison. */
function matches(provided) {
  if (!token || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Accepts `Authorization: Bearer <t>` or `?token=<t>` (for EventSource). */
export function extractToken(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      return decoded.split(':').slice(1).join(':').trim();
    } catch { return null; }
  }
  const q = req.query && typeof req.query.token === 'string' ? req.query.token : null;
  return q;
}

/** Express middleware: 401 unless a valid token is presented. */
export function requireToken(req, res, next) {
  if (matches(extractToken(req))) return next();
  res.status(401).json({ success: false, error: 'unauthorized' });
}

/**
 * Read guard: only enforced when AUTH_REQUIRED=1. Writes always go through
 * requireToken regardless of this setting.
 */
export function requireRead(req, res, next) {
  if (!config.auth.requireForRead) return next();
  if (matches(extractToken(req))) return next();
  res.status(401).json({ success: false, error: 'unauthorized' });
}

/* ------------------------------------------------------------ rate limiting */

const buckets = new Map();   // ip -> { count, resetAt }

/**
 * Fixed-window limiter for write routes. Cheap (one Map entry per client) and
 * enough to stop a runaway UI loop from hammering the disk.
 */
export function writeLimiter(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + 60000 };
    buckets.set(ip, b);
    // Bound the map: a scanner must not grow it without limit.
    if (buckets.size > 4096) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
  }
  b.count++;
  if (b.count > config.limits.writeRatePerMin) {
    res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
    res.status(429).json({ success: false, error: 'too many writes, slow down' });
    return;
  }
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, config.limits.writeRatePerMin - b.count)));
  next();
}

/** Exposed for tests and /api/status. */
export function rateLimitHealth() {
  const now = Date.now();
  let active = 0;
  for (const b of buckets.values()) if (now < b.resetAt) active++;
  return { tracked: buckets.size, active };
}
