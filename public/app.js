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

  // schema editor
  edit: false,          // false = visualisation, true = édition
  grid: false,          // grille optionnelle (mode édition)
  mapVB: null,          // {x,y,w,h} viewBox courant de la carte
  mapVBBase: null,      // viewBox d'origine (bornes du zoom)
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

/* Editor interaction state (drag / pan / pinch). */
let dragState = null;      // {id, cx, cy, ox, oy, sc, moved}
let panState = null;       // {cx, cy, moved}
let justDragged = false;   // suppress the click that follows a drag
let pinchState = null;     // {dist, cx, cy}
const activePointers = new Map();   // pointerId -> {x, y}

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

  // ---- optional 20px grid (edit mode): also the pan target under the nodes
  if (state.grid) {
    const defs = s('defs');
    const pat = s('pattern', { id: 'gridpat', width: '20', height: '20', patternUnits: 'userSpaceOnUse' });
    pat.append(s('path', { d: 'M20 0H0V20', fill: 'none', stroke: '#e3e9ef', 'stroke-width': '1' }));
    defs.append(pat);
    svg.append(defs, s('rect', {
      class: 'gridrect', x: '-100000', y: '-100000', width: '200000', height: '200000', fill: 'url(#gridpat)',
    }));
  }

  // ---- links
  for (const link of state.links.values()) {
    const e = linkEdge(link);
    if (!e) continue;
    const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180 / Math.PI;
    const mx = (e.x1 + e.x2) / 2;
    const my = (e.y1 + e.y2) / 2;

    const g = s('g', { class: 'lnk', 'data-link': link.id, tabindex: '0', role: 'button' });
    const line = s('line', {
      class: 'lk-line',
      'stroke-width': '4',
      x1: String(e.x1), y1: String(e.y1), x2: String(e.x2), y2: String(e.y2),
    });
    const sp = s('text', { class: 'port', transform: `translate(${e.x1} ${e.y1}) rotate(${ang})`, x: '10', y: '-6' });
    const ep = s('text', { class: 'port', transform: `translate(${e.x2} ${e.y2}) rotate(${ang})`, x: '-10', y: '-6', 'text-anchor': 'end' });
    const labels = s('g', { transform: `translate(${mx} ${my}) rotate(${ang})` });
    const top = s('text', { class: 'lab up', y: '-10', 'text-anchor': 'middle' }, '-');
    const bottom = s('text', { class: 'lab down', y: '19', 'text-anchor': 'middle' }, '-');
    const title = s('title', {}, '');
    labels.append(top, bottom);
    g.append(line, sp, ep, labels, title);

    const open = () => {
      if (justDragged) return;
      if (state.edit) { openLinkModal(link.id); return; }
      const dev = link.a.device;
      if (state.devices.has(dev)) goDevice(dev);
    };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });

    svg.append(g);
    linkEls.set(link.id, { g, line, labels, top, bottom, sp, ep, title, edge: e });
  }

  // ---- nodes
  for (const dev of state.devices.values()) {
    const p = POS[dev.id];
    if (!p) continue;
    const locked = Boolean(dev.layout && dev.layout.locked);
    const g = s('g', {
      class: `node${locked ? ' locked' : ''}${dev.enabled === false ? ' off' : ''}`,
      'data-dev': dev.id,
      tabindex: '0',
      role: 'button',
      'aria-label': state.edit ? `${dev.name} — modifier cet équipement` : `${dev.name} — ouvrir le tableau de bord`,
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

    // Padlock: only in edit mode, toggles the position lock for this node.
    let lock = null;
    if (state.edit) {
      lock = s('g', {
        class: 'lock',
        transform: `translate(${NW - 24} 6)`,
        tabindex: '0',
        role: 'button',
        'aria-label': `${dev.name} — ${locked ? 'déverrouiller' : 'verrouiller'} la position`,
      });
      lock.append(
        s('rect', { width: '18', height: '18', rx: '3' }),
        s('path', { d: 'M6 9V6.6a3 3 0 0 1 6 0V9' }),
        s('rect', {
          x: '5', y: '9', width: '8', height: '6.5', rx: '1.5',
          fill: locked ? '#e2231a' : '#6b7a89', stroke: 'none',
        }),
      );
      const toggle = (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleLock(dev.id); };
      lock.addEventListener('click', toggle);
      lock.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') toggle(ev);
      });
      g.append(lock);
    }

    const open = () => {
      if (justDragged) return;
      if (state.edit) openDeviceModal(dev.id);
      else goDevice(dev.id);
    };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
    // Drag starts on the node itself; the background handler pans instead.
    g.addEventListener('pointerdown', (ev) => startNodeDrag(ev, dev.id));

    svg.append(g);
    nodeEls.set(dev.id, { g, bar, up, dn, name, model, title, lock });
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

/** Apply the current viewBox (kept in state so pan/zoom work without layout). */
function applyViewBox() {
  const vb = state.mapVB;
  if (!vb) return;
  $('map').setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}

/** viewBox covering every node, whatever the layout (stored or automatic). */
function fitMap() {
  const xs = [];
  const ys = [];
  for (const p of Object.values(POS)) { xs.push(p.x); ys.push(p.y); }
  if (xs.length === 0) { state.mapVB = { x: 0, y: 0, w: 800, h: 300 }; applyViewBox(); return; }
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  const maxX = Math.max(...xs) + NW + PAD;
  const maxY = Math.max(...ys) + NH + PAD;
  state.mapVB = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  state.mapVBBase = { ...state.mapVB };
  applyViewBox();
}

/** Zoom the map around a client point (or its centre when unknown). */
function zoomMap(factor, cx, cy) {
  const vb = state.mapVB;
  if (!vb) return;
  const base = state.mapVBBase || vb;
  const w = Math.min(base.w * 8, Math.max(base.w / 6, vb.w * factor));
  const k = w / vb.w;
  const h = vb.h * k;
  let px = vb.x + vb.w / 2;
  let py = vb.y + vb.h / 2;
  const r = $('map').getBoundingClientRect();
  if (cx !== undefined && r.width > 0 && r.height > 0) {
    px = vb.x + ((cx - r.left) / r.width) * vb.w;
    py = vb.y + ((cy - r.top) / r.height) * vb.h;
  }
  state.mapVB = { x: px - (px - vb.x) * k, y: py - (py - vb.y) * k, w, h };
  applyViewBox();
}

/** Move the view by a number of client pixels. */
function panMap(dxPx, dyPx) {
  const vb = state.mapVB;
  if (!vb) return;
  const r = $('map').getBoundingClientRect();
  const sx = r.width > 0 ? vb.w / r.width : 1;
  const sy = r.height > 0 ? vb.h / r.height : 1;
  vb.x -= dxPx * sx;
  vb.y -= dyPx * sy;
  applyViewBox();
}

/** Redraw every link after a node moved (drag, auto-layout, lock toggle). */
function updateLinkGeometry() {
  for (const link of state.links.values()) {
    const els = linkEls.get(link.id);
    if (!els) continue;
    const e = linkEdge(link);
    if (!e) continue;
    els.edge = e;
    const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180 / Math.PI;
    els.line.setAttribute('x1', String(e.x1));
    els.line.setAttribute('y1', String(e.y1));
    els.line.setAttribute('x2', String(e.x2));
    els.line.setAttribute('y2', String(e.y2));
    els.sp.setAttribute('transform', `translate(${e.x1} ${e.y1}) rotate(${ang})`);
    els.ep.setAttribute('transform', `translate(${e.x2} ${e.y2}) rotate(${ang})`);
    els.labels.setAttribute('transform',
      `translate(${(e.x1 + e.x2) / 2} ${(e.y1 + e.y2) / 2}) rotate(${ang})`);
  }
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

  /* --------------------------------------------------- éditeur de schéma */
  for (const b of $('map-mode').querySelectorAll('button')) {
    b.addEventListener('click', () => setEditMode(b.dataset.mode === 'edit'));
  }
  $('map-add-device').addEventListener('click', () => openDeviceModal(null));
  $('map-add-link').addEventListener('click', () => openLinkModal(null));
  $('map-auto').addEventListener('click', () => { autoLayout().catch(() => {}); });
  $('map-recenter').addEventListener('click', () => fitMap());
  $('map-grid').addEventListener('change', (e) => {
    state.grid = Boolean(e.target.checked);
    mapBuilt = false;
    mark('map');
  });

  const map = $('map');
  map.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    zoomMap(Math.exp(ev.deltaY * 0.0018), ev.clientX, ev.clientY);
  }, { passive: false });
  map.addEventListener('pointerdown', onMapPointerDown);
  map.addEventListener('keydown', onMapKeydown);
  document.addEventListener('pointermove', onDocPointerMove);
  document.addEventListener('pointerup', onDocPointerUp);
  document.addEventListener('pointercancel', onDocPointerUp);

  // device modal
  const closeDevice = () => { $('modal-device').hidden = true; };
  $('dev-close').addEventListener('click', closeDevice);
  $('dev-cancel').addEventListener('click', closeDevice);
  $('modal-device').addEventListener('click', (e) => { if (e.target === $('modal-device')) closeDevice(); });
  $('dev-save').addEventListener('click', () => { saveDevice().catch((err) => showDevError(String(err))); });
  $('dev-del').addEventListener('click', () => { deleteDevice().catch((err) => showDevError(String(err))); });
  $('dev-test').addEventListener('click', () => { testDevice().catch((err) => showDevError(String(err))); });
  $('dev-form').addEventListener('submit', (e) => { e.preventDefault(); saveDevice().catch(() => {}); });
  $('f-ports-mode').addEventListener('change', () => {
    $('f-ports-wrap').hidden = $('f-ports-mode').value !== 'manual';
  });

  // link modal
  const closeLink = () => { $('modal-link').hidden = true; };
  $('lnk-close').addEventListener('click', closeLink);
  $('lnk-cancel').addEventListener('click', closeLink);
  $('modal-link').addEventListener('click', (e) => { if (e.target === $('modal-link')) closeLink(); });
  $('lnk-save').addEventListener('click', () => { saveLink().catch((err) => showLnkError(String(err))); });
  $('lnk-del').addEventListener('click', () => { deleteLink().catch((err) => showLnkError(String(err))); });
  $('lnk-a-dev').addEventListener('change', () => { onLinkDeviceChange('a').catch(() => {}); });
  $('lnk-b-dev').addEventListener('change', () => { onLinkDeviceChange('b').catch(() => {}); });

  // confirmation + token prompts
  $('cf-yes').addEventListener('click', () => closeConfirm(true));
  $('cf-no').addEventListener('click', () => closeConfirm(false));
  $('modal-confirm').addEventListener('click', (e) => { if (e.target === $('modal-confirm')) closeConfirm(false); });
  $('tk-save').addEventListener('click', () => {
    const value = $('tk-input').value.trim();
    if (!value) {
      const box = $('tk-error');
      box.textContent = 'Collez le jeton (fichier data/token).';
      box.hidden = false;
      return;
    }
    closeToken(value);
  });
  $('tk-cancel').addEventListener('click', () => closeToken(null));
  $('tk-close').addEventListener('click', () => closeToken(null));
  $('modal-token').addEventListener('click', (e) => { if (e.target === $('modal-token')) closeToken(null); });
  $('tk-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('tk-save').click(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modal-token').hidden) closeToken(null);
    else if (!$('modal-confirm').hidden) closeConfirm(false);
    else if (!$('modal-device').hidden) $('modal-device').hidden = true;
    else if (!$('modal-link').hidden) $('modal-link').hidden = true;
  });
}

