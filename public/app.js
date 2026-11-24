// The page: connects to the local monitor's event stream and draws the status, charts and tables.

import { fmtMs, fmtDur, fmtTime, fmtBytes } from './lib/format.js';
import { heroAt, statusSince, outages as findOutages, sliceFrom, uptime, fmtUptime, median, percentile, jitter } from './lib/status.js';

const LABELS = { up: 'Online', warn: 'Degraded', down: 'Offline', idle: 'Monitor not running' };
const ICONS = { up: '✓', warn: '!', down: '✕', idle: '…' };

let config = { tickMs: 3000, gapMs: 11000, pingHost: '1.1.1.1', httpUrl: '', httpEveryMs: 30000, machineMs: 10000, machineGapMs: 30000, diskPath: '/' };
let gateway = null;
let iface = null; // the interface the router is reached on
let samples = [];
let machine = []; // machine health samples, same 24 hours
let procs = null; // latest top processes, live only
let events = []; // network changes, wake from sleep, speed tests: same 24 hours
let vpn = null; // the VPN's tunnel interface, when one carries traffic
let hotspot = false; // the router looks like a phone sharing its connection
let speedRunning = false;
let connected = false;
let triedOnce = false; // true after the first connect attempt succeeds or fails
let rangeMs = 3600000;
try {
  const saved = Number(localStorage.getItem('netmon-range'));
  if (saved > 0) rangeMs = saved;
} catch { /* storage unavailable */ }

const $ = (id) => document.getElementById(id);

function fmtRange(ms) {
  return { 900000: '15 min', 3600000: '1 hour', 21600000: '6 hours', 86400000: '24 hours' }[ms] || fmtDur(ms);
}

// ---------- derived data ----------

function currentStatus() {
  const last = samples[samples.length - 1];
  if (!connected || !last || Date.now() - last.t > config.gapMs) return 'idle';
  return last.s;
}

// The monitor is running and its latest sample is current.
const running = () => currentStatus() !== 'idle';

// The latest machine sample, or null when they've stopped arriving.
function currentMachine() {
  const last = machine[machine.length - 1];
  if (!connected || !last || Date.now() - last.t > config.machineGapMs) return null;
  return last;
}

function heroStatus() {
  const net = currentStatus();
  if (net === 'idle') return net;
  return heroAt(net, currentMachine()?.s);
}

// When the hero's status started, or null when the monitor isn't running.
function since() {
  const status = heroStatus();
  return status === 'idle' ? null : statusSince(samples, machine, config, status);
}

const outages = () => findOutages(samples, Date.now(), config, running());

// ---------- rendering: hero and layers ----------

// ok: true (green), false (red), 'w' (amber), or null (grey, unknown).
function setLayer(id, ok, value, sub) {
  const el = $(id);
  el.dataset.ok = ok == null ? '' : ok === 'w' ? 'w' : ok ? '1' : '0';
  el.querySelector('.layer-value').textContent = value;
  el.querySelector('.layer-sub').textContent = sub;
}

function renderMachineLayers() {
  const m = currentMachine();
  if (!m) {
    for (const id of ['layer-wifi', 'layer-cpu', 'layer-mem', 'layer-disk', 'layer-swap']) setLayer(id, null, '—', '');
    $('machine-note').textContent = '';
    return;
  }
  // The server judges CPU, memory and swap on an average over its judging window (a minute, or
  // four samples when MACHINE_MS is longer) and lists what's over its limit in w.
  const ok = (key, value) => (value == null ? null : m.w?.includes(key) ? 'w' : true);
  setLayer('layer-cpu', ok('cpu', m.cpu), m.cpu == null ? '—' : `${Math.round(m.cpu)}%`, `load ${m.load.toFixed(2)}`);
  setLayer('layer-mem', ok('mem', m.mem), m.mem == null ? '—' : `${Math.round(m.mem)}% used`,
    m.mp === undefined ? '' : `pressure ${{ 1: 'normal', 2: 'warning', 4: 'critical' }[m.mp] ?? m.mp}`);
  renderWifi(m);
  setLayer('layer-disk', ok('disk', m.dgb), m.dgb == null ? '—' : `${fmtBytes(m.dgb * 1e9)} free`,
    m.disk == null ? '' : `${Math.round(m.disk)}% of ${config.diskPath}`);
  setLayer('layer-swap', ok('swap', m.swap), m.swap == null ? '—' : `${fmtBytes(m.swap * 1048576)} used`,
    m.so == null ? '' : m.so > 0 ? `writing ${fmtBytes(m.so * 1024, true)}` : 'not swapping now');

  const notes = [];
  if (m.bat !== undefined) notes.push(`Battery ${m.bat}%${m.ac ? ', on power' : ''}`);
  if (m.hot) notes.push('CPU slowed down for heat');
  $('machine-note').textContent = notes.join(' · ');
}

