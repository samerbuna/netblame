// The two check loops and what they remember: network rounds every few seconds, machine
// health every 10. Results go to history files and to whoever subscribed (the web server).

import fs from 'node:fs';
import type { Config } from './config.ts';
import { ping, dnsCheck, httpCheck, findGateway, routeInterface, isTunnel, isPhoneHotspot } from './checks.ts';
import type { HttpResult } from './checks.ts';
import { judgeNetwork, linkQuality, QUALITY } from './netrules.ts';
import { sliceFrom } from '../public/lib/status.js';
import { fmtDur } from '../public/lib/format.js';
import type { Sample } from './netrules.ts';
import { createCollector, machineStatus } from './machine.ts';
import type { MachineSample, Procs } from './machine.ts';
import { persist, loadRange, dropOlderThan, pruneOldFiles, MACHINE, EVENTS } from './history.ts';
import { createNotifier, sendNote } from './notify.ts';
import type { Note } from './notify.ts';

const GATEWAY_REFRESH_MS = 30_000;
const HISTORY_MS = 24 * 60 * 60 * 1000; // what the page gets on connect
const SLEEP_SLACK_MS = 5000;            // the wait between rounds overran by this much: the machine slept
const RESUME_GRACE_MS = 20_000;         // Wi-Fi takes a few seconds to rejoin after sleep; don't call that an outage

export type Listener = (event: string, data: unknown) => void;

// Something that happened, for the timeline: the monitor starting, the machine waking,
// the network or VPN changing, a speed test.
export interface MonitorEvent { t: number; k: 'start' | 'wake' | 'net' | 'vpn' | 'speed'; text: string }

// "en1, router 172.20.10.1 (phone hotspot, uses mobile data), VPN on (utun3)"
export function describeNetwork(gateway: string | null, iface: string | null, vpn: string | null): string {
  if (!gateway) return 'no network';
  let s = `${iface ?? 'unknown interface'}, router ${gateway}`;
  if (isPhoneHotspot(gateway)) s += ' (phone hotspot, uses mobile data)';
  if (vpn) s += `, VPN on (${vpn})`;
  return s;
}

export interface Snapshot {
  [key: string]: unknown;
  config: Record<string, unknown>;
  gateway: string | null;
  samples: Sample[];
  machine: { samples: MachineSample[]; procs: Procs | null };
}

