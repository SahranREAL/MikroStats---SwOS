/* MikroTik SwOS Monitor — frontend.
 *
 * Rules this file obeys:
 *  - the browser NEVER talks to a device: it reads /api/stream (SSE) and small
 *    REST snapshots (topology, status, link loads, history);
 *  - ONE EventSource for the whole page, ONE render pass per animation frame;
 *  - IN and OUT are two curves of the same chart, mirrored around zero;
 *  - nothing runs on a timer while the page is hidden;
 *  - no innerHTML anywhere: dynamic values go through textContent / createElement,
 *    so a device named "<img onerror=...>" is displayed, never executed.
 */
'use strict';

// chartjs-plugin-zoom registers itself when loaded; Hammer is only needed for
// pinch gestures and is optional.
if (!window.Chart) throw new Error('Chart.js failed to load');

const SVGNS = 'http://www.w3.org/2000/svg';

const COLORS = {
  in: '#049fd9',      // download
  out: '#6abf4b',     // upload
  grid: '#eef1f5',
  zero: '#6b7a89',
  tick: '#98a4b0',
  inFill: 'rgba(4, 159, 217, 0.16)',
  outFill: 'rgba(106, 191, 75, 0.20)',
};

// Link load colours, shared with the legend in index.html.
const LINK_COLOR = {
  ok: '#6abf4b',
  warn: '#fbab18',
  critical: '#e2231a',
  down: '#e2231a',
  unknown: '#b9c4cf',
};

const RANGES = [
  { key: '5m', label: '5m', ms: 5 * 60e3, title: '5 minutes' },
  { key: '15m', label: '15m', ms: 15 * 60e3, title: '15 minutes' },
  { key: '1h', label: '1h', ms: 60 * 60e3, title: '1 heure' },
  { key: '6h', label: '6h', ms: 6 * 3600e3, title: '6 heures' },
  { key: '24h', label: '24h', ms: 24 * 3600e3, title: '24 heures' },
  { key: '7d', label: '7d', ms: 7 * 86400e3, title: '7 jours' },
  { key: '30d', label: '30d', ms: 30 * 86400e3, title: '30 jours' },
];

const RANGE_TITLES = Object.fromEntries(RANGES.map((r) => [r.key, r.title]));
const SHORT_RANGES = new Set(['5m', '15m', '1h']);

/* --------------------------------------------------------------- formatting */

function fmtBpsParts(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return ['0', 'bps'];
  if (bps >= 1e9) return [(bps / 1e9).toFixed(bps >= 1e10 ? 1 : 2), 'Gbps'];
  if (bps >= 1e6) return [(bps / 1e6).toFixed(bps >= 1e7 ? 1 : 2), 'Mbps'];
  if (bps >= 1e3) return [(bps / 1e3).toFixed(bps >= 1e4 ? 0 : 1), 'Kbps'];
  return [String(Math.round(bps)), 'bps'];
}

function fmtBps(bps) {
  const [n, u] = fmtBpsParts(bps);
  return `${n} ${u}`;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i];
}

const pad2 = (n) => (n < 10 ? '0' + n : String(n));

// 24h clock formatted by hand: toLocaleTimeString renders midnight as "24:05"
// on some ICU builds and otherwise depends on the browser locale.
function fmtTime(ms, withSeconds) {
  const d = new Date(ms);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

function fmtClock(ms) {
  if (!ms) return '-';
  return fmtTime(ms, true);
}

function fmtStamp(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return (sameDay ? '' : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ') +
    fmtTime(ms, false);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function fmtSpeed(v) {
  if (!Number.isFinite(v) || v === null) return '-';
  if (v >= 1e9) return (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 1) + 'G';
  if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function s(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

/** KPI value with its unit in a <small>, built with nodes (never innerHTML). */
function setKpi(id, bps) {
  const [n, u] = fmtBpsParts(bps);
  $(id).replaceChildren(document.createTextNode(n), el('small', null, u));
}

function setPair(id, main, sub) {
  $(id).replaceChildren(document.createTextNode(String(main)), el('small', null, String(sub)));
}

const typeLabel = (d) => (d && d.type === 'router' ? 'Routeur RouterOS' : 'Switch SwOS');
const shortType = (d) => (d && d.type === 'router' ? 'Routeur' : 'Switch');

/* -------------------------------------------------------------------- state */

const state = {
  // topology (from /api/topology and the SSE "topology" event)
  devices: new Map(),   // id -> device
  links: new Map(),     // id -> {id, a:{device,port}, b:{device,port}, capacityBps, label}
  rates: new Map(),     // link id -> {f,r,t,c,k,u,aName,bName}
  rev: null,

  // live data
  statuses: new Map(),  // device id -> status snapshot
  live: new Map(),      // device id -> stats payload (ports + totals)
  portMeta: new Map(),  // device id -> Map(port -> {name,sfp,duplex})
  server: null,         // last /api/status payload
  alertCount: 0,
  sseClients: 0,
  streamUp: false,

  // navigation
  view: 'map',          // 'map' | 'device'
  cur: null,            // device id shown in the dashboard

  // dashboard state
  range: '5m',
  modalRange: '1h',
  modalPort: 0,
  ports: new Map(),     // port -> live metrics of the current device
  peak: new Map(),      // port -> {in, out} peaks for the selected range
  stats: null,          // aggregate stats for the selected range
  lastSample: null,
  sort: { key: 'totalBps', dir: -1 },
  filter: '',
  onlyActive: false,
  liveTail: { t: [], in: [], out: [] },
  liveCap: 400,
  zoomed: false,
};

let globalChart = null;
let portChart = null;
const sparklines = new Map();   // port -> Sparkline
const portCards = new Map();    // port -> card element
const plateTiles = new Map();   // port -> .pt element
const tableRows = new Map();    // port -> {tr, cells}
const devRows = new Map();      // device id -> {tr, cells}
const linkEls = new Map();      // link id -> {g, line, top, bottom, sp, ep}
const nodeEls = new Map();      // device id -> {g, bar, up, dn}
const pendingHistory = new Map();
let plateEth = null;
let plateSfp = null;

/* ------------------------------------------------------------------ charts */

/**
 * chartjs-plugin-zoom reads `options.plugins.zoom = {zoom, pan, limits}`.
 * Wheel/pinch/pan act on the time axis only: the y axis is re-fitted to the
 * data on every update (symmetric mirror scale).
 */
const ZOOM_OPTS = {
  zoom: { wheel: { enabled: true, speed: 0.1 }, pinch: { enabled: true }, mode: 'x' },
  pan: { enabled: true, mode: 'x', threshold: 5 },
  limits: { x: { minRange: 5000 } },
};

function baseOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    parsing: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 6, bottom: 0, left: 0 } },
    plugins: {
      legend: { display: false },
      zoom: ZOOM_OPTS,
      tooltip: {
        backgroundColor: 'rgba(27,39,51,0.95)',
        borderColor: '#25343f',
        borderWidth: 1,
        titleColor: '#ffffff',
        bodyColor: '#dfe7ee',
        padding: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 2,
        callbacks: {
          title: (items) => (items.length ? fmtStamp(items[0].parsed.x) : ''),
          label: (ctx) => ` ${ctx.dataset.label}: ${fmtBps(Math.abs(ctx.parsed.y))}`,
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        grid: { display: false },
        border: { color: '#dde3ea' },
        ticks: { color: COLORS.tick, maxTicksLimit: 8, font: { size: 10 }, callback: (v) => fmtStamp(v) },
      },
      y: {
        min: -1,
        max: 1,
        grid: {
          color: (ctx) => (ctx && ctx.tick && ctx.tick.value === 0 ? COLORS.zero : COLORS.grid),
          lineWidth: (ctx) => (ctx && ctx.tick && ctx.tick.value === 0 ? 1.5 : 1),
        },
        border: { display: false },
        ticks: {
          color: COLORS.tick,
          font: { size: 10 },
          maxTicksLimit: 6,
          padding: 6,
          callback: (v) => (v === 0 ? '0' : fmtBps(Math.abs(v))),
        },
      },
    },
  };
}

/** Mirror: OUT above the axis (positive), IN below it (negative). */
function makeDataset(label, color, fill) {
  return {
    label,
    data: [],
    peak: [],
    borderColor: color,
    backgroundColor: fill,
    borderWidth: 1.6,
    pointRadius: 0,
    pointHoverRadius: 3,
    pointHoverBackgroundColor: color,
    fill: true,
    tension: 0.25,
    spanGaps: false,
  };
}

function newChart(canvas) {
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets: [makeDataset('Upload', COLORS.out, COLORS.outFill), makeDataset('Download', COLORS.in, COLORS.inFill)] },
    options: baseOptions(),
  });
}