// Wi-Fi readings come with the machine samples, and only while the router is reached over Wi-Fi.
function renderWifi(m) {
  if (m.rssi === undefined) {
    setLayer('layer-wifi', null, iface ? 'Not in use' : '—', iface ? `connected through ${iface}` : '');
    return;
  }
  const words = m.rssi >= -60 ? 'strong' : m.rssi >= -67 ? 'good' : m.rssi >= -75 ? 'fair' : 'weak';
  const details = [words];
  if (m.rate) details.push(`${m.rate} Mbps`);
  if (m.ch) details.push(`ch ${m.ch}`);
  setLayer('layer-wifi', m.w?.includes('wifi') ? 'w' : true, `${m.rssi} dBm`, details.join(' · '));
}

function renderHero() {
  const status = heroStatus();
  const last = samples[samples.length - 1];
  const m = currentMachine();
  renderMachineLayers();
  $('hero').dataset.status = status;
  $('orb').textContent = ICONS[status];
  $('label').textContent = LABELS[status];

  if (status === 'idle' && !triedOnce) {
    $('label').textContent = 'Connecting…';
    $('reason').textContent = 'Waiting for the local monitor';
    $('since').textContent = '';
  } else if (status === 'idle') {
    $('reason').textContent = connected
      ? 'No checks are arriving. The monitor may have stopped (start it with: npx is-it-me), or the machine just woke from sleep.'
      : 'Can’t reach the monitor on localhost. Start it with: npx is-it-me';
    $('since').textContent = last ? `Last check ${fmtTime(last.t)}` : '';
  } else {
    const reasons = [];
    if (last.s !== 'up' && last.r) reasons.push(last.r);
    if (m?.s === 'warn' && m.r) reasons.push(m.r);
    $('reason').textContent = status === 'up' ? 'All checks passing' : reasons.join(' · ');
    const from = since();
    $('since').textContent = from ? `for ${fmtDur(Date.now() - from)}, since ${fmtTime(from, false)}` : '';
  }

  document.title = `${LABELS[status]} · Is it me?`;
  setFavicon(status);

  if (!last || status === 'idle') {
    for (const id of ['layer-router', 'layer-internet', 'layer-dns', 'layer-web']) setLayer(id, null, '—', '');
    return;
  }
  if (last.g === undefined) {
    // No router address found. While the internet still answers, that's a lookup gap, not "offline".
    // Same test as the server's: a ping reply or a passing web check (h is null when it failed).
    if (last.n !== null || last.h != null) setLayer('layer-router', null, 'Unknown', 'router address not found');
    else setLayer('layer-router', false, 'No route', 'not on a network');
  }
  else {
    const notes = [gateway || ''];
    if (hotspot) notes.push('phone hotspot');
    if (vpn) notes.push(`VPN ${vpn}`);
    setLayer('layer-router', last.g !== null, last.g !== null ? `${fmtMs(last.g)} ms` : 'No reply', notes.join(' · '));
  }
  // Amber while the server says the connection is lossy, jittery or slow under load.
  const minute = sliceFrom(samples, Date.now() - 60000).map((x) => x.n).filter((v) => v !== null);
  const j = jitter(minute);
  setLayer('layer-internet', last.n === null ? false : last.q ? 'w' : true, last.n !== null ? `${fmtMs(last.n)} ms` : 'No reply',
    j === null ? config.pingHost : `jitter ${fmtMs(j)} ms · ${config.pingHost}`);
  setLayer('layer-dns', last.d !== null, last.d !== null ? `${fmtMs(last.d)} ms` : 'No answer', 'uncached lookup');

  let web = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if ('h' in samples[i]) { web = samples[i]; break; }
  }
  if (!web) setLayer('layer-web', null, '—', 'not checked yet');
  else {
    const ago = `checked ${fmtDur(Date.now() - web.t)} ago`;
    if (web.p) setLayer('layer-web', false, 'Intercepted', ago);
    else setLayer('layer-web', web.h !== null, web.h !== null ? `${fmtMs(web.h)} ms` : 'Failed', ago);
  }
}

