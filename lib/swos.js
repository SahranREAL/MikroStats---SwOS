'use strict';

const DigestFetch = require('digest-fetch').default;
const config = require('../config');
const logger = require('./logger');
const { extractObject } = require('./parse');

/**
 * SwOS link speed codes (reverse engineered, consistent with the CSS326).
 * Values are bits per second; null means "no link / unknown".
 */
const SPEED_BY_CODE = {
  0: null,
  1: 100e6,
  2: 1e9,
  3: 10e9,
  4: null,
  5: 1e9,
  6: 1e9,
  7: null,
};

const U32 = 4294967296;

/**
 * Data endpoints, newest firmware first. SwOS 2.19 dropped the legacy "!"
 * prefix (those paths now 303-redirect to the web UI), older releases only
 * answer the prefixed ones - so both are tried until one answers.
 */
const STATS_FALLBACKS = ['/stats.b', '/!stats.b'];
const LINK_FALLBACKS = ['/link.b'];

/** "This path does not exist on this firmware" vs "switch unreachable / bad credentials". */
function isEndpointError(err) {
  if (!err) return false;
  if (err.code === 'REDIRECT' || err.code === 'HTML_RESPONSE') return true;
  return err.code === 'HTTP_STATUS' && (err.status === 403 || err.status === 404 || err.status === 405);
}

function counter(lowKey, highKey, raw, index) {
  const lo = raw[lowKey] && Number.isFinite(raw[lowKey][index]) ? raw[lowKey][index] : 0;
  const hi = highKey && raw[highKey] && Number.isFinite(raw[highKey][index]) ? raw[highKey][index] : 0;
  return (lo >>> 0) + (hi >>> 0) * U32;
}

function scalar(raw, key) {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function decodeName(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  if (hex.length > 64) return null;
  const buf = Buffer.from(hex, 'hex');
  // Port names must be printable ASCII; anything else is not a name we trust.
  for (const b of buf) if (b < 0x20 || b > 0x7e) return null;
  return buf.toString('ascii');
}

class SwitchClient {
  constructor(opts = {}) {
    const sw = config.switch;
    this.host = opts.host || sw.host;
    this.base = `http://${this.host}`;
    this.statsPath = sw.statsPath;
    this.linkPath = sw.linkPath;
    this.timeoutMs = sw.timeoutMs;
    this.client = new DigestFetch(sw.username, sw.password, { basic: false });
    this.stats = null;   // last raw counters
    this.links = null;   // last raw link data
    this.linksAt = 0;    // epoch ms of the last successful /link.b read
    // Path that actually answered on this firmware, resolved on first poll.
    this.statsPathWorking = null;
    this.linkPathWorking = null;
  }

  async fetchJson(path) {
    // Redirects are never followed: on SwOS 2.19+ an unknown path 303s to the
    // HTML web UI, which would silently replace the payload with a login page.
    const res = await this.client.fetch(this.base + path, {
      timeout: this.timeoutMs,
      headers: { accept: 'text/plain' },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers && res.headers.get ? res.headers.get('location') : null;
      const err = new Error(`switch redirected ${path} -> ${location || '(no location)'} (endpoint unknown on this firmware?)`);
      err.code = 'REDIRECT';
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} on ${path}`);
      err.code = 'HTTP_STATUS';
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    if (!text || text.length === 0) {
      const err = new Error('empty response');
      err.code = 'EMPTY_RESPONSE';
      throw err;
    }
    if (/^\s*<(!doctype|html)/i.test(text)) {
      const err = new Error(`switch returned an HTML page for ${path} (auth failure?)`);
      err.code = 'HTML_RESPONSE';
      throw err;
    }
    return extractObject(text);
  }

  /**
   * Tries the remembered path, then the configured one, then the firmware
   * alternates. Only endpoint-shaped failures trigger another path: a timeout
   * or a 401 means the switch is unreachable or rejects the credentials, and
   * retrying another path would only double the load on it.
   */
  async fetchPath(kind, primary, fallbacks) {
    const remembered = kind === 'stats' ? this.statsPathWorking : this.linkPathWorking;
    const candidates = [...new Set([remembered, primary, ...fallbacks].filter(Boolean))];
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        const raw = await this.fetchJson(candidate);
        if (remembered !== candidate) {
          logger.info(`swos ${kind} endpoint: ${candidate}`);
          if (kind === 'stats') this.statsPathWorking = candidate;
          else this.linkPathWorking = candidate;
        }
        return raw;
      } catch (err) {
        lastErr = err;
        if (!isEndpointError(err)) throw err;
        logger.throttleError('swos-paths', `swos ${kind}: ${candidate} unusable (${err.message})`, 300000);
      }
    }
    throw lastErr;
  }

  /** Raw port counters. Throws on transport / protocol errors. */
  async fetchStats() {
    const raw = await this.fetchPath('stats', this.statsPath, STATS_FALLBACKS);
    if (!Array.isArray(raw.rb) || !Array.isArray(raw.tb)) {
      const err = new Error('unexpected stats payload (missing rb/tb arrays)');
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
    const ports = Math.max(raw.rb.length, raw.tb.length);
    if (ports === 0 || ports > 512) {
      const err = new Error(`implausible port count: ${ports}`);
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
    this.stats = raw;
    return raw;
  }

  /** Port names / link state / speed. */
  async fetchLinks() {
    const raw = await this.fetchPath('link', this.linkPath, LINK_FALLBACKS);
    if (!raw.prt || !Array.isArray(raw.spd)) {
      const err = new Error('unexpected link payload');
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
    this.links = raw;
    this.linksAt = Date.now();
    return raw;
  }

  /**
   * Normalise the last known link data into a per-port descriptor list.
   * Never throws: link data is optional, traffic must keep working without it.
   */
  portMeta(index) {
    const raw = this.links;
    if (!raw) return { name: `Port${index + 1}`, link: null, speed: null, duplex: null, enabled: null, sfp: false };

    const up = raw.lnk !== undefined ? (scalar(raw, 'lnk') >>> index & 1) === 1 : null;
    const en = raw.en !== undefined ? (scalar(raw, 'en') >>> index & 1) === 1 : null;
    const dpx = raw.dpx !== undefined ? (scalar(raw, 'dpx') >>> index & 1) === 1 : null;
    const an = raw.an !== undefined ? (scalar(raw, 'an') >>> index & 1) === 1 : null;
    const name = Array.isArray(raw.nm) ? decodeName(raw.nm[index]) : null;
    const code = Array.isArray(raw.spd) ? raw.spd[index] : undefined;
    const sfpStart = Number.isFinite(raw.sfpo) ? raw.sfpo : Number.MAX_SAFE_INTEGER;

    return {
      name: name || `Port${index + 1}`,
      link: up,
      speed: code !== undefined && Object.prototype.hasOwnProperty.call(SPEED_BY_CODE, code) ? SPEED_BY_CODE[code] : null,
      duplex: dpx === null ? null : (dpx ? 'full' : 'half'),
      autoNeg: an,
      enabled: en,
      sfp: index >= sfpStart,
    };
  }

  /** Rebuilds port identity from whichever data is freshest. */
  describePorts(count) {
    const total = count || (this.stats ? this.stats.rb.length : 0);
    const out = [];
    for (let i = 0; i < total; i++) out.push(this.portMeta(i));
    return out;
  }

  logError(err, context) {
    logger.throttleError(context, `swos ${context} failed: ${err.message}`, 120000);
  }
}

module.exports = { SwitchClient, SPEED_BY_CODE, decodeName, counter };