/* ============================================================ éditeur de schéma */

let toastTimer = 0;
function toast(message, kind) {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3400);
}

/* ---- confirmation (native confirm() is not available headless, and the copy
 *      must be translatable): resolves true/false. */
let confirmResolver = null;
function confirmDialog(title, message, okLabel) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $('cf-title').textContent = title;
    $('cf-msg').textContent = message;
    $('cf-yes').textContent = okLabel || 'Supprimer';
    $('modal-confirm').hidden = false;
    $('cf-no').focus?.();
  });
}
function closeConfirm(value) {
  $('modal-confirm').hidden = true;
  const r = confirmResolver;
  confirmResolver = null;
  if (r) r(Boolean(value));
}

/* ---- admin token: asked once per tab, kept in sessionStorage (never logged,
 *      never rendered — a password-type input, value only read back). */
const TOKEN_KEY = 'mikrostats.token';
function storedToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function storeToken(value) {
  try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); }
  catch { /* private mode: the token is then asked for on every write */ }
}
let tokenResolver = null;
function askToken() {
  return new Promise((resolve) => {
    tokenResolver = resolve;
    $('tk-input').value = '';
    $('tk-error').hidden = true;
    $('modal-token').hidden = false;
    $('tk-input').focus?.();
  });
}
function closeToken(value) {
  $('modal-token').hidden = true;
  const r = tokenResolver;
  tokenResolver = null;
  if (r) r(value || '');
}