let lastFavicon = '';
function setFavicon(status) {
  if (status === lastFavicon) return;
  lastFavicon = status;
  const css = getComputedStyle(document.documentElement);
  const color = { up: '--good', warn: '--warning', down: '--critical', idle: '--idle' }[status];
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = css.getPropertyValue(color).trim();
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fill();
  $('favicon').href = c.toDataURL('image/png');
}

// ---------- rendering: tiles ----------

const windowSamples = (list = samples) => sliceFrom(list, Date.now() - rangeMs);

function renderTiles() {
  const win = windowSamples();
  const label = fmtRange(rangeMs);
  if (!win.length) {
    for (const id of ['t-uptime', 't-outages', 't-latency', 't-loss']) $(id).textContent = '—';
    for (const id of ['t-uptime-sub', 't-outages-sub', 't-latency-sub', 't-loss-sub']) $(id).textContent = `no checks in the last ${label}`;
    return;
  }
  const now = Date.now();
  const from = now - rangeMs;
  const { observedMs, downMs } = uptime(samples, from, now, config, running());
  setTile('t-uptime', fmtUptime(observedMs, downMs), '%');
  $('t-uptime-sub').textContent = `${win.length.toLocaleString()} checks, last ${label}`;

  const outs = outages().filter((o) => o.end > from);
  setTile('t-outages', String(outs.length), '');
  $('t-outages-sub').textContent = outs.length ? `${fmtDur(downMs)} offline in total` : `none in the last ${label}`;

  const ns = win.map((x) => x.n).filter((v) => v !== null);
  const med = median(ns);
  setTile('t-latency', fmtMs(med), med == null ? '' : 'ms');
  const j = jitter(ns);
  $('t-latency-sub').textContent = ns.length
    ? `95th percentile ${fmtMs(percentile(ns, 0.95))} ms${j === null ? '' : ` · jitter ${fmtMs(j)} ms`}`
    : 'no successful pings';

  const lost = win.filter((x) => x.n === null).length;
  const loss = (lost / win.length) * 100;
  setTile('t-loss', loss === 0 ? '0' : loss < 0.1 ? '<0.1' : loss.toFixed(1), '%');
  $('t-loss-sub').textContent = `${lost.toLocaleString()} of ${win.length.toLocaleString()} pings lost`;
}

// target: an element or its id.
function setTile(target, value, unit) {
  const el = typeof target === 'string' ? $(target) : target;
  el.textContent = value;
  if (unit) {
    const u = document.createElement('span');
    u.className = 'tile-unit';
    u.textContent = unit;
    el.appendChild(u);
  }
}

// ---------- rendering: charts ----------

const SVGNS = 'http://www.w3.org/2000/svg';
const STATUS_RANK = { up: 0, warn: 1, down: 2 };

function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVGNS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

function niceMax(v) {
  const steps = [10, 20, 25, 50, 100, 150, 200, 250, 500, 1000, 1500, 2000, 5000];
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / 1000) * 1000;
}

// The next 1, 2, 2.5, 4 or 5 times a power of ten at or above v, for byte scales.
function niceBytes(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  for (const k of [1, 2, 2.5, 4, 5, 10]) if (v <= k * p) return k * p;
  return 10 * p;
}

function tipRow(color, value, name) {
  const row = document.createElement('div');
  row.className = 'tt-row';
  if (color) {
    const k = document.createElement('i');
    k.className = 'key-line';
    k.style.background = color;
    row.appendChild(k);
  }
  const strong = document.createElement('strong');
  strong.textContent = value;
  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = name;
  row.append(strong, span);
  return row;
}

