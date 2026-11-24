// The local web server: the page and its scripts, and a Server-Sent Events stream of results.
// It listens on 127.0.0.1 only.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { APP, VERSION } from './config.ts';

// What the server needs from the monitor. Tests pass a fake.
export interface Source {
  // The SSE init payload: settings for the page, and everything it shows on load.
  init(): Record<string, unknown>;
  subscribe(fn: (event: string, data: unknown) => void): () => void;
  watching(n: number): void;
  report(days: number): string; // plain-text outage report
  speedTest(): 'started' | 'running' | 'unavailable';
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// URL path -> file in publicDir. Only these are served; no path is built from the request.
function staticFiles(publicDir: string): Map<string, string> {
  const files = new Map([['/', 'index.html'], ['/style.css', 'style.css'], ['/app.js', 'app.js']]);
  let lib: string[] = [];
  try {
    lib = fs.readdirSync(path.join(publicDir, 'lib'));
  } catch {
    // no lib folder; the page will fail to load its modules and say so in the console
  }
  for (const f of lib) if (/^[a-z-]+\.js$/.test(f)) files.set(`/lib/${f}`, `lib/${f}`);
  return files;
}

export function createServer(source: Source, publicDir: string): http.Server {
  const files = staticFiles(publicDir);
  const clients = new Set<ServerResponse>();

  source.subscribe((event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  });

  const server = http.createServer(handle);

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // Reject other Host headers so a web page can't reach this through DNS rebinding.
    const port = (server.address() as AddressInfo | null)?.port;
    const host = req.headers.host ?? '';
    if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);

    // A page on any site can send a POST to localhost (the Host header is then right), so actions
    // that cost something, like a speed test that moves hundreds of MB, also need this page's Origin.
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (url.pathname === '/speedtest') {
        const result = source.speedTest();
        json(res, result === 'started' ? 202 : result === 'running' ? 409 : 404, { result });
        return;
      }
    }

    if (req.method === 'GET' && files.has(url.pathname)) {
      const file = files.get(url.pathname)!;
      fs.readFile(path.join(publicDir, file), (err, body) => {
        if (err) {
          res.writeHead(500).end(`${file} missing`);
          return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' }).end(body);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/report') {
      const days = Math.min(31, Math.max(1, Math.round(Number(url.searchParams.get('days')) || 7)));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(source.report(days));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { app: APP, version: VERSION });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`retry: 2000\nevent: init\ndata: ${JSON.stringify(source.init())}\n\n`);
      clients.add(res);
      source.watching(clients.size);
      req.on('close', () => {
        clients.delete(res);
        source.watching(clients.size);
      });
      return;
    }

    res.writeHead(404).end('Not found');
  }

  return server;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}