/** Symmetric y axis: both directions share one absolute scale. */
function syncY(chart) {
  if (!chart) return;
  let max = 0;
  for (const ds of chart.data.datasets) {
    for (const p of ds.data) {
      const a = Math.abs(p.y || 0);
      if (a > max) max = a;
    }
    for (const v of ds.peak || []) {
      const a = Math.abs(v || 0);
      if (a > max) max = a;
    }
  }
  const m = (max || 1) * 1.1;
  chart.options.scales.y.min = -m;
  chart.options.scales.y.max = m;
}

function applySeries(chart, series) {
  if (!chart) return;
  const t = series.t || [];
  const inn = series.in || [];
  const out = series.out || [];
  const outMax = series.outMax || out;
  const inMax = series.inMax || inn;
  const ds = chart.data.datasets;
  // ds[0] = Upload (OUT, positive, above), ds[1] = Download (IN, negative, below)
  ds[0].data = t.map((x, i) => ({ x, y: out[i] || 0 }));
  ds[1].data = t.map((x, i) => ({ x, y: -(inn[i] || 0) }));
  ds[0].peak = outMax.map((v) => v || 0);
  ds[1].peak = inMax.map((v) => -(v || 0));
  syncY(chart);
  chart.update('none');
}

function resetZoom(chart) {
  if (chart && chart.resetZoom) chart.resetZoom();
}

/* ------------------------------------------------------------- sparklines */

/**
 * Tiny canvas renderer for the port cards. A hand-rolled renderer instead of
 * 26 Chart.js instances is what keeps the dashboard smooth on a weak CPU.
 */
class Sparkline {
  constructor(canvas, colorIn, colorOut) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colorIn = colorIn;
    this.colorOut = colorOut;
    this.inn = [];
    this.out = [];
    this.raf = 0;
  }

  push(inBps, outBps) {
    this.inn.push(inBps);
    this.out.push(outBps);
    if (this.inn.length > 60) { this.inn.shift(); this.out.shift(); }
    this.schedule();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  draw() {
    const { canvas, ctx } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = this.inn.length;
    if (n < 2) return;

    let max = 0;
    for (let i = 0; i < n; i++) {
      if (this.inn[i] > max) max = this.inn[i];
      if (this.out[i] > max) max = this.out[i];
    }
    if (max <= 0) max = 1;

    const step = w / (n - 1);
    const y = (v) => h - (v / max) * (h - 2) - 1;

    ctx.strokeStyle = '#dde3ea';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();

    const line = (arr, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const px = i * step;
        const py = y(arr[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };

    line(this.out, this.colorOut);
    line(this.inn, this.colorIn);
  }

  reset() { this.inn.length = 0; this.out.length = 0; this.draw(); }
}

/* ------------------------------------------------------------ render queue */

const dirty = { map: true, header: true, kpi: true, ports: true, table: true, sys: true, nb: true, conn: true, chart: true };
let renderQueued = false;

function mark(...keys) {
  for (const k of keys) dirty[k] = true;
  scheduleRender();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; doRender(); });
}

function doRender() {
  // Nothing is painted while the tab is hidden; visibilitychange re-marks.
  if (document.visibilityState === 'hidden') return;
  if (dirty.conn) { dirty.conn = false; renderConn(); }
  if (state.view === 'map') {
    if (dirty.map) { dirty.map = false; renderMapView(); }
    return;
  }
  if (dirty.header) { dirty.header = false; renderDeviceHeader(); }
  if (dirty.kpi) { dirty.kpi = false; renderKpis(); }
  if (dirty.chart) { dirty.chart = false; renderLiveTail(); }
  if (dirty.ports) { dirty.ports = false; renderPlate(); renderCards(); }
  if (dirty.table) { dirty.table = false; renderTable(); }
  if (dirty.sys) { dirty.sys = false; renderSystem(); }
  if (dirty.nb) { dirty.nb = false; renderNeighbors(); }
}

/* -------------------------------------------------------- connection state */

function deviceName(id) {
  const d = state.devices.get(id);
  return d ? d.name : id;
}

function aggregateState() {
  if (!state.streamUp) return 'disconnected';
  let up = 0;
  let total = 0;
  for (const snap of state.statuses.values()) {
    total++;
    if (snap.status === 'connected') up++;
  }
  if (total === 0) return 'connected';
  if (up === total) return 'connected';
  return up > 0 ? 'degraded' : 'disconnected';
}

function renderConn() {
  const agg = aggregateState();
  $('hdr-conn').dataset.state = agg;
  $('hdr-conn-text').textContent =
    agg === 'connected' ? 'Connecté' : agg === 'degraded' ? 'Dégradé' : 'Déconnecté';

  const banner = $('banner');
  if (agg === 'connected') { banner.hidden = true; return; }
  banner.hidden = false;

  if (!state.streamUp) {
    $('banner-title').textContent = 'Flux temps réel interrompu';
    $('banner-body').textContent = 'Connexion au serveur perdue — nouvelle tentative automatique…';
    return;
  }

  const down = [...state.statuses.values()].filter((sn) => sn.status !== 'connected');
  if (down.length > 0) {
    $('banner-title').textContent = down.length > 1 ? 'Équipements inaccessibles' : 'Équipement inaccessible';
    $('banner-body').textContent = down
      .map((sn) => `${deviceName(sn.id)} : ${sn.lastError || 'pas de réponse'} (vu à ${fmtClock(sn.lastUpdate)})`)
      .join(' — ');
  } else {
    $('banner-title').textContent = 'Réseau dégradé';
    $('banner-body').textContent = 'Un ou plusieurs éléments ne sont pas nominaux.';
  }
}

/* ------------------------------------------------------------- map rendering */

const NW = 176;
const NH = 72;
const COLW = 350;
const ROWH = 140;
const PAD = 36;
let POS = {};
let mapBuilt = false;

/** Left-to-right tree layout (root on the left), then stored positions win. */
function computeLayout() {
  const devices = [...state.devices.values()];
  const pos = {};
  if (devices.length === 0) return pos;

  const links = [...state.links.values()];
  const root = devices.find((d) => d.root) || devices[0];
  const lvl = {};
  const kids = {};
  const seen = new Set();

  const bfs = (r) => {
    lvl[r] = 0;
    seen.add(r);
    const q = [r];
    while (q.length) {
      const id = q.shift();
      for (const l of links) {
        const other = l.a.device === id ? l.b.device : (l.b.device === id ? l.a.device : null);
        if (other && !seen.has(other)) {
          seen.add(other);
          lvl[other] = lvl[id] + 1;
          (kids[id] = kids[id] || []).push(other);
          q.push(other);
        }
      }
    }
  };

  const roots = [root.id];
  bfs(root.id);
  for (const d of devices) if (!seen.has(d.id)) { bfs(d.id); roots.push(d.id); }

  let slot = 0;
  const place = (id) => {
    const ch = kids[id] || [];
    if (ch.length === 0) { pos[id] = { y: slot++ }; }
    else {
      ch.forEach(place);
      pos[id] = { y: (pos[ch[0]].y + pos[ch[ch.length - 1]].y) / 2 };
    }
    pos[id].l = lvl[id];
  };
  roots.forEach(place);

  const levels = Object.values(lvl);
  const maxL = levels.length ? Math.max(...levels) : 0;
  const width = PAD * 2 + maxL * COLW + NW;
  const height = PAD * 2 + Math.max(0, slot - 1) * ROWH + NH;
  for (const d of devices) {
    const p = pos[d.id];
    if (!p) continue;
    p.x = PAD + p.l * COLW;
    p.y = PAD + p.y * ROWH;
    p.w = width;
    p.h = height;
  }

  // Persisted coordinates (drag & drop) override the automatic layout.
  for (const d of devices) {
    const p = pos[d.id];
    if (!p) continue;
    const l = d.layout;
    if (l && Number.isFinite(l.x) && Number.isFinite(l.y)) { p.x = l.x; p.y = l.y; }
  }
  return pos;
}

