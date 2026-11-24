import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeNetwork, linkQuality, DOWN_AFTER } from '../src/netrules.ts';
import type { RoundInput } from '../src/netrules.ts';

const MINUTE = 60_000;
const ok = { ms: 50, portal: false };
const failed = { ms: null, portal: false };
const portal = { ms: null, portal: true };
const round = (x: Partial<RoundInput>): RoundInput => ({
  hasGateway: true, g: 2, n: 20, d: 10, h: null, lastHttp: ok, failStreak: 0, inGrace: false, ...x,
});

test('judgeNetwork: all passing is up', () => {
  assert.deepEqual(judgeNetwork(round({})), { s: 'up', failStreak: 0 });
});

test('judgeNetwork: a blocked ping with a passing web check is still up', () => {
  assert.equal(judgeNetwork(round({ n: null, h: ok, lastHttp: ok })).s, 'up');
});

test('judgeNetwork: confirms for one round, then names the cause', () => {
  const cases: [Partial<RoundInput>, string][] = [
    [{ hasGateway: false, g: null }, 'No network: Wi-Fi off or not joined'],
    [{ g: null }, 'Router not responding: Wi-Fi or router problem'],
    [{ g: 2 }, 'Router OK, nothing beyond it: modem or ISP problem'],
  ];
  for (const [x, reason] of cases) {
    const first = judgeNetwork(round({ ...x, n: null, h: failed, lastHttp: failed }));
    assert.equal(first.s, 'warn');
    assert.equal(first.r, `Checks failing, confirming… (${reason})`);
    const second = judgeNetwork(round({ ...x, n: null, h: failed, lastHttp: failed, failStreak: first.failStreak }));
    assert.equal(second.failStreak, DOWN_AFTER);
    assert.deepEqual([second.s, second.r], ['down', reason]);
  }
});

test('judgeNetwork: failures right after waking are "reconnecting", not an outage', () => {
  const r = judgeNetwork(round({ n: null, h: failed, lastHttp: failed, failStreak: 5, inGrace: true }));
  assert.deepEqual([r.s, r.r], ['warn', 'Reconnecting after sleep']);
});

test('judgeNetwork: portal, DNS and web failures are degraded', () => {
  assert.equal(judgeNetwork(round({ lastHttp: portal })).r, 'Web requests intercepted: captive portal or login page');
  assert.equal(judgeNetwork(round({ d: null })).r, 'DNS not answering');
  assert.equal(judgeNetwork(round({ lastHttp: failed })).r, 'Ping works but web requests fail');
  // a portal outranks DNS
  assert.equal(judgeNetwork(round({ d: null, lastHttp: portal })).r, 'Web requests intercepted: captive portal or login page');
});

test('judgeNetwork: a passing round resets the streak', () => {
  assert.equal(judgeNetwork(round({ failStreak: 4 })).failStreak, 0);
});

// ---------- linkQuality ----------

const NOW = 10_000_000;
// One round every 3s over the last `ms`, ending now; ping(i) gives each round's reply (null = lost).
function rounds(ms: number, ping: (i: number) => number | null, h: number | null = null) {
  const out: { t: number; n: number | null; h?: number | null }[] = [];
  const count = Math.floor(ms / 3000);
  for (let i = 0; i < count; i++) {
    const n = ping(i);
    // A lost ping triggers the web check on the same round.
    out.push(n === null ? { t: NOW - (count - 1 - i) * 3000, n, h: h ?? 40 } : { t: NOW - (count - 1 - i) * 3000, n });
  }
  return out;
}
const idle = [{ t: NOW - 5000, rx: 1000, tx: 1000 }];
const busy = [{ t: NOW - 5000, rx: 2_000_000, tx: 50_000 }];

test('linkQuality: a steady connection is fine', () => {
  assert.deepEqual(linkQuality(rounds(30 * MINUTE, () => 20), idle, NOW), {});
});

test('linkQuality: loss needs 3 lost pings and 10% while the web check passes', () => {
  assert.deepEqual(linkQuality(rounds(MINUTE, (i) => (i % 7 === 0 ? null : 20)), idle, NOW).q, ['loss']); // 3 of 20
  assert.deepEqual(linkQuality(rounds(MINUTE, (i) => (i % 10 === 0 ? null : 20)), idle, NOW), {}); // 2 of 20
  assert.match(linkQuality(rounds(MINUTE, (i) => (i % 7 === 0 ? null : 20)), idle, NOW).r!, /Losing pings \(3 of 20 in the last minute\)/);
});

test('linkQuality: ping blocked everywhere, or not enough history, is not judged', () => {
  assert.deepEqual(linkQuality(rounds(MINUTE, () => null), idle, NOW), {});
  assert.deepEqual(linkQuality(rounds(30_000, (i) => (i % 2 ? null : 20)), idle, NOW), {}); // only 30s covered
});

test('linkQuality: jitter above 30 ms', () => {
  assert.deepEqual(linkQuality(rounds(MINUTE, (i) => (i % 2 ? 20 : 60)), idle, NOW).q, ['jitter']);
  assert.match(linkQuality(rounds(MINUTE, (i) => (i % 2 ? 20 : 60)), idle, NOW).r!, /Unstable ping \(jitter 40 ms\)/);
  assert.deepEqual(linkQuality(rounds(MINUTE, (i) => (i % 2 ? 20 : 45)), idle, NOW), {});
});

test('linkQuality: bufferbloat is ping well above normal while busy', () => {
  // normal 20 ms for 30 minutes, then 300 ms for the last 30s
  const history = rounds(30 * MINUTE, (i, n = Math.floor((30 * MINUTE) / 3000)) => (i >= n - 10 ? 300 : 20));
  const r = linkQuality(history, busy, NOW);
  assert.deepEqual(r.q, ['bloat']); // jitter isn't reported on top
  assert.equal(r.r, 'Slow under load: ping 300 ms while the connection is busy (normally 20 ms)');
  // the same pings with an idle connection are just slow, not bloat
  assert.equal(linkQuality(history, idle, NOW).q?.includes('bloat'), undefined);
  // too little history to know what normal is
  assert.deepEqual(linkQuality(rounds(45_000, () => 300), busy, NOW).q, undefined);
});
