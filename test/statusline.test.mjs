import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../plugin/scripts/statusline.mjs');
const run = (input, dir) =>
  spawnSync('node', [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ROUTER_DATA_DIR: dir } });
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'router-sl-'));
const payload = (o = {}) => ({
  session_id: 'sl1',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'high' },
  cost: { total_cost_usd: 4.123 },
  context_window: { current_usage: { input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 340000 } },
  ...o,
});

test('statusline: full line, with the cheaper-main hint from state', () => {
  const dir = mk();
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'state/sl1.json'), JSON.stringify({ recommendedMain: 'sonnet/medium' }));
  assert.equal(run(payload(), dir).stdout, 'opus·high │ ctx 342K ~$0.07/req │ $4.12 │ ⇢ sonnet/medium');
});

test('statusline: no hint when the recommendation is not cheaper; missing effort and state are fine', () => {
  const dir = mk();
  fs.mkdirSync(path.join(dir, 'state'));
  fs.writeFileSync(path.join(dir, 'state/sl1.json'), JSON.stringify({ recommendedMain: 'opus/high' }));
  assert.doesNotMatch(run(payload(), dir).stdout, /⇢/);
  const r = run(payload({ effort: undefined, session_id: 'none' }), dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^opus │ ctx/);
});

test('statusline: garbage in, exit 0', () => {
  const r = spawnSync('node', [script], { input: '{{', encoding: 'utf8' });
  assert.equal(r.status, 0);
});
