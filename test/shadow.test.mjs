import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../plugin/scripts');
const fake = path.resolve(import.meta.dirname, 'fixtures/c-claude.sh');
const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'router-c-')));
const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function setup(promptOf = () => 'where is the config loaded') {
  const dir = mk(), repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'init');
  const prompt = promptOf(repo);
  const hash = (await_hash(prompt));
  // transcript so run can recover the full prompt
  const transcript = path.join(dir, 'transcripts/sess1234.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const ts = new Date(Date.now() + 5000).toISOString();
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: ts, cwd: repo, sessionId: 'sess1234', message: { role: 'user', content: prompt } }) + '\n');
  const risky = { ...mkTask(0, ts, prompt, hash) };
  const bad = { ...mkTask(1, ts, 'deploy to prod now', 'h2') };
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions/sess1234.json'), JSON.stringify({ sessionId: 'sess1234', project: repo, file: transcript, tasks: [risky, bad] }));
  fs.writeFileSync(path.join(dir, 'ingest-state.json'), '{}');
  return { dir, repo, transcript };
}
import crypto from 'node:crypto';
function await_hash(p) { return crypto.createHash('sha1').update(p).digest('hex'); }
function mkTask(idx, ts, preview, hash) {
  return {
    idx, boundary: 'start', start: ts, end: ts, prompts: [{ ts, hash, preview }], mainModels: { 'claude-sonnet-5-5': 1 },
    main: { requests: 1, cost: { total: 1 }, ctxP50: 1, ctxMax: 1, reqs: [['claude-sonnet-5-5', 1000, 0, 0, 0, 100]] },
    subagents: [], routed: [], signals: { corrections: 0, toolErrors: 0, denials: 0, bashFails: 0, escalations: 0 }, total: 1,
  };
}
const run = (args, d, extra = {}) => spawnSync('node', [path.join(root, 'shadow.mjs'), ...args], {
  env: { ...process.env, ROUTER_DATA_DIR: d.dir, ROUTER_PROJECTS_DIR: path.join(d.dir, 'none'), ROUTER_CLAUDE_BIN: fake, ROUTER_SHADOW_SCRATCH: d.dir, FAKE_CLAUDE_LOG: path.join(d.dir, 'claude.log'), ...extra }, encoding: 'utf8',
});

test('plan: picks the safe repo task, skips risky prompts, prints an estimate and budget share, runs nothing', () => {
  const d = setup();
  fs.writeFileSync(path.join(d.dir, 'budget.json'), '{"monthlyUsd": 500}');
  const r = run(['plan', '--n', '5'], d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sess1234-0\s+recon\s+fast->standard/);
  assert.doesNotMatch(r.stdout, /sess1234-1/);
  assert.match(r.stdout, /estimated total \$0\.\d+/);
  assert.match(r.stdout, /% of the \$500 monthly budget/);
  assert.ok(!fs.existsSync(path.join(d.dir, 'claude.log')));
});

test('run without --yes only prints the plan', () => {
  const d = setup();
  const r = run(['run', '--ids', 'sess1234-0'], d);
  assert.match(r.stdout, /Dry run/);
  assert.ok(!fs.existsSync(path.join(d.dir, 'claude.log')));
});

test('run --yes with the fake claude records a verdict and cleans up worktrees', () => {
  const d = setup();
  const r = run(['run', '--ids', 'sess1234-0', '--yes'], d);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(fs.readFileSync(path.join(d.dir, 'shadow/results.jsonl'), 'utf8').trim());
  assert.deepEqual([rec.taskId, rec.kind, rec.cheapTier, rec.upTier, rec.verdict], ['sess1234-0', 'recon', 'fast', 'standard', 'cheap_worse']);
  assert.ok(Math.abs(rec.costUsd - 0.22) < 1e-9);
  const log = fs.readFileSync(path.join(d.dir, 'claude.log'), 'utf8');
  assert.match(log, /--model haiku --effort low/);
  assert.match(log, /--model sonnet --effort medium/);
  assert.match(log, /disableAllHooks/);
  assert.equal(sh(d.repo, 'worktree', 'list').stdout.trim().split('\n').length, 1);
  assert.deepEqual(fs.readdirSync(d.dir).filter((n) => n.startsWith('router-shadow-')), []);
});

