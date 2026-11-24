// Small helpers for running stock commands and reading system files. Both resolve to null
// on any failure, so a missing tool or file never crashes a check.

import fs from 'node:fs';
import { execFile } from 'node:child_process';

// A localized command can print "12,3" or translated labels that the parsers would miss.
export const C_ENV = { ...process.env, LC_ALL: 'C' };

export function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: C_ENV, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}
