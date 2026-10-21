import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../plugin/scripts');
export const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'router-c-'));
const { wilson, buildStats, propose, effectiveTier, countsOf, samplesOf } = await import('../plugin/scripts/lib/policy.mjs');

// a task shaped like a session-file task
export const task = (o = {}) => ({
  idx: 0, boundary: 'start', start: new Date().toISOString(), end: new Date().toISOString(),
  prompts: [{ ts: 't', hash: 'h', preview: o.preview ?? 'where is the config loaded' }],
  mainModels: { [o.model ?? 'claude-haiku-5-5']: 1 }, mainEffort: 'low',
  main: { requests: 1, cost: { total: 1 }, ctxP50: 1, ctxMax: 1, reqs: [[o.model ?? 'claude-haiku-5-5', 1000, 0, 0, 0, 100]] },
  subagents: o.subagents ?? [], routed: o.kind ? [{ kind: o.kind, ...(o.routedTier && { tier: o.routedTier }) }] : [], evidence: o.evidence ?? true,
  signals: { corrections: 0, toolErrors: 0, denials: 0, bashFails: 0, escalations: 0, ...o.signals }, total: o.total ?? 1, id: o.id ?? Math.random().toString(36),
});
const policy = { target: 0.8, minN: 8, kinds: { recon: 'standard', debug: 'standard', question: 'fast', chat: null } };
const many = (n, o) => Array.from({ length: n }, () => task(o));

test('wilson lower bound', () => {
  assert.equal(wilson(0, 0), 0);
  assert.ok(wilson(10, 10) > 0.8 && wilson(10, 10) < 1);
  assert.ok(wilson(8, 10) < wilson(80, 100));
});

test('effective tier is the main model, whatever helpers ran', () => {
  assert.equal(effectiveTier(task()), 0);
  assert.equal(effectiveTier(task({ model: 'claude-opus-5-5', subagents: [{ model: 'claude-haiku-5-5' }] })), 2);
});

const sub = (model, o = {}) => ({ type: 'router:fast', model, status: 'done', description: 'x', ...o });
const cell = (ts, kind, tier) => buildStats(ts, [], policy)[kind]?.[tier];

test('R2#1: an escalation charges the failure to the lowest tier, the rescuer gets a success only if the task worked', () => {
  const esc = (o) => task({ kind: 'recon', model: 'claude-sonnet-5-5', signals: { escalations: 1 }, subagents: [sub('claude-haiku-5-5', { status: 'blocked' }), sub('claude-sonnet-5-5', { type: 'router:standard' })], ...o });
  assert.deepEqual(samplesOf(esc()).map((x) => x.slice(0, 2)), [[0, 0], [1, 1]]);
  const s = buildStats([esc()], [], policy);
  assert.deepEqual([s.recon.fast.n, s.recon.fast.succ, s.recon.standard.n, s.recon.standard.succ], [1, 0, 1, 1]);
  // the rescuer also failed: the lower tier is still charged, the higher tier gets nothing
  const bad = esc({ subagents: [sub('claude-haiku-5-5', { status: 'blocked' }), sub('claude-sonnet-5-5', { status: 'partial' })] });
  assert.deepEqual(samplesOf(bad).map((x) => x.slice(0, 2)), [[0, 0]]);
  // the user corrected afterwards: no credit for the rescuer either
  assert.deepEqual(samplesOf(esc({ signals: { escalations: 1, corrections: 1 } })).map((x) => x.slice(0, 2)), [[0, 0]]);
});

