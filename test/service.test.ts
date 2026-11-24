import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchdPlist, systemdUnit, servicePath, serviceEnv } from '../src/service.ts';
import { loadConfig } from '../src/config.ts';

const spec = {
  node: '/Users/a b/.nvm/node',
  cli: '/Users/a b/Library/Application Support/is-it-me/app/dist/cli.js',
  env: { PORT: '4322', PING_HOST: '<8.8.8.8 & "x">', DATA_DIR: '/data/100%' },
  log: '/data/100%/is-it-me.log',
};

test('launchdPlist: runs `node cli run` with the settings, escaped for XML', () => {
  const plist = launchdPlist(spec);
  assert.match(plist, /<key>Label<\/key><string>is-it-me<\/string>/);
  assert.match(plist, /<array><string>\/Users\/a b\/\.nvm\/node<\/string><string>\/Users\/a b\/Library\/Application Support\/is-it-me\/app\/dist\/cli\.js<\/string><string>run<\/string><\/array>/);
  assert.match(plist, /<key>PING_HOST<\/key><string>&lt;8\.8\.8\.8 &amp; &quot;x&quot;&gt;<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/data\/100%\/is-it-me\.log<\/string>/);
});

test('systemdUnit: quoted arguments and settings, % doubled', () => {
  const unit = systemdUnit(spec);
  assert.match(unit, /^ExecStart="\/Users\/a b\/\.nvm\/node" "\/Users\/a b\/Library\/Application Support\/is-it-me\/app\/dist\/cli\.js" "run"$/m);
  assert.match(unit, /^Environment="PING_HOST=<8\.8\.8\.8 & \\"x\\">"$/m);
  assert.match(unit, /^Environment="DATA_DIR=\/data\/100%%"$/m);
  assert.match(unit, /^StandardOutput=append:\/data\/100%%\/is-it-me\.log$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('servicePath: LaunchAgents on macOS, systemd user units on Linux', () => {
  assert.equal(servicePath('darwin', {}, '/Users/a'), '/Users/a/Library/LaunchAgents/is-it-me.plist');
  assert.equal(servicePath('linux', {}, '/home/a'), '/home/a/.config/systemd/user/is-it-me.service');
  assert.equal(servicePath('linux', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/a'), '/x/cfg/systemd/user/is-it-me.service');
});

test('serviceEnv: the settings that are set, plus the data folder', () => {
  const cfg = loadConfig({ DATA_DIR: '/data/x' });
  assert.deepEqual(serviceEnv(cfg, { PORT: '4322', HOME: '/h', NOTIFY: '', TICK_MS: '5000' }), { PORT: '4322', TICK_MS: '5000', DATA_DIR: '/data/x' });
});
