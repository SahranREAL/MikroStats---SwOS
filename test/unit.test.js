/** Unit tests for the correctness-critical logic. */
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
process.env.LOG_DIR = path.join(os.tmpdir(), 'mikrostats-test-logs');
const assert = require('assert');
const P = ROOT;
const { parseSwos, extractObject, ParseError } = require(`${P}/lib/parse`);
const { RingBuffer } = require(`${P}/lib/ring`);
const { SwitchClient, decodeName, counter } = require(`${P}/lib/swos`);
const { Poller } = require(`${P}/lib/poller`);
const { Store } = require(`${P}/lib/store`);

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { fail++; console.log('FAIL ', name, '::', e.message); }
}
async function tAsync(name, fn) {
  try { await fn(); pass++; console.log('PASS ', name); }
  catch (e) { fail++; console.log('FAIL ', name, '::', e.message); }
}

/* ------------------------------------------------------------------ parser */

t('parses real /!stats.b shape', () => {
  const o = parseSwos('{rb:[0x0001c4eb,0x2],rbh:[0,0],tb:[0xff,0]}');
  assert.deepStrictEqual(o.rb, [0x1c4eb, 2]);
  assert.strictEqual(o.rbh[0], 0);
  assert.strictEqual(o.tb[0], 255);
});

t('parses real /link.b shape', () => {
  const o = extractObject('  \n{comb:0x0,en:0x03ffffff,lnk:0x00000001,spd:[2,7],nm:["506f727431","53"]}');
  assert.strictEqual(o.en, 67108863);
  assert.strictEqual(o.lnk, 1);
  assert.deepStrictEqual(o.spd, [2, 7]);
  assert.strictEqual(decodeName(o.nm[0]), 'Port1');
});

t('parses decimals, negatives, whitespace, nested', () => {
  const o = parseSwos('{a:1.5,b:-2,c:[ 1 , 2 ],d:{e:3}}');
  assert.strictEqual(o.a, 1.5);
  assert.strictEqual(o.b, -2);
  assert.deepStrictEqual(o.c, [1, 2]);
  assert.strictEqual(o.d.e, 3);
});

t('REJECTS code execution', () => {
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
  assert.strictEqual(globalThis.PWNED, undefined);
});

t('REJECTS prototype-pollution keys', () => {
  // __proto__ does not match KEY_RE (starts with _), so it is rejected outright.
  assert.throws(() => parseSwos('{__proto__:1}'), ParseError);
  assert.throws(() => parseSwos('{constructor:1}'), ParseError);
  assert.throws(() => parseSwos('{prototype:1}'), ParseError);
  // Parsed objects have a null prototype, so nothing can leak into Object.prototype.
  const o = parseSwos('{rb:[1]}');
  assert.strictEqual(Object.getPrototypeOf(o), null);
  assert.strictEqual({}.polluted, undefined);
});

t('REJECTS oversized payloads', () => {
  assert.throws(() => parseSwos(`{a:[${'1,'.repeat(5000)}1]}`), ParseError);
  assert.throws(() => parseSwos(`{${'a:1,'.repeat(300)}a:1}`), ParseError);
});

t('parses 64-bit counters as high*2^32+low', () => {
  const raw = { rb: [1, 0], rbh: [1, 0] };
  assert.strictEqual(counter('rb', 'rbh', raw, 0), 4294967297);
  const big = { rb: [0xffffffff, 0], rbh: [0xffffffff, 0] };
  assert.strictEqual(counter('rb', 'rbh', big, 0), 0xffffffff * 4294967296 + 0xffffffff);
});

/* ------------------------------------------------------------- ring buffer */

t('ring buffer is fixed capacity and ordered', () => {
  const r = new RingBuffer(5, 2);
  for (let i = 0; i < 12; i++) r.push(1000 + i, [i, i * 2]);
  assert.strictEqual(r.capacity, 5);
  assert.strictEqual(r.size, 5);
  assert.strictEqual(r.count, 12);
  const a = r.toArrays();
  assert.deepStrictEqual(a.t, [1007, 1008, 1009, 1010, 1011]);
  assert.deepStrictEqual(a.f0, [7, 8, 9, 10, 11]);
  assert.deepStrictEqual(a.f1, [14, 16, 18, 20, 22]);
  assert.strictEqual(r.last(0), 11);
});

