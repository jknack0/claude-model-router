# Phase 1 + 2 implementation spec

Read first: `PLAN.md` (why), `docs/facts/claude-code.md` (hook/statusline/agent facts), `docs/facts/transcripts.md` (transcript schema).

## Ground rules (all items)
- **Runtime:** Node 24 ESM `.mjs`, **no npm dependencies**, built-ins only. Tests use `node:test` + `node:assert/strict` under `test/`, and run with `node --test test/*.test.mjs` (`node --test test/` fails on Node 24).
- **Shared contract (already written, don't change the API):**
  - `plugin/scripts/lib/pricing.mjs`: `costOf`, `priceFor`, `promptTokens`, `perRequestContextCost`, `resolveModel`, `ALIASES`, `PRICES_AS_OF`.
  - `plugin/scripts/lib/paths.mjs`: `dataDir`, `projectsDir`, `sub`.
  - Tests may set `ROUTER_DATA_DIR` and `ROUTER_PROJECTS_DIR` to temp dirs.
- **Hooks must never break a session.** Catch everything, exit 0, print nothing on error (log errors to `<dataDir>/errors.log`). Budget: under 300 ms typical, never read a whole large transcript in a hook (tail-read only, last ~256 KB).
- **Everything injected into context costs tokens on every later request.** Router output to the model: under 600 chars per prompt, and nothing at all when there's nothing to say.
- **Simplest thing that works.** No config flags for rejected ideas. Match orch's style (short comments, plain names).
- **Privacy:** data stays local in the data dir. Store a prompt preview of at most 160 chars plus a sha1 hash, not full prompts.

---

## Item 1: transcript parsing (`plugin/scripts/lib/transcripts.mjs`)
Exports:
- `readSession(transcriptPath)`: an async generator or array of parsed lines. Skip bad JSON.
- `assistantMessages(lines)`: deduped by `message.id` (+`requestId`), keeping the line with the max `output_tokens`. Returns `{id, ts, model, usage, effort, isSidechain}`. `effort` comes from the line's top-level `effort` / `perTurnEffort` (see the facts file). Skip `<synthetic>`.
- `humanPrompts(lines)`: real typed prompts only, using the filter from `docs/facts/transcripts.md`. Returns `{ts, uuid, text}`. Also return boundary events so tasks can split on them:
  - `/clear` keeps the **same session file**; the /clear user line starts a new chain with `parentUuid: null`;
  - compaction shows up as a `system` line with subtype `compact_boundary` (+ an `isCompactSummary` user line, which is not a human prompt);
  - `/model` and `/effort` echoes, if present.
  Use `{ts, kind:'clear'|'compact'|'model'|'effort', args}`.
- `subagentFiles(transcriptPath)`: subagent transcript paths for a session, with agentType, description and toolUseId from the sidecar meta.json. The model comes from the subagent's own assistant lines, or from the parent tool_result's `toolUseResult.resolvedModel`; see the facts file.
- `tailUsage(transcriptPath)`: reads only the last ~256 KB and returns the latest main-thread assistant `{model, usage, contextTokens}` or null. Item 4's hooks use it.

## Item 2: ingest (`plugin/scripts/lib/ingest.mjs` + CLI `plugin/scripts/ingest.mjs`)
- `ingestAll({days=30})`: walks `projectsDir()`. It re-ingests a session only when its main file or any of its subagent files changed size or mtime (tracked in `ingest-state.json`), then writes `sessions/<sessionId>.json`. Must handle ~1,700 files / 130K messages in under ~60 s cold and under 3 s warm.
- `ingestSession(transcriptPath)`: one session, used by the SessionEnd hook.
- **Task segmentation:** a new task starts at the first human prompt, at each `/clear`, and after a compaction boundary. (Phase 3 will add topic-shift detection; leave a `boundary` field saying why: 'start' | 'clear' | 'compact'.)
- **Session file shape:**
```json
{ "sessionId": "...", "project": "<cwd>", "file": "<path>", "ingestedAt": "...",
  "events": { "efforts": [{"ts":"...","level":"high"}] },
  "tasks": [{
    "idx": 0, "boundary": "start", "start": "ts", "end": "ts",
    "prompts": [{"ts":"...","hash":"sha1","preview":"<=160 chars"}],
    "mainModels": {"claude-opus-5-5": 120},
    "main": {"requests": 120, "cost": {"in":0,"cw":0,"cr":0,"out":0,"total":0}, "ctxP50": 0, "ctxMax": 0},
    "subagents": [{"type":"orch:scout","model":"claude-haiku-5-5","description":"...","requests":30,"cost":{...},"ctxP50":0,"ctxMax":0,"status":"done|partial|blocked|null"}],
    "signals": {"corrections":0,"toolErrors":0,"denials":0,"bashFails":0,"escalations":0},
    "total": 0
  }]
}
```
- **Subagent attribution:** a subagent belongs to the task that contains its parent Agent tool_use (fall back to its timestamp).
- **Signals:**
  - corrections: a human prompt that is a correction ("no", "wrong", "that's not", "still", "doesn't work", "didn't work", "revert", "undo", case-insensitive at the start or as a short prompt). Count it on the task it follows.
  - toolErrors: tool_result `is_error`.
  - denials: a tool_result with `permissionDecision.decision == "reject"`, or the classifier-denied text from the facts file.
  - bashFails: Bash results with `is_error: true` (the content starts with "Exit code N"; there's no exitCode field).
  - escalations: within a task, a later Agent call with the same `subagent_type` and a higher model tier than an earlier one (haiku < sonnet < opus < fable). Agent tool_use input usually has no `model`, so compare `toolUseResult.resolvedModel` or the subagent file's model.
  - `status`: the last `STATUS:` word in the subagent's final message.
- **Effort:** it's recorded per assistant line, so store the task's main effort as the most common value (`mainEffort`), plus each subagent's effort. The router's `events.jsonl` (item 4) adds `{ts, sessionId, kind, tier, explore}`; ingest attaches the matching events to tasks as `routed: [...]`. Drop the `events.efforts` field from the shape above.

## Item 3: report (`plugin/scripts/report.mjs` + skill `plugin/skills/report/SKILL.md`)
`node report.mjs [--days 30] [--project <substr>] [--json]`: runs `ingestAll` first, then prints plain text (fits about 100 columns):
1. **Totals:** total $, plus the share of input / cache write / cache read / output, split by model × main/sub (like `tools/baseline.mjs`).
2. **Context:** p50 / p90 / mean / share over 100K, for main and sub requests.
3. **Per task:** count, p50 / p90 / mean $ per task, the most expensive 10 tasks (date, project basename, preview, $, requests, ctxMax, `$ in cache reads`).
4. **Subagents by type:** type × model, then runs, $, $/run and ctxP50. Shows which agents are expensive and whether their briefs are fat.
5. **Settings comparison** (measures the zero-code options): tasks grouped by `(main model family, mainEffort)`, giving tasks, p50 $/task, p50 requests/task and correction rate. Mark groups with fewer than 5 tasks as low-n.
6. **What-ifs** (same tokens, re-priced):
   - (a) Opus 5.5 subagents → Sonnet 5.5;
   - (b) subagent types whose name contains scout/explore/researcher/fast → Haiku 5.5, with the 100K rule applied;
   - (c) main sessions on Sonnet 5.5.
   Each says "same tokens, re-priced; quality not measured".
7. Header line: `prices as of <PRICES_AS_OF>; list-price estimate, not a bill`.

`--json` prints the same data as one JSON object.

The SKILL.md (`name: report`) runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs"` with the user's flags via Bash, then summarizes the 3–5 biggest levers in plain words. Check whether skills get `CLAUDE_PLUGIN_ROOT`. If they don't, have the skill locate the script with `ls ~/.claude/plugins/cache/*/router/*/scripts/report.mjs` or similar, and say what you did.

## Item 4: routing (phase 2)
### 4a. Classifier (`plugin/scripts/lib/classify.mjs`)
- `classify(prompt) -> {kind, confidence, reasons[]}` using local heuristics only (no API call).
- Kinds and default tiers live in `plugin/templates/policy.json`, copied to `<dataDir>/policy.json` on first run; the user's copy wins:
  - `continue`: "ok", "yes", "go", "do it", "continue", "lgtm", a number choice, ≤3 words. No routing output.
  - `question`: explain or why/how/what without an edit verb → **fast** (haiku/low)
  - `recon`: find/where/list/search/grep/inventory/"look at" → **fast**
  - `small-edit`: rename/typo/bump/tweak/one-line/"change X to Y" → **standard** (sonnet/medium)
  - `feature`: add/implement/build/create plus code nouns → **standard**
  - `debug`: error/stack trace/failing/broken/crash/"doesn't work" → **deep** (opus/high)
  - `design`: plan/architect/design/tradeoff/"how should we" → **deep**
  - `review`: review/audit/check this diff → **deep**
  - `ops`: deploy/push/merge/migrate/release → **standard**
  - `chat`: anything else → no routing output
- Signals: a pasted stack trace or a code block over 30 lines → debug; prompt length over 1,500 chars bumps one tier; "quick"/"just" lowers one tier, never below fast.
- Tiers in policy.json: `{ "fast": {"model":"haiku","effort":"low"}, "standard": {"model":"sonnet","effort":"medium"}, "deep": {"model":"opus","effort":"high"} }`.

### 4b. UserPromptSubmit hook (`plugin/scripts/route.mjs`)
1. Parse stdin. Read `prompt`, `session_id`, `transcript_path`, and `effort` (object or string, defensive).
2. Classify. Load `state/<session>.json` (`{taskKind, tier, promptsInTask, lastPromptHash, recommendedMain, ctx}`).
3. **Boundary:** this is a new task if there's no state yet, or the hook payload / transcript shows a `/clear` since the last prompt. Track `lastClearTs` from SessionStart `source=clear` (item 4c writes it).
4. Get the current context with `tailUsage(transcript_path)`. Its `contextTokens` and `model` give the per-request floor `perRequestContextCost(ctx, model)`.
5. Output additionalContext (JSON `hookSpecificOutput` form) **only when**:
   - the kind isn't continue/chat and (it's a boundary, or its tier differs from the state's tier). Line:
     `[router] <kind> task → subagents: model=<m> effort=<e> (pass these on Agent calls unless the agent needs more); main session fits <m>/<e>.`
   - and, if the current context is over 150K **and** the prompt shares less than 15% of its keywords (lowercased words of 4+ letters minus stopwords) with the last 3 prompts in state, add:
     `[router] context is <N>K (~$<x>/request). This looks like a new topic — suggest /clear to the user before starting.`
     Only once per task (`clearSuggested` flag).
6. Append the event to `events.jsonl`, and update state (keep the last 3 prompt keyword sets, not the text).

### 4c. SessionStart hook (`plugin/scripts/session-start.mjs`)
- Seed `policy.json`.
- On `source=clear`, reset `state/<session>.json` to boundary-pending.
- Print `plugin/instructions/router.md` (under 900 chars; it costs tokens on every request), which tells Claude:
  - `[router]` lines are cost advice from the router plugin;
  - pass the suggested `model`/`effort` on Agent calls for that task's subagents unless the task clearly needs more;
  - **escalate:** if a subagent at a lower tier reports `STATUS: partial|blocked` or `CONFIDENCE: low`, re-run it once at the next tier up (fast→standard→deep);
  - relay a /clear suggestion to the user in one line, and never /clear by itself;
  - the main model can't be switched by the router; mention the main-session fit to the user only at a task boundary, and only when it's cheaper than the current model.

### 4d. SessionEnd hook
`node ingest.mjs --session "$transcript_path"`, quick and silent. Ingest is idempotent.

### 4e. Tier agents (`plugin/agents/fast.md`, `standard.md`, `deep.md`)
- Frontmatter:
  - fast: `model: haiku`, `effort: low`, tools `Read, Grep, Glob, Bash`, read-only by instruction
  - standard: `model: sonnet`, `effort: medium`, all tools
  - deep: `model: opus`, `effort: high`, all tools
- Descriptions say when to use each tier.
- Body is short. Answer only the brief, keep context lean (read excerpts, not whole files), and stop early with `CONFIDENCE: low` + why when the task is beyond the tier instead of flailing.
- End every reply with `STATUS: done|partial|blocked — reason`, `CONFIDENCE: high|medium|low`, and `FRICTION: ...`.
- Copy the zsh/eza shell notes from orch's scout.md for fast.

### 4f. Statusline (`plugin/scripts/statusline.mjs`)
- Reads stdin and prints one line:
  `<model short>·<effort> │ ctx 342K ~$0.07/req │ $4.12 │ ⇢ sonnet/medium`
- The last part shows only when `state/<session>.json` recommends a cheaper main tier than the current model.
- Under 50 ms, no transcript reads (use `context_window.current_usage` or `total_input_tokens` from stdin; check which one gives the current context and say which you used).

### 4g. hooks.json
SessionStart (matcher `startup|clear|compact|resume`), UserPromptSubmit and SessionEnd, each `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"`, timeout 10.

---

## Ownership for parallel workers
- **Worker A (phase 1):** items 1–3, meaning `lib/transcripts.mjs`, `lib/ingest.mjs`, `scripts/ingest.mjs`, `scripts/report.mjs`, `skills/report/`, plus tests `test/transcripts.test.mjs`, `test/ingest.test.mjs`, `test/report.test.mjs` and `test/fixtures/a-*`.
- **Worker B (phase 2):** item 4, meaning `lib/classify.mjs`, `scripts/route.mjs`, `scripts/session-start.mjs`, `scripts/statusline.mjs`, `agents/*`, `instructions/router.md`, `templates/policy.json`, `hooks/hooks.json`, plus tests `test/classify.test.mjs`, `test/route.test.mjs`, `test/statusline.test.mjs` and `test/fixtures/b-*`.
  - B needs `tailUsage` from item 1. To avoid waiting, B writes it in `lib/tail.mjs` (owned by B), and A's `transcripts.mjs` re-exports it.
- Neither worker edits `pricing.mjs`, `paths.mjs`, the manifests, `PLAN.md` or the other worker's files. Propose changes in the report instead.

---

# Phase 3: learning loop (wave 2, after items 1–4 land)

## Item 5: policy learning (`plugin/scripts/lib/policy.mjs` + CLI `plugin/scripts/learn.mjs`)
- **Inputs:** `sessions/*.json` (item 2), `events.jsonl` (item 4b), `shadow/results.jsonl` (item 7).
- **Per task:**
  - kind = the `kind` from the task's first routed event; if there's no event, `classify(firstPromptPreview)`.
  - effective tier = the tier of the priciest model that did work in the task: the max over subagent models, or the main model when there were no subagents. haiku=fast, sonnet=standard, opus/fable=deep.
  - success = 1 when signals show no corrections, no escalations and no blocked/partial final subagent status; else 0.
  - A shadow verdict for the task overrides the signals and weighs 3 samples:
    - `cheap_worse` → failure for the cheap tier;
    - `same` / `cheap_better` → success.
- **Per (kind, tier):** n, successes, Wilson lower bound (z=1.28), median $/task.
- **Decision per kind:** the cheapest tier with n ≥ `minN` (default 8) and Wilson lower bound ≥ `target` (default 0.8). If none qualifies, keep the current tier.
  - Never move more than one tier per retro.
  - A move down needs the evidence above. A move up happens when the current tier's lower bound is under `target − 0.15` with n ≥ minN.
- **Exploration** (how it keeps learning): `policy.json.explore` (default 0.1) is the share of prompts of a kind routed one tier *below* the policy tier while that cheaper tier has n < minN. Item 4b reads it: it rolls the dice, marks the event `explore: true`, and adds "(trial of a cheaper tier; escalate if it struggles)" to the router line. Edit route.mjs for this in wave 2 (owner C).
- `learn.mjs [--apply] [--json]` prints the table and the proposed changes. `--apply` writes `policy.json` and appends `{ts, kind, from, to, evidence}` to `policy.json.history`.

## Item 6: retro (`plugin/skills/retro/SKILL.md` + `plugin/scripts/retro.mjs`)
- **`retro.mjs`:**
  - runs ingest and learn (dry run);
  - shows spend since the last retro (`retro-state.json.lastTs`) vs the window before;
  - lists the top 5 context offenders and the subagent types costing the most per run;
  - shows the policy proposals and the exploration stats;
  - prints a ~60-line markdown summary;
  - `--mark` updates `lastTs`.
- **SKILL.md** (`/router:retro`) tells Claude to:
  1. run retro.mjs;
  2. explain the proposals and apply them with `learn.mjs --apply` (policy changes are routine; each one is logged with its evidence);
  3. append 5–10 lines to `<dataDir>/retros.md`;
  4. curate `<dataDir>/learnings.md` (under 20 lines; only rules that change routing or briefing, e.g. "orch:scout briefs average 180K context, so pass file paths, not pasted facts");
  5. offer a shadow sample with the estimate from `shadow.mjs plan`, and never run it without the user's yes;
  6. run `retro.mjs --mark`;
  7. tell the user the result in 2–3 lines.
- **SessionStart** (item 4c, edited by C in wave 2) also prints `learnings.md` when it's non-empty. When 25 or more tasks have been ingested since the last retro, it adds one line: `[router] N tasks since the last retro; suggest /router:retro to the user.` No blocking Stop hook.

## Item 7: shadow judge (`plugin/scripts/shadow.mjs` + `plugin/agents/judge.md` for the rubric text)
- **`shadow.mjs plan [--n 5]`:** picks up to n tasks from the last 14 days that meet all of these:
  - the effective tier (the main model's) was above fast;
  - there's exactly one human prompt, or only the first is replayed;
  - the project cwd is a git repo whose HEAD still exists;
  - the kind isn't ops, and the prompt doesn't match push|deploy|merge|release|prod|delete|drop|rm -rf|migrate.

  Cheap tier = effective tier - 1, up tier = effective tier; the verdict scores the cheap tier (`cheap_worse` = failure sample for (kind, cheap tier), otherwise success). Estimate cost = the first turn re-priced fresh at both tiers + a judge allowance of $0.20 per task. Print the table and the total. If the data dir's `budget.json` has `{"monthlyUsd": 500}`, also show the estimate as a share of it. Exit without running anything.
- **`shadow.mjs run --ids <task ids> --yes`:**
  1. For each task, create a throwaway clone with `git clone --local --no-checkout <repo top-level> <scratch>/<id>-<tier>` (origin removed), then `git checkout --detach <commit at task start>` (`git rev-list -1 --before=<task start> HEAD`). A clone has its own `.git`, so tools using `--git-common-dir` (repit's `./wt`) cannot reach the real repo's worktrees. Absolute paths in the prompt under the top-level are rewritten to the clone, and claude runs in the clone at the task cwd's relative subdirectory. `<scratch>` is a unique `router-shadow-*` dir per run holding a `pid` file; a run's startup sweep removes only such dirs whose pid is dead and that are over 1 hour old.
  2. Run the first prompt twice, at the cheap tier (effective - 1) and at the effective tier. Follow the headless recipe from `~/.claude/CLAUDE.md`:
     - run `claude auth status` first, and abort if it's not logged in;
     - pipe the prompt on stdin;
     - flags: `claude -p --model <m> --effort <e> --output-format json --settings '{"disableAllHooks": true}' --permission-mode acceptEdits --restricted --tools Read,Grep,Glob,Edit,Write,Bash --disallowedTools "Bash(git push:*)" "Bash(rm:*)" "WebFetch" "WebSearch"`;
     - `--restricted` ignores user/project/local settings files (so checked-in allow rules do not apply); `--tools` names back the tools it removes;
     - each run gets its own clone;
     - timeout of 10 min each.
  3. Capture the result text, `git diff`, and `total_cost_usd` from the JSON.
  4. Judge with `claude -p --model sonnet` and the rubric from judge.md. The judge sees the prompt plus both outputs and diffs, and returns `{"verdict":"same|cheap_worse|cheap_better","reason":"..."}` as JSON.
  5. Append to `shadow/results.jsonl` `{ts, taskId, kind, cheapTier, upTier, verdict, reason, costUsd}`, then remove the clones.
- Without `--yes`, `run` only prints the plan. Make this testable by injecting the `claude` binary path (`ROUTER_CLAUDE_BIN`) so tests use a fake script, and never call the real claude in tests.

# Phase 4: experimental gateway (wave 1, independent)

## Item 8: gateway (`plugin/gateway/gateway.mjs`, `plugin/gateway/README.md`)
- **What it is:** an opt-in local proxy that the user starts by hand with `node plugin/gateway/gateway.mjs [--port 8787] [--dry-run]`, then runs `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude`. Upstream: `ROUTER_UPSTREAM` (default `https://api.anthropic.com`).
- **Pass-through:**
  - All methods and paths, with headers forwarded verbatim (auth, `anthropic-beta`, `anthropic-version`); drop hop-by-hop headers and fix `host`.
  - The body is unchanged except for the rewrite below.
  - Stream responses back **unbuffered** (pipe), status and headers included.
  - Bind to 127.0.0.1 only.
- **Rewrite** (POST `/v1/messages` only):
  - Rewrite only requests whose `model` is opus- or fable-family (the main thread); never touch haiku/sonnet or count_tokens.
  - Conversation key = sha1 of (the first `system` text block's first 2 KB + the first user message's text).
  - On the first request of a conversation (one user message, no assistant turns), classify the first user text (the `classify` contract from item 4a: `classify(text) -> {kind}`), map kind → tier via `<dataDir>/policy.json` → `resolveModel`, and pin `{model, effort}` for that key in memory and in `<dataDir>/gateway-pins.json`.
  - **Later requests with the same key always use the pinned model** (caches and thinking blocks are model-bound, so never switch mid-conversation).
  - If the pin is cheaper than the requested model, set `body.model`. If `output_config.effort` exists and the pin has an effort, set it too.
  - Never upgrade a model. continue/chat kinds keep the requested model.
- **`--dry-run`:** log the decision but forward unchanged.
- **Logging:** append `{ts, key8, requested, sent, kind, path}` to `<dataDir>/gateway.jsonl`. For streamed responses, parse the SSE `message_start` / `message_delta` usage on the fly (tee, never buffer the stream) and log usage + `costOf`.
- **README:** setup, `--dry-run` first, the caveats:
  - Claude Code's local cost display will show the requested model's prices;
  - Enterprise policy may forbid a gateway;
  - pins live per conversation;
  - how to stop it.
- **Tests:** spin up a fake upstream `http.createServer` on a random port. Check pass-through of headers and stream, the rewrite on the first request, pinning on later requests, haiku untouched, and dry-run.

## Wave plan and ownership
- **Wave 1 (parallel):**
  - Worker A: items 1–3.
  - Worker B: item 4.
  - Worker D: item 8, owning `plugin/gateway/**` and `test/gateway.test.mjs`. D imports `../scripts/lib/classify.mjs` (B's), so D writes against the contract above. Until B lands, the tests stub it by writing a policy that maps everything to fast.
- **Wave 2:** Worker C does items 5–7. It owns `lib/policy.mjs`, `learn.mjs`, `retro.mjs`, `shadow.mjs`, `skills/retro/`, `agents/judge.md`, and their tests. It may edit `route.mjs` and `session-start.mjs` only for the exploration and learnings changes described above.
- **Then:** tester (end to end: install the plugin from the local marketplace in a scratch config, run a real prompt) + reviewer.

# Item 9: first-run baseline + `/router:init`

So the router starts from your history, not from nothing.

- **`plugin/scripts/init.mjs [--days 30] [--quiet]`**, idempotent:
  1. `ingestAll({days})`.
  2. Write `<dataDir>/baseline.json`:
     - `{createdAt, days, from, to, sessions, tasks, total, shares{in,cw,cr,out}}`
     - `ctx{main:{p50,p90}, sub:{p50,p90}}`
     - `perTask{p50,p90,mean}`
     - `models{<model>: $}`
     - `topSubagents[{type,model,runs,cost,perRun,ctxP50}]` (top 10)
     - `byKind{<kind>:{tasks,p50}}`
     - `pricesAsOf`

     Reuse `buildReport` from report.mjs; don't duplicate the math. Don't overwrite an existing baseline unless `--rebaseline` is passed.
  3. Seed the policy: the equivalent of `learn.mjs --apply` (writes `counts`, so exploration works from day one; applies any moves the evidence supports).
  4. Write `<dataDir>/init.json` `{ts, version, baselineTasks}`.
  5. Without `--quiet`, print a ~40-line markdown summary: the baseline headline, the top 5 context offenders, the top 5 subagent types by $, the policy counts table, and the `shadow.mjs plan --n 5` estimate (the plan only, never run).

  Use a lock file `<dataDir>/init.lock` (pid + ts; stale after 10 min) so the background run and `/router:init` never ingest at the same time. If the lock is held, `init.mjs` waits up to 90 s for it to clear, then continues.
- **SessionStart** (`session-start.mjs`): if `init.json` is missing and no live lock exists:
  - spawn `node init.mjs --quiet` detached (`stdio: 'ignore'`, `unref()`);
  - print one line: `[router] first run: building a spend baseline from the last 30 days in the background. Suggest /router:init to the user to review it and seed routing.`

  The hook must still return in under 300 ms. If `init.json` exists, print nothing new.
- **Skill `plugin/skills/init/SKILL.md`** (`/router:init`) tells Claude to:
  1. run `init.mjs`, which waits for the background run if one is going;
  2. explain the baseline in 5 lines (where the money goes, biggest levers);
  3. write the first `<dataDir>/learnings.md` (under 20 lines; only routing or briefing rules backed by the numbers, e.g. "subagent type X averages 190K context per request; brief it with file paths, not pasted content");
  4. append an `init` entry to `retros.md`;
  5. show the shadow estimate and offer it, never running it without the user's yes;
  6. run `retro.mjs --mark`;
  7. tell the user what happens next: routing is live, run `/router:retro` weekly or when nudged.
- **`retro.mjs`:** add a "vs baseline" block when `baseline.json` exists: $/task p50 and mean, context p50 main/sub, cache-read share, and model mix since the baseline's `to` vs the baseline itself. Mark it low-n when there are fewer than 10 tasks since then.
- **README:** add a "First run" note under Install.
- **Tests:**
  - init writes the baseline, init.json and policy counts from fixtures;
  - it's idempotent (a second run keeps the baseline);
  - the lock wait works;
  - SessionStart spawns the job once (inject the spawn function, or check for the lock file) and prints the line only when it isn't initialized;
  - retro shows the vs-baseline block.

# Item 10: per-subagent routing at spawn time + workflow phases

Jon's work is two plan → execute pipelines:
- **(1) features:** plan → review plan → subagents implement the steps.
- **(2) integrations:** make a directory → an agent reads the Jira ticket and gathers everything from Jira/Confluence/Slack (MCP) into md files → decide which existing pattern the integration fits → implementation plan + high-level estimate.

Most of the spend is subagents, so route each subagent when it's spawned.

Verified (code.claude.com/docs/en/hooks, 2026-10-21):
- PreToolUse fires for the `Agent` tool (matcher `"Agent"`).
- `tool_input` has `prompt`, `description`, `subagent_type`, and optionally `model` (an alias).
- `hookSpecificOutput.updatedInput` **replaces the whole input**, so include the unchanged fields. Pair it with `"permissionDecision": "allow"`. `additionalContext` is also accepted.
- **`effort` is not documented** for Agent tool_input. Don't set it, because an unknown field could fail the spawn. Model only.

## 10a. Phases (classifier, `lib/classify.mjs`)
Add phase kinds. They're used for typed prompts (route.mjs) and subagent briefs (spawn.mjs), checked before the generic rules where they match:

| Phase | Matches | Default tier |
|---|---|---|
| `gather` | jira, confluence, slack, ticket, an issue key `\b[A-Z][A-Z0-9]+-\d+\b`, "gather/collect/pull everything", "find everything about" | standard |
| `pattern-fit` | "which pattern", "what pattern", "fits (into\|with)", "closest existing", "similar to (our\|the) existing", "compare (it )?(to\|with) existing", "same as how we" | deep |
| `plan` | "implementation plan", "estimate", "break (it )?down", "plan (out\|for\|the)", "outline", "level of effort", "LOE" | deep |
| `plan-review` | "review (the\|this\|my) plan", "critique the plan", "poke holes" | deep |
| `implement-step` | "implement step \d+", "step \d+ of", "items? \d+(–\d+)? of", "per the plan", a `\.md` plan path plus implement/execute | standard; "scaffold\|boilerplate\|rename\|move files\|wire up\|stub" lowers it to fast |
| `doc-intake` | "summari[sz]e", "read (this\|the) (doc\|spec\|page)", "what does this doc say" | standard (never fast, because of size) |
| `write-guide` | "write (a\|the) (guide\|doc\|runbook\|readme\|technical guide)" | standard |

Keep the existing kinds and their tiers as fallbacks. Put the phase defaults in `templates/policy.json` under `kinds` (one table). Risk/debug floors still apply.

## 10b. Spawn hook (`plugin/scripts/spawn.mjs`, hooks.json PreToolUse matcher `Agent`)
1. Parse stdin and use `tool_input`. Never throw or print on error; budget under 150 ms.
2. **Leave the model alone** when:
   - `tool_input.model` is set (an explicit choice), or
   - the agent's definition pins a non-`inherit` model.

   To find that definition, look up `subagent_type` in order:
   - `router:*` in this plugin's agents/;
   - `~/.claude/agents/<name>.md`;
   - `<cwd>/.claude/agents/<name>.md`;
   - for `<plugin>:<name>`, the newest `~/.claude/plugins/cache/*/<plugin>/*/agents/<name>.md`;
   - built-ins `Explore`, `Plan` and `statusline-setup`: leave them alone.

   Read only the frontmatter `model:`. Cache the lookups in `state/agents.json` with file mtimes.
   - Exception: `policy.json.spawnOverride` (default `[]`) lists agent types the router may re-tier even when their frontmatter pins a model.
3. Otherwise classify `description + "\n" + prompt` to get a phase → tier (policy `kinds`, plus tierFor floors) → model alias.
   - **Escalation:** if this session spawned a brief with the same sha1, or ≥50% keyword overlap, in the last 30 min at tier T, use max(tier, T+1), capped at deep.
   - Record spawns in `state/<session>.json.spawns` (keep the last 20: hash, keywords, tier, ts).
4. **Exploration:** reuse route.mjs's exploration rule (the policy's `explore` share, only while the cheaper tier has n < minN for that phase) and mark `explore: true`.
5. Output `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...tool_input, model},"additionalContext":"..."}}` **only when changing the model or adding a note**. Otherwise print nothing.
6. **gather phase:** also append one line to `updatedInput.prompt`: `\n\n(Router: write what you find to markdown files in the working directory and reply with an index of at most 20 lines: file paths plus one line each.)`. Do this only when the brief doesn't already mention writing files.
7. **Fat brief:** if `prompt` is over 4,000 chars, add `additionalContext`: `[router] this subagent brief is <N> chars; subagent context is the main cost — next time pass a file path ("implement step 3 of plan.md") instead of pasting.` Never block.
8. Append `{ts, type:'spawn', sessionId, toolUseId (payload tool_use_id if present), subagentType, phase, tier, model, set: bool, reason, explore, briefChars, hash}` to `events.jsonl`.

## 10c. Ledger, learning, report
- **ingest:** attach a spawn event to its subagent by `toolUseId` (meta.json `toolUseId`); fall back to description hash plus the nearest ts. Store `routedPhase`, `routedTier` and `explore` on the subagent. Bump the shape VERSION.
- **policy:** add **subagent samples**. A subagent yields `(routedPhase, tierOf(model))` only when its spawn event had `set: true` (the router picked the model; stored as `routedSet`). It succeeds when its final STATUS is done (or absent) and it isn't the lower half of an escalation pair. A failure is partial/blocked, or an escalation away from it. These sit in the same `(kind, tier)` table as task samples, so the phase rows learn from subagents.
- **report:** a new section **"BY PHASE"** with phase × model → runs, $, $/run, ctxP50 and success %. Use routedPhase when present, else classify the subagent's description. Also a **"BRIEFS"** line: subagent runs whose brief was over 4K chars (from spawn events), and their median ctx vs the rest.
- **retro:** include the BY PHASE table.

## 10d. Instructions
`router.md` gets a single line (stay under 900 chars total): subagent models are set automatically at spawn; pass `model` explicitly only to override; if a router-tiered subagent reports `CONFIDENCE: low` or `STATUS: blocked`, re-spawn it with the same brief (the router escalates automatically).

## Tests
- **phases:** table-driven, including Jon's pipeline prompts:
  - "read PROJ-123 and find everything about it in jira, confluence and slack" → gather
  - "which existing integration pattern does this fit" → pattern-fit
  - "create an implementation plan and a high level estimate" → plan
  - "implement step 3 of docs/plan.md" → implement-step
  - "scaffold the client boilerplate per step 2 of plan.md" → implement-step/fast
- **spawn hook:**
  - explicit model untouched;
  - pinned frontmatter untouched (fixture agent file);
  - inherit or unknown gets routed;
  - updatedInput keeps all fields;
  - gather gets the index line;
  - fat brief gets the note;
  - the same brief re-spawned escalates;
  - no output when nothing changes.
- **ingest:** links a spawn event to a subagent.
- **policy:** subagent samples.
- **report:** the BY PHASE section.