function describeError(res) {
  const d = (res && res.data) || {};
  const fields = Array.isArray(d.fields) && d.fields.length ? ` (${d.fields.join(', ')})` : '';
  if (res && res.status === 0) return d.error || 'serveur injoignable';
  if (res && res.status === 429) return 'trop d’écritures : réessayez dans une minute';
  if (res && res.status === 412) return 'la topologie a été modifiée ailleurs, réessayez';
  return (d.error || `erreur HTTP ${res && res.status}`) + fields;
}

/**
 * One write path for every editor mutation: token, If-Match rev, one token
 * prompt on 401, topology reload on 412.
 */
async function apiWrite(method, url, body, opts = {}) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  const token = storedToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.rev !== false && state.rev !== null) headers['if-match'] = String(state.rev);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: { error: 'serveur injoignable' } };
  }
  let data = {};
  try { data = await res.json(); } catch { /* corps vide */ }

  if (res.status === 401 && opts.retry !== false) {
    storeToken('');                       // the stored one was refused
    const granted = await askToken();
    if (granted) {
      storeToken(granted);
      return apiWrite(method, url, body, { ...opts, retry: false });
    }
    return { ok: false, status: 401, data: { error: 'unauthorized' } };
  }
  if (res.status === 412) {
    try { await loadTopology(); } catch { /* the stream will refresh it */ }
  }
  if (res.ok && data.rev !== undefined) state.rev = data.rev;
  return { ok: res.ok, status: res.status, data };
}

