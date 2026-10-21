#!/usr/bin/env node
// CLI: node report.mjs [--days 30] [--project <substr>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sub } from './lib/paths.mjs';
import { PRICES_AS_OF } from './lib/pricing.mjs';
import { ingestAll, reqCost, reqCtx } from './lib/ingest.mjs';

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const family = (m) => /haiku/.test(m) ? 'haiku' : /sonnet/.test(m) ? 'sonnet' : /opus/.test(m) ? 'opus' : /fable|mythos/.test(m) ? 'fable' : m ?? '?';
const CHEAP_TYPE = /scout|explore|researcher|fast/i;

export function buildReport({ days = 30, project = '' } = {}) {
  const { sessionIds } = ingestAll({ days });
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const tasks = [];
  for (const id of sessionIds) {
    let s;
    try { s = JSON.parse(fs.readFileSync(sub('sessions', `${id}.json`), 'utf8')); } catch { continue; }
    if (project && !(s.project ?? '').includes(project)) continue;
    for (const t of s.tasks) if ((t.end ?? '') >= cutoff) tasks.push({ ...t, project: s.project, sessionId: s.sessionId });
  }

  // 1. totals by model x main/sub, and 2. context
  const rows = {};
  const ctx = { main: [], sub: [] };
  const sum = { in: 0, cw: 0, cr: 0, out: 0, total: 0 };
  const whatif = { opusSubToSonnet: [0, 0], cheapSubToHaiku: [0, 0], mainToSonnet: [0, 0] };
  const addReq = (r, where, type) => {
    const c = reqCost(r);
    const row = (rows[`${r[0]} ${where}`] ??= { key: `${r[0]} ${where}`, requests: 0, in: 0, cw: 0, cr: 0, out: 0, total: 0 });
    row.requests++;
    for (const k of Object.keys(sum)) { row[k] += c[k]; sum[k] += c[k]; }
    ctx[where].push(reqCtx(r));
    const wi = (k, to) => { whatif[k][0] += c.total; whatif[k][1] += reqCost(r, to).total; };
    if (where === 'main') wi('mainToSonnet', 'claude-sonnet-5-5');
    else {
      if (/opus-5-5/.test(r[0])) wi('opusSubToSonnet', 'claude-sonnet-5-5');
      if (CHEAP_TYPE.test(type)) wi('cheapSubToHaiku', 'claude-haiku-5-5');
    }
  };
  const taskStats = [];
  const subRuns = {};
  for (const t of tasks) {
    let crCost = 0, reqs = t.main.requests, ctxMax = t.main.ctxMax;
    for (const r of t.main.reqs) { addReq(r, 'main'); crCost += reqCost(r).cr; }
    for (const s of t.subagents) {
      for (const r of s.reqs) { addReq(r, 'sub', s.type); crCost += reqCost(r).cr; }
      reqs += s.requests;
      ctxMax = Math.max(ctxMax, s.ctxMax);
      (subRuns[`${s.type}\t${s.model}`] ??= []).push(s);
    }
    taskStats.push({
      date: (t.start ?? '').slice(0, 10), project: path.basename(t.project ?? '?'), preview: t.prompts[0]?.preview ?? '',
      total: t.total, requests: reqs, ctxMax, cacheReadCost: crCost,
    });
  }
  const ctxSummary = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p90: pct(xs, 0.9), mean: mean(xs), over100k: xs.length ? xs.filter((x) => x > 1e5).length / xs.length : 0 });
  const totals = tasks.map((t) => t.total);

  const subagents = Object.entries(subRuns).map(([k, runs]) => {
    const [type, model] = k.split('\t');
    const cost = runs.reduce((a, s) => a + s.cost.total, 0);
    return { type, model, runs: runs.length, cost, perRun: cost / runs.length, ctxP50: pct(runs.map((s) => s.ctxP50), 0.5) };
  }).sort((a, b) => b.cost - a.cost);

  const groups = {};
  for (const t of tasks) {
    if (!t.main.requests) continue;
    const dom = Object.entries(t.mainModels).sort((a, b) => b[1] - a[1])[0][0];
    const g = (groups[`${family(dom)}\t${t.mainEffort ?? '-'}`] ??= []);
    g.push(t);
  }
  const settings = Object.entries(groups).map(([k, ts]) => {
    const [model, effort] = k.split('\t');
    return {
      model, effort, tasks: ts.length, lowN: ts.length < 5, p50Cost: pct(ts.map((t) => t.total), 0.5),
      p50Requests: pct(ts.map((t) => t.main.requests), 0.5),
      correctionRate: ts.filter((t) => t.signals.corrections > 0).length / ts.length,
    };
  }).sort((a, b) => b.tasks - a.tasks);

  const wi = (k, label) => ({ label, before: whatif[k][0], after: whatif[k][1], delta: whatif[k][1] - whatif[k][0] });
  return {
    pricesAsOf: PRICES_AS_OF, days, project, sessions: sessionIds.length,
    totals: { ...sum, rows: Object.values(rows).sort((a, b) => b.total - a.total) },
    context: { main: ctxSummary(ctx.main), sub: ctxSummary(ctx.sub) },
    tasks: {
      count: tasks.length, p50: pct(totals, 0.5), p90: pct(totals, 0.9), mean: mean(totals),
      top: taskStats.sort((a, b) => b.total - a.total).slice(0, 10),
    },
    subagents, settings,
    whatIfs: [
      wi('opusSubToSonnet', 'Opus 5.5 subagents -> Sonnet 5.5'),
      wi('cheapSubToHaiku', 'scout/explore/researcher/fast subagents -> Haiku 5.5 (100K rule applied)'),
      wi('mainToSonnet', 'main sessions -> Sonnet 5.5'),
    ],
  };
}