/** Geometry of a link: drawn left -> right, labels follow that direction. */
function linkEdge(link) {
  const A = POS[link.a.device];
  const B = POS[link.b.device];
  if (!A || !B) return null;
  let from = A;
  let to = B;
  let flip = false;
  if (A.x > B.x || (A.x === B.x && A.y > B.y)) { from = B; to = A; flip = true; }
  if (Math.abs(from.x - to.x) < 1) {
    return { x1: from.x + NW / 2, y1: from.y + NH, x2: to.x + NW / 2, y2: to.y, flip };
  }
  return { x1: from.x + NW, y1: from.y + NH / 2, x2: to.x, y2: to.y + NH / 2, flip };
}

function buildMap() {
  const svg = $('map');
  svg.replaceChildren();
  linkEls.clear();
  nodeEls.clear();
  POS = computeLayout();
  if (Object.keys(POS).length === 0) { mapBuilt = false; return; }

  // ---- links
  for (const link of state.links.values()) {
    const e = linkEdge(link);
    if (!e) continue;
    const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180 / Math.PI;
    const mx = (e.x1 + e.x2) / 2;
    const my = (e.y1 + e.y2) / 2;

    const g = s('g', { class: 'lnk', 'data-link': link.id, tabindex: '0', role: 'button' });
    const line = s('line', { class: 'lk-line', 'stroke-width': '4' });
    const sp = s('text', { class: 'port', transform: `translate(${e.x1} ${e.y1}) rotate(${ang})`, x: '10', y: '-6' });
    const ep = s('text', { class: 'port', transform: `translate(${e.x2} ${e.y2}) rotate(${ang})`, x: '-10', y: '-6', 'text-anchor': 'end' });
    const labels = s('g', { transform: `translate(${mx} ${my}) rotate(${ang})` });
    const top = s('text', { class: 'lab up', y: '-10', 'text-anchor': 'middle' }, '-');
    const bottom = s('text', { class: 'lab down', y: '19', 'text-anchor': 'middle' }, '-');
    const title = s('title', {}, '');
    labels.append(top, bottom);
    g.append(line, sp, ep, labels, title);

    const open = () => {
      const dev = link.a.device;
      if (state.devices.has(dev)) goDevice(dev);
    };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });

    svg.append(g);
    linkEls.set(link.id, { g, line, top, bottom, sp, ep, title, edge: e });
  }

  // ---- nodes
  for (const dev of state.devices.values()) {
    const p = POS[dev.id];
    if (!p) continue;
    const g = s('g', {
      class: 'node',
      'data-dev': dev.id,
      tabindex: '0',
      role: 'button',
      'aria-label': `${dev.name} — ouvrir le tableau de bord`,
      transform: `translate(${p.x} ${p.y})`,
    });
    const box = s('rect', { class: 'nbox', width: String(NW), height: String(NH), rx: '6' });
    const bar = s('rect', { width: '5', height: String(NH), rx: '2', fill: '#98a4b0' });
    const icon = dev.type === 'router' ? routerIcon() : switchIcon();
    const name = s('text', { class: 'nname', x: '46', y: '28' }, dev.name);
    const model = s('text', { class: 'nmodel', x: '46', y: '44' }, dev.model || '');
    const rates = s('text', { class: 'nrate', x: '14', y: '63' });
    const up = s('tspan', { class: 'up' }, '↑ -');
    const dn = s('tspan', { class: 'down', dx: '10' }, '↓ -');
    rates.append(up, dn);
    const title = s('title', {}, `${dev.name} (${dev.host || 'sans IP'})`);
    g.append(box, bar, icon, name, model, rates, title);

    const open = () => goDevice(dev.id);
    g.addEventListener('click', open);
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });

    svg.append(g);
    nodeEls.set(dev.id, { g, bar, up, dn, name, model, title });
  }

  fitMap();
  mapBuilt = true;
  renderMapView();
}

function routerIcon() {
  const g = s('g', { transform: 'translate(22 28)' });
  g.append(
    s('circle', { r: '12', fill: '#e6f4fb', stroke: '#049fd9', 'stroke-width': '1.5' }),
    s('path', {
      d: 'M-6 0H6M0 -6V6M-6 0l2.5-2.5M-6 0l2.5 2.5M6 0l-2.5-2.5M6 0l-2.5 2.5M0 -6l-2.5 2.5M0 -6l2.5 2.5M0 6l-2.5-2.5M0 6l2.5-2.5',
      stroke: '#049fd9', 'stroke-width': '1.2', fill: 'none', 'stroke-linecap': 'round',
    }),
  );
  return g;
}

function switchIcon() {
  const g = s('g', { transform: 'translate(10 20)' });
  g.append(
    s('rect', { width: '24', height: '16', rx: '2', fill: '#e6f4fb', stroke: '#049fd9', 'stroke-width': '1.5' }),
    s('path', { d: 'M5.5 5.5v5M10 5.5v5M14.5 5.5v5M19 5.5v5', stroke: '#049fd9', 'stroke-width': '2' }),
  );
  return g;
}

/** viewBox covering every node, whatever the layout (stored or automatic). */
function fitMap() {
  const svg = $('map');
  const xs = [];
  const ys = [];
  for (const p of Object.values(POS)) { xs.push(p.x); ys.push(p.y); }
  if (xs.length === 0) { svg.setAttribute('viewBox', '0 0 800 300'); return; }
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  const maxX = Math.max(...xs) + NW + PAD;
  const maxY = Math.max(...ys) + NH + PAD;
  svg.setAttribute('viewBox', `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`);
}

function deviceStatus(id) {
  return state.statuses.get(id) || null;
}

function linkRate(id) {
  return state.rates.get(id) || null;
}

