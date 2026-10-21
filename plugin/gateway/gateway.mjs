// Opt-in local proxy: routes the first request of an opus/fable conversation to a cheaper model,
// pins it for the rest of the conversation. See README.md.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { costOf, priceFor, resolveModel } from '../scripts/lib/pricing.mjs';
import { sub } from '../scripts/lib/paths.mjs';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');

// UNVERIFIED ASSUMPTION: the router's SessionStart hook output (first line of instructions/router.md) lands in
// the first user message of a MAIN session only, and subagent conversations never carry it. Without the marker
// the gateway passes the request through untouched (safe failure: hooks off => no-op).
const FALLBACK_MARKER = 'Router plugin: lines starting `[router]`';
function loadMarker() {
  try { return fs.readFileSync(new URL('../instructions/router.md', import.meta.url), 'utf8').split('\n')[0].trim() || FALLBACK_MARKER; }
  catch { return FALLBACK_MARKER; }
}
const MARKER = loadMarker();
const MAX_PINS = 1000;
/** The marker only counts inside a <system-reminder> block that also mentions SessionStart (the hook output wrapper);
 *  a subagent brief quoting the marker in plain text does not qualify. */
export function hasMarker(content) {
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '') : [];
  for (const t of blocks) for (const m of t.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) if (m[1].includes(MARKER) && m[1].includes('SessionStart')) return true;
  return false;
}

const stripReminders = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
/** The typed prompt: last non-empty text block of the message once system-reminder blocks are removed. */
export function typedPrompt(content) {
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '') : [];
  const kept = blocks.map(stripReminders).filter(Boolean);
  return kept.at(-1) ?? '';
}

const sysKey = (body) => sha1(textOf(body.system).slice(0, 2048));
export function conversationKey(body) {
  const first = (body.messages ?? []).find((m) => m.role === 'user');
  return sha1(textOf(body.system).slice(0, 2048) + '\n' + textOf(first?.content));
}

const isMain = (m) => /opus|fable|mythos/.test(resolveModel(m ?? ''));

