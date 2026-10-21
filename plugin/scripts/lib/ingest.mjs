// Turn transcripts into per-session task summaries under <dataDir>/sessions/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sub, projectsDir } from './paths.mjs';
import { costOf, promptTokens } from './pricing.mjs';
import { readSession, assistantMessages, humanPrompts, subagentFiles } from './transcripts.mjs';

const VERSION = 5; // bump to force re-ingest when the session file shape changes

// ---- per-request helpers (also used by report.mjs) ----
// A request is stored as [model, input, cacheWrite5m, cacheWrite1h, cacheRead, output].
export function toReq(m) {
  const u = m.usage;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1);
  return [m.model, u.input_tokens ?? 0, w5, w1, u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0];
}
export function reqUsage(r) {
  return {
    input_tokens: r[1], cache_creation_input_tokens: r[2] + r[3],
    cache_creation: { ephemeral_5m_input_tokens: r[2], ephemeral_1h_input_tokens: r[3] },
    cache_read_input_tokens: r[4], output_tokens: r[5],
  };
}
export const reqCtx = (r) => promptTokens(reqUsage(r));
/** Cost of a stored request, optionally re-priced on another model. Zeros when unpriced. */
export function reqCost(r, model = r[0]) {
  return costOf(reqUsage(r), model) ?? { in: 0, cw: 0, cr: 0, out: 0, total: 0 };
}
const ZERO = () => ({ in: 0, cw: 0, cr: 0, out: 0, total: 0 });
const addCost = (a, b) => { for (const k in a) a[k] += b[k]; return a; };
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const mode = (xs) => {
  const c = {};
  for (const x of xs) if (x != null) c[x] = (c[x] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const tierOf = (model) => (/haiku/.test(model) ? 0 : /sonnet/.test(model) ? 1 : /opus/.test(model) ? 2 : /fable|mythos/.test(model) ? 3 : -1);

function summarize(reqs) {
  const cost = ZERO();
  const ctxs = reqs.map(reqCtx).sort((a, b) => a - b);
  for (const r of reqs) addCost(cost, reqCost(r));
  return { requests: reqs.length, cost, ctxP50: pct(ctxs, 0.5), ctxMax: ctxs.at(-1) ?? 0, reqs };
}

// ---- signals ----
const CORR_START = /^\s*(no|nope|wrong|that'?s not|still|doesn'?t work|didn'?t work|revert|undo)\b/i;
const CORR_SHORT = /\b(wrong|doesn'?t work|didn'?t work|revert|undo|still)\b/i;
const isCorrection = (t) => CORR_START.test(t) || (t.trim().split(/\s+/).length <= 6 && CORR_SHORT.test(t));
const STOP = new Set('the and for with from that this into have your you are was were not but can all any its our out use using then them they what when where which will would should could just also than'.split(' '));
const kws = (t) => new Set((String(t ?? '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
const kwOverlap = (earlier, later) => { const a = kws(earlier), b = kws(later); if (!b.size) return 0; let n = 0; for (const w of b) if (a.has(w)) n++; return n / b.size; };
const ROUTER_RANK = { 'router:fast': 0, 'router:standard': 1, 'router:deep': 2 };
const rank = (s) => ROUTER_RANK[s.type] ?? tierOf(s.model ?? '');
const DENIED = 'denied by the Claude Code auto mode classifier';
const blockText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : '');

function lastStatus(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.type !== 'assistant' || !Array.isArray(l.message?.content)) continue;
    const text = l.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text) continue;
    const all = [...text.matchAll(/STATUS:\s*(done|partial|blocked)/gi)];
    return all.length ? all.at(-1)[1].toLowerCase() : null;
  }
  return null;
}

export function loadEvents() {
  const bySession = {};
  let text = '';
  try { text = fs.readFileSync(sub('events.jsonl'), 'utf8'); } catch { /* none yet */ }
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try { const e = JSON.parse(raw); (bySession[e.sessionId] ??= []).push(e); } catch { /* skip */ }
  }
  return bySession;
}

/** Parse one session (main + subagents) into the session-file shape. */
export function buildSession(transcriptPath, events = loadEvents()) {
  const sessionId = path.basename(transcriptPath, '.jsonl');
  const lines = readSession(transcriptPath);
  const msgs = assistantMessages(lines).filter((m) => !m.isSidechain);
  const { prompts, boundaries } = humanPrompts(lines);
  const project = lines.find((l) => l.cwd)?.cwd ?? null;
  // non-interactive runs: claude -p / SDK write entrypoint sdk-*; shadow replays live in router-shadow-* dirs
  const entrypoint = lines.find((l) => l.entrypoint)?.entrypoint ?? null;
  // `claude -p` inherits entrypoint from its parent (e.g. claude-desktop), so the first user line's turnOrigin is the reliable tell
  const firstUser = lines.find((l) => l.type === 'user');
  const headless = firstUser?.turnOrigin === 'sdk' || /^sdk/.test(entrypoint ?? '') || /router-shadow-/.test(project ?? '');

  // task starts: the beginning, each /clear, each compaction
  const starts = [{ ts: '', boundary: 'start' }];
  for (const b of boundaries) if (b.kind === 'clear' || b.kind === 'compact') starts.push({ ts: b.ts, boundary: b.kind });
  // topic shifts flagged by the router hook: match each to the human prompt that followed it
  // The hook stamps its event after the prompt, so match on the hash both records store; failing that, the
  // last human prompt at most 30 s before the event. Corrections never open a topic.
  const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
  const sessionEvents = events[sessionId] ?? [];
  const promptEvents = sessionEvents.filter((e) => e.type !== 'spawn');
  const spawnEvents = sessionEvents.filter((e) => e.type === 'spawn');
  const claimed = new Set();
  for (const e of promptEvents) {
    if (e.boundary !== 'topic') continue;
    const cands = prompts.slice(1).filter((x) => !isCorrection(x.text));
    const gap = (x) => Math.abs(Date.parse(x.ts) - Date.parse(e.ts));
    let p = e.hash ? cands.filter((x) => sha(x.text) === e.hash).sort((x, y) => gap(x) - gap(y))[0] : null;
    p ??= cands.filter((x) => { const d = Date.parse(e.ts) - Date.parse(x.ts); return d >= 0 && d < 30_000; }).at(-1);
    if (p && !starts.some((s) => s.ts === p.ts)) starts.push({ ts: p.ts, evTs: e.ts, boundary: 'topic' });
  }
  starts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const taskOf = (ts) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1].ts <= ts) i++;
    return i;
  };
  const tasks = starts.map((s, idx) => ({
    idx, boundary: s.boundary, start: null, end: null, prompts: [], mainReqs: [], mainReqTs: [], mainEfforts: [],
    subs: [], signals: { corrections: 0, toolErrors: 0, denials: 0, bashFails: 0, escalations: 0 },
  }));
  const touch = (t, ts) => {
    if (!ts) return;
    if (!t.start || ts < t.start) t.start = ts;
    if (!t.end || ts > t.end) t.end = ts;
  };

  for (const p of prompts) {
    const t = tasks[taskOf(p.ts)];
    if (isCorrection(p.text)) {
      // a correction belongs to the task it corrects, even when a compaction opened a new one
      if (t.prompts.length) t.signals.corrections++;
      else if (t.boundary === 'compact' && t.idx > 0) tasks[t.idx - 1].signals.corrections++;
    }
    const text = p.text.replace(/\s+/g, ' ').trim();
    t.prompts.push({ ts: p.ts, hash: sha(p.text), preview: text.slice(0, 160) });
    touch(t, p.ts);
  }
  for (const m of msgs) {
    const t = tasks[taskOf(m.ts)];
    t.mainReqs.push(toReq(m));
    t.mainReqTs.push(m.ts);
    t.mainEfforts.push(m.effort);
    touch(t, m.ts);
  }

  // tool calls and results (signals, Agent links)
  const toolUses = new Map(); // tool_use id -> {name, ts, subagentType}
  for (const l of lines) {
    if (l.type !== 'assistant' || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message.content) {
      if (b.type === 'tool_use') toolUses.set(b.id, { name: b.name, ts: l.timestamp, subagentType: b.input?.subagent_type ?? null });
    }
  }
  const resolved = new Map(); // agentId -> resolvedModel
  for (const l of lines) {
    if (l.type !== 'user' || !Array.isArray(l.message?.content)) continue;
    const t = tasks[taskOf(l.timestamp)];
    const tur = l.toolUseResult;
    if (tur && typeof tur === 'object' && tur.agentId && tur.resolvedModel) resolved.set(tur.agentId, tur.resolvedModel);
    for (const b of l.message.content) {
      if (b.type !== 'tool_result') continue;
      if (b.is_error === true) {
        t.signals.toolErrors++;
        if (toolUses.get(b.tool_use_id)?.name === 'Bash') t.signals.bashFails++;
      }
      if (l.permissionDecision?.decision === 'reject' || blockText(b.content).includes(DENIED)) t.signals.denials++;
    }
  }

  // subagents
  for (const f of subagentFiles(transcriptPath)) {
    const sl = readSession(f.path);
    const sm = assistantMessages(sl);
    if (!sm.length) continue;
    const use = f.toolUseId ? toolUses.get(f.toolUseId) : null;
    const reqs = sm.map(toReq);
    const model = mode(sm.map((m) => m.model)) ?? resolved.get(f.agentId);
    const startTs = use?.ts ?? sl.find((l) => l.timestamp)?.timestamp ?? sm[0].ts;
    const t = tasks[taskOf(startTs)];
    // the spawn hook's record of this subagent: by tool_use id, else same description hash and the nearest ts
    let sp = f.toolUseId ? spawnEvents.find((e) => e.toolUseId === f.toolUseId) : null;
    if (!sp && f.description) {
      const dh = sha(f.description), gap = (e) => Math.abs(Date.parse(e.ts) - Date.parse(startTs));
      sp = spawnEvents.filter((e) => e.descHash === dh && !claimed.has(e) && gap(e) < 10 * 60_000).sort((x, y) => gap(x) - gap(y))[0];
    }
    if (sp) claimed.add(sp);
    t.subs.push({
      type: f.agentType ?? use?.subagentType ?? 'unknown', model, effort: mode(sm.map((m) => m.effort)),
      description: (f.description ?? '').slice(0, 160), startTs, ...summarize(reqs), status: lastStatus(sl),
      ...(sp ? { routedPhase: sp.phase ?? null, routedTier: sp.tier ?? null, routedSet: sp.set === true, explore: !!sp.explore, briefChars: sp.briefChars ?? null } : {}),
    });
    touch(t, startTs);
    touch(t, sm.at(-1).ts);
  }

  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.mainReqs.length && !t.subs.length) continue;
    // escalations: a later run at a higher tier redoing an earlier lower-tier run: same type, a router:<tier>
    // pair, or a description sharing >= 50% of its keywords with the earlier one
    t.subs.sort((a, b) => (a.startTs < b.startTs ? -1 : 1));
    t.subs.forEach((s, j) => {
      const tier = rank(s);
      const lower = t.subs.slice(0, j).filter((e) => rank(e) < tier && (e.type === s.type || (ROUTER_RANK[e.type] != null && ROUTER_RANK[s.type] != null) || kwOverlap(e.description, s.description) >= 0.5));
      if (lower.length) t.signals.escalations++;
      for (const e of lower) e.escalated = true; // the lower half of an escalation pair
    });
    // the first turn alone (up to the 2nd human prompt): what a shadow replay would redo
    const p2 = t.prompts[1]?.ts ?? '\uffff';
    const turn1 = [...t.mainReqs.filter((_, k) => t.mainReqTs[k] < p2), ...t.subs.filter((s) => s.startTs < p2).flatMap((s) => s.reqs)];
    // evidence: the user corrected, kept talking, or moved on to another topic. A lone prompt, a session's last
    // task and a task followed by /clear (or a bare compaction) tell us nothing.
    const next = tasks.slice(i + 1).find((x) => x.mainReqs.length || x.subs.length);
    // An escalation or a blocked/partial subagent is evidence on its own: the fast tier's failure is real even in a last task.
    const evidence = t.signals.corrections > 0 || t.signals.escalations > 0 || t.subs.some((s) => s.status === 'partial' || s.status === 'blocked') || t.prompts.length >= 2 || !!(next && next.boundary !== 'clear' && next.prompts.length);
    const lo = starts[i].evTs ?? starts[i].ts, hi = starts[i + 1]?.evTs ?? starts[i + 1]?.ts ?? '￿';
    const mainModels = {};
    for (const r of t.mainReqs) mainModels[r[0]] = (mainModels[r[0]] ?? 0) + 1;
    const main = summarize(t.mainReqs);
    const subs = t.subs.map(({ startTs, ...s }) => s);
    out.push({
      idx: out.length, boundary: t.boundary, start: t.start, end: t.end, prompts: t.prompts,
      mainModels, mainEffort: mode(t.mainEfforts), main, subagents: subs,
      routed: promptEvents.filter((e) => e.ts >= lo && e.ts < hi),
      turn1, evidence, signals: t.signals, total: main.cost.total + subs.reduce((s, x) => s + x.cost.total, 0),
    });
  }
  return { sessionId, project, entrypoint, headless, file: transcriptPath, ingestedAt: new Date().toISOString(), tasks: out };
}