/* ------------------------------------------------------------ mode édition */

function setEditMode(on) {
  state.edit = Boolean(on);
  for (const b of $('map-mode').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String((b.dataset.mode === 'edit') === state.edit));
  }
  $('map-tools').hidden = !state.edit;
  $('map-wrap').classList.toggle('editing', state.edit);
  $('map-sub').textContent = state.edit
    ? 'Mode édition : glissez pour déplacer, cliquez pour modifier, le cadenas verrouille la position'
    : 'Cliquez sur un équipement pour ouvrir son tableau de bord';
  if (!state.edit && state.grid) {
    state.grid = false;
    $('map-grid').checked = false;
  }
  mapBuilt = false;
  mark('map');
}

function mapScale() {
  const r = $('map').getBoundingClientRect();
  const vb = state.mapVB || { w: 800, h: 300 };
  return {
    x: r.width > 0 ? vb.w / r.width : 1,
    y: r.height > 0 ? vb.h / r.height : 1,
  };
}

function markDragged() {
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 120);
}

/* ---- drag & drop (Pointer Events, one save when the drop lands) */

function startNodeDrag(ev, id) {
  if (!state.edit) return;                      // view mode: let the map pan
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  ev.stopPropagation();
  const dev = state.devices.get(id);
  const p = POS[id];
  if (!dev || !p) return;
  if (dev.layout && dev.layout.locked) return;  // only the padlock reacts
  dragState = {
    id, cx: ev.clientX, cy: ev.clientY, ox: p.x, oy: p.y, sc: mapScale(), moved: false,
  };
  $('map-wrap').classList.add('dragging');
}

function onMapPointerDown(ev) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    pinchState = {
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      cx: (pts[0].x + pts[1].x) / 2,
      cy: (pts[0].y + pts[1].y) / 2,
    };
    panState = null;
    return;
  }
  panState = { cx: ev.clientX, cy: ev.clientY, moved: false };
}

function onDocPointerMove(ev) {
  if (activePointers.has(ev.pointerId)) activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  if (dragState) {
    const dx = (ev.clientX - dragState.cx) * dragState.sc.x;
    const dy = (ev.clientY - dragState.cy) * dragState.sc.y;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    dragState.moved = true;
    let nx = dragState.ox + dx;
    let ny = dragState.oy + dy;
    if (state.grid) { nx = Math.round(nx / 20) * 20; ny = Math.round(ny / 20) * 20; }
    nx = Math.max(-100000, Math.min(100000, Math.round(nx)));
    ny = Math.max(-100000, Math.min(100000, Math.round(ny)));
    POS[dragState.id].x = nx;
    POS[dragState.id].y = ny;
    const els = nodeEls.get(dragState.id);
    if (els) els.g.setAttribute('transform', `translate(${nx} ${ny})`);
    updateLinkGeometry();
    return;
  }

  if (pinchState && activePointers.size >= 2) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinchState.dist > 4 && dist > 4) zoomMap(pinchState.dist / dist, pinchState.cx, pinchState.cy);
    pinchState.dist = dist;
    return;
  }

  if (panState) {
    const dx = ev.clientX - panState.cx;
    const dy = ev.clientY - panState.cy;
    if (!panState.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    panState.moved = true;
    panState.cx = ev.clientX;
    panState.cy = ev.clientY;
    panMap(dx, dy);
  }
}

