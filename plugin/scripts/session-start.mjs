// SessionStart hook: seed policy.json, reset routing state on /clear, print the router instructions.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sub } from './lib/paths.mjs';
import { runHook } from './lib/hook.mjs';
import { loadPolicy } from './lib/classify.mjs';
import { lockHeld, takeLock, setLockPid } from './lib/initlock.mjs';

await runHook('session-start', (input) => {
  loadPolicy();
  if (input.source === 'clear' && input.session_id) {
    fs.writeFileSync(sub('state', `${input.session_id}.json`), JSON.stringify({ boundaryPending: true, lastClearTs: new Date().toISOString() }));
  }
  let out = fs.readFileSync(path.resolve(import.meta.dirname, '../instructions/router.md'), 'utf8');
  try {
    const learned = fs.readFileSync(sub('learnings.md'), 'utf8').trim().split('\n').slice(0, 20).join('\n').slice(0, 1500);
    if (learned) out += `\nRouter learnings:\n${learned}\n`;
  } catch { /* none yet */ }
  // new tasks since the last retro = routed prompts that opened a task (boundary true or 'topic')
  let lastTs = '';
  try { lastTs = JSON.parse(fs.readFileSync(sub('retro-state.json'), 'utf8')).lastTs ?? ''; } catch { /* never ran */ }
  let n = 0;
  try {
    for (const l of fs.readFileSync(sub('events.jsonl'), 'utf8').split('\n')) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (e.boundary && e.ts > lastTs) n++; } catch { /* skip */ }
    }
  } catch { /* no events */ }
  if (n >= 25) out += `\n[router] ${n} tasks since the last retro; suggest /router:retro to the user.\n`;
  // first run: build the baseline in the background, once (the lock guards against parallel sessions)
  if (!fs.existsSync(sub('init.json')) && !lockHeld() && takeLock()) {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, 'init.mjs'), '--quiet'], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => {});
    setLockPid(child.pid);
    child.unref();
    out += '\n[router] first run: building a spend baseline from the last 30 days in the background. Suggest /router:init to the user to review it and seed routing.\n';
  }
  process.stdout.write(out);
});