// A time chart over the selected range: samples averaged into buckets about 3px wide,
// one line per series, amber/red bands where the worst status in a bucket wasn't "up",
// and a hover crosshair with a tooltip.
//   series: [{ key, color, label, fmt(v), missing }], first drawn on top and listed first
//   yMax(max): the top of the y scale for the largest bucket value
//   footer(b): optional [value, name] row under the series in the tooltip
//   bands: false to leave out the status bands
//   statusOf(x): the status a sample counts as for bands and the tooltip, x.s by default
//   marks(): optional events ({ t, text }) drawn as dashed lines and listed in the tooltip
function makeChart({ svg, tip, list, stepMs, series, yMax: scale, yLabel, left = 40, footer, bands = true, statusOf = (x) => x.s, marks }) {
  let buckets = [];
  let geom = null;
  let hoverIndex = null;

  function render() {
    const W = svg.clientWidth || 600;
    const H = svg.clientHeight || 240;
    const m = { l: left, r: 8, t: 8, b: 22 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const now = Date.now();
    const start = now - rangeMs;

    // One bucket per ~3px, or per sample if that's coarser.
    const n = Math.max(1, Math.min(Math.floor(pw / 3), Math.ceil(rangeMs / stepMs())));
    const bms = rangeMs / n;
    buckets = Array.from({ length: n }, (_, i) => ({ t0: start + i * bms, t1: start + (i + 1) * bms, cnt: 0, worst: null, sum: {}, num: {}, miss: {} }));
    for (const x of windowSamples(list())) {
      const b = buckets[Math.min(n - 1, Math.floor((x.t - start) / bms))];
      b.cnt++;
      for (const s of series) {
        const v = x[s.key];
        if (v == null) { b.miss[s.key] = (b.miss[s.key] || 0) + 1; continue; }
        b.sum[s.key] = (b.sum[s.key] || 0) + v;
        b.num[s.key] = (b.num[s.key] || 0) + 1;
      }
      const st = statusOf(x);
      if (b.worst === null || STATUS_RANK[st] > STATUS_RANK[b.worst]) b.worst = st;
    }
    for (const e of marks ? sliceFrom(marks(), start) : []) {
      (buckets[Math.min(n - 1, Math.floor((e.t - start) / bms))].marks ??= []).push(e);
    }
    let max = 0;
    for (const b of buckets) {
      for (const s of series) {
        b[s.key] = b.num[s.key] ? b.sum[s.key] / b.num[s.key] : null;
        max = Math.max(max, b[s.key] ?? 0);
      }
    }

    const yMax = scale(max);
    const x = (i) => m.l + (i + 0.5) * (pw / n);
    const y = (v) => m.t + ph - (Math.min(v, yMax) / yMax) * ph;
    geom = { m, pw, ph, n, W, H, x, y };

    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // status bands behind everything
    const bandW = pw / n;
    let i = 0;
    while (bands && i < n) {
      const s = buckets[i].worst;
      if (s !== 'down' && s !== 'warn') { i++; continue; }
      let j = i;
      while (j + 1 < n && buckets[j + 1].worst === s) j++;
      svgEl('rect', {
        x: m.l + i * bandW, y: m.t, width: (j - i + 1) * bandW, height: ph,
        fill: s === 'down' ? 'color-mix(in srgb, var(--critical) 22%, transparent)' : 'color-mix(in srgb, var(--warning) 26%, transparent)',
      }, svg);
      i = j + 1;
    }

    // event marks, behind the grid and lines
    buckets.forEach((b, k) => {
      if (!b.marks) return;
      const xx = m.l + (k + 0.5) * bandW;
      svgEl('line', { x1: xx, x2: xx, y1: m.t, y2: m.t + ph, stroke: 'var(--ink-2)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }, svg);
    });

    // y grid + labels
    // 4 or 5 gridline steps, whichever lands on whole numbers (50 -> 10s, 100 -> 25s).
    const steps = yMax % 4 === 0 ? 4 : 5;
    for (let k = 0; k <= steps; k++) {
      const v = (yMax / steps) * k;
      const yy = y(v);
      svgEl('line', { x1: m.l, x2: m.l + pw, y1: yy, y2: yy, stroke: k === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
      const t = svgEl('text', { x: m.l - 6, y: yy + 4, 'text-anchor': 'end' }, svg);
      t.textContent = yLabel(v);
    }

    // x labels: about one per 110px
    const ticks = Math.max(2, Math.floor(pw / 110));
    for (let k = 0; k <= ticks; k++) {
      const tt = start + (rangeMs / ticks) * k;
      const xx = m.l + (pw / ticks) * k;
      const t = svgEl('text', { x: xx, y: H - 6, 'text-anchor': k === 0 ? 'start' : k === ticks ? 'end' : 'middle' }, svg);
      t.textContent = k === ticks ? 'now' : fmtTime(tt, false);
    }

    // lines, broken wherever a bucket has no value; drawn last-first so the first series is on top
    for (const s of [...series].reverse()) {
      let d = '';
      let pen = false;
      for (let k = 0; k < n; k++) {
        const v = buckets[k][s.key];
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      if (d) svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    }

    // crosshair and dots (hidden until hover), then the hit area
    geom.cross = svgEl('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ph, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' }, svg);
    geom.dots = series.map((s) => svgEl('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    svgEl('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' }, svg);

    if (hoverIndex !== null) show(hoverIndex);
  }

  function show(i) {
    if (!geom || i < 0 || i >= buckets.length) return hide();
    hoverIndex = i;
    const b = buckets[i];
    const xx = geom.x(i);
    geom.cross.setAttribute('x1', xx);
    geom.cross.setAttribute('x2', xx);
    geom.cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      const dot = geom.dots[k];
      const v = b[s.key];
      if (v == null) { dot.setAttribute('visibility', 'hidden'); return; }
      dot.setAttribute('cx', xx);
      dot.setAttribute('cy', geom.y(v));
      dot.setAttribute('visibility', 'visible');
    });

    tip.replaceChildren();
    const time = document.createElement('div');
    time.className = 'tt-time';
    time.textContent = b.t1 - b.t0 > 90000 ? `${fmtTime(b.t0, false)} – ${fmtTime(b.t1, false)}` : `${fmtTime(b.t0)} – ${fmtTime(b.t1)}`;
    tip.appendChild(time);
    if (!b.cnt) {
      tip.appendChild(tipRow(null, 'No checks', '(monitor stopped or asleep)'));
    } else {
      for (const s of series) tip.appendChild(tipRow(s.color, b[s.key] == null ? s.missing : s.fmt(b[s.key]), s.label()));
      const f = footer?.(b);
      if (f) {
        const st = tipRow(null, f[0], f[1]);
        st.style.marginTop = '4px';
        tip.appendChild(st);
      }
    }
    for (const e of b.marks ?? []) {
      const row = tipRow(null, fmtTime(e.t, false), e.text);
      row.classList.add('tt-mark');
      tip.appendChild(row);
    }
    tip.style.display = 'block';
    const wrapW = svg.clientWidth;
    const tw = tip.offsetWidth;
    let leftPx = xx + 12;
    if (leftPx + tw > wrapW) leftPx = xx - tw - 12;
    tip.style.left = `${Math.max(0, leftPx)}px`;
    tip.style.top = `${geom.m.t}px`;
  }

  function hide() {
    hoverIndex = null;
    tip.style.display = 'none';
    if (geom) for (const el of [geom.cross, ...geom.dots]) el.setAttribute('visibility', 'hidden');
  }

  svg.addEventListener('pointermove', (e) => {
    if (!geom) return;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (geom.W / rect.width);
    if (px < geom.m.l || px > geom.m.l + geom.pw) return hide();
    show(Math.min(geom.n - 1, Math.max(0, Math.floor((px - geom.m.l) / (geom.pw / geom.n)))));
  });
  svg.addEventListener('pointerleave', hide);
  new ResizeObserver(() => render()).observe(svg);

  return { render, hide };
}

const rttChart = makeChart({
  svg: $('chart'),
  tip: $('tooltip'),
  list: () => samples,
  stepMs: () => config.tickMs,
  series: [
    { key: 'n', color: 'var(--series-1)', label: () => 'Internet', fmt: (v) => `${fmtMs(v)} ms`, missing: 'no reply' },
    { key: 'g', color: 'var(--series-2)', label: () => 'Router', fmt: (v) => `${fmtMs(v)} ms`, missing: 'no reply' },
  ],
  yMax: (max) => niceMax(Math.max(max * 1.1, 20)),
  yLabel: (v) => String(Math.round(v)),
  footer: (b) => [LABELS[b.worst], b.miss.n ? `${b.miss.n} of ${b.cnt} pings lost` : `${b.cnt} check${b.cnt === 1 ? '' : 's'}`],
  marks: () => events,
});

// Shade this chart only for warnings about what it plots: a full disk or low battery
// would otherwise shade it while CPU and memory are fine.
const LOAD_KEYS = ['cpu', 'mem', 'swap'];
const loadStatus = (x) => (x.w?.some((k) => LOAD_KEYS.includes(k)) ? 'warn' : 'up');
const machineFooter = (b) => (b.worst === 'warn' ? ['Degraded', '(CPU, memory or swap)'] : null);

const loadChart = makeChart({
  svg: $('chart-load'),
  tip: $('tooltip-load'),
  list: () => machine,
  stepMs: () => config.machineMs,
  series: [
    { key: 'cpu', color: 'var(--series-1)', label: () => 'CPU', fmt: (v) => `${Math.round(v)}%`, missing: '—' },
    { key: 'mem', color: 'var(--series-2)', label: () => 'Memory', fmt: (v) => `${Math.round(v)}%`, missing: '—' },
  ],
  yMax: () => 100,
  yLabel: (v) => String(Math.round(v)),
  footer: machineFooter,
  statusOf: loadStatus,
});

const netChart = makeChart({
  svg: $('chart-net'),
  tip: $('tooltip-net'),
  list: () => machine,
  stepMs: () => config.machineMs,
  series: [
    { key: 'rx', color: 'var(--series-1)', label: () => 'Received', fmt: (v) => fmtBytes(v, true), missing: '—' },
    { key: 'tx', color: 'var(--series-2)', label: () => 'Sent', fmt: (v) => fmtBytes(v, true), missing: '—' },
  ],
  yMax: (max) => niceBytes(Math.max(max * 1.1, 10000)),
  yLabel: (v) => (v ? fmtBytes(v) : '0'),
  left: 52,
  // Machine warnings are about CPU, memory and disk, so they'd mislead here.
  bands: false,
});

function hideAllHovers() {
  for (const c of [rttChart, loadChart, netChart]) c.hide();
}

// ---------- rendering: tables ----------

function cell(tr, text, status) {
  const td = document.createElement('td');
  if (status) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.dataset.s = status;
    b.textContent = text;
    td.appendChild(b);
  } else td.textContent = text;
  tr.appendChild(td);
}

function table(headers, rows) {
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = t.createTBody();
  for (const fill of rows) fill(body.insertRow());
  return t;
}

function renderOutages() {
  const list = outages().reverse();
  const box = $('outages');
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = samples.length ? 'No outages recorded.' : 'No checks recorded yet.';
    box.replaceChildren(p);
    return;
  }
  box.replaceChildren(table(['Started', 'Duration', 'Likely cause'], list.map((o) => (tr) => {
    cell(tr, `${new Date(o.start).toLocaleDateString([], { weekday: 'short' })} ${fmtTime(o.start)}`, 'down');
    cell(tr, o.ongoing ? `${fmtDur(o.end - o.start)} (ongoing)` : fmtDur(o.end - o.start));
    cell(tr, o.reason);
  })));
}

// ---------- speed test (macOS) ----------

function lastSpeed() {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].k === 'speed') return events[i];
  return null;
}

const mbps = (bits) => (bits == null ? '—' : bits < 1e7 ? (bits / 1e6).toFixed(1) : String(Math.round(bits / 1e6)));

function speedTile(label, value, unit, sub) {
  const el = document.createElement('div');
  const l = document.createElement('div');
  l.className = 'tile-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'tile-value';
  setTile(v, value, value === '—' ? '' : unit);
  const s = document.createElement('div');
  s.className = 'tile-sub';
  s.textContent = sub;
  el.append(l, v, s);
  return el;
}

function renderSpeed() {
  $('speed-card').hidden = !config.speedTest;
  if (!config.speedTest) return;
  const button = $('speed-run');
  button.disabled = speedRunning || !connected;
  button.textContent = speedRunning ? 'Testing… (about 20s)' : 'Run speed test';

  const cost = hotspot
    ? 'You’re on a phone hotspot: a test uses several hundred MB of its mobile data.'
    : 'A test takes about 20 seconds and moves a few hundred MB.';
  const note = document.createElement('div');
  note.className = 'tile-sub';
  const ev = lastSpeed();
  if (!ev || !ev.speed || ev.speed.error) {
    note.textContent = `${ev ? `${ev.text}, at ${fmtTime(ev.t, false)}.` : 'No speed test in the last 24 hours.'} ${cost}`;
    $('speed').replaceChildren(note);
    return;
  }
  const r = ev.speed;
  const grid = document.createElement('div');
  grid.className = 'speed-grid';
  grid.append(
    speedTile('Download', mbps(r.down), 'Mbps', ''),
    speedTile('Upload', mbps(r.up), 'Mbps', ''),
    speedTile('Ping under load', r.rpm ? String(Math.round(60000 / r.rpm)) : '—', 'ms', r.rpm ? `responsiveness ${Math.round(r.rpm)} RPM` : ''),
    speedTile('Ping idle', r.baseRtt == null ? '—' : fmtMs(r.baseRtt), 'ms', ''),
  );
  note.textContent = `Ran at ${fmtTime(ev.t, false)}${r.iface ? ` over ${r.iface}` : ''}. ${cost}`;
  $('speed').replaceChildren(grid, note);
}

async function runSpeedTest() {
  if (hotspot && !confirm('You’re on a phone hotspot. A speed test uses several hundred MB of its mobile data. Run it?')) return;
  try {
    const res = await fetch('/speedtest', { method: 'POST' });
    if (res.status === 202 || res.status === 409) speedRunning = true;
  } catch { /* the monitor is unreachable; the hero already says so */ }
  renderSpeed();
}
$('speed-run').addEventListener('click', runSpeedTest);

function renderChanges() {
  const box = $('changes');
  const list = events.slice(-50).reverse();
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No changes recorded.';
    box.replaceChildren(p);
    return;
  }
  box.replaceChildren(table(['Time', 'What happened'], list.map((e) => (tr) => {
    cell(tr, `${new Date(e.t).toLocaleDateString([], { weekday: 'short' })} ${fmtTime(e.t)}`);
    cell(tr, e.text);
  })));
}

