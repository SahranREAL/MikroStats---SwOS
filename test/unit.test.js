/**
 * Unit tests for the correctness-critical logic: parser, SwOS path
 * negotiation, rate math, status machine and the multi-resolution history.
 *
 * Run with `npm test` (node --test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrostats-unit-'));
process.env.DATA_DIR = TMP;
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.LOG_TARGET = 'stdout';
process.env.LOG_LEVEL = 'error';

const { parseSwos, extractObject, ParseError } = await import(path.join(ROOT, 'lib/parse.js'));
const { SwitchClient, decodeName, counter } = await import(path.join(ROOT, 'lib/swos.js'));
const { Poller } = await import(path.join(ROOT, 'lib/poller.js'));
const { HistoryStore } = await import(path.join(ROOT, 'lib/history.js'));
const { digestHeader } = await import(path.join(ROOT, 'lib/net.js'));
const config = (await import(path.join(ROOT, 'config.js'))).default;

/* ------------------------------------------------------------------ parser */

test('parses real /!stats.b shape', () => {
  const o = parseSwos('{rb:[0x0001c4eb,0x2],rbh:[0,0],tb:[0xff,0]}');
  assert.deepEqual(o.rb, [0x1c4eb, 2]);
  assert.equal(o.rbh[0], 0);
  assert.equal(o.tb[0], 255);
});

test('parses real /link.b shape', () => {
  const o = extractObject('  \n{comb:0x0,en:0x03ffffff,lnk:0x00000001,spd:[2,7],nm:["506f727431","53"]}');
  assert.equal(o.en, 67108863);
  assert.equal(o.lnk, 1);
  assert.deepEqual(o.spd, [2, 7]);
  assert.equal(decodeName(o.nm[0]), 'Port1');
});

test('parses decimals, negatives, whitespace, nested', () => {
  const o = parseSwos('{a:1.5,b:-2,c:[ 1 , 2 ],d:{e:3}}');
  assert.equal(o.a, 1.5);
  assert.equal(o.b, -2);
  assert.deepEqual(o.c, [1, 2]);
  assert.equal(o.d.e, 3);
});

test('REJECTS code execution', () => {
  const evil = [
    '{a: (globalThis.PWNED=1)}',
    '{a: (function(){return 1})()}',
    '{a: this}',
    '{a: 1, b: require("fs")}',
    '{constructor: 1}',
    '{a: 1} trailing',
    '{a: 1} {b: 2}',
    '{a: `x${process.env}`}',
    '{a: 1/0}',
    '{toString: 1}',
    '{"a":1}',
    '{a: 0x}',
    '{a: [1,2',
  ];
  for (const e of evil) {
    assert.throws(() => parseSwos(e), ParseError, `should reject: ${e}`);
  }
  assert.equal(globalThis.PWNED, undefined);
});

test('REJECTS prototype-pollution keys', () => {
  // __proto__ does not match KEY_RE (starts with _), so it is rejected outright.
  assert.throws(() => parseSwos('{__proto__:1}'), ParseError);
  assert.throws(() => parseSwos('{constructor:1}'), ParseError);
  assert.throws(() => parseSwos('{prototype:1}'), ParseError);
  // Parsed objects have a null prototype, so nothing can leak into Object.prototype.
  const o = parseSwos('{rb:[1]}');
  assert.equal(Object.getPrototypeOf(o), null);
  assert.equal({}.polluted, undefined);
});

test('REJECTS oversized payloads', () => {
  assert.throws(() => parseSwos(`{a:[${'1,'.repeat(5000)}1]}`), ParseError);
  assert.throws(() => parseSwos(`{${'a:1,'.repeat(300)}a:1}`), ParseError);
});

test('parses 64-bit counters as high*2^32+low', () => {
  const raw = { rb: [1, 0], rbh: [1, 0] };
  assert.equal(counter('rb', 'rbh', raw, 0), 4294967297);
  const big = { rb: [0xffffffff, 0], rbh: [0xffffffff, 0] };
  assert.equal(counter('rb', 'rbh', big, 0), 0xffffffff * 4294967296 + 0xffffffff);
});

