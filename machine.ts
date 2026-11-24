// Machine health: CPU, memory, swap, disk, network throughput, battery and thermal throttling.
// Everything comes from node:os, /proc and /sys on Linux, and a few stock commands on macOS
// (sysctl, vm_stat, netstat, pmset, ps). No sudo.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Thresholds for calling the machine degraded.
export const LIMITS = {
  diskGb: 5,         // free space below this many GB, on any disk ...
  diskPct: 10,       // ... or below this % while also below diskPctGb, so a big disk
  diskPctGb: 50,     //     with hundreds of GB free doesn't count as full
  memPct: 90,        // memory in use, averaged over the window
  swapOutKBs: 1024,  // swap-out rate, averaged over the window
  cpuPct: 90,        // CPU busy, averaged over the window
  batteryPct: 10,    // battery below this % and not on power
};
export const WINDOW_MS = 60_000;     // CPU, memory and swap are judged over this much history ...

// ... or over four samples when samples are further apart than that, so a long MACHINE_MS
// can still fill the window and doesn't quietly switch those warnings off.
export const judgingWindow = (intervalMs: number) => Math.max(WINDOW_MS, intervalMs * 4);
const SLOW_EVERY_MS = 60_000;        // battery and thermal change slowly; read them this often

export interface MachineSample {
  t: number;            // epoch ms
  s: 'up' | 'warn';
  cpu: number | null;   // % busy across all cores since the previous sample
  load: number;         // 1-minute load average
  mem: number | null;   // % of memory in use
  swap: number | null;  // MB of swap in use
  so: number | null;    // swap-out rate, KB/s
  disk: number | null;  // % free on the watched disk
  dgb: number | null;   // GB free on the watched disk
  rx: number | null;    // bytes/s received on the active network interface
  tx: number | null;    // bytes/s sent
  bat?: number;         // battery %, absent on machines without one
  ac?: 0 | 1;           // 1 when on power
  hot?: 1;              // CPU slowed down for heat
  r?: string;           // why, when status is "warn"
  w?: WarnKey[];        // which readings are over their limit, when status is "warn"
}

export type WarnKey = 'disk' | 'mem' | 'swap' | 'cpu' | 'bat' | 'hot';

export type Reading = Omit<MachineSample, 't' | 's' | 'r' | 'w'>;

export interface Proc { pid: number; name: string; cpu: number | null; mb: number }
export interface Procs { cpu: Proc[]; mem: Proc[] }

// A localized command can print "12,3" or translated labels that the parsers would miss.
export const C_ENV = { ...process.env, LC_ALL: 'C' };

