// Bits shared by the prompt hook (route.mjs) and the spawn hook (spawn.mjs).
import { TIERS } from './classify.mjs';

const STOP = new Set('this that with from have will would could should there their what when where which about into your just like then than them they been were also some more make need want please using used does only'.split(' '));
export const keywords = (s) => [...new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)))];
/** Share of `kw` that appears in `seen` (an iterable of words). 1 when `kw` is empty. */
export function overlap(kw, seen) {
  if (!kw.length) return 1;
  const set = new Set(seen);
  return kw.filter((w) => set.has(w)).length / kw.length;
}

/**
 * Exploration: sometimes try one tier cheaper while that tier has too little evidence for this kind
 * (counts come from learn.mjs --apply). Never below the classification's floor.
 * @returns {{tier:string, explore:boolean}}
 */
export function maybeExplore(tier, res, policy, rand = Math.random) {
  const cheaper = TIERS[TIERS.indexOf(tier) - 1];
  const n = policy.counts?.[res.kind]?.[cheaper];
  const ok = cheaper && n != null && n < (policy.minN ?? 8) && TIERS.indexOf(cheaper) >= TIERS.indexOf(res.floor) && rand() < (policy.explore ?? 0);
  return ok ? { tier: cheaper, explore: true } : { tier, explore: false };
}