t('ring buffer filters by sinceMs and never grows memory', () => {
  const r = new RingBuffer(4, 1);
  for (let i = 0; i < 1000; i++) r.push(i, [i]);
  assert.strictEqual(r.size, 4);
  assert.strictEqual(r.ts.length, 4);
  assert.deepStrictEqual(r.toArrays(998).t, [998, 999]);
});

t('ring buffer sanitises non-finite values', () => {
  const r = new RingBuffer(3, 2);
  r.push(1, [NaN, Infinity]);
  r.push(2, [5, undefined]);
  assert.deepStrictEqual(r.toArrays().f0, [0, 5]);
  assert.deepStrictEqual(r.toArrays().f1, [0, 0]);
});

/* ------------------------------------------------------------ rate + resets */

function makePoller() {
  const store = { ingest() {}, };
  const p = new Poller(store);
  p.ensurePortRing(2);
  return p;
}
/** Build a raw counter payload: values[i] = {rx, tx} for port i. */
function mk(values) {
  const n = values.length;
  const lo = (v) => v % 4294967296;
  const hi = (v) => Math.floor(v / 4294967296);
  const raw = { rb: [], rbh: [], tb: [], tbh: [] };
  for (const v of values) {
    raw.rb.push(lo(v.rx)); raw.rbh.push(hi(v.rx));
    raw.tb.push(lo(v.tx)); raw.tbh.push(hi(v.tx));
  }
  return raw;
}
const P1 = (rx, tx) => [{ rx, tx }];

t('rate uses REAL elapsed time, not the nominal interval', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 1000000);
  // 1 MiB in 10 s  =>  1048576 * 8 / 10 = 838860.8 bps
  const s = p.buildSample(mk(P1(1048576, 0)), 1000000 + 10000);
  assert.ok(Math.abs(s.inBps - 838861) <= 1, `10s: got ${s.inBps}`);
  assert.strictEqual(s.outBps, 0);
  // The same 1 MiB spread over 20 s must halve the rate.
  const s2 = p.buildSample(mk(P1(2097152, 0)), 1010000 + 20000);
  assert.ok(Math.abs(s2.inBps - 419430) <= 1, `20s: got ${s2.inBps}`);
});

t('irregular poll spacing is handled (3s then 47s)', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 0);
  const s = p.buildSample(mk(P1(940000, 0)), 47000);
  // 940000 * 8 / 47 = 160000.0 bps
  assert.ok(Math.abs(s.inBps - 160000) <= 1, `got ${s.inBps}`);
});

t('first sample reports counters but zero rate', () => {
  const p = makePoller();
  const s = p.buildSample(mk(P1(500, 700)), 1000);
  assert.strictEqual(s.first, true);
  assert.strictEqual(s.inBps, 0);
  assert.strictEqual(s.outBps, 0);
  assert.strictEqual(s.totalRxBytes, 500);
  assert.strictEqual(s.totalTxBytes, 700);
});

t('counter reset yields 0 for that port, never a huge spike', () => {
  const p = makePoller();
  p.buildSample(mk([{ rx: 50_000_000, tx: 0 }]), 1000);
  // switch rebooted: the counter restarts far below the previous reading
  const s = p.buildSample(mk([{ rx: 1000, tx: 0 }]), 4000);
  assert.strictEqual(s.ports[0].inBps, 0, `spike on reset: ${s.ports[0].inBps}`);
  assert.strictEqual(s.inBps, 0, `global spike on reset: ${s.inBps}`);
  assert.ok(s.ports[0].inBps >= 0);
  // the post-reset reading becomes the new baseline
  const s2 = p.buildSample(mk([{ rx: 300_000 + 1000, tx: 0 }]), 7000);
  assert.ok(Math.abs(s2.ports[0].inBps - 800_000) <= 1, `got ${s2.ports[0].inBps}`);
});

