// Statusline: <model>·<effort> │ ctx 342K ~$0.07/req │ $4.12 │ ⇢ sonnet/medium. No transcript reads.
import fs from 'node:fs';
import { sub } from './lib/paths.mjs';
import { perRequestContextCost, priceFor } from './lib/pricing.mjs';

try {
  const d = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const id = d.model?.id ?? '';
  const short = (id.match(/opus|sonnet|haiku|fable/) ?? [d.model?.display_name ?? '?'])[0];
  const cw = d.context_window ?? {};
  // current_usage is the last API call's usage = the live context; fall back to the percentage, then to the running total.
  const cu = cw.current_usage;
  const ctx = cu
    ? (cu.input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0)
    : cw.used_percentage != null && cw.context_window_size
      ? Math.round((cw.used_percentage / 100) * cw.context_window_size)
      : cw.total_input_tokens ?? 0;
  const parts = [d.effort?.level ? `${short}·${d.effort.level}` : short];
  if (ctx) {
    const c = perRequestContextCost(ctx, id);
    parts.push(`ctx ${Math.round(ctx / 1000)}K${c != null ? ` ~$${c.toFixed(2)}/req` : ''}`);
  }
  if (d.cost?.total_cost_usd != null) parts.push(`$${d.cost.total_cost_usd.toFixed(2)}`);
  if (d.session_id) {
    try {
      const st = JSON.parse(fs.readFileSync(sub('state', `${d.session_id}.json`), 'utf8'));
      const rec = st.recommendedMain;
      const pr = priceFor(rec?.split('/')[0]);
      const cur = priceFor(id);
      if (pr && cur && pr.input < cur.input) parts.push(`⇢ ${rec}`);
    } catch {}
  }
  process.stdout.write(parts.join(' │ '));
} catch {}
process.exit(0);
