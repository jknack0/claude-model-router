import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ph-'));
process.env.ROUTER_DATA_DIR = path.join(tmp, 'data');
process.env.ROUTER_CLAUDE_DIR = path.join(tmp, 'claude');
const { classify, loadPolicy, tierFor } = await import('../plugin/scripts/lib/classify.mjs');
const { buildSession } = await import('../plugin/scripts/lib/ingest.mjs');
const { buildStats } = await import('../plugin/scripts/lib/policy.mjs');
const phasesLib = await import('../plugin/scripts/lib/phases.mjs');
const { phaseRows, briefStats } = phasesLib;
const SPAWN = path.resolve(import.meta.dirname, '../plugin/scripts/spawn.mjs');
const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');

// ---- 10a: classifier ----
const cases = [
  ['read PROJ-123 and find everything about it in jira, confluence and slack', 'gather', 'standard'],
  ['which existing integration pattern does this fit', 'pattern-fit', 'deep'],
  ['create an implementation plan and a high level estimate', 'plan', 'deep'],
  ['implement step 3 of docs/plan.md', 'implement-step', 'standard'],
  ['scaffold the client boilerplate per step 2 of plan.md', 'implement-step', 'fast'],
  ['review the plan and poke holes in it', 'plan-review', 'deep'],
  ['summarize the vendor spec for me', 'doc-intake', 'standard'],
  ['just summarize the vendor spec', 'doc-intake', 'standard'], // never fast
  ['write a runbook for the sync job', 'write-guide', 'standard'],
  ['the build is failing with a type error', 'debug', 'deep'], // generic rules unchanged
];
for (const [prompt, kind, tier] of cases) {
  test(`phase: ${prompt}`, () => {
    const r = classify(prompt);
    assert.equal(r.kind, kind);
    assert.equal(tierFor(r, loadPolicy()), tier);
  });
}

test('phase: a long brief is not bumped up, and a user policy.json without phase kinds still routes them', () => {
  assert.equal(tierFor(classify('implement step 3 of plan.md. ' + 'detail '.repeat(300)), loadPolicy()), 'standard');
  fs.writeFileSync(path.join(process.env.ROUTER_DATA_DIR, 'policy.json'), JSON.stringify({ kinds: { debug: 'deep' }, tiers: loadPolicy().tiers }));
  assert.equal(tierFor(classify('which pattern fits'), loadPolicy()), 'deep');
  fs.rmSync(path.join(process.env.ROUTER_DATA_DIR, 'policy.json'));
});

// ---- 10b: spawn hook ----
const mkDir = () => fs.mkdtempSync(path.join(tmp, 'd-'));
const hook = (dir, tool_input, extra = {}) => {
  const r = spawnSync('node', [SPAWN], { input: JSON.stringify({ session_id: 's1', cwd: path.join(tmp, 'proj'), tool_name: 'Agent', tool_use_id: 'tu1', tool_input, ...extra }), encoding: 'utf8', env: { ...process.env, ROUTER_DATA_DIR: dir } });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const evs = (dir) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const brief = { description: 'implement the client', prompt: 'implement step 3 of docs/plan.md', subagent_type: 'general-purpose' };
const installPlugin = (name, version) => {
  const root = path.join(process.env.ROUTER_CLAUDE_DIR, 'plugins/cache/mk', name, version);
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name }));
  setInstalled(name, root);
  return root;
};
const setInstalled = (name, installPath) => {
  const f = path.join(process.env.ROUTER_CLAUDE_DIR, 'plugins/installed_plugins.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let cur = { version: 2, plugins: {} };
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  cur.plugins[`${name}@mk`] = [{ scope: 'user', installPath, version: '1' }];
  fs.writeFileSync(f, JSON.stringify(cur));
};
const agent = (root, name, fm) => { fs.mkdirSync(path.join(root, 'agents'), { recursive: true }); fs.writeFileSync(path.join(root, 'agents', `${name}.md`), `---\nname: ${name}\n${fm}\n---\nbody\n`); };

test('spawn: unknown or inherit agent gets routed; updatedInput keeps every field', () => {
  const d = mkDir();
  const out = hook(d, { ...brief, run_in_background: true });
  assert.equal(out.permissionDecision, 'allow');
  assert.deepEqual(out.updatedInput, { ...brief, run_in_background: true, model: 'sonnet' });
  assert.equal(out.updatedInput.effort, undefined);
  agent(process.env.ROUTER_CLAUDE_DIR, 'helper', 'model: inherit');
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'helper' }).updatedInput.model, 'sonnet');
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'router:deep' }), null); // picking router:deep is an escalation: left alone
  assert.equal(hook(mkDir(), { ...brief, subagent_type: undefined }).updatedInput.model, 'sonnet'); // no type means general-purpose
  const e = evs(d)[0];
  assert.deepEqual([e.type, e.phase, e.tier, e.model, e.set, e.toolUseId, e.hash], ['spawn', 'implement-step', 'standard', 'sonnet', true, 'tu1', sha(brief.prompt)]);
});

