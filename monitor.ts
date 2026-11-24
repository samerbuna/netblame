// Internet connection monitor.
// Runs layered checks every few seconds (router ping, internet ping, uncached DNS,
// HTTP 204) and streams the results to index.html over Server-Sent Events.
//
// Run: node monitor.ts   (Node ^22.18 or >=23.6 runs TypeScript directly, no build step)

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCollector, machineStatus, C_ENV, WINDOW_MS } from './machine.ts';
import type { MachineSample, Procs } from './machine.ts';

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const PORT = envNum('PORT', 4321);
const TICK_MS = envNum('TICK_MS', 3000);
const KEEP_DAYS = envNum('KEEP_DAYS', 7);
const PING_HOST = process.env.PING_HOST ?? '1.1.1.1';
const HTTP_URL = process.env.HTTP_URL ?? 'http://cp.cloudflare.com/generate_204';
// Each DNS check asks for a random name under this zone, so no cache can answer it.
const DNS_ZONE = process.env.DNS_ZONE ?? 'example.com';
const MACHINE_MS = envNum('MACHINE_MS', 10_000); // time between machine health samples
const DISK_PATH = process.env.DISK_PATH ?? '/';  // free space is watched on the volume holding this path

const HTTP_EVERY_MS = 30_000;          // routine web check; it also runs whenever another check fails
const GATEWAY_REFRESH_MS = 30_000;
const HISTORY_MS = 24 * 60 * 60 * 1000; // what the page gets on connect
// A longer pause between samples means the machine slept or the monitor was stopped.
// One round can take ~8s when everything times out, so leave room for that.
const GAP_MS = TICK_MS * 2 + 10_000;
const SLEEP_SLACK_MS = 5000;            // the wait between rounds overran by this much: the machine slept
const RESUME_GRACE_MS = 20_000;         // Wi-Fi takes a few seconds to rejoin after sleep; don't call that an outage
const DOWN_AFTER = 2;                   // consecutive failed ticks before we say "down"
const MACHINE_GAP_MS = MACHINE_MS * 2 + 10_000;

const HERE = import.meta.dirname;
const DATA_DIR = path.join(HERE, 'data');
const PAGE = path.join(HERE, 'index.html');

type Ms = number | null; // round-trip in ms, or null when the check failed
type Status = 'up' | 'warn' | 'down';

interface Sample {
  t: number;    // epoch ms
  s: Status;
  g?: Ms;       // router ping (absent when the router address is unknown)
  n: Ms;        // internet ping
  d: Ms;        // DNS lookup
  h?: Ms;       // HTTP 204 check (only on ticks where it ran)
  p?: 1;        // HTTP check got something other than 204: captive portal or interception
  r?: string;   // why, when status is not "up"
}

// ---------- checks ----------

const round = (x: number) => Math.round(x * 10) / 10;

function ping(host: string, timeoutMs: number): Promise<Ms> {
  // -n: no reverse DNS, so the ping doesn't depend on DNS.
  // -W is milliseconds on macOS, whole seconds on Linux.
  const wait = process.platform === 'darwin' ? String(timeoutMs) : String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return new Promise((resolve) => {
    // C_ENV sets LC_ALL=C: a localized ping (iputils on Linux) can print "Zeit=" or "12,3 ms", which the regex would miss.
    execFile('ping', ['-c', '1', '-n', '-W', wait, host], { timeout: timeoutMs + 1000, env: C_ENV }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /time[=<]([\d.]+)\s*ms/.exec(stdout);
      resolve(m ? round(Number(m[1])) : null);
    });
  });
}

async function dnsCheck(timeoutMs: number): Promise<Ms> {
  // A fresh Resolver picks up the current DNS servers after a network change.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const name = `${randomBytes(6).toString('hex')}.${DNS_ZONE}`;
  const t0 = performance.now();
  try {
    await resolver.resolve4(name);
  } catch (err) {
    // "No such name" / "no A record" is still an answer from a working DNS server.
    const code = (err as { code?: string }).code;
    if (code !== 'ENOTFOUND' && code !== 'ENODATA') return null;
  }
  return round(performance.now() - t0);
}

interface HttpResult { ms: Ms; portal: boolean }

function httpCheck(timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: HttpResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const t0 = performance.now();
    // agent: false opens a fresh connection each time, so a stale keep-alive socket can't hide a problem.
    const req = http.get(HTTP_URL, { agent: false, headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      const ok = code === 204;
      // A page or redirect instead of the empty 204 means something intercepted the request.
      // A 5xx is the check server failing, which is a failed check, not a portal,
      // except 511 (Network Authentication Required), the status meant for portals.
      finish({ ms: ok ? round(performance.now() - t0) : null, portal: !ok && (code < 500 || code === 511) });
    });
    req.on('error', () => finish({ ms: null, portal: false }));
    const timer = setTimeout(() => finish({ ms: null, portal: false }), timeoutMs);
  });
}

interface Route { gateway: string; iface: string | null }

