// How one round of network checks becomes a status. Pure, so it can be tested without a network.

import type { Ms, HttpResult } from './checks.ts';

export type Status = 'up' | 'warn' | 'down';

export interface Sample {
  t: number;    // epoch ms
  s: Status;
  g?: Ms;       // router ping (absent when the router address is unknown)
  n: Ms;        // internet ping
  d: Ms;        // DNS lookup
  h?: Ms;       // HTTP 204 check (only on rounds where it ran)
  p?: 1;        // HTTP check got something other than 204: captive portal or interception
  r?: string;   // why, when status is not "up"
}

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