function onDocPointerUp(ev) {
  activePointers.delete(ev.pointerId);
  if (activePointers.size < 2) pinchState = null;

  if (dragState) {
    const { id, moved } = dragState;
    dragState = null;
    $('map-wrap').classList.remove('dragging');
    if (!moved) return;
    markDragged();
    const p = POS[id];
    const dev = state.devices.get(id);
    persistPositions([{
      id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      locked: Boolean(dev && dev.layout && dev.layout.locked),
    }]);
    return;
  }
  if (panState) {
    const moved = panState.moved;
    panState = null;
    if (moved) markDragged();
  }
}

/** One batched PUT for every position that moved; nothing is written twice. */
async function persistPositions(entries) {
  if (!entries.length) return;
  const res = await apiWrite('PUT', '/api/topology/layout', { devices: entries });
  if (res.ok) {
    for (const e of entries) {
      const d = state.devices.get(e.id);
      if (d) d.layout = { x: e.x, y: e.y, locked: Boolean(e.locked) };
    }
    if (res.data && res.data.written === false) return;   // rien n'a changé
    toast(`Position enregistrée (${entries.length})`);
    return;
  }
  toast(`Position non enregistrée : ${describeError(res)}`, 'err');
  try { await loadTopology(); } catch { /* the stream will refresh it */ }
  mapBuilt = false;
  mark('map');
}

async function toggleLock(id) {
  const dev = state.devices.get(id);
  if (!dev) return;
  const p = POS[id] || { x: 0, y: 0 };
  const locked = !(dev.layout && dev.layout.locked);
  const res = await apiWrite('PUT', '/api/topology/layout', {
    devices: [{ id, x: Math.round(p.x), y: Math.round(p.y), locked }],
  });
  if (!res.ok) { toast(`Position : ${describeError(res)}`, 'err'); return; }
  dev.layout = { x: Math.round(p.x), y: Math.round(p.y), locked };
  toast(locked ? `${dev.name} verrouillé` : `${dev.name} déverrouillé`);
  mapBuilt = false;
  mark('map');
}

/** Recompute the tree layout and store it in ONE batched write. */
async function autoLayout() {
  const devices = [...state.devices.values()];
  if (!devices.length) return;
  const saved = new Map(devices.map((d) => [d.id, d.layout]));
  for (const d of devices) d.layout = null;          // ignore stored positions
  const pos = computeLayout();
  for (const d of devices) d.layout = saved.get(d.id);

  const entries = [];
  for (const d of devices) {
    const p = pos[d.id];
    if (!p) continue;
    entries.push({
      id: d.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      locked: saved.get(d.id)?.locked === true,
    });
  }
  await persistPositions(entries);
  for (const e of entries) POS[e.id] = { ...(POS[e.id] || {}), x: e.x, y: e.y };
  mapBuilt = false;
  mark('map');
}

function onMapKeydown(ev) {
  if (ev.target !== $('map')) return;               // nodes handle their own keys
  const vb = state.mapVB;
  if (!vb) return;
  const step = Math.max(10, Math.round(vb.w / 20));
  let handled = true;
  switch (ev.key) {
    case '+': case '=': zoomMap(1 / 1.25); break;
    case '-': case '_': zoomMap(1.25); break;
    case '0': fitMap(); break;
    case 'ArrowLeft': panMap(step, 0); break;
    case 'ArrowRight': panMap(-step, 0); break;
    case 'ArrowUp': panMap(0, step); break;
    case 'ArrowDown': panMap(0, -step); break;
    default: handled = false;
  }
  if (handled) ev.preventDefault();
}

/* ------------------------------------------------------------ modal appareil */

let deviceModalId = null;

