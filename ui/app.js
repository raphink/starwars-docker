/**
 * app.js — Death Star SSE frontend
 *
 * Connects to /api/events (proxied by Nginx to the Go SSE hub at /v1/events)
 * and updates the visual Death Star display in real-time.
 *
 * Visual states:
 *   unprotected  — no shields, red badge, red glow on impacts
 *   l3l4         — blue shield ring visible, traffic may be filtered at L3/L4
 *   l7           — green shield ring + inner l7 ring, L7 policy enforced
 *   exploded     — exhaust port hit, destruction animation
 *
 * Manual state buttons allow the demo presenter to sync visuals with kubectl
 * policy applies (Cilium drops happen in kernel, so no event fires for blocks —
 * the presenter advances the visual state themselves).
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STATES = Object.freeze({
  UNPROTECTED: 'unprotected',
  L3L4:        'l3l4',
  L7:          'l7',
  EXPLODED:    'exploded',
});

const BADGE_LABELS = {
  [STATES.UNPROTECTED]: 'UNPROTECTED',
  [STATES.L3L4]:        'L3/L4 SHIELD',
  [STATES.L7]:          'L7 LOCKED',
  [STATES.EXPLODED]:    'DESTROYED',
};

const MAX_LOG_ENTRIES = 60;
const SSE_URL         = '/api/events';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const badge        = document.getElementById('status-badge');
const shieldRing   = document.getElementById('shield-ring');
const l7Ring       = document.getElementById('l7-ring');
const deathstarSvg = document.getElementById('deathstar');
const impactLayer  = document.getElementById('impact-layer');
const explosionEl  = document.getElementById('explosion');
const logList      = document.getElementById('log-list');
const connStatus   = document.getElementById('conn-status');
const eventCounter = document.getElementById('event-counter');

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
let currentState = STATES.UNPROTECTED;
let totalEvents  = 0;
let eventSource  = null;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function applyState(newState) {
  currentState = newState;

  // Badge
  badge.textContent = BADGE_LABELS[newState];
  badge.className = `badge state-${newState}`;

  // Shield rings
  switch (newState) {
    case STATES.UNPROTECTED:
      shieldRing.classList.add('hidden');
      shieldRing.classList.remove('l7-active');
      l7Ring.classList.add('hidden');
      deathstarSvg.classList.remove('ds-exploded');
      explosionEl.classList.add('hidden');
      break;

    case STATES.L3L4:
      shieldRing.classList.remove('hidden');
      shieldRing.classList.remove('l7-active');
      l7Ring.classList.add('hidden');
      deathstarSvg.classList.remove('ds-exploded');
      break;

    case STATES.L7:
      shieldRing.classList.remove('hidden');
      shieldRing.classList.add('l7-active');
      l7Ring.classList.remove('hidden');
      deathstarSvg.classList.remove('ds-exploded');
      break;

    case STATES.EXPLODED:
      shieldRing.classList.add('hidden');
      shieldRing.classList.remove('l7-active');
      l7Ring.classList.add('hidden');
      deathstarSvg.classList.add('ds-exploded');
      explosionEl.classList.remove('hidden');
      break;
  }
}

// ---------------------------------------------------------------------------
// Impact flashes
// ---------------------------------------------------------------------------

/**
 * addImpact — spawn a brief flash at a random position on the Death Star body.
 * @param {boolean} allowed  — true = orange hit, false = blue block
 */
function addImpact(allowed) {
  if (currentState === STATES.EXPLODED) return;

  // Random position within a circle of radius ~100px centred in the wrapper
  const angle  = Math.random() * 2 * Math.PI;
  const radius = Math.random() * 90;         // px from centre
  const cx     = 140 + radius * Math.cos(angle); // wrapper is 280px wide
  const cy     = 140 + radius * Math.sin(angle);

  const div = document.createElement('div');
  div.className = `impact ${allowed ? 'impact-hit' : 'impact-block'}`;
  div.style.left = `${cx}px`;
  div.style.top  = `${cy}px`;
  impactLayer.appendChild(div);

  // Remove after animation ends (~800ms)
  div.addEventListener('animationend', () => div.remove(), { once: true });
}

// ---------------------------------------------------------------------------
// Traffic log
// ---------------------------------------------------------------------------

/**
 * fmt2 — zero-pad a number to 2 digits.
 */
function fmt2(n) { return String(n).padStart(2, '0'); }

/**
 * fmtTime — extract HH:MM:SS from an RFC3339Nano timestamp string.
 * Falls back to current local time if parsing fails.
 */
function fmtTime(ts) {
  try {
    const d = new Date(ts);
    return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}:${fmt2(d.getSeconds())}`;
  } catch (_) {
    const d = new Date();
    return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}:${fmt2(d.getSeconds())}`;
  }
}