function renderRecent() {
  const details = $('recent').closest('details');
  if (!details.open) return;
  const rows = samples.slice(-20).reverse();
  const v = (x) => (x === undefined ? '—' : x === null ? 'failed' : `${fmtMs(x)} ms`);
  $('recent').replaceChildren(table(['Time', 'Status', 'Router', 'Internet', 'DNS', 'Web'], rows.map((x) => (tr) => {
    cell(tr, fmtTime(x.t));
    cell(tr, LABELS[x.s], x.s);
    cell(tr, v(x.g));
    cell(tr, v(x.n));
    cell(tr, v(x.d));
    cell(tr, x.p ? 'intercepted' : v(x.h));
  })));
}
$('recent').closest('details').addEventListener('toggle', renderRecent);

// The report covers every day of history kept (KEEP_DAYS), read from disk by the server.
async function copyReport() {
  const button = $('copy-report');
  const label = button.textContent;
  button.disabled = true;
  let text = null;
  try {
    const res = await fetch(`/report?days=${config.keepDays ?? 7}`);
    if (!res.ok) throw new Error(String(res.status));
    text = await res.text();
    // A clipboard write can wait on a permission prompt indefinitely, so give up after a moment.
    const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1500));
    await Promise.race([navigator.clipboard.writeText(text), slow]);
    button.textContent = 'Copied';
  } catch {
    // Without clipboard access, show the report selected, ready to copy by hand.
    if (text !== null) {
      const box = $('report-text');
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
    }
    button.textContent = text === null ? 'Couldn’t load the report' : 'Shown below, ready to copy';
  }
  setTimeout(() => { button.textContent = label; button.disabled = false; }, 2500);
}
$('copy-report').addEventListener('click', copyReport);

