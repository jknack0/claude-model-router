#!/usr/bin/env node
// CLI: node retro.mjs [--days 30] [--mark]   markdown summary for /router:retro. --mark records "now" as the last retro.
import fs from 'node:fs';
import path from 'node:path';
import { sub } from './lib/paths.mjs';
import { learn, formatTable } from './learn.mjs';
import { loadTasks, loadEventList } from './lib/policy.mjs';
import { reqCost, reqCtx } from './lib/ingest.mjs';

const a = process.argv.slice(2);
const days = a.includes('--days') ? Number(a[a.indexOf('--days') + 1]) || 30 : 30;
const statePath = () => sub('retro-state.json');
const money = (x) => `$${x.toFixed(2)}`;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

if (a.includes('--mark')) {
  fs.writeFileSync(statePath(), JSON.stringify({ lastTs: new Date().toISOString() }));
  console.log('retro marked');
  process.exit(0);
}

let lastTs = null;
try { lastTs = JSON.parse(fs.readFileSync(statePath(), 'utf8')).lastTs; } catch { /* first retro */ }
const now = Date.now();
const since = lastTs ?? new Date(now - 14 * 864e5).toISOString();
const span = now - Date.parse(since);
const before = new Date(Date.parse(since) - span).toISOString();

const r = learn({ days });
const tasks = loadTasks({ days: Math.max(days, Math.ceil((span * 2) / 864e5)) });
const spend = (lo, hi) => { const ts = tasks.filter((t) => (t.start ?? '') >= lo && (t.start ?? '') < hi); return [sum(ts.map((t) => t.total)), ts.length]; };
const [cur, curN] = spend(since, '9');
const [prev, prevN] = spend(before, since);

const out = [`# Router retro (${new Date(now).toISOString().slice(0, 10)})`, ''];
out.push('## Spend', `- since ${since.slice(0, 10)}${lastTs ? ' (last retro)' : ' (no retro yet, last 14 days)'}: ${money(cur)} over ${curN} tasks`);
out.push(`- the window before: ${money(prev)} over ${prevN} tasks (list-price estimates)`, '');

const window = tasks.filter((t) => (t.start ?? '') >= new Date(now - days * 864e5).toISOString());
const ctxMax = (t) => Math.max(t.main.ctxMax, ...t.subagents.map((s) => s.ctxMax));
out.push('## Top context offenders');
for (const t of [...window].sort((x, y) => ctxMax(y) - ctxMax(x)).slice(0, 5)) {
  out.push(`- ${(t.start ?? '').slice(0, 10)} ${path.basename(t.project ?? '?')} ctxMax ${Math.round(ctxMax(t) / 1000)}K ${money(t.total)}: ${t.prompts[0]?.preview.slice(0, 70) ?? ''}`);
}
out.push('', '## Subagent types by $/run');
const byType = {};
for (const t of window) for (const s of t.subagents) { const x = (byType[s.type] ??= { n: 0, cost: 0, ctx: [] }); x.n++; x.cost += s.cost.total; x.ctx.push(s.ctxP50); }
for (const [type, x] of Object.entries(byType).sort((p, q) => q[1].cost / q[1].n - p[1].cost / p[1].n).slice(0, 5)) {
  out.push(`- ${type}: ${x.n} runs, ${money(x.cost / x.n)}/run, ctxP50 ~${Math.round(x.ctx.sort((p, q) => p - q)[Math.floor(x.ctx.length / 2)] / 1000)}K`);
}

out.push('', '## Policy', '```', formatTable(r), '```');
const ev = loadEventList().filter((e) => e.ts >= since && e.explore);
const byKind = {};
for (const e of ev) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
out.push('', '## Exploration', `- explore rate ${r.policy.explore ?? 0}; trials since the last retro: ${ev.length}${ev.length ? ' (' + Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ') + ')' : ''}`);
out.push('- evidence so far (n per tier): ' + (Object.entries(r.counts).map(([k, c]) => `${k} ${c.fast}/${c.standard}/${c.deep}`).join(', ') || 'none'));

try {
  const b = JSON.parse(fs.readFileSync(sub('baseline.json'), 'utf8'));
  const ts = tasks.filter((t) => (t.start ?? '') > (b.to ?? ''));
  const pct = (xs, p) => { const q = [...xs].sort((x, y) => x - y); return q.length ? q[Math.min(q.length - 1, Math.floor(q.length * p))] : 0; };
  const ctx = { main: [], sub: [] }, byModel = {};
  let total = 0, cr = 0;
  const add = (r, w) => { const c = reqCost(r); ctx[w].push(reqCtx(r)); total += c.total; cr += c.cr; byModel[r[0]] = (byModel[r[0]] ?? 0) + c.total; };
  for (const t of ts) { t.main.reqs.forEach((r) => add(r, 'main')); t.subagents.forEach((s) => s.reqs.forEach((r) => add(r, 'sub'))); }
  const costs = ts.map((t) => t.total), K = (n) => `${Math.round(n / 1000)}K`;
  const mix = (m) => { const tot = sum(Object.values(m)); return Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k.replace(/^claude-/, '')} ${Math.round((100 * v) / (tot || 1))}%`).join(', ') || 'none'; };
  out.push('', `## vs baseline (${ts.length} tasks since ${(b.to ?? '').slice(0, 10)}${ts.length < 10 ? ', low-n' : ''})`);
  out.push(`- $/task p50 ${money(pct(costs, 0.5))} (baseline ${money(b.perTask.p50)}), mean ${money(ts.length ? sum(costs) / ts.length : 0)} (baseline ${money(b.perTask.mean)})`);
  out.push(`- context p50 main ${K(pct(ctx.main, 0.5))} (${K(b.ctx.main.p50)}), sub ${K(pct(ctx.sub, 0.5))} (${K(b.ctx.sub.p50)})`);
  out.push(`- cache-read share ${Math.round((100 * cr) / (total || 1))}% (${Math.round(100 * b.shares.cr)}%)`);
  out.push(`- model mix: ${mix(byModel)} (baseline ${mix(b.models)})`);
} catch { /* no baseline yet */ }
console.log(out.join('\n'));
