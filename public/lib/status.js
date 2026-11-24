// Status logic shared by the page, the server's report and the tests.
// Pure: samples, settings and the current time all come in as arguments.

/**
 * @typedef {'up' | 'warn' | 'down'} Status
 * @typedef {{ t: number, s: Status, g?: number | null, n: number | null, d: number | null,
 *   h?: number | null, p?: 1, r?: string, q?: string[] }} NetSample
 * @typedef {{ t: number, s: 'up' | 'warn', r?: string, w?: string[] }} MachineMark
 * @typedef {{ tickMs: number, gapMs: number }} NetTiming
 * @typedef {{ start: number, end: number, reason: string, ongoing?: boolean }} Outage
 */

/**
 * What the hero shows for a network status and a machine status (undefined when unknown).
 * Offline is about the network only; a machine warning turns an otherwise healthy status Degraded.
 * @param {Status} net
 * @param {'up' | 'warn' | undefined} mach
 * @returns {Status}
 */
export function heroAt(net, mach) {
  if (net === 'down') return 'down';
  return mach === 'warn' ? 'warn' : net;
}

/**
 * How long the hero's current status has held. Walks back through both records together: each pair
 * (network sample i, machine sample j) holds from the later of the two, so step past whichever
 * is newer, and stop at the first pair that shows a different status or at a gap in the network record.
 * A machine sample counts only up to machineGapMs after it; inside a gap in the machine record
 * its status is unknown, and the machine samples before the gap count again once the walk reaches them.
 * @param {NetSample[]} samples
 * @param {MachineMark[]} machine
 * @param {{ gapMs: number, machineGapMs: number }} cfg
 * @param {Status} status the hero's status now
 * @returns {number | null}
 */
export function statusSince(samples, machine, cfg, status) {
  let i = samples.length - 1;
  if (i < 0) return null;
  let j = machine.length - 1;
  /** @type {number | null} */
  let since = null;
  for (;;) {
    const n = samples[i];
    const m = j >= 0 ? machine[j] : null;
    const start = Math.max(n.t, m ? m.t : -Infinity);
    const mach = m && start - m.t <= cfg.machineGapMs ? m.s : undefined;
    // The newest pair always counts: the caller judged the current status against now, not against n.t.
    if (since !== null && heroAt(n.s, mach) !== status) return since;
    since = start;
    if (m && m.t >= n.t) j--;
    else {
      if (i === 0 || n.t - samples[i - 1].t > cfg.gapMs) return since;
      i--;
    }
  }
}

/**
 * When the time sample i stands for ends: at the next sample, one round later if the
 * record stops there, or now for the latest sample while the monitor is running.
 * Outages, uptime and the report all use this, so they agree.
 * @param {NetSample[]} samples
 * @param {number} i
 * @param {number} now
 * @param {NetTiming} cfg
 * @param {boolean} running the monitor is running and the latest sample is current
 */
export function sampleEnd(samples, i, now, cfg, running) {
  const x = samples[i];
  const next = samples[i + 1];
  if (next) return next.t - x.t <= cfg.gapMs ? next.t : x.t + cfg.tickMs;
  return running ? now : x.t + cfg.tickMs;
}

/**
 * Runs of "down" samples. Each outage ends where its last down sample's time ends:
 * at the first sample that isn't down, at a gap in the record, or now if ongoing.
 * @param {NetSample[]} samples
 * @param {number} now
 * @param {NetTiming} cfg
 * @param {boolean} running
 * @returns {Outage[]}
 */
export function outages(samples, now, cfg, running) {
  /** @type {(Outage & { reasons: Record<string, number> })[]} */
  const list = [];
  /** @type {(Outage & { reasons: Record<string, number> }) | null} */
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    if (x.s !== 'down') {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { start: x.t, end: x.t, reason: '', reasons: {} };
      list.push(cur);
    }
    if (x.r) cur.reasons[x.r] = (cur.reasons[x.r] || 0) + 1;
    cur.end = sampleEnd(samples, i, now, cfg, running);
    if (i === samples.length - 1) cur.ongoing = running;
    // A gap in the record ends the outage; a down sample after it starts a new one.
    if (cur.end !== samples[i + 1]?.t) cur = null;
  }
  return list.map(({ reasons, ...o }) => ({
    ...o,
    reason: Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
  }));
}

/**
 * The samples with t >= from, assuming the list is sorted by time.
 * @template {{ t: number }} T
 * @param {T[]} list
 * @param {number} from
 * @returns {T[]}
 */
export function sliceFrom(list, from) {
  let i = list.length;
  while (i > 0 && list[i - 1].t >= from) i--;
  return list.slice(i);
}

/**
 * Time observed and time offline between from and now. By time, not by sample count: rounds take
 * longer during an outage (checks wait for timeouts), so offline samples are sparser than online ones.
 * Starts one sample before from, since that sample's time may run into the window.
 * @param {NetSample[]} samples
 * @param {number} from
 * @param {number} now
 * @param {NetTiming} cfg
 * @param {boolean} running
 */
export function uptime(samples, from, now, cfg, running) {
  const first = samples.length - sliceFrom(samples, from).length;
  let observedMs = 0;
  let downMs = 0;
  for (let i = Math.max(0, first - 1); i < samples.length; i++) {
    const span = Math.min(sampleEnd(samples, i, now, cfg, running), now) - Math.max(samples[i].t, from);
    if (span <= 0) continue;
    observedMs += span;
    if (samples[i].s === 'down') downMs += span;
  }
  return { observedMs, downMs, checks: samples.length - first };
}

/**
 * Uptime as the page and the report print it. Never rounds up to 100 when there was any downtime.
 * @param {number} observedMs
 * @param {number} downMs
 */
export function fmtUptime(observedMs, downMs) {
  if (!downMs) return '100';
  const up = ((observedMs - downMs) / observedMs) * 100;
  return up >= 99 ? Math.min(up, 99.99).toFixed(2) : up.toFixed(1);
}

/** @param {number[]} xs */
export function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * The value at fraction p of the sorted list (0.95 for the 95th percentile).
 * @param {number[]} xs
 * @param {number} p
 */
export function percentile(xs, p) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

/**
 * Mean absolute difference between consecutive values, or null with fewer than two.
 * @param {number[]} values in time order
 */
export function jitter(values) {
  if (values.length < 2) return null;
  let sum = 0;
  for (let k = 1; k < values.length; k++) sum += Math.abs(values[k] - values[k - 1]);
  return sum / (values.length - 1);
}
