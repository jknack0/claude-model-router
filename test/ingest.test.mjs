import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/a-proj');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ingest-'));
const projects = path.join(tmp, 'projects');
fs.cpSync(FIX, projects, { recursive: true });
process.env.ROUTER_DATA_DIR = path.join(tmp, 'data');
process.env.ROUTER_PROJECTS_DIR = projects;
const { ingestAll, ingestSession, buildSession } = await import('../plugin/scripts/lib/ingest.mjs');
const file = path.join(projects, '-tmp-demo/a-main.jsonl');

test('buildSession segments tasks and attributes subagents', () => {
  const s = buildSession(file, { 'a-main': [{ ts: '2026-10-01T10:11:30.000Z', sessionId: 'a-main', kind: 'recon', tier: 'fast' }] });
  assert.equal(s.project, '/tmp/demo');
  assert.deepEqual(s.tasks.map((t) => t.boundary), ['start', 'clear', 'compact']);
  const [t0, t1, t2] = s.tasks;
  assert.equal(t0.main.requests, 3);
  assert.equal(t0.mainEffort, 'high');
  assert.equal(t0.prompts.length, 2);
  assert.ok(t0.prompts[0].hash.length === 40);
  assert.deepEqual(t0.subagents.map((x) => [x.type, x.model, x.status]), [['orch:scout', 'claude-haiku-5-5', 'done']]);
  assert.equal(t0.signals.corrections, 1);
  assert.equal(t0.signals.toolErrors, 1);
  assert.equal(t0.signals.bashFails, 1);
  assert.equal(t1.subagents.length, 2);
  assert.equal(t1.signals.escalations, 1);
  assert.equal(t1.signals.denials, 1);
  assert.equal(t1.routed.length, 1);
  assert.equal(t0.routed.length, 0);
  assert.equal(t2.main.requests, 1);
  assert.equal(t2.prompts.length, 0);
  // m1: opus-5-5 in=10 cw=1000 out=50 -> 10*4e-6... cost check on first request
  const m1 = 10 * 4 / 1e6 + 1000 * 1.25 * 4 / 1e6 + 50 * 20 / 1e6;
  assert.ok(t0.main.cost.total > m1);
  assert.ok(Math.abs(t0.total - (t0.main.cost.total + t0.subagents[0].cost.total)) < 1e-9);
});

test('ingestAll writes sessions, is incremental, and re-ingests on subagent change', () => {
  const r1 = ingestAll({ days: 36500 });
  assert.equal(r1.ingested, 1);
  const out = path.join(process.env.ROUTER_DATA_DIR, 'sessions/a-main.json');
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).sessionId, 'a-main');
  assert.equal(ingestAll({ days: 36500 }).ingested, 0);
  const subf = path.join(projects, '-tmp-demo/a-main/subagents/agent-ag1.jsonl');
  fs.appendFileSync(subf, '\n');
  assert.equal(ingestAll({ days: 36500 }).ingested, 1);
  assert.equal(ingestAll({ days: 0 }).sessionIds.length, 0);
});

test('ingestSession is idempotent', () => {
  const a = ingestSession(file);
  const b = ingestSession(file);
  assert.deepEqual(a.tasks, b.tasks);
});
