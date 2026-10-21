// Rough 30-day list-price spend baseline from Claude Code transcripts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

// $/MTok: [input, output, cacheRead]; cache write 5m = 1.25x input, 1h = 2x input
const PRICES = [
  [/fable/, [10, 50, 0.25]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus/, [5, 25, 0.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-5-5/, [0.1, 0.5, 0.01]],
  [/haiku/, [1, 5, 0.1]],
];
const price = (m) => (PRICES.find(([re]) => re.test(m)) || [null, null])[1];

const root = path.join(os.homedir(), '.claude/projects');
const cutoff = Date.now() - 30 * 864e5;
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs > cutoff) files.push(p);
  }
})(root);

const seen = new Map();
const agg = {};
let unpriced = 0;
for (const f of files) {
  const where = f.includes('/subagents/') ? 'sub' : 'main';
  const rl = readline.createInterface({ input: fs.createReadStream(f) });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const m = j.message;
    if (j.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
    const key = `${m.id}:${j.requestId ?? ''}`;
    // one message is written as several lines; keep the largest output count
    const prevOut = seen.get(key);
    if (prevOut !== undefined && (m.usage.output_tokens ?? 0) <= prevOut) continue;
    const isNew = prevOut === undefined;
    seen.set(key, m.usage.output_tokens ?? 0);
    const p = price(m.model);
    if (!p) { unpriced++; continue; }
    const u = m.usage;
    const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0;
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const k = `${m.model} ${where}`;
    const a = (agg[k] ??= { reqs: 0, in: 0, cw: 0, cr: 0, out: 0 });
    if (!isNew) { a.out += ((u.output_tokens ?? 0) - prevOut) * p[1] / 1e6; continue; }
    a.reqs++;
    a.in += (u.input_tokens ?? 0) * p[0] / 1e6;
    a.cw += (w5 * 1.25 + w1 * 2) * p[0] / 1e6;
    a.cr += (u.cache_read_input_tokens ?? 0) * p[2] / 1e6;
    a.out += (u.output_tokens ?? 0) * p[1] / 1e6;
  }
}
const rows = Object.entries(agg).map(([k, a]) => ({ k, ...a, t: a.in + a.cw + a.cr + a.out })).sort((x, y) => y.t - x.t);
const tot = rows.reduce((s, r) => s + r.t, 0);
const f2 = (n) => n.toFixed(2).padStart(9);
console.log('model/where'.padEnd(30), 'reqs'.padStart(7), '   input$', '  cwrite$', '   cread$', '     out$', '   total$', ' share');
for (const r of rows) console.log(r.k.padEnd(30), String(r.reqs).padStart(7), f2(r.in), f2(r.cw), f2(r.cr), f2(r.out), f2(r.t), (100 * r.t / tot).toFixed(1).padStart(5) + '%');
const sum = (f) => rows.reduce((s, r) => s + r[f], 0);
console.log(`\nfiles=${files.length} msgs=${seen.size} unpriced=${unpriced}`);
console.log(`TOTAL ${tot.toFixed(2)} | input ${(100*sum('in')/tot).toFixed(1)}% cwrite ${(100*sum('cw')/tot).toFixed(1)}% cread ${(100*sum('cr')/tot).toFixed(1)}% output ${(100*sum('out')/tot).toFixed(1)}%`);
