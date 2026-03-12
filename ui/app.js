/**
 * app.js — Death Star Observability Dashboard
 *
 * Connects to /api/events (Nginx proxied → Go SSE hub at /v1/events) and:
 *   1. Displays rolling event-rate charts broken down by source IP and endpoint.
 *   2. Shows a live traffic log (IP, method, endpoint, status, time).
 *   3. Transitions the Death Star visual to "exploded" when PUT /v1/exhaust-port succeeds.
 *
 * The dashboard shows only what the Death Star application can see — raw source IPs
 * and HTTP endpoints.  Identity (Cilium labels like org=empire) is not visible here;
 * that's the job of Hubble.  This deliberate blindness is the teaching moment.
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SSE_URL        = '/api/events';
const MAX_LOG        = 80;          // max rows in traffic log
const WINDOW_SECS    = 180;         // rolling chart window (3 minutes)
const BUCKET_SECS    = 5;           // one bar = 5 s
const BUCKETS        = WINDOW_SECS / BUCKET_SECS;   // 36 buckets
const MAX_SERIES     = 8;           // max distinct IPs / endpoints on a chart

// Colour palette for chart series (cycles if more than palette length)
const PALETTE = [
  '#44aaff', '#00ff88', '#ffcc00', '#ff8800',
  '#ff2244', '#cc44ff', '#00dddd', '#ff66aa',
];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const deathstarSvg  = document.getElementById('deathstar');
const impactLayer   = document.getElementById('impact-layer');
const explosionEl   = document.getElementById('explosion');
const stationStatus = document.getElementById('station-status');
const logList       = document.getElementById('log-list');
const connStatus    = document.getElementById('conn-status');
const eventCounter  = document.getElementById('event-counter');

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
let exploded    = false;
let totalEvents = 0;
let eventSource = null;

// ---------------------------------------------------------------------------
// Rolling time-series store
// ---------------------------------------------------------------------------
/**
 * RollingStore tracks per-key event counts in fixed-width time buckets.
 * Each bucket covers BUCKET_SECS seconds.  The store always holds exactly
 * BUCKETS buckets, dropping the oldest as time advances.
 */
class RollingStore {
  constructor() {
    this._keys     = [];          // ordered list of seen keys
    this._buckets  = [];          // array of {ts, counts:{key:n}} (newest last)
    this._init();
  }

  _nowBucket() {
    return Math.floor(Date.now() / 1000 / BUCKET_SECS) * BUCKET_SECS;
  }

  _init() {
    const now = this._nowBucket();
    for (let i = BUCKETS - 1; i >= 0; i--) {
      this._buckets.push({ ts: now - i * BUCKET_SECS, counts: {} });
    }
  }

  /** Record one event for a given key at the current time. */
  record(key) {
    const ts = this._nowBucket();

    // Advance buckets if time has moved forward
    const last = this._buckets[this._buckets.length - 1];
    if (ts > last.ts) {
      const steps = Math.min(Math.round((ts - last.ts) / BUCKET_SECS), BUCKETS);
      for (let i = 0; i < steps; i++) {
        this._buckets.push({ ts: last.ts + (i + 1) * BUCKET_SECS, counts: {} });
      }
      // Drop oldest to keep window size
      this._buckets = this._buckets.slice(-BUCKETS);
    }

    // Increment count in the current bucket
    const cur = this._buckets[this._buckets.length - 1];
    cur.counts[key] = (cur.counts[key] || 0) + 1;

    // Register key if new
    if (!this._keys.includes(key)) {
      this._keys.push(key);
      // Keep only top MAX_SERIES by recent activity; evict the least-active if needed
      if (this._keys.length > MAX_SERIES) {
        this._evictLeastActive();
      }
    }
  }

  _evictLeastActive() {
    // Score each key by total events in the current window
    const scores = {};
    for (const b of this._buckets) {
      for (const [k, n] of Object.entries(b.counts)) {
        scores[k] = (scores[k] || 0) + n;
      }
    }
    let minKey = this._keys[0], minScore = Infinity;
    for (const k of this._keys) {
      if ((scores[k] || 0) < minScore) { minScore = scores[k] || 0; minKey = k; }
    }
    this._keys = this._keys.filter(k => k !== minKey);
    // Remove from buckets too
    for (const b of this._buckets) { delete b.counts[minKey]; }
  }