// Runs cmd and returns the router address (group 1) and the interface it's reached on (group 2).
function findRoute(cmd: string, args: string[], re: RegExp): Promise<Route | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, env: C_ENV }, (err, stdout) => {
      if (err) return resolve(null);
      const m = re.exec(stdout);
      if (!m) return resolve(null);
      // An interface name starts with a letter; anything else means the columns weren't what we expected.
      resolve({ gateway: m[1], iface: /^[a-z]/i.test(m[2] ?? '') ? m[2] : null });
    });
  });
}

async function findGateway(): Promise<Route | null> {
  if (process.platform !== 'darwin') {
    return findRoute('ip', ['-4', 'route', 'show', 'default'], /default via (\d+\.\d+\.\d+\.\d+)(?: dev (\S+))?/);
  }
  // A VPN that takes over the default route points it at a tunnel interface with no gateway.
  // The physical router's default route is still in the table, scoped to its interface.
  return await findRoute('route', ['-n', 'get', 'default'], /gateway:\s*(\d+\.\d+\.\d+\.\d+)[\s\S]*?interface:\s*(\S+)/)
    ?? findRoute('netstat', ['-rn', '-f', 'inet'], /^default\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\S+)/m);
}

// ---------- monitor state ----------

let samples: Sample[] = [];
let gateway: string | null = null;
let gatewayIface: string | null = null; // where throughput is measured
let gatewayCheckedAt = 0;
let lastHttp: HttpResult | null = null;
let lastHttpAt = 0;
let lastTickEnd = 0;
let failStreak = 0;
let graceUntil = 0;

async function tick(): Promise<void> {
  const now = Date.now();
  // The wait between rounds is at most TICK_MS, so a much longer one means we were asleep.
  // (Measured from the end of the last round, so a slow round during an outage doesn't count.)
  if (lastTickEnd && now - lastTickEnd > TICK_MS + SLEEP_SLACK_MS) {
    graceUntil = now + RESUME_GRACE_MS;
    failStreak = 0;
    gatewayCheckedAt = 0; // likely a different network after waking
  }

  const lastSample = samples.at(-1);
  if (!gateway || now - gatewayCheckedAt > GATEWAY_REFRESH_MS || lastSample?.g === null) {
    const route = await findGateway();
    gateway = route?.gateway ?? null;
    gatewayIface = route?.iface ?? null;
    gatewayCheckedAt = now;
  }

  const [g, n, d] = await Promise.all([
    gateway ? ping(gateway, 1000) : Promise.resolve(null),
    ping(PING_HOST, 1500),
    dnsCheck(1500),
  ]);

  // Run the web check on its routine interval, to confirm a failed ping or DNS lookup
  // (some networks block ping), and on every tick until a failing web check passes again.
  const runHttp = now - lastHttpAt >= HTTP_EVERY_MS || n === null || d === null
    || (lastHttp !== null && (lastHttp.ms === null || lastHttp.portal));
  let h: HttpResult | null = null;
  if (runHttp) {
    h = await httpCheck(4000);
    lastHttp = h;
    lastHttpAt = now;
  }

  const internetOk = n !== null || (h !== null && h.ms !== null);
  failStreak = internetOk ? 0 : failStreak + 1;

  let s: Status = 'up';
  let r: string | undefined;
  if (!internetOk) {
    if (!gateway) r = 'No network: Wi-Fi off or not joined';
    else if (g === null) r = 'Router not responding: Wi-Fi or router problem';
    else r = 'Router OK, nothing beyond it: modem or ISP problem';
    if (now < graceUntil) {
      s = 'warn';
      r = 'Reconnecting after sleep';
    } else if (failStreak < DOWN_AFTER) {
      s = 'warn';
      r = `Checks failing, confirming… (${r})`;
    } else {
      s = 'down';
    }
  } else if (lastHttp?.portal) {
    s = 'warn';
    r = 'Web requests intercepted: captive portal or login page';
  } else if (d === null) {
    s = 'warn';
    r = 'DNS not answering';
  } else if (lastHttp && lastHttp.ms === null) {
    s = 'warn';
    r = 'Ping works but web requests fail';
  }

  const sample: Sample = { t: now, s, n, d };
  if (gateway) sample.g = g;
  if (h) sample.h = h.ms;
  if (h?.portal) sample.p = 1;
  if (r) sample.r = r;

  if (s !== lastSample?.s) logChange(sample);
  samples.push(sample);
  samples = dropOlderThan(samples, now - HISTORY_MS);

  broadcast('sample', { sample, gateway });
  await persist(sample);
}

function logChange(x: Sample): void {
  const label = { up: 'ONLINE ', warn: 'DEGRADED', down: 'OFFLINE' }[x.s];
  console.log(`${new Date(x.t).toLocaleTimeString()}  ${label}  ${x.r ?? ''}`);
}

// ---------- machine health ----------

const collector = createCollector(DISK_PATH, MACHINE_MS);
let machineSamples: MachineSample[] = [];
let procs: Procs | null = null;

