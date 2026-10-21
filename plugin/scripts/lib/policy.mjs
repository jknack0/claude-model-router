// Policy learning: per (kind, tier) success stats from ingested tasks, and a proposed kind -> tier table.
import fs from 'node:fs';
import { sub } from './paths.mjs';
import { classify, TIERS } from './classify.mjs';
import { subOk } from './phases.mjs';

export const tierIdx = (model) => (/haiku/.test(model ?? '') ? 0 : /sonnet/.test(model ?? '') ? 1 : /opus|fable|mythos/.test(model ?? '') ? 2 : -1);
export const taskId = (sessionId, idx) => `${sessionId.slice(0, 8)}-${idx}`;

/** Tier index of the main session's dominant model (what a replay re-runs). -1 when unknown. */
export function effectiveTier(task) {
  const top = Object.entries(task.mainModels ?? {}).sort((a, b) => b[1] - a[1])[0];
  return top ? tierIdx(top[0]) : -1;
}

/** Wilson score lower bound (z = 1.28, ~90% one-sided). */
export function wilson(succ, n, z = 1.28) {
  if (!n) return 0;
  const p = succ / n;
  const d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (l) try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}
export const loadShadow = () => readJsonl(sub('shadow', 'results.jsonl'));
export const loadEventList = () => readJsonl(sub('events.jsonl'));

/** All ingested tasks with session info and learning fields, newest activity within `days`. */
export function loadTasks({ days = 30 } = {}) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const dir = sub('sessions');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { /* nothing ingested yet */ }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
    for (const t of s.tasks) {
      if ((t.end ?? '') < cutoff) continue;
      out.push({ ...t, project: s.project, headless: !!s.headless, sessionId: s.sessionId, id: taskId(s.sessionId, t.idx), file: s.file });
    }
  }
  return out;
}

export function taskKind(task) {
  const e = task.routed?.[0];
  return e ? e.kind : classify(task.prompts[0]?.preview ?? '').kind;
}

export function taskSuccess(task) {
  const g = task.signals;
  const bad = g.corrections || g.escalations || task.subagents.some((s) => s.status === 'partial' || s.status === 'blocked');
  return bad ? 0 : 1;
}

const badStatus = (s) => s.status === 'partial' || s.status === 'blocked';

/**
 * The (tier, success, cost) samples a task honestly yields. No evidence (lone prompt, last task, abandoned): none.
 * An escalation charges the failure to the lowest tier that ran; the rescuing tier gets a success only if the
 * task otherwise succeeded. Otherwise the sample goes to the routed tier when the work matched it (a subagent at
 * that tier and none higher, or no subagents and the main model there), or, with no routed event, to the main
 * model's tier. Cheap helpers under a bigger main model never define the tier.
 */
export function samplesOf(task) {
  const subs = task.subagents.map((s) => ({ tier: tierIdx(s.model), s })).filter((x) => x.tier >= 0);
  // an escalation or a blocked/partial subagent is evidence even without follow-up (also for sessions ingested before this rule)
  if (!(task.evidence || task.signals.escalations > 0 || task.subagents.some(badStatus))) return [];
  const lo = subs.length ? Math.min(...subs.map((x) => x.tier)) : -1;
  const hi = subs.length ? Math.max(...subs.map((x) => x.tier)) : -1;
  const escalated = hi > lo && (task.signals.escalations > 0 || subs.some((x) => x.tier < hi && badStatus(x.s)));
  if (escalated) {
    const out = [[lo, 0, task.total]];
    const rescued = !task.signals.corrections && subs.filter((x) => x.tier === hi).every((x) => !badStatus(x.s));
    if (rescued) out.push([hi, 1, null]);
    return out;
  }
  const main = effectiveTier(task);
  const routed = TIERS.indexOf(task.routed?.[0]?.tier);
  let tier = main;
  if (task.routed?.length && routed >= 0) {
    // Deliberate: with subagents, the routed tier is scored on the subagents' tiers even under an Opus main, because the router decides subagent tiers.
    const matched = subs.length ? subs.some((x) => x.tier === routed) && hi <= routed : main === routed;
    tier = matched ? routed : -1;
  }
  return tier < 0 ? [] : [[tier, taskSuccess(task), task.total]];
}

