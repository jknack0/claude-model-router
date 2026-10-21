import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/a-proj');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-report-'));
fs.cpSync(FIX, path.join(tmp, 'projects'), { recursive: true });
process.env.ROUTER_DATA_DIR = path.join(tmp, 'data');
process.env.ROUTER_PROJECTS_DIR = path.join(tmp, 'projects');
const { buildReport, renderText } = await import('../plugin/scripts/report.mjs');

test('report totals add up and what-ifs are present', () => {
  const d = buildReport({ days: 36500 });
  assert.equal(d.tasks.count, 3);
  const rowSum = d.totals.rows.reduce((s, r) => s + r.total, 0);
  assert.ok(Math.abs(rowSum - d.totals.total) < 1e-9);
  const taskSum = d.tasks.top.reduce((s, t) => s + t.total, 0);
  assert.ok(Math.abs(taskSum - d.totals.total) < 1e-9);
  assert.equal(d.subagents.length, 2); // scout on haiku (ag1+ag3) and on sonnet
  assert.equal(d.whatIfs.length, 3);
  assert.ok(d.settings.every((s) => s.lowN));
  assert.equal(d.context.main.n, 6);
});

test('text report has all sections; project filter works', () => {
  const txt = renderText(buildReport({ days: 36500 }));
  for (const h of ['prices as of', '1. TOTAL', '2. CONTEXT', '3. TASKS', '4. SUBAGENTS', '5. SETTINGS', '6. WHAT-IFS', 'quality not measured']) assert.ok(txt.includes(h), h);
  assert.equal(buildReport({ days: 36500, project: 'nomatch' }).tasks.count, 0);
});

test('report CLI runs through a symlink in a path with spaces', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const cp = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router rep '));
  const link = path.join(dir, 'rep link.mjs');
  fs.symlinkSync(path.resolve(import.meta.dirname, '../plugin/scripts/report.mjs'), link);
  const r = cp.spawnSync('node', [link, '--json'], { encoding: 'utf8', env: { ...process.env, ROUTER_DATA_DIR: dir, HOME: dir } });
  assert.ok(r.stdout.trim().startsWith('{'), r.stderr);
});
