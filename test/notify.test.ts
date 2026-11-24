import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, NOTIFY } from '../src/notify.ts';
import type { Note } from '../src/notify.ts';

const START = 1_000_000;
const AFTER_QUIET = START + NOTIFY.quietStartMs;
type Net = { s: 'up' | 'warn' | 'down'; r?: string };

// Feeds one network sample every 3s from `from`, returns the notes with their times.
function feed(n: ReturnType<typeof createNotifier>, from: number, steps: [count: number, x: Net][]) {
  const notes: [number, Note][] = [];
  let t = from;
  for (const [count, x] of steps) {
    for (let i = 0; i < count; i++, t += 3000) {
      const note = n.network({ t, ...x });
      if (note) notes.push([t - from, note]);
    }
  }
  return notes;
}
const fresh = () => createNotifier(START, 16_000, 30_000);

test('offline right away, back online with how long it lasted', () => {
  const notes = feed(fresh(), AFTER_QUIET, [[5, { s: 'up' }], [20, { s: 'down', r: 'Router OK, nothing beyond it: modem or ISP problem' }], [2, { s: 'up' }]]);
  assert.deepEqual(notes, [
    [15_000, { title: 'Offline', body: 'Router OK, nothing beyond it: modem or ISP problem' }],
    [75_000, { title: 'Back online', body: 'Offline for 1m 00s' }],
  ]);
});

test('nothing during the quiet start, and no "back online" for an outage never reported', () => {
  assert.deepEqual(feed(fresh(), START, [[5, { s: 'down', r: 'x' }], [5, { s: 'up' }]]), []);
});

test('an outage that began during the quiet start is reported when it ends', () => {
  const notes = feed(fresh(), START, [[25, { s: 'down', r: 'x' }]]);
  assert.deepEqual(notes, [[60_000, { title: 'Offline', body: 'x' }]]);
});

test('degraded only after two minutes in a row, then back to normal', () => {
  const dns = { s: 'warn' as const, r: 'DNS not answering' };
  assert.deepEqual(feed(fresh(), AFTER_QUIET, [[30, dns], [10, { s: 'up' }]]), []); // 90s: not long enough
  const notes = feed(fresh(), AFTER_QUIET, [[45, dns], [1, { s: 'up' }]]);
  assert.deepEqual(notes, [
    [120_000, { title: 'Connection degraded', body: 'DNS not answering' }],
    [135_000, { title: 'Connection back to normal', body: 'Degraded for 2m 15s' }],
  ]);
});

test('confirming and reconnecting are not degraded episodes', () => {
  const notes = feed(fresh(), AFTER_QUIET, [[50, { s: 'warn', r: 'Reconnecting after sleep' }], [50, { s: 'warn', r: 'Checks failing, confirming… (x)' }]]);
  assert.deepEqual(notes, []);
});

test('a gap in the record ends an outage without a "back online"', () => {
  const n = fresh();
  assert.equal(n.network({ t: AFTER_QUIET, s: 'down', r: 'x' })?.title, 'Offline');
  assert.equal(n.network({ t: AFTER_QUIET + 3 * 60 * 60_000, s: 'up' }), null);
});

test('machine warnings: once when new, not again within 30 minutes', () => {
  const n = fresh();
  const disk = { s: 'warn' as const, r: 'Disk almost full (3.0 GB free)', w: ['disk' as const] };
  // present during the quiet start, reported once it ends
  assert.equal(n.machine({ t: START + 10_000, ...disk }), null);
  assert.deepEqual(n.machine({ t: AFTER_QUIET, ...disk }), { title: 'Disk almost full', body: 'Disk almost full (3.0 GB free)' });
  assert.equal(n.machine({ t: AFTER_QUIET + 10_000, ...disk }), null);
  // clears and comes back within 30 minutes: quiet
  n.machine({ t: AFTER_QUIET + 20_000, s: 'up' });
  assert.equal(n.machine({ t: AFTER_QUIET + 30_000, ...disk }), null);
  // two new ones at once
  const both = n.machine({ t: AFTER_QUIET + 40_000, s: 'warn', r: 'a; b', w: ['disk', 'cpu', 'wifi'] });
  assert.deepEqual(both, { title: 'This machine needs attention', body: 'a; b' });
});
