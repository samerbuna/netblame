// Settings from environment variables, where history is kept, and the app version.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { judgingWindow } from './machine.ts';

export const APP = 'netblame';

// The package root: this file sits one level down, in src/ when run from source and in dist/ when built.
export const ROOT = path.resolve(import.meta.dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// The environment variables people can set. install copies the ones that are set into the login service.
export const SETTING_NAMES = [
  'PORT', 'TICK_MS', 'KEEP_DAYS', 'PING_HOST', 'HTTP_URL', 'DNS_ZONE', 'MACHINE_MS', 'DISK_PATH', 'DATA_DIR', 'NOTIFY',
] as const;

export interface Config {
  port: number;
  tickMs: number;          // time between network check rounds
  keepDays: number;        // days of history files to keep
  pingHost: string;        // internet ping target
  httpUrl: string;         // must answer 204
  dnsZone: string;         // each DNS check asks for a random name under this zone, so no cache can answer it
  machineMs: number;       // time between machine health samples
  diskPath: string;        // free space is watched on the volume holding this path
  dataDir: string;
  notify: boolean;         // desktop notifications; NOTIFY=0 turns them off
  httpEveryMs: number;     // routine web check; it also runs whenever another check fails
  // A longer pause between samples means the machine slept or the monitor was stopped.
  // One round can take ~8s when everything times out, so leave room for that.
  gapMs: number;
  machineGapMs: number;
  machineWindowMs: number; // CPU, memory and swap are judged over this much history
}

type Env = Record<string, string | undefined>;

function envNum(env: Env, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function defaultDataDir(platform: string = process.platform, env: Env = process.env, home = os.homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP);
  // XDG says to ignore a relative path in these variables.
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(state, APP);
}

export function loadConfig(env: Env = process.env): Config {
  const tickMs = envNum(env, 'TICK_MS', 3000);
  const machineMs = envNum(env, 'MACHINE_MS', 10_000);
  return {
    port: Number.isInteger(Number(env.PORT)) && Number(env.PORT) >= 1 && Number(env.PORT) <= 65535 ? Number(env.PORT) : 4321,
    tickMs,
    keepDays: envNum(env, 'KEEP_DAYS', 7),
    pingHost: env.PING_HOST || '1.1.1.1',
    httpUrl: env.HTTP_URL || 'http://cp.cloudflare.com/generate_204',
    dnsZone: env.DNS_ZONE || 'example.com',
    machineMs,
    diskPath: env.DISK_PATH || '/',
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : defaultDataDir(),
    notify: env.NOTIFY !== '0',
    httpEveryMs: 30_000,
    gapMs: tickMs * 2 + 10_000,
    machineGapMs: machineMs * 2 + 10_000,
    machineWindowMs: judgingWindow(machineMs),
  };
}
