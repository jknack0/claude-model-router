#!/usr/bin/env node
// CLI: shadow.mjs plan [--n 5]   |   shadow.mjs run --ids <id,id> [--yes]
// Replays a past task's first prompt at the tier below its main model's and at that tier ("would one tier cheaper do?") in throwaway local clones, then has a judge compare.
// The claude binary comes from ROUTER_CLAUDE_BIN (tests use a fake). `run` spends quota; only run it with the user's yes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sub, dataDir } from './lib/paths.mjs';
import { TIERS, loadPolicy } from './lib/classify.mjs';
import { ingestAll, reqCost } from './lib/ingest.mjs';
import { loadTasks, taskKind, effectiveTier } from './lib/policy.mjs';
import { readSession, humanPrompts } from './lib/transcripts.mjs';
import { resolveModel } from './lib/pricing.mjs';

const claude = () => process.env.ROUTER_CLAUDE_BIN || 'claude';
const RISKY = /publish|commit|push|gh pr|reset --hard|rm -r|force|drop|truncate|deploy|release|prod|migrate|delete|merge/i;
const JUDGE_ALLOWANCE = 0.2; // sonnet -p call with default system prompt plus up to 80 KB of diffs
const BASE_CTX = 30_000; // tokens a fresh `claude -p` session writes before the prompt (system prompt, tools)
const MIN_BUDGET = 0.25; // floor for --max-budget-usd so a tiny estimate cannot abort the run at once
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const isRepo = (cwd) => !!cwd && fs.existsSync(cwd) && git(cwd, 'rev-parse', '--verify', 'HEAD').status === 0;

/** Cost of redoing the task's first turn fresh on `model`: no inherited cached context, a fixed base instead. */
function repriced(task, model) {
  const reqs = task.turn1?.length ? task.turn1 : task.main.reqs;
  const inherited = reqs[0]?.[4] ?? 0;
  return reqs.reduce((sum, r, i) => {
    const fresh = [r[0], r[1], r[2] + (i === 0 ? BASE_CTX : 0), r[3], i === 0 ? 0 : Math.max(0, r[4] - inherited) + BASE_CTX, r[5]];
    return sum + reqCost(fresh, resolveModel(model)).total;
  }, 0);
}

/** Tasks a replay may touch; plan and run share this filter. */
function candidates(policy) {
  return loadTasks({ days: 14 })
    .map((t) => ({ t, kind: taskKind(t), tier: effectiveTier(t) }))
    .filter(({ t, kind, tier }) => !t.headless && tier > 0 && policy.kinds?.[kind] && kind !== 'ops' && t.prompts.length && !RISKY.test(t.prompts[0].preview) && isRepo(t.project))
    .sort((a, b) => (a.t.start < b.t.start ? 1 : -1));
}

export function plan({ n = 5 } = {}) {
  ingestAll({ days: 14 });
  const policy = loadPolicy();
  const picked = [];
  const rows = candidates(policy);
  // one task per kind first, then fill up
  const seen = new Set();
  for (const r of rows) if (picked.length < n && !seen.has(r.kind)) { seen.add(r.kind); picked.push(r); }
  for (const r of rows) if (picked.length < n && !picked.includes(r)) picked.push(r);
  return picked.map(({ t, kind, tier }) => {
    const cheap = TIERS[tier - 1], up = TIERS[tier];
    const estCheap = repriced(t, policy.tiers[cheap].model), estUp = repriced(t, policy.tiers[up].model);
    return { id: t.id, kind, cheap, up, estCheap, estUp, est: estCheap + estUp + JUDGE_ALLOWANCE, project: t.project, preview: t.prompts[0].preview };
  });
}

function printPlan(rows) {
  console.log('id          kind        cheap->up           est$  prompt');
  for (const r of rows) console.log(`${r.id.padEnd(11)} ${r.kind.padEnd(11)} ${(r.cheap + '->' + r.up).padEnd(16)} ${('$' + r.est.toFixed(2)).padStart(6)}  ${r.preview.slice(0, 60)}`);
  const total = rows.reduce((s, r) => s + r.est, 0);
  console.log(`\n${rows.length} task(s), estimated total $${total.toFixed(2)} (first turn re-priced fresh at both tiers + $${JUDGE_ALLOWANCE.toFixed(2)} judge each; list price)`);
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dataDir(), 'budget.json'), 'utf8'));
    if (b.monthlyUsd) console.log(`= ${((total / b.monthlyUsd) * 100).toFixed(1)}% of the $${b.monthlyUsd} monthly budget`);
  } catch { /* no budget */ }
  console.log('Nothing was run. To run: shadow.mjs run --ids <id,id> --yes');
}

