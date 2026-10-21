// PreToolUse hook for the Agent tool: pick the subagent's model from its brief unless something already chose one.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sub } from './lib/paths.mjs';
import { runHook } from './lib/hook.mjs';
import { classify, loadPolicy, tierFor, TIERS } from './lib/classify.mjs';
import { keywords, overlap, maybeExplore } from './lib/routing.mjs';

import { pinned } from './lib/agents.mjs';

const CAP = 4000; // keywords and anchors look at the first 4,000 chars only
// Numbers and file paths in a brief, sorted: what makes two similar briefs the same piece of work. Token by token, so no regex backtracking.
function anchors(t) {
  const head = t.slice(0, CAP), set = new Set(head.match(/\b\d+\b/g) ?? []);
  for (const raw of head.split(/\s+/)) {
    const tok = raw.replace(/^[^\w./-]+/, '').replace(/[^\w/]+$/, '');
    const dot = tok.lastIndexOf('.');
    if (dot > 0 && /^[a-z]{1,5}$/i.test(tok.slice(dot + 1)) && /^[\w./-]+$/.test(tok)) set.add(tok);
  }
  return [...set].sort().join(' ').slice(0, 300);
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const FAT = 4000;
const GATHER_NOTE = '\n\n(Router: write what you find to markdown files in the working directory and reply with an index of at most 20 lines: file paths plus one line each.)';
const WRITES_FILES = /\b(writ(e|ing)|sav(e|ing)|stor(e|ing))\b.{0,80}(\.md\b|\bmarkdown\b|\bfiles?\b)/i;

await runHook('spawn', (input) => {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object' || typeof ti.prompt !== 'string') return;
  const sid = input.session_id;
  const policy = loadPolicy();
  const brief = `${ti.description ?? ''}\n${ti.prompt}`;
  const res = classify(brief.slice(0, 8000)); // the head of a brief says what it is; a huge paste mustn't cost regex time
  const hash = sha(ti.prompt);

  let model = null, tier = null, explore = false, reason, kw, anc;
  const type = ti.subagent_type ?? null;
  if (ti.model) reason = 'explicit model';
  else if (pinned(ti.subagent_type, input.cwd, policy.spawnOverride)) reason = 'agent pins a model';
  else if (!(tier = tierFor(res, policy))) reason = `no tier for ${res.kind}`;
  else {
    reason = res.kind;
    // the same brief again within 30 min means the earlier run didn't do it: go one tier above that run
    const spawnsFile = sid ? sub('state', `${sid}.spawns.jsonl`) : null;
    let prior = [];
    try { prior = fs.readFileSync(spawnsFile, 'utf8').split('\n').slice(-51).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { /* new session */ }
    kw = keywords(brief.slice(0, CAP)).slice(0, 40);
    // a reworded retry still names the same step numbers and files; "step 2 of plan.md" after "step 1 of plan.md" is new work
    anc = anchors(brief);
    const retry = (s) => s.type === type && (s.hash === hash || (kw.length >= 3 && anc !== '' && s.anc === anc && overlap(kw, s.kw ?? []) >= 0.6));
    const recent = prior.filter((s) => Date.now() - Date.parse(s.ts) < 30 * 60_000 && retry(s));
    if (recent.length) {
      const top = Math.max(...recent.map((s) => TIERS.indexOf(s.tier)));
      const up = Math.min(TIERS.length - 1, top + 1);
      if (up > TIERS.indexOf(tier)) tier = TIERS[up];
      reason = `${res.kind}, escalated`;
    } else ({ tier, explore } = maybeExplore(tier, res, policy));
    model = policy.tiers[tier].model;
    if (spawnsFile) fs.appendFileSync(spawnsFile, JSON.stringify({ hash, type, kw, anc, tier, ts: new Date().toISOString() }) + '\n');
  }

  const gather = res.kind === 'gather' && !WRITES_FILES.test(ti.prompt) && !['Explore', 'Plan'].includes(ti.subagent_type);
  const fat = ti.prompt.length > FAT;
  const set = !!model;
  fs.appendFileSync(sub('events.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), type: 'spawn', sessionId: sid, toolUseId: input.tool_use_id ?? null, subagentType: ti.subagent_type ?? null,
    phase: res.kind, tier, model, set, reason, explore, briefChars: ti.prompt.length, hash, descHash: sha(ti.description ?? ''),
  }) + '\n');

  if (!set && !gather && !fat) return;
  const updated = { ...ti };
  if (set) updated.model = model;
  if (gather) updated.prompt = ti.prompt + GATHER_NOTE;
  const out = { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: updated };
  if (fat) out.additionalContext = `[router] this subagent brief is ${ti.prompt.length} chars; subagent context is the main cost — next time pass a file path ("implement step 3 of plan.md") instead of pasting.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
});