function readPins(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** classify(text)->{kind}; policy = {tiers:{name:{model,effort}}, kinds:{kind:tier|null}} (object, or loaded from <dataDir>/policy.json).
 *  Pin = {model: model actually sent, requested, effort, kind, sys}. */
export function createGateway({ classify, policy, upstream = process.env.ROUTER_UPSTREAM || 'https://api.anthropic.com', dryRun = false } = {}) {
  const up = new URL(upstream);
  const basePath = up.pathname.replace(/\/$/, '');
  const lib = up.protocol === 'https:' ? https : http;
  const pinFile = sub('gateway-pins.json');
  const pins = readPins(pinFile);
  const getPolicy = () => {
    if (policy) return policy;
    try { return JSON.parse(fs.readFileSync(sub('policy.json'), 'utf8')); }
    catch { return JSON.parse(fs.readFileSync(new URL('../templates/policy.json', import.meta.url), 'utf8')); }
  };
  const log = (o) => { try { fs.appendFileSync(sub('gateway.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); } catch {} };

  let writeTimer = null, writing = false, dirty = false;
  function flushPins() {
    if (writing) { dirty = true; return; }
    writing = true;
    fs.promises.writeFile(pinFile, JSON.stringify(pins)).catch(() => {}).finally(() => { writing = false; if (dirty) { dirty = false; schedulePins(); } });
  }
  function schedulePins() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => { writeTimer = null; flushPins(); }, 100);
    writeTimer.unref?.();
  }
  function setPin(keys, pin) {
    for (const k of keys.filter(Boolean)) { delete pins[k]; pins[k] = pin; }
    const all = Object.keys(pins);
    for (const k of all.slice(0, Math.max(0, all.length - MAX_PINS))) delete pins[k];
    schedulePins();
  }

  // Decide the model for a parsed /v1/messages body (mutates body when a cheaper pin applies; dry-run only skips creating new downgrade pins). Returns log fields.
  async function decide(body) {
    const requested = body.model;
    const out = { requested, sent: requested, kind: null };
    if (!isMain(requested) || !Array.isArray(body.messages)) return out;
    const key = conversationKey(body);
    const marked = hasMarker(body.messages.find((m) => m.role === 'user')?.content);
    const uidRaw = body.metadata?.user_id ? 'u:' + body.metadata.user_id : null;
    const uid = marked ? uidRaw : null; // only marker-bearing (main) requests may create or overwrite a session-id pin
    const sk = sysKey(body);
    out.key8 = key.slice(0, 8);
    if (uidRaw) out.uid8 = sha1(uidRaw).slice(0, 8); // logged to help verify the metadata.user_id assumption
    const first = body.messages.length === 1 && body.messages[0].role === 'user';
    let pin = pins[key];
    // Key drift (compaction, resume): fall back to the session id, only for the same requested model and system prompt.
    if (!pin && !first && uidRaw && pins[uidRaw]?.requested === requested && pins[uidRaw].sys === sk) {
      pin = pins[uidRaw];
      setPin([key], pin);
      out.reason = 'uid-pin';
    }
    // Pins from an older gateway have no `requested`: treat as matching and backfill.
    if (pin && pin.requested == null) { pin.requested = requested; schedulePins(); }
    // The user switched models (/model): honor it and re-pin, no rewrite.
    if (pin && pin.requested !== requested) {
      setPin([key, uid], { model: requested, requested, effort: null, kind: null, sys: sk });
      out.reason = 'model-switch';
      return out;
    }
    if (!pin) {
      if (!first) { out.reason = 'unpinned-midstream'; return out; }
      if (!marked) { out.reason = 'no-marker'; return out; }
      let tier = null;
      try {
        const c = await classify(typedPrompt(body.messages[0].content));
        out.kind = c?.kind ?? null;
        const p = getPolicy();
        tier = p.tiers?.[p.kinds?.[out.kind]] ?? null;
      } catch {}
      const target = tier ? resolveModel(tier.model) : requested;
      const a = priceFor(target), b = priceFor(requested);
      const cheaper = !!(a && b && a.input < b.input);
      if (cheaper) out.would = target;
      // The pin stores what is actually sent: in dry-run that is the requested model.
      pin = { model: cheaper && !dryRun ? target : requested, requested, effort: cheaper && !dryRun ? tier?.effort ?? null : null, kind: out.kind, sys: sk };
      setPin([key, uid], pin);
      out.first = true;
    }
    out.kind = pin.kind ?? out.kind;
    const a = priceFor(pin.model), b = priceFor(requested);
    if (a && b && a.input < b.input) {
      out.sent = pin.model;
      body.model = pin.model;
      if (pin.effort && body.output_config?.effort) body.output_config.effort = pin.effort;
    }
    out.pinKeys = [key, uid];
    return out;
  }

  const server = http.createServer(async (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    let preq = null;
    res.on('close', () => { if (preq && !res.writableEnded) preq.destroy(); });
    try {
      const chunks = [];
      try { for await (const c of req) chunks.push(c); } catch { res.destroy(); return; }
      if (res.destroyed) return;
      const orig = Buffer.concat(chunks);
      let buf = orig;
      const path = req.url.split('?')[0];
      let info = null;
      if (req.method === 'POST' && path === '/v1/messages') {
        try {
          const body = JSON.parse(buf.toString('utf8'));
          info = await decide(body);
          if (info.sent !== info.requested) buf = Buffer.from(JSON.stringify(body));
        } catch { info = null; }
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
      headers.host = up.host;
      // Usage logging needs readable bytes, so ask for an uncompressed response on this path only.
      if (info) headers['accept-encoding'] = 'identity';

      const forward = (payload, canFallback) => {
        preq = lib.request({ hostname: up.hostname, port: up.port || undefined, path: basePath + req.url, method: req.method, headers: { ...headers, 'content-length': payload.length } }, (pres) => {
          // A rewritten first request that the cheaper model rejects: resend once unchanged and re-pin to the requested model.
          if (canFallback && info?.first && info.sent !== info.requested && pres.statusCode >= 400 && pres.statusCode < 500) {
            pres.resume();
            const model = info.requested;
            for (const k of info.pinKeys.filter(Boolean)) if (pins[k]) setPin([k], { ...pins[k], model, effort: null });
            log({ key8: info.key8, requested: info.requested, sent: info.sent, kind: info.kind, path, dryRun, status: pres.statusCode, reason: 'fallback-4xx' });
            info.sent = model;
            forward(orig, false);
            return;
          }
          const rh = {};
          for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k) || k === 'content-length') rh[k] = v;
          res.writeHead(pres.statusCode, rh);
          const sse = /event-stream/.test(pres.headers['content-type'] ?? '');
          let usage = null, line = '';
          const whole = [];
          if (info) pres.on('data', (c) => {
            if (!sse) { whole.push(c); return; }
            line += c.toString('utf8');
            const parts = line.split('\n');
            line = parts.pop();
            for (const l of parts) usage = mergeUsage(usage, l);
          });
          pres.on('end', () => {
            if (!info) return;
            if (sse) usage = mergeUsage(usage, line);
            else { try { usage = JSON.parse(Buffer.concat(whole).toString('utf8')).usage ?? null; } catch { usage = null; } }
            log({ key8: info.key8, uid8: info.uid8, requested: info.requested, sent: info.sent, would: info.would, reason: info.reason, kind: info.kind, path, dryRun, status: pres.statusCode, usage, cost: usage ? costOf(usage, info.sent)?.total ?? null : null });
          });
          pres.on('error', () => res.destroy());
          pres.on('close', () => { if (!pres.complete) res.destroy(); });
          pres.pipe(res);
        });
        preq.on('error', () => { if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); } });
        preq.end(payload);
      };
      forward(buf, true);
    } catch {
      try { res.headersSent ? res.destroy() : (res.writeHead(500), res.end()); } catch {}
    }
  });
  server.flushPinsSync = () => { if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; } fs.writeFileSync(pinFile, JSON.stringify(pins)); };
  return server;
}

// Fold one SSE line (message_start / message_delta) into the running usage.
function mergeUsage(usage, line) {
  if (!line.startsWith('data:')) return usage;
  let d; try { d = JSON.parse(line.slice(5)); } catch { return usage; }
  if (d.type === 'message_start') return { ...d.message?.usage };
  if (d.type === 'message_delta' && d.usage) return { ...usage, ...d.usage };
  return usage;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const a = process.argv.slice(2);
  const port = Number(a[a.indexOf('--port') + 1]) || 8787;
  const dryRun = a.includes('--dry-run');
  const { classify } = await import('../scripts/lib/classify.mjs');
  const gw = createGateway({ classify, dryRun });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { gw.flushPinsSync(); } catch {} process.exit(0); });
  gw.listen(port, '127.0.0.1', () =>
    console.log(`router gateway on http://127.0.0.1:${port} -> ${process.env.ROUTER_UPSTREAM || 'https://api.anthropic.com'}${dryRun ? ' (dry-run)' : ''}`));
}
