// History on disk: one JSON line per sample, one file per local day and kind.
// Network samples go to YYYY-MM-DD.jsonl, machine samples to YYYY-MM-DD.machine.jsonl.

import fs from 'node:fs';
import path from 'node:path';

export const MACHINE = '.machine';

export const FILE_RE = /^(\d{4}-\d{2}-\d{2})(\.machine)?\.jsonl$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayStamp(t: number): string {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const dayName = (t: number, suffix = '') => `${dayStamp(t)}${suffix}.jsonl`;

export async function persist(dir: string, x: { t: number }, suffix = ''): Promise<void> {
  try {
    await fs.promises.appendFile(path.join(dir, dayName(x.t, suffix)), JSON.stringify(x) + '\n');
  } catch (err) {
    console.error('could not save sample:', (err as Error).message);
  }
}

// Every record of one kind with from <= t <= to, oldest first.
export function loadRange<T extends { t: number }>(dir: string, from: number, to: number, suffix = ''): T[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Pick files by the date in their name, so a DST change can't skip a day.
  const first = dayStamp(from);
  const last = dayStamp(to);
  const loaded: T[] = [];
  for (const f of names) {
    const m = FILE_RE.exec(f);
    if (!m || (m[2] ?? '') !== suffix || m[1] < first || m[1] > last) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const x = JSON.parse(line) as T;
        if (typeof x.t === 'number' && x.t >= from && x.t <= to) loaded.push(x);
      } catch {
        // a half-written last line from a crash; skip it
      }
    }
  }
  return loaded.sort((a, b) => a.t - b.t);
}

export function dropOlderThan<T extends { t: number }>(list: T[], cutoff: number): T[] {
  let drop = 0;
  while (drop < list.length && list[drop].t < cutoff) drop++;
  return drop ? list.slice(drop) : list;
}

// Only touches files this app wrote: YYYY-MM-DD[.kind].jsonl older than keepDays.
export function pruneOldFiles(dir: string, keepDays: number, now = Date.now()): void {
  const oldest = dayStamp(now - keepDays * DAY_MS);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of names) {
    const m = FILE_RE.exec(f);
    if (m && m[1] < oldest) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch (err) {
        console.error(`could not remove ${f}:`, (err as Error).message);
      }
    }
  }
}