t('a reset on one port does not poison the others', () => {
  const p = makePoller();
  p.buildSample(mk([{ rx: 50_000_000, tx: 0 }, { rx: 0, tx: 0 }]), 1000);
  const s = p.buildSample(mk([{ rx: 10, tx: 0 }, { rx: 30_000, tx: 0 }]), 4000);
  assert.strictEqual(s.ports[0].inBps, 0);
  assert.ok(Math.abs(s.ports[1].inBps - 80_000) <= 1, `got ${s.ports[1].inBps}`);
});

t('outage does not inflate the rate on recovery', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 1000);
  // 60 s gap, 600 KiB transferred => 600*1024*8/60 = 81920 bps
  const s = p.buildSample(mk(P1(614400, 0)), 61000);
  assert.ok(Math.abs(s.inBps - 81920) <= 1, `got ${s.inBps}`);
});

t('global = sum of ports (section 23)', () => {
  const p = new Poller({ ingest() {} });
  p.buildSample(mk([{ rx: 0, tx: 0 }, { rx: 0, tx: 0 }, { rx: 0, tx: 0 }]), 1000);
  const s = p.buildSample(mk([
    { rx: 0, tx: 0 }, { rx: 100000, tx: 50000 }, { rx: 200000, tx: 25000 },
  ]), 4000);
  const sumIn = s.ports.reduce((a, x) => a + x.inBps, 0);
  const sumOut = s.ports.reduce((a, x) => a + x.outBps, 0);
  assert.strictEqual(s.inBps, sumIn, 'global IN must equal the sum of ports');
  assert.strictEqual(s.outBps, sumOut, 'global OUT must equal the sum of ports');
  assert.ok(Math.abs(s.inBps - 800000) <= 1, `in=${s.inBps}`);
  assert.ok(Math.abs(s.outBps - 200000) <= 1, `out=${s.outBps}`);
  // flat[] must line up with the port list for the RAM buffer
  assert.strictEqual(s.flat.length, s.ports.length * 2);
  assert.strictEqual(s.flat[2], s.ports[1].inBps);
  assert.strictEqual(s.flat[3], s.ports[1].outBps);
});

t('cumulative totals accumulate across ports', () => {
  const p = makePoller();
  const s = p.buildSample(mk([{ rx: 10, tx: 1 }, { rx: 20, tx: 2 }, { rx: 30, tx: 3 }]), 1000);
  assert.strictEqual(s.totalRxBytes, 60);
  assert.strictEqual(s.totalTxBytes, 6);
});

t('zero elapsed time is ignored (no Infinity/NaN)', () => {
  const p = makePoller();
  p.buildSample(mk(P1(0, 0)), 1000);
  const s = p.buildSample(mk(P1(999999, 0)), 1000);
  assert.ok(Number.isFinite(s.inBps) && s.inBps >= 0, `got ${s.inBps}`);
});

/* ------------------------------------------------------------------ status */

t('status machine: connected -> degraded -> disconnected -> connected', () => {
  const p = makePoller();
  p.recomputeStatus();
  assert.strictEqual(p.status, 'disconnected'); // never succeeded: must not claim live
  p.counters.successful = 1; p.lastSuccessAt = Date.now();
  p.recomputeStatus();
  assert.strictEqual(p.status, 'connected');
  p.counters.consecutiveErrors = 1;
  p.recomputeStatus();
  assert.strictEqual(p.status, 'degraded');
  assert.strictEqual(p.stale, true);
  p.counters.consecutiveErrors = 5;
  p.recomputeStatus();
  assert.strictEqual(p.status, 'disconnected');
  p.counters.consecutiveErrors = 0;
  p.recomputeStatus();
  assert.strictEqual(p.status, 'connected');
  assert.strictEqual(p.stale, false);
});

t('stats payload is never falsely live', () => {
  const p = makePoller();
  const empty = p.statsPayload();
  assert.strictEqual(empty.stale, true);
  assert.strictEqual(empty.inBps, 0);
  assert.deepStrictEqual(empty.ports, []);
});