function renderMapView() {
  if (!mapBuilt) { buildMap(); return; }
  const devices = [...state.devices.values()];

  // ---- links: colour, dashed when down, rates above/below with an arrow
  for (const link of state.links.values()) {
    const els = linkEls.get(link.id);
    if (!els) continue;
    const r = linkRate(link.id);
    const nameA = deviceName(link.a.device);
    const nameB = deviceName(link.b.device);
    const portA = (r && r.aName) || `P${link.a.port}`;
    const portB = (r && r.bName) || `P${link.b.port}`;
    els.sp.textContent = els.edge.flip ? portB : portA;
    els.ep.textContent = els.edge.flip ? portA : portB;

    if (!r || r.t === null || r.t === undefined) {
      els.line.setAttribute('stroke', LINK_COLOR.unknown);
      els.line.removeAttribute('stroke-dasharray');
      els.top.textContent = '-';
      els.bottom.textContent = '-';
      els.top.setAttribute('class', 'lab unknown');
      els.bottom.setAttribute('class', 'lab unknown');
      els.g.setAttribute('aria-label', `${nameA} ↔ ${nameB} : charge inconnue`);
      els.title.textContent = `${nameA} (${portA}) ↔ ${nameB} (${portB})`;
      continue;
    }

    const forward = els.edge.flip ? r.r : r.f;   // traffic toward the right
    const reverse = els.edge.flip ? r.f : r.r;   // traffic toward the left

    if (r.u === false) {
      els.line.setAttribute('stroke', LINK_COLOR.down);
      els.line.setAttribute('stroke-dasharray', '8 7');
      els.top.textContent = 'LIEN DOWN';
      els.bottom.textContent = '';
      els.top.setAttribute('class', 'lab down');
      els.bottom.setAttribute('class', 'lab down');
      els.g.setAttribute('aria-label', `${nameA} ↔ ${nameB} : lien down`);
      els.title.textContent = `${nameA} (${portA}) ↔ ${nameB} (${portB}) : down`;
      continue;
    }

    els.line.setAttribute('stroke', LINK_COLOR[r.k] || LINK_COLOR.unknown);
    els.line.removeAttribute('stroke-dasharray');
    els.top.textContent = `${fmtBps(forward || 0)} →`;
    els.bottom.textContent = `← ${fmtBps(reverse || 0)}`;
    els.top.setAttribute('class', 'lab up');
    els.bottom.setAttribute('class', 'lab down');
    els.g.setAttribute(
      'aria-label',
      `${nameA} ↔ ${nameB} : ${fmtBps(forward || 0)} vers la droite, ${fmtBps(reverse || 0)} vers la gauche, ouvrir ${nameA}`,
    );
    els.title.textContent = `${nameA} (${portA}) ↔ ${nameB} (${portB}) — ${fmtBps(r.t)}`;
  }

  // ---- nodes: status bar + device totals
  for (const dev of devices) {
    const els = nodeEls.get(dev.id);
    if (!els) continue;
    const snap = deviceStatus(dev.id);
    const live = state.live.get(dev.id);
    const up = snap ? snap.status === 'connected' : Boolean(live);
    els.g.classList.toggle('off', !up);
    els.bar.setAttribute('fill', snap && snap.status ? (up ? '#6abf4b' : '#e2231a') : '#98a4b0');
    els.up.textContent = up && live ? `↑ ${fmtBps(live.outBps || 0)}` : '↑ –';
    els.dn.textContent = up && live ? `↓ ${fmtBps(live.inBps || 0)}` : '↓ –';
  }

  renderMapKpis(devices);
  renderDeviceTable(devices);

  $('map-update').textContent = fmtTime(Date.now(), false);
  const intervals = devices.filter((d) => Number.isFinite(d.intervalMs) && d.intervalMs > 0).map((d) => d.intervalMs);
  $('map-poll').textContent = intervals.length ? `${Math.round(Math.min(...intervals) / 1000)} s` : '-';
}

function renderMapKpis(devices) {
  const on = devices.filter((d) => {
    const sn = deviceStatus(d.id);
    return sn ? sn.status === 'connected' : Boolean(state.live.get(d.id));
  }).length;

  setPair('m-dev', on, `/ ${devices.length}`);
  $('m-dev-s').textContent = devices.length - on > 0 ? `${devices.length - on} hors ligne` : 'tous en ligne';

  let upLinks = 0;
  let downLinks = 0;
  let busiest = null;
  for (const link of state.links.values()) {
    const r = linkRate(link.id);
    if (!r || r.u === null || r.u === undefined) { upLinks++; continue; }
    if (r.u === false) { downLinks++; continue; }
    upLinks++;
    if (Number.isFinite(r.ratio) && (!busiest || r.ratio > busiest.ratio)) busiest = { link, r };
  }

  setPair('m-links', upLinks, `/ ${state.links.size}`);
  $('m-links-s').textContent = downLinks > 0 ? `${downLinks} lien(s) down` : 'tous opérationnels';

  if (busiest) {
    setPair('m-top', (Math.min(busiest.r.ratio, 1.5) * 100).toFixed(1), ' %');
    $('m-top-s').textContent = `${deviceName(busiest.link.a.device)} ↔ ${deviceName(busiest.link.b.device)}`;
  } else {
    $('m-top').textContent = '-';
    $('m-top-s').textContent = state.links.size ? 'charge inconnue' : 'aucun lien déclaré';
  }

  const alerts = state.alertCount;
  $('m-alerts').textContent = String(alerts);
  $('m-alerts').style.color = alerts ? 'var(--err)' : '';
  $('m-alerts-s').textContent = alerts ? 'à vérifier' : 'tout est normal';
}

function renderDeviceTable(devices) {
  const tbody = $('m-tbody');
  const frag = document.createDocumentFragment();
  const seen = new Set();

  for (const dev of devices) {
    seen.add(dev.id);
    let row = devRows.get(dev.id);
    if (!row) {
      const tr = el('tr');
      tr.dataset.dev = dev.id;
      const name = el('td', 'name');
      const type = el('td');
      const model = el('td');
      const host = el('td');
      const status = el('td');
      const out = el('td', 'num c-up');
      const inn = el('td', 'num c-down');
      const portsUp = el('td', 'num');
      tr.append(name, type, model, host, status, out, inn, portsUp);
      tr.addEventListener('click', () => goDevice(dev.id));
      row = { tr, cells: { name, type, model, host, status, out, inn, portsUp } };
      devRows.set(dev.id, row);
    }
    const c = row.cells;
    const snap = deviceStatus(dev.id);
    const live = state.live.get(dev.id);
    const up = snap ? snap.status === 'connected' : Boolean(live);

    c.name.textContent = dev.name;
    c.type.textContent = shortType(dev);
    c.model.textContent = dev.model || '—';
    c.host.textContent = dev.host || '—';

    c.status.replaceChildren();
    const pill = el('span', `st ${up ? 'up' : 'down'}`);
    pill.append(el('i'), document.createTextNode(up ? 'En ligne' : 'Hors ligne'));
    c.status.append(pill);

    c.out.textContent = up && live ? fmtBps(live.outBps || 0) : '—';
    c.inn.textContent = up && live ? fmtBps(live.inBps || 0) : '—';
    if (up && live && Array.isArray(live.ports)) {
      const n = live.ports.filter((p) => p.link === true).length;
      c.portsUp.textContent = `${n} / ${live.ports.length}`;
    } else {
      c.portsUp.textContent = '—';
    }
    frag.append(row.tr);
  }

  for (const [id, row] of devRows) {
    if (seen.has(id)) continue;
    row.tr.remove();
    devRows.delete(id);
  }
  tbody.replaceChildren(frag);
}

/* ---------------------------------------------------------- device view */

function currentDevice() {
  return state.cur ? state.devices.get(state.cur) || null : null;
}

function renderDeviceHeader() {
  const dev = currentDevice();
  if (!dev) return;
  $('hdr-switch').textContent = dev.name;
  $('hdr-type').textContent = typeLabel(dev);
  $('hdr-model').textContent = dev.model || '—';
  $('hdr-ip').textContent = dev.host || '—';
  $('crumb-dev').textContent = dev.name;
  $('hdr-poll').textContent = dev.intervalMs ? `${Math.round(dev.intervalMs / 1000)} s` : '—';
  const snap = deviceStatus(dev.id);
  $('hdr-update').textContent = fmtClock(snap ? snap.lastUpdate : (state.lastSample ? state.lastSample.t : 0));
}