const isMac = process.platform === 'darwin';
const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places;

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, env: C_ENV, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// "MemAvailable:  1234 kB" style files (/proc/meminfo, /proc/vmstat).
function field(text: string | null, name: string): number | null {
  if (!text) return null;
  const m = new RegExp(`^${name}:?\\s+(\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : null;
}

// ---------- the collector: keeps the previous counters so it can report rates ----------

export function createCollector(diskPath: string, intervalMs: number) {
  // Rates across a longer pause (sleep, a stalled round) would be averages over the pause, so drop them.
  const maxGapMs = intervalMs * 3;

  let prevAt = 0;
  let prevCpu: { idle: number; total: number } | null = null;
  let prevSwapOut: number | null = null;        // bytes swapped out, cumulative
  let prevNet: { iface: string; rx: number; tx: number } | null = null;
  let slowAt = 0;
  let slow: Pick<Reading, 'bat' | 'ac' | 'hot'> = {};
  let pageSize: number | null = null;
  let prevProcTicks = new Map<number, number>(); // Linux: pid -> CPU clock ticks, for per-process rates
  let prevProcAt = 0;

  // Linux clock ticks per second and page size, read once.
  let linuxSys: Promise<{ hz: number; page: number }> | null = null;
  const sysconf = () => (linuxSys ??= Promise.all([run('getconf', ['CLK_TCK']), run('getconf', ['PAGESIZE'])])
    .then(([hz, page]) => ({ hz: Number(hz) || 100, page: Number(page) || 4096 })));

  function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  }

  // Memory % in use, swap MB in use, cumulative swap-out bytes.
  async function memory(): Promise<{ mem: number | null; swap: number | null; swapOut: number | null }> {
    if (isMac) {
      // os.freemem() counts cached memory as used on macOS, so it reads near zero on a healthy Mac.
      // kern.memorystatus_level is the % available that memory pressure is based on.
      const [sys, vm] = await Promise.all([run('sysctl', ['-n', 'kern.memorystatus_level', 'vm.swapusage']), run('vm_stat', [])]);
      const level = sys ? Number(sys.split('\n')[0]) : NaN;
      const used = sys ? /used = ([\d.]+)([MG])/.exec(sys) : null;
      const page = vm ? /page size of (\d+) bytes/.exec(vm) : null;
      const outs = vm ? /^Swapouts:\s+(\d+)/m.exec(vm) : null;
      if (page) pageSize = Number(page[1]);
      return {
        mem: Number.isFinite(level) && level >= 0 && level <= 100 ? 100 - level : null,
        swap: used ? round(Number(used[1]) * (used[2] === 'G' ? 1024 : 1)) : null,
        swapOut: outs && pageSize ? Number(outs[1]) * pageSize : null,
      };
    }
    const [info, vmstat, sys] = await Promise.all([readText('/proc/meminfo'), readText('/proc/vmstat'), sysconf()]);
    pageSize = sys.page;
    const total = field(info, 'MemTotal');
    const avail = field(info, 'MemAvailable');
    const swapTotal = field(info, 'SwapTotal');
    const swapFree = field(info, 'SwapFree');
    const outs = field(vmstat, 'pswpout');
    return {
      mem: total && avail !== null ? round(100 * (1 - avail / total)) : null,
      swap: swapTotal !== null && swapFree !== null ? round((swapTotal - swapFree) / 1024) : null,
      swapOut: outs !== null && pageSize ? outs * pageSize : null,
    };
  }

  async function disk(): Promise<{ disk: number | null; dgb: number | null }> {
    try {
      const s = await fs.promises.statfs(diskPath);
      const free = s.bavail * s.bsize;
      const total = s.blocks * s.bsize;
      return { disk: total ? round((100 * free) / total) : null, dgb: round(free / 1e9) };
    } catch {
      return { disk: null, dgb: null };
    }
  }

  // Cumulative bytes received and sent on one interface.
  async function netCounters(iface: string): Promise<{ rx: number; tx: number } | null> {
    if (!/^[\w.:-]+$/.test(iface)) return null;
    if (isMac) {
      const out = await run('netstat', ['-ibn', '-I', iface]);
      // The <Link#n> row has the interface totals. A tunnel's row has no MAC address column,
      // so count from the end: ... Ibytes Opkts Oerrs Obytes Coll.
      const row = out?.split('\n').find((l) => l.includes('<Link#'));
      const cols = row?.trim().split(/\s+/);
      if (!cols || cols.length < 8) return null;
      const rx = Number(cols[cols.length - 5]);
      const tx = Number(cols[cols.length - 2]);
      return Number.isFinite(rx) && Number.isFinite(tx) ? { rx, tx } : null;
    }
    const [rx, tx] = await Promise.all([
      readText(`/sys/class/net/${iface}/statistics/rx_bytes`),
      readText(`/sys/class/net/${iface}/statistics/tx_bytes`),
    ]);
    return rx !== null && tx !== null ? { rx: Number(rx), tx: Number(tx) } : null;
  }

  async function battery(): Promise<Pick<Reading, 'bat' | 'ac'>> {
    if (isMac) {
      const out = await run('pmset', ['-g', 'batt']);
      const pct = out ? /(\d+)%;/.exec(out) : null;
      if (!pct) return {};
      return { bat: Number(pct[1]), ac: out!.includes("'AC Power'") ? 1 : 0 };
    }
    let dirs: string[];
    try {
      dirs = (await fs.promises.readdir('/sys/class/power_supply')).filter((d) => d.startsWith('BAT'));
    } catch {
      return {};
    }
    if (!dirs.length) return {};
    const base = path.join('/sys/class/power_supply', dirs[0]);
    const [cap, status] = await Promise.all([readText(`${base}/capacity`), readText(`${base}/status`)]);
    if (cap === null) return {};
    return { bat: Number(cap), ac: status?.trim() === 'Discharging' ? 0 : 1 };
  }

  async function thermal(): Promise<Pick<Reading, 'hot'>> {
    if (!isMac) return {};
    const out = await run('pmset', ['-g', 'therm']);
    if (!out) return {};
    const limit = (name: string) => {
      const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(out);
      return m ? Number(m[1]) : 100;
    };
    const warning = /thermal warning level[^\d\n]*(\d+)/i.exec(out);
    const hot = limit('CPU_Speed_Limit') < 100 || limit('CPU_Scheduler_Limit') < 100 || (warning !== null && Number(warning[1]) > 0);
    return hot ? { hot: 1 } : {};
  }

  async function sample(iface: string | null, now: number): Promise<Reading> {
    const fresh = prevAt > 0 && now - prevAt <= maxGapMs;
    const dt = (now - prevAt) / 1000;

    const cpuNow = cpuTimes();
    let cpu: number | null = null;
    if (fresh && prevCpu && cpuNow.total > prevCpu.total) {
      cpu = round(100 * (1 - (cpuNow.idle - prevCpu.idle) / (cpuNow.total - prevCpu.total)));
    }
    prevCpu = cpuNow;

    // Everything is read at once. Reading battery and thermal (pmset can take up to its timeout)
    // before the counters would delay them past `now`, so their rates would cover the wrong span.
    const slowDue = now - slowAt >= SLOW_EVERY_MS;
    const [m, d, net, b, h] = await Promise.all([
      memory(),
      disk(),
      iface ? netCounters(iface) : Promise.resolve(null),
      slowDue ? battery() : Promise.resolve(null),
      slowDue ? thermal() : Promise.resolve(null),
    ]);
    if (slowDue) {
      slow = { ...b, ...h };
      slowAt = now;
    }

    // A counter that went down was reset (interface restarted); skip that sample's rate.
    let so: number | null = null;
    if (fresh && m.swapOut !== null && prevSwapOut !== null && m.swapOut >= prevSwapOut) {
      so = round((m.swapOut - prevSwapOut) / 1024 / dt);
    }
    prevSwapOut = m.swapOut;

    let rx: number | null = null;
    let tx: number | null = null;
    if (fresh && net && prevNet && prevNet.iface === iface && net.rx >= prevNet.rx && net.tx >= prevNet.tx) {
      rx = Math.round((net.rx - prevNet.rx) / dt);
      tx = Math.round((net.tx - prevNet.tx) / dt);
    }
    prevNet = net && iface ? { iface, ...net } : null;
    prevAt = now;

    return { cpu, load: round(os.loadavg()[0], 2), mem: m.mem, swap: m.swap, so, ...d, rx, tx, ...slow };
  }

  // macOS ps reports recent CPU use per process.
  async function macProcs(): Promise<Proc[] | null> {
    const out = await run('ps', ['-Ao', 'pid=,pcpu=,rss=,comm=']);
    if (!out) return null;
    const list: Proc[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
      if (m) list.push({ pid: Number(m[1]), name: path.basename(m[4].trim()), cpu: Number(m[2]), mb: round(Number(m[3]) / 1024) });
    }
    return list;
  }

  // Linux ps reports a lifetime average and counts CPU time in whole seconds, so the rate comes
  // from /proc/<pid>/stat clock ticks between two calls.
  async function linuxProcs(now: number): Promise<Proc[] | null> {
    const { hz, page } = await sysconf();
    let pids: string[];
    try {
      pids = (await fs.promises.readdir('/proc')).filter((d) => /^\d+$/.test(d));
    } catch {
      return null;
    }
    const stats = await Promise.all(pids.map((p) => readText(`/proc/${p}/stat`)));
    const dt = (now - prevProcAt) / 1000;
    const haveRates = prevProcAt > 0 && now - prevProcAt <= maxGapMs;
    const ticks = new Map<number, number>();
    const list: Proc[] = [];
    for (const text of stats) {
      const st = text ? parseProcStat(text) : null; // null text: the process exited meanwhile
      if (!st) continue;
      ticks.set(st.pid, st.ticks);
      const before = prevProcTicks.get(st.pid);
      const cpu = haveRates && before !== undefined && st.ticks >= before ? round((100 * (st.ticks - before)) / hz / dt) : null;
      list.push({ pid: st.pid, name: st.name, cpu, mb: round((st.rssPages * page) / 1048576) });
    }
    prevProcTicks = ticks;
    prevProcAt = now;
    return list;
  }

  // Top processes by CPU and by memory.
  async function procs(now: number): Promise<Procs | null> {
    const list = isMac ? await macProcs() : await linuxProcs(now);
    if (!list) return null;
    const byCpu = list.filter((p) => p.cpu !== null).sort((a, b) => b.cpu! - a.cpu!).slice(0, 5);
    const byMem = [...list].sort((a, b) => b.mb - a.mb).slice(0, 5);
    return { cpu: byCpu, mem: byMem };
  }

  return { sample, procs };
}

// One /proc/<pid>/stat line (see proc(5)). The name sits in parentheses and may itself contain
// spaces or ")", so fields are counted from the last ")": utime and stime are fields 14 and 15,
// rss (in pages) is field 24.
export function parseProcStat(text: string): { pid: number; name: string; ticks: number; rssPages: number } | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = text.slice(close + 2).split(' ');
  const pid = Number(text.slice(0, open));
  const ticks = Number(f[11]) + Number(f[12]);
  const rssPages = Number(f[21]);
  if (!Number.isFinite(pid) || !Number.isFinite(ticks) || !Number.isFinite(rssPages)) return null;
  return { pid, name: text.slice(open + 1, close), ticks, rssPages };
}

// ---------- status ----------

// recent: the machine samples from the last windowMs (see judgingWindow), oldest first, ending with the one being judged.
// CPU, memory and swap are averaged so a short spike doesn't count, and they're only judged once
// the window is mostly covered (not right after start or wake).
export function machineStatus(recent: Pick<MachineSample, 't' | 'cpu' | 'mem' | 'so' | 'disk' | 'dgb' | 'bat' | 'ac' | 'hot'>[], windowMs = WINDOW_MS): { s: 'up' | 'warn'; r?: string; w?: WarnKey[] } {
  const x = recent[recent.length - 1];
  if (!x) return { s: 'up' };
  const covered = x.t - recent[0].t >= windowMs * 0.75;
  const over = windowMs <= 60_000 ? 'the last minute'
    : windowMs < 120_000 ? `the last ${Math.round(windowMs / 1000)} seconds`
    : `the last ${Math.round(windowMs / 60_000)} minutes`;
  const avg = (key: 'cpu' | 'mem' | 'so') => {
    const vals = recent.map((y) => y[key]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const reasons: string[] = [];
  const keys: WarnKey[] = [];
  const warn = (key: WarnKey, text: string) => {
    keys.push(key);
    reasons.push(text);
  };
  if (x.dgb !== null && x.disk !== null && (x.dgb < LIMITS.diskGb || (x.disk < LIMITS.diskPct && x.dgb < LIMITS.diskPctGb))) {
    warn('disk', `Disk almost full (${x.dgb < 10 ? x.dgb.toFixed(1) : Math.round(x.dgb)} GB free)`);
  }
  if (covered) {
    const mem = avg('mem');
    const so = avg('so');
    const cpu = avg('cpu');
    if (mem !== null && mem > LIMITS.memPct) warn('mem', `Memory almost full (${Math.round(mem)}% in use)`);
    if (so !== null && so > LIMITS.swapOutKBs) warn('swap', `Swapping heavily (${(so / 1024).toFixed(1)} MB/s to disk)`);
    if (cpu !== null && cpu > LIMITS.cpuPct) warn('cpu', `CPU busy (${Math.round(cpu)}% over ${over})`);
  }
  if (x.bat !== undefined && x.ac === 0 && x.bat < LIMITS.batteryPct) warn('bat', `Battery low (${x.bat}%)`);
  if (x.hot) warn('hot', 'CPU slowed down for heat');

  return reasons.length ? { s: 'warn', r: reasons.join('; '), w: keys } : { s: 'up' };
}
