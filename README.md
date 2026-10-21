# claude-model-router

A Claude Code plugin (`router`) that sends each task to the cheapest **model, effort and context** that still gets the job done. It logs where the tokens went and learns a routing policy from how tasks turn out.

Why model, effort *and* context: on a real 30-day history, 93% of spend was context (cache reads 63%, cache writes 29%) and 7% was output. Opus 5.5 and Sonnet 5.5 cost the same to read from cache, so switching models alone saves little. See [PLAN.md](PLAN.md).

## What it does
| Part | How |
|---|---|
| **Spend ledger** | Reads Claude Code transcripts (`~/.claude/projects`) into per-task records: cost by token type, context size, subagents, outcome signals. Runs at SessionEnd and on demand. Needs no hooks to report. |
| **`/router:report`** | Totals by model and main vs subagent, context p50/p90, most expensive tasks, cost per subagent type, model × effort comparison, and re-priced what-ifs. |
| **Per-prompt routing** | A UserPromptSubmit hook classifies the prompt locally (no API call) and adds one `[router]` line telling Claude which `model`/`effort` to pass to subagents. It suggests `/clear` when a new topic arrives with a large context. Prompts like "ok" or "continue" get nothing. |
| **Tier agents** | `router:fast` (haiku/low, read-only), `router:standard` (sonnet/medium), `router:deep` (opus/high). Each reports `CONFIDENCE`. When a cheap tier struggles, Claude re-runs the task one tier up. |
| **Statusline** | `opus·high │ ctx 342K ~$0.07/req │ $4.12 │ ⇢ sonnet/medium`: what each extra request costs right now, and whether a cheaper main model would fit. |
| **Learning** | `/router:retro`: ingest, score each (task kind, tier) by outcome (corrections, escalations, blocked agents), and move a kind one tier cheaper only once the evidence clears the bar (n ≥ 8, Wilson lower bound ≥ 0.8). A 10% exploration probes the cheaper tier while it has little data. It also curates `learnings.md`, which is injected at session start. |
| **Shadow judge** | Optional and costs money. It replays a sample of past tasks one tier cheaper in throwaway git worktrees, and a Sonnet judge compares the results. It always shows an estimate first and needs `--yes`. |
| **Gateway** | Experimental and opt-in. A local proxy that enforces the routed model per conversation. See [plugin/gateway/README.md](plugin/gateway/README.md). |

The main session's model can't be switched by any hook (Claude Code's hooks can only block a model switch). So for the main session, the router *advises*; it pins only subagents. It never switches the model in the middle of a conversation, because caches and thinking blocks are tied to the model.

## Install
```bash
claude plugin marketplace add ~/Dev/claude_model_router
```
```bash
claude plugin install router@claude-model-router --scope user
```
Start a new session. Try `/router:report`.

**First run:** the first SessionStart builds a spend baseline from your last 30 days in the background (`baseline.json`, `init.json` in the data dir) and seeds the routing policy. Run `/router:init` to review it, write the first `learnings.md` and see the optional shadow estimate. `/router:retro` then reports spend against that baseline.

To try it for one session without installing:
```bash
claude --plugin-dir ~/Dev/claude_model_router/plugin
```

Requirements: Node 24+, and no npm dependencies. On a work machine with `allowManagedHooksOnly`, the hooks won't run, but `/router:report` and `/router:retro` still work.

### Statusline (optional)
Plugins can't set the statusline, so add this to `~/.claude/settings.json`:
```json
"statusLine": { "type": "command", "command": "node /Users/drfart/Dev/claude_model_router/plugin/scripts/statusline.mjs" }
```

## Data
Everything stays local, in `~/.claude/router` (the plugin's `data_dir` option):

| File | What |
|---|---|
| `sessions/*.json` | Ingested tasks (cost, context, subagents, signals, 160-char prompt preview) |
| `events.jsonl` | One line per routed prompt |
| `policy.json` | Kind → tier table plus learned counts and history. Edit it to override. |
| `learnings.md`, `retros.md` | Retro output |
| `shadow/results.jsonl` | Shadow-judge verdicts |
| `budget.json` | Optional `{"monthlyUsd": 500}`, so estimates show as a share of the budget |

## Commands
```bash
node plugin/scripts/report.mjs --days 30
```
```bash
node plugin/scripts/learn.mjs
```
```bash
node plugin/scripts/shadow.mjs plan --n 5
```
Prices are list prices from `plugin/scripts/lib/pricing.mjs` (as of 2026-10-06). They're estimates, not a bill.

## Develop
```bash
node --test test/*.test.mjs
```

## Work-machine checklist
1. Get the code: either `claude plugin marketplace add jknack0/claude-model-router` (private repo, so the machine needs GitHub access), or clone https://github.com/jknack0/claude-model-router and add the local folder.
2. Run `node --version`. It must be 24 or newer.
3. In Claude Code, check `/status`. If managed settings set `allowManagedHooksOnly`, plugin hooks won't run. `/router:report` and `/router:retro` still work, but routing, the statusline hints and the first-run baseline don't.
4. Install with the two commands under Install, then start a new session. The first session builds the baseline in the background, which took under 35 s on a month of history in testing. Then run `/router:init`.
5. Optional: create `~/.claude/router/budget.json` with `{"monthlyUsd": 500}`, so shadow estimates show as a share of the budget.
6. Leave the gateway off at work unless policy clearly allows an `ANTHROPIC_BASE_URL` proxy.