test('spawn: explicit model, pinned frontmatter and built-ins are left alone, with no output', () => {
  const d = mkDir();
  assert.equal(hook(d, { ...brief, model: 'opus' }), null);
  agent(process.env.ROUTER_CLAUDE_DIR, 'pinned', 'model: haiku');
  assert.equal(hook(d, { ...brief, subagent_type: 'pinned' }), null);
  agent(path.join(tmp, 'proj', '.claude'), 'local', 'model: sonnet');
  assert.equal(hook(d, { ...brief, subagent_type: 'local' }), null);
  assert.equal(hook(d, { ...brief, subagent_type: 'Explore' }), null);
  assert.equal(hook(d, { ...brief, subagent_type: 'claude-code-guide' }), null); // not found: fail closed
  assert.equal(hook(d, { ...brief, subagent_type: 'nobody' }), null);
  const pl = installPlugin('orch', '1.0.0');
  agent(pl, 'scout', 'model: haiku');
  assert.equal(hook(d, { ...brief, subagent_type: 'orch:scout' }), null);
  assert.deepEqual(evs(d).map((e) => [e.set, e.reason]), [[false, 'explicit model'], ...Array(6).fill([false, 'agent pins a model'])]);
  // spawnOverride lets the router re-tier a pinned agent
  const d2 = mkDir();
  fs.writeFileSync(path.join(d2, 'policy.json'), JSON.stringify({ ...loadPolicy(), spawnOverride: ['pinned'] }));
  assert.equal(hook(d2, { ...brief, subagent_type: 'pinned' }).updatedInput.model, 'sonnet');
});

test('spawn: nothing to route and nothing to add prints nothing', () => {
  const d = mkDir();
  assert.equal(hook(d, { description: 'x', prompt: 'ok' }), null);
  assert.equal(evs(d)[0].set, false);
  assert.equal(spawnSync('node', [SPAWN], { input: 'garbage', encoding: 'utf8', env: { ...process.env, ROUTER_DATA_DIR: mkDir() } }).stdout, '');
});