test('decodeName rejects non-ASCII / malformed hex', () => {
  assert.equal(decodeName('506f7274'), 'Port');
  assert.equal(decodeName('00ff41'), null);
  assert.equal(decodeName('zz'), null);
  assert.equal(decodeName('abc'), null);
  assert.equal(decodeName(''), '');
  assert.equal(decodeName(null), null);
  assert.equal(decodeName(123), null);
});

/* ------------------------------------------------------------ digest header */

test('digest header implements RFC 7616 MD5 qop=auth', () => {
  const challenge = { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth', algorithm: 'MD5' };
  const h = digestHeader({ challenge, username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html' });
  assert.ok(h.startsWith('Digest '));
  assert.ok(h.includes('username="Mufasa"'));
  assert.ok(h.includes('realm="testrealm@host.com"'));
  assert.ok(h.includes('uri="/dir/index.html"'));
  assert.ok(h.includes('qop=auth'));
  assert.ok(h.includes('nc=00000001'));

  // Recompute the response independently: md5(ha1:nonce:nc:cnonce:qop:ha2)
  const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
  const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
  const ha2 = md5('GET:/dir/index.html');
  const cnonce = h.match(/cnonce="([^"]+)"/)[1];
  const expected = md5(`${ha1}:${challenge.nonce}:00000001:${cnonce}:auth:${ha2}`);
  assert.equal(h.match(/response="([0-9a-f]{32})"/)[1], expected);
});

/* ------------------------------------------------------------ rate + resets */

function makePoller() {
  const store = new HistoryStore(path.join(TMP, 'h1'));
  return new Poller(store, {
    id: 'unit',
    driver: {
      host: 'test',
      device: { name: 'unit' },
      async readCounters() { return { ports: [] }; },
      async listPorts() { return [{ index: 1, name: 'P', link: true, speed: 1e9, duplex: 'full', sfp: false }]; },
    },
  });
}
/** Build a normalised counter payload: values[i] = {rx, tx} for port i. */
function mk(values) {
  return {
    ports: values.map((v, i) => ({ index: i + 1, rxBytes: v.rx, txBytes: v.tx })),
  };
}
const P1 = (rx, tx) => [{ rx, tx }];

test('rate uses REAL elapsed time, not the nominal interval', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 1000000);
  // 1 MiB in 10 s  =>  1048576 * 8 / 10 = 838860.8 bps
  const s = p.buildSample(mk(P1(1048576, 0)), 1000000 + 10000);
  assert.ok(Math.abs(s.inBps - 838861) <= 1, `10s: got ${s.inBps}`);
  assert.equal(s.outBps, 0);
  // The same 1 MiB spread over 20 s must halve the rate.
  const s2 = p.buildSample(mk(P1(2097152, 0)), 1010000 + 20000);
  assert.ok(Math.abs(s2.inBps - 419430) <= 1, `20s: got ${s2.inBps}`);
});

test('irregular poll spacing is handled (3s then 47s)', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 0);
  const s = p.buildSample(mk(P1(940000, 0)), 47000);
  assert.ok(Math.abs(s.inBps - 160000) <= 1, `got ${s.inBps}`);
});

test('first sample reports counters but zero rate', () => {
  const p = makePoller();
  const s = p.buildSample(mk(P1(500, 700)), 1000);
  assert.equal(s.first, true);
  assert.equal(s.inBps, 0);
  assert.equal(s.outBps, 0);
  assert.equal(s.totalRxBytes, 500);
  assert.equal(s.totalTxBytes, 700);
});

test('counter reset yields 0 for that port, never a huge spike', () => {
  const p = makePoller();
  p.buildSample(mk([{ rx: 50_000_000, tx: 0 }]), 1000);
  // device rebooted: the counter restarts far below the previous reading
  const s = p.buildSample(mk([{ rx: 1000, tx: 0 }]), 4000);
  assert.equal(s.ports[0].inBps, 0, `spike on reset: ${s.ports[0].inBps}`);
  assert.equal(s.inBps, 0, `global spike on reset: ${s.inBps}`);
  // the post-reset reading becomes the new baseline
  const s2 = p.buildSample(mk([{ rx: 300_000 + 1000, tx: 0 }]), 7000);
  assert.ok(Math.abs(s2.ports[0].inBps - 800_000) <= 1, `got ${s2.ports[0].inBps}`);
});