function slugify(value) {
  return String(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function uniqueDeviceId(name) {
  const base = slugify(name) || 'equipement';
  let id = base;
  let n = 1;
  while (state.devices.has(id)) { n += 1; id = `${base}-${n}`.slice(0, 64); }
  return id;
}

/** Link ids are derived from both endpoints (max 64 chars, ID_RE safe). */
function uniqueLinkId(a, b) {
  const raw = `${a.device}-${a.port}-${b.device}-${b.port}`;
  const base = (/^[A-Za-z0-9]/.test(raw) ? raw : `l-${raw}`).slice(0, 56);
  let id = base;
  let n = 1;
  while (state.links.has(id)) { n += 1; id = `${base.slice(0, 58)}-${n}`; }
  return id;
}

function openDeviceModal(id) {
  const dev = id ? state.devices.get(id) : null;
  deviceModalId = dev ? dev.id : null;
  $('dev-title').textContent = dev ? `Modifier ${dev.name}` : 'Ajouter un équipement';
  $('f-id').value = dev ? dev.id : '';
  $('f-id').disabled = Boolean(dev);
  $('f-name').value = dev ? dev.name : '';
  $('f-type').value = dev ? dev.type : 'switch';
  $('f-model').value = (dev && dev.model) || '';
  $('f-host').value = (dev && dev.host) || '';
  $('f-port').value = dev && dev.port ? String(dev.port) : '';
  $('f-auth').value = (dev && dev.auth) || 'digest';
  $('f-user').value = (dev && dev.username) || '';
  $('f-pass').value = '';
  $('f-interval').value = String(Math.max(1, Math.round(((dev && dev.intervalMs) || 3000) / 1000)));
  $('f-ports-mode').value = (dev && dev.portsMode) || 'auto';
  $('f-ports').value = (dev && Array.isArray(dev.ports) ? dev.ports : [])
    .map((p) => `${p.index} ${p.name || ''} ${p.kind || 'ethernet'}`.replace(/\s+/g, ' ').trim())
    .join('\n');
  $('f-root').checked = Boolean(dev && dev.root) || (!dev && state.devices.size === 0);
  $('f-enabled').checked = !dev || dev.enabled !== false;
  $('f-tls').checked = Boolean(dev && dev.tls);
  $('f-ports-wrap').hidden = $('f-ports-mode').value !== 'manual';
  $('dev-error').hidden = true;
  $('dev-test-result').hidden = true;
  $('dev-del').hidden = !dev;
  $('modal-device').hidden = false;
  $('f-name').focus?.();
}

function collectCredentials() {
  const username = $('f-user').value.trim();
  const password = $('f-pass').value;
  if (!username && !password) return null;    // blank = keep what is stored
  return { username, password };
}

function collectDevice() {
  const portsMode = $('f-ports-mode').value;
  const ports = [];
  if (portsMode === 'manual') {
    for (const raw of $('f-ports').value.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^(\d{1,3})\s*(.*)$/.exec(line);
      if (!m) continue;
      const index = Number(m[1]);
      if (!Number.isInteger(index) || index < 1 || index > 512) continue;
      const rest = m[2].trim();
      const kindMatch = /\s(ethernet|sfp)$/i.exec(rest);
      const kind = kindMatch ? kindMatch[1].toLowerCase() : 'ethernet';
      const name = (kindMatch ? rest.slice(0, kindMatch.index) : rest).trim() || null;
      ports.push({ index, kind, name, speedBps: null });
    }
  }
  const interval = Number($('f-interval').value);
  const body = {
    ...(deviceModalId ? {} : { id: $('f-id').value.trim() || uniqueDeviceId($('f-name').value.trim()) }),
    type: $('f-type').value,
    name: $('f-name').value.trim(),
    model: $('f-model').value.trim() || null,
    host: $('f-host').value.trim(),
    port: Number($('f-port').value) || null,
    tls: $('f-tls').checked,
    auth: $('f-auth').value,
    intervalMs: (Number.isFinite(interval) && interval >= 1 ? Math.round(interval) : 3) * 1000,
    root: $('f-root').checked,
    enabled: $('f-enabled').checked,
    portsMode,
    ports,
  };
  // Switching type switches the driver too (swos <-> routeros); otherwise the
  // stored driver is left alone.
  const original = deviceModalId ? state.devices.get(deviceModalId) : null;
  if (original && original.type !== body.type) {
    body.driver = body.type === 'router' ? 'routeros' : 'swos';
  }
  return body;
}

function showDevError(message) {
  const box = $('dev-error');
  box.textContent = message;
  box.hidden = false;
}

async function saveDevice() {
  const name = $('f-name').value.trim();
  const host = $('f-host').value.trim();
  $('dev-error').hidden = true;
  if (!name) { showDevError('Le nom est requis.'); return; }
  if (!host) { showDevError('L’adresse IP ou le hostname est requis.'); return; }

  const body = collectDevice();
  const credentials = collectCredentials();
  if (credentials) body.credentials = credentials;

  const isNew = !deviceModalId;
  const url = isNew ? '/api/devices' : `/api/devices/${encodeURIComponent(deviceModalId)}`;
  const res = await apiWrite(isNew ? 'POST' : 'PATCH', url, body);
  if (res.ok) {
    $('modal-device').hidden = true;
    toast(isNew ? 'Équipement ajouté' : 'Équipement mis à jour');
    mapBuilt = false;
    mark('map');
    return;
  }
  showDevError(describeError(res));
}

async function deleteDevice() {
  const dev = state.devices.get(deviceModalId);
  if (!dev) return;
  const touching = [...state.links.values()]
    .filter((l) => l.a.device === dev.id || l.b.device === dev.id).length;
  const ok = await confirmDialog(
    'Supprimer l’équipement',
    `Supprimer « ${dev.name} » ? ${touching ? `${touching} lien(s) seront aussi supprimés. ` : ''}Son historique sera effacé.`,
    'Supprimer',
  );
  if (!ok) return;
  const res = await apiWrite('DELETE', `/api/devices/${encodeURIComponent(dev.id)}`);
  if (res.ok) {
    $('modal-device').hidden = true;
    toast('Équipement supprimé');
    mapBuilt = false;
    mark('map');
    return;
  }
  showDevError(describeError(res));
}

async function testDevice() {
  const btn = $('dev-test');
  const out = $('dev-test-result');
  btn.disabled = true;
  out.hidden = false;
  out.className = 'fmsg';
  out.textContent = 'Test en cours…';

  const isNew = !deviceModalId;
  const payload = isNew ? { device: collectDevice() } : { id: deviceModalId };
  const credentials = collectCredentials();
  if (credentials) payload.credentials = credentials;

  const res = await apiWrite('POST', '/api/devices/test', payload, { rev: false });
  btn.disabled = false;
  if (res.ok) {
    const d = res.data || {};
    const sys = d.system || {};
    out.className = 'fmsg ok';
    out.textContent = `Connexion réussie en ${d.latencyMs ?? '?'} ms`
      + (sys.identity ? ` — ${sys.identity}` : '')
      + (d.portCount ? ` — ${d.portCount} ports` : '')
      + (d.mode ? ` (${d.mode})` : '');
    return;
  }
  out.className = 'fmsg err';
  out.textContent = `Échec : ${describeError(res)}`;
}

/* -------------------------------------------------------------- modal lien */

let linkModalId = null;

function portChoices(devId) {
  const out = [];
  const live = state.live.get(devId);
  if (live && Array.isArray(live.ports)) {
    for (const p of live.ports) out.push({ index: p.port, name: p.name || `Port${p.port}` });
  }
  const dev = state.devices.get(devId);
  if (!out.length && dev && Array.isArray(dev.ports)) {
    for (const p of dev.ports) out.push({ index: p.index, name: p.name || `Port${p.index}` });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Known ports -> select, unknown device -> numeric input (never invented). */
function renderPortPicker(container, devId, selected) {
  container.replaceChildren();
  const choices = portChoices(devId);
  let node;
  if (choices.length) {
    node = document.createElement('select');
    for (const c of choices) {
      const opt = document.createElement('option');
      opt.value = String(c.index);
      opt.textContent = `${c.name} (port ${c.index})`;
      node.append(opt);
    }
    container.dataset.mode = 'select';
  } else {
    node = document.createElement('input');
    node.type = 'number';
    node.min = '1';
    node.max = '512';
    node.placeholder = 'numéro du port';
    container.dataset.mode = 'number';
  }
  if (selected) node.value = String(selected);
  container.append(node);
}

function portPickerValue(container) {
  const node = container.firstElementChild;
  if (!node) return null;
  const v = Number(node.value);
  return Number.isInteger(v) && v >= 1 && v <= 512 ? v : null;
}

async function ensurePorts(devId) {
  if (!devId || state.live.has(devId)) return;
  await fetchDeviceStats(devId);
}

async function openLinkModal(id, presetA, presetB) {
  linkModalId = id || null;
  const link = id ? state.links.get(id) : null;
  $('lnk-title').textContent = link ? 'Modifier le lien' : 'Nouveau lien';
  $('lnk-error').hidden = true;
  $('lnk-del').hidden = !link;

  const devices = [...state.devices.values()];
  if (!devices.length) { toast('Ajoutez d’abord un équipement', 'err'); return; }
  const fill = (sel, value) => {
    sel.replaceChildren();
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.name} (${d.host || 'sans IP'})`;
      sel.append(opt);
    }
    if (value && devices.some((d) => d.id === value)) sel.value = value;
  };
  const root = devices.find((d) => d.root) || devices[0];
  const other = devices.find((d) => d.id !== root.id);
  fill($('lnk-a-dev'), link ? link.a.device : (presetA || root.id));
  fill($('lnk-b-dev'), link ? link.b.device : (presetB || (other ? other.id : root.id)));
  $('lnk-label').value = (link && link.label) || '';
  $('lnk-cap').value = link && link.capacityBps ? String(Math.round(link.capacityBps / 1e6)) : '';

  $('modal-link').hidden = false;
  await Promise.all([ensurePorts($('lnk-a-dev').value), ensurePorts($('lnk-b-dev').value)]);
  renderPortPicker($('lnk-a-port'), $('lnk-a-dev').value, link ? link.a.port : null);
  renderPortPicker($('lnk-b-port'), $('lnk-b-dev').value, link ? link.b.port : null);
}

function showLnkError(message) {
  const box = $('lnk-error');
  box.textContent = message;
  box.hidden = false;
}

async function onLinkDeviceChange(side) {
  const devId = $(`lnk-${side}-dev`).value;
  renderPortPicker($(`lnk-${side}-port`), devId, null);
  if (!state.live.has(devId)) {
    await ensurePorts(devId);
    renderPortPicker($(`lnk-${side}-port`), devId, null);
  }
}

async function saveLink() {
  $('lnk-error').hidden = true;
  const isNew = !linkModalId;
  const a = { device: $('lnk-a-dev').value, port: portPickerValue($('lnk-a-port')) };
  const b = { device: $('lnk-b-dev').value, port: portPickerValue($('lnk-b-port')) };
  if (!a.device || !b.device) { showLnkError('Choisissez deux équipements.'); return; }
  if (!a.port || !b.port) { showLnkError('Choisissez un port sur chaque équipement.'); return; }
  if (a.device === b.device && a.port === b.port) {
    showLnkError('Les deux extrémités sont identiques.');
    return;
  }
  const capacity = Number($('lnk-cap').value);
  const body = {
    a,
    b,
    label: $('lnk-label').value.trim() || null,
    capacityBps: Number.isFinite(capacity) && capacity > 0 ? Math.round(capacity * 1e6) : null,
  };
  // The API needs an id on creation: derive it from the two endpoints so a
  // recreated link keeps a stable, readable identifier.
  if (isNew) body.id = uniqueLinkId(a, b);
  const url = isNew ? '/api/links' : `/api/links/${encodeURIComponent(linkModalId)}`;
  const res = await apiWrite(isNew ? 'POST' : 'PATCH', url, body);
  if (res.ok) {
    $('modal-link').hidden = true;
    toast(isNew ? 'Lien créé' : 'Lien mis à jour');
    mapBuilt = false;
    mark('map');
    return;
  }
  showLnkError(describeError(res));
}

async function deleteLink() {
  const link = state.links.get(linkModalId);
  if (!link) return;
  const a = deviceName(link.a.device);
  const b = deviceName(link.b.device);
  const ok = await confirmDialog('Supprimer le lien', `Supprimer le lien ${a} ↔ ${b} ?`, 'Supprimer');
  if (!ok) return;
  const res = await apiWrite('DELETE', `/api/links/${encodeURIComponent(link.id)}`);
  if (res.ok) {
    $('modal-link').hidden = true;
    toast('Lien supprimé');
    mapBuilt = false;
    mark('map');
    return;
  }
  showLnkError(describeError(res));
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
