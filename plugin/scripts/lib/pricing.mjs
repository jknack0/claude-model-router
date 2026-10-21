// List prices in $/MTok. Source: claude-api skill model table + shared/prompt-caching.md
// (cached 2026-10-06). Cache writes: 1.25x input (5m TTL), 2x input (1h TTL).
// Unverified: Haiku 5.5 cache read (assumed 0.1x input, like the other non-Opus-5.5 models).

export const PRICES_AS_OF = '2026-10-06';

// First match wins, so specific ids go before family fallbacks.
const TABLE = [
  { re: /fable|mythos/, input: 10, output: 50, cacheRead: 0.25 },
  { re: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { re: /opus/, input: 5, output: 25, cacheRead: 0.5 },
  { re: /sonnet-5/, input: 2, output: 10, cacheRead: 0.2 },
  { re: /sonnet/, input: 3, output: 15, cacheRead: 0.3 },
  // Haiku 5.5: prompts over 100K tokens bill at 5x.
  { re: /haiku-5-5/, input: 0.1, output: 0.5, cacheRead: 0.01, longAbove: 100_000, longMultiplier: 5 },
  { re: /haiku/, input: 1, output: 5, cacheRead: 0.1 },
];

// Aliases used in agent frontmatter, Agent tool params and router output.
export const ALIASES = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

export function resolveModel(model) {
  return ALIASES[model] ?? model;
}

/** @returns {{input:number, output:number, cacheRead:number, longAbove?:number, longMultiplier?:number} | null} */
export function priceFor(model) {
  if (!model || model === '<synthetic>') return null;
  const id = resolveModel(model);
  return TABLE.find((p) => p.re.test(id)) ?? null;
}

/** Total prompt tokens a request carried (fresh + cache write + cache read). */
export function promptTokens(usage) {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

/**
 * Dollar cost of one API response's `usage` block.
 * @returns {{in:number, cw:number, cr:number, out:number, total:number} | null} null when the model is unpriced
 */
export function costOf(usage, model) {
  const p = priceFor(model);
  if (!p || !usage) return null;
  const m = p.longAbove && promptTokens(usage) > p.longAbove ? p.longMultiplier : 1;
  const cc = usage.cache_creation ?? {};
  const w1h = cc.ephemeral_1h_input_tokens ?? 0;
  // Older transcripts have only the flat field; treat it as 5m writes.
  const w5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens ?? 0) - w1h);
  const c = {
    in: ((usage.input_tokens ?? 0) * p.input * m) / 1e6,
    cw: ((w5m * 1.25 + w1h * 2) * p.input * m) / 1e6,
    cr: ((usage.cache_read_input_tokens ?? 0) * p.cacheRead * m) / 1e6,
    out: ((usage.output_tokens ?? 0) * p.output * m) / 1e6,
  };
  c.total = c.in + c.cw + c.cr + c.out;
  return c;
}

/** Cost of re-reading `contextTokens` from cache once on `model` (the floor cost of one more request). */
export function perRequestContextCost(contextTokens, model) {
  const p = priceFor(model);
  if (!p) return null;
  const m = p.longAbove && contextTokens > p.longAbove ? p.longMultiplier : 1;
  return (contextTokens * p.cacheRead * m) / 1e6;
}
