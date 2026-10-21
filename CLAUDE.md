# claude-model-router

A Claude Code plugin (`router`, in `plugin/`). Background in PLAN.md, work items in docs/SPEC.md, verified platform facts in docs/facts/.

- Node 24 (`/opt/homebrew/opt/node@24/bin/node`), ESM `.mjs`, no npm deps.
- Tests: `node --test test/*.test.mjs`. `node --test test/` fails on Node 24.
- Validate: `claude plugin validate plugin`.
- Real-data runs: set `ROUTER_DATA_DIR` to a scratch dir. Never point tests at `~/.claude/router`.

## Lessons from agent retros
- Hook payloads arrive as stdin JSON. There's no `$transcript_path` shell var, so hook commands run a `.mjs` wrapper that uses `lib/hook.mjs` (catches everything, exits 0).
- Transcripts:
  - effort is on every assistant line;
  - /clear keeps the same session file;
  - subagents live in `<session>/subagents/` and also nested under `subagents/workflows/<wf>/`;
  - the subagent model is in the parent's `toolUseResult.resolvedModel`;
  - `claude -p` sessions carry `turnOrigin: "sdk"`.
- Shadow replays use `git clone --local`, never `git worktree`. Repo tools like repit's `./wt` follow `--git-common-dir` back to the real repo.
- The real `claude` has never run `shadow.mjs run` or the gateway. Verify `--restricted --tools …` and the gateway's SessionStart-marker and `metadata.user_id` assumptions on a real session before trusting them.
- shadow.test.mjs can fail while other agents edit files in parallel. Judge by a quiet full run.
