import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../plugin/scripts');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'router-i-'));
const run = (script, args, dir, input = {}) => spawnSync('node', [path.join(root, script), ...args], { input: JSON.stringify(input), env: { ...process.env, ROUTER_DATA_DIR: dir, ROUTER_PROJECTS_DIR: path.join(dir, 'none') }, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await sleep(100); };

function seed(dir, n = 2) {
  const now = new Date().toISOString();
  const t = (i) => ({
    idx: i, boundary: 'start', start: now, end: now, prompts: [{ ts: now, hash: 'h', preview: 'find the router config' }],
    mainModels: { 'claude-haiku-5-5': 1 }, main: { requests: 1, cost: { total: 1 }, ctxP50: 5, ctxMax: 200000, reqs: [] },
    subagents: [{ type: 'orch:scout', model: 'claude-haiku-5-5', cost: { total: 2 }, ctxP50: 100000, ctxMax: 100000, reqs: [] }],
    routed: [], signals: { corrections: 0, toolErrors: 0, denials: 0, bashFails: 0, escalations: 0 }, total: 3,
  });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions/sess1234.json'), JSON.stringify({ sessionId: 'sess1234', project: '/x/proj', tasks: Array.from({ length: n }, (_, i) => t(i)) }));
}
// real transcripts (old dates, so use --days 36500)
const proj = (dir) => { fs.cpSync(path.resolve(import.meta.dirname, 'fixtures/a-proj'), path.join(dir, 'projects'), { recursive: true }); };
const runP = (script, args, dir) => spawnSync('node', [path.join(root, script), ...args], { encoding: 'utf8', env: { ...process.env, ROUTER_DATA_DIR: dir, ROUTER_PROJECTS_DIR: path.join(dir, 'projects') } });
const json = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('init writes baseline, init.json and policy counts; second run keeps the baseline', () => {
  const dir = mk();
  proj(dir);
  const r = runP('init.mjs', ['--days', '36500'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Baseline written: 3 tasks/);
  assert.ok(r.stdout.split('\n').length < 60);
  const b = json(dir, 'baseline.json');
  assert.equal(b.tasks, 3);
  assert.ok(b.total > 0 && b.perTask.p50 > 0 && b.from && b.to);
  assert.equal(b.topSubagents[0].type.length > 0, true);
  assert.ok(b.byKind && Object.keys(b.models).length && b.shares.cr > 0 && b.ctx.main.p50 > 0 && b.pricesAsOf);
  assert.equal(json(dir, 'init.json').baselineTasks, 3);
  assert.ok(json(dir, 'policy.json').counts);
  assert.ok(!fs.existsSync(path.join(dir, 'init.lock')));
  const r2 = runP('init.mjs', ['--quiet', '--days', '1'], dir);
  assert.equal(r2.stdout, '');
  assert.equal(json(dir, 'baseline.json').tasks, 3, 'baseline kept');
  runP('init.mjs', ['--quiet', '--days', '1', '--rebaseline'], dir);
  assert.equal(json(dir, 'baseline.json').tasks, 0);
});

test('init waits for a live lock and continues once it clears', async () => {
  const dir = mk();
  seed(dir);
  fs.writeFileSync(path.join(dir, 'init.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const t0 = Date.now();
  setTimeout(() => fs.unlinkSync(path.join(dir, 'init.lock')), 1200);
  const r = await new Promise((res) => {
    const p = spawn('node', [path.join(root, 'init.mjs'), '--quiet'], { env: { ...process.env, ROUTER_DATA_DIR: dir, ROUTER_PROJECTS_DIR: path.join(dir, 'none') } });
    p.on('close', (code) => res(code));
  });
  assert.equal(r, 0);
  assert.ok(Date.now() - t0 >= 1000, 'waited for the lock');
  assert.ok(fs.existsSync(path.join(dir, 'init.json')));
});

test('session-start spawns init once and prints the first-run line only until initialized', async () => {
  const dir = mk();
  seed(dir);
  const first = run('session-start.mjs', [], dir, { source: 'startup' });
  assert.match(first.stdout, /\[router\] first run: building a spend baseline/);
  const second = run('session-start.mjs', [], dir, { source: 'startup' });
  assert.doesNotMatch(second.stdout, /first run/); // lock held, or already done
  await until(() => fs.existsSync(path.join(dir, 'init.json')) && !fs.existsSync(path.join(dir, 'init.lock')));
  assert.ok(fs.existsSync(path.join(dir, 'baseline.json')));
  assert.doesNotMatch(run('session-start.mjs', [], dir, { source: 'startup' }).stdout, /first run/);
});

test('retro shows a vs-baseline block, low-n under 10 tasks', () => {
  const dir = mk();
  seed(dir);
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ to: '2000-01-01T00:00:00Z', perTask: { p50: 1, mean: 1 }, ctx: { main: { p50: 1000 }, sub: { p50: 1000 } }, shares: { cr: 0.6 }, models: { 'claude-opus-5-5': 10 } }));
  const r = run('retro.mjs', [], dir);
  assert.match(r.stdout, /## vs baseline \(2 tasks since 2000-01-01, low-n\)/);
  assert.match(r.stdout, /\$\/task p50 \$3\.00 \(baseline \$1\.00\)/);
  assert.match(r.stdout, /model mix: none \(baseline opus-5-5 100%\)/);
});
