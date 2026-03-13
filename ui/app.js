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
const dsMount      = document.getElementById('deathstar-mount');
const impactLayer  = document.getElementById('impact-layer');
const explosionEl  = document.getElementById('explosion');
const stationStatus = document.getElementById('station-status');
const logList      = document.getElementById('log-list');
const connStatus   = document.getElementById('conn-status');
const eventCounter = document.getElementById('event-counter');

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
// Death Star — Three.js 3-D sphere
// ---------------------------------------------------------------------------

/**
 * buildSurfaceCanvas — paints the Death Star surface as a 1024×512
 * equirectangular texture map.  Three.js wraps it onto the sphere automatically.
 *
 * Coordinate helper: (lon°, lat°) → pixel (u, v)
 *   u = (lon + 180) / 360 * W      left=-180°, right=+180°
 *   v = (90 - lat)  / 180 * H      top=+90°N,  bottom=-90°S
 */
function buildSurfaceCanvas() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  function uv(lonDeg, latDeg) {
    return [((lonDeg + 180) / 360) * W, ((90 - latDeg) / 180) * H];
  }

  // ── Base body ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#5a5a6a';
  ctx.fillRect(0, 0, W, H);

  // ── Subtle polar darkening ─────────────────────────────────────────────
  const polarGrad = ctx.createLinearGradient(0, 0, 0, H);
  polarGrad.addColorStop(0,   'rgba(0,0,0,0.28)');
  polarGrad.addColorStop(0.2, 'rgba(0,0,0,0)');
  polarGrad.addColorStop(0.8, 'rgba(0,0,0,0)');
  polarGrad.addColorStop(1,   'rgba(0,0,0,0.28)');
  ctx.fillStyle = polarGrad;
  ctx.fillRect(0, 0, W, H);

  // ── Very subtle north-south surface banding ────────────────────────────
  // Adds faint tonal variation to break up the monotone grey
  for (const [latTop, latBot, alpha] of [
    [60, 30, 0.04], [-30, -60, 0.04],
  ]) {
    const [, vTop] = uv(0, latTop);
    const [, vBot] = uv(0, latBot);
    const g = ctx.createLinearGradient(0, vTop, 0, vBot);
    g.addColorStop(0,   `rgba(136,136,160,0)`);
    g.addColorStop(0.5, `rgba(136,136,160,${alpha})`);
    g.addColorStop(1,   `rgba(136,136,160,0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, vTop, W, vBot - vTop);
  }

  // ── Equator trench ─────────────────────────────────────────────────────
  const [, vT] = uv(0,  4.5);
  const [, vB] = uv(0, -4.5);
  ctx.fillStyle = '#2a2a38';
  ctx.fillRect(0, vT, W, vB - vT);
  // highlight above
  ctx.strokeStyle = 'rgba(136,136,160,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, vT - 2); ctx.lineTo(W, vT - 2); ctx.stroke();
  // shadow below
  ctx.strokeStyle = 'rgba(8,8,18,0.65)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, vB + 2); ctx.lineTo(W, vB + 2); ctx.stroke();

  // ── Superlaser dish ────────────────────────────────────────────────────
  // lon = -0.68 rad ≈ -38.95°,  lat = 0.55 rad ≈ 31.51°
  const [du, dv] = uv(-39, 31.5);
  const DR = 46;   // dish outer radius in texture pixels

  function arc(r, fill, stroke, lw, alpha) {
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(du, dv, r, 0, Math.PI * 2);
    if (fill)   { ctx.fillStyle   = fill;   ctx.fill();   }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw ?? 1.5; ctx.stroke(); }
    ctx.restore();
  }

  arc(DR + 5,  '#16161e', null, null, 0.75);  // recessed drop-shadow
  arc(DR,      '#2e2e3a');                      // outer rim
  arc(DR - 5,  '#3a3a4a');                      // dish body (narrow lip)
  arc(DR - 10, '#0a0a10');                      // deep dark bowl (wide concavity)
  arc(DR - 14, '#111118');                      // bowl floor
  arc(DR - 18, '#1a1a24');                      // inner bowl highlight
  arc(DR - 13, null, '#44445a', 1.5, 0.6);     // focusing ring outer
  arc(DR - 22, null, '#44445a', 1.5, 0.6);     // focusing ring inner
  arc(DR - 28, null, '#33334a', 1.0, 0.5);     // focusing ring innermost
  // Emitter — orange hollow ring with glow
  ctx.save();
  ctx.shadowColor = '#ff8844';
  ctx.shadowBlur  = 14;
  arc(DR - 34, null, '#ff9955', 3.5);
  ctx.restore();
  // Emitter core — faint orange dot
  ctx.save();
  ctx.globalAlpha = 0.6;
  arc(DR - 38, '#ff6622');
  ctx.restore();

  // ── Meridional panel lines — run pole-to-pole every 45°, very subtle ──
  // Breaks up the back hemisphere so it looks structured, not empty
  ctx.strokeStyle = 'rgba(30,30,50,0.55)';
  ctx.lineWidth = 2;
  for (let lon = -180; lon < 180; lon += 45) {
    const [pu] = uv(lon, 0);
    ctx.beginPath();
    ctx.moveTo(pu, 0);
    ctx.lineTo(pu, H);
    ctx.stroke();
  }
  // Highlight edge on alternating ones
  ctx.strokeStyle = 'rgba(100,100,120,0.18)';
  ctx.lineWidth = 1;
  for (let lon = -157.5; lon < 180; lon += 90) {
    const [pu] = uv(lon, 0);
    ctx.beginPath();
    ctx.moveTo(pu + 2, 0);
    ctx.lineTo(pu + 2, H);
    ctx.stroke();
  }

  // ── Secondary latitude trenches ─────────────────────────────────────────
  for (const latD of [42, -42]) {
    const [, vL] = uv(0, latD);
    ctx.fillStyle = 'rgba(30,30,46,0.5)';
    ctx.fillRect(0, vL - 3, W, 6);
    ctx.strokeStyle = 'rgba(100,100,120,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, vL - 4); ctx.lineTo(W, vL - 4); ctx.stroke();
  }

  // ── Craters — spread across ALL longitudes for a full-sphere look ────────
  for (const [lonD, latD, r] of [
    // Front hemisphere (will be visible immediately)
    [ -39,   55,   9],
    [  20,  -38,   8],
    [  75,   18,   6],
    [ -80,  -22,  10],
    [  50,  -52,   7],
    [  10,   48,   5],
    // Back hemisphere (visible as DS rotates)
    [ 110,   30,   9],
    [ 145,  -18,  11],
    [-130,   42,   7],
    [-160,  -35,   8],
    [ 170,   10,   6],
    [-110,   -8,   5],
    [ 130,  -50,   9],
    [-150,   55,   7],
  ]) {
    const [cu, cv] = uv(lonD, latD);
    // Raised rim gradient
    const rim = ctx.createRadialGradient(cu, cv, r * 0.65, cu, cv, r);
    rim.addColorStop(0, '#30303c');
    rim.addColorStop(1, '#484858');
    ctx.fillStyle = rim;
    ctx.beginPath(); ctx.arc(cu, cv, r, 0, Math.PI * 2); ctx.fill();
    // Dark inner bowl
    ctx.fillStyle = '#1c1c26';
    ctx.beginPath(); ctx.arc(cu, cv, r * 0.55, 0, Math.PI * 2); ctx.fill();
  }

  // ── Turret clusters — small rectangular protrusions, back hemisphere ─────
  ctx.fillStyle = '#484858';
  for (const [lonD, latD] of [
    [ 120,   15], [ 125,   18], [ 122,   12],   // cluster 1
    [-140,  -28], [-136,  -25], [-143,  -30],   // cluster 2
    [ 160,   48], [ 164,   44],                  // cluster 3
  ]) {
    const [tu, tv] = uv(lonD, latD);
    ctx.fillRect(tu - 2, tv - 2, 4, 4);
    ctx.fillStyle = '#5a5a6e';
    ctx.fillRect(tu - 1, tv - 3, 2, 2);
    ctx.fillStyle = '#484858';
  }

  return c;
}

// ── Scene setup ─────────────────────────────────────────────────────────────

const DS_SIZE = 240;   // canvas px — matches CSS width/height

const dsRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
dsRenderer.setSize(DS_SIZE, DS_SIZE);
dsRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
dsRenderer.setClearColor(0x000000, 0);
dsMount.appendChild(dsRenderer.domElement);

const dsScene  = new THREE.Scene();
const dsCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
dsCamera.position.set(0, 0, 3.8);

const dsGeo = new THREE.SphereGeometry(1, 64, 32);
const dsTex = new THREE.CanvasTexture(buildSurfaceCanvas());

const dsMat = new THREE.MeshStandardMaterial({
  map:               dsTex,
  roughness:         0.85,
  metalness:         0.0,
  emissive:          new THREE.Color(0x000000),
  emissiveIntensity: 0,
});
const dsSphere = new THREE.Mesh(dsGeo, dsMat);
dsScene.add(dsSphere);

// Ambient — prevents total black on the shadow side
const dsAmbient = new THREE.AmbientLight(0x8888aa, 0.4);
dsScene.add(dsAmbient);

// Key light — upper-left of camera; creates natural terminator on right
const dsDirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dsDirLight.position.set(-2, 1.5, 3);
dsScene.add(dsDirLight);

const DS_ROT_SPEED = 0.007;   // radians/frame @ ~60 fps ≈ 8 s per revolution

function dsAnimate() {
  requestAnimationFrame(dsAnimate);
  if (!exploded) dsSphere.rotation.y += DS_ROT_SPEED;
  dsRenderer.render(dsScene, dsCamera);
}

requestAnimationFrame(dsAnimate);

// ---------------------------------------------------------------------------
// Death Star visual transitions
// ---------------------------------------------------------------------------

function explode() {
  if (exploded) return;
  exploded = true;

  // Flash the mount white, then animate sphere breaking apart
  dsMount.style.transition = 'filter 0.1s';
  dsMount.style.filter = 'brightness(4) saturate(0)';
  setTimeout(() => { dsMount.style.filter = 'none'; }, 120);

  // Animate sphere: scale up + fade away over 1.4s using render loop
  let t = 0;
  const breakApart = () => {
    t += 0.012;
    if (t <= 1) {
      dsSphere.scale.setScalar(1 + t * 0.6);
      dsMat.opacity = 1 - t;
      dsMat.transparent = true;
      // Shift to orange-red as it breaks
      dsMat.emissive.setHex(0xff2200);
      dsMat.emissiveIntensity = t * 1.5;
      requestAnimationFrame(breakApart);
    } else {
      dsSphere.visible = false;
    }
  };
  requestAnimationFrame(breakApart);

  // Shake the whole station wrapper
  dsMount.animate([
    { transform: 'translate(0,0)' },
    { transform: 'translate(-8px,-4px)' },
    { transform: 'translate(8px,5px)' },
    { transform: 'translate(-6px,3px)' },
    { transform: 'translate(5px,-6px)' },
    { transform: 'translate(0,0)' },
  ], { duration: 400, easing: 'ease-out' });

  // Show explosion overlay (CSS handles fireball + rings + debris)
  explosionEl.classList.remove('hidden');
  stationStatus.textContent = 'DESTROYED';
  stationStatus.className   = 'station-status status-destroyed';
}

/**
 * addImpact — brief radial flash at a random position on the station body.
 * The Three.js canvas is 240×240 and centred inside the 260×260 wrapper,
 * so the sphere centre sits at (130, 130) within the wrapper coords.
 */
function addImpact(type) {
  if (exploded) return;
  const angle  = Math.random() * 2 * Math.PI;
  const radius = Math.random() * 90;
  // Sphere centre within .station-wrapper: canvas is 240px centred in 260px → offset = 10px
  const cx = 130 + radius * Math.cos(angle);
  const cy = 130 + radius * Math.sin(angle);
  const div = document.createElement('div');
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