// ---- text rendering ----
const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const k = (n) => `${Math.round(n / 1000)}K`;
const p = (x) => `${(100 * x).toFixed(1)}%`;
const L = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));
const R = (s, n) => String(s).padStart(n);

export function renderText(d) {
  const o = [];
  o.push(`prices as of ${d.pricesAsOf}; list-price estimate, not a bill`);
  o.push(`last ${d.days} days${d.project ? `, project ~ "${d.project}"` : ''}: ${d.sessions} sessions, ${d.tasks.count} tasks`, '');
  const t = d.totals;
  o.push(`1. TOTAL ${usd(t.total)}  | input ${p(t.in / t.total)}  cache write ${p(t.cw / t.total)}  cache read ${p(t.cr / t.total)}  output ${p(t.out / t.total)}`);
  o.push(`${L('model/where', 30)}${R('reqs', 8)}${R('input', 9)}${R('cwrite', 10)}${R('cread', 10)}${R('output', 10)}${R('total', 11)}${R('share', 7)}`);
  for (const r of t.rows) o.push(`${L(r.key, 30)}${R(r.requests, 8)}${R(r.in.toFixed(0), 9)}${R(r.cw.toFixed(0), 10)}${R(r.cr.toFixed(0), 10)}${R(r.out.toFixed(0), 10)}${R(r.total.toFixed(0), 11)}${R(p(r.total / t.total), 7)}`);
  o.push('(columns in $)', '', '2. CONTEXT per request (prompt tokens)');
  for (const w of ['main', 'sub']) {
    const c = d.context[w];
    o.push(`  ${L(w, 5)} n=${c.n}  p50 ${k(c.p50)}  p90 ${k(c.p90)}  mean ${k(c.mean)}  over 100K ${p(c.over100k)}`);
  }
  const tk = d.tasks;
  o.push('', `3. TASKS: ${tk.count}   $/task p50 ${usd(tk.p50)}  p90 ${usd(tk.p90)}  mean ${usd(tk.mean)}`, '   top 10 by cost:');
  o.push(`   ${L('date', 11)}${L('project', 18)}${L('prompt', 34)}${R('$', 9)}${R('reqs', 6)}${R('ctxMax', 8)}${R('$ cache rd', 11)}`);
  for (const x of tk.top) o.push(`   ${L(x.date, 11)}${L(x.project.slice(0, 17), 18)}${L(x.preview.slice(0, 32), 34)}${R(x.total.toFixed(2), 9)}${R(x.requests, 6)}${R(k(x.ctxMax), 8)}${R(x.cacheReadCost.toFixed(2), 11)}`);
  o.push('', '4. SUBAGENTS by type x model');
  o.push(`   ${L('type', 34)}${L('model', 20)}${R('runs', 6)}${R('$', 10)}${R('$/run', 8)}${R('ctxP50', 8)}`);
  for (const s of d.subagents.slice(0, 25)) o.push(`   ${L(s.type.slice(0, 33), 34)}${L(s.model.slice(0, 19), 20)}${R(s.runs, 6)}${R(s.cost.toFixed(2), 10)}${R(s.perRun.toFixed(2), 8)}${R(k(s.ctxP50), 8)}`);
  if (d.subagents.length > 25) o.push(`   ... ${d.subagents.length - 25} more rows (see --json)`);
  o.push('', '5. SETTINGS COMPARISON (main model family x effort; confounded by task mix, not a controlled test)');
  o.push(`   ${L('model', 8)}${L('effort', 8)}${R('tasks', 7)}${R('p50 $', 9)}${R('p50 reqs', 10)}${R('corrected', 11)}`);
  for (const s of d.settings) o.push(`   ${L(s.model, 8)}${L(s.effort, 8)}${R(s.tasks, 7)}${R(s.p50Cost.toFixed(2), 9)}${R(s.p50Requests, 10)}${R(p(s.correctionRate), 11)}${s.lowN ? '  low-n' : ''}`);
  o.push('', '6. WHAT-IFS (same tokens, re-priced; quality not measured)');
  for (const w of d.whatIfs) o.push(`   ${L(w.label, 72)} ${usd(w.before)} -> ${usd(w.after)}  (${w.delta <= 0 ? '-' : '+'}${usd(Math.abs(w.delta))})`);
  return o.join('\n');
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  const a = process.argv.slice(2);
  const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  const d = buildReport({ days: Number(val('--days') ?? 30), project: val('--project') ?? '' });
  console.log(a.includes('--json') ? JSON.stringify(d) : renderText(d));
}
