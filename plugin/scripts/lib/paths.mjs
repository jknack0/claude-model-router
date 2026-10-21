// Where the router keeps its data. The plugin's data_dir option wins, else ~/.claude/router.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDir() {
  let d = process.env.CLAUDE_PLUGIN_OPTION_DATA_DIR || process.env.ROUTER_DATA_DIR || '~/.claude/router';
  if (d.startsWith('~')) d = path.join(os.homedir(), d.slice(1));
  d = d.replace(/\/+$/, '');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function projectsDir() {
  return process.env.ROUTER_PROJECTS_DIR || path.join(os.homedir(), '.claude/projects');
}

// Layout inside dataDir():
//   sessions/<sessionId>.json   ingested tasks for one session (rewritten on each ingest)
//   ingest-state.json           { "<transcript path>": { size, mtimeMs } }
//   events.jsonl                one line per routed prompt (written by the UserPromptSubmit hook)
//   state/<sessionId>.json      live routing state for the statusline and the next prompt
//   policy.json                 kind -> tier table (seeded from templates/policy.json)
export const sub = (...p) => {
  const full = path.join(dataDir(), ...p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
};