test('run aborts when claude is not logged in', () => {
  const d = setup();
  const r = run(['run', '--ids', 'sess1234-0', '--yes'], d, { FAKE_LOGGED_OUT: '1' });
  assert.match(r.stderr, /not logged in/);
  assert.ok(!fs.existsSync(path.join(d.dir, 'shadow/results.jsonl')));
});

const calls = (d) => fs.readFileSync(path.join(d.dir, 'claude.log'), 'utf8').split('\n').filter((l) => l && !l.startsWith('STDIN') && !l.startsWith('CWD') && !l.startsWith('auth'));

test('run --yes passes the isolation flags to both replays and the judge, with budgets', () => {
  const d = setup((repo) => `where is the config loaded in ${repo}/a.txt`);
  const r = run(['run', '--ids', 'sess1234-0', '--yes'], d);
  assert.equal(r.status, 0, r.stderr);
  const [cheap, up, judge] = calls(d);
  for (const c of [cheap, up, judge]) {
    assert.match(c, /--no-session-persistence/);
    assert.match(c, /--strict-mcp-config/);
    assert.match(c, /--max-budget-usd \d+\.\d\d/);
  }
  assert.match(cheap, /--model haiku --effort low/);
  assert.match(up, /--model sonnet --effort medium/);
  assert.match(judge, /--model sonnet/);
  assert.match(judge, /--tools  ?--/); // --tools "" (empty list), nothing after it swallowed
  assert.doesNotMatch(judge, /--permission-mode|--disallowedTools/);
  // absolute repo paths in the prompt were rewritten to the clone
  const stdin = fs.readFileSync(path.join(d.dir, 'claude.log'), 'utf8').split('\n').filter((l) => l.startsWith('STDIN'))[0];
  assert.doesNotMatch(stdin, new RegExp(d.repo + '/a.txt'));
  assert.match(stdin, /router-shadow-.*sess1234-0-fast\/a\.txt/);
  assert.match(cheap, /--restricted --tools Read,Grep,Glob,Edit,Write,Bash/);
  assert.doesNotMatch(judge, /--restricted/);
  // the judge prompt carries the rubric
  assert.match(fs.readFileSync(path.join(d.dir, 'claude.log'), 'utf8'), /STDIN: You compare two solutions/);
});

test('run --ids applies the plan filters (ops/risky tasks are refused)', () => {
  const d = setup();
  const r = run(['run', '--ids', 'sess1234-1', '--yes'], d);
  assert.match(r.stderr, /sess1234-1: not eligible/);
  assert.ok(!fs.existsSync(path.join(d.dir, 'claude.log')) || calls(d).length === 0);
});

