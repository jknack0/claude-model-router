# Experimental gateway

An opt-in local proxy. For a new opus/fable **main-session** conversation it classifies the typed first prompt and, if the
policy maps it to a cheaper tier, sends that request (and every later one in the conversation) to the
cheaper model. Haiku, sonnet and `count_tokens` requests are never touched. It never upgrades a model.

## Setup
```
node plugin/gateway/gateway.mjs --dry-run          # try this first: logs decisions, forwards unchanged
node plugin/gateway/gateway.mjs [--port 8787]      # real routing
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude    # in another terminal
```
Upstream defaults to `https://api.anthropic.com`; override with `ROUTER_UPSTREAM`. It binds 127.0.0.1 only.
Policy comes from `<dataDir>/policy.json` (falls back to `plugin/templates/policy.json`).
Check `<dataDir>/gateway.jsonl` (`{ts,key8,uid8,requested,sent,would,reason,kind,path,usage,cost}`) to see what it would do or did.

## Stop
Ctrl-C the gateway, then start `claude` without `ANTHROPIC_BASE_URL`.

## Caveats
- Claude Code's local cost display uses the model it requested, so it will show opus prices; use `gateway.jsonl` for real cost.
- Enterprise policy may forbid a gateway or a custom base URL.
- **Unverified assumption 1 (main-thread marker):** the gateway only rewrites a conversation whose first user message
  contains the first line of `plugin/instructions/router.md` (the SessionStart hook output). It assumes that hook runs in
  main sessions only, so subagent conversations (including opus `router:deep` escalations) never carry it and pass through
  with `reason:'no-marker'`. Not verified against a live Claude Code. With hooks disabled the gateway is a no-op.
- **Unverified assumption 2 (`metadata.user_id`):** Claude Code is assumed to send a stable per-session id there. Pins are
  also indexed by it, so a conversation whose key drifts (compaction, resume) keeps its pin if the requested model and system
  prompt match. The hashed id is logged as `uid8`; check it is stable before trusting this. Without a match a mid-conversation
  request passes through (`reason:'unpinned-midstream'`).
- Only the typed prompt is classified (`<system-reminder>` blocks are stripped, last remaining text block used).
- Pins live per conversation (key = first system text + first user message), in memory and `<dataDir>/gateway-pins.json`
  (max 1,000, oldest dropped; written debounced and async). A pin stores the model actually sent, so `--dry-run` pins are
  the requested model and never affect a later real run. Caches and thinking blocks are model-bound, so the model never
  changes mid-conversation, except: if the user switches model (`/model`), the new model is honored and re-pinned; if a
  rewritten first request gets a 4xx, it is re-sent unchanged and pinned to the requested model (`reason:'fallback-4xx'`).
  Later 4xx are not retried, and `max_tokens`/context window are not clamped to the cheaper model.
- In dry-run, `sent` is the requested model, `would` is what real mode would send, and cost is priced at the model sent.
- `ROUTER_UPSTREAM` may include a path prefix, which is kept.
- Headers (`anthropic-beta`, `anthropic-version`, auth) and `cache_control` / block-form `system` pass through verbatim.
  Only on `/v1/messages` POSTs the gateway asks upstream for an uncompressed response so it can read usage.
- Responses are streamed through unbuffered; usage is read from a copy of the stream.