function renderKpis() {
  const sample = state.lastSample || { inBps: 0, outBps: 0, totalRxBytes: 0, totalTxBytes: 0 };
  setKpi('kpi-in', sample.inBps);
  setKpi('kpi-out', sample.outBps);
  $('kpi-rx-total').textContent = fmtBytes(sample.totalRxBytes);
  $('kpi-tx-total').textContent = fmtBytes(sample.totalTxBytes);

  const stats = state.stats;
  $('kpi-in-avg').textContent = stats ? `moy ${fmtBps(stats.inAvg)}` : 'moy -';
  $('kpi-out-avg').textContent = stats ? `moy ${fmtBps(stats.outAvg)}` : 'moy -';
  setKpi('kpi-in-max', stats ? stats.inMax : 0);
  setKpi('kpi-out-max', stats ? stats.outMax : 0);
  $('kpi-in-max-at').textContent = stats ? `sur ${RANGE_TITLES[state.range]}` : '-';
  $('kpi-out-max-at').textContent = stats ? `sur ${RANGE_TITLES[state.range]}` : '-';

  $('ro-in').textContent = fmtBps(sample.inBps);
  $('ro-out').textContent = fmtBps(sample.outBps);
  $('ro-in-max').textContent = stats ? fmtBps(stats.inMax) : '-';
  $('ro-out-max').textContent = stats ? fmtBps(stats.outMax) : '-';
  $('sub-ports').textContent = `somme des ${state.ports.size} ports`;

  let up = 0;
  let down = 0;
  let unknown = 0;
  for (const p of state.ports.values()) {
    if (p.link === true) up++;
    else if (p.link === false) down++;
    else unknown++;
  }
  setPair('kpi-ports-up', unknown > 0 && up === 0 ? '-' : up, `/ ${state.ports.size}`);
  const sub = $('kpi-ports-down');
  sub.textContent = down > 0 ? `${down} down` : (unknown ? `${unknown} ?` : 'aucun');
  sub.className = 'kpi-s' + (down > 0 ? ' err' : '');
}

function renderPlate() {
  const grid = $('plate');
  if (!plateEth || !plateEth.isConnected) {
    grid.replaceChildren();
    plateEth = el('div', 'bank');
    plateSfp = el('div', 'bank');
    grid.append(plateEth, plateSfp);
    plateTiles.clear();
  }

  const seen = new Set();
  for (const p of state.ports.values()) {
    if (state.onlyActive && p.link !== true) continue;
    seen.add(p.port);
    let tile = plateTiles.get(p.port);
    if (!tile) {
      tile = el('div', 'pt', String(p.port));
      tile.dataset.port = String(p.port);
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      const open = () => openPort(p.port);
      tile.addEventListener('click', open);
      tile.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      plateTiles.set(p.port, tile);
    }
    const active = p.link === true && (p.inBps + p.outBps) > 1e6;
    tile.className = 'pt'
      + (p.link === true ? (active ? ' act' : ' up') : '')
      + (p.sfp ? ' sfp' : '')
      + (p.port === state.modalPort ? ' sel' : '')
      + (state.onlyActive && p.link !== true ? ' dim' : '');
    tile.title = p.link === true
      ? `${p.name || 'Port' + p.port} — ${fmtBps(p.inBps)} ↓ / ${fmtBps(p.outBps)} ↑`
      : `${p.name || 'Port' + p.port} — down`;
    const bank = p.sfp ? plateSfp : plateEth;
    if (tile.parentElement !== bank) bank.append(tile);
  }

  for (const [port, tile] of plateTiles) {
    if (seen.has(port)) continue;
    tile.remove();
    plateTiles.delete(port);
  }
}

function renderCards() {
  const grid = $('ports-grid');
  const seen = new Set();

  for (const p of state.ports.values()) {
    if (state.onlyActive && p.link !== true) continue;
    seen.add(p.port);

    let card = portCards.get(p.port);
    if (!card) {
      card = el('div', 'pcard');
      card.dataset.port = String(p.port);
      card.tabIndex = 0;
      card.setAttribute('role', 'button');

      const hd = el('div', 'pcard-hd');
      const name = el('span', 'pcard-name');
      const badge = el('span', 'badge');
      hd.append(name, badge);

      const rate = el('div', 'pcard-rate');
      const inRow = el('span');
      const inVal = el('b', 'c-down', '-');
      inRow.append(el('em', null, 'IN'), inVal);
      const outRow = el('span');
      const outVal = el('b', 'c-up', '-');
      outRow.append(el('em', null, 'OUT'), outVal);
      rate.append(inRow, outRow);

      const canvas = document.createElement('canvas');
      canvas.className = 'chart-sm';

      card.append(hd, rate, canvas);
      const open = () => openPort(p.port);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      grid.append(card);
      portCards.set(p.port, card);
      sparklines.set(p.port, new Sparkline(canvas, COLORS.in, COLORS.out));
      card._parts = { name, badge, inVal, outVal };
    }

    const parts = card._parts;
    parts.name.textContent = p.name || `Port${p.port}`;
    parts.badge.textContent = p.link === true ? 'UP' : p.link === false ? 'DOWN' : '?';
    parts.badge.className = 'badge ' + (p.link === true ? 'up' : p.link === false ? 'down' : 'unknown');
    card.classList.toggle('down', p.link === false);
    parts.inVal.textContent = fmtBps(p.inBps);
    parts.outVal.textContent = fmtBps(p.outBps);
  }

  for (const [port, card] of portCards) {
    if (seen.has(port)) continue;
    card.remove();
    portCards.delete(port);
    sparklines.delete(port);
  }

  const total = state.ports.size;
  const active = [...state.ports.values()].filter((p) => p.link === true).length;
  $('ports-sub').textContent = `${active} port(s) actif(s) sur ${total} — IN et OUT sur le même graphique`;
}

function sortedPorts() {
  const list = [...state.ports.values()];
  const { key, dir } = state.sort;
  const value = (p) => {
    switch (key) {
      case 'totalBps': return p.inBps + p.outBps;
      case 'inPeak': return (state.peak.get(p.port) || { in: 0 }).in;
      case 'outPeak': return (state.peak.get(p.port) || { out: 0 }).out;
      case 'linkSpeed': return p.speed || 0;
      case 'rxBytes': return p.rxBytes || 0;
      case 'txBytes': return p.txBytes || 0;
      default: return p[key] || 0;
    }
  };
  list.sort((a, b) => {
    if (key === 'port') return (a.port - b.port) * dir;
    if (key === 'link') {
      const av = a.link === true ? 2 : a.link === false ? 0 : 1;
      const bv = b.link === true ? 2 : b.link === false ? 0 : 1;
      return (av - bv) * dir;
    }
    return (value(a) - value(b)) * dir;
  });
  if (state.filter) {
    const f = state.filter.toLowerCase();
    return list.filter((p) => String(p.name || '').toLowerCase().includes(f) || String(p.port) === f);
  }
  return list;
}

