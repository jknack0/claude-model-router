# claude-model-router: plan

A Claude Code plugin that sends each task to the cheapest **(model, effort, context)** that still gets the same result, logs every task, and runs retros that tune the routing policy.

Target: Claude Code Enterprise at work ($500/mo API budget). Built and tested on Jon's personal subscription first.

## What the baseline says (2026-10-20, personal sub, 30 days, list-price equivalent)

Source: `~/.claude/projects/**/*.jsonl`, 1,673 files and 133K assistant messages, each deduplicated by message id.

| | share of $ |
|---|---|
| Cache reads | 63% |
| Cache writes | 29% |
| Output | 7% |
| Fresh input | ~0% |

- 90% of spend is Opus 5.5, split about evenly between the main session and subagents.
- Context per request (input + cache write + cache read):

  | | median | p90 | mean | share over 100K |
  |---|---|---|---|---|
  | Main session | 340K | 738K | 391K | 95% |
  | Subagents | 168K | 378K | 204K | 80% |

  These are typical sizes, not a few marathon sessions.
- Opus 5.5 and Sonnet 5.5 have the **same cache-read price** ($0.20/MTok). Moving every Opus subagent to Sonnet saves only about 8% of the total, because only cache writes and output get cheaper.
- **Prices**, from the claude-api skill (cached 2026-10-06), $/MTok input/output:

  | Model | Input / output | Notes |
  |---|---|---|
  | Opus 5.5 | 4 / 20 | cache read 0.20 (0.05x) |
  | Sonnet 5.5 | 2 / 10 | cache read 0.20 |
  | Haiku 5.5 | 0.10 / 0.50 for prompts ≤100K | **0.50 / 2.50 above 100K**; its tokenizer counts about 30% more tokens |
  | Fable 5.1 | 10 / 50 | cache read 0.25 |

  - Cache writes cost 1.25x input for the 5-minute TTL and **2x for the 1-hour TTL**, which is what Claude Code uses per the transcripts. Other cache reads are about 0.1x input (`shared/prompt-caching.md` § Economics).
  - The exact Haiku 5.5 cache-read figure isn't listed. The baseline assumed 0.1x.
- **Caveat: this is the personal sub, so it may not match work.** About $10.9K a month list-price equivalent, against a $500 work budget. Personal use runs orch, including its Sonnet fact-check on every reply. Phase 1 must re-baseline on the work machine before any thresholds get tuned.

**Conclusion:** model choice is the smaller lever. The bigger ones are **context size × number of requests** (long sessions, fat subagent briefs, no /clear between tasks) and **effort** (fewer turns, less thinking). The router decides all three.

## Hard constraints (verified in the docs, see the claude-code-guide report from the 2026-10-20 session)

1. **No hook can change the main session's model or effort.** PreModelSwitch can only block a switch, and UserPromptSubmit can only add context. The supported switches are `/model`, `/effort`, settings, env and flags.
2. **Subagents can be pinned.** Frontmatter `model:` (an alias or full ID) and `effort:`, plus a per-invocation `model` (and `effort` on v2.1.292+), take priority over the session model.
3. **Caches are model-scoped, and thinking blocks are bound to the model that produced them.** Never switch models mid-conversation: it throws away the whole cached prefix (a full cache rewrite) and the earlier reasoning. Route only at a task boundary (session start, /clear, subagent spawn).
4. **Gateway** (`ANTHROPIC_BASE_URL`) is supported and could rewrite `model` per request. Claude Code works out cost locally from the model name, so a rewrite would probably make the local cost display wrong (an inference, not checked). Enterprise managed settings may also forbid a gateway, and rule 3 still applies. Deferred to phase 4.
5. **Built-ins to beat first:** `opusplan` (Opus in plan mode, Sonnet for execution) and `/effort auto` (`CLAUDE_CODE_EFFORT_LEVEL=auto`). The plugin only earns its place if it beats these.
6. **Enterprise may set `allowManagedHooksOnly`**, which turns plugin hooks off. The ledger and retro must also work without hooks: a manual `/router:retro` reads the transcripts directly. Check `/status` on the work machine.
7. Transcripts keep 30 days (`cleanupPeriodDays`). The ledger must copy what it needs.

## Architecture

```
plugin/
  .claude-plugin/plugin.json      userConfig: data_dir (default ~/.claude/router)
  hooks/hooks.json                SessionStart, UserPromptSubmit, SubagentStop, Stop/SessionEnd
  scripts/                        Node 24, no deps (.mjs)
    pricing.mjs                   one price table (verified values + date)
    ingest.mjs                    transcript JSONL → task records (incremental, by file offset)
    classify.mjs                  prompt → features → tier recommendation (local, no API call)
    signals.mjs                   implicit outcome signals per task
    policy.mjs                    learned policy: feature bucket → (model, effort) + confidence
    report.mjs                    baseline / what-if / weekly numbers
    statusline.mjs                optional: session $, context size, recommended tier
  agents/
    fast.md      haiku,  effort low     recon, grep, inventories, summaries, formatting
                                        (only pays off with a lean brief: under 100K context, or Haiku's 5x long-context price applies)
    standard.md  sonnet, effort medium  scoped edits, tests, routine features
    deep.md      opus,   effort high    design, debugging, cross-cutting changes
    judge.md     sonnet                 shadow comparison (phase 3)
    retro.md                            weekly policy curation
  skills/
    retro/       /router:retro           run a retro now
    report/      /router:report          spend baseline + what-if
  instructions/router.md          injected at SessionStart: routing rules + current policy
```

