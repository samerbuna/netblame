import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

// Lays the package out the way npm installs it: dist/, public/ and package.json in one folder.
function buildPackage(): string {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'is-it-me-build-'));
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/build.ts', path.join(pkg, 'dist')], { cwd: root });
  fs.cpSync(path.join(root, 'public'), path.join(pkg, 'public'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(pkg, 'package.json'));
  return pkg;
}

// Run the built CLI with type stripping off, as it would run from node_modules.
const runBuilt = (pkg: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, ['--no-experimental-strip-types', path.join(pkg, 'dist', 'cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('build: every source file becomes plain JS with .js imports', () => {
  const pkg = buildPackage();
  const sources = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.ts'));
  const built = fs.readdirSync(path.join(pkg, 'dist'));
  assert.deepEqual(built.sort(), sources.map((f) => f.replace(/\.ts$/, '.js')).sort());
  for (const f of built) {
    const js = fs.readFileSync(path.join(pkg, 'dist', f), 'utf8');
    assert.doesNotMatch(js, /from\s+['"]\.\.?\/[^'"]+\.ts['"]/, f);
  }
  assert.ok(fs.statSync(path.join(pkg, 'dist', 'cli.js')).mode & 0o100, 'cli.js is executable');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(runBuilt(pkg, ['--version']).trim(), pkgJson.version);
  assert.match(runBuilt(pkg, ['--help']), /Usage:/);
});

test('build: refuses an output folder not named dist', () => {
  assert.throws(() => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/build.ts', os.tmpdir()], { cwd: root, stdio: 'pipe' }));
});
