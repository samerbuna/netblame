// Number and time formatting shared by the page and the server's report.

/** @param {number | null | undefined} v round-trip in ms */
export function fmtMs(v) {
  if (v == null) return '—';
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

/** @param {number} ms */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** @param {number} t epoch ms */
export function fmtTime(t, withSeconds = true) {
  return new Date(t).toLocaleTimeString([], withSeconds
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
}

/** @param {number} n bytes */
export function fmtBytes(n, perSecond = false) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}${perSecond ? '/s' : ''}`;
}
