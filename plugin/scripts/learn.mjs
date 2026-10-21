#!/usr/bin/env node
// CLI: node learn.mjs [--days 30] [--apply] [--json]   success stats per (kind, tier) and proposed policy moves.
import fs from 'node:fs';
import { sub } from './lib/paths.mjs';
import { TIERS, loadPolicy } from './lib/classify.mjs';
import { ingestAll } from './lib/ingest.mjs';
import { loadTasks, loadShadow, buildStats, propose, countsOf } from './lib/policy.mjs';

export function learn({ days = 30, apply = false } = {}) {
  ingestAll({ days });
  const policy = loadPolicy();
  const stats = buildStats(loadTasks({ days }), loadShadow(), policy);
  const moves = propose(stats, policy);
  const counts = countsOf(stats, policy);
  if (apply) {
    const next = { ...policy, kinds: { ...policy.kinds }, counts, history: [...(policy.history ?? [])] };
    for (const m of moves) {
      next.kinds[m.kind] = m.to;
      next.history.push({ ts: new Date().toISOString(), kind: m.kind, from: m.from, to: m.to, evidence: m.evidence });
    }
    const f = sub('policy.json'), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, f);
  }
  return { stats, moves, policy, counts };
}

export function formatTable({ stats, moves, policy }) {
  const lines = ['kind         tier      n  succ   lb   med$/task  policy'];
  for (const kind of Object.keys(stats).sort()) {
    for (const t of TIERS) {
      const c = stats[kind][t];
      if (!c) continue;
      lines.push(`${kind.padEnd(12)} ${t.padEnd(9)}${String(c.n).padStart(3)} ${String(c.succ).padStart(5)} ${c.lb.toFixed(2).padStart(5)} ${('$' + c.med.toFixed(2)).padStart(9)}  ${policy.kinds?.[kind] === t ? '<- current' : ''}`);
    }
  }
  lines.push('', `target lb >= ${policy.target ?? 0.8}, minN ${policy.minN ?? 8}, explore ${policy.explore ?? 0}`);
  lines.push(moves.length ? 'Proposed moves:' : 'No policy moves proposed.');
  for (const m of moves) lines.push(`  ${m.kind}: ${m.from} -> ${m.to} (${m.evidence})`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const days = Number(a[a.indexOf('--days') + 1]) || 30;
  const apply = a.includes('--apply');
  try {
    const r = learn({ days: a.includes('--days') ? days : 30, apply });
    console.log(a.includes('--json') ? JSON.stringify({ stats: r.stats, moves: r.moves }, null, 2) : formatTable(r));
    if (apply) console.log(r.moves.length ? `applied ${r.moves.length} move(s) to policy.json` : 'policy.json unchanged except evidence counts');
  } catch (e) {
    console.error(e.message);
  }
}
