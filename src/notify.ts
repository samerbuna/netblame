// Desktop notifications when the connection or this machine needs attention, so nobody has to
// keep the page open. createNotifier() decides what to say for each sample (pure, tested);
// sendNote() shows it.

import { execFile } from 'node:child_process';
import { fmtDur } from '../public/lib/format.js';
import type { Status } from './netrules.ts';
import type { WarnKey } from './machine.ts';

export interface Note { title: string; body: string }

export const NOTIFY = {
  quietStartMs: 60_000,          // nothing for this long after starting, while the first checks settle
  degradedAfterMs: 2 * 60_000,   // a Degraded connection has to last this long before it's worth a notification
  machineRepeatMs: 30 * 60_000,  // the same machine warning at most this often
};

// Degraded states that are part of normal operation and clear by themselves.
const PASSING = /^(Reconnecting after sleep|Checks failing, confirming)/;

const MACHINE_TITLES: Record<WarnKey, string> = {
  disk: 'Disk almost full',
  mem: 'Memory running low',
  swap: 'Swapping heavily',
  cpu: 'CPU busy',
  bat: 'Battery low',
  hot: 'CPU slowed down for heat',
  wifi: 'Weak Wi-Fi signal',
};

// startedAt: when monitoring started. gapMs, machineGapMs: a longer pause between samples means
// the machine slept or the monitor was stopped, which ends whatever episode was going on.
export function createNotifier(startedAt: number, gapMs: number, machineGapMs: number) {
  let lastNet = 0;
  let downSince: number | null = null;
  let downNotified = false;
  let warnSince: number | null = null;
  let warnNotified = false;

  let lastMachine = 0;
  let machineKeys = new Set<WarnKey>();
  const machineNotifiedAt = new Map<WarnKey, number>();

  return {
    network(x: { t: number; s: Status; r?: string }): Note | null {
      if (lastNet && x.t - lastNet > gapMs) {
        downSince = warnSince = null;
        downNotified = warnNotified = false;
      }
      lastNet = x.t;
      const quiet = x.t - startedAt < NOTIFY.quietStartMs;

      if (x.s === 'down') {
        downSince ??= x.t;
        // An outage that began during the quiet start is reported when the quiet ends.
        if (!downNotified && !quiet) {
          downNotified = true;
          return { title: 'Offline', body: x.r ?? 'The internet is unreachable' };
        }
        return null;
      }

      if (downSince !== null) {
        const notified = downNotified;
        const lasted = x.t - downSince;
        downSince = null;
        downNotified = false;
        if (notified) {
          const still = x.s === 'warn' && x.r && !PASSING.test(x.r) ? `. Still degraded: ${x.r}` : '';
          return { title: 'Back online', body: `Offline for ${fmtDur(lasted)}${still}` };
        }
      }

      if (x.s === 'warn') {
        if (x.r && PASSING.test(x.r)) return null;
        warnSince ??= x.t;
        if (!warnNotified && !quiet && x.t - warnSince >= NOTIFY.degradedAfterMs) {
          warnNotified = true;
          return { title: 'Connection degraded', body: x.r ?? '' };
        }
        return null;
      }

      // Online again.
      if (warnSince !== null) {
        const notified = warnNotified;
        const lasted = x.t - warnSince;
        warnSince = null;
        warnNotified = false;
        if (notified) return { title: 'Connection back to normal', body: `Degraded for ${fmtDur(lasted)}` };
      }
      return null;
    },

    machine(x: { t: number; s: 'up' | 'warn'; r?: string; w?: WarnKey[] }): Note | null {
      if (lastMachine && x.t - lastMachine > machineGapMs) machineKeys = new Set();
      lastMachine = x.t;
      // While quiet, warnings already present stay "new", so they're reported once the quiet ends.
      if (x.t - startedAt < NOTIFY.quietStartMs) return null;
      const keys = new Set(x.w ?? []);
      const fresh = [...keys].filter((k) => !machineKeys.has(k) && x.t - (machineNotifiedAt.get(k) ?? -Infinity) >= NOTIFY.machineRepeatMs);
      machineKeys = keys;
      if (!fresh.length) return null;
      for (const k of fresh) machineNotifiedAt.set(k, x.t);
      return { title: fresh.length === 1 ? MACHINE_TITLES[fresh[0]] : 'This machine needs attention', body: x.r ?? '' };
    },
  };
}

export function sendNote(note: Note): void {
  const done = () => { /* no notification service (no notify-send, or no desktop session); nothing to do */ };
  if (process.platform === 'darwin') {
    // The text goes in as arguments, so nothing in it is ever read as AppleScript.
    execFile('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)',
      '-e', 'end run',
      'Is it me?', note.title, note.body,
    ], done);
  } else {
    execFile('notify-send', ['--app-name=is-it-me', note.title, note.body], done);
  }
}