test('spawn: gather gets the index line unless the brief already writes files', () => {
  const g = { description: 'gather ticket', prompt: 'read PROJ-123 and find everything about it in jira and slack', subagent_type: 'general-purpose' };
  const out = hook(mkDir(), g);
  assert.equal(out.updatedInput.model, 'sonnet');
  assert.match(out.updatedInput.prompt, /\(Router: write what you find to markdown files .* at most 20 lines/);
  assert.equal(hook(mkDir(), { ...g, prompt: g.prompt + '. Save everything to files in ./notes' }).updatedInput.prompt.includes('(Router:'), false);
  // an explicit model still gets the note, and keeps its model
  const ex = hook(mkDir(), { ...g, model: 'haiku' });
  assert.equal(ex.updatedInput.model, 'haiku');
  assert.ok(ex.updatedInput.prompt.includes('(Router:'));
});

test('spawn: a brief over 4000 chars gets the note, never blocked', () => {
  const out = hook(mkDir(), { ...brief, prompt: brief.prompt + ' ' + 'x'.repeat(4100) });
  assert.match(out.additionalContext, /^\[router\] this subagent brief is 4\d{3} chars; subagent context is the main cost/);
  assert.equal(out.permissionDecision, 'allow');
  assert.equal(hook(mkDir(), { ...brief, model: 'opus', prompt: 'y'.repeat(4001) }).updatedInput.model, 'opus');
});

test('spawn: re-spawning the same brief escalates one tier above the earlier run, capped at deep', () => {
  const d = mkDir();
  const b = { description: 'find loader', prompt: 'find where the config loader is defined in the repo', subagent_type: 'general-purpose' };
  assert.equal(hook(d, b).updatedInput.model, 'haiku');
  assert.equal(hook(d, b).updatedInput.model, 'sonnet');
  assert.equal(hook(d, b).updatedInput.model, 'opus');
  assert.equal(hook(d, b).updatedInput.model, 'opus');
  assert.equal(evs(d)[1].reason, 'recon, escalated');
  // a different brief, or the same one in another session, is not escalated
  assert.equal(hook(d, { ...b, prompt: 'locate the webhook retry handler' }).updatedInput.model, 'haiku');
  assert.equal(hook(d, b, { session_id: 's2' }).updatedInput.model, 'haiku');
  const lines = fs.readFileSync(path.join(d, 'state/s1.spawns.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  assert.ok(JSON.parse(lines[0]).hash);
});

test('spawn: explores one tier cheaper only with thin evidence and marks the event', () => {
  const d = mkDir();
  fs.writeFileSync(path.join(d, 'policy.json'), JSON.stringify({ ...loadPolicy(), explore: 1, counts: { 'implement-step': { fast: 0, standard: 20, deep: 0 } } }));
  const out = hook(d, brief);
  assert.equal(out.updatedInput.model, 'haiku');
  assert.deepEqual([evs(d)[0].explore, evs(d)[0].tier], [true, 'fast']);
  const d2 = mkDir();
  fs.writeFileSync(path.join(d2, 'policy.json'), JSON.stringify({ ...loadPolicy(), explore: 1, counts: { 'doc-intake': { fast: 0, standard: 20, deep: 0 } } }));
  assert.equal(hook(d2, { description: 'x', prompt: 'summarize the vendor spec' }).updatedInput.model, 'sonnet'); // floor: never fast
});

test('spawn: finishes well inside the 150 ms budget', () => {
  const d = mkDir();
  hook(d, brief); // warm file caches
  const t = process.hrtime.bigint();
  hook(d, brief);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 150, `took ${ms.toFixed(0)} ms`);
});

// ---- 10c: ledger, learning, report ----
const u = (ts, text, id) => JSON.stringify({ type: 'user', uuid: id, sessionId: 'sp', timestamp: ts, cwd: '/x', message: { role: 'user', content: text } });
const a = (id, ts, model, content) => JSON.stringify({ type: 'assistant', uuid: id, sessionId: 'sp', timestamp: ts, requestId: id, message: { id, model, role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1 } } });

test('ingest: attaches spawn events by toolUseId, else description hash, and marks escalated runs', () => {
  const proj = path.join(tmp, 'projects/-x');
  const sd = path.join(proj, 'sp/subagents');
  fs.mkdirSync(sd, { recursive: true });
  const T = '2026-10-01T10:00:0';
  fs.writeFileSync(path.join(proj, 'sp.jsonl'), [
    u(`${T}0.000Z`, 'build it', 'u1'),
    a('m1', `${T}1.000Z`, 'claude-opus-5-5', [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'general-purpose' } }, { type: 'tool_use', id: 'tu2', name: 'Agent', input: { subagent_type: 'general-purpose' } }]),
  ].join('\n') + '\n');
  const put = (id, meta, ts, model, text) => {
    fs.writeFileSync(path.join(sd, `agent-${id}.jsonl`), a(`s${id}`, ts, model, [{ type: 'text', text }]) + '\n');
    fs.writeFileSync(path.join(sd, `agent-${id}.meta.json`), JSON.stringify(meta));
  };
  put('a1', { agentType: 'general-purpose', description: 'step one client', toolUseId: 'tu1' }, `${T}2.000Z`, 'claude-haiku-5-5', 'STATUS: blocked');
  put('a2', { agentType: 'general-purpose', description: 'zebra stripes qq' }, `${T}3.000Z`, 'claude-sonnet-5-5', 'STATUS: done');
  const spawn = (o) => ({ ts: `${T}1.500Z`, type: 'spawn', sessionId: 'sp', ...o });
  const s = buildSession(path.join(proj, 'sp.jsonl'), { sp: [
    spawn({ toolUseId: 'tu1', phase: 'implement-step', tier: 'fast', set: true, explore: true, briefChars: 5000 }),
    spawn({ toolUseId: 'other', descHash: sha('zebra stripes qq'), phase: 'gather', tier: 'standard', briefChars: 100 }),
    { ts: `${T}0.500Z`, sessionId: 'sp', kind: 'feature', tier: 'standard', boundary: true },
  ] });
  const [x, y] = s.tasks[0].subagents;
  assert.deepEqual([x.routedPhase, x.routedTier, x.routedSet, x.explore, x.briefChars, x.escalated], ['implement-step', 'fast', true, true, 5000, true]);
  assert.deepEqual([y.routedPhase, y.routedTier, y.routedSet, y.explore, y.escalated], ['gather', 'standard', false, false, undefined]);
  assert.equal(s.tasks[0].routed.length, 1); // spawn events are not prompt events
  assert.equal(briefStats(s.tasks[0].subagents).n, 1);
});