test('R2#2: helpers do not define the tier; routed work must match the routed tier', () => {
  // haiku scout under an opus main, no routed event: scored at deep (the main model), never fast
  const t = task({ kind: 'debug', model: 'claude-opus-5-5', subagents: [sub('claude-haiku-5-5', { type: 'orch:scout' })] });
  t.routed = [];
  assert.deepEqual(samplesOf(t).map((x) => x[0]), [2]);
  // routed fast and a haiku subagent ran with none higher: counts at fast (spec: subagent at the routed tier, none above)
  const ok = task({ kind: 'recon', routedTier: 'fast', model: 'claude-haiku-5-5', subagents: [sub('claude-haiku-5-5')] });
  assert.deepEqual(samplesOf(ok).map((x) => x[0]), [0]);
  // a higher tier also ran: not a fast sample
  assert.deepEqual(samplesOf(task({ kind: 'recon', routedTier: 'fast', subagents: [sub('claude-haiku-5-5'), sub('claude-sonnet-5-5')] })), []);
  // no subagents: main model must be at the routed tier
  assert.deepEqual(samplesOf(task({ kind: 'recon', routedTier: 'standard', model: 'claude-haiku-5-5' })), []);
  assert.deepEqual(samplesOf(task({ kind: 'recon', routedTier: 'fast', model: 'claude-haiku-5-5' })).map((x) => x[0]), [0]);
  // eight clean opus-main tasks with a haiku scout no longer make fast look good
  const many8 = Array.from({ length: 8 }, () => task({ kind: 'debug', model: 'claude-opus-5-5', subagents: [sub('claude-haiku-5-5')] }));
  assert.equal(cell(many8, 'debug', 'fast'), undefined);
});

test('R2#8: tasks without evidence do not score; only a shadow verdict does', () => {
  const none = many(10, { kind: 'recon', evidence: false });
  assert.deepEqual(buildStats(none, [], policy), {});
  const shadow = [{ taskId: none[0].id, kind: 'recon', cheapTier: 'fast', verdict: 'same' }];
  const s = buildStats(none, shadow, policy);
  assert.deepEqual([s.recon.fast.n, s.recon.fast.succ], [1, 1]);
});

test('non-interactive sessions are excluded from learning', () => {
  assert.deepEqual(buildStats(many(10, { kind: 'recon' }).map((t) => ({ ...t, headless: true })), [], policy), {});
});

test('propose: move down one tier on evidence, up on struggle, otherwise keep', () => {
  const stats = buildStats([...many(10, { kind: 'recon' }), ...many(10, { kind: 'debug', model: 'claude-sonnet-5-5', signals: { corrections: 1 } }), ...many(3, { kind: 'question' })], [], policy);
  assert.equal(stats.recon.fast.n, 10);
  const moves = propose(stats, policy);
  assert.deepEqual(moves.map((m) => [m.kind, m.from, m.to]), [['recon', 'standard', 'fast'], ['debug', 'standard', 'deep']]);
  assert.match(moves[0].evidence, /lb=/);
  assert.deepEqual(countsOf(stats, policy).recon, { fast: 10, standard: 0, deep: 0 });
});

test('R2#7: a shadow verdict replaces the task sample and counts as one', () => {
  const ts = many(10, { kind: 'recon' });
  const shadow = [{ taskId: ts[0].id, kind: 'recon', cheapTier: 'fast', verdict: 'cheap_worse' }];
  const s = buildStats(ts, shadow, policy);
  assert.equal(s.recon.fast.n, 9 + 1);
  assert.equal(s.recon.fast.succ, 9);
  // three judged replays alone are n=3, far from minN
  const three = Array.from({ length: 3 }, (_, i) => ({ taskId: `x${i}`, kind: 'recon', cheapTier: 'fast', verdict: 'same' }));
  assert.equal(buildStats([], three, policy).recon.fast.n, 3);
  assert.deepEqual(propose(buildStats([], three, policy), policy), []);
});

test('learn.mjs --apply writes the move, history and counts; dry run leaves policy alone', () => {
  const dir = mk();
  const env = { ...process.env, ROUTER_DATA_DIR: dir, ROUTER_PROJECTS_DIR: path.join(dir, 'none') };
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions/abcdefgh.json'), JSON.stringify({ sessionId: 'abcdefgh', project: '/x', tasks: many(10, { kind: 'recon' }).map((t, i) => ({ ...t, idx: i })) }));
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ tiers: { fast: { model: 'haiku', effort: 'low' }, standard: { model: 'sonnet', effort: 'medium' }, deep: { model: 'opus', effort: 'high' } }, kinds: { recon: 'standard', chat: null } }));
  const dry = spawnSync('node', [path.join(root, 'learn.mjs')], { env, encoding: 'utf8' });
  assert.match(dry.stdout, /recon: standard -> fast/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'))).kinds.recon, 'standard');
  spawnSync('node', [path.join(root, 'learn.mjs'), '--apply'], { env, encoding: 'utf8' });
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json')));
  assert.equal(p.kinds.recon, 'fast');
  assert.equal(p.history[0].from, 'standard');
  assert.equal(p.counts.recon.fast, 10);
});

