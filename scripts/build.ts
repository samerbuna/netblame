// Builds dist/ for the npm package: each src/*.ts with its types removed and its relative
// imports pointed at .js. It uses Node's own type stripper, the same one that runs src/ in
// development, so the package runs exactly the code that was tested.
//
// Usage: node scripts/build.ts [out-dir]   (default: dist; the folder must be named dist)

import { stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
// The folder is emptied first, so refuse anything that isn't plainly a build folder.
if (path.basename(out) !== 'dist') {
  console.error(`Refusing to build into ${out}: the folder must be named dist.`);
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// from './x.ts', import('./x.ts') and import './x.ts' -> .js
const TS_IMPORT = /((?:\bfrom|\bimport)\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g;

const src = path.join(root, 'src');
let count = 0;
for (const f of fs.readdirSync(src).sort()) {
  if (!f.endsWith('.ts')) continue;
  const js = stripTypeScriptTypes(fs.readFileSync(path.join(src, f), 'utf8'), { mode: 'strip' })
    .replace(TS_IMPORT, '$1$2$3.js$2');
  const file = path.join(out, f.replace(/\.ts$/, '.js'));
  fs.writeFileSync(file, js);
  if (f === 'cli.ts') fs.chmodSync(file, 0o755);
  count++;
}
console.log(`built ${count} files into ${path.relative(process.cwd(), out) || out}`);
