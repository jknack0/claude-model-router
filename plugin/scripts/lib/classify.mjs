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
  const words = text.split(/\s+/).filter(Boolean).length;

  const stack = /^\s+at .+\(.+:\d+(:\d+)?\)|Traceback \(most recent call last\)|^\s*File ".+", line \d+/m.test(text);
  const bigBlock = (text.match(/```[\s\S]*?```/g) ?? []).some((b) => b.split('\n').length > 30);

  if (CONTINUE.test(text)) {
    kind = 'continue'; confidence = 0.95; reasons.push('short acknowledgement or choice');
  } else if (stack || bigBlock) {
    kind = 'debug'; confidence = 0.8; reasons.push(stack ? 'pasted stack trace' : 'code block over 30 lines');
  } else {
    for (const [k, re] of RULES) {
      const hit = k === 'question' ? re.test(text) && !EDIT_VERB.test(text)
        : k === 'small-edit' ? re.test(text) || (words <= 12 && CHANGE_TO.test(text))
          : re.test(text);
      if (hit) {
        kind = k; confidence = 0.7; reasons.push(`matched ${k} keywords`);
        break;
      }
    }
    if (kind === 'chat' && words <= 3) {
      kind = 'continue'; confidence = 0.6; reasons.push('3 words or fewer');
    }
  }

  let bump = 0;
  let floor = null;
  if (kind === 'question') {
    if (RISK.test(text)) { floor = 'deep'; reasons.push('risk words, at least deep'); }
    else if (words >= 25) { floor = 'standard'; reasons.push('long question, at least standard'); }
  } else if (kind === 'recon' || kind === 'small-edit') {
    if (RISK.test(text)) { floor = 'standard'; reasons.push('risk words, at least standard'); }
  }
  if (kind !== 'continue' && kind !== 'chat') {
    if (text.length > 1500) { bump += 1; reasons.push('long prompt, tier +1'); }
    if (/^\W*(quick(ly)?|just)\b/i.test(text)) { bump -= 1; reasons.push('leading "quick/just", tier -1'); }
    bump = Math.max(-1, Math.min(1, bump));
  }
  return { kind, confidence, reasons, bump, floor };
}

/** Load <dataDir>/policy.json, seeding it from the template on first run. The user's copy wins. */
export function loadPolicy() {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const file = path.join(dataDir(), 'policy.json');
  const defaults = { target: tpl.target, minN: tpl.minN, explore: tpl.explore };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
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
