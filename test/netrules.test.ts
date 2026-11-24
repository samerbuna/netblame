import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeNetwork, DOWN_AFTER } from '../src/netrules.ts';
import type { RoundInput } from '../src/netrules.ts';

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