/* ------------------------------------------------------------------- store */

t('tiered aggregation preserves avg and peak', () => {
  const store = new Store();
  store.ready = true;
  const t0 = 1699999980000; // aligned to both 5s and 30s
  // 6 samples inside ONE 5s bucket
  for (let i = 0; i < 6; i++) store.ingest(t0 + i * 100, 0, i === 5 ? 1000 : 100, 10);
  // 10 more samples inside the SAME 30s bucket, in later 5s children
  for (let i = 0; i < 10; i++) store.ingest(t0 + 5000 + i * 2000, 0, i === 9 ? 2000 : 200, 20);
  const b5 = store.buckets.get(`5:${Math.floor(t0 / 5000) * 5000}:0`);
  assert.strictEqual(b5.n, 6);
  assert.strictEqual(b5.inMax, 1000);
  assert.ok(Math.abs(b5.inSum / 6 - 250) < 1, `avg ${b5.inSum / 6}`);
  const b30 = store.buckets.get(`30:${Math.floor(t0 / 30000) * 30000}:0`);
  assert.ok(b30.inMax >= 2000, '30s bucket must keep the highest peak of its children');
});

t('store bounds open buckets and survives a clock jump', () => {
  const store = new Store();
  store.ready = true;
  for (let i = 0; i < 20000; i++) store.ingest(Date.now() - i * 60000, i % 27, 100, 100);
  assert.ok(store.buckets.size <= 4096, `buckets=${store.buckets.size}`);
});

t('tierFor picks the finest tier that covers the range', () => {
  const store = new Store();
  const tiers = store.tiers;
  assert.strictEqual(store.tierFor(5 * 60e3).res, tiers[0].res);
  assert.strictEqual(store.tierFor(60 * 60e3).res, tiers[0].res);
  assert.strictEqual(store.tierFor(6 * 3600e3).res, tiers[1].res);
  assert.strictEqual(store.tierFor(24 * 3600e3).res, tiers[1].res);
  assert.strictEqual(store.tierFor(7 * 86400e3).res, tiers[2].res);
  assert.strictEqual(store.tierFor(30 * 86400e3).res, tiers[2].res);
  assert.strictEqual(store.tierFor(365 * 86400e3).res, tiers[2].res);
});

t('store.query downsamples and never exceeds maxPoints', () => {
  process.env.DB_FILE = path.join(os.tmpdir(), 'mikrostats-unit-query.db');
  try { require('fs').unlinkSync(path.join(os.tmpdir(), 'mikrostats-unit-query.db')); } catch { /* fresh */ }
  const store = new Store().open();
  const now = Date.now();
  // 2 h of 5s buckets = 1440 rows
  for (let i = 0; i < 1440; i++) store.ingest(now - i * 5000, 0, 1000 + (i % 7) * 100, 500);
  const out = store.query({ port: 0, from: now - 2 * 3600e3, to: now, maxPoints: 100 });
  assert.ok(out.points <= 100, `points=${out.points}`);
  assert.ok(out.points > 10, `points=${out.points}`);
  assert.ok(out.inMax.length === out.in.length);
  assert.ok(out.outMax.length === out.out.length);
  assert.ok(out.t[0] >= now - 2 * 3600e3);
  // The overall peak must survive downsampling.
  assert.ok(out.inMax.reduce((a, b) => Math.max(a, b), 0) >= 1600, 'peak lost');
  // Chronological order.
  for (let i = 1; i < out.t.length; i++) assert.ok(out.t[i] > out.t[i - 1]);
  // Round-trip through SQLite, not just the in-memory path.
  store.flush(true);
  const raw = store.queryRaw({ port: 0, from: now - 2 * 3600e3, to: now + 1000, res: 5 });
  assert.ok(raw.length > 100, `sqlite rows=${raw.length}`);
  assert.ok(raw.every((r) => r.n > 0 && r.in_max >= r.in_avg));
  store.close();
});

/* -------------------------------------------------------------------- misc */