test('a reset on one port does not poison the others', () => {
  const p = makePoller();
  p.buildSample(mk([{ rx: 50_000_000, tx: 0 }, { rx: 0, tx: 0 }]), 1000);
  const s = p.buildSample(mk([{ rx: 10, tx: 0 }, { rx: 30_000, tx: 0 }]), 4000);
  assert.equal(s.ports[0].inBps, 0);
  assert.ok(Math.abs(s.ports[1].inBps - 80_000) <= 1, `got ${s.ports[1].inBps}`);
});

test('outage does not inflate the rate on recovery', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 1000);
  // 60 s gap, 600 KiB transferred => 600*1024*8/60 = 81920 bps
  const s = p.buildSample(mk(P1(614400, 0)), 61000);
  assert.ok(Math.abs(s.inBps - 81920) <= 1, `got ${s.inBps}`);
});

test('global = sum of ports', () => {
  const p = makePoller();
  p.buildSample(mk([{ rx: 0, tx: 0 }, { rx: 0, tx: 0 }, { rx: 0, tx: 0 }]), 1000);
  const s = p.buildSample(mk([
    { rx: 0, tx: 0 }, { rx: 100000, tx: 50000 }, { rx: 200000, tx: 25000 },
  ]), 4000);
  const sumIn = s.ports.reduce((a, x) => a + x.inBps, 0);
  const sumOut = s.ports.reduce((a, x) => a + x.outBps, 0);
  assert.equal(s.inBps, sumIn, 'global IN must equal the sum of ports');
  assert.equal(s.outBps, sumOut, 'global OUT must equal the sum of ports');
  assert.ok(Math.abs(s.inBps - 800000) <= 1, `in=${s.inBps}`);
  assert.ok(Math.abs(s.outBps - 200000) <= 1, `out=${s.outBps}`);
});

test('cumulative totals accumulate across ports', () => {
  const p = makePoller();
  const s = p.buildSample(mk([{ rx: 10, tx: 1 }, { rx: 20, tx: 2 }, { rx: 30, tx: 3 }]), 1000);
  assert.equal(s.totalRxBytes, 60);
  assert.equal(s.totalTxBytes, 6);
});

test('zero elapsed time is ignored (no Infinity/NaN)', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 1000);
  const s = p.buildSample(mk(P1(999999, 0)), 1000);
  assert.ok(Number.isFinite(s.inBps) && s.inBps >= 0, `got ${s.inBps}`);
});

/* ------------------------------------------------------------------ status */

test('status machine: connected -> degraded -> disconnected -> connected', () => {
  const p = makePoller();
  p.recomputeStatus();
  assert.equal(p.status, 'disconnected'); // never succeeded: must not claim live
  p.counters.successful = 1; p.lastSuccessAt = Date.now();
  p.recomputeStatus();
  assert.equal(p.status, 'connected');
  p.counters.consecutiveErrors = 1;
  p.recomputeStatus();
  assert.equal(p.status, 'degraded');
  assert.equal(p.stale, true);
  p.counters.consecutiveErrors = 5;
  p.recomputeStatus();
  assert.equal(p.status, 'disconnected');
  p.counters.consecutiveErrors = 0;
  p.recomputeStatus();
  assert.equal(p.status, 'connected');
  assert.equal(p.stale, false);
});

test('stats payload is never falsely live', () => {
  const p = makePoller();
  const empty = p.statsPayload();
  assert.equal(empty.stale, true);
  assert.equal(empty.inBps, 0);
  assert.deepEqual(empty.ports, []);
});

test('backoff grows exponentially and is capped', () => {
  const p = makePoller();
  p.lastSuccessAt = Date.now();
  p.counters.consecutiveErrors = 1;
  p.onFailure(new Error('x'));
  const first = p.backoffMs;
  assert.ok(first >= p.intervalMs, `first backoff ${first}`);
  for (let i = 0; i < 10; i++) p.onFailure(new Error('x'));
  assert.ok(p.backoffMs <= config.poll.backoffMaxMs, `capped at ${p.backoffMs}`);
  assert.ok(p.backoffMs >= first, 'backoff must not shrink');
});

