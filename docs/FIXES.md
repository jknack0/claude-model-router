# Fix wave 1 (from reviews 2026-10-20)

Each finding comes with repro details and file:line refs in the review files:
- R1 = `/private/tmp/claude-501/-Users-drfart-Dev-claude-model-router/02580690-fc6b-419a-a8ef-4ce2a3baba21/scratchpad/review1.md` (repro scripts in `scratchpad/gw/`)
- R2 = `.../scratchpad/review2.md` (same folder)

The orchestrator spot-checked these, and they are real:
- R1 gateway handler with no try/catch
- R2 #3 topic match forward-only (`ingest.mjs` `x.ts >= e.ts`)
- R2 #2 `effectiveTier` driven by subagents
- R2 #4–6 shadow flags missing

`claude --help` (2.1.300) lists `--no-session-persistence`, `--strict-mcp-config`, `--tools`, `--max-budget-usd` and `--plugin-dir`. **Check any other flag with `claude --help` before using it.**

Test command: `node --test test/*.test.mjs` (55 passing now; keep it green). Add a regression test for each HIGH you fix.

## F1: gateway (owner: `plugin/gateway/**`, `test/gateway.test.mjs`)
1. **R1#1** Client abort or request error must never crash the process. Wrap the handler in try/catch, use `req.on('error')` and `res.on('close')`, and abort the upstream request when the client goes away. Add a test with a client that aborts mid-body.
2. **R1#2** Pins store the model **actually sent**. In dry-run the sent model is the requested one, so dry-run never creates a downgrade pin.
3. **R1#3 Main-thread detection.** Rewrite only when the first user message contains the router's SessionStart marker. Use the first line of `plugin/instructions/router.md` (it starts "Router plugin: lines starting `[router]`"). SessionStart hooks run in main sessions only, so subagent conversations don't carry it.
   - **Unverified assumption:** say so in README and in the code comment.
   - No marker means pass through, logged as `reason:'no-marker'`.
4. **R1#5** Classify only the typed prompt: strip `<system-reminder>…</system-reminder>` blocks and use the last remaining text block of the first user message.
5. **R1#6 Key changes mid-conversation** (compaction, resume):
   - Also index pins by `metadata.user_id` when present (Claude Code puts a session id there; unverified, so log what it sees).
   - If a mid-conversation request has no key pin, but its user_id has a pin whose `requested` equals this request's model, apply that pin.
   - Otherwise pass through and log `reason:'unpinned-midstream'`.
6. **R1#7** If a rewritten first request gets a 4xx, re-send it once unchanged and re-pin to the requested model. Log it.
7. **R1#8** If the request's model differs from the pin's stored `requested`, the user switched models. Re-pin to the new requested model and don't rewrite.
8. **R1#9** Cap pins at 1,000 (drop the oldest) and write them debounced and async, never sync in the request path.
9. **R1 low items:**
   - parse SSE usage incrementally, keeping only a line buffer, not the whole response;
   - on an upstream error mid-stream, destroy the client stream so truncation is visible;
   - keep the `ROUTER_UPSTREAM` path prefix;
   - price dry-run logs at the model sent.

## F2: classifier, transcripts, report, hooks (owner: `lib/classify.mjs`, `lib/transcripts.mjs`, `scripts/report.mjs`, `scripts/route.mjs`, `scripts/session-start.mjs`, `templates/policy.json`, tests `classify|route|transcripts|report`)
1. **R1#4 Erring cheap on hard work is worse than erring expensive.**
   - Debug words: flaky, leak, race, deadlock, wrong, incorrect, figure out, investigate, root cause, regression, hang, slow, timeout, double-, why does/is … (fail|break|crash|charge|happen).
   - Risk words (prod, production, drop, delete, migrate, security, safe to, secret, billing, payment) make a prompt at least `deep` for `question`, and at least `standard` otherwise.
   - `question` → fast only when it's under 25 words and has no risk or debug words; else standard.
   - `recon` → fast only without debug words.
   - Add the reviewer's probes as tests.
