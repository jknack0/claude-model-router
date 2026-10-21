#!/usr/bin/env node
// CLI: node init.mjs [--days 30] [--quiet] [--rebaseline]   first-run baseline, policy seed and summary. Idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sub } from './lib/paths.mjs';
import { loadTasks, taskKind } from './lib/policy.mjs';
import { buildReport } from './report.mjs';
import { learn, formatTable } from './learn.mjs';
import { plan } from './shadow.mjs';
import { lockHeld, takeLock, releaseLock } from './lib/initlock.mjs';

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const money = (x) => `$${x.toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = () => { try { return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../.claude-plugin/plugin.json'), 'utf8')).version ?? ''; } catch { return ''; } };

export function makeBaseline(rep, tasks, days) {
  const t = rep.totals;
  const models = {};
  for (const r of t.rows) { const m = r.key.split(' ')[0]; models[m] = (models[m] ?? 0) + r.total; }
  const kinds = {};
  for (const x of tasks) (kinds[taskKind(x)] ??= []).push(x.total);
  const starts = tasks.map((x) => x.start).filter(Boolean).sort();
  return {
    createdAt: new Date().toISOString(), days, from: starts[0] ?? null, to: tasks.map((x) => x.end).filter(Boolean).sort().pop() ?? null,
    sessions: rep.sessions, tasks: rep.tasks.count, total: t.total,
    shares: { in: t.total ? t.in / t.total : 0, cw: t.total ? t.cw / t.total : 0, cr: t.total ? t.cr / t.total : 0, out: t.total ? t.out / t.total : 0 },
    ctx: { main: { p50: rep.context.main.p50, p90: rep.context.main.p90 }, sub: { p50: rep.context.sub.p50, p90: rep.context.sub.p90 } },
    perTask: { p50: rep.tasks.p50, p90: rep.tasks.p90, mean: rep.tasks.mean },
    models,
    topSubagents: rep.subagents.slice(0, 10).map(({ type, model, runs, cost, perRun, ctxP50 }) => ({ type, model, runs, cost, perRun, ctxP50 })),
    byKind: Object.fromEntries(Object.entries(kinds).map(([k, xs]) => [k, { tasks: xs.length, p50: pct(xs, 0.5) }])),
    pricesAsOf: rep.pricesAsOf,
  };
}

/** Wait (up to waitMs) for a live lock, then take it. Runs the init and returns the summary data. */
export async function init({ days = 30, rebaseline = false, waitMs = 90000 } = {}) {
  const t0 = Date.now();
  // the SessionStart hook locks on our behalf with our pid (see session-start.mjs); otherwise take it ourselves
  let owned = false;
  try { owned = JSON.parse(fs.readFileSync(sub('init.lock'), 'utf8')).pid === process.pid; } catch { /* none */ }
  while (!owned && !takeLock()) {
    if (Date.now() - t0 > waitMs) break;
    await sleep(Math.min(500, waitMs));
  }
  try {
    const rep = buildReport({ days });
    const tasks = loadTasks({ days });
    const file = sub('baseline.json');
    const fresh = rebaseline || !fs.existsSync(file);
    if (fresh) fs.writeFileSync(file, JSON.stringify(makeBaseline(rep, tasks, days), null, 2) + '\n');
    const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    const learned = learn({ days, apply: true });
    fs.writeFileSync(sub('init.json'), JSON.stringify({ ts: new Date().toISOString(), version: version(), baselineTasks: baseline.tasks }) + '\n');
    return { rep, baseline, learned, fresh };
  } finally { releaseLock(); }
}

const k = (n) => `${Math.round(n / 1000)}K`;
export function summary({ rep, baseline: b, learned, fresh }) {
  const o = [`# Router init (${b.from?.slice(0, 10) ?? '?'} to ${b.to?.slice(0, 10) ?? '?'})`, ''];
  o.push(`${fresh ? 'Baseline written' : 'Baseline kept (use --rebaseline to replace)'}: ${b.tasks} tasks, ${b.sessions} sessions, ${money(b.total)} (list price, as of ${b.pricesAsOf}).`);
  o.push(`- $/task p50 ${money(b.perTask.p50)}, p90 ${money(b.perTask.p90)}, mean ${money(b.perTask.mean)}`);
  o.push(`- where it goes: cache read ${(100 * b.shares.cr).toFixed(0)}%, cache write ${(100 * b.shares.cw).toFixed(0)}%, input ${(100 * b.shares.in).toFixed(0)}%, output ${(100 * b.shares.out).toFixed(0)}%`);
  o.push(`- context p50/p90: main ${k(b.ctx.main.p50)}/${k(b.ctx.main.p90)}, subagents ${k(b.ctx.sub.p50)}/${k(b.ctx.sub.p90)}`, '', '## Top context offenders');
  for (const x of rep.tasks.top.slice().sort((p, q) => q.ctxMax - p.ctxMax).slice(0, 5)) o.push(`- ${x.date} ${x.project} ctxMax ${k(x.ctxMax)} ${money(x.total)}: ${x.preview.slice(0, 60)}`);
  o.push('', '## Top subagent types by $');
  for (const s of b.topSubagents.slice(0, 5)) o.push(`- ${s.type} (${s.model}): ${s.runs} runs, ${money(s.cost)}, ${money(s.perRun)}/run, ctxP50 ${k(s.ctxP50)}`);
  o.push('', '## Policy', '```', formatTable(learned), '```');
  const moves = learned.moves.length ? `${learned.moves.length} move(s) applied` : 'no moves applied';
  o.push(`${moves}; evidence counts written for exploration.`, '', '## Shadow estimate (plan only, nothing run)');
  try {
    const rows = plan({ n: 5 });
    for (const r of rows) o.push(`- ${r.id} ${r.kind} ${r.cheap}->${r.up} ~${money(r.est)}: ${r.preview.slice(0, 50)}`);
    o.push(rows.length ? `Total ~${money(rows.reduce((s, r) => s + r.est, 0))} for ${rows.length} replay(s).` : 'No eligible tasks.');
  } catch (e) { o.push(`unavailable: ${e.message}`); }
  return o.join('\n');
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  const a = process.argv.slice(2);
  const days = a.includes('--days') ? Number(a[a.indexOf('--days') + 1]) || 30 : 30;
  try {
    const r = await init({ days, rebaseline: a.includes('--rebaseline') });
    if (!a.includes('--quiet')) console.log(summary(r));
  } catch (e) {
    try { fs.appendFileSync(sub('errors.log'), `${new Date().toISOString()} init: ${e?.stack ?? e}\n`); } catch { /* ignore */ }
    if (!a.includes('--quiet')) console.error(e.message);
    process.exitCode = 1;
  }
}
