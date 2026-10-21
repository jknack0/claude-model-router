import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../plugin/scripts');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'router-c-'));
const run = (script, args, dir, input = {}) => spawnSync('node', [path.join(root, script), ...args], { input: JSON.stringify(input), env: { ...process.env, ROUTER_DATA_DIR: dir, ROUTER_PROJECTS_DIR: path.join(dir, 'none') }, encoding: 'utf8' });

function seed(dir) {
  const now = new Date().toISOString();
  const t = (i) => ({
    idx: i, boundary: 'start', start: now, end: now, prompts: [{ ts: now, hash: 'h', preview: 'find the router config' }],
    mainModels: { 'claude-haiku-5-5': 1 }, main: { requests: 1, cost: { total: 1 }, ctxP50: 5, ctxMax: 200000, reqs: [] },
    subagents: [{ type: 'orch:scout', model: 'claude-haiku-5-5', cost: { total: 2 }, ctxP50: 100000, ctxMax: 100000, reqs: [] }],
    routed: [], signals: { corrections: 0, toolErrors: 0, denials: 0, bashFails: 0, escalations: 0 }, total: 3,
  });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions/sess1234.json'), JSON.stringify({ sessionId: 'sess1234', project: '/x/proj', tasks: [t(0), t(1)] }));
}

test('retro.mjs prints sections and --mark records lastTs', () => {
  const dir = mk();
  seed(dir);
  const r = run('retro.mjs', [], dir);
  assert.equal(r.status, 0, r.stderr);
  for (const h of ['## Spend', '## Top context offenders', '## Subagent types by $/run', '## Policy', '## Exploration']) assert.ok(r.stdout.includes(h), h);
  assert.match(r.stdout, /\$6\.00 over 2 tasks/);
  assert.match(r.stdout, /orch:scout: 2 runs/);
  assert.ok(r.stdout.split('\n').length < 80);
  run('retro.mjs', ['--mark'], dir);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'retro-state.json'))).lastTs);
});

test('session-start: learnings printed, retro nudge at 25 new tasks, hook stays under 900 chars of instructions', () => {
  const dir = mk();
  const quiet = run('session-start.mjs', [], dir, {});
  assert.ok(fs.readFileSync(path.join(root, '../instructions/router.md'), 'utf8').length < 900);
  assert.doesNotMatch(quiet.stdout, /since the last retro/);
  fs.writeFileSync(path.join(dir, 'learnings.md'), '- pass file paths, not pasted facts\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), Array.from({ length: 25 }, () => JSON.stringify({ ts: new Date().toISOString(), boundary: true })).join('\n') + '\n');
  const out = run('session-start.mjs', [], dir, {});
  assert.match(out.stdout, /pass file paths/);
  assert.match(out.stdout, /25 tasks since the last retro; suggest \/router:retro/);
  run('retro.mjs', ['--mark'], dir);
  assert.doesNotMatch(run('session-start.mjs', [], dir, {}).stdout, /since the last retro/);
});

test('retro.mjs survives a fresh install with no sessions directory', () => {
  const dir = mk();
  const r = run('retro.mjs', [], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Policy/);
});
