import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tailUsage } from '../plugin/scripts/lib/tail.mjs';

const root = path.resolve(import.meta.dirname, '../plugin/scripts');
const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'router-rt-'));
const run = (script, input, dir) =>
  spawnSync('node', [path.join(root, script)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ROUTER_DATA_DIR: dir } });
const ctx = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');
const events = (dir) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('tailUsage: latest main-thread message, deduped by id, skips sidechain and synthetic', () => {
  const u = tailUsage(path.join(fixtures, 'b-transcript.jsonl'));
  assert.equal(u.model, 'claude-opus-5-5');
  assert.equal(u.effort, 'high');
  assert.equal(u.usage.output_tokens, 50);
  assert.equal(u.contextTokens, 10 + 1000 + 200000);
  assert.equal(tailUsage('/nonexistent'), null);
});

test('route: first debug prompt emits a deep line; same tier stays silent; tier change emits', () => {
  const dir = mk();
  const base = { session_id: 's1', transcript_path: '/nonexistent' };
  const r1 = run('route.mjs', { ...base, prompt: 'the build is failing with a type error' }, dir);
  assert.equal(r1.status, 0);
  const l1 = ctx(r1);
  assert.match(l1, /^\[router\] debug task → subagents: model=opus effort=high/);
  assert.ok(l1.length < 600);
  assert.equal(ctx(run('route.mjs', { ...base, prompt: 'still crashing on startup' }, dir)), '');
  assert.equal(ctx(run('route.mjs', { ...base, prompt: 'ok' }, dir)), '');
  assert.match(ctx(run('route.mjs', { ...base, prompt: 'find where the config is loaded' }, dir)), /model=haiku effort=low/);
  assert.equal(events(dir).length, 4);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state/s1.json'), 'utf8'));
  assert.equal(st.recommendedMain, 'sonnet/medium');
});

test('route: /clear resets so the same tier is announced again', () => {
  const dir = mk();
  const base = { session_id: 's2', transcript_path: '/nonexistent' };
  run('route.mjs', { ...base, prompt: 'the build is failing with a type error' }, dir);
  run('session-start.mjs', { ...base, source: 'clear' }, dir);
  assert.match(ctx(run('route.mjs', { ...base, prompt: 'the tests are failing now' }, dir)), /^\[router\] debug/);
});

test('route: big context plus a new topic suggests /clear, once', () => {
  const dir = mk();
  const base = { session_id: 's3', transcript_path: path.join(fixtures, 'b-transcript.jsonl') };
  run('route.mjs', { ...base, prompt: 'explain the billing invoice pipeline logic' }, dir);
  const l = ctx(run('route.mjs', { ...base, prompt: 'rename the avatar upload widget please' }, dir));
  assert.match(l, /context is 201K \(~\$0\.04\/request\)\. This looks like a new topic/);
  assert.doesNotMatch(ctx(run('route.mjs', { ...base, prompt: 'build the kubernetes manifests chart' }, dir)), /\/clear/);
});

test('hooks survive garbage stdin and log nothing to stdout', () => {
  const dir = mk();
  for (const s of ['route.mjs', 'session-start.mjs', 'session-end.mjs']) {
    const r = spawnSync('node', [path.join(root, s)], { input: 'not json', encoding: 'utf8', env: { ...process.env, ROUTER_DATA_DIR: dir } });
    assert.equal(r.status, 0);
  }
});

test('session-start prints the instructions under 900 chars and seeds policy', () => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, 'init.json'), '{}'); // already initialized: no first-run line
  const r = run('session-start.mjs', { session_id: 's4', source: 'startup' }, dir);
  assert.ok(r.stdout.length > 100 && r.stdout.length < 900);
  assert.ok(fs.existsSync(path.join(dir, 'policy.json')));
});

test('route: main-session advice never says haiku; a correction is never a topic boundary', () => {
  const dir = mk();
  const base = { session_id: 's5', transcript_path: path.join(fixtures, 'big-ctx.jsonl') };
  const l = ctx(run('route.mjs', { ...base, prompt: 'find where the config is loaded' }, dir));
  assert.match(l, /model=haiku effort=low/);
  assert.match(l, /main session fits sonnet\/medium/);
  assert.doesNotMatch(l, /fits haiku/);
  run('route.mjs', { ...base, prompt: 'no, that is wrong' }, dir);
  assert.notEqual(events(dir).at(-1).boundary, 'topic');
});

test('session-start caps learnings at 20 lines / 1500 chars', () => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, 'init.json'), '{}');
  fs.writeFileSync(path.join(dir, 'learnings.md'), Array.from({ length: 60 }, (_, i) => `line${i} ${'x'.repeat(100)}`).join('\n'));
  const r = run('session-start.mjs', { session_id: 's6', source: 'startup' }, dir);
  assert.match(r.stdout, /line0 /);
  assert.doesNotMatch(r.stdout, /line20 /);
  assert.ok(r.stdout.length < 900 + 1500 + 60);
});