// ---- route.mjs: exploration and topic boundary ----
const route = (dir, input) => spawnSync('node', [path.join(root, 'route.mjs')], { input: JSON.stringify({ session_id: 's', transcript_path: '/nonexistent', ...input }), env: { ...process.env, ROUTER_DATA_DIR: dir }, encoding: 'utf8' });
const events = (dir) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const withPolicy = (dir, extra) => {
  const tpl = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../plugin/templates/policy.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ ...tpl, ...extra }));
};

test('route: explores one tier cheaper only with thin evidence, and marks the event', () => {
  const dir = mk();
  withPolicy(dir, { explore: 1, counts: { debug: { fast: 0, standard: 0, deep: 20 } } });
  route(dir, { prompt: 'the build is failing with a type error' });
  const e = events(dir)[0];
  assert.deepEqual([e.explore, e.tier], [true, 'standard']);

  const d2 = mk(); // enough evidence at the cheaper tier: no trial
  withPolicy(d2, { explore: 1, counts: { debug: { fast: 0, standard: 8, deep: 20 } } });
  route(d2, { prompt: 'the build is failing with a type error' });
  assert.deepEqual([events(d2)[0].explore, events(d2)[0].tier], [false, 'deep']);

  const d3 = mk(); // no counts yet (no learn run): never explores
  withPolicy(d3, { explore: 1 });
  route(d3, { prompt: 'the build is failing with a type error' });
  assert.equal(events(d3)[0].explore, false);
});

test('route: low keyword overlap marks boundary topic; overlap does not', () => {
  const dir = mk();
  route(dir, { prompt: 'refactor the payment webhook handler retries' });
  route(dir, { prompt: 'payment webhook handler needs better logging' });
  route(dir, { prompt: 'rewrite the onboarding carousel animation timing' });
  const ev = events(dir);
  assert.equal(ev[0].boundary, true);
  assert.equal(ev[1].boundary, false);
  assert.equal(ev[2].boundary, 'topic');
});