/**
 * addLogEntry — prepend a formatted event row to the traffic log.
 */
function addLogEntry(ev) {
  const li = document.createElement('li');

  // Determine CSS class
  let cls = 'log-other';
  if (ev.type === 'connected') {
    cls = 'log-connected';
  } else if (ev.type === 'exhaust-port') {
    cls = 'log-exhaust';
  } else if (ev.allowed) {
    cls = 'log-allowed';
  } else {
    cls = 'log-denied';
  }

  li.className = `log-entry ${cls}`;

  const time     = fmtTime(ev.timestamp);
  const identity = ev.identity || ev.source || '?';
  const method   = (ev.method  || '').padEnd(4, ' ');
  const path     = ev.endpoint || '';
  const status   = ev.status   || '';
  const tick     = ev.allowed ? '✓' : '✗';

  if (ev.type === 'connected') {
    li.innerHTML = `<span class="log-time">[${time}]</span> SSE client connected`;
  } else {
    li.innerHTML =
      `<span class="log-time">[${time}]</span>` +
      `<span class="log-identity">${escHtml(identity)}</span>` +
      `<span class="log-method">${escHtml(method.trim())}</span> ` +
      `<span class="log-path">${escHtml(path)}</span>` +
      `<span class="log-arrow"> → </span>` +
      `<span class="log-status">${status} ${tick}</span>`;
  }

  // Prepend (newest on top)
  logList.insertBefore(li, logList.firstChild);

  // Enforce max entries
  while (logList.children.length > MAX_LOG_ENTRIES) {
    logList.removeChild(logList.lastChild);
  }

  // Update counter
  totalEvents++;
  eventCounter.textContent = `EVENTS: ${totalEvents}`;
}

function clearLog() {
  logList.innerHTML = '';
}

// Expose to onclick handler in HTML
window.clearLog = clearLog;

/**
 * escHtml — minimal HTML escaping for untrusted strings.
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

function connect() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(SSE_URL);

  // ----- shield (presenter sets policy level via PUT /v1/shield/{level}) -----
  eventSource.addEventListener('shield', (e) => {
    const ev = parseEvent(e);
    if (!ev) return;
    // Map API level names → UI state names ("none" → "unprotected")
    const stateMap = { none: STATES.UNPROTECTED, l3l4: STATES.L3L4, l7: STATES.L7 };
    const newState = stateMap[ev.level];
    if (!newState) return;
    // "none" after explosion = reset; otherwise guard against transitions out of exploded
    if (currentState === STATES.EXPLODED && newState !== STATES.UNPROTECTED) return;
    applyState(newState);
  });

  // ----- request-landing -----
  eventSource.addEventListener('request-landing', (e) => {
    const ev = parseEvent(e);
    if (!ev) return;
    addLogEntry(ev);
    addImpact(ev.allowed);
  });

  // ----- exhaust-port -----
  eventSource.addEventListener('exhaust-port', (e) => {
    const ev = parseEvent(e);
    if (!ev) return;
    addLogEntry(ev);
    if (currentState !== STATES.EXPLODED) {
      addImpact(false);
      // Trigger explosion after a brief visual pause
      setTimeout(() => applyState(STATES.EXPLODED), 600);
    }
  });

  // ----- connected (hub sends this when a new SSE client joins) -----
  eventSource.addEventListener('connected', (e) => {
    const ev = parseEvent(e);
    if (ev) addLogEntry(ev);
    setConnStatus('connected');
  });

  // ----- other (healthz, root, etc.) -----
  eventSource.addEventListener('other', (e) => {
    const ev = parseEvent(e);
    if (!ev) return;
    addLogEntry(ev);
  });

  // ----- open -----
  eventSource.onopen = () => {
    setConnStatus('connected');
  };

  // ----- error -----
  eventSource.onerror = () => {
    setConnStatus('disconnected');
    // The browser will automatically attempt to reconnect.
    // Update the UI to show "reconnecting" after a short delay.
    setTimeout(() => {
      if (eventSource && eventSource.readyState !== EventSource.OPEN) {
        setConnStatus('connecting');
      }
    }, 2000);
  };
}

function parseEvent(e) {
  try {
    return JSON.parse(e.data);
  } catch (_) {
    return null;
  }
}

function setConnStatus(state) {
  switch (state) {
    case 'connected':
      connStatus.textContent  = '⬤ CONNECTED';
      connStatus.className    = 'conn-connected';
      break;
    case 'disconnected':
      connStatus.textContent  = '⬤ DISCONNECTED';
      connStatus.className    = 'conn-disconnected';
      break;
    case 'connecting':
    default:
      connStatus.textContent  = '⬤ RECONNECTING…';
      connStatus.className    = 'conn-connecting';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
connect();