function renderTable() {
  const tbody = $('port-tbody');
  const frag = document.createDocumentFragment();
  const seen = new Set();

  for (const p of sortedPorts()) {
    seen.add(p.port);
    let row = tableRows.get(p.port);
    if (!row) {
      const tr = el('tr');
      tr.dataset.port = String(p.port);
      const name = el('td', 'name');
      const status = el('td');
      const inn = el('td', 'num c-down');
      const out = el('td', 'num c-up');
      const total = el('td', 'num');
      const inPeak = el('td', 'num c-down');
      const outPeak = el('td', 'num c-up');
      const rx = el('td', 'num');
      const tx = el('td', 'num');
      const speed = el('td', 'num');
      tr.append(name, status, inn, out, total, inPeak, outPeak, rx, tx, speed);
      tr.addEventListener('click', () => openPort(p.port));
      row = { tr, cells: { name, status, inn, out, total, inPeak, outPeak, rx, tx, speed } };
      tableRows.set(p.port, row);
    }

    const pk = state.peak.get(p.port) || { in: 0, out: 0 };
    const c = row.cells;
    row.tr.classList.toggle('sel', p.port === state.modalPort);
    c.name.textContent = p.name || `Port${p.port}`;

    c.status.replaceChildren();
    const badge = el('span', 'badge ' + (p.link === true ? 'up' : p.link === false ? 'down' : 'unknown'),
      p.link === true ? 'UP' : p.link === false ? 'DOWN' : '?');
    c.status.append(badge);

    c.inn.textContent = fmtBps(p.inBps);
    c.out.textContent = fmtBps(p.outBps);
    const pct = p.speed ? Math.min(100, (Math.max(p.inBps, p.outBps) / p.speed) * 100) : 0;
    c.total.replaceChildren(document.createTextNode(fmtBps(p.inBps + p.outBps)));
    if (p.link === true && p.speed) {
      const bar = el('span', 'bar');
      const fill = el('b');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      c.total.append(bar);
    }
    c.inPeak.textContent = fmtBps(pk.in);
    c.outPeak.textContent = fmtBps(pk.out);
    c.rx.textContent = fmtBytes(p.rxBytes);
    c.tx.textContent = fmtBytes(p.txBytes);
    c.speed.textContent = p.speed ? fmtSpeed(p.speed) : '-';
    frag.append(row.tr);
  }

  for (const [port, row] of tableRows) {
    if (seen.has(port)) continue;
    row.tr.remove();
    tableRows.delete(port);
  }
  tbody.replaceChildren(frag);

  for (const th of document.querySelectorAll('#port-table th')) {
    if (th.dataset.sort === state.sort.key) {
      th.setAttribute('aria-sort', state.sort.dir === 1 ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  }
}

function renderSystem() {
  const dev = currentDevice();
  const snap = dev ? deviceStatus(dev.id) : null;
  if (!dev) return;

  const st = snap || {};
  const rows = [
    ['État', st.status === 'connected' ? 'Connecté' : st.status === 'degraded' ? 'Dégradé' : 'Inaccessible',
      st.status === 'connected' ? 'ok' : st.status === 'degraded' ? 'warn' : 'err'],
    ['Dernière mise à jour', fmtClock(st.lastUpdate), ''],
    ['Dernière erreur', st.lastError || 'aucune', st.lastError ? 'err' : ''],
    ['Polling', dev.intervalMs ? `${Math.round(dev.intervalMs / 1000)} s` : '-', ''],
    ['Durée du poll', st.lastDurationMs ? `${st.lastDurationMs} ms` : '-', ''],
    ['Pollings réussis', String(st.successfulPolls ?? 0), ''],
    ['Erreurs', String(st.failedPolls ?? 0), (st.failedPolls || 0) > 0 ? 'warn' : ''],
    ['Erreurs consécutives', String(st.consecutiveErrors ?? 0), (st.consecutiveErrors || 0) > 0 ? 'err' : ''],
    ['Disponibilité (uptime)', fmtDuration(st.appUptimeMs), ''],
    ['Âge des données de lien', st.linkUpdatedAt ? fmtDuration(Date.now() - st.linkUpdatedAt) : '-', ''],
    ['Modèle', dev.model || '—', ''],
    ['Driver', dev.driver === 'routeros' ? 'RouterOS' : 'SwOS', ''],
    ['Adresse IP', dev.host || '—', ''],
    // The username is not a secret; the password never leaves the server.
    ['Identifiants', dev.hasCredentials ? (dev.username || 'définis') : 'aucun', ''],
  ];

  const srv = state.server;
  if (srv) {
    const h = srv.history || {};
    rows.push(['Historique', `${h.buckets ?? 0} points · ${fmtBytes(h.bytes ?? 0)} · ${h.flushes ?? 0} flush(s)`, '']);
    rows.push(['Topologie', `${srv.topology ? srv.topology.devices : 0} équipement(s) · ${srv.topology ? srv.topology.links : 0} lien(s) · ${srv.topology ? srv.topology.writes : 0} écriture(s)`, '']);
    rows.push(['Clients SSE', String(srv.sseClients ?? 0), '']);
    rows.push(['Mémoire RSS', srv.server ? `${srv.server.rssMb} Mo` : '-', '']);
  }

  const grid = $('sysgrid');
  const frag = document.createDocumentFragment();
  for (const [k, v, cls] of rows) {
    const row = el('div', 'sysrow');
    row.append(el('span', null, k), el('b', cls || null, v));
    frag.append(row);
  }
  grid.replaceChildren(frag);
}

function renderNeighbors() {
  const tbody = $('nb-tbody');
  const frag = document.createDocumentFragment();
  let count = 0;

  for (const link of state.links.values()) {
    const mine = link.a.device === state.cur ? 'a' : (link.b.device === state.cur ? 'b' : null);
    if (!mine) continue;
    const nbId = mine === 'a' ? link.b.device : link.a.device;
    const nb = state.devices.get(nbId);
    if (!nb) continue;
    count++;

    const r = linkRate(link.id);
    const localPort = mine === 'a' ? link.a.port : link.b.port;
    const remotePort = mine === 'a' ? link.b.port : link.a.port;
    const localName = (mine === 'a' ? r && r.aName : r && r.bName) || `P${localPort}`;
    const remoteName = (mine === 'a' ? r && r.bName : r && r.aName) || `P${remotePort}`;
    const out = r ? (mine === 'a' ? r.f : r.r) : null;   // OUT on my side
    const inn = r ? (mine === 'a' ? r.r : r.f) : null;   // IN on my side
    const up = r ? r.u !== false : null;

    const tr = el('tr');
    tr.dataset.dev = nbId;
    const name = el('td', 'name', nb.name);
    const type = el('td', null, shortType(nb));
    const ports = el('td', 'num', `${localName} → ${remoteName}`);
    const status = el('td');
    const pill = el('span', `st ${up === false ? 'down' : 'up'}`);
    pill.append(el('i'), document.createTextNode(up === null ? 'Inconnu' : up ? 'Up' : 'Down'));
    status.append(pill);
    const outCell = el('td', 'num c-up', out === null ? '—' : fmtBps(out));
    const inCell = el('td', 'num c-down', inn === null ? '—' : fmtBps(inn));
    tr.append(name, type, ports, status, outCell, inCell);
    tr.addEventListener('click', () => goDevice(nbId));
    frag.append(tr);
  }

  if (count === 0) {
    const tr = el('tr');
    const td = el('td', 'muted', 'Aucun lien déclaré');
    td.colSpan = 6;
    tr.append(td);
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

/* ---------------------------------------------------------------- history */

async function loadHistory(range, port) {
  if (!state.cur) return null;
  const key = `${state.cur}:${range}:${port}`;
  if (pendingHistory.has(key)) return null;
  const token = Symbol('req');
  pendingHistory.set(key, token);
  try {
    const qs = new URLSearchParams({ range, port: String(port) });
    const res = await fetch(`/api/devices/${encodeURIComponent(state.cur)}/history?${qs}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (pendingHistory.get(key) !== token) return null; // superseded
    if (data.device !== state.cur) return null;          // user navigated away
    return data;
  } finally {
    if (pendingHistory.get(key) === token) pendingHistory.delete(key);
  }
}

async function refreshGlobal() {
  if (state.view !== 'device') return;
  const data = await loadHistory(state.range, 0);
  if (!data) return;
  applySeries(globalChart, data);
  state.stats = data.stats || null;
  if (data.peaks) applyPeaks(data.peaks);
  mark('kpi', 'table');
}

function applyPeaks(peaks) {
  for (const p of peaks) state.peak.set(p.port, { in: p.inMax || 0, out: p.outMax || 0 });
}

/* --------------------------------------------------------------- streaming */

/** Merge a payload into live state, keeping port names / sfp / duplex. */
function putLive(id, payload) {
  let meta = state.portMeta.get(id);
  if (!meta) { meta = new Map(); state.portMeta.set(id, meta); }
  const ports = (payload.ports || []).map((p) => {
    const prev = meta.get(p.port) || {};
    const merged = { ...prev, ...p };
    if (p.name !== undefined && p.name !== null) merged.name = p.name;
    if (p.sfp !== undefined && p.sfp !== null) merged.sfp = p.sfp;
    if (p.duplex !== undefined && p.duplex !== null) merged.duplex = p.duplex;
    if (merged.name === undefined || merged.name === null) merged.name = `Port${p.port}`;
    meta.set(p.port, { name: merged.name, sfp: merged.sfp, duplex: merged.duplex });
    return merged;
  });
  state.live.set(id, { ...(state.live.get(id) || {}), ...payload, ports });
  return state.live.get(id);
}

function adoptSample(sample) {
  const live = putLive(sample.device, sample);
  const prev = state.statuses.get(sample.device) || { id: sample.device };
  state.statuses.set(sample.device, {
    ...prev,
    id: sample.device,
    status: sample.status || prev.status,
    stale: sample.stale,
    lastUpdate: sample.t,
  });

  if (state.cur !== sample.device) return;

  state.lastSample = live;
  state.ports.clear();
  for (const p of live.ports) state.ports.set(p.port, p);

  for (const p of live.ports) {
    const line = sparklines.get(p.port);
    if (line) line.push(p.inBps, p.outBps);
  }

  if (!sample.first) {
    state.liveTail.t.push(sample.t);
    state.liveTail.in.push(live.inBps || 0);
    state.liveTail.out.push(live.outBps || 0);
    if (state.liveTail.t.length > state.liveCap) {
      state.liveTail.t.shift();
      state.liveTail.in.shift();
      state.liveTail.out.shift();
    }
  }

  mark('kpi', 'ports', 'table', 'header', 'chart', 'map');
}

function applyRates(list, full) {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (!item || !item.id) continue;
    const prev = state.rates.get(item.id) || {};
    if (full) {
      state.rates.set(item.id, {
        ...prev,
        f: item.forwardBps,
        r: item.reverseBps,
        t: item.totalBps,
        c: item.capacityBps,
        k: item.klass,
        u: item.up,
        aName: item.aName,
        bName: item.bName,
      });
    } else {
      state.rates.set(item.id, {
        ...prev,
        f: item.f,
        r: item.r,
        t: item.t,
        c: item.c,
        k: item.k,
        u: item.u,
      });
    }
  }
}

function applyTopology(view) {
  if (!view) return;
  state.rev = view.rev;
  const devices = new Map();
  for (const d of view.devices || []) devices.set(d.id, d);
  state.devices = devices;

  const links = new Map();
  for (const l of view.links || []) links.set(l.id, l);
  state.links = links;

  // Drop rates of links that no longer exist.
  for (const id of [...state.rates.keys()]) if (!links.has(id)) state.rates.delete(id);
  // Drop live state of devices that no longer exist.
  for (const id of [...state.live.keys()]) {
    if (devices.has(id)) continue;
    state.live.delete(id);
    state.statuses.delete(id);
    state.portMeta.delete(id);
  }

  if (state.cur && !devices.has(state.cur)) {
    location.hash = '#/';
  }

  mapBuilt = false;
  mark('map', 'header', 'sys', 'nb');
  if (state.view === 'map') scheduleRender();
}

function connect() {
  if (state.es) return;
  const es = new EventSource('/api/stream');
  state.es = es;

  es.addEventListener('hello', (e) => {
    state.streamUp = true;
    const data = JSON.parse(e.data);
    if (data.topology && data.topology.rev !== state.rev) applyTopology(data.topology);
    applyRates(data.links, false);
    state.sseClients = data.sseClients || 0;
    mark('conn', 'map', 'kpi');
  });

  es.addEventListener('sample', (e) => {
    state.streamUp = true;
    adoptSample(JSON.parse(e.data));
    mark('conn');
  });

  es.addEventListener('links', (e) => {
    state.streamUp = true;
    const data = JSON.parse(e.data);
    applyRates(data.links, false);
    mark('map', 'nb');
  });

  es.addEventListener('status', (e) => {
    state.streamUp = true;
    const snap = JSON.parse(e.data);
    if (snap && snap.id) state.statuses.set(snap.id, snap);
    mark('conn', 'map', 'header', 'sys');
  });

  es.addEventListener('statusChange', (e) => {
    state.streamUp = true;
    const change = JSON.parse(e.data);
    if (!change || !change.deviceId) { mark('conn'); return; }
    const prev = state.statuses.get(change.deviceId) || { id: change.deviceId };
    state.statuses.set(change.deviceId, { ...prev, ...change, id: change.deviceId });
    mark('conn', 'map', 'header', 'sys');
  });

  es.addEventListener('topology', (e) => {
    state.streamUp = true;
    applyTopology(JSON.parse(e.data));
    route();
  });

  es.addEventListener('alerts', () => {
    state.streamUp = true;
    // The active-alert count lives in /api/status: refresh it, then repaint.
    mark('map');
    scheduleStatusRefresh();
  });

  es.onerror = () => {
    state.streamUp = false;
    mark('conn');
    // EventSource reconnects on its own (retry hint sent by the server).
  };
}

let statusRefreshTimer = 0;
function scheduleStatusRefresh() {
  if (statusRefreshTimer) return;
  statusRefreshTimer = setTimeout(() => {
    statusRefreshTimer = 0;
    pollSystemStatus();
  }, 1000);
}

async function pollSystemStatus() {
  try {
    const res = await fetch('/api/status', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    state.server = data;
    state.sseClients = data.sseClients || 0;
    state.alertCount = Array.isArray(data.alerts) ? data.alerts.length : 0;
    for (const snap of (data.manager && data.manager.perDevice) || []) {
      if (!snap || !snap.id) continue;
      const prev = state.statuses.get(snap.id);
      if (!prev || !state.streamUp || (snap.lastUpdate || 0) >= (prev.lastUpdate || 0)) {
        state.statuses.set(snap.id, snap);
      }
    }
    $('foot-version').textContent = `mikrostats ${data.version} · node ${data.node}`;
    const h = data.history || {};
    $('foot-store').textContent = data.history
      ? `historique ${h.buckets ?? 0} points · ${fmtBytes(h.bytes ?? 0)} · ${h.flushes ?? 0} flush(s)`
      : 'historique indisponible';
    mark('conn', 'map', 'sys', 'header');
  } catch { /* offline: the SSE stream and the banner already say so */ }
}

async function fetchDeviceStats(id) {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(id)}/stats`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (state.cur !== id) return;
    putLive(id, data);
    if (state.cur === id) {
      state.lastSample = state.live.get(id);
      state.ports.clear();
      for (const p of state.live.get(id).ports) state.ports.set(p.port, p);
      mark('kpi', 'ports', 'table', 'header', 'map');
    }
  } catch { /* the stream will deliver the next sample */ }
}

/* ------------------------------------------------------------------ modal */

async function openPort(port) {
  const p = state.ports.get(port);
  if (!p) return;
  state.modalPort = port;
  $('modal').hidden = false;
  $('modal-title').textContent = `${currentDevice() ? currentDevice().name : ''} · ${p.name || 'Port' + port}${p.link === true ? ' — lien up' : p.link === false ? ' — lien down' : ''}`;

  const pk = state.peak.get(port) || { in: 0, out: 0 };
  const facts = [
    ['Statut', p.link === true ? 'UP' : p.link === false ? 'DOWN' : 'inconnu', p.link === true ? 'ok' : p.link === false ? 'err' : ''],
    ['Lien', p.speed ? fmtSpeed(p.speed) + ' bps' : '-', ''],
    ['Duplex', p.duplex || '-', ''],
    ['Download (IN)', fmtBps(p.inBps), 'c-down'],
    ['Upload (OUT)', fmtBps(p.outBps), 'c-up'],
    ['Pic download', fmtBps(pk.in), 'c-down'],
    ['Pic upload', fmtBps(pk.out), 'c-up'],
    ['RX total', fmtBytes(p.rxBytes), ''],
    ['TX total', fmtBytes(p.txBytes), ''],
  ];
  const frag = document.createDocumentFragment();
  for (const [k, v, cls] of facts) {
    const fact = el('div', 'fact');
    fact.append(el('div', 'k', k), el('div', 'v ' + (cls || ''), v));
    frag.append(fact);
  }
  $('modal-facts').replaceChildren(frag);

  if (!portChart) portChart = newChart($('chart-port'));
  buildRangeButtons($('modal-range'), state.modalRange, (key) => {
    state.modalRange = key;
    loadPortHistory();
  });
  renderPlate();
  renderTable();
  await loadPortHistory();
}

function closePort() {
  $('modal').hidden = true;
  state.modalPort = 0;
  if (portChart) resetZoom(portChart);
  mark('ports', 'table');
}

async function loadPortHistory() {
  if (!state.modalPort || !portChart) return;
  const port = state.modalPort;
  const data = await loadHistory(state.modalRange, port);
  if (!data || state.modalPort !== port) return;
  applySeries(portChart, data);
}

/* ---------------------------------------------------------------- controls */

function buildRangeButtons(container, active, onPick) {
  const frag = document.createDocumentFragment();
  for (const r of RANGES) {
    const b = el('button', null, r.label);
    b.type = 'button';
    b.title = r.title;
    b.setAttribute('aria-pressed', String(r.key === active));
    b.addEventListener('click', () => {
      if (r.key === active) return;
      for (const node of container.children) node.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onPick(r.key);
    });
    frag.append(b);
  }
  container.replaceChildren(frag);
}

function wireControls() {
  $('zoom-tools').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !globalChart) return;
    if (btn.dataset.zoom === 'in') globalChart.zoom({ x: 1.4 });
    else if (btn.dataset.zoom === 'out') globalChart.zoom({ x: 0.7 });
    else { globalChart.resetZoom(); state.zoomed = false; $('zoom-tools').hidden = true; }
  });

  // Reveal the zoom toolbar as soon as the user has zoomed by drag or wheel.
  const revealZoom = () => {
    if (globalChart && globalChart.isZoomActive && globalChart.isZoomActive()) {
      state.zoomed = true;
      $('zoom-tools').hidden = false;
    }
  };
  $('chart-global').addEventListener('mouseup', revealZoom);
  $('chart-global').addEventListener('wheel', revealZoom, { passive: true });

  $('only-active').addEventListener('change', (e) => {
    state.onlyActive = e.target.checked;
    mark('ports');
  });
  $('table-filter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim();
    mark('table');
  });

  for (const th of document.querySelectorAll('#port-table th')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 'port' || key === 'link' ? 1 : -1 };
      mark('table');
    });
  }

  // Every interactive element wires its own handler (no delegated double-fire).
  $('modal-close').addEventListener('click', closePort);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closePort(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closePort(); });

  // Stop all rendering work while the tab is in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    mark('conn', 'map', 'header', 'kpi', 'ports', 'table', 'sys', 'nb', 'chart');
    pollSystemStatus();
    refreshGlobal();
    if (state.modalPort) loadPortHistory();
  });

  // Slow background refreshes only (never for live data: that is the SSE job).
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    pollSystemStatus();
  }, 30000);
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshGlobal();
    if (state.modalPort) loadPortHistory();
  }, 60000);
}

