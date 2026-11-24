// The network checks: ping, an uncached DNS lookup, an HTTP 204 fetch, and finding the router.

import http from 'node:http';
import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { run } from './exec.ts';

export type Ms = number | null; // round-trip in ms, or null when the check failed

const round = (x: number) => Math.round(x * 10) / 10;

// The round-trip from one ping's output, or null when there was no reply.
export function parsePing(stdout: string): Ms {
  const m = /time[=<]([\d.]+)\s*ms/.exec(stdout);
  return m ? round(Number(m[1])) : null;
}

export async function ping(host: string, timeoutMs: number): Promise<Ms> {
  // -n: no reverse DNS, so the ping doesn't depend on DNS.
  // -W is milliseconds on macOS, whole seconds on Linux.
  const wait = process.platform === 'darwin' ? String(timeoutMs) : String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  // run() sets LC_ALL=C: a localized ping (iputils on Linux) can print "Zeit=" or "12,3 ms", which the regex would miss.
  const out = await run('ping', ['-c', '1', '-n', '-W', wait, host], timeoutMs + 1000);
  return out === null ? null : parsePing(out);
}

export async function dnsCheck(zone: string, timeoutMs: number): Promise<Ms> {
  // A fresh Resolver picks up the current DNS servers after a network change.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const name = `${randomBytes(6).toString('hex')}.${zone}`;
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

export interface HttpResult { ms: Ms; portal: boolean }

export function httpCheck(url: string, timeoutMs: number): Promise<HttpResult> {
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
    const req = http.get(url, { agent: false, headers: { 'Cache-Control': 'no-cache' } }, (res) => {
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

export interface Route { gateway: string; iface: string | null }

// Group 1 is the router address, group 2 the interface it's reached on.
export const ROUTE_RE = {
  linux: /default via (\d+\.\d+\.\d+\.\d+)(?: dev (\S+))?/,
  macRoute: /gateway:\s*(\d+\.\d+\.\d+\.\d+)[\s\S]*?interface:\s*(\S+)/,
  macNetstat: /^default\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\S+)/m,
};

export function parseRoute(stdout: string, re: RegExp): Route | null {
  const m = re.exec(stdout);
  if (!m) return null;
  // An interface name starts with a letter; anything else means the columns weren't what we expected.
  return { gateway: m[1], iface: /^[a-z]/i.test(m[2] ?? '') ? m[2] : null };
}

async function findRoute(cmd: string, args: string[], re: RegExp): Promise<Route | null> {
  const out = await run(cmd, args, 2000);
  return out === null ? null : parseRoute(out, re);
}

export async function findGateway(): Promise<Route | null> {
  if (process.platform !== 'darwin') return findRoute('ip', ['-4', 'route', 'show', 'default'], ROUTE_RE.linux);
  // A VPN that takes over the default route points it at a tunnel interface with no gateway.
  // The physical router's default route is still in the table, scoped to its interface.
  return await findRoute('route', ['-n', 'get', 'default'], ROUTE_RE.macRoute)
    ?? findRoute('netstat', ['-rn', '-f', 'inet'], ROUTE_RE.macNetstat);
}