test('policy: routed subagents are (phase, tier) samples; blocked or escalated-away runs fail', () => {
  const sa = (model, o) => ({ type: 'general-purpose', model, status: 'done', description: 'x', cost: { total: 1 }, ctxP50: 1000, routedPhase: 'implement-step', routedSet: true, ...o });
  const t = { prompts: [{ preview: 'zzz' }], subagents: [sa('claude-sonnet-5-5'), sa('claude-sonnet-5-5', { status: 'blocked' }), sa('claude-haiku-5-5', { escalated: true }), sa('claude-haiku-5-5', { routedPhase: undefined }), sa('claude-haiku-5-5', { routedSet: false })], routed: [], evidence: false, signals: { corrections: 0, escalations: 0 }, total: 1, id: 't', headless: false, mainModels: {} };
  const st = buildStats([t], [], { kinds: { 'implement-step': 'standard' } })['implement-step'];
  assert.deepEqual([st.standard.n, st.standard.succ, st.fast.n, st.fast.succ], [2, 1, 1, 0]);
  const rows = phaseRows(t.subagents);
  assert.deepEqual(rows.find((r) => r.phase === 'implement-step' && r.model === 'sonnet').success, 0.5);
});

test('spawn: the next plan step is new work, but a reworded retry of the same step escalates', () => {
  const d = mkDir();
  const step = (n, verb = 'implement') => ({ description: `step ${n}`, prompt: `${verb} step ${n} of docs/plan.md for the payments client`, subagent_type: 'general-purpose' });
  hook(d, step(1));
  hook(d, step(2));
  hook(d, step(3));
  hook(d, step(2, 'please redo'));
  const e = evs(d).filter((x) => x.type === 'spawn');
  assert.deepEqual(e.slice(0, 3).map((x) => x.reason.includes('escalated')), [false, false, false]);
  assert.match(e[3].reason, /escalated/);
});

test('phases: old subagents with only a short label count as unrouted', () => {
  const { phaseOf } = phasesLib;
  assert.equal(phaseOf({ description: 'Worker A: ledger + report' }), 'unrouted');
  assert.equal(phaseOf({ routedPhase: 'gather', description: 'x' }), 'gather');
});

