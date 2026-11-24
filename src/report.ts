// A plain-text outage report: what to paste into a support chat or ticket with an ISP.

import { outages, uptime, fmtUptime, median, percentile, sliceFrom } from '../public/lib/status.js';
import { fmtDur, fmtMs } from '../public/lib/format.js';
import type { Sample } from './netrules.ts';
import type { Config } from './config.ts';
import { loadRangeAsync } from './history.ts';

export interface ReportOptions {
  from: number;
  now: number;
  tickMs: number;
  gapMs: number;
  pingHost: string;
}

// Longer spans read better in days and hours: "6d 20h", "3h 05m", "4m 10s".
export function fmtSpan(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 24) return fmtDur(ms);
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const when = (t: number) => new Date(t).toLocaleString([], {
  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// samples: network samples from opts.from (or a little before) to now, oldest first.
export function buildReport(all: Sample[], opts: ReportOptions): string {
  const { from, now } = opts;
  const cfg = { tickMs: opts.tickMs, gapMs: opts.gapMs };
  const samples = sliceFrom(all, from - opts.gapMs); // one sample before the window can run into it
  const last = samples[samples.length - 1];
  const running = last !== undefined && now - last.t <= opts.gapMs;
  const lines = [
    `Internet connection report, ${when(from)} to ${when(now)}`,
    `Measured on this computer by is-it-me, which checks the router, the internet (ping ${opts.pingHost}), DNS and a web request every ${opts.tickMs / 1000} seconds.`,
    '',
  ];
  if (!sliceFrom(samples, from).length) {
    lines.push('No checks were recorded in this period.');
    return lines.join('\n') + '\n';
  }

  const u = uptime(samples, from, now, cfg, running);
  const outs = outages(samples, now, cfg, running).filter((o) => o.end > from);
  const win = sliceFrom(samples, from);
  const replies = win.map((x) => x.n).filter((v): v is number => v !== null);
  const lost = win.length - replies.length;

  lines.push(
    `Monitored:  ${fmtSpan(u.observedMs)} of ${fmtSpan(now - from)} (the rest of the time this computer was off, asleep, or not running the monitor)`,
    `Uptime:     ${fmtUptime(u.observedMs, u.downMs)}% of the monitored time`,
    `Outages:    ${outs.length}${outs.length ? `, ${fmtSpan(u.downMs)} offline in total` : ''}`,
    replies.length
      ? `Ping:       median ${fmtMs(median(replies))} ms, 95th percentile ${fmtMs(percentile(replies, 0.95))} ms, ${((100 * lost) / win.length).toFixed(1)}% of pings lost`
      : 'Ping:       no replies',
  );

  if (outs.length) {
    lines.push('', 'Outages (start, duration, likely cause):');
    for (const o of outs) {
      const start = Math.max(o.start, from);
      lines.push(`  ${when(start)}   ${fmtSpan(o.end - start).padEnd(8)}  ${o.reason}${o.ongoing ? ' (ongoing)' : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

// The report for the last `days` days, read from the history files, so it works with the monitor stopped.
export async function reportFromDisk(cfg: Config, days: number, now = Date.now()): Promise<string> {
  const from = now - days * 24 * 60 * 60 * 1000;
  const samples = await loadRangeAsync<Sample>(cfg.dataDir, from - cfg.gapMs, now);
  return buildReport(samples, { from, now, tickMs: cfg.tickMs, gapMs: cfg.gapMs, pingHost: cfg.pingHost });
}
