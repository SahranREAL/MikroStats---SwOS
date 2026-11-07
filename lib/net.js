/**
 * Minimal HTTP client built on node:http / node:https.
 *
 * Why not `fetch` or a library: we need (a) a keep-alive agent shared across
 * polls, (b) hard timeouts via AbortSignal.timeout, (c) HTTP Digest (SwOS) and
 * Basic (RouterOS REST) without pulling a dependency, and (d) redirects never
 * followed silently (SwOS 303s unknown paths to its HTML login page).
 *
 * One instance per process is enough: the agent pools sockets per origin.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const agents = new Map();

/* ------------------------------------------------------------------ metrics
 * Process-wide counters for the device-facing traffic. They exist so the
 * dashboard can answer "how many requests per minute do we really make?"
 * without logging anything per poll (a log line per tick would be the
 * noisiest I/O of all).
 */
const io = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0,
  responseBytes: 0,
  perHost: new Map(),   // "host:port" -> {requests, errors, bytes}
};

const PER_HOST_MAX = 128;

function hostSlot(url) {
  const key = url.host;
  let slot = io.perHost.get(key);
  if (!slot) {
    if (io.perHost.size >= PER_HOST_MAX) return null;   // bounded, never leaks
    slot = { requests: 0, errors: 0, bytes: 0 };
    io.perHost.set(key, slot);
  }
  return slot;
}

/** Snapshot of the device-facing traffic (cumulative since process start). */
export function ioStats() {
  const perHost = [];
  for (const [host, s] of io.perHost) perHost.push({ host, ...s });
  perHost.sort((a, b) => b.requests - a.requests);
  return {
    startedAt: io.startedAt,
    uptimeSec: Math.round((Date.now() - io.startedAt) / 1000),
    requests: io.requests,
    errors: io.errors,
    responseBytes: io.responseBytes,
    perHost,
  };
}

/** Reset the counters (tests and before a measurement window). */
export function resetIoStats() {
  io.startedAt = Date.now();
  io.requests = 0;
  io.errors = 0;
  io.responseBytes = 0;
  io.perHost.clear();
}

function agentFor(protocol, maxSockets) {
  const key = `${protocol}:${maxSockets}`;
  let agent = agents.get(key);
  if (!agent) {
    const Ctor = protocol === 'https:' ? https.Agent : http.Agent;
    agent = new Ctor({
      keepAlive: true,
      maxSockets,
      maxFreeSockets: 4,
      // Reap idle sockets: a switch reboot must not leave a stale connection.
      keepAliveMsecs: 15000,
      scheduling: 'fifo',
    });
    agents.set(key, agent);
  }
  return agent;
}

/** Close every pooled socket (used by tests and by shutdown). */
export function closeAgents() {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

/* ------------------------------------------------------------------ digest */

function parseChallenge(header) {
  if (!header || !/^\s*Digest\s+/i.test(header)) return null;
  const params = {};
  const body = header.replace(/^\s*Digest\s+/i, '');
  const re = /([a-zA-Z_]+)=("([^"]*)"|[^,]*)\s*(?:,|$)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    params[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
  }
  return params;
}

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

