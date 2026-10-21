// Local heuristic prompt classifier + policy loader. No API calls.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.mjs';

const TEMPLATE = path.resolve(import.meta.dirname, '../../templates/policy.json');
export const TIERS = ['fast', 'standard', 'deep'];

const RULES = [
  ['debug', /\b(flaky|leak(s|ing)?|race|deadlock(s|ed)?|wrong|incorrect|figure out|investigate|root cause|hang(s|ing)?|hung|slow|timeouts?|why (does|is|did|do|are) .*\b(fail|fails|break|breaks|crash|crashes|charge|charges|happen|happens)|what'?s causing|what is causing|causing (the|a|an|this)|5\d\ds|error|exception|traceback|stack ?trace|failing|fails|failed|broken|crash(es|ed|ing)?|bug|regression|segfault|undefined is not|cannot read|doesn'?t work|does not work|didn'?t work|not working)\b|\bdouble-\w+/i],
  ['design', /\b(architect(ure)?|design|tradeoffs?|trade-offs?|plan (for|the|out)|how should (we|i)|which approach|rfc|proposal|restructure|best way to)\b/i],
  ['review', /\b(review|audit|code review|check (this|the|my) (diff|pr|changes?|code))\b/i],
  ['ops', /\b(deploy|release|merge|migrate|migration|push|rollout|publish|ship)\b/i],
  ['small-edit', /\b(rename|typo|bump|tweak|one[- ]line|fix (the )?(typo|spelling|import|lint)|update (the )?(version|comment|copy|text))\b/i],
  ['feature', /\b(add|implement|build|create|write|make|support|refactor|extend)\b.*\b(function|component|endpoint|route|api|test|tests|hook|script|module|class|page|screen|command|feature|flag|field|table|handler|service|cli|parser|schema)\b/i],
  ['recon', /\b(find|where|list|search|grep|inventory|locate|look at|show me|which files?)\b/i],
  ['question', /^\s*(explain|why|how|what|which|who|when|is|are|does|do|can you explain|tell me|describe|walk me through)\b/i],
];
const rule = (k) => RULES.find(([n]) => n === k)[1];
const GATHER_VERB = /\b(find everything|gather|collect|pull (together|everything)|research|look up|dig up)\b/i;
const GATHER_SRC = /\b(jira|confluence|slack|tickets?)\b/i;
// tokens that look like issue keys but name a standard or algorithm
const ISSUE_KEY = /\b(?!(?:UTF|SHA|AES|ISO|MD|RSA|TLS|SSL|HTTP|IPV|RFC|CVE|ES|X)-)[A-Z][A-Z0-9]+-\d+\b/;
const DOC_VERB = /\b(summari[sz]e|read)\b/i;
const DOC_SRC = /\b(doc|docs|spec|page|url|link|confluence|pdf)\b/i;
// Classification order: the first matching step wins. Debug/design/review come before the workflow phases so deep work is never lowered.
const STEPS = [
  ['pattern-fit', (t) => /\b(which pattern|what pattern|fits (into|with)|closest existing|similar to (our|the) existing|compare (it )?(to|with) existing|same as how we)\b|\bfit\b.{0,40}\bpattern\b|\bpattern\b.{0,40}\b(fit|fits)\b/i.test(t)],
  ['plan-review', (t) => /\b(review (the|this|my) plan|critique the plan|poke holes)\b/i.test(t)],
  ['plan', (t) => /\b(implementation plan|estimate|break (it )?down|plan (out|for|the)|outline|level of effort)\b|\bLOE\b/i.test(t)],
  ['debug', (t) => rule('debug').test(t)],
  ['design', (t) => rule('design').test(t)],
  ['review', (t) => rule('review').test(t)],
  ['gather', (t) => GATHER_VERB.test(t) && (GATHER_SRC.test(t) || ISSUE_KEY.test(t))],
  ['implement-step', (t) => /\b(step \d+|items? \d+(–\d+|-\d+)?( of)?|per the plan)\b|(^|[\s/])[\w.-]*plan[\w.-]*\.[a-z]{1,5}\b/i.test(t)],
  ['doc-intake', (t) => DOC_VERB.test(t) && DOC_SRC.test(t)],
  ['write-guide', (t) => /\bwrite (a|the) (guide|doc|runbook|readme|technical guide)\b/i.test(t)],
];
export const PHASE_KINDS = ['gather', 'implement-step', 'doc-intake', 'write-guide', 'plan', 'plan-review', 'pattern-fit'];
// implement-step goes to fast only for short mechanical briefs whose first verb is scaffold-like
const SCAFFOLD_FIRST = /^\W*((please|just|quickly?|now)\s+)*(scaffold|boilerplate|rename|move|stub|wire up)\b/i;
const HEAVY = /\b(refactor|rewrite|concurren\w*|race|backpressure|ordering|migrat\w*|redesign)\b/i;
const CHANGE_TO = /\bchange .{1,60} to .{1,60}/i;
const RISK = /\b(prod|production|drop|delete|migrate|security|safe to|secrets?|billing|payments?|auth(entication)?|credentials?)\b/i;
const EDIT_VERB = /\b(add|implement|build|create|fix|change|rename|update|refactor|write|remove|delete|make)\b/i;
const CORR_START = /^\s*(no|nope|wrong|that'?s not|still|doesn'?t work|didn'?t work|revert|undo)\b/i;
const CORR_SHORT = /\b(wrong|doesn'?t work|didn'?t work|revert|undo|still)\b/i;
/** True when a prompt corrects the previous answer (so it belongs to the task it corrects). */
export const isCorrection = (t) => CORR_START.test(t) || (t.trim().split(/\s+/).length <= 6 && CORR_SHORT.test(t));
const CONTINUE = /^\W*(ok(ay)?|yes|yep|yeah|y|go|go ahead|do it|continue|proceed|lgtm|sure|next|thanks?|ty|looks good|sounds good|\d+|option \d+|(the )?(first|second|third) (one|option))\W*$/i;

/** @returns {{kind:string, confidence:number, reasons:string[], bump:number, floor:string|null}} bump is the tier adjustment (-1, 0, +1); floor is a minimum tier */
export function classify(prompt) {
  const text = String(prompt ?? '').trim();
  const reasons = [];
  let kind = 'chat';
  let confidence = 0.4;
  let bump = 0;
  let floor = null;
  const words = text.split(/\s+/).filter(Boolean).length;

  const stack = /^\s+at .+\(.+:\d+(:\d+)?\)|Traceback \(most recent call last\)|^\s*File ".+", line \d+/m.test(text);
  const bigBlock = (text.match(/```[\s\S]*?```/g) ?? []).some((b) => b.split('\n').length > 30);

  if (CONTINUE.test(text)) {
    kind = 'continue'; confidence = 0.95; reasons.push('short acknowledgement or choice');
  } else if (stack || bigBlock) {
    kind = 'debug'; confidence = 0.8; reasons.push(stack ? 'pasted stack trace' : 'code block over 30 lines');
  } else {
    const step = STEPS.find(([, fn]) => fn(text))?.[0];
    if (step) {
      kind = step; confidence = PHASE_KINDS.includes(step) ? 0.75 : 0.7; reasons.push(`matched ${kind} ${PHASE_KINDS.includes(step) ? 'phase' : 'keywords'}`);
    } else {
      for (const [k, re] of RULES) {
        if (['debug', 'design', 'review'].includes(k)) continue;
        const hit = k === 'question' ? re.test(text) && !EDIT_VERB.test(text)
          : k === 'small-edit' ? re.test(text) || (words <= 12 && CHANGE_TO.test(text))
            : re.test(text);
        if (hit) {
          kind = k; confidence = 0.7; reasons.push(`matched ${k} keywords`);
          break;
        }
      }
    }
    if (kind === 'chat' && words <= 3) {
      kind = 'continue'; confidence = 0.6; reasons.push('3 words or fewer');
    }
    if (PHASE_KINDS.includes(kind)) {
      if (kind === 'implement-step' && text.length < 400 && SCAFFOLD_FIRST.test(text) && !RISK.test(text) && !HEAVY.test(text)) { bump -= 1; reasons.push('short scaffold-type brief, tier -1'); }
      if (kind === 'doc-intake') floor = 'standard';
      if (RISK.test(text)) floor = 'standard';
    }
  }

  if (kind === 'question') {
    if (RISK.test(text)) { floor = 'deep'; reasons.push('risk words, at least deep'); }
    else if (words >= 25) { floor = 'standard'; reasons.push('long question, at least standard'); }
  } else if (kind === 'recon' || kind === 'small-edit') {
    if (RISK.test(text)) { floor = 'standard'; reasons.push('risk words, at least standard'); }
  }
  if (kind !== 'continue' && kind !== 'chat') {
    if (text.length > 1500 && !PHASE_KINDS.includes(kind)) { bump += 1; reasons.push('long prompt, tier +1'); }
    if (/^\W*(quick(ly)?|just)\b/i.test(text)) { bump -= 1; reasons.push('leading "quick/just", tier -1'); }
    bump = Math.max(-1, Math.min(1, bump));
  }
  return { kind, confidence, reasons, bump, floor };
}

/** Load <dataDir>/policy.json, seeding it from the template on first run. The user's copy wins. */
export function loadPolicy() {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const file = path.join(dataDir(), 'policy.json');
  const defaults = { target: tpl.target, minN: tpl.minN, explore: tpl.explore, spawnOverride: [] };
  try {
    const user = JSON.parse(fs.readFileSync(file, 'utf8'));
    // phase kinds added after a user's policy.json was seeded fall back to the template's tier
    return { ...defaults, ...user, kinds: { ...tpl.kinds, ...user.kinds } };
  } catch (e) {
    if (e.code === 'ENOENT') fs.copyFileSync(TEMPLATE, file);
    return tpl;
  }
}

/** Tier name for a classification, or null when there's nothing to route. Adjusts by bump, clamped to fast..deep. */
export function tierFor(result, policy) {
  const base = policy.kinds?.[result.kind];
  if (!base) return null;
  const b = TIERS.indexOf(base);
  let i = Math.max(0, Math.min(TIERS.length - 1, (b < 0 ? 1 : b) + (result.bump ?? 0)));
  i = Math.max(i, TIERS.indexOf(result.floor));
  return TIERS[i];
}
