// How network checks become a status. Pure, so it can be tested without a network.

import type { Ms, HttpResult } from './checks.ts';
import { median, percentile, jitter } from '../public/lib/status.js';

export type Status = 'up' | 'warn' | 'down';
export type QualityKey = 'loss' | 'jitter' | 'bloat';

export interface Sample {
  t: number;    // epoch ms
  s: Status;
  g?: Ms;       // router ping (absent when the router address is unknown)
  n: Ms;        // internet ping
  d: Ms;        // DNS lookup
  h?: Ms;       // HTTP 204 check (only on rounds where it ran)
  p?: 1;        // HTTP check got something other than 204: captive portal or interception
  r?: string;   // why, when status is not "up"
  q?: QualityKey[]; // which connection-quality limits were crossed, when that's why it's "warn"
}

// Limits for calling a working connection degraded.
export const QUALITY = {
  windowMs: 60_000,          // loss and jitter are judged over this much history ...
  coverage: 0.75,            // ... once samples cover this much of it (not right after start or wake)
  lossMin: 3,                // at least this many pings lost ...
  lossPct: 10,               // ... and at least this % of them
  jitterMs: 30,              // mean change between consecutive internet pings
  jitterPairs: 10,           // consecutive pairs needed before judging jitter
  busyBps: 250_000,          // bytes/s in + out that count as a busy connection
  loadedMs: 30_000,          // the ping under load is the median over this long ...
  loadedMin: 5,              // ... from at least this many replies
  baselineMs: 30 * 60_000,   // the normal ping is the 10th percentile over this long ...
  baselineMin: 20,           // ... from at least this many replies
  bloatMs: 100,              // ping under load this much above normal is bufferbloat
};

export const DOWN_AFTER = 2; // consecutive failed rounds before we say "down"

export interface RoundInput {
  hasGateway: boolean;
  g: Ms;
  n: Ms;
  d: Ms;
  h: HttpResult | null;        // this round's web check, when it ran
  lastHttp: HttpResult | null; // the latest web check, from this round or an earlier one
  failStreak: number;          // failed rounds in a row before this one
  inGrace: boolean;            // just woke from sleep
}

export function judgeNetwork(x: RoundInput): { s: Status; r?: string; failStreak: number } {
  const internetOk = x.n !== null || (x.h !== null && x.h.ms !== null);
  const failStreak = internetOk ? 0 : x.failStreak + 1;

  if (!internetOk) {
    let r: string;
    if (!x.hasGateway) r = 'No network: Wi-Fi off or not joined';
    else if (x.g === null) r = 'Router not responding: Wi-Fi or router problem';
    else r = 'Router OK, nothing beyond it: modem or ISP problem';
    if (x.inGrace) return { s: 'warn', r: 'Reconnecting after sleep', failStreak };
    if (failStreak < DOWN_AFTER) return { s: 'warn', r: `Checks failing, confirming… (${r})`, failStreak };
    return { s: 'down', r, failStreak };
  }
  if (x.lastHttp?.portal) return { s: 'warn', r: 'Web requests intercepted: captive portal or login page', failStreak };
  if (x.d === null) return { s: 'warn', r: 'DNS not answering', failStreak };
  if (x.lastHttp && x.lastHttp.ms === null) return { s: 'warn', r: 'Ping works but web requests fail', failStreak };
  return { s: 'up', failStreak };
}

type PingRound = Pick<Sample, 't' | 'n' | 'h'>;
type Traffic = { t: number; rx: number | null; tx: number | null };

// Connection quality on a working connection: lost pings, jittery pings, and pings that climb
// while the connection is busy (bufferbloat: a router queue filling up, which breaks calls
// while speed tests look fine).
//   recent: network rounds from the last QUALITY.baselineMs, oldest first, ending with the current one
//   traffic: machine samples (bytes/s in and out) from the last QUALITY.loadedMs
export function linkQuality(recent: PingRound[], traffic: Traffic[], now: number): { r?: string; q?: QualityKey[] } {
  const reasons: string[] = [];
  const keys: QualityKey[] = [];
  const replies = (fromMs: number) => recent.filter((x) => x.t > now - fromMs && x.n !== null).map((x) => x.n as number);

  // Bufferbloat
  const busy = traffic.some((m) => m.t > now - QUALITY.loadedMs && (m.rx ?? 0) + (m.tx ?? 0) >= QUALITY.busyBps);
  const loaded = replies(QUALITY.loadedMs);
  const base = replies(QUALITY.baselineMs);
  let bloat = false;
  if (busy && loaded.length >= QUALITY.loadedMin && base.length >= QUALITY.baselineMin) {
    const l = median(loaded)!;
    const b = percentile(base, 0.1)!;
    if (l - b >= QUALITY.bloatMs) {
      bloat = true;
      keys.push('bloat');
      reasons.push(`Slow under load: ping ${Math.round(l)} ms while the connection is busy (normally ${Math.round(b)} ms)`);
    }
  }

  const win = recent.filter((x) => x.t > now - QUALITY.windowMs);
  const covered = win.length > 0 && win[win.length - 1].t - win[0].t >= QUALITY.windowMs * QUALITY.coverage;
  if (covered) {
    // Loss. A ping counts as lost only when the web check on the same round passed, so outages
    // (already Offline) don't count. A network that blocks ping has no replies at all, and isn't judged.
    const reachable = win.filter((x) => x.n !== null || typeof x.h === 'number');
    const lost = reachable.filter((x) => x.n === null).length;
    if (lost < reachable.length && lost >= QUALITY.lossMin && (100 * lost) / reachable.length >= QUALITY.lossPct) {
      keys.push('loss');
      reasons.push(`Losing pings (${lost} of ${reachable.length} in the last minute)`);
    }

    // Jitter. Bufferbloat already explains jittery pings while busy, so it isn't reported twice.
    const values = win.filter((x) => x.n !== null).map((x) => x.n as number);
    const j = jitter(values);
    if (!bloat && j !== null && values.length - 1 >= QUALITY.jitterPairs && j > QUALITY.jitterMs) {
      keys.push('jitter');
      reasons.push(`Unstable ping (jitter ${Math.round(j)} ms)`);
    }
  }

  return keys.length ? { r: reasons.join('; '), q: keys } : {};
}