// ---- wave 3 (R4) ----
const R4 = [
  // [brief, kind, tier]: briefs that used to be mis-routed
  ['Investigate why the parser fails on UTF-8 input and fix it', 'debug', 'deep'],
  ['Fix the bug described in PROJ-412: the import drops rows', 'debug', 'deep'],
  ['Root-cause the deadlock in the queue worker; the ticket has repro steps', 'debug', 'deep'],
  ['Root-cause the deadlock in the queue worker and leave some slack in the timeout', 'debug', 'deep'],
  ['Debug the race condition in the scheduler. Read CLAUDE.md first, then implement a fix.', 'debug', 'deep'],
  ['Review the auth middleware for security issues and summarize findings', 'review', 'deep'],
  ['Design the caching architecture for the API and summarize the tradeoffs', 'design', 'deep'],
  ['Implement step 3 of plan.md: refactor the sync engine to the new event-sourced model, rename the old reducers and stub the legacy adapter', 'implement-step', 'standard'],
  ['Implement step 4 of plan.md: wire up the new websocket transport with reconnection, backpressure and ordering guarantees', 'implement-step', 'standard'],
  ['Refactor the session store per the plan; move files into src/store', 'implement-step', 'standard'],
  ['Scaffold the client boilerplate per step 2 of plan.md', 'implement-step', 'fast'],
  ['Gather everything about PROJ-12 from jira', 'gather', 'standard'],
  ['Research the retry policy in confluence', 'gather', 'standard'],
  ['Summarize the vendor spec', 'doc-intake', 'standard'],
  ['Write a SHA-256 function and gather the old ones', 'feature', 'standard'], // no source: not gather
];
for (const [prompt, kind, tier] of R4) {
  test(`R4 classify: ${prompt.slice(0, 70)}`, () => {
    const r = classify(prompt);
    assert.deepEqual([r.kind, tierFor(r, loadPolicy())], [kind, tier]);
  });
}
test('R4 classify: a key or "slack" alone is not gather; a long scaffold brief is not fast', () => {
  assert.notEqual(classify('Open PROJ-123').kind, 'gather');
  assert.notEqual(classify('Add a wrapper function with some slack').kind, 'gather');
  assert.equal(classify('Rename the helpers per step 2 of plan.md. ' + 'detail '.repeat(80)).kind, 'implement-step');
  assert.equal(tierFor(classify('Rename the helpers per step 2 of plan.md. ' + 'detail '.repeat(80)), loadPolicy()), 'standard');
  assert.equal(tierFor(classify('Move the files per step 2 of plan.md, fix the failing build'), loadPolicy()), 'deep'); // debug word wins
});

test('spawn: fix-it briefs are not gather, so no markdown note is appended', () => {
  const out = hook(mkDir(), { description: 'fix parser', prompt: 'Investigate why the parser fails on UTF-8 input and fix it', subagent_type: 'general-purpose' });
  assert.equal(out.updatedInput.model, 'opus');
  assert.equal(out.updatedInput.prompt.includes('(Router:'), false);
});

test('spawn: only Agent and Task calls are touched', () => {
  const d = mkDir();
  assert.equal(hook(d, brief, { tool_name: 'Bash' }), null);
  assert.equal(hook(d, brief, { tool_name: undefined }), null);
  assert.equal(fs.existsSync(path.join(d, 'events.jsonl')), false);
  assert.equal(hook(d, brief, { tool_name: 'Task' }).updatedInput.model, 'sonnet');
  const hooks = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../plugin/hooks/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'Agent|Task');
});

test('spawn: parallel distinct briefs with no anchors are not escalated, and neither is another subagent_type', () => {
  const d = mkDir();
  const b = (svc) => ({ description: 'tests', prompt: `Write unit tests for the ${svc} service covering the happy path and boundary inputs`, subagent_type: 'general-purpose' });
  assert.deepEqual(['invoices', 'customers', 'shipments'].map((s) => hook(d, b(s)).updatedInput.model), ['sonnet', 'sonnet', 'sonnet']);
  const r = { description: 'find loader', prompt: 'find where the config loader is defined in the repo', subagent_type: 'general-purpose' };
  assert.equal(hook(d, r).updatedInput.model, 'haiku');
  agent(process.env.ROUTER_CLAUDE_DIR, 'other', 'description: x');
  assert.equal(hook(d, { ...r, subagent_type: 'other' }).updatedInput.model, 'haiku'); // same hash, different type
  assert.equal(hook(d, r).updatedInput.model, 'sonnet'); // same hash and type
});

test('spawn: a reworded retry with the same anchors escalates; one that adds a path does not', () => {
  const d = mkDir();
  const t = { description: 'retry handler', subagent_type: 'general-purpose' };
  const p1 = 'Implement step 3 of docs/plan.md: add the retry handler to the payments client';
  assert.equal(hook(d, { ...t, prompt: p1 }).updatedInput.model, 'sonnet');
  assert.equal(hook(d, { ...t, prompt: 'Please implement step 3 of docs/plan.md and add the retry handler to the payments client' }).updatedInput.model, 'opus');
  assert.equal(hook(d, { ...t, prompt: p1 + '; also touch src/sync/retry.ts around line 42' }).updatedInput.model, 'sonnet');
});

