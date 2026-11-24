// An on-demand speed test with Apple's networkQuality (macOS 12 and later): download and upload
// speed, and responsiveness, which measures how much latency grows while the connection is busy.
// One run moves hundreds of MB, so it only runs when someone presses the button.

import fs from 'node:fs';
import { execFile } from 'node:child_process';

export interface SpeedResult {
  down: number | null;    // download, bits/s
  up: number | null;      // upload, bits/s
  rpm: number | null;     // responsiveness, round-trips per minute while busy
  baseRtt: number | null; // idle round-trip, ms
  iface?: string;
  error?: string;
}

const TOOL = '/usr/bin/networkQuality';

export const speedTestAvailable = () => process.platform === 'darwin' && fs.existsSync(TOOL);

// The JSON from networkQuality -c. Key names have shifted between macOS versions, so read what's there.
export function parseNetworkQuality(text: string): SpeedResult {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return { down: null, up: null, rpm: null, baseRtt: null, error: 'networkQuality printed something unexpected' };
  }
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof j[k] === 'number' && Number.isFinite(j[k])) return j[k] as number;
    return null;
  };
  const r: SpeedResult = {
    down: num('dl_throughput'),
    up: num('ul_throughput'),
    rpm: num('responsiveness', 'dl_responsiveness', 'ul_responsiveness'),
    baseRtt: num('base_rtt'),
  };
  if (typeof j.interface_name === 'string') r.iface = j.interface_name;
  if (r.down === null && r.up === null) r.error = typeof j.error_domain === 'string' ? `networkQuality failed (${j.error_domain})` : 'networkQuality gave no result';
  return r;
}

export function runSpeedTest(): Promise<SpeedResult> {
  return new Promise((resolve) => {
    execFile(TOOL, ['-c'], { timeout: 90_000 }, (err, stdout) => {
      // networkQuality can exit non-zero yet still print JSON describing the failure.
      if (stdout.trim()) return resolve(parseNetworkQuality(stdout));
      resolve({ down: null, up: null, rpm: null, baseRtt: null, error: err ? `networkQuality failed: ${err.message.split('\n')[0]}` : 'networkQuality gave no result' });
    });
  });
}

const mbps = (bits: number) => {
  const v = bits / 1e6;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} Mbps`;
};

// "220 Mbps down, 22.5 Mbps up, responsiveness 1256 RPM (about 48 ms under load)"
export function describeSpeed(r: SpeedResult): string {
  if (r.error) return `Speed test failed: ${r.error}`;
  const parts = [];
  if (r.down !== null) parts.push(`${mbps(r.down)} down`);
  if (r.up !== null) parts.push(`${mbps(r.up)} up`);
  if (r.rpm) parts.push(`responsiveness ${Math.round(r.rpm)} RPM (about ${Math.round(60_000 / r.rpm)} ms under load)`);
  return `Speed test: ${parts.join(', ')}`;
}
