import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persist, loadRange, pruneOldFiles, dropOlderThan, dayStamp, MACHINE } from '../src/history.ts';
import { defaultDataDir, loadConfig } from '../src/config.ts';

const DAY = 24 * 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'is-it-me-test-'));

test('persist and loadRange: by kind and time range, skipping a torn last line', async () => {
  const dir = tmp();
  const now = new Date(2026, 10, 24, 12).getTime();
  await persist(dir, { t: now - 2 * DAY, v: 1 });
  await persist(dir, { t: now - DAY, v: 2 });
  await persist(dir, { t: now, v: 3 });
  await persist(dir, { t: now, v: 'm' }, MACHINE);
  fs.appendFileSync(path.join(dir, `${dayStamp(now)}.jsonl`), '{"t":');
  assert.deepEqual(loadRange<{ t: number; v: number }>(dir, now - DAY, now).map((x) => x.v), [2, 3]);
  assert.deepEqual(loadRange<{ t: number; v: string }>(dir, now - DAY, now, MACHINE).map((x) => x.v), ['m']);
  assert.deepEqual(loadRange(path.join(dir, 'missing'), 0, now), []);
});

test('pruneOldFiles: removes only this app\'s files older than keepDays', () => {
  const dir = tmp();
  const now = new Date(2026, 10, 24, 12).getTime();
  for (const f of ['2026-11-10.jsonl', '2026-11-10.machine.jsonl', '2026-11-10.events.jsonl', '2026-11-20.jsonl', 'notes.txt', '2026-11-01.backup']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  pruneOldFiles(dir, 7, now);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-11-01.backup', '2026-11-20.jsonl', 'notes.txt']);
});

test('dropOlderThan keeps the list when nothing is older', () => {
  const list = [{ t: 5 }, { t: 9 }];
  assert.equal(dropOlderThan(list, 1), list);
  assert.deepEqual(dropOlderThan(list, 6), [{ t: 9 }]);
});

test('defaultDataDir: per platform, honouring an absolute XDG_STATE_HOME', () => {
  assert.equal(defaultDataDir('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/is-it-me');
  assert.equal(defaultDataDir('linux', {}, '/home/a'), '/home/a/.local/state/is-it-me');
  assert.equal(defaultDataDir('linux', { XDG_STATE_HOME: '/x/state' }, '/home/a'), '/x/state/is-it-me');
  assert.equal(defaultDataDir('linux', { XDG_STATE_HOME: 'relative' }, '/home/a'), '/home/a/.local/state/is-it-me');
});

test('loadConfig: defaults, overrides, and nonsense falls back', () => {
  const c = loadConfig({ PORT: '5000', TICK_MS: 'abc', DATA_DIR: '/tmp/x', PING_HOST: '' });
  assert.equal(c.port, 5000);
  assert.equal(c.tickMs, 3000);
  assert.equal(c.gapMs, 16_000);
  assert.equal(c.dataDir, '/tmp/x');
  assert.equal(c.pingHost, '1.1.1.1');
  assert.equal(c.machineWindowMs, 60_000);
});