  /**
   * snapshot() → { labels: string[], series: [{key, data:[]}] }
   * labels: HH:MM:SS for each bucket
   * data: counts array parallel to labels
   */
  snapshot() {
    // Ensure buckets are up-to-date (no events may have arrived recently)
    this.record.__no_op || this._advance();

    const labels = this._buckets.map(b => {
      const d = new Date(b.ts * 1000);
      return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}:${fmt2(d.getSeconds())}`;
    });

    const series = this._keys.map(key => ({
      key,
      data: this._buckets.map(b => b.counts[key] || 0),
    }));

    return { labels, series };
  }

  _advance() {
    const ts = this._nowBucket();
    const last = this._buckets[this._buckets.length - 1];
    if (ts > last.ts) {
      const steps = Math.min(Math.round((ts - last.ts) / BUCKET_SECS), BUCKETS);
      for (let i = 0; i < steps; i++) {
        this._buckets.push({ ts: last.ts + (i + 1) * BUCKET_SECS, counts: {} });
      }
      this._buckets = this._buckets.slice(-BUCKETS);
    }
  }
}

const sourceStore   = new RollingStore();
const endpointStore = new RollingStore();

// ---------------------------------------------------------------------------
// Chart.js setup
// ---------------------------------------------------------------------------
Chart.defaults.color           = '#9090a8';
Chart.defaults.borderColor     = '#2a2a44';
Chart.defaults.font.family     = "'Courier New', Courier, monospace";
Chart.defaults.font.size       = 11;

function makeChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            padding: 8,
            font: { size: 10 },
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.label ?? '',
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 7,
            font: { size: 9 },
          },
          grid: { color: '#1a1a2c' },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { precision: 0, maxTicksLimit: 5 },
          grid: { color: '#1a1a2c' },
        },
      },
    },
  });
}

const sourceChart   = makeChart('chart-source');
const endpointChart = makeChart('chart-endpoint');

function refreshChart(chart, store) {
  const { labels, series } = store.snapshot();

  chart.data.labels = labels;

  // Add/update datasets
  series.forEach((s, i) => {
    const colour = PALETTE[i % PALETTE.length];
    if (chart.data.datasets[i]) {
      chart.data.datasets[i].label = s.key;
      chart.data.datasets[i].data  = s.data;
    } else {
      chart.data.datasets.push({
        label:           s.key,
        data:            s.data,
        backgroundColor: colour + 'cc',
        borderColor:     colour,
        borderWidth:     1,
        borderRadius:    2,
      });
    }
  });

  // Remove excess datasets (key was evicted)
  if (chart.data.datasets.length > series.length) {
    chart.data.datasets.splice(series.length);
  }

  chart.update('none');
}

// Refresh charts every BUCKET_SECS seconds so the window scrolls even with no events
setInterval(() => {
  refreshChart(sourceChart,   sourceStore);
  refreshChart(endpointChart, endpointStore);
}, BUCKET_SECS * 1000);

// ---------------------------------------------------------------------------
// Death Star visual
// ---------------------------------------------------------------------------

function explode() {
  if (exploded) return;
  exploded = true;
  deathstarSvg.classList.add('ds-exploded');
  explosionEl.classList.remove('hidden');
  stationStatus.textContent  = 'DESTROYED';
  stationStatus.className    = 'station-status status-destroyed';
}

/**
 * addImpact — brief radial flash at a random position on the station body.
 * colour: 'hit' (orange) for allowed requests, 'block' (blue) for denied.
 */
function addImpact(type) {
  if (exploded) return;
  const angle  = Math.random() * 2 * Math.PI;
  const radius = Math.random() * 90;
  const cx     = 140 + radius * Math.cos(angle);
  const cy     = 140 + radius * Math.sin(angle);
  const div    = document.createElement('div');
  div.className = `impact impact-${type}`;
  div.style.left = `${cx}px`;
  div.style.top  = `${cy}px`;
  impactLayer.appendChild(div);
  div.addEventListener('animationend', () => div.remove(), { once: true });
}

// ---------------------------------------------------------------------------
// Traffic log
// ---------------------------------------------------------------------------

function fmt2(n) { return String(n).padStart(2, '0'); }

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}:${fmt2(d.getSeconds())}`;
  } catch (_) {
    const d = new Date();
    return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}:${fmt2(d.getSeconds())}`;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addLogEntry(ev) {
  const li  = document.createElement('li');
  const time = fmtTime(ev.timestamp);

  if (ev.type === 'connected') {
    li.className = 'log-entry log-connected';
    li.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-info">SSE connected</span>`;
  } else {
    const ip     = escHtml(ev.source   || '?');
    const method = escHtml((ev.method  || '').trim());
    const path   = escHtml(ev.endpoint || '');
    const status = ev.status || '';
    const tick   = ev.allowed ? '✓' : '✗';
    const cls    = ev.type === 'exhaust-port' ? 'log-exhaust'
                 : ev.allowed                 ? 'log-allowed'
                 :                              'log-denied';
    li.className = `log-entry ${cls}`;
    li.innerHTML =
      `<span class="log-time">[${time}]</span>` +
      `<span class="log-source">${ip}</span>` +
      `<span class="log-method">${method}</span> ` +
      `<span class="log-path">${path}</span>` +
      `<span class="log-arrow"> → </span>` +
      `<span class="log-status">${status} ${tick}</span>`;
  }

