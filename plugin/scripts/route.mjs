// UserPromptSubmit hook: classify the prompt, print a tiny [router] line when the tier changes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sub } from './lib/paths.mjs';
import { runHook } from './lib/hook.mjs';
import { classify, loadPolicy, tierFor, isCorrection, TIERS } from './lib/classify.mjs';
import { tailUsage } from './lib/tail.mjs';
import { perRequestContextCost } from './lib/pricing.mjs';

const STOP = new Set('this that with from have will would could should there their what when where which about into your just like then than them they been were also some more make need want please using used does only'.split(' '));
const keywords = (s) => [...new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)))];

await runHook('route', (input) => {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const sid = input.session_id;
  if (!prompt || !sid) return;

  const policy = loadPolicy();
  const res = classify(prompt);
  const tier = tierFor(res, policy);
  const stateFile = sub('state', `${sid}.json`);
  let st = null;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const boundary = !st || !!st.boundaryPending;
  st = boundary
    ? { ...(st ?? {}), boundaryPending: false, promptsInTask: 0, kw: [], clearSuggested: false, taskKind: null, tier: null }
    : st;

  const kw = keywords(prompt);
  // keyword overlap with the last 3 prompts: low overlap means a topic shift
  let share = 1;
  if (kw.length >= 3 && st.kw?.length) {
    const seen = new Set(st.kw.flat());
    share = kw.filter((w) => seen.has(w)).length / kw.length;
  }
  const topic = !boundary && share < 0.15 && !isCorrection(prompt);

  const out = [];
  let routed = tier;
  let explore = false;
  if (tier && (boundary || tier !== st.baseTier)) {
    // exploration: sometimes try one tier cheaper while that tier has too little evidence (counts come from learn.mjs --apply)
    const ti = TIERS.indexOf(tier);
    const cheaper = TIERS[ti - 1];
    const n = policy.counts?.[res.kind]?.[cheaper];
    if (cheaper && n != null && n < (policy.minN ?? 8) && Math.random() < (policy.explore ?? 0)) { routed = cheaper; explore = true; }
    const t = policy.tiers[routed];
    const m = policy.tiers[routed === 'fast' ? 'standard' : routed]; // the main session orchestrates: floor is standard
    out.push(`[router] ${res.kind} task → subagents: model=${t.model} effort=${t.effort} (pass these on Agent calls unless the agent needs more); main session fits ${m.model}/${m.effort}.${explore ? ' (trial of a cheaper tier; escalate if it struggles)' : ''}`);
    st.baseTier = tier;
    st.tier = routed;
    st.taskKind = res.kind;
    st.recommendedMain = `${m.model}/${m.effort}`;
  }

  const u = tailUsage(input.transcript_path);
  st.ctx = u?.contextTokens ?? st.ctx ?? 0;
  if (u && u.contextTokens > 150_000 && !st.clearSuggested && topic) {
    const cost = perRequestContextCost(u.contextTokens, u.model);
    out.push(`[router] context is ${Math.round(u.contextTokens / 1000)}K${cost != null ? ` (~$${cost.toFixed(2)}/request)` : ''}. This looks like a new topic — suggest /clear to the user before starting.`);
    st.clearSuggested = true;
  }

  const hash = crypto.createHash('sha1').update(prompt).digest('hex');
  st.promptsInTask = (st.promptsInTask ?? 0) + 1;
  st.lastPromptHash = hash;
  st.kw = [...(st.kw ?? []), kw].slice(-3);
  fs.writeFileSync(stateFile, JSON.stringify(st));
  fs.appendFileSync(sub('events.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), sessionId: sid, kind: res.kind, tier: routed, explore, boundary: topic ? 'topic' : boundary, hash,
  }) + '\n');

  if (out.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.join('\n') } }));
  }
});