test('plan estimates the first turn only and skips headless sessions', () => {
  const d = setup();
  const f = path.join(d.dir, 'sessions/sess1234.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.tasks[0].main.reqs = [['claude-sonnet-5-5', 1000, 0, 0, 900000, 100], ['claude-sonnet-5-5', 1000, 0, 0, 900000, 100]];
  s.tasks[0].turn1 = [['claude-sonnet-5-5', 1000, 0, 0, 900000, 100]];
  fs.writeFileSync(f, JSON.stringify(s));
  const est = Number(/\$(\d+\.\d+)\s+where/.exec(run(['plan', '--n', '1'], d).stdout)?.[1]);
  assert.ok(est < 0.5, `inherited 900K cache read must not be re-priced, got ${est}`);
  s.headless = true;
  fs.writeFileSync(f, JSON.stringify(s));
  assert.doesNotMatch(run(['plan', '--n', '1'], d).stdout, /sess1234-0/);
});

test('SIGTERM mid-replay kills the child and removes the clone and scratch', async () => {
  const d = setup();
  const { spawn } = await import('node:child_process');
  const child = spawn('node', [path.join(root, 'shadow.mjs'), 'run', '--ids', 'sess1234-0', '--yes'], { env: { ...process.env, ROUTER_DATA_DIR: d.dir, ROUTER_PROJECTS_DIR: path.join(d.dir, 'none'), ROUTER_CLAUDE_BIN: fake, ROUTER_SHADOW_SCRATCH: d.dir, FAKE_CLAUDE_LOG: path.join(d.dir, 'claude.log'), FAKE_SLEEP: '5' }, stdio: 'ignore' });
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  const t0 = Date.now();
  const clone = () => { const s = fs.readdirSync(d.dir).find((n) => n.startsWith('router-shadow-')); return s && fs.existsSync(path.join(d.dir, s, 'sess1234-0-fast', '.git')); };
  while (Date.now() - t0 < 10_000 && !clone()) await new Promise((r) => setTimeout(r, 50));
  assert.ok(clone(), 'replay clone should exist mid-run');
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143);
  assert.equal(sh(d.repo, 'worktree', 'list').stdout.trim().split('\n').length, 1);
  assert.deepEqual(fs.readdirSync(d.dir).filter((n) => n.startsWith('router-shadow-')), []);
});

test('isolation: replay is a clone with its own .git, run at the same relative subdir, prompt paths rewritten from the top-level', () => {
  const d = setup((repo) => `where is the config loaded in ${repo}/sub/b.txt`);
  fs.mkdirSync(path.join(d.repo, 'sub'));
  fs.writeFileSync(path.join(d.repo, 'sub/b.txt'), 'y');
  sh(d.repo, 'add', '-A'); sh(d.repo, 'commit', '-qm', 'sub');
  const f = path.join(d.dir, 'sessions/sess1234.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.project = path.join(d.repo, 'sub'); // the task ran in a subdirectory
  fs.writeFileSync(f, JSON.stringify(s));
  const r = run(['run', '--ids', 'sess1234-0', '--yes'], d, { FAKE_SLEEP: '' });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(d.dir, 'claude.log'), 'utf8');
  const cwds = log.split('\n').filter((l) => l.startsWith('CWD:')).map((l) => l.slice(5));
  assert.match(cwds[0], /router-shadow-[^/]+\/sess1234-0-fast\/sub$/);
  assert.match(cwds[1], /router-shadow-[^/]+\/sess1234-0-standard\/sub$/);
  assert.match(log, /STDIN: .*router-shadow-[^/]+\/sess1234-0-fast\/sub\/b\.txt/);
  assert.equal(sh(d.repo, 'worktree', 'list').stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(log, /git worktree/);
});

test('isolation: the clone has its own git dir and no origin', () => {
  const d = setup();
  const clone = path.join(d.dir, 'c');
  // same commands the replay uses
  assert.equal(sh(d.dir, 'clone', '--local', '--no-checkout', '--quiet', d.repo, clone).status, 0);
  assert.equal(sh(clone, 'rev-parse', '--git-common-dir').stdout.trim(), '.git');
});

test('sweep: removes only dead-pid dirs older than an hour, never a live run or a fresh dir', () => {
  const d = setup();
  const mkdir = (name, pid, ageH) => {
    const p = path.join(d.dir, name);
    fs.mkdirSync(p);
    if (pid != null) fs.writeFileSync(path.join(p, 'pid'), String(pid));
    const t = new Date(Date.now() - ageH * 3_600_000);
    fs.utimesSync(p, t, t);
    return p;
  };
  const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const oldDead = mkdir('router-shadow-olddead', dead, 3);
  const oldLive = mkdir('router-shadow-oldlive', process.pid, 3); // this test process is alive
  const freshDead = mkdir('router-shadow-freshdead', dead, 0);
  const r = run(['run', '--ids', 'sess1234-0', '--yes'], d);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(oldDead));
  assert.ok(fs.existsSync(oldLive));
  assert.ok(fs.existsSync(freshDead));
});