  logList.insertBefore(li, logList.firstChild);
  while (logList.children.length > MAX_LOG) {
    logList.removeChild(logList.lastChild);
  }

  totalEvents++;
  eventCounter.textContent = `EVENTS: ${totalEvents}`;
}

function clearLog() {
  logList.innerHTML = '';
}

window.clearLog = clearLog;

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

function parseEvent(e) {
  try { return JSON.parse(e.data); } catch (_) { return null; }
}

function connect() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(SSE_URL);

  // request-landing: normal traffic
  eventSource.addEventListener('request-landing', (e) => {
    const ev = parseEvent(e);
    if (!ev) return;
    sourceStore.record(ev.source || '?');
    endpointStore.record(ev.endpoint || '?');
    refreshChart(sourceChart,   sourceStore);
    refreshChart(endpointChart, endpointStore);
    addLogEntry(ev);
    addImpact(ev.allowed ? 'hit' : 'block');
  });

  // exhaust-port: critical vulnerability
  eventSource.addEventListener('exhaust-port', (e) => {
    const ev = parseEvent(e);
    if (!ev) return;
    sourceStore.record(ev.source || '?');
    endpointStore.record(ev.endpoint || '?');
    refreshChart(sourceChart,   sourceStore);
    refreshChart(endpointChart, endpointStore);
    addLogEntry(ev);
    addImpact('hit');
    // Explode after a brief pause so the log entry is visible first
    setTimeout(explode, 600);
  });

  // other: healthz, root, etc.
  eventSource.addEventListener('other', (e) => {
    const ev = parseEvent(e);
    if (!ev) return;
    sourceStore.record(ev.source || '?');
    endpointStore.record(ev.endpoint || '?');
    refreshChart(sourceChart,   sourceStore);
    refreshChart(endpointChart, endpointStore);
    addLogEntry(ev);
  });

  // connected: SSE hub announces new client
  eventSource.addEventListener('connected', (e) => {
    const ev = parseEvent(e);
    if (ev) addLogEntry(ev);
    setConnStatus('connected');
  });

  eventSource.onopen  = () => setConnStatus('connected');
  eventSource.onerror = () => {
    setConnStatus('disconnected');
    setTimeout(() => {
      if (eventSource && eventSource.readyState !== EventSource.OPEN) {
        setConnStatus('connecting');
      }
    }, 2000);
  };
}

function setConnStatus(state) {
  switch (state) {
    case 'connected':
      connStatus.textContent = '⬤ CONNECTED';
      connStatus.className   = 'conn-connected';
      break;
    case 'disconnected':
      connStatus.textContent = '⬤ DISCONNECTED';
      connStatus.className   = 'conn-disconnected';
      break;
    default:
      connStatus.textContent = '⬤ RECONNECTING…';
      connStatus.className   = 'conn-connecting';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
connect();
