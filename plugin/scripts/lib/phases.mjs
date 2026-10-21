// Subagent runs grouped by workflow phase and model (report.mjs and retro.mjs both print this).
import { classify } from './classify.mjs';

const family = (m) => (/haiku/.test(m) ? 'haiku' : /sonnet/.test(m) ? 'sonnet' : /opus/.test(m) ? 'opus' : /fable|mythos/.test(m) ? 'fable' : m ?? '?');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const k = (n) => `${Math.round(n / 1000)}K`;

/** A subagent run worked when its STATUS isn't partial/blocked and a higher-tier run didn't redo it. */
export const subOk = (s) => s.status !== 'partial' && s.status !== 'blocked' && !s.escalated;
/** The phase a subagent was routed as, else its description classified now. */
// Subagents from before the router have only a short label; call them unrouted unless the label clearly names a phase.
export const phaseOf = (s) => {
  if (s.routedPhase) return s.routedPhase;
  const k = classify(s.description ?? '').kind;
  return k === 'chat' || k === 'continue' ? 'unrouted' : k;
};

/** [{phase, model, runs, cost, perRun, ctxP50, success}] by cost, descending. */
export function phaseRows(subagents) {
  const g = {};
  for (const s of subagents) (g[`${phaseOf(s)}\t${family(s.model)}`] ??= []).push(s);
  return Object.entries(g).map(([key, runs]) => {
    const [phase, model] = key.split('\t');
    const cost = runs.reduce((a, s) => a + s.cost.total, 0);
    return { phase, model, runs: runs.length, cost, perRun: cost / runs.length, ctxP50: median(runs.map((s) => s.ctxP50)), success: runs.filter(subOk).length / runs.length };
  }).sort((a, b) => b.cost - a.cost);
}

/** Briefs over 4K chars (known from spawn events) against all other subagent runs: {n, ctx, restN, restCtx}. */
export function briefStats(subagents) {
  const fat = subagents.filter((s) => s.briefChars > 4000), rest = subagents.filter((s) => !(s.briefChars > 4000));
  return { n: fat.length, ctx: median(fat.map((s) => s.ctxP50)), restN: rest.length, restCtx: median(rest.map((s) => s.ctxP50)) };
}

export function phaseLines(rows, brief, limit = 20) {
  const L = (s, n) => String(s).padEnd(n), R = (s, n) => String(s).padStart(n);
  const o = [`   ${L('phase', 16)}${L('model', 8)}${R('runs', 6)}${R('$', 10)}${R('$/run', 8)}${R('ctxP50', 8)}${R('success', 9)}`];
  for (const r of rows.slice(0, limit)) o.push(`   ${L(r.phase, 16)}${L(r.model, 8)}${R(r.runs, 6)}${R(r.cost.toFixed(2), 10)}${R(r.perRun.toFixed(2), 8)}${R(k(r.ctxP50), 8)}${R(`${Math.round(100 * r.success)}%`, 9)}`);
  if (rows.length > limit) o.push(`   ... ${rows.length - limit} more rows (see --json)`);
  o.push(`   BRIEFS over 4K chars: ${brief.n} runs, median ctx ${k(brief.ctx)} vs ${k(brief.restCtx)} for the other ${brief.restN}`);
  return o;
}