t('decodeName rejects non-ASCII / malformed hex', () => {
  assert.strictEqual(decodeName('506f7274'), 'Port');
  assert.strictEqual(decodeName('00ff41'), null);
  assert.strictEqual(decodeName('zz'), null);
  assert.strictEqual(decodeName('abc'), null);
  assert.strictEqual(decodeName(''), '');
  assert.strictEqual(decodeName(null), null);
  assert.strictEqual(decodeName(123), null);
});

/* ------------------------------------------- swos endpoint path negotiation */

const STATS_BODY = '{rb:[100,200],rbh:[0,0],tb:[300,400],tbh:[0,0]}';
const LINK_BODY = '{prt:26,en:0x03ffffff,lnk:0x00000003,spd:[2,2],nm:["57414e","427572656175"],sfpo:24}';

function stubClient(routes, hits) {
  const c = new SwitchClient();
  c.client = {
    fetch: async (url) => {
      const p = url.replace(`http://${require('../config').switch.host}`, '');
      hits.push(p);
      const r = routes[p];
      if (!r) {
        return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
      }
      return {
        ok: r.status ? r.status < 300 : true,
        status: r.status || 200,
        headers: { get: (h) => (h === 'location' ? (r.location || null) : null) },
        text: async () => r.body || '',
      };
    },
  };
  return c;
}

(async () => {
  // SwOS 2.19: /!stats.b 303s to the web UI, /stats.b answers.
  await tAsync('swos falls back from legacy /!stats.b to /stats.b', async () => {
    const hits = [];
    const c = stubClient({
      '/!stats.b': { status: 303, location: '/index.html' },
      '/index.html': { status: 200, body: '<!doctype html><html></html>' },
      '/stats.b': { status: 200, body: STATS_BODY },
    }, hits);
    const raw = await c.fetchStats();
    assert.deepStrictEqual(raw.rb, [100, 200]);
    assert.deepStrictEqual(raw.tb, [300, 400]);
    assert.strictEqual(c.statsPathWorking, '/stats.b');
    // Once resolved, the next poll only hits the working path.
    hits.length = 0;
    await c.fetchStats();
    assert.deepStrictEqual(hits, ['/stats.b']);
  });

  await tAsync('swos falls back when the legacy path answers with the HTML UI', async () => {
    const hits = [];
    const c = stubClient({
      '/!stats.b': { status: 200, body: '<!doctype html><html>login</html>' },
      '/stats.b': { status: 200, body: STATS_BODY },
    }, hits);
    const raw = await c.fetchStats();
    assert.deepStrictEqual(raw.rb, [100, 200]);
    assert.strictEqual(c.statsPathWorking, '/stats.b');
  });

  await tAsync('swos tries the legacy path when the new one is missing (old firmware)', async () => {
    const hits = [];
    const c = stubClient({
      '/stats.b': { status: 404 },
      '/!stats.b': { status: 200, body: STATS_BODY },
    }, hits);
    const raw = await c.fetchStats();
    assert.deepStrictEqual(raw.rb, [100, 200]);
    assert.strictEqual(c.statsPathWorking, '/!stats.b');
  });

  await tAsync('swos does not try another path on auth failure', async () => {
    const hits = [];
    const c = stubClient({
      '/stats.b': { status: 401 },
      '/!stats.b': { status: 200, body: STATS_BODY },
    }, hits);
    let err = null;
    try { await c.fetchStats(); } catch (e) { err = e; }
    assert.ok(err, 'must throw');
    assert.strictEqual(err.code, 'HTTP_STATUS');
    assert.strictEqual(err.status, 401);
    assert.deepStrictEqual(hits, ['/stats.b'], 'a 401 must not trigger a path probe');
  });

  await tAsync('swos link endpoint is reached and keeps its payload shape', async () => {
    const hits = [];
    const c = stubClient({ '/link.b': { status: 200, body: LINK_BODY } }, hits);
    const raw = await c.fetchLinks();
    assert.strictEqual(raw.prt, 26);
    assert.deepStrictEqual(raw.spd, [2, 2]);
    assert.strictEqual(c.portMeta(0).name, 'WAN');
    assert.strictEqual(c.portMeta(1).speed, 1e9);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