// ---------- wiring ----------

function procTable(title, list, value) {
  return table([title, ''], list.map((p) => (tr) => {
    cell(tr, p.name);
    tr.firstChild.title = `${p.name} (pid ${p.pid})`;
    cell(tr, value(p));
  }));
}

function renderProcs() {
  const box = $('procs');
  if (!procs || (!procs.cpu.length && !procs.mem.length)) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = connected ? `Collected while this page is open; the first list arrives within ${config.machineMs / 1000}s.` : '—';
    box.replaceChildren(p);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = procs.net ? 'procs three' : 'procs';
  // CPU is % of one core, so a busy multi-threaded process can pass 100%.
  wrap.append(
    procTable('By CPU (% of one core)', procs.cpu, (p) => `${p.cpu < 10 ? p.cpu.toFixed(1) : Math.round(p.cpu)}%`),
    procTable('By memory', procs.mem, (p) => fmtBytes(p.mb * 1048576)),
  );
  // macOS only: traffic in + out, with the split in the hover title.
  if (procs.net) {
    const only = (text) => table(['By network', ''], [(tr) => { cell(tr, text); cell(tr, ''); }]);
    if (procs.net === 'measuring') wrap.append(only('Measuring…'));
    else if (!procs.net.length) wrap.append(only('Nothing sending or receiving'));
    else {
      const t = procTable('By network', procs.net, (p) => fmtBytes(p.rx + p.tx, true));
      procs.net.forEach((p, i) => { t.tBodies[0].rows[i].lastChild.title = `${fmtBytes(p.rx, true)} in, ${fmtBytes(p.tx, true)} out`; });
      wrap.append(t);
    }
  }
  box.replaceChildren(wrap);
}