/** RFC 7616 Digest response (MD5 and MD5-sess, qop=auth or no qop). */
export function digestHeader({ challenge, username, password, method, uri }) {
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  if (!realm || !nonce) return null;

  const algorithm = (challenge.algorithm || 'MD5').toUpperCase();
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const qop = (challenge.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;

  let ha1 = md5(`${username}:${realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);

  let response;
  if (qop) response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  else response = md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm === 'MD5-SESS' ? 'MD5-sess' : 'MD5'}`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

/* ------------------------------------------------------------------ client */

function encodeQuery(url) {
  return url.pathname + (url.search || '');
}

/** Last digest challenge per origin: lets us authenticate on the first try. */
const challenges = new Map();

/** Drop cached credentials state (used by tests). */
export function clearAuthCache() {
  challenges.clear();
}

/**
 * Perform one HTTP(S) request.
 *
 * @param {object} opts
 * @param {string} opts.url absolute URL
 * @param {string} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @param {string|Buffer} [opts.body]
 * @param {number} [opts.timeoutMs] hard deadline for headers + body
 * @param {{username:string,password:string,mode:'digest'|'basic'}} [opts.auth]
 * @param {'manual'|'error'} [opts.redirect] 'manual' returns 3xx as-is
 * @param {number} [opts.maxBytes]
 * @returns {Promise<{status:number, headers:object, body:string, url:string}>}
 */
export function request(opts) {
  const {
    url: rawUrl,
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 8000,
    auth = null,
    redirect = 'manual',
    maxBytes = MAX_RESPONSE_BYTES,
    maxSockets = 4,
  } = opts;

  const once = (url, authorization) => singleRequest({
    url, method, headers, body, timeoutMs, authorization, redirect, maxBytes, maxSockets,
  });

  return (async () => {
    const url = new URL(rawUrl);
    const uri = encodeQuery(url);

    if (!auth) return once(url, null);

    if (auth.mode === 'basic') {
      const basic = 'Basic ' + Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
      let res = await once(url, basic);
      if (res.status === 401) {
        // Some stacks answer Basic only after an explicit challenge.
        const challenge = res.headers['www-authenticate'];
        if (challenge && /basic/i.test(challenge)) return res;
      }
      return res;
    }

    if (auth.mode !== 'digest') return once(url, null);

    const build = (challenge) => digestHeader({
      challenge, username: auth.username, password: auth.password || '', method, uri,
    });

    // 1. Pre-authenticate with the remembered challenge (SwOS keeps nonces
    //    valid across requests, so this turns 2 requests into 1 per poll).
    const cached = challenges.get(url.origin);
    if (cached) {
      const res = await once(url, build(cached));
      if (res.status !== 401) return res;
      const fresh = parseChallenge(res.headers['www-authenticate']);
      if (!fresh) return res;
      challenges.set(url.origin, fresh);
      return once(url, build(fresh));
    }

    // 2. Cold start: challenge, then authenticated retry.
    const res = await once(url, null);
    if (res.status !== 401) return res;
    const fresh = parseChallenge(res.headers['www-authenticate']);
    if (!fresh) return res;
    challenges.set(url.origin, fresh);
    return once(url, build(fresh));
  })();
}

function singleRequest({ url, method, headers, body, timeoutMs, authorization, redirect, maxBytes, maxSockets }) {
  io.requests += 1;
  const slot = hostSlot(url);
  if (slot) slot.requests += 1;
  const countError = () => {
    io.errors += 1;
    if (slot) slot.errors += 1;
  };
  const countBytes = (n) => {
    io.responseBytes += n;
    if (slot) slot.bytes += n;
  };
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === null || body === undefined ? null : Buffer.from(body);
    // SwOS runs a minimal HTTP stack that matches header NAMES case-sensitively
    // ("authorization" is rejected, "Authorization" is not), so every header we
    // add ourselves uses canonical capitalisation. Callers are expected to do
    // the same.
    const finalHeaders = { ...headers, 'Accept-Encoding': 'identity' };
    if (authorization) finalHeaders.Authorization = authorization;
    if (payload) finalHeaders['Content-Length'] = String(payload.length);

    // Hard deadline: connect + headers + body, one signal for the whole request.
    const signal = AbortSignal.timeout(timeoutMs);

    let req;
    try {
      req = lib.request(url, {
        method,
        headers: finalHeaders,
        agent: agentFor(url.protocol, maxSockets),
        signal,
      }, (res) => {
        const chunks = [];
        let size = 0;
        let settled = false;

        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            const err = new Error(`response exceeds ${maxBytes} bytes`);
            err.code = 'RESPONSE_TOO_LARGE';
            countError();
            finish(reject, err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          countBytes(size);
          finish(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            url: url.toString(),
          });
        });
        res.on('error', (err) => { countError(); finish(reject, err); });
        res.on('aborted', () => {
          const err = new Error('response aborted');
          err.code = 'ABORTED';
          countError();
          finish(reject, err);
        });
      });
    } catch (err) {
      countError();
      reject(err);
      return;
    }

    req.on('error', (err) => {
      if (err && err.name === 'TimeoutError') {
        const e = new Error(`timeout after ${timeoutMs}ms`);
        e.code = 'TIMEOUT';
        countError();
        reject(e);
        return;
      }
      countError();
      reject(err);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

export default { request, digestHeader, closeAgents, ioStats, resetIoStats };
