import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, fmtSpan, reportFromDisk } from '../src/report.ts';
import { loadConfig } from '../src/config.ts';
import { persist } from '../src/history.ts';
import type { Sample } from '../src/netrules.ts';

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 24, 12).getTime();
const opts = { from: NOW - 2 * HOUR, now: NOW, tickMs: 3000, gapMs: 16_000, pingHost: '1.1.1.1' };

// Every 3s over the last hour; down for 5 minutes in the middle.
function hour(): Sample[] {
  const out: Sample[] = [];
  for (let t = NOW - HOUR; t <= NOW; t += 3000) {
    const down = t >= NOW - 30 * 60_000 && t < NOW - 25 * 60_000;
    out.push(down
      ? { t, s: 'down', n: null, d: null, r: 'Router OK, nothing beyond it: modem or ISP problem' }
      : { t, s: 'up', n: 20, d: 10 });
  }
  return out;
}

test('report: monitored time, uptime, outages and ping', () => {
  const text = buildReport(hour(), opts);
  assert.match(text, /^Internet connection report, /);
  assert.match(text, /Monitored: {2}1h 00m of 2h 00m/);
  assert.match(text, /Uptime: {5}91\.7% of the monitored time/);
  assert.match(text, /Outages: {4}1, 5m 00s offline in total/);
  assert.match(text, /Ping: {7}median 20 ms, 95th percentile 20 ms, 8\.3% of pings lost/);
  assert.match(text, /5m 00s +Router OK, nothing beyond it: modem or ISP problem\n$/);
  assert.doesNotMatch(text, /ongoing/);
});

test('report: an empty period says so', () => {
  assert.match(buildReport([], opts), /No checks were recorded in this period\.\n$/);
});

test('report: an outage still going is marked ongoing', () => {
  const s = hour().map((x) => (x.t > NOW - 60_000 ? { ...x, s: 'down' as const, n: null, r: 'No network: Wi-Fi off or not joined' } : x));
  assert.match(buildReport(s, opts), /No network: Wi-Fi off or not joined \(ongoing\)\n$/);
});

test('fmtSpan: days for long spans', () => {
  assert.equal(fmtSpan(90_000), '1m 30s');
  assert.equal(fmtSpan(5 * HOUR + 60_000), '5h 01m');
  assert.equal(fmtSpan(164 * HOUR), '6d 20h');
});

test('reportFromDisk: reads the history files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-it-me-report-'));
  for (const x of hour()) await persist(dir, x);
  const text = reportFromDisk(loadConfig({ DATA_DIR: dir }), 1, NOW);
  assert.match(text, /Outages: {4}1, 5m 00s offline in total/);
});
