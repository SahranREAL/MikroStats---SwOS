/* MikroTik SwOS Monitor - front-end.
 *
 * Rules this file obeys:
 *  - the browser NEVER talks to the switch; it reads /api/stream (SSE) and
 *    /api/history (on demand only);
 *  - IN and OUT are always two curves of the same chart, on the same axes;
 *  - nothing runs on a timer when the page is hidden or the stream is down;
 *  - charts are created once and updated in place, never rebuilt per sample.
 */
'use strict';

// chartjs-plugin-zoom registers itself when loaded; Hammer is only needed for
// pinch gestures and is optional.
if (!window.Chart) throw new Error('Chart.js failed to load');

const COLORS = {
  in: '#3b82f6',
  out: '#6366f1',
  grid: '#1e293b',
  tick: '#94a3b8',
  inFill: 'rgba(59, 130, 246, 0.10)',
  outFill: 'rgba(99, 102, 241, 0.10)',
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

/* --------------------------------------------------------------- formatting */

function fmtBps(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '0 bps';
  if (bps >= 1e9) return (bps / 1e9).toFixed(bps >= 1e10 ? 1 : 2) + ' Gbps';
  if (bps >= 1e6) return (bps / 1e6).toFixed(bps >= 1e7 ? 1 : 2) + ' Mbps';
  if (bps >= 1e3) return (bps / 1e3).toFixed(bps >= 1e4 ? 0 : 1) + ' Kbps';
  return Math.round(bps) + ' bps';
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

// 24h clock, formatted by hand on purpose. toLocaleTimeString with hour12:false
// renders midnight as "24:05" on some ICU builds/locales, and the result
// otherwise depends on the browser locale. Local time is used, like the
// toLocale* helpers did, but the output is now identical everywhere.
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
  return Math.round(v);
}

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* -------------------------------------------------------------------- state */

const state = {
  range: '5m',
  modalRange: '1h',
  modalPort: 0,
  ports: new Map(),       // port index -> live metrics
  peak: new Map(),        // port index -> {in, out}
  stats: null,            // aggregate stats for the selected range
  status: null,
  connected: false,
  sort: { key: 'totalBps', dir: -1 },
  filter: '',
  onlyActive: false,
  liveTail: { t: [], in: [], out: [] },
  liveCap: 400,
  zoomed: false,
  lastStatsFetch: 0,
};

let globalChart = null;
let portChart = null;
const sparklines = new Map(); // port index -> Sparkline
const portCards = new Map();  // port index -> card element
const pendingHistory = new Map();

/* ------------------------------------------------------------------ charts */

const zoomPlugin = {
  zoom: {
    zoom: {
      wheel: { enabled: true },
      pinch: { enabled: true },
      mode: 'x',
    },
    pan: { enabled: true, mode: 'x' },
    limits: { x: { minRange: 5000 } },
  },
};

function baseOptions(height) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    parsing: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 6, bottom: 0, left: 0 } },
    plugins: {
      legend: { display: true, labels: { color: COLORS.tick, boxWidth: 10, boxHeight: 2, font: { size: 11 }, padding: 12 } },
      zoom: zoomPlugin.zoom,
      tooltip: {
        backgroundColor: 'rgba(10,16,32,0.95)',
        borderColor: '#1e293b',
        borderWidth: 1,
        titleColor: '#e2e8f0',
        bodyColor: '#cbd5e1',
        padding: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 2,
        callbacks: {
          title: (items) => (items.length ? fmtStamp(items[0].parsed.x) : ''),
          label: (ctx) => {
            const peak = ctx.dataset.key === 'in' ? ctx.dataset.peak : ctx.dataset.peakOut;
            const v = peak ? Math.max(peak[ctx.dataIndex] || 0, ctx.parsed.y) : ctx.parsed.y;
            return ` ${ctx.dataset.label}: ${fmtBps(v)}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        grid: { display: false },
        border: { color: '#1e293b' },
        ticks: {
          color: COLORS.tick,
          maxTicksLimit: 8,
          font: { size: 10 },
          callback: (v) => fmtStamp(v),
        },
      },
      y: {
        beginAtZero: true,
        grid: { color: COLORS.grid, drawTicks: false },
        border: { display: false },
        ticks: { color: COLORS.tick, font: { size: 10 }, maxTicksLimit: 6, padding: 6, callback: (v) => fmtBps(v) },
      },
    },
  };
}

function makeDataset(label, color, fill) {
  return {
    label,
    key: label === 'IN' ? 'in' : 'out',
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

/** Both directions, always: one chart, two curves, one y axis, one time axis. */
function newChart(canvas) {
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets: [makeDataset('IN', COLORS.in, COLORS.inFill), makeDataset('OUT', COLORS.out, COLORS.outFill)] },
    options: baseOptions(),
  });
}

function applySeries(chart, series) {
  if (!chart) return;
  const t = series.t || [];
  const inn = series.in || [];
  const out = series.out || [];
  const ds = chart.data.datasets;
  ds[0].data = t.map((x, i) => ({ x, y: inn[i] || 0 }));
  ds[1].data = t.map((x, i) => ({ x, y: out[i] || 0 }));
  ds[0].peak = series.inMax || inn;
  ds[1].peak = series.outMax || out;
  chart.update('none');
}

function resetZoom(chart) {
  if (chart) chart.resetZoom();
}

/* ------------------------------------------------------------- sparklines */

/**
 * Tiny canvas renderer for the 26 port cards. Using a hand-rolled renderer here
 * (instead of 26 Chart.js instances) is what keeps the dashboard smooth on a
 * weak CPU. IN and OUT are still two curves of the same mini chart.
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

    // baseline
    ctx.strokeStyle = '#1e293b';
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

    line(this.out, COLORS.out);
    line(this.inn, COLORS.in);
  }

  reset() { this.inn.length = 0; this.out.length = 0; this.draw(); }
}

/* --------------------------------------------------------------- rendering */

function renderHeader(status) {
  state.status = status;
  $('hdr-switch').textContent = status.switchName || '-';
  $('hdr-ip').textContent = status.switchIp || '-';
  $('hdr-update').textContent = fmtClock(status.lastUpdate);
  $('hdr-poll').textContent = status.pollIntervalMs ? `${Math.round(status.pollIntervalMs / 1000)}s` : '-';

  const conn = $('hdr-conn');
  conn.dataset.state = status.status || 'disconnected';
  $('hdr-conn-text').textContent =
    status.status === 'connected' ? 'Connected' : status.status === 'degraded' ? 'Degraded' : 'Disconnected';

  const banner = $('banner');
  if (status.status === 'connected') {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    $('banner-title').textContent = status.status === 'degraded' ? 'Switch degrade' : 'Switch inaccessible';
    const parts = [`Last successful update : ${fmtClock(status.lastUpdate)}`];
    if (status.lastError) parts.push(`Last error : ${status.lastError}`);
    if (status.consecutiveErrors) parts.push(`${status.consecutiveErrors} consecutive failures`);
    $('banner-body').textContent = parts.join(' - ');
  }
}

function renderKpis(sample, stats) {
  $('kpi-in').textContent = fmtBps(sample.inBps);
  $('kpi-out').textContent = fmtBps(sample.outBps);
  $('kpi-rx-total').textContent = fmtBytes(sample.totalRxBytes);
  $('kpi-tx-total').textContent = fmtBytes(sample.totalTxBytes);
  $('ro-in').textContent = fmtBps(sample.inBps);
  $('ro-out').textContent = fmtBps(sample.outBps);

  if (stats) {
    $('kpi-in-avg').textContent = `avg ${fmtBps(stats.inAvg)}`;
    $('kpi-out-avg').textContent = `avg ${fmtBps(stats.outAvg)}`;
    $('kpi-in-max').textContent = fmtBps(stats.inMax);
    $('kpi-out-max').textContent = fmtBps(stats.outMax);
    $('ro-in-max').textContent = fmtBps(stats.inMax);
    $('ro-out-max').textContent = fmtBps(stats.outMax);
    $('kpi-in-max-at').textContent = `sur ${RANGE_TITLES[state.range]}`;
    $('kpi-out-max-at').textContent = `sur ${RANGE_TITLES[state.range]}`;
  }

  let up = 0;
  let down = 0;
  let unknown = 0;
  for (const p of state.ports.values()) {
    if (p.link === true) up++;
    else if (p.link === false) down++;
    else unknown++;
  }
  $('kpi-ports-up').textContent = unknown > 0 && up === 0 ? '-' : `${up}`;
  $('kpi-ports-down').textContent = down > 0 ? `${down} down` : (unknown ? `${unknown} ?` : 'aucun');
  $('kpi-ports-down').className = 'kpi-s' + (down > 0 ? ' err' : '');
}

function renderPortsGrid() {
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
      const inVal = el('b', 'in', '-');
      inRow.append(el('em', null, 'IN'), inVal);
      const outRow = el('span');
      const outVal = el('b', 'out', '-');
      outRow.append(el('em', null, 'OUT'), outVal);
      rate.append(inRow, outRow);

      const canvas = document.createElement('canvas');
      canvas.className = 'chart-sm';

      card.append(hd, rate, canvas);
      const open = () => openPort(p.port);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      grid.append(card);
      portCards.set(p.port, card);
      sparklines.set(p.port, new Sparkline(canvas, COLORS.in, COLORS.out));

      // Cache the nodes we rewrite on every sample: no querySelector per frame.
      card._parts = { name, badge, inVal, outVal };
    }

    const parts = card._parts;
    parts.name.textContent = p.name;
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

  $('ports-sub').textContent = `${state.ports.size} ports - IN et OUT sur le meme graphique`;
}

function sortedPorts() {
  const list = Array.from(state.ports.values());
  const { key, dir } = state.sort;
  const value = (p) => {
    switch (key) {
      case 'totalBps': return p.inBps + p.outBps;
      case 'inPeak': return (state.peak.get(p.port) || { in: 0 }).in;
      case 'outPeak': return (state.peak.get(p.port) || { out: 0 }).out;
      case 'linkSpeed': return p.speed || 0;
      default: return p[key];
    }
  };
  list.sort((a, b) => {
    if (key === 'port' || key === 'link') {
      const av = key === 'port' ? a.port : a.link === true ? 2 : a.link === false ? 0 : 1;
      const bv = key === 'port' ? b.port : b.link === true ? 2 : b.link === false ? 0 : 1;
      return (av - bv) * dir;
    }
    return (value(a) - value(b)) * dir;
  });
  if (state.filter) {
    const f = state.filter.toLowerCase();
    return list.filter((p) => p.name.toLowerCase().includes(f) || String(p.port) === f);
  }
  return list;
}

function renderTable() {
  const tbody = $('port-tbody');
  const frag = document.createDocumentFragment();
  for (const p of sortedPorts()) {
    const pk = state.peak.get(p.port) || { in: 0, out: 0 };
    const tr = el('tr');
    tr.dataset.port = String(p.port);
    if (p.port === state.modalPort) tr.className = 'sel';

    const name = el('td', 'name', p.name);
    const status = el('td');
    const badge = el('span', 'badge ' + (p.link === true ? 'up' : p.link === false ? 'down' : 'unknown'),
      p.link === true ? 'UP' : p.link === false ? 'DOWN' : '?');
    status.append(badge);

    tr.append(
      name,
      status,
      el('td', 'num in', fmtBps(p.inBps)),
      el('td', 'num out', fmtBps(p.outBps)),
      el('td', 'num', fmtBps(p.inBps + p.outBps)),
      el('td', 'num in', fmtBps(pk.in)),
      el('td', 'num out', fmtBps(pk.out)),
      el('td', 'num', fmtBytes(p.rxBytes)),
      el('td', 'num', fmtBytes(p.txBytes)),
      el('td', 'num', p.speed ? fmtSpeed(p.speed) : '-')
    );
    tr.addEventListener('click', () => openPort(p.port));
    frag.append(tr);
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

function renderSystem(extra) {
  const s = state.status;
  if (!s) return;
  const rows = [
    ['Switch', s.status === 'connected' ? 'Connected' : s.status === 'degraded' ? 'Degraded' : 'Disconnected',
      s.status === 'connected' ? 'ok' : s.status === 'degraded' ? 'warn' : 'err'],
    ['Last update', fmtClock(s.lastUpdate), ''],
    ['Last error', s.lastError || 'aucune', s.lastError ? 'err' : ''],
    ['Polling', s.pollIntervalMs ? `${Math.round(s.pollIntervalMs / 1000)} s` : '-', ''],
    ['Poll duration', s.lastDurationMs ? `${s.lastDurationMs} ms` : '-', ''],
    ['Successful polls', String(s.successfulPolls), ''],
    ['Errors', String(s.failedPolls), s.failedPolls > 0 ? 'warn' : ''],
    ['Consecutive errors', String(s.consecutiveErrors), s.consecutiveErrors > 0 ? 'err' : ''],
    ['Application uptime', fmtDuration(s.appUptimeMs), ''],
    ['Link data age', s.linkUpdatedAt ? fmtDuration(Date.now() - s.linkUpdatedAt) : '-', ''],
  ];
  if (extra && extra.store) {
    rows.push(['Database', `${fmtBytes(extra.store.dbBytes)} - ${extra.store.rows} lignes`, '']);
    rows.push(['Buffer RAM', `${state.ports.size * 2} series x ${extra.ram ? extra.ram.maxPoints : '?'} points`, '']);
    rows.push(['Stream clients', String(extra.sseClients != null ? extra.sseClients : 0), '']);
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

/* ------------------------------------------------------------------ history */

async function loadHistory(range, port) {
  const key = `${range}:${port}`;
  if (pendingHistory.has(key)) return;
  const token = Symbol('req');
  pendingHistory.set(key, token);
  try {
    const qs = new URLSearchParams({ range, port: String(port) });
    const res = await fetch(`/api/history?${qs}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (pendingHistory.get(key) !== token) return; // superseded
    return data;
  } finally {
    if (pendingHistory.get(key) === token) pendingHistory.delete(key);
  }
}

async function refreshGlobal() {
  const data = await loadHistory(state.range, 0);
  if (!data) return;
  applySeries(globalChart, data);
  state.stats = data.stats;
  renderKpis(state.lastSample || { inBps: 0, outBps: 0, totalRxBytes: 0, totalTxBytes: 0 }, data.stats);
  if (data.peaks) applyPeaks(data.peaks);
  renderTable();
}

function applyPeaks(peaks) {
  for (const p of peaks) state.peak.set(p.port, { in: p.inMax, out: p.outMax });
}

/* ------------------------------------------------------------------ streaming */

function applySample(sample) {
  state.lastSample = sample;

  for (const p of sample.ports) {
    const existing = state.ports.get(p.port);
    if (existing) {
      existing.inBps = p.inBps;
      existing.outBps = p.outBps;
      existing.rxBytes = p.rxBytes;
      existing.txBytes = p.txBytes;
      existing.link = p.link;
      existing.speed = p.speed;
    } else {
      state.ports.set(p.port, { port: p.port, name: `Port${p.port}`, ...p });
    }
    const spark = sparklines.get(p.port);
    if (spark) spark.push(p.inBps, p.outBps);
  }

  // Live tail keeps the chart moving between history refreshes.
  if (!sample.first) {
    state.liveTail.t.push(sample.t);
    state.liveTail.in.push(sample.inBps);
    state.liveTail.out.push(sample.outBps);
    if (state.liveTail.t.length > state.liveCap) {
      state.liveTail.t.shift(); state.liveTail.in.shift(); state.liveTail.out.shift();
    }
  }

  const isShort = ['5m', '15m', '1h'].includes(state.range);
  if (isShort) {
    appendLiveToChart(globalChart, state.range);
  }

  renderKpis(sample, state.stats);
  renderHeader({
    ...(state.status || {}),
    status: sample.status,
    stale: sample.stale,
    lastUpdate: sample.t,
  });

  renderPortsGrid();
  renderTable();
}

function appendLiveToChart(chart, rangeKey) {
  if (!chart) return;
  const span = RANGES.find((r) => r.key === rangeKey).ms;
  const from = Date.now() - span;
  const ds = chart.data.datasets;
  let changed = false;
  for (let i = 0; i < state.liveTail.t.length; i++) {
    const t = state.liveTail.t[i];
    if (t < from) continue;
    const last = ds[0].data[ds[0].data.length - 1];
    if (!last || t > last.x) {
      ds[0].data.push({ x: t, y: state.liveTail.in[i] });
      ds[1].data.push({ x: t, y: state.liveTail.out[i] });
      changed = true;
    }
  }
  if (!changed) return;

  // Keep the series bounded and inside the window (memory + clarity).
  const cutoff = from;
  while (ds[0].data.length > 0 && ds[0].data[0].x < cutoff) {
    ds[0].data.shift();
    ds[1].data.shift();
    ds[0].peak.shift();
    ds[1].peak.shift();
  }
  const max = 720;
  while (ds[0].data.length > max) { ds[0].data.shift(); ds[1].data.shift(); }
  chart.update('none');
}

function connect() {
  const es = new EventSource('/api/stream');

  es.addEventListener('hello', (e) => {
    state.connected = true;
    const s = JSON.parse(e.data);
    renderHeader(s);
  });

  es.addEventListener('sample', (e) => {
    state.connected = true;
    applySample(JSON.parse(e.data));
  });

  es.addEventListener('status', (e) => renderHeader(JSON.parse(e.data)));
  es.addEventListener('statusChange', (e) => {
    const s = JSON.parse(e.data);
    renderHeader({ ...(state.status || {}), ...s });
  });

  es.onerror = () => {
    state.connected = false;
    // EventSource reconnects on its own (retry hint sent by the server).
    if (state.status) {
      renderHeader({ ...state.status, status: 'disconnected' });
    }
  };
}

async function pollSystemStatus() {
  try {
    const res = await fetch('/api/status', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const s = await res.json();
    state.status = s;
    renderHeader(s);
    renderSystem(s);
    $('foot-version').textContent = `mikrostats ${s.version} - node ${s.node}`;
    $('foot-store').textContent = s.store && s.store.ready
      ? `sqlite ${fmtBytes(s.store.dbBytes)} - ${s.store.rows} rows - retention 30d`
      : 'sqlite indisponible';
  } catch { /* offline: the SSE stream and banner already say so */ }
}

/* -------------------------------------------------------------------- modal */

async function openPort(port) {
  const p = state.ports.get(port);
  if (!p) return;
  state.modalPort = port;
  $('modal').hidden = false;
  $('modal-title').textContent = `${p.name} - vue detaillee`;

  const pk = state.peak.get(port) || { in: 0, out: 0 };
  const facts = [
    ['Status', p.link === true ? 'UP' : p.link === false ? 'DOWN' : 'inconnu', p.link === true ? 'ok' : p.link === false ? 'err' : ''],
    ['Link', p.speed ? fmtSpeed(p.speed) + ' bps' : '-', ''],
    ['Duplex', p.duplex || '-', ''],
    ['IN', fmtBps(p.inBps), 'in'],
    ['OUT', fmtBps(p.outBps), 'out'],
    ['Peak IN', fmtBps(pk.in), 'in'],
    ['Peak OUT', fmtBps(pk.out), 'out'],
    ['RX Total', fmtBytes(p.rxBytes), ''],
    ['TX Total', fmtBytes(p.txBytes), ''],
  ];
  const frag = document.createDocumentFragment();
  for (const [k, v, cls] of facts) {
    const row = el('div', 'sysrow');
    row.append(el('span', null, k), el('b', cls || null, v));
    frag.append(row);
  }
  $('modal-facts').replaceChildren(frag);

  if (!portChart) portChart = newChart($('chart-port'));
  buildRangeButtons($('modal-range'), state.modalRange, (key) => {
    state.modalRange = key;
    loadPortHistory();
  });
  await loadPortHistory();
  renderTable();
}

function closePort() {
  $('modal').hidden = true;
  state.modalPort = 0;
  if (portChart) resetZoom(portChart);
  renderTable();
}

async function loadPortHistory() {
  if (!state.modalPort || !portChart) return;
  const data = await loadHistory(state.modalRange, state.modalPort);
  if (!data || state.modalPort === 0) return;
  applySeries(portChart, data);
}

/* ------------------------------------------------------------------ controls */

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
  buildRangeButtons($('range-btns'), state.range, async (key) => {
    state.range = key;
    $('range-label').textContent = RANGE_TITLES[key];
    state.liveTail = { t: [], in: [], out: [] };
    resetZoom(globalChart);
    state.zoomed = false;
    $('zoom-tools').hidden = true;
    for (const s of sparklines.values()) s.reset();
    await refreshGlobal();
  });

  $('zoom-tools').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !globalChart) return;
    if (btn.dataset.zoom === 'in') globalChart.zoom(1.4, undefined, 'x');
    else if (btn.dataset.zoom === 'out') globalChart.zoom(0.7, undefined, 'x');
    else { globalChart.resetZoom(); state.zoomed = false; $('zoom-tools').hidden = true; }
  });

  // Reveal the zoom toolbar as soon as the user has zoomed by drag or wheel.
  $('chart-global').addEventListener('mouseup', () => {
    if (globalChart && globalChart.isZoomActive && globalChart.isZoomActive()) {
      state.zoomed = true;
      $('zoom-tools').hidden = false;
    }
  });
  $('chart-global').addEventListener('wheel', () => {
    if (globalChart && globalChart.isZoomActive && globalChart.isZoomActive()) {
      state.zoomed = true;
      $('zoom-tools').hidden = false;
    }
  }, { passive: true });

  $('only-active').addEventListener('change', (e) => { state.onlyActive = e.target.checked; renderPortsGrid(); });
  $('table-filter').addEventListener('input', (e) => { state.filter = e.target.value.trim(); renderTable(); });

  for (const th of document.querySelectorAll('#port-table th')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 'port' || key === 'link' ? 1 : -1 };
      renderTable();
    });
  }

  $('modal-close').addEventListener('click', closePort);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closePort(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closePort(); });

  // Stop all rendering work while the tab is in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pollSystemStatus();
      refreshGlobal();
    }
  });
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  globalChart = newChart($('chart-global'));
  $('range-label').textContent = RANGE_TITLES[state.range];
  wireControls();

  // A single REST snapshot first so the UI is populated before the first frame.
  try {
    const res = await fetch('/api/stats', { headers: { accept: 'application/json' } });
    if (res.ok) {
      const s = await res.json();
      renderHeader(s);
      state.ports.clear();
      for (const p of s.ports || []) {
        state.ports.set(p.port, { ...p });
        state.peak.set(p.port, { in: 0, out: 0 });
      }
      if (s.inBps != null) state.lastSample = s;
      renderPortsGrid();
      renderKpis(s, null);
      renderTable();
    }
  } catch { /* the stream will recover it */ }

  await refreshGlobal();
  renderSystem(null);
  connect();
  pollSystemStatus();

  // Slow background refreshes only: peaks, storage health, uptime.
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

boot().catch((err) => {
  // Never leave a blank page: show what went wrong.
  const b = $('banner');
  b.hidden = false;
  b.querySelector('.banner-title').textContent = 'Erreur';
  $('banner-body').textContent = String(err && err.message ? err.message : err);
});
