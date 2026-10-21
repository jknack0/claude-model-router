// Parse Claude Code transcript JSONL: assistant usage, human prompts, boundaries, subagents.
import fs from 'node:fs';
import path from 'node:path';

export { tailUsage } from './tail.mjs';

/** All parsed lines of a transcript (bad JSON skipped). Whole file; hooks must use tailUsage instead. */
export function readSession(transcriptPath) {
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try { out.push(JSON.parse(raw)); } catch { /* skip */ }
  }
  return out;
}

const effortOf = (l) => {
  const e = l.effort ?? l.perTurnEffort;
  return (e && typeof e === 'object' ? e.level : e) ?? null;
};

/** Deduped assistant messages: one per message.id+requestId, keeping the line with the most output tokens. */
export function assistantMessages(lines) {
  const byKey = new Map();
  for (const l of lines) {
    const m = l.message;
    if (l.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
    const key = `${m.id}:${l.requestId ?? ''}`;
    const prev = byKey.get(key);
    const out = m.usage.output_tokens ?? 0;
    if (prev && out <= (prev.usage.output_tokens ?? 0)) continue;
    byKey.set(key, {
      id: m.id, ts: prev?.ts ?? l.timestamp, model: m.model, usage: m.usage,
      effort: effortOf(l), isSidechain: !!l.isSidechain,
    });
  }
  return [...byKey.values()];
}

const NOT_PROMPT = /^\s*<(command-name|command-message|command-args|local-command-|task-notification|system-reminder|bash-)|^(Stop hook feedback|Another Claude session sent a message|\[Image:|\[Request interrupted by user)/;

function userText(l) {
  const c = l.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && !c.some((b) => b.type === 'tool_result')) {
    return c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null;
  }
  return null;
}

/**
 * Real typed prompts plus boundary events, both in file order.
 * @returns {{prompts: {ts,uuid,text}[], boundaries: {ts, kind:'clear'|'compact'|'model'|'effort', args?}[]}}
 */
export function humanPrompts(lines) {
  const prompts = [];
  const boundaries = [];
  for (const l of lines) {
    if (l.isSidechain) continue;
    if (l.type === 'system' && l.subtype === 'compact_boundary') {
      boundaries.push({ ts: l.timestamp, kind: 'compact', args: l.compactMetadata?.trigger ?? '' });
      continue;
    }
    if (l.type !== 'user' || l.isMeta || l.isCompactSummary || l.toolUseResult || l.sourceToolAssistantUUID) continue;
    const text = userText(l);
    if (!text) continue;
    const cmd = /^\s*<command-name>\/(clear|model|effort)<\/command-name>/.exec(text);
    if (cmd) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim() ?? '';
      boundaries.push({ ts: l.timestamp, kind: cmd[1], args });
    } else if (!NOT_PROMPT.test(text)) {
      prompts.push({ ts: l.timestamp, uuid: l.uuid, text });
    }
  }
  return { prompts, boundaries };
}

/** Subagent transcripts of a session (including nested workflow ones), with sidecar meta. */
export function subagentFiles(transcriptPath) {
  const root = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const out = [];
  let ents;
  try { ents = fs.readdirSync(root, { recursive: true }); } catch { return out; }
  for (const rel of ents) {
    const m = /(?:^|\/)agent-([^/]+)\.jsonl$/.exec(rel);
    if (!m) continue;
    const file = path.join(root, rel);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* none */ }
    out.push({
      path: file, agentId: m[1], agentType: meta.agentType ?? null,
      description: meta.description ?? null, toolUseId: meta.toolUseId ?? null,
    });
  }
  return out;
}