Data folder (`~/.claude/router`): `tasks.jsonl` (one line per task), `policy.json`, `learnings.md`, `retros.md`, `shadow/`.

### A task record
`session, task_idx, started, first_prompt_hash, features{kind, size, files, langs, keywords}, routed{model, effort, via: main|subagent}, cost{in, cw, cr, out, total}, requests, peak_context, turns, signals{...}, shadow?{...}`

Task boundary = the session start, a `/clear`, or a user prompt the classifier marks as a new topic.

### Routing (what happens per prompt)
1. **UserPromptSubmit**: classify the prompt using local features plus the nearest past tasks in `tasks.jsonl`, and look up `policy.json`. Inject 2–4 lines of additionalContext, for example: "Router: kind=recon, delegate to `router:fast` (haiku/low); confidence 0.82 from 14 similar tasks". The main model follows it the way it follows orch's roster. This is advisory, not enforced.
2. **Main-session tier**: hooks can't switch it, so the statusline shows the recommended `/model` + `/effort` when it differs from the current one. At a task boundary the injected context also tells Claude to suggest `/clear` when the new task doesn't need the old context, since context is the biggest cost.
3. **Escalation**: if a `fast` or `standard` agent reports `STATUS: BLOCKED/LOW-CONFIDENCE`, or a test fails twice, re-run on the next tier up. The escalation is logged as a negative signal for the cheap tier.
4. **Effort first**: the policy tries the same model at lower effort before a smaller model. The claude-api skill says lower effort on the newest models often matches older or smaller models, and it keeps one cache namespace.

### Learning loop
**Implicit signals (free, every task):**
- user correction or re-ask in the next prompt ("no", "that's wrong", "still broken", the same request reworded)
- denied tool calls
- tier escalations
- Bash test/build exit codes (fail→pass counts as a pass)
- task abandoned (no follow-up and a /clear)
- reverted edits

Score = success probability per (feature bucket, tier). The policy picks the cheapest tier whose lower confidence bound is ≥ the target (default 0.9), judged on **cost per completed task**, retries included.

**Shadow judge (sampled, costs money):** during the weekly retro, sample about 5–10% of tasks that were routed cheap and replay the first prompt one tier up. The replay runs with `claude -p` in a throwaway git worktree, using the CLAUDE.md headless-eval recipe (`claude auth status`, stdin prompt, hooks disabled). A Sonnet `judge` compares the diffs or answers: same / cheap worse / cheap better. Read-only tasks replay as-is; tasks with side effects outside the repo are skipped.
- Cost: about sample × median task cost × 2. Shown and approved before each run.
- On the personal sub it uses quota, not dollars.

**Retro** (`/router:retro`, weekly, or after every N tasks) does five things:
1. ingest
2. recompute the policy
3. write the what-if (actual $ vs all-Opus vs policy)
4. list the top context offenders (sessions with the highest cache-read $)
5. append to `retros.md`, curate `learnings.md` (under 40 lines, injected at SessionStart), and propose agent or threshold changes.

It follows orch's retro pattern, but it stands alone, so orch is not required.

## Phases
Status 2026-10-20: phases 1–4 built (91 tests). Learning starts once routed tasks build up, and the gateway is experimental. The end-to-end run inside real Claude Code is still pending.

1. **Ledger + report** (no routing yet): `pricing`, `ingest`, `report`, `/router:report`. Done when:
   - it reproduces today's baseline and shows per-task cost plus the top context offenders;
   - it measures the zero-code options on a week of real work: `opusplan`, `/effort auto`, and a `/clear`-per-task habit, each compared with the baseline on cost per task.

   If those get most of the way there, phases 2–3 shrink to ledger + nudges + retro. *Nothing changes behaviour, so this is safe to ship to work first.*
2. **Router v1**: the tier agents, `classify` (heuristics), UserPromptSubmit injection, the escalation rule, and the statusline. Done when 20 real tasks are routed and logged, with no quality complaints.
3. **Learning**: `signals`, `policy`, `/router:retro`, the shadow judge behind an explicit approval. Done when one retro changes a policy bucket based on evidence.
4. **Optional gateway** (only if phase 2's advisory routing proves too loose, and Enterprise allows `ANTHROPIC_BASE_URL`): pins (model, effort) per conversation on its first request and never switches mid-conversation.

## Open questions for Jon
- At work: does orch run, and are sessions as long as they are here (median 340K context)? If not, the context thesis is unproven there.
- On the work machine: does `/status` show hooks allowed (no `allowManagedHooksOnly`)? Is `ANTHROPIC_BASE_URL` locked?
- Does work give Console access to usage/cost reports? That would be a better source of truth than client-side estimates.
- Success target: is 0.9 right, or stricter for code edits?
