/**
 * Headless smoke test: runs the real public/index.html + public/app.js inside
 * jsdom against a live backend, then exercises the UI paths (map view, device
 * navigation, range switch, port modal, table sort, filter, SSE) looking for
 * runtime errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';

const errors = [];
const logs = [];
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

function makeDom() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => logs.push('warn: ' + a.map(String).join(' ')));

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  return dom;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const dom = makeDom();
  const { window } = dom;
  const doc = window.document;

  // Minimal canvas + Chart.js shims: we only care that app.js wires up cleanly
  // and manipulates the DOM as expected.
  const ctxStub = () => ({
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, fillRect() {}, save() {}, restore() {}, translate() {},
    scale() {}, arc() {}, closePath() {}, measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set lineJoin(v) {}, set font(v) {}, set textBaseline(v) {}, set globalAlpha(v) {},
  });
  window.HTMLCanvasElement.prototype.getContext = function () { return ctxStub(); };
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get: () => 54 });
  window.devicePixelRatio = 1;

  const chartInstances = [];
  class FakeChart {
    constructor(canvas, cfg) {
      this.canvas = canvas;
      this.data = cfg.data;
      this.options = cfg.options;
      this.updates = 0;
      chartInstances.push(this);
    }
    update() { this.updates++; }
    resetZoom() {}
    zoom() {}
    isZoomActive() { return false; }
  }
  FakeChart.register = () => {};
  window.Chart = FakeChart;
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  // Real network, served by the actual server.
  const nodeFetch = globalThis.fetch;
  window.fetch = (url, opts) => {
    if (String(url).startsWith('/')) url = BASE + url;
    return nodeFetch(url, opts);
  };

  // EventSource shim on top of fetch streaming.
  class FakeES {
    constructor(url) {
      this.handlers = new Map();
      this.closed = false;
      this.ctrl = new AbortController();
      this._start(String(url).startsWith('/') ? BASE + url : url);
    }
    addEventListener(t, fn) { this.handlers.set(t, fn); }
    onerror = null;
    async _start(url) {
      try {
        const res = await fetch(url, { signal: this.ctrl.signal, headers: { accept: 'text/event-stream' } });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (!this.closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /event: (.+)/.exec(frame);
            const data = /data: (.*)/.exec(frame);
            if (ev && data && this.handlers.has(ev[1])) {
              this.handlers.get(ev[1])({ data: data[1] });
            }
          }
        }
      } catch { /* aborted */ }
    }
    close() { this.closed = true; this.ctrl.abort(); }
  }
  window.EventSource = FakeES;

  window.eval(appSrc);

  await sleep(4000);

  let checks = 0;
  const check = (name, cond, extra) => {
    checks++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`);
    if (!cond) errors.push('assert: ' + name);
  };

  // Cells are human-formatted ("3.8 Kbps"); convert back to bps to assert ordering.
  const toBps = (text) => {
    const m = String(text).trim().match(/^([\d.]+)\s*(bps|Kbps|Mbps|Gbps)?$/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    const f = { bps: 1, Kbps: 1e3, Mbps: 1e6, Gbps: 1e9 }[m[2] || 'bps'];
    return n * f;
  };

  /* ------------------------------------------------------------ static checks */
  // Regression: a front-end fix must never reach the server and still not reach
  // the browser. index.html carries a cache-busting ?v= on every asset.
  const servedHtml = await (await fetch(`${BASE}/`)).text();
  const assets = [...servedHtml.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
  const unversioned = assets.filter((u) => !/\?v=[a-z0-9]+/i.test(u));
  check('every asset is cache-busted (?v=)', assets.length >= 5 && unversioned.length === 0,
    unversioned.length ? `missing ?v=: ${unversioned.join(', ')}` : `${assets.length} assets versioned`);
  const appJsUrl = (assets.find((u) => u.startsWith('/app.js')) || '/app.js');
  const appJsOk = await fetch(BASE + appJsUrl).then((r) => r.text()).then((t) => t.includes('function fmtTime'));
  check('versioned app.js is reachable and current', /\?v=/.test(appJsUrl) && appJsOk,
    `${appJsUrl} serves the 24h clock`);

  // XSS: no dynamic value may be injected as HTML.
  check('app.js never assigns innerHTML', !/\.innerHTML\s*=/.test(appSrc));
  check('map nodes are built with createElementNS', /createElementNS\(/.test(appSrc));

  /* ------------------------------------------------------------- map view */
  check('map view is the default view', doc.getElementById('view-map').hidden === false
    && doc.getElementById('view-device').hidden === true);
  const mapNodes = doc.querySelectorAll('#map .node');
  check('map renders one node per device', mapNodes.length > 0, `${mapNodes.length} node(s)`);
  const devRows = doc.querySelectorAll('#m-tbody tr');
  check('device table has one row per device', devRows.length === mapNodes.length && devRows.length > 0,
    `${devRows.length} row(s)`);
  check('device row opens the device', Boolean(devRows[0] && devRows[0].dataset.dev));
  check('map links are keyboard reachable',
    [...doc.querySelectorAll('#map .lnk')].every((g) => g.getAttribute('tabindex') === '0')
    || doc.querySelectorAll('#map .lnk').length === 0,
    `${doc.querySelectorAll('#map .lnk').length} link(s)`);
  check('map nodes are keyboard reachable',
    [...mapNodes].every((g) => g.getAttribute('tabindex') === '0'));
  check('map KPI equipment counter', /\/\s*\d+/.test(doc.getElementById('m-dev').textContent),
    doc.getElementById('m-dev').textContent);

  const topo = await (await fetch(`${BASE}/api/topology`)).json();
  const root = topo.devices.find((d) => d.root) || topo.devices[0];
  check('topology exposes a root device', Boolean(root), root && `${root.id} @ ${root.host}`);
  check('topology exposes no password', !JSON.stringify(topo).includes('password'));

  // Reference payload: the link/traffic state of the real switch changes over
  // time, so assertions below compare the DOM against this snapshot.
  const liveStats = await (await fetch(`${BASE}/api/stats`)).json();

  /* --------------------------------------------------------- device view */
  const goto = async (hash) => {
    window.location.hash = hash;
    await sleep(250);
    const wantDevice = hash.startsWith('#/device/');
    const showingDevice = !doc.getElementById('view-device').hidden;
    if (wantDevice !== showingDevice) {
      // jsdom does not always emit hashchange: drive the router explicitly.
      window.dispatchEvent(new window.Event('hashchange'));
      await sleep(250);
    }
  };

  await goto(`#/device/${root.id}`);
  await sleep(3000);

  check('device view opened', doc.getElementById('view-device').hidden === false
    && doc.getElementById('view-map').hidden === true);
  check('breadcrumb shows the device',
    doc.getElementById('crumb-dev').textContent === root.name,
    doc.getElementById('crumb-dev').textContent);
  check('header switch name', doc.getElementById('hdr-switch').textContent === root.name,
    doc.getElementById('hdr-switch').textContent);
  check('header ip', doc.getElementById('hdr-ip').textContent === root.host,
    doc.getElementById('hdr-ip').textContent);
  check('header type badge', doc.getElementById('hdr-type').textContent.length > 0,
    doc.getElementById('hdr-type').textContent);

  check('conn badge present', doc.getElementById('hdr-conn').dataset.state === 'connected',
    doc.getElementById('hdr-conn').dataset.state);
  check('KPI IN formatted', /bps|Kbps|Mbps|Gbps/.test(doc.getElementById('kpi-in').textContent),
    doc.getElementById('kpi-in').textContent);
  check('KPI RX total formatted', /(B|KB|MB|GB|TB)/.test(doc.getElementById('kpi-rx-total').textContent),
    doc.getElementById('kpi-rx-total').textContent);
  check('KPI peaks set', doc.getElementById('kpi-in-max').textContent !== '-',
    doc.getElementById('kpi-in-max').textContent);
  check('range buttons built', doc.getElementById('range-btns').children.length === 7,
    String(doc.getElementById('range-btns').children.length));
  check('range label', doc.getElementById('range-label').textContent === '5 minutes',
    doc.getElementById('range-label').textContent);

  const cards = doc.querySelectorAll('#ports-grid .pcard');
  check('port cards match the switch', cards.length === liveStats.ports.length,
    `${cards.length} card(s), ${liveStats.ports.length} port(s)`);
  check('port card has IN+OUT rows', cards[0] && cards[0].querySelectorAll('.pcard-rate span').length === 2);
  check('port card has canvas (IN+OUT same chart)', cards[0] && cards[0].querySelectorAll('canvas').length === 1);
  const firstName = (liveStats.ports.find((p) => p.port === 1) || {}).name || 'Port1';
  check('port 1 badge matches the switch',
    cards[0] && cards[0].querySelector('.badge').textContent
      === (liveStats.ports[0].link === true ? 'UP' : liveStats.ports[0].link === false ? 'DOWN' : '?'),
    cards[0] && cards[0].querySelector('.badge').textContent);

  const tiles = doc.querySelectorAll('#plate .pt');
  check('faceplate shows every port', tiles.length === liveStats.ports.length,
    `${tiles.length} tile(s)`);

  const rows = doc.querySelectorAll('#port-tbody tr');
  check('table shows every port', rows.length === liveStats.ports.length,
    `${rows.length} row(s)`);
  // Default order is Total descending. Which port is busiest changes with real
  // traffic, so assert the ordering itself instead of a hardcoded port.
  const totals = Array.from(rows).map((tr) => toBps(tr.children[4].textContent));
  let totalBad = -1;
  for (let i = 1; i < totals.length; i++) {
    if (totals[i - 1] < totals[i]) { totalBad = i; break; }
  }
  check('table sorted by total desc', totals.every(Number.isFinite) && totalBad === -1,
    totals.every(Number.isFinite)
      ? `top3: ${totals.slice(0, 3).join(' >= ')}${totalBad < 0 ? '' : ` (breaks at row ${totalBad})`}`
      : `unparsable: ${Array.from(rows).slice(0, 3).map((r) => r.children[4].textContent).join(' | ')}`);

  const sysText = doc.getElementById('sysgrid').textContent;
  check('system status rendered', sysText.includes('Pollings réussis') && sysText.includes('uptime'),
    sysText.slice(0, 90));

  /* ------------------------------------------------------- 24-hour clock */
  // app.js runs under 'use strict' inside window.eval, so its helpers are not
  // reachable as globals. Extract the clock helpers from the shipped source and
  // exercise every hour of the day, then confirm the DOM agrees.
  const clockSrc = appSrc.match(/const pad2 = [\s\S]*?\n}\n\nfunction fmtStamp[\s\S]*?\n}\n/);
  let fmtTime = null;
  if (clockSrc) fmtTime = new Function(`${clockSrc[0]}; return fmtTime;`)();
  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push({ h, got: fmtTime ? fmtTime(new Date(2026, 0, 2, h, 7, 9).getTime(), true) : 'n/a',
                 want: `${String(h).padStart(2, '0')}:07:09` });
  }
  const wrongHours = hours.filter((x) => x.got !== x.want);
  check('clock formatter is 24h across all 24 hours', Boolean(fmtTime) && wrongHours.length === 0,
    wrongHours.length
      ? `wrong: ${wrongHours.map((x) => `${x.h}h->${x.got}`).join(', ')}`
      : `${hours[0].got} .. ${hours[12].got} .. ${hours[23].got}`);
  check('clock formatter pads correctly', fmtTime
    ? fmtTime(new Date(2026, 0, 2, 7, 3, 4).getTime(), true) === '07:03:04'
      && fmtTime(new Date(2026, 0, 2, 0, 0, 0).getTime(), true) === '00:00:00'
    : false,
    fmtTime ? `${fmtTime(new Date(2026, 0, 2, 7, 3, 4).getTime(), true)} / ${fmtTime(new Date(2026, 0, 2, 0, 0, 0).getTime(), true)}` : 'n/a');
  check('clock formatter has no 24:xx hour', fmtTime
    ? !hours.some((x) => x.got.startsWith('24:'))
    : false,
    'midnight must be 00:xx, never 24:xx');

  const hdrUpdate = doc.getElementById('hdr-update').textContent;
  check('header renders 24h, no AM/PM', /^\d{2}:\d{2}:\d{2}$/.test(hdrUpdate) && !/AM|PM/i.test(hdrUpdate),
    JSON.stringify(hdrUpdate));
  check('no AM/PM anywhere in the UI', !/\b(AM|PM)\b/.test(doc.body.textContent),
    (doc.body.textContent.match(/\b(AM|PM)\b/g) || []).join(','));

  /* -------------------------------------------------------------- charts */
  const g = chartInstances[0];
  check('global chart has 2 datasets (OUT+IN)', g && g.data.datasets.length === 2,
    g && g.data.datasets.map((d) => d.label).join('/'));
  check('global chart has points', g && g.data.datasets[0].data.length > 1,
    g && String(g.data.datasets[0].data.length));
  check('global chart x is time (ms)', g && g.data.datasets[0].data[0] && g.data.datasets[0].data[0].x > 1e12);
  check('series lengths match', g && g.data.datasets[0].data.length === g.data.datasets[1].data.length);
  check('global chart is mirrored (OUT above, IN below)',
    g && g.data.datasets[0].data.every((p) => p.y >= 0)
      && g.data.datasets[1].data.every((p) => p.y <= 0));
  check('global chart y axis is symmetric',
    g && g.options.scales.y.min === -g.options.scales.y.max && g.options.scales.y.max > 0,
    g && `${g.options.scales.y.min} .. ${g.options.scales.y.max}`);
  check('global chart has zoom plugin', g && !!g.options.plugins.zoom.zoom.wheel.enabled);
  check('global chart zoom is x-only', g && g.options.plugins.zoom.zoom.mode === 'x');

  /* ------------------------------------------------------- range switching */
  const btns = doc.getElementById('range-btns').children;
  btns[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(2500);
  check('range label updated', doc.getElementById('range-label').textContent === '24 heures',
    doc.getElementById('range-label').textContent);
  check('active range button marked', btns[4].getAttribute('aria-pressed') === 'true');

  /* ----------------------------------------------------------- table sort */
  const thIn = doc.querySelector('#port-table th[data-sort="inBps"]');
  thIn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  const rows2 = Array.from(doc.querySelectorAll('#port-tbody tr'));
  const sortedIn = rows2.map((tr) => toBps(tr.children[2].textContent));
  const allFinite = sortedIn.every(Number.isFinite);
  let firstBad = -1;
  for (let i = 1; i < sortedIn.length; i++) {
    if (sortedIn[i - 1] < sortedIn[i]) { firstBad = i; break; }
  }
  check('sort by IN descending', allFinite && firstBad === -1,
    allFinite ? `row ${firstBad < 0 ? 'ok' : firstBad}: ${sortedIn.slice(0, 3).join(' >= ')}`
      : `unparsable cells: ${rows2.map((r) => r.children[2].textContent).slice(0, 3).join(' | ')}`);
  check('sort actually reorders the table',
    rows2.length > 1 && rows2[0].dataset.port !== rows2[1].dataset.port,
    `top=${rows2[0].dataset.port}`);

  /* ------------------------------------------------------------ port modal */
  cards[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(2000);
  check('modal open', doc.getElementById('modal').hidden === false);
  // Port names come from the switch (WAN, Bureau, ...) so assert against the
  // live payload instead of a hardcoded "Port1".
  check('modal title matches the port name',
    doc.getElementById('modal-title').textContent.includes(firstName),
    `${doc.getElementById('modal-title').textContent} (expected ${firstName})`);
  const facts = doc.getElementById('modal-facts').textContent;
  check('modal shows status', facts.includes('UP'));
  check('modal shows peaks', facts.includes('Pic download') && facts.includes('Pic upload'));
  check('modal shows totals', facts.includes('RX total') && facts.includes('TX total'));
  const pc = chartInstances[chartInstances.length - 1];
  check('port chart 2 datasets OUT+IN', pc && pc.data.datasets.length === 2);
  check('port chart has data', pc && pc.data.datasets[0].data.length > 0,
    pc && String(pc.data.datasets[0].data.length));
  check('port history uses the device route', appSrc.includes('/api/devices/'));

  const mbtns = doc.getElementById('modal-range').children;
  check('modal range buttons built', mbtns.length === 7, String(mbtns.length));
  mbtns[5].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(1500);
  check('modal range switch works', mbtns[5].getAttribute('aria-pressed') === 'true');

  doc.getElementById('modal-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  check('modal closed', doc.getElementById('modal').hidden === true);

  /* ------------------------------------------------------ filter + active */
  const allRows = doc.querySelectorAll('#port-tbody tr').length;
  const filt = doc.getElementById('table-filter');
  filt.value = 'port2';
  filt.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(200);
  const filtered = Array.from(doc.querySelectorAll('#port-tbody tr'));
  // Port names come from the switch, so assert the invariant (every shown row
  // matches the query, and the table did narrow) rather than an exact count.
  const q = 'port2';
  const allMatch = filtered.length > 0 && filtered.length < allRows
    && filtered.every((tr) => tr.textContent.toLowerCase().includes(q));
  check('table filter narrows to matching rows', allMatch,
    `${filtered.length}/${allRows} rows for "${q}"`);
  filt.value = '';
  filt.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(200);
  check('clearing the filter restores every row',
    doc.querySelectorAll('#port-tbody tr').length === allRows,
    `${doc.querySelectorAll('#port-tbody tr').length} vs ${allRows}`);

  const oa = doc.getElementById('only-active');
  oa.checked = true;
  oa.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(200);
  // Assert the invariant (every shown card is a linked port) rather than a
  // hardcoded count: the real switch's link state changes over time.
  const shown = Array.from(doc.querySelectorAll('#ports-grid .pcard')).map((c) => Number(c.dataset.port));
  const allShownLinked = shown.length > 0 && shown.every((n) => {
    const p = liveStats.ports.find((x) => x.port === n);
    return p && p.link === true;
  });
  const linkedNow = liveStats.ports.filter((p) => p.link === true).length;
  check('only-active keeps only linked ports', allShownLinked,
    `${shown.length} card(s) shown, ${linkedNow} linked: ${shown.join(',')}`);
  check('only-active also filters the faceplate',
    Array.from(doc.querySelectorAll('#plate .pt')).every((t) => shown.includes(Number(t.dataset.port))));
  oa.checked = false;
  oa.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(200);
  check('cards restored', doc.querySelectorAll('#ports-grid .pcard').length === liveStats.ports.length,
    String(doc.querySelectorAll('#ports-grid .pcard').length));

  /* ------------------------------------------------------------- zooming */
  g.isZoomActive = () => true;
  doc.getElementById('chart-global').dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  await sleep(100);
  check('zoom toolbar revealed', doc.getElementById('zoom-tools').hidden === false);
  doc.querySelector('#zoom-tools button[data-zoom="reset"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  /* ------------------------------------------------------- back to the map */
  await goto('#/');
  await sleep(500);
  check('back to the map view', doc.getElementById('view-map').hidden === false
    && doc.getElementById('view-device').hidden === true);
  check('map still rendered after navigation', doc.querySelectorAll('#map .node').length === mapNodes.length,
    `${doc.querySelectorAll('#map .node').length} node(s)`);

  console.log('\n--- runtime errors ---');
  if (errors.length === 0) console.log('none');
  else errors.forEach((e) => console.log('  ' + e));
  if (logs.length) console.log('--- warnings ---\n' + logs.join('\n'));
  console.log(`\nchart updates: ${chartInstances.map((c) => c.updates).join(',')}`);
  const failed = errors.filter((e) => e.startsWith('assert:')).length;
  console.log(`\n${checks - failed} passed, ${failed} failed`);
  window.close();
  process.exit(errors.length ? 1 : 0);
}

run().catch((e) => { console.error('HARNESS FAILURE', e); process.exit(2); });
