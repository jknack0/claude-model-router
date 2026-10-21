// Shared hook wrapper: read stdin JSON, run fn, never throw, never exit non-zero.
import fs from 'node:fs';
import { dataDir } from './paths.mjs';

export function logError(where, e) {
  try {
    fs.appendFileSync(`${dataDir()}/errors.log`, `${new Date().toISOString()} ${where}: ${e?.stack ?? e}\n`);
  } catch {}
}

export async function runHook(name, fn) {
  try {
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch {}
    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch {}
    await fn(input);
  } catch (e) {
    logError(name, e);
  }
  // let a large stdout write finish before exiting, or the JSON arrives truncated
  try { await new Promise((r) => process.stdout.write('', r)); } catch {}
  process.exit(0);
}
