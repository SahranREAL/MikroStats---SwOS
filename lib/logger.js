'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.log.level] !== undefined ? LEVELS[config.log.level] : LEVELS.info;

const file = path.join(config.logDir, 'mikrostats.log');

let stream = null;
let written = 0;
// Bounded map of last-log timestamps, used to rate-limit repetitive errors.
const throttleState = new Map();

function open() {
  if (stream) return stream;
  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    written = fs.existsSync(file) ? fs.statSync(file).size : 0;
    stream = fs.createWriteStream(file, { flags: 'a' });
    // A logging failure must never escalate into an application failure.
    stream.on('error', () => { stream = null; });
    return stream;
  } catch {
    return null;
  }
}

function rotate() {
  if (!stream) return;
  try {
    stream.end();
  } catch { /* ignore */ }
  stream = null;
  for (let i = config.log.maxFiles - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  written = 0;
}

function write(level, args) {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${args.map(fmt).join(' ')}\n`;
  const s = open();
  if (!s) return;
  if (written + line.length > config.log.maxBytes) rotate();
  written += line.length;
  s.write(line);
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return '[unserialisable]'; }
  }
  return String(v);
}

const logger = {
  error: (...a) => write('error', a),
  warn: (...a) => write('warn', a),
  info: (...a) => write('info', a),
  debug: (...a) => write('debug', a),
  /** Rate-limited error logging: polling loops can fail thousands of times a day. */
  throttleError(key, message, minGapMs = 60000) {
    const now = Date.now();
    const last = throttleState.get(key) || 0;
    if (now - last < minGapMs) return;
    if (throttleState.size > 32) throttleState.clear();
    throttleState.set(key, now);
    logger.error(message, `(${key})`);
  },
  /**
   * Flush and release the log file. Returns a Promise because the write stream
   * buffers: calling process.exit() right after end() would discard the last
   * lines (typically the shutdown messages, which are the ones you need most).
   */
  close() {
    const s = stream;
    stream = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      try { s.end(); } catch { finish(); return; }
      s.once('finish', finish);
      s.once('close', finish);
      s.once('error', finish);
      // A wedged filesystem must not hold the process open during shutdown.
      const t = setTimeout(finish, 1000);
      if (t.unref) t.unref();
    });
  },
};

module.exports = logger;