let machineChartsAt = 0;
function renderMachineCharts() {
  loadChart.render();
  netChart.render();
  machineChartsAt = Date.now();
}

function renderMachine() {
  renderMachineCharts();
  renderProcs();
}

// Everything that changes with a network sample. Machine charts and processes change only
// with a machine sample (every 10s), so they're left to renderMachine().
function renderNetwork() {
  renderHero();
  renderTiles();
  rttChart.render();
  renderSpeed();
  renderOutages();
  renderChanges();
  renderRecent();
  $('legend-internet').textContent = `Internet (${config.pingHost})`;
  $('legend-router').textContent = gateway ? `Router (${gateway})` : 'Router';
  $('footer').textContent = `Checks every ${config.tickMs / 1000}s: ping router and ${config.pingHost}, uncached DNS lookup, and an HTTP 204 check every ${config.httpEveryMs / 1000}s or whenever another check fails. Machine health every ${config.machineMs / 1000}s.`;
}

function renderAll() {
  renderNetwork();
  renderMachine();
}

function setRange(ms) {
  rangeMs = ms;
  try { localStorage.setItem('netmon-range', String(ms)); } catch { /* ignore */ }
  for (const b of document.querySelectorAll('.filters button')) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === ms));
  hideAllHovers();
  renderAll();
}
for (const b of document.querySelectorAll('.filters button')) b.addEventListener('click', () => setRange(Number(b.dataset.range)));