2. **R1#11** "change X to Y" counts as small-edit only when it's 12 words or fewer.
3. **R1 low items:**
   - "just"/"quick" lower a tier only when they're the prompt's first word;
   - `tierFor` with an unknown tier name falls back to `standard`, not fast;
   - the report's main-module check must work through symlinks and paths with spaces (`realpathSync` + `pathToFileURL`).
4. **R1#10** `[Request interrupted by user…]` lines aren't human prompts, so add them to NOT_PROMPT in transcripts.mjs.
5. **Main-session advice floor:** route.mjs never says the main session "fits" haiku. The main session orchestrates, so its floor is `standard`. Subagent advice can still be fast.
6. **R2#8b** A prompt matching the correction regex (reuse the one ingest uses, or move it to classify.mjs and export it) is never marked `boundary:'topic'`. It belongs to the task it corrects.
7. **R2#12** session-start.mjs prints at most the first 20 lines / 1,500 chars of learnings.md.

## F3: learning, ingest, shadow (owner: `lib/policy.mjs`, `scripts/learn.mjs`, `scripts/retro.mjs`, `scripts/shadow.mjs`, `agents/judge.md`, `skills/retro/`, `lib/ingest.mjs`, tests `policy|retro|shadow|ingest`)
1. **R2#3** Match a topic event to its prompt by the `hash` both records store. If that fails, use the last human prompt at most 30 s *before* the event. Fix the fixture order so it matches real data (the prompt comes first, then the hook event).
2. **R2#1 Escalations charge the failure to the lowest tier that ran.** The higher tier gets a success only if the task otherwise succeeded.
3. **R2#2 Score honestly.**
   - A task with routed events yields a sample `(kind, routedTier)` only if the work matched the routed tier: at least one subagent at that tier and none higher, or no subagents and the main model at that tier.
   - A task with no routed events yields a sample at the **main model's** tier only.
   - Cheap helper subagents (e.g. a haiku scout under an Opus main) don't define the task's tier.
4. **R2#7** A shadow verdict counts as **one** sample.
5. **R2#8** Tasks with no evidence don't score:
   - a single prompt with no follow-up;
   - the session's last task with no follow-up;
   - abandoned.

   A shadow verdict is the only thing that scores them.
6. **R2#9** Escalation across subagent types counts: a later subagent at a higher tier in the same task whose description shares at least 50% of its keywords with an earlier lower-tier one (or a router:fast → router:standard/deep pair).
7. **R2#4** Shadow replays and the judge run with `--no-session-persistence`. Also exclude non-interactive sessions (`claude -p`, SDK) from **learning**, but keep them in spend reports. Check the transcripts for a field that marks them (e.g. `entrypoint`) and say what you found.
8. **R2#5/#6 Isolation:**
   - replays: `--strict-mcp-config` (no MCP), `--max-budget-usd <2× that task's estimate>`, and rewrite absolute paths to the real repo inside the prompt so they point at the worktree;
   - judge: `--tools ""` plus `--strict-mcp-config` plus `--no-session-persistence`. If `--max-turns` exists, use `--max-turns 1`.
   - Put the judge rubric in the prompt (frontmatter is stripped anyway).
9. **R2#10 Clean up on any exit:**
   - `git worktree prune` before and after;
   - try/finally removal;
   - SIGINT/SIGTERM handlers that kill the child and remove its worktree.
10. **R2#11 Estimate the replay, not the original:** use the first prompt's turn only (requests up to the 2nd human prompt), without the inherited cached context from before the task. The judge allowance is $0.20.
11. **R2#13**
    - `run --ids` applies the same filters as `plan`.
    - The risky regex adds: publish, commit, push, gh pr, reset --hard, rm -r, force, drop, truncate, deploy, release, prod, migrate, delete.

## Rules for all fixers
- Simplest fix. No new config flags.
- Don't edit another fixer's files. If you need a change there, put it in your report.
- Don't commit, and never run `shadow.mjs run` for real.
- Reply in 30 lines or fewer: what you fixed (by id), what you skipped and why, and the test count.
- End with STATUS: and FRICTION: lines.
