// Lock for the first-run init: <dataDir>/init.lock = {pid, ts}. Stale after 10 min or when the pid is gone.
import fs from 'node:fs';
import { sub } from './paths.mjs';

const STALE_MS = 10 * 60 * 1000;
const lockFile = () => sub('init.lock');

export function lockHeld() {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(), 'utf8'));
    if (Date.now() - l.ts > STALE_MS) return false;
    try { process.kill(l.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
    return l.pid !== process.pid;
  } catch { return false; }
}

/** Atomically take the lock for `pid`. False when a live lock exists. */
export function takeLock(pid = process.pid) {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(lockFile(), JSON.stringify({ pid, ts: Date.now() }), { flag: 'wx' }); return true; }
    catch { if (lockHeld()) return false; try { fs.unlinkSync(lockFile()); } catch { /* raced */ } }
  }
  return false;
}

export const setLockPid = (pid) => fs.writeFileSync(lockFile(), JSON.stringify({ pid, ts: Date.now() }));
export const releaseLock = () => { try { fs.unlinkSync(lockFile()); } catch { /* gone */ } };