// send: how notifications are shown, replaceable for testing.
export function createMonitor(cfg: Config, send: (note: Note) => void = sendNote) {
  const listeners = new Set<Listener>();
  const emit = (event: string, data: unknown) => {
    for (const l of listeners) l(event, data);
  };
  let viewers = 0;
  let notifier: ReturnType<typeof createNotifier> | null = null;
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  // ---------- network ----------

  let samples: Sample[] = [];
  let gateway: string | null = null;
  let gatewayIface: string | null = null; // where throughput is measured
  let vpn: string | null = null;          // the tunnel traffic to the ping host leaves through, when a VPN carries it
  let routeKnown = false;                 // false until the first route lookup, which the start event describes
  let events: MonitorEvent[] = [];
  let gatewayCheckedAt = 0;
  let lastHttp: HttpResult | null = null;
  let lastHttpAt = 0;
  let lastTickEnd = 0;
  let failStreak = 0;
  let graceUntil = 0;

  async function tick(): Promise<void> {
    const now = Date.now();
    // The wait between rounds is at most tickMs, so a much longer one means we were asleep.
    // (Measured from the end of the last round, so a slow round during an outage doesn't count.)
    if (lastTickEnd && now - lastTickEnd > cfg.tickMs + SLEEP_SLACK_MS) {
      graceUntil = now + RESUME_GRACE_MS;
      failStreak = 0;
      gatewayCheckedAt = 0; // likely a different network after waking
      addEvent(now, 'wake', `Woke from sleep (about ${fmtDur(now - lastTickEnd)} asleep)`);
    }

    const lastSample = samples.at(-1);
    if (!gateway || now - gatewayCheckedAt > GATEWAY_REFRESH_MS || lastSample?.g === null) {
      const [route, tunnel] = await Promise.all([findGateway(), routeInterface(cfg.pingHost)]);
      noteRoute(now, route?.gateway ?? null, route?.iface ?? null, isTunnel(tunnel) ? tunnel : null);
      gatewayCheckedAt = now;
    }

    const [g, n, d] = await Promise.all([
      gateway ? ping(gateway, 1000) : Promise.resolve(null),
      ping(cfg.pingHost, 1500),
      dnsCheck(cfg.dnsZone, 1500),
    ]);

    // Run the web check on its routine interval, to confirm a failed ping or DNS lookup
    // (some networks block ping), and on every round until a failing web check passes again.
    const runHttp = now - lastHttpAt >= cfg.httpEveryMs || n === null || d === null
      || (lastHttp !== null && (lastHttp.ms === null || lastHttp.portal));
    let h: HttpResult | null = null;
    if (runHttp) {
      h = await httpCheck(cfg.httpUrl, 4000);
      lastHttp = h;
      lastHttpAt = now;
    }

    const judged = judgeNetwork({ hasGateway: gateway !== null, g, n, d, h, lastHttp, failStreak, inGrace: now < graceUntil });
    failStreak = judged.failStreak;

    const sample: Sample = { t: now, s: judged.s, n, d };
    if (gateway) sample.g = g;
    if (h) sample.h = h.ms;
    if (h?.portal) sample.p = 1;
    if (judged.r) sample.r = judged.r;
    // A working connection can still be lossy, jittery or slow under load.
    if (sample.s === 'up') {
      const quality = linkQuality([...sliceFrom(samples, now - QUALITY.baselineMs), sample], sliceFrom(machineSamples, now - QUALITY.loadedMs), now);
      if (quality.q) {
        sample.s = 'warn';
        sample.r = quality.r;
        sample.q = quality.q;
      }
    }

    if (sample.s !== lastSample?.s) logChange(sample);
    tell(notifier?.network(sample));
    samples.push(sample);
    samples = dropOlderThan(samples, now - HISTORY_MS);

    emit('sample', { sample, ...link() });
    await persist(cfg.dataDir, sample);
  }

  // Records a change of router, interface or VPN as an event, then remembers the new route.
  function noteRoute(now: number, nextGateway: string | null, nextIface: string | null, nextVpn: string | null): void {
    const desc = describeNetwork(nextGateway, nextIface, nextVpn);
    if (!routeKnown) addEvent(now, 'start', `Monitor started: ${desc}`);
    else if (nextGateway !== gateway || nextIface !== gatewayIface) {
      addEvent(now, 'net', !nextGateway ? 'Network lost: no router' : gateway ? `Network changed: ${desc}` : `Joined a network: ${desc}`);
    } else if (nextVpn !== vpn) addEvent(now, 'vpn', nextVpn ? `VPN on (${nextVpn})` : 'VPN off');
    routeKnown = true;
    gateway = nextGateway;
    gatewayIface = nextIface;
    vpn = nextVpn;
  }

  function addEvent(t: number, k: MonitorEvent['k'], text: string): void {
    const ev: MonitorEvent = { t, k, text };
    events.push(ev);
    events = dropOlderThan(events, t - HISTORY_MS);
    console.log(`${new Date(t).toLocaleTimeString()}  ${text}`);
    emit('event', ev);
    void persist(cfg.dataDir, ev, EVENTS);
  }

  // What the page shows about the current route.
  const link = () => ({ gateway, iface: gatewayIface, vpn, hotspot: isPhoneHotspot(gateway) });

  function tell(note: Note | null | undefined): void {
    if (!note) return;
    console.log(`${new Date().toLocaleTimeString()}  NOTIFIED  ${note.title}: ${note.body}`);
    send(note);
  }

  function logChange(x: Sample): void {
    const label = { up: 'ONLINE ', warn: 'DEGRADED', down: 'OFFLINE' }[x.s];
    console.log(`${new Date(x.t).toLocaleTimeString()}  ${label}  ${x.r ?? ''}`);
  }

  // ---------- machine health ----------

  const collector = createCollector(cfg.diskPath, cfg.machineMs);
  let machineSamples: MachineSample[] = [];
  let procs: Procs | null = null;

  async function machineTick(): Promise<void> {
    const now = Date.now();
    const [reading, top] = await Promise.all([
      collector.sample(gatewayIface, now),
      // Process lists are only for the page, so skip them while nobody is watching.
      viewers ? collector.procs(now) : Promise.resolve(null),
    ]);
    procs = top;

    const recent = machineSamples.filter((y) => y.t > now - cfg.machineWindowMs);
    const status = machineStatus([...recent, { t: now, ...reading }], cfg.machineWindowMs);
    const sample: MachineSample = { t: now, s: status.s, ...reading };
    if (status.r) sample.r = status.r;
    if (status.w) sample.w = status.w;

    if (sample.s !== machineSamples.at(-1)?.s) {
      console.log(`${new Date(now).toLocaleTimeString()}  ${sample.s === 'up' ? 'MACHINE OK  ' : 'MACHINE WARN'}  ${sample.r ?? ''}`);
    }
    tell(notifier?.machine(sample));
    machineSamples.push(sample);
    machineSamples = dropOlderThan(machineSamples, now - HISTORY_MS);

    emit('machine', { sample, procs });
    await persist(cfg.dataDir, sample, MACHINE);
  }

  // ---------- loops ----------

  // Runs fn every intervalMs, measured from the start of each run.
  function every(intervalMs: number, label: string, fn: () => Promise<void>, after?: () => void): void {
    const loop = async () => {
      const started = Date.now();
      try {
        await fn();
      } catch (err) {
        console.error(`${label} failed:`, err);
      }
      after?.();
      if (!stopped) timers.push(setTimeout(loop, Math.max(0, intervalMs - (Date.now() - started))));
    };
    loop();
  }

  return {
    start(): void {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const now = Date.now();
      if (cfg.notify) notifier = createNotifier(now, cfg.gapMs, cfg.machineGapMs);
      samples = loadRange<Sample>(cfg.dataDir, now - HISTORY_MS, now);
      events = loadRange<MonitorEvent>(cfg.dataDir, now - HISTORY_MS, now, EVENTS);
      machineSamples = loadRange<MachineSample>(cfg.dataDir, now - HISTORY_MS, now, MACHINE);
      pruneOldFiles(cfg.dataDir, cfg.keepDays);
      const prune = setInterval(() => pruneOldFiles(cfg.dataDir, cfg.keepDays), 60 * 60 * 1000);
      prune.unref();
      timers.push(prune);
      every(cfg.tickMs, 'check round', tick, () => { lastTickEnd = Date.now(); });
      every(cfg.machineMs, 'machine check', machineTick);
    },
    stop(): void {
      stopped = true;
      for (const t of timers) clearTimeout(t);
    },
    // What a page gets when it connects: the settings it needs and the last 24 hours.
    init(): Snapshot {
      const config = {
        tickMs: cfg.tickMs, gapMs: cfg.gapMs, pingHost: cfg.pingHost, httpUrl: cfg.httpUrl, httpEveryMs: cfg.httpEveryMs,
        machineMs: cfg.machineMs, machineGapMs: cfg.machineGapMs, diskPath: cfg.diskPath,
      };
      return { config, ...link(), samples, events, machine: { samples: machineSamples, procs } };
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // How many pages are open. Process lists are only collected while one is.
    watching(n: number): void {
      viewers = n;
    },
  };
}

export type Monitor = ReturnType<typeof createMonitor>;