/* ------------------------------------------------------------- navigation */

function goDevice(id) {
  const target = `#/device/${id}`;
  if (location.hash === target) route();
  else location.hash = target;
}

function enterMap() {
  state.view = 'map';
  state.cur = null;
  state.modalPort = 0;
  $('modal').hidden = true;
  $('view-device').hidden = true;
  $('view-map').hidden = false;
  $('nav-map').classList.add('on');
  $('nav-dev').hidden = true;
  document.title = 'Carte réseau · SwOS Monitor';

  state.ports.clear();
  state.stats = null;
  state.lastSample = null;
  for (const line of sparklines.values()) line.reset();

  mark('conn', 'map', 'header', 'kpi', 'ports', 'table', 'sys', 'nb', 'chart');
}

function enterDevice(id) {
  const dev = state.devices.get(id);
  if (!dev) { enterMap(); return; }
  const changed = state.cur !== id;
  state.view = 'device';
  state.cur = id;
  state.modalPort = 0;
  $('modal').hidden = true;
  $('view-map').hidden = true;
  $('view-device').hidden = false;
  $('nav-map').classList.remove('on');
  $('nav-dev').hidden = false;
  $('nav-dev').textContent = dev.name;
  $('nav-dev').href = `#/device/${id}`;
  $('nav-dev').classList.add('on');
  document.title = `${dev.name} · SwOS Monitor`;

  if (changed) {
    state.ports.clear();
    state.peak.clear();
    state.stats = null;
    state.lastSample = null;
    state.liveTail = { t: [], in: [], out: [] };
    for (const line of sparklines.values()) line.reset();
    state.range = '5m';
    $('range-label').textContent = RANGE_TITLES[state.range];
    buildRangeButtons($('range-btns'), state.range, wireRangePicker);
    $('zoom-tools').hidden = true;
    if (globalChart) resetZoom(globalChart);
  }

  const live = state.live.get(id);
  if (live) {
    state.lastSample = live;
    state.ports.clear();
    for (const p of live.ports) state.ports.set(p.port, p);
  }
  fetchDeviceStats(id);
  refreshGlobal();

  mark('conn', 'map', 'header', 'kpi', 'ports', 'table', 'sys', 'nb', 'chart');
  // jsdom (the headless UI test) has no layout and logs scrollTo as an error.
  if (window.scrollY > 0) window.scrollTo(0, 0);
}

