import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heroAt, statusSince, sampleEnd, outages, uptime, fmtUptime, sliceFrom, median, percentile, jitter } from '../public/lib/status.js';

type S = 'up' | 'warn' | 'down';
const MIN = 60_000;
const at = (h: number, m: number) => (h * 60 + m) * MIN;
const cfg = { tickMs: 3000, gapMs: 16_000, machineGapMs: 30_000 };

// One sample every `step` ms from `from` to 10:10, skipping where skip(t) is true.
function series<T extends string>(step: number, fn: (t: number) => T, from = at(9, 30), skip = (_t: number) => false) {
  const out: { t: number; s: T }[] = [];
  for (let t = from; t <= at(10, 10); t += step) if (!skip(t)) out.push({ t, s: fn(t) });
  return out;
}
const net = (s: { t: number; s: S }[]) => s.map((x) => ({ ...x, n: 20, d: 10 }));
const clock = (t: number | null) => (t === null ? null : `${Math.floor(t / 3_600_000)}:${String(Math.floor(t / MIN) % 60).padStart(2, '0')}`);

test('heroAt: offline wins, a machine warning degrades an online network', () => {
  assert.equal(heroAt('down', 'warn'), 'down');
  assert.equal(heroAt('up', 'warn'), 'warn');
  assert.equal(heroAt('warn', 'up'), 'warn');
  assert.equal(heroAt('up', undefined), 'up');
});

test('statusSince: walks both records back to where the hero status began', () => {
  const cases: [string, (t: number) => S, (t: number) => 'up' | 'warn', string][] = [
    ['offline since 10:00, machine warn from 10:05', (t) => (t >= at(10, 0) ? 'down' : 'up'), (t) => (t >= at(10, 5) ? 'warn' : 'up'), '10:00'],
    ['net DNS warn since 10:00, machine warn cleared at 10:05', (t) => (t >= at(10, 0) ? 'warn' : 'up'), (t) => (t < at(10, 5) ? 'warn' : 'up'), '9:30'],
    ['net warn since 10:00, machine warn 9:50-10:05', (t) => (t >= at(10, 0) ? 'warn' : 'up'), (t) => (t >= at(9, 50) && t < at(10, 5) ? 'warn' : 'up'), '9:50'],
    ['all up, machine warn ended 10:05', () => 'up', (t) => (t >= at(9, 55) && t < at(10, 5) ? 'warn' : 'up'), '10:05'],
    ['all up, net warn ended 10:02', (t) => (t >= at(9, 58) && t < at(10, 2) ? 'warn' : 'up'), () => 'up', '10:02'],
    ['machine warn only, from 10:03', () => 'up', (t) => (t >= at(10, 3) ? 'warn' : 'up'), '10:03'],
  ];
  for (const [name, netFn, machFn, want] of cases) {
    const samples = net(series(3000, netFn));
    const machine = series(10_000, machFn);
    const status = heroAt(samples.at(-1)!.s, machine.at(-1)!.s);
    assert.equal(clock(statusSince(samples, machine, cfg, status)), want, name);
  }
});

test('statusSince: machine samples before a gap in the machine record count again', () => {
  // machine warn 8:00-8:30, no machine samples 9:00-9:05, all up since
  const samples = net(series(3000, () => 'up', at(7, 0)));
  const machine = series(10_000, (t) => (t >= at(8, 0) && t < at(8, 30) ? 'warn' : 'up'), at(7, 0), (t) => t >= at(9, 0) && t < at(9, 5));
  assert.equal(clock(statusSince(samples, machine, cfg, 'up')), '8:30');
});

test('statusSince: stops at a gap in the network record', () => {
  const samples = net(series(3000, () => 'up', at(9, 30), (t) => t > at(9, 40) && t < at(9, 50)));
  assert.equal(clock(statusSince(samples, [], cfg, 'up')), '9:50');
  assert.equal(statusSince([], [], cfg, 'up'), null);
});

test('sampleEnd: next sample, one round at a gap, now while running', () => {
  const s = net([{ t: 0, s: 'up' }, { t: 3000, s: 'up' }, { t: 60_000, s: 'up' }]);
  assert.equal(sampleEnd(s, 0, 99_000, cfg, true), 3000);
  assert.equal(sampleEnd(s, 1, 99_000, cfg, true), 6000);
  assert.equal(sampleEnd(s, 2, 99_000, cfg, true), 99_000);
  assert.equal(sampleEnd(s, 2, 99_000, cfg, false), 63_000);
});

test('outages: runs of down samples, split at gaps, with the commonest reason', () => {
  const s = net([
    { t: 0, s: 'up' },
    { t: 3000, s: 'down' }, { t: 6000, s: 'down' }, { t: 9000, s: 'up' },
    { t: 12_000, s: 'down' }, { t: 60_000, s: 'down' }, // a gap after 12s splits this run
  ]).map((x, i) => (x.s === 'down' ? { ...x, r: i === 2 ? 'B' : 'A' } : x));
  const list = outages(s, 61_000, cfg, true);
  assert.deepEqual(list.map((o) => [o.start, o.end, o.ongoing ?? false]), [[3000, 9000, false], [12_000, 15_000, false], [60_000, 61_000, true]]);
  assert.equal(list[0].reason, 'A'); // A and B tie at one each; the first counted wins
  assert.equal(outages(s, 61_000, cfg, false).at(-1)!.ongoing, false);
});

test('uptime: by time, from one sample before the window', () => {
  // up 0-30s, down 30-60s (10 samples), up again
  const s = net(Array.from({ length: 30 }, (_, i) => ({ t: i * 3000, s: (i >= 10 && i < 20 ? 'down' : 'up') as S })));
  const u = uptime(s, 0, 90_000, cfg, true);
  assert.equal(u.observedMs, 90_000);
  assert.equal(u.downMs, 30_000);
  assert.equal(u.checks, 30);
  // window starting mid-sample counts the part of the sample before it that runs into the window
  assert.equal(uptime(s, 31_500, 90_000, cfg, true).observedMs, 58_500);
  assert.equal(fmtUptime(90_000, 30_000), '66.7');
  assert.equal(fmtUptime(100_000, 1), '99.99'); // never rounds up to 100
  assert.equal(fmtUptime(100_000, 0), '100');
});

test('number helpers', () => {
  assert.deepEqual(sliceFrom([{ t: 1 }, { t: 5 }, { t: 9 }], 5), [{ t: 5 }, { t: 9 }]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1), 2);
  assert.equal(jitter([10, 20, 10, 20]), 10);
  assert.equal(jitter([5]), null);
});
