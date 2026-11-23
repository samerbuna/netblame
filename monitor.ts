// Internet connection monitor.
// Runs layered checks every few seconds (router ping, internet ping, uncached DNS,
// HTTP 204) and streams the results to index.html over Server-Sent Events.
//
// Run: node monitor.ts   (Node 22.18+ runs TypeScript directly, no build step)

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

const HTTP_EVERY_MS = 30_000;          // routine web check; it also runs whenever another check fails
const GATEWAY_REFRESH_MS = 30_000;
const HISTORY_MS = 24 * 60 * 60 * 1000; // what the page gets on connect
// A longer pause between samples means the machine slept or the monitor was stopped.
// One round can take ~8s when everything times out, so leave room for that.
const GAP_MS = TICK_MS * 2 + 10_000;
const SLEEP_SLACK_MS = 5000;            // the wait between rounds overran by this much: the machine slept
const RESUME_GRACE_MS = 20_000;         // Wi-Fi takes a few seconds to rejoin after sleep; don't call that an outage
const DOWN_AFTER = 2;                   // consecutive failed ticks before we say "down"

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
    // LC_ALL=C: a localized ping (iputils on Linux) can print "Zeit=" or "12,3 ms", which the regex would miss.
    const env = { ...process.env, LC_ALL: 'C' };
    execFile('ping', ['-c', '1', '-n', '-W', wait, host], { timeout: timeoutMs + 1000, env }, (err, stdout) => {
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
      const ok = res.statusCode === 204;
      finish({ ms: ok ? round(performance.now() - t0) : null, portal: !ok });
    });
    req.on('error', () => finish({ ms: null, portal: false }));
    const timer = setTimeout(() => finish({ ms: null, portal: false }), timeoutMs);
  });
}

function firstMatch(cmd: string, args: string[], re: RegExp): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = re.exec(stdout);
      resolve(m ? m[1] : null);
    });
  });
}

async function findGateway(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return firstMatch('ip', ['-4', 'route', 'show', 'default'], /default via (\d+\.\d+\.\d+\.\d+)/);
  }
  // A VPN that takes over the default route points it at a tunnel interface with no gateway.
  // The physical router's default route is still in the table, scoped to its interface.
  return await firstMatch('route', ['-n', 'get', 'default'], /gateway:\s*(\d+\.\d+\.\d+\.\d+)/)
    ?? firstMatch('netstat', ['-rn', '-f', 'inet'], /^default\s+(\d+\.\d+\.\d+\.\d+)\s/m);
}

// ---------- monitor state ----------

let samples: Sample[] = [];
let gateway: string | null = null;
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
    gateway = await findGateway();
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
  const cutoff = now - HISTORY_MS;
  let drop = 0;
  while (drop < samples.length && samples[drop].t < cutoff) drop++;
  if (drop) samples = samples.slice(drop);

  broadcast('sample', { sample, gateway });
  await persist(sample);
}

function logChange(x: Sample): void {
  const label = { up: 'ONLINE ', warn: 'DEGRADED', down: 'OFFLINE' }[x.s];
  console.log(`${new Date(x.t).toLocaleTimeString()}  ${label}  ${x.r ?? ''}`);
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

const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function dayName(t: number): string {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
}

async function persist(x: Sample): Promise<void> {
  try {
    await fs.promises.appendFile(path.join(DATA_DIR, dayName(x.t)), JSON.stringify(x) + '\n');
  } catch (err) {
    console.error('could not save sample:', (err as Error).message);
  }
}

function loadHistory(): void {
  const now = Date.now();
  const files = [...new Set([dayName(now - HISTORY_MS), dayName(now)])];
  const loaded: Sample[] = [];
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
        const x = JSON.parse(line) as Sample;
        if (typeof x.t === 'number' && x.t >= now - HISTORY_MS) loaded.push(x);
      } catch {
        // a half-written last line from a crash; skip it
      }
    }
  }
  samples = loaded.sort((a, b) => a.t - b.t);
}

function pruneOldFiles(): void {
  // Only touches files this script wrote: data/YYYY-MM-DD.jsonl older than KEEP_DAYS.
  const oldest = dayName(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (FILE_RE.test(f) && f < oldest) {
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
    const config = { tickMs: TICK_MS, gapMs: GAP_MS, pingHost: PING_HOST, httpUrl: HTTP_URL, httpEveryMs: HTTP_EVERY_MS };
    res.write(`retry: 2000\nevent: init\ndata: ${JSON.stringify({ config, gateway, samples })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404).end('Not found');
}

// ---------- start ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
loadHistory();
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
});

function shutdown(): void {
  for (const c of clients) c.end();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
