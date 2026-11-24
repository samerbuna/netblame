// Starting at login: a launchd agent on macOS, a systemd user service on Linux.
// install copies the app into the data folder first, because the folder npx runs it from
// is a cache that can be cleared or replaced by the next version.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP, ROOT, SETTING_NAMES } from './config.ts';
import type { Config } from './config.ts';

export const LABEL = APP;

export interface ServiceSpec {
  node: string;                 // the node binary to run with
  cli: string;                  // the installed copy's cli.js (or cli.ts)
  env: Record<string, string>;  // settings to run with
  log: string;                  // where output goes
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchdPlist(spec: ServiceSpec): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  const env = Object.entries(spec.env).map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key>
  <array>${str(spec.node)}${str(spec.cli)}${str('run')}</array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key>${str(spec.log)}
  <key>StandardErrorPath</key>${str(spec.log)}
</dict>
</plist>
`;
}

// systemd unit values: double-quoted, with backslash and quote escaped, and % doubled
// because systemd treats it as the start of a specifier.
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join('\n');
  return `[Unit]
Description=is-it-me: is it me, or the internet?

[Service]
ExecStart=${[spec.node, spec.cli, 'run'].map(quote).join(' ')}
${env}
StandardOutput=append:${spec.log.replace(/%/g, '%%')}
StandardError=append:${spec.log.replace(/%/g, '%%')}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function servicePath(platform: string = process.platform, env: Record<string, string | undefined> = process.env, home = os.homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(config, 'systemd', 'user', `${LABEL}.service`);
}

// The settings that are set now, so the service runs the way this command did. DATA_DIR is always
// written out: the service's environment may not have the XDG variables a shell has.
export function serviceEnv(cfg: Config, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SETTING_NAMES) {
    const v = env[name];
    if (v !== undefined && v !== '') out[name] = v;
  }
  out.DATA_DIR = cfg.dataDir;
  return out;
}

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const quietly = (cmd: string, args: string[]) => {
  try {
    sh(cmd, args);
  } catch {
    // not loaded, or already gone
  }
};
const guiDomain = () => `gui/${process.getuid?.() ?? 0}`;

// Starts the service from its definition file.
function startService(file: string): void {
  if (process.platform === 'darwin') sh('launchctl', ['bootstrap', guiDomain(), file]);
  else {
    sh('systemctl', ['--user', 'daemon-reload']);
    sh('systemctl', ['--user', 'enable', '--now', `${LABEL}.service`]);
  }
}

// Stops the service if it's running. Returns whether its definition file existed.
function stopService(): boolean {
  const file = servicePath();
  if (process.platform === 'darwin') quietly('launchctl', ['bootout', `${guiDomain()}/${LABEL}`]);
  else quietly('systemctl', ['--user', 'disable', '--now', `${LABEL}.service`]);
  return fs.existsSync(file);
}

// Copies the running app (the built dist/ or src/, public/ and package.json) to dir.
function copyApp(dir: string): string {
  const codeDir = path.basename(import.meta.dirname); // 'dist' when installed from npm, 'src' from a clone
  if (path.resolve(ROOT) !== path.resolve(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const part of [codeDir, 'public', 'package.json']) {
      fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
    }
  }
  return path.join(dir, codeDir, `cli.${codeDir === 'dist' ? 'js' : 'ts'}`);
}

export async function install(cfg: Config, portFree: () => Promise<boolean>): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Start at login works on macOS and Linux only.');
  // Stop an earlier install, so its port is free and its files can be replaced.
  const file = servicePath();
  const existed = stopService();
  if (!(await portFree())) {
    // Something else holds the port. Leave things as they were: start the earlier install again.
    let restored = '';
    if (existed) {
      try {
        startService(file);
        restored = ' The service that was already installed is running again, unchanged.';
      } catch {
        restored = ` The service that was already installed is stopped; run install again once the port is free.`;
      }
    }
    throw new Error(`Port ${cfg.port} is in use, probably by is-it-me running in a terminal. Stop that (Ctrl-C) and run install again, or pick another port: PORT=${cfg.port + 1} ${APP} install.${restored}`);
  }

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const spec: ServiceSpec = {
    node: process.execPath,
    cli: copyApp(path.join(cfg.dataDir, 'app')),
    env: serviceEnv(cfg),
    log: path.join(cfg.dataDir, `${APP}.log`),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, process.platform === 'darwin' ? launchdPlist(spec) : systemdUnit(spec));
  startService(file);
  console.log(`${APP} now starts at login and is running on http://localhost:${cfg.port}
  service: ${file}
  app:     ${path.dirname(path.dirname(spec.cli))}
  log:     ${spec.log}
  node:    ${spec.node} (if you remove this Node version, run install again)
Remove it with: ${APP} uninstall`);
}

export function uninstall(cfg: Config): void {
  const existed = stopService();
  fs.rmSync(servicePath(), { force: true });
  if (process.platform === 'linux') quietly('systemctl', ['--user', 'daemon-reload']);
  fs.rmSync(path.join(cfg.dataDir, 'app'), { recursive: true, force: true });
  console.log(existed
    ? `${APP} no longer starts at login. History is kept in ${cfg.dataDir}`
    : `${APP} wasn't set to start at login. History is in ${cfg.dataDir}`);
}