// ---- ingest: topic matching, evidence, escalation, headless ----
const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
const u = (id, ts, text, extra = {}) => JSON.stringify({ type: 'user', uuid: id, sessionId: 'tt', timestamp: ts, cwd: '/x', message: { role: 'user', content: text }, ...extra });
const a = (id, ts, model = 'claude-haiku-5-5') => JSON.stringify({ type: 'assistant', uuid: id, sessionId: 'tt', timestamp: ts, requestId: id, effort: 'low', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
async function build(lines, events, name = 'tt') {
  const dir = mk();
  process.env.ROUTER_DATA_DIR = dir;
  const { buildSession } = await import('../plugin/scripts/lib/ingest.mjs');
  const f = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return { s: buildSession(f, { [name]: events }), dir, f };
}
const T0 = '2026-10-01T10:00:00.000Z';

test('R2#3: a topic event splits at its own prompt (hook stamps after the prompt), by hash then by time', async () => {
  const p2 = 'totally different subject now';
  const lines = [u('1', T0, 'first topic prompt here'), a('2', '2026-10-01T10:00:05.000Z'), u('3', '2026-10-01T10:05:02.000Z', p2), a('4', '2026-10-01T10:05:08.000Z'), u('5', '2026-10-01T10:05:20.000Z', 'another unrelated request entirely'), a('6', '2026-10-01T10:05:25.000Z')];
  const ev = (o) => [{ ts: T0, sessionId: 'tt', kind: 'recon', boundary: true }, { ts: '2026-10-01T10:05:02.140Z', sessionId: 'tt', kind: 'debug', boundary: 'topic', ...o }];
  // by hash; the event follows prompt 3 by 140 ms and prompt 5 is not mistaken for it
  let { s } = await build(lines, ev({ hash: sha(p2) }));
  assert.deepEqual(s.tasks.map((t) => t.boundary), ['start', 'topic']);
  assert.equal(s.tasks[1].prompts[0].preview, p2);
  assert.deepEqual(s.tasks.map((t) => t.routed.map((e) => e.kind)), [['recon'], ['debug']]);
  // no hash: the last prompt within 30 s before the event, never the next one
  ({ s } = await build(lines, ev({})));
  assert.equal(s.tasks[1].prompts[0].preview, p2);
  // an event with no prompt in the 30 s before it splits nothing
  ({ s } = await build(lines, ev({ ts: '2026-10-01T10:09:00.000Z' })));
  assert.deepEqual(s.tasks.map((t) => t.boundary), ['start']);
});

test('R2#8: evidence flags, and a correction opening a new task is counted on the previous one', async () => {
  const lines = [u('1', T0, 'refactor the payment webhook handler'), a('2', '2026-10-01T10:00:05.000Z'),
    u('3', '2026-10-01T10:05:00.000Z', 'rewrite the onboarding carousel animation'), a('4', '2026-10-01T10:05:05.000Z'),
    u('5', '2026-10-01T10:06:00.000Z', 'no, that still fails with the same error'), a('6', '2026-10-01T10:06:05.000Z')];
  const ev = [{ ts: '2026-10-01T10:05:00.100Z', sessionId: 'tt', kind: 'feature', boundary: 'topic', hash: sha('rewrite the onboarding carousel animation') },
    { ts: '2026-10-01T10:06:00.100Z', sessionId: 'tt', kind: 'debug', boundary: 'topic', hash: sha('no, that still fails with the same error') }];
  const { s } = await build(lines, ev);
  // the correction is not a topic start: it joins task 1 as its 2nd prompt and counts there
  assert.equal(s.tasks.length, 2);
  assert.equal(s.tasks[1].signals.corrections, 1);
  assert.deepEqual(s.tasks.map((t) => t.evidence), [true, true]); // moved on / corrected
  // lone prompt in a session's last task: no evidence
  const lone = await build([u('1', T0, 'where is the config loaded'), a('2', '2026-10-01T10:00:05.000Z')], []);
  assert.equal(lone.s.tasks[0].evidence, false);
  // followed by /clear: abandoned
  const clr = await build([u('1', T0, 'where is the config loaded'), a('2', '2026-10-01T10:00:05.000Z'),
    u('3', '2026-10-01T10:01:00.000Z', '<command-name>/clear</command-name>'), u('4', '2026-10-01T10:02:00.000Z', 'build the new report page'), a('5', '2026-10-01T10:02:05.000Z')], []);
  assert.deepEqual(clr.s.tasks.map((t) => [t.boundary, t.evidence]), [['start', false], ['clear', false]]);
});

test('R2#9/R2#4: escalation across router tiers and similar descriptions; headless sessions flagged', async () => {
  const lines = [u('1', T0, 'find the config loader'), a('2', '2026-10-01T10:00:05.000Z'), u('3', '2026-10-01T10:01:00.000Z', 'thanks, now another thing')];
  const { dir, f } = await build(lines, []);
  const subDir = path.join(dir, 'tt/subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const put = (id, meta, ts, model) => { fs.writeFileSync(path.join(subDir, `agent-${id}.jsonl`), a(`s${id}`, ts, model) + '\n'); fs.writeFileSync(path.join(subDir, `agent-${id}.meta.json`), JSON.stringify(meta)); };
  put('a1', { agentType: 'router:fast', description: 'locate config loader code' }, '2026-10-01T10:00:10.000Z', 'claude-haiku-5-5');
  put('a2', { agentType: 'router:standard', description: 'something else' }, '2026-10-01T10:00:20.000Z', 'claude-sonnet-5-5');
  put('b1', { agentType: 'Explore', description: 'locate config loader code paths' }, '2026-10-01T10:00:30.000Z', 'claude-haiku-5-5');
  put('b2', { agentType: 'general-purpose', description: 'locate config loader code paths again' }, '2026-10-01T10:00:40.000Z', 'claude-opus-5-5');
  put('c1', { agentType: 'Explore', description: 'unrelated zebra' }, '2026-10-01T10:00:50.000Z', 'claude-haiku-5-5');
  put('c2', { agentType: 'other', description: 'banana smoothie recipe' }, '2026-10-01T10:00:55.000Z', 'claude-opus-5-5');
  const { buildSession } = await import('../plugin/scripts/lib/ingest.mjs');
  // a1->a2 (router pair) and b1->b2 (keyword overlap) escalate; c1->c2 share nothing
  assert.equal(buildSession(f, {}).tasks[0].signals.escalations, 2);
});

test('R2#4: ingest flags sdk entrypoints and router-shadow projects as headless', async () => {
  const sdk = await build([u('1', T0, 'summarise this file please', { entrypoint: 'sdk-cli' }), a('2', '2026-10-01T10:00:05.000Z')], []);
  assert.equal(sdk.s.headless, true);
  const cli = await build([u('1', T0, 'summarise this file please', { entrypoint: 'cli' }), a('2', '2026-10-01T10:00:05.000Z')], []);
  assert.equal(cli.s.headless, false);
  const shadow = await build([u('1', T0, 'summarise this file please', { cwd: '/private/tmp/router-shadow-abc/x-fast' }), a('2', '2026-10-01T10:00:05.000Z')], []);
  assert.equal(shadow.s.headless, true);
});

test('R2#4: turnOrigin sdk marks headless even when the entrypoint is inherited', async () => {
  const hp = await build([u('1', T0, 'summarise this file please', { entrypoint: 'claude-desktop', turnOrigin: 'sdk' }), a('2', '2026-10-01T10:00:05.000Z')], []);
  assert.equal(hp.s.headless, true);
  const human = await build([u('1', T0, 'summarise this file please', { entrypoint: 'claude-desktop', turnOrigin: 'human' }), a('2', '2026-10-01T10:00:05.000Z')], []);
  assert.equal(human.s.headless, false);
});

test('R2#1: an escalation or a blocked subagent is evidence even in a lone last task', async () => {
  // policy side, no follow-up
  const fast = { model: 'claude-haiku-5-5', status: 'blocked', cost: { total: 1 } }, std = { model: 'claude-sonnet-5-5', status: 'done', cost: { total: 1 } };
  assert.deepEqual(samplesOf(task({ evidence: false, model: 'claude-opus-5-5', subagents: [fast, std], signals: { escalations: 1 } })).map((x) => x.slice(0, 2)), [[0, 0], [1, 1]]);
  assert.deepEqual(samplesOf(task({ evidence: false, model: 'claude-opus-5-5', subagents: [fast, std] })).map((x) => x.slice(0, 2)), [[0, 0], [1, 1]]);
  assert.deepEqual(samplesOf(task({ evidence: false, model: 'claude-opus-5-5', subagents: [std] })), []);
  // ingest side: a router:fast -> router:standard pair in a single-prompt session
  const { dir, f } = await build([u('1', T0, 'find the config loader'), a('2', '2026-10-01T10:00:05.000Z')], []);
  const subDir = path.join(dir, 'tt/subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const put = (id, type, ts, model) => { fs.writeFileSync(path.join(subDir, `agent-${id}.jsonl`), a(`s${id}`, ts, model) + '\n'); fs.writeFileSync(path.join(subDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description: 'locate config' })); };
  put('a1', 'router:fast', '2026-10-01T10:00:10.000Z', 'claude-haiku-5-5');
  put('a2', 'router:standard', '2026-10-01T10:00:20.000Z', 'claude-sonnet-5-5');
  const { buildSession } = await import('../plugin/scripts/lib/ingest.mjs');
  assert.equal(buildSession(f, {}).tasks[0].evidence, true);
});