async function wireRangePicker(key) {
  state.range = key;
  $('range-label').textContent = RANGE_TITLES[key];
  state.liveTail = { t: [], in: [], out: [] };
  resetZoom(globalChart);
  state.zoomed = false;
  $('zoom-tools').hidden = true;
  for (const line of sparklines.values()) line.reset();
  await refreshGlobal();
  mark('kpi');
}

function route() {
  const m = /^#\/device\/([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (m && state.devices.has(m[1])) enterDevice(m[1]);
  else enterMap();
}

window.addEventListener('hashchange', route);

/* ------------------------------------------------------------ live tail */

function renderLiveTail() {
  if (!globalChart || !SHORT_RANGES.has(state.range)) return;
  const span = (RANGES.find((r) => r.key === state.range) || RANGES[0]).ms;
  const from = Date.now() - span;
  const ds = globalChart.data.datasets;
  let changed = false;

  for (let i = 0; i < state.liveTail.t.length; i++) {
    const t = state.liveTail.t[i];
    if (t < from) continue;
    const last = ds[0].data[ds[0].data.length - 1];
    if (!last || t > last.x) {
      ds[0].data.push({ x: t, y: state.liveTail.out[i] });   // Upload, above
      ds[1].data.push({ x: t, y: -state.liveTail.in[i] });   // Download, below
      changed = true;
    }
  }
  if (!changed) return;

  const cutoff = from;
  while (ds[0].data.length > 0 && ds[0].data[0].x < cutoff) {
    ds[0].data.shift();
    ds[1].data.shift();
    ds[0].peak.shift();
    ds[1].peak.shift();
  }
  while (ds[0].data.length > 720) {
    ds[0].data.shift();
    ds[1].data.shift();
    ds[0].peak.shift();
    ds[1].peak.shift();
  }
  syncY(globalChart);
  globalChart.update('none');
}

/* -------------------------------------------------------------------- boot */

async function loadTopology() {
  const res = await fetch('/api/topology', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`topology HTTP ${res.status}`);
  const data = await res.json();
  applyTopology(data);
}

async function loadLinkRates() {
  const res = await fetch('/api/links', { headers: { accept: 'application/json' } });
  if (!res.ok) return;
  const data = await res.json();
  applyRates(data.links, true);
  mark('map', 'nb');
}

async function boot() {
  if (!window.Chart) throw new Error('Chart.js failed to load');
  globalChart = newChart($('chart-global'));
  $('range-label').textContent = RANGE_TITLES[state.range];
  buildRangeButtons($('range-btns'), state.range, wireRangePicker);
  wireControls();

  // One REST snapshot first so the UI is populated before the first frame.
  await loadTopology();
  await Promise.all([pollSystemStatus(), loadLinkRates()]);
  route();
  connect();
  scheduleRender();
}

boot().catch((err) => {
  // Never leave a blank page: show what went wrong.
  const b = $('banner');
  b.hidden = false;
  $('banner-title').textContent = 'Erreur de démarrage';
  $('banner-body').textContent = String(err && err.message ? err.message : err);
});