test('spawn: six concurrent hooks leave six records', async () => {
  const d = mkDir();
  const run = (i) => new Promise((resolve) => {
    const c = spawn('node', [SPAWN], { env: { ...process.env, ROUTER_DATA_DIR: d } });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify({ session_id: 'cc', tool_name: 'Agent', tool_input: { description: `d${i}`, prompt: `find where thing number ${i} lives in the repo`, subagent_type: 'general-purpose' } }));
  });
  await Promise.all([0, 1, 2, 3, 4, 5].map(run));
  assert.equal(fs.readFileSync(path.join(d, 'state/cc.spawns.jsonl'), 'utf8').trim().split('\n').length, 6);
  assert.equal(evs(d).length, 6);
});

test('spawn: agent lookup goes by frontmatter name, project before user, BOM stripped, unknown left alone', () => {
  const cd = process.env.ROUTER_CLAUDE_DIR, proj = path.join(tmp, 'proj');
  const w = (dir, file, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  w(path.join(cd, 'agents'), 'auditor.md', '---\nname: security-auditor\nmodel: opus\n---\nx');
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'security-auditor' }), null);
  w(path.join(cd, 'agents'), 'arch.md', '---\nname: arch\n---\nx'); // user copy: unpinned
  w(path.join(proj, '.claude/agents'), 'arch.md', '---\nname: arch\nmodel: opus\n---\nx'); // project copy wins
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'arch' }), null);
  w(path.join(cd, 'agents'), 'bom.md', '﻿---\nname: bom\nmodel: haiku\n---\nx');
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'bom' }), null);
  w(path.join(cd, 'agents'), 'free.md', '---\nname: free\ndescription: y\n---\nx');
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'free' }).updatedInput.model, 'sonnet');
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'ghost' }), null);
  assert.equal(hook(mkDir(), { ...brief, subagent_type: 'ghost:thing' }), null);
});

test('spawn: plugin agents resolve through installed_plugins.json, honour a custom agents path, and follow upgrades', () => {
  const d = mkDir(); // one data dir, so the lookup cache is exercised
  const v1 = installPlugin('cust', '1.0.0');
  fs.writeFileSync(path.join(v1, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'cust', agents: ['./roles'] }));
  fs.mkdirSync(path.join(v1, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(v1, 'roles/lead.md'), '---\nname: lead\nmodel: opus\n---\nx');
  assert.equal(hook(d, { ...brief, subagent_type: 'cust:lead' }), null);
  // upgrade: the new install path has an unpinned lead
  const v2 = path.join(process.env.ROUTER_CLAUDE_DIR, 'plugins/cache/mk/cust/2.0.0');
  fs.mkdirSync(path.join(v2, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(v2, '.claude-plugin/plugin.json'), '{}');
  agent(v2, 'lead', 'description: y');
  setInstalled('cust', v2);
  const f = path.join(process.env.ROUTER_CLAUDE_DIR, 'plugins/installed_plugins.json');
  fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(hook(d, { ...brief, subagent_type: 'cust:lead' }).updatedInput.model, 'sonnet');
  // not installed at all: left alone
  assert.equal(hook(d, { ...brief, subagent_type: 'missing:lead' }), null);
});

test('spawn: a 200KB brief still prints complete JSON', () => {
  const prompt = brief.prompt + ' ' + 'lorem ipsum '.repeat(17000);
  const r = spawnSync('node', [SPAWN], { input: JSON.stringify({ session_id: 'big', tool_name: 'Agent', tool_input: { ...brief, prompt } }), encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ROUTER_DATA_DIR: mkDir() } });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.updatedInput.prompt, prompt);
  assert.match(out.additionalContext, /brief is 2\d{5} chars/);
});

test('spawn: a 300K-char single token finishes inside 150 ms', () => {
  const d = mkDir();
  const input = JSON.stringify({ session_id: 'rx', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'a'.repeat(300_000) + '.md', subagent_type: 'general-purpose' } });
  spawnSync('node', [SPAWN], { input: JSON.stringify({ tool_name: 'Agent', tool_input: brief }), env: { ...process.env, ROUTER_DATA_DIR: d } }); // warm
  const t = process.hrtime.bigint();
  const r = spawnSync('node', [SPAWN], { input, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ROUTER_DATA_DIR: d } });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(r.status, 0);
  assert.ok(ms < 150, `took ${ms.toFixed(0)} ms`);
});
