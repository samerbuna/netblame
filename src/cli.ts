#!/usr/bin/env node
// is-it-me: says whether your connection, Wi-Fi, ISP, DNS or this machine is the problem.

import { execFile } from 'node:child_process';
import { loadConfig, VERSION, APP, PUBLIC_DIR } from './config.ts';
import type { Config } from './config.ts';
import { createMonitor } from './monitor.ts';
import { createServer } from './server.ts';

const HELP = `${APP} ${VERSION}: is it me, or the internet?

Usage:
  ${APP}            start monitoring and open the page (or just open it, if already running)
  ${APP} run        start monitoring without opening the page
  ${APP} --version
  ${APP} --help

Settings are environment variables, for example PORT=4322 ${APP}. See the README.`;

const url = (cfg: Config) => `http://localhost:${cfg.port}`;

function openPage(cfg: Config): void {
  // Only when someone is at a terminal; a login service has nobody to show the page to.
  if (!process.stdout.isTTY) return;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(opener, [url(cfg)], () => { /* no browser to open; the URL is printed anyway */ });
}

// True when an is-it-me server already answers on the port.
async function alreadyRunning(cfg: Config): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok && ((await res.json()) as { app?: string }).app === APP;
  } catch {
    return false;
  }
}

async function start(cfg: Config, open: boolean): Promise<void> {
  const monitor = createMonitor(cfg);
  const server = createServer(monitor, PUBLIC_DIR);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${cfg.port} is in use. Try: PORT=${cfg.port + 1} ${APP}`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`${APP} on ${url(cfg)}  (checks every ${cfg.tickMs / 1000}s, history in ${cfg.dataDir})`);
    monitor.start();
    if (open) openPage(cfg);
  });

  const shutdown = () => {
    monitor.stop();
    server.closeAllConnections();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const cmd = args[0];
  switch (cmd) {
    case undefined:
      if (await alreadyRunning(cfg)) {
        console.log(`${APP} is already running on ${url(cfg)}`);
        openPage(cfg);
        return;
      }
      return start(cfg, true);
    case 'run':
      return start(cfg, false);
    case '-v':
    case '--version':
      console.log(VERSION);
      return;
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