/* ------------------------------------------- swos endpoint path negotiation */

const STATS_BODY = '{rb:[100,200],rbh:[0,0],tb:[300,400],tbh:[0,0]}';
const LINK_BODY = '{prt:26,en:0x03ffffff,lnk:0x00000003,spd:[2,2],nm:["57414e","427572656175"],sfpo:24}';

/** Stub only the transport: lib/net.js is exercised for real elsewhere. */
function stubClient(routes, hits) {
  const c = new SwitchClient({ host: 'stub.test' });
  c.fetchJson = async (p) => {
    hits.push(p);
    const r = routes[p];
    const status = r ? (r.status || 200) : 404;
    const body = r ? (r.body || '') : '';
    if (status >= 300 && status < 400) {
      const e = new Error(`redirect -> ${r.location || '(no location)'}`);
      e.code = 'REDIRECT'; e.status = status; throw e;
    }
    if (status < 200 || status >= 300) {
      const e = new Error(`HTTP ${status}`); e.code = 'HTTP_STATUS'; e.status = status; throw e;
    }
    if (/^\s*<(!doctype|html)/i.test(body)) {
      const e = new Error('html page'); e.code = 'HTML_RESPONSE'; throw e;
    }
    return extractObject(body);
  };
  return c;
}

test('swos falls back from legacy /!stats.b to /stats.b', async () => {
  const hits = [];
  const c = stubClient({
    '/!stats.b': { status: 303, location: '/index.html' },
    '/index.html': { status: 200, body: '<!doctype html><html></html>' },
    '/stats.b': { status: 200, body: STATS_BODY },
  }, hits);
  const raw = await c.fetchStats();
  assert.deepEqual(raw.rb, [100, 200]);
  assert.deepEqual(raw.tb, [300, 400]);
  assert.equal(c.statsPathWorking, '/stats.b');
  hits.length = 0;
  await c.fetchStats();
  assert.deepEqual(hits, ['/stats.b']);
});

test('swos falls back when the legacy path answers with the HTML UI', async () => {
  const hits = [];
  const c = stubClient({
    '/!stats.b': { status: 200, body: '<!doctype html><html>login</html>' },
    '/stats.b': { status: 200, body: STATS_BODY },
  }, hits);
  const raw = await c.fetchStats();
  assert.deepEqual(raw.rb, [100, 200]);
  assert.equal(c.statsPathWorking, '/stats.b');
});

test('swos tries the legacy path when the new one is missing (old firmware)', async () => {
  const hits = [];
  const c = stubClient({ '/stats.b': { status: 404 }, '/!stats.b': { status: 200, body: STATS_BODY } }, hits);
  const raw = await c.fetchStats();
  assert.deepEqual(raw.rb, [100, 200]);
  assert.equal(c.statsPathWorking, '/!stats.b');
});

test('swos does not try another path on auth failure', async () => {
  const hits = [];
  const c = stubClient({ '/stats.b': { status: 401 }, '/!stats.b': { status: 200, body: STATS_BODY } }, hits);
  await assert.rejects(() => c.fetchStats(), (err) => err.code === 'HTTP_STATUS' && err.status === 401);
  assert.deepEqual(hits, ['/stats.b'], 'a 401 must not trigger a path probe');
});

test('swos link endpoint keeps its payload shape', async () => {
  const hits = [];
  const c = stubClient({ '/link.b': { status: 200, body: LINK_BODY } }, hits);
  const raw = await c.fetchLinks();
  assert.equal(raw.prt, 26);
  assert.deepEqual(raw.spd, [2, 2]);
  assert.equal(c.portMeta(0).name, 'WAN');
  assert.equal(c.portMeta(1).speed, 1e9);
  assert.equal(c.portMeta(1).sfp, false);   // sfpo=24: ports 25+ are SFP
  c.links.sfpo = 1;
  assert.equal(c.portMeta(1).sfp, true);
});