// ---- live resources, released on any exit (finally, SIGINT, SIGTERM) ----
const live = { child: null, scratch: null };
function releaseAll() {
  try { live.child?.kill('SIGKILL'); } catch { /* gone */ }
  live.child = null;
  if (live.scratch) fs.rmSync(live.scratch, { recursive: true, force: true });
  live.scratch = null;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** Remove router-shadow-* run dirs a killed run left behind: pid file names a dead process and the dir is over an hour old. Never a live run's. */
function sweep(base, own) {
  for (const n of fs.readdirSync(base)) {
    const d = path.join(base, n);
    if (!n.startsWith('router-shadow-') || d === own) continue;
    try {
      if (Date.now() - fs.statSync(d).mtimeMs < 3_600_000) continue;
      const pid = Number(fs.readFileSync(path.join(d, 'pid'), 'utf8'));
      if (pid > 0 && alive(pid)) continue;
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* no pid file or raced with its owner: leave it */ }
  }
}

function runClaude(args, input, cwd, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    const child = spawn(claude(), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    live.child = child;
    let out = '', err = '', done = false;
    const finish = (code, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      live.child = null;
      let j = null;
      try { j = JSON.parse(out); } catch { /* not json */ }
      resolve({ ok: code === 0 && !!j, text: j?.result ?? '', cost: Number(j?.total_cost_usd) || 0, err: err + extra });
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(-1, e.message));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function judgeRubric() {
  const md = fs.readFileSync(path.resolve(import.meta.dirname, '../agents/judge.md'), 'utf8');
  return md.replace(/^---[\s\S]*?---\n/, '').trim();
}

function fullPrompt(task) {
  const { prompts } = humanPrompts(readSession(task.file));
  const p = prompts.find((x) => crypto.createHash('sha1').update(x.text).digest('hex') === task.prompts[0].hash);
  return p?.text ?? null;
}

// No MCP servers (the user's vault would take writes), no session file (it would be ingested as a real task).
// --restricted ignores user/project/local settings files (so the repo's checked-in allow rules do not apply) and drops
// the code-running tools; --tools names back the ones a replay needs (Bash included: read-only commands still pass acceptEdits).
const ISOLATION = ['--no-session-persistence', '--strict-mcp-config'];
const REPLAY_TOOLS = ['--restricted', '--tools', 'Read,Grep,Glob,Edit,Write,Bash'];

/** Replay in a private clone (own .git, so tools resolving --git-common-dir cannot reach the real repo's worktrees). */
async function replay(task, tier, prompt, policy, commit, scratch, budget) {
  const top = git(task.project, 'rev-parse', '--show-toplevel').stdout.trim();
  const rel = path.relative(top, task.project);
  const root = path.join(scratch, `${task.id}-${tier}`);
  const cl = spawnSync('git', ['clone', '--local', '--no-checkout', '--quiet', top, root], { encoding: 'utf8' });
  if (cl.status !== 0) throw new Error(`clone failed: ${cl.stderr}`);
  try {
    git(root, 'remote', 'remove', 'origin');
    const co = git(root, 'checkout', '--quiet', '--detach', commit);
    if (co.status !== 0) throw new Error(`checkout failed: ${co.stderr}`);
    const t = policy.tiers[tier];
    const local = prompt.split(top).join(root); // absolute paths in the prompt point at the clone
    const r = await runClaude(['-p', '--model', t.model, '--effort', t.effort, '--output-format', 'json', '--settings', '{"disableAllHooks": true}', '--permission-mode', 'acceptEdits', ...REPLAY_TOOLS, ...ISOLATION, '--max-budget-usd', budget.toFixed(2), '--disallowedTools', 'Bash(git push:*)', 'Bash(rm:*)', 'WebFetch', 'WebSearch'], local, path.join(root, rel));
    if (!r.ok) throw new Error(`claude failed at ${tier}: ${r.err.slice(0, 200)}`);
    git(root, 'add', '-A');
    return { text: r.text, cost: r.cost, diff: git(root, 'diff', '--cached').stdout.slice(0, 40_000) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function run(ids) {
  const auth = spawnSync(claude(), ['auth', 'status'], { encoding: 'utf8' });
  if (auth.status !== 0) throw new Error('claude is not logged in (claude auth status failed); aborting');
  ingestAll({ days: 14 });
  const policy = loadPolicy();
  const all = candidates(policy);
  const scratch = fs.mkdtempSync(path.join(process.env.ROUTER_SHADOW_SCRATCH || os.tmpdir(), 'router-shadow-'));
  live.scratch = scratch;
  fs.writeFileSync(path.join(scratch, 'pid'), String(process.pid));
  sweep(path.dirname(scratch), scratch);
  const onSignal = (sig) => () => { releaseAll(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  const handlers = ['SIGINT', 'SIGTERM'].map((sig) => [sig, onSignal(sig)]);
  for (const [sig, h] of handlers) process.on(sig, h);
  const done = [];
  try {
    for (const id of ids) {
      const row = all.find((r) => r.t.id === id);
      if (!row) { console.error(`${id}: not eligible (same filters as plan: repo task, not ops/risky, not deep, interactive)`); continue; }
      const { t: task } = row;
      try {
        const prompt = fullPrompt(task);
        if (!prompt || RISKY.test(prompt)) throw new Error('prompt not found or risky');
        const tier = row.tier;
        const commit = git(task.project, 'rev-list', '-1', `--before=${task.start}`, 'HEAD').stdout.trim() || git(task.project, 'rev-parse', 'HEAD').stdout.trim();
        const cheapTier = TIERS[tier - 1], upTier = TIERS[tier];
        const budgetOf = (tr) => Math.max(MIN_BUDGET, 2 * repriced(task, policy.tiers[tr].model));
        const a = await replay(task, cheapTier, prompt, policy, commit, scratch, budgetOf(cheapTier));
        const b = await replay(task, upTier, prompt, policy, commit, scratch, budgetOf(upTier));
        const body = `${judgeRubric()}\n\n## Task prompt\n${prompt}\n\n## A (${cheapTier}) final message\n${a.text}\n\n## A diff\n${a.diff}\n\n## B (${upTier}) final message\n${b.text}\n\n## B diff\n${b.diff}\n`;
        const j = await runClaude(['-p', '--model', 'sonnet', '--output-format', 'json', '--settings', '{"disableAllHooks": true}', '--tools', '', ...ISOLATION, '--max-budget-usd', (2 * JUDGE_ALLOWANCE).toFixed(2)], body, scratch);
        const v = j.ok && /\{[\s\S]*\}/.exec(j.text);
        const verdict = v ? JSON.parse(v[0]) : null;
        if (!verdict || !['same', 'cheap_worse', 'cheap_better'].includes(verdict.verdict)) throw new Error('judge returned no usable verdict');
        const rec = { ts: new Date().toISOString(), taskId: id, kind: row.kind, cheapTier, upTier, verdict: verdict.verdict, reason: String(verdict.reason ?? '').slice(0, 300), costUsd: a.cost + b.cost + j.cost };
        fs.appendFileSync(sub('shadow', 'results.jsonl'), JSON.stringify(rec) + '\n');
        done.push(rec);
        console.log(`${id}: ${rec.verdict} (${rec.reason}) $${rec.costUsd.toFixed(2)}`);
      } catch (e) {
        console.error(`${id}: ${e.message}`);
      }
    }
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
    releaseAll();
  }
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  try {
    if (a[0] === 'plan') printPlan(plan({ n: Number(val('--n') ?? 5) }));
    else if (a[0] === 'run') {
      const i = a.indexOf('--ids');
      const ids = i < 0 ? [] : a.slice(i + 1).filter((x, k, arr) => !x.startsWith('--') && arr.slice(0, k).every((y) => !y.startsWith('--'))).flatMap((x) => x.split(','));
      if (!ids.length) throw new Error('run needs --ids <id,id>');
      if (!a.includes('--yes')) { console.log('Dry run (no --yes). Would replay: ' + ids.join(', ')); printPlan(plan({ n: 1000 }).filter((r) => ids.includes(r.id))); }
      else await run(ids);
    } else console.log('usage: shadow.mjs plan [--n 5] | run --ids <id,id> [--yes]');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