async function machineTick(): Promise<void> {
  const now = Date.now();
  const [reading, top] = await Promise.all([
    collector.sample(gatewayIface, now),
    // Process lists are only for the page, so skip them while nobody is watching.
    clients.size ? collector.procs(now) : Promise.resolve(null),
  ]);
  procs = top;

  const recent = machineSamples.filter((y) => y.t > now - WINDOW_MS);
  const status = machineStatus([...recent, { t: now, ...reading }]);
  const sample: MachineSample = { t: now, s: status.s, ...reading };
  if (status.r) sample.r = status.r;
  if (status.w) sample.w = status.w;

  if (sample.s !== machineSamples.at(-1)?.s) {
    console.log(`${new Date(now).toLocaleTimeString()}  ${sample.s === 'up' ? 'MACHINE OK  ' : 'MACHINE WARN'}  ${sample.r ?? ''}`);
  }
  machineSamples.push(sample);
  machineSamples = dropOlderThan(machineSamples, now - HISTORY_MS);

  broadcast('machine', { sample, procs });
  await persist(sample, MACHINE_SUFFIX);
}

async function machineLoop(): Promise<void> {
  const started = Date.now();
  try {
    await machineTick();
  } catch (err) {
    console.error('machine check failed:', err);
  }
  setTimeout(machineLoop, Math.max(0, MACHINE_MS - (Date.now() - started)));
}

async function loop(): Promise<void> {
  const started = Date.now();
  try {
    await tick();
  } catch (err) {
    console.error('check round failed:', err);
  }
  lastTickEnd = Date.now();
  setTimeout(loop, Math.max(0, TICK_MS - (Date.now() - started)));
}

// ---------- history on disk: one JSON line per sample, one file per local day ----------

// Network samples go to YYYY-MM-DD.jsonl, machine samples to YYYY-MM-DD.machine.jsonl.
const FILE_RE = /^(\d{4}-\d{2}-\d{2})(\.machine)?\.jsonl$/;
const MACHINE_SUFFIX = '.machine';

function dayStamp(t: number): string {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const dayName = (t: number, suffix = '') => `${dayStamp(t)}${suffix}.jsonl`;

async function persist(x: { t: number }, suffix = ''): Promise<void> {
  try {
    await fs.promises.appendFile(path.join(DATA_DIR, dayName(x.t, suffix)), JSON.stringify(x) + '\n');
  } catch (err) {
    console.error('could not save sample:', (err as Error).message);
  }
}

function loadHistory<T extends { t: number }>(suffix = ''): T[] {
  const now = Date.now();
  const files = [...new Set([dayName(now - HISTORY_MS, suffix), dayName(now, suffix)])];
  const loaded: T[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const x = JSON.parse(line) as T;
        if (typeof x.t === 'number' && x.t >= now - HISTORY_MS) loaded.push(x);
      } catch {
        // a half-written last line from a crash; skip it
      }
    }
  }
  return loaded.sort((a, b) => a.t - b.t);
}

function dropOlderThan<T extends { t: number }>(list: T[], cutoff: number): T[] {
  let drop = 0;
  while (drop < list.length && list[drop].t < cutoff) drop++;
  return drop ? list.slice(drop) : list;
}

function pruneOldFiles(): void {
  // Only touches files this script wrote: data/YYYY-MM-DD[.machine].jsonl older than KEEP_DAYS.
  const oldest = dayStamp(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = FILE_RE.exec(f);
    if (m && m[1] < oldest) {
      try {
        fs.unlinkSync(path.join(DATA_DIR, f));
      } catch (err) {
        console.error(`could not remove ${f}:`, (err as Error).message);
      }
    }
  }
}

// ---------- web server (localhost only) ----------

const clients = new Set<ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function handle(req: IncomingMessage, res: ServerResponse): void {
  // Reject other Host headers so a web page can't reach this through DNS rebinding.
  if (!allowedHosts.has(req.headers.host ?? '')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    fs.readFile(PAGE, (err, body) => {
      if (err) {
        res.writeHead(500).end('index.html missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const config = {
      tickMs: TICK_MS, gapMs: GAP_MS, pingHost: PING_HOST, httpUrl: HTTP_URL, httpEveryMs: HTTP_EVERY_MS,
      machineMs: MACHINE_MS, machineGapMs: MACHINE_GAP_MS, diskPath: DISK_PATH,
    };
    const machine = { samples: machineSamples, procs };
    res.write(`retry: 2000\nevent: init\ndata: ${JSON.stringify({ config, gateway, samples, machine })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404).end('Not found');
}

// ---------- start ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
samples = loadHistory<Sample>();
machineSamples = loadHistory<MachineSample>(MACHINE_SUFFIX);
pruneOldFiles();
setInterval(pruneOldFiles, 60 * 60 * 1000).unref();

const server = http.createServer(handle);
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Try: PORT=4322 node monitor.ts`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Net monitor on http://localhost:${PORT}  (checks every ${TICK_MS / 1000}s, history in ${DATA_DIR})`);
  loop();
  machineLoop();
});

function shutdown(): void {
  for (const c of clients) c.end();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
