import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../plugin/scripts/lib/transcripts.mjs';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/a-proj/-tmp-demo/a-main.jsonl');

test('readSession skips bad JSON', () => {
  const lines = T.readSession(MAIN);
  assert.ok(lines.length > 10);
  assert.ok(lines.every((l) => typeof l === 'object'));
});

test('assistantMessages dedupes by id keeping max output, skips synthetic', () => {
  const ms = T.assistantMessages(T.readSession(MAIN));
  assert.deepEqual(ms.map((m) => m.id), ['m1', 'm2', 'm4', 'm5', 'm6', 'm7']);
  const m1 = ms[0];
  assert.equal(m1.usage.output_tokens, 50);
  assert.equal(m1.effort, 'high');
  assert.equal(m1.isSidechain, false);
});

test('humanPrompts returns real prompts and boundaries', () => {
  const { prompts, boundaries } = T.humanPrompts(T.readSession(MAIN));
  assert.deepEqual(prompts.map((p) => p.text), ['fix the bug in parser', 'no that is wrong, still broken', 'second task: list files']);
  assert.deepEqual(boundaries.map((b) => b.kind), ['effort', 'clear', 'compact']);
  assert.equal(boundaries[0].args, 'high');
});

test('subagentFiles reads sidecar meta', () => {
  const fs = T.subagentFiles(MAIN);
  assert.equal(fs.length, 3);
  const a1 = fs.find((f) => f.agentId === 'ag1');
  assert.equal(a1.agentType, 'orch:scout');
  assert.equal(a1.toolUseId, 'toolu_A');
  assert.equal(a1.description, 'find stuff');
  assert.deepEqual(T.subagentFiles('/nonexistent/x.jsonl'), []);
});

test('re-exports tailUsage', () => {
  assert.equal(typeof T.tailUsage, 'function');
});

test('humanPrompts ignores interrupt markers', () => {
  const mk = (text) => ({ type: 'user', timestamp: 't', uuid: 'u', message: { content: text } });
  const { prompts } = T.humanPrompts([mk('[Request interrupted by user for tool use]'), mk('[Request interrupted by user]'), mk('real prompt')]);
  assert.deepEqual(prompts.map((p) => p.text), ['real prompt']);
});
