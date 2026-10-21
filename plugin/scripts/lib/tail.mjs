// Latest main-thread assistant usage from the last ~256 KB of a transcript.
import fs from 'node:fs';
import { promptTokens } from './pricing.mjs';

const TAIL = 256 * 1024;

/** @returns {{model:string, usage:object, effort:string|null, contextTokens:number} | null} */
export function tailUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const start = Math.max(0, size - TAIL);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  let best = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const m = o.message;
    if (o.type !== 'assistant' || o.isSidechain || !m?.usage || !m.model || m.model === '<synthetic>') continue;
    if (best && best.id !== m.id) break; // older message
    // Several lines share one message.id; keep the one with the most output tokens.
    if (!best || (m.usage.output_tokens ?? 0) > (best.usage.output_tokens ?? 0)) {
      best = { id: m.id, model: m.model, usage: m.usage, effort: o.effort ?? o.perTurnEffort ?? null };
    }
  }
  if (!best) return null;
  return { model: best.model, usage: best.usage, effort: best.effort, contextTokens: promptTokens(best.usage) };
}