/** stats[kind][tier] = {n, succ, lb, med}. A shadow verdict is one sample and replaces the task's own. */
export function buildStats(tasks, shadow, policy) {
  const cells = {}; // kind -> tier -> {n, succ, costs}
  const add = (kind, tier, succ, cost) => {
    const c = ((cells[kind] ??= {})[TIERS[tier]] ??= { n: 0, succ: 0, costs: [] });
    c.n += 1; c.succ += succ;
    if (cost != null) c.costs.push(cost);
  };
  const judged = new Set(shadow.map((r) => r.taskId));
  for (const t of tasks) {
    const kind = taskKind(t);
    if (t.headless || !policy.kinds?.[kind] || judged.has(t.id)) continue;
    for (const [tier, succ, cost] of samplesOf(t)) add(kind, tier, succ, cost);
  }
  // subagents whose model the router picked at spawn (set: true; pinned, explicit and built-in runs say nothing about the tier): (phase, tier the subagent ran at) in the same table as task samples
  for (const t of tasks) {
    if (t.headless) continue;
    for (const s of t.subagents) {
      const tier = tierIdx(s.model);
      if (s.routedPhase && s.routedSet && tier >= 0 && policy.kinds?.[s.routedPhase]) add(s.routedPhase, tier, subOk(s) ? 1 : 0, s.cost.total);
    }
  }
  for (const r of shadow) {
    const tier = TIERS.indexOf(r.cheapTier);
    if (tier < 0 || !policy.kinds?.[r.kind]) continue;
    add(r.kind, tier, r.verdict === 'cheap_worse' ? 0 : 1, null);
  }
  const stats = {};
  for (const [kind, byTier] of Object.entries(cells)) {
    for (const [tier, c] of Object.entries(byTier)) {
      (stats[kind] ??= {})[tier] = { n: c.n, succ: c.succ, lb: wilson(c.succ, c.n), med: median(c.costs) };
    }
  }
  return stats;
}

/** Proposed moves, at most one tier per kind. */
export function propose(stats, policy) {
  const target = policy.target ?? 0.8, minN = policy.minN ?? 8;
  const moves = [];
  for (const [kind, cur] of Object.entries(policy.kinds ?? {})) {
    if (!cur) continue;
    const ci = TIERS.indexOf(cur);
    const st = stats[kind] ?? {};
    const ok = TIERS.findIndex((t) => st[t] && st[t].n >= minN && st[t].lb >= target);
    let to = null, why = '';
    if (ok >= 0 && ok < ci) { to = TIERS[ci - 1]; why = `${TIERS[ok]} holds: n=${st[TIERS[ok]].n}, lb=${st[TIERS[ok]].lb.toFixed(2)} >= ${target}`; }
    else if (st[cur] && st[cur].n >= minN && st[cur].lb < target - 0.15 && ci < TIERS.length - 1) {
      to = TIERS[ci + 1]; why = `${cur} struggles: n=${st[cur].n}, lb=${st[cur].lb.toFixed(2)} < ${(target - 0.15).toFixed(2)}`;
    }
    if (to) moves.push({ kind, from: cur, to, evidence: why });
  }
  return moves;
}

/** n per kind and tier for every policy kind (route.mjs reads this to decide on exploration). */
export function countsOf(stats, policy) {
  const out = {};
  for (const kind of Object.keys(policy.kinds ?? {})) {
    if (!policy.kinds[kind]) continue;
    out[kind] = Object.fromEntries(TIERS.map((t) => [t, stats[kind]?.[t]?.n ?? 0]));
  }
  return out;
}