// ---- incremental driver ----
const statePath = () => sub('ingest-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}
function saveState(state) {
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath());
}

/** Signature of a session's files: main + every subagent file. {sig, mtimeMs} */
function signature(file) {
  const st = fs.statSync(file);
  let mtimeMs = st.mtimeMs;
  const parts = [VERSION, st.size, st.mtimeMs];
  for (const f of subagentFiles(file)) {
    try {
      const s = fs.statSync(f.path);
      parts.push(f.path, s.size, s.mtimeMs);
      mtimeMs = Math.max(mtimeMs, s.mtimeMs);
    } catch { /* vanished */ }
  }
  return { sig: crypto.createHash('sha1').update(parts.join('|')).digest('hex'), mtimeMs };
}

function writeSession(session) {
  const f = sub('sessions', `${session.sessionId}.json`);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session));
  fs.renameSync(tmp, f);
}

/** Ingest one session; idempotent. */
export function ingestSession(transcriptPath) {
  const state = loadState();
  const { sig } = signature(transcriptPath);
  const session = buildSession(transcriptPath);
  writeSession(session);
  state[transcriptPath] = { sig };
  saveState(state);
  return session;
}

/** Walk projectsDir(); re-ingest sessions whose files changed. Only files touched within `days` count. */
export function ingestAll({ days = 30 } = {}) {
  const cutoff = Date.now() - days * 864e5;
  const state = loadState();
  const events = loadEvents();
  const sessionIds = [];
  let ingested = 0;
  let root = [];
  try { root = fs.readdirSync(projectsDir(), { withFileTypes: true }); } catch { /* no projects */ }
  for (const d of root) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir(), d.name);
    for (const e of fs.readdirSync(dir)) {
      if (!e.endsWith('.jsonl')) continue;
      const file = path.join(dir, e);
      let s;
      try { s = signature(file); } catch { continue; }
      if (s.mtimeMs < cutoff) continue;
      const id = path.basename(e, '.jsonl');
      sessionIds.push(id);
      if (state[file]?.sig === s.sig && fs.existsSync(sub('sessions', `${id}.json`))) continue;
      try {
        writeSession(buildSession(file, events));
        state[file] = { sig: s.sig };
        ingested++;
      } catch (err) {
        fs.appendFileSync(sub('errors.log'), `${new Date().toISOString()} ingest ${file}: ${err.stack}\n`);
      }
    }
  }
  saveState(state);
  return { sessionIds, ingested };
}
