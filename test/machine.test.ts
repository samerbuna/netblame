import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineStatus, judgingWindow, parseProcStat } from '../src/machine.ts';

type Over = Record<string, number | null | undefined>;
const base = { cpu: 20, mem: 50, so: 0, disk: 50, dgb: 500 };
const series = (over: Over, n = 7, step = 10_000) =>
  Array.from({ length: n }, (_, i) => ({ t: i * step, ...base, ...over })) as Parameters<typeof machineStatus>[0];

test('machineStatus: thresholds and the judging window', () => {
  const cases: [string, Parameters<typeof machineStatus>[0], 'up' | 'warn', number?][] = [
    ['healthy', series({}), 'up'],
    ['disk 9.9% / 49GB', series({ disk: 9.9, dgb: 49 }), 'warn'],
    ['disk 8.75% / 350GB (big disk)', series({ disk: 8.75, dgb: 350 }), 'up'],
    ['disk 10% / 50GB', series({ disk: 10, dgb: 50 }), 'up'],
    ['disk 4.9GB at 40%', series({ disk: 40, dgb: 4.9 }), 'warn'],
    ['mem 91 full minute', series({ mem: 91 }), 'warn'],
    ['mem 90 exactly', series({ mem: 90 }), 'up'],
    ['mem 95 only 30s of data', series({ mem: 95 }, 4), 'up'],
    ['cpu spike in one sample', [...series({}, 6), { t: 60_000, ...base, cpu: 100 }], 'up'],
    ['cpu 95 full minute', series({ cpu: 95 }), 'warn'],
    ['swap-out 2MB/s', series({ so: 2048 }), 'warn'],
    ['nulls everywhere', series({ cpu: null, mem: null, so: null, disk: null, dgb: null }), 'up'],
    ['battery 9 on battery', series({ bat: 9, ac: 0 }), 'warn'],
    ['battery 9 charging', series({ bat: 9, ac: 1 }), 'up'],
    ['hot', series({ hot: 1 }), 'warn'],
    ['empty', [], 'up'],
    ['60s samples: cpu 95, 4 samples a minute apart', series({ cpu: 95 }, 4, 60_000), 'warn', judgingWindow(60_000)],
    ['60s samples: cpu 95, only 3 samples', series({ cpu: 95 }, 3, 60_000), 'up', judgingWindow(60_000)],
  ];
  for (const [name, recent, want, windowMs] of cases) {
    assert.equal(machineStatus(recent, windowMs).s, want, name);
  }
});

test('machineStatus: reasons and warn keys', () => {
  const r = machineStatus(series({ cpu: 95, dgb: 3, disk: 1 }));
  assert.deepEqual(r.w, ['disk', 'cpu']);
  assert.equal(r.r, 'Disk almost full (3.0 GB free); CPU busy (95% over the last minute)');
  assert.match(machineStatus(series({ cpu: 95 }, 4, 30_000), 90_000).r!, /over the last 90 seconds/);
  assert.match(machineStatus(series({ cpu: 95 }, 4, 60_000), judgingWindow(60_000)).r!, /over the last 4 minutes/);
});

test('parseProcStat: counts fields from the last ")" so odd names parse', () => {
  // pid (comm) state ppid ... utime(14) stime(15) ... rss(24)
  const rest = 'S 1 1 1 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 100 123456789 2500 18446744073709551615';
  assert.deepEqual(parseProcStat(`42 (my) (weird) name) ${rest}`), { pid: 42, name: 'my) (weird) name', ticks: 200, rssPages: 2500 });
  assert.equal(parseProcStat('garbage'), null);
});

test('machineStatus: macOS memory pressure replaces the 90% rule', () => {
  assert.equal(machineStatus(series({ mem: 95, mp: 1 })).s, 'up');
  const high = machineStatus(series({ mem: 70, mp: 2 }));
  assert.deepEqual([high.s, high.w, high.r], ['warn', ['mem'], 'Memory pressure high (70% in use)']);
  assert.match(machineStatus(series({ mp: 4 })).r!, /Memory pressure critical/);
  // elevated for under half the window
  const brief = [...series({ mp: 1 }, 5), ...series({ mp: 2 }, 2).map((x, i) => ({ ...x, t: 50_000 + i * 10_000 }))];
  assert.equal(machineStatus(brief).s, 'up');
});

test('machineStatus: weak Wi-Fi, averaged, only while on Wi-Fi', () => {
  const weak = machineStatus(series({ rssi: -80 }));
  assert.deepEqual([weak.s, weak.w, weak.r], ['warn', ['wifi'], 'Weak Wi-Fi signal (-80 dBm)']);
  assert.equal(machineStatus(series({ rssi: -70 })).s, 'up');
  assert.equal(machineStatus(series({ rssi: -75 })).s, 'up');
  // moved to Ethernet: the latest sample has no Wi-Fi reading
  assert.equal(machineStatus([...series({ rssi: -85 }, 6), { t: 60_000, ...base }]).s, 'up');
});