// The route details that come with init and every sample.
function setLink(data) {
  gateway = data.gateway;
  iface = data.iface ?? null;
  vpn = data.vpn ?? null;
  hotspot = !!data.hotspot;
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    config = { ...config, ...data.config };
    $('view-report').href = `/report?days=${config.keepDays}`;
    $('copy-report').textContent = `Copy ${config.keepDays}-day report for your ISP`;
    setLink(data);
    samples = data.samples;
    events = data.events ?? [];
    speedRunning = !!data.speedRunning;
    machine = data.machine?.samples ?? [];
    procs = data.machine?.procs ?? null;
    connected = true;
    triedOnce = true;
    renderAll();
  });
  es.addEventListener('sample', (e) => {
    const data = JSON.parse(e.data);
    setLink(data);
    samples.push(data.sample);
    const cutoff = Date.now() - 86400000;
    if (samples.length && samples[0].t < cutoff) samples = samples.filter((x) => x.t >= cutoff);
    renderNetwork();
    // Keep the machine charts' time axis moving with the network chart's when machine samples
    // are far apart (a long MACHINE_MS) or have stopped, without redrawing them every 3s.
    if (Date.now() - machineChartsAt >= 10000) renderMachineCharts();
  });
  es.addEventListener('machine', (e) => {
    const data = JSON.parse(e.data);
    machine.push(data.sample);
    procs = data.procs;
    const cutoff = Date.now() - 86400000;
    if (machine.length && machine[0].t < cutoff) machine = machine.filter((x) => x.t >= cutoff);
    renderHero();
    renderMachine();
  });
  es.addEventListener('event', (e) => {
    events.push(JSON.parse(e.data));
    const cutoff = Date.now() - 86400000;
    if (events[0].t < cutoff) events = events.filter((x) => x.t >= cutoff);
    renderChanges();
    renderSpeed();
    rttChart.render();
  });
  es.addEventListener('speed', (e) => {
    speedRunning = JSON.parse(e.data).running;
    renderSpeed();
  });
  es.addEventListener('error', () => {
    // EventSource retries on its own; just show that we're cut off meanwhile.
    connected = false;
    triedOnce = true;
    renderHero();
  });
}

// Keep the "for 3m 12s" text and the stale-monitor check moving between samples.
setInterval(renderHero, 1000);

setRange(rangeMs);
connect();
