import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server.ts';
import { PUBLIC_DIR, VERSION } from '../src/config.ts';

let viewers = -1;
let emit: (event: string, data: unknown) => void = () => {};
const source = {
  init: () => ({ config: { tickMs: 3000 }, samples: [{ t: 1, s: 'up' }] }),
  subscribe(fn: (event: string, data: unknown) => void) {
    emit = fn;
    return () => {};
  },
  watching(n: number) {
    viewers = n;
  },
  report: (days: number) => `report for ${days} days\n`,
};

const server = createServer(source, PUBLIC_DIR);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
after(() => {
  server.closeAllConnections();
  server.close();
});

// Raw requests, since fetch won't let us set Host.
function get(pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('rejects other Host headers', async () => {
  assert.equal((await get('/', { host: `evil.example:${port}` })).status, 403);
  assert.equal((await get('/', { host: 'localhost:1' })).status, 403);
  assert.equal((await get('/health', { host: `127.0.0.1:${port}` })).status, 200);
});

test('serves the page files from the allowlist only', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /<title>Is it me\?<\/title>/);
  assert.match((await get('/app.js')).type, /text\/javascript/);
  assert.match((await get('/style.css')).type, /text\/css/);
  assert.equal((await get('/lib/status.js')).status, 200);
  // (/lib/../app.js is just /app.js once the URL is normalized, so it isn't a traversal.)
  for (const p of ['/lib/..%2f..%2fpackage.json', '/lib/%2e%2e/package.json', '/../package.json', '/index.html', '/lib/missing.js', '/package.json']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('health names the app and version', async () => {
  assert.deepEqual(JSON.parse((await get('/health')).body), { app: 'is-it-me', version: VERSION });
});

test('events: init first, then what the monitor emits, and counts viewers', async () => {
  const chunks: string[] = [];
  const req = http.request({ host: '127.0.0.1', port, path: '/events', headers: { host: `localhost:${port}` } });
  const res = await new Promise<http.IncomingMessage>((resolve) => req.on('response', resolve).end());
  res.setEncoding('utf8');
  const got = (re: RegExp) => new Promise<void>((resolve) => {
    const check = () => (re.test(chunks.join('')) ? resolve() : res.once('data', (c) => { chunks.push(c); check(); }));
    check();
  });
  await got(/event: init\ndata: (.*)\n\n/);
  const init = JSON.parse(/event: init\ndata: (.*)\n\n/.exec(chunks.join(''))![1]);
  assert.deepEqual(init, source.init());
  assert.equal(viewers, 1);
  emit('sample', { x: 1 });
  await got(/event: sample\ndata: \{"x":1\}\n\n/);
  req.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(viewers, 0);
});

test('report: plain text, days clamped to 1-31', async () => {
  const r = await get('/report?days=3');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/plain/);
  assert.equal(r.body, 'report for 3 days\n');
  assert.equal((await get('/report?days=400')).body, 'report for 31 days\n');
  assert.equal((await get('/report?days=abc')).body, 'report for 7 days\n');
  assert.equal((await get('/report')).body, 'report for 7 days\n');
});
