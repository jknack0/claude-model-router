---
name: report
description: Show where Claude Code spend went (by model, task, subagent type, context size) and what-if savings. Use for /router:report or when asked about token/cost usage.
argument-hint: "[--days 30] [--project <substr>]"
---

Run the router report with the user's flags (default `--days 30`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" $ARGUMENTS
```

If `${CLAUDE_PLUGIN_ROOT}` comes through empty or the file is missing, locate the script instead and say you did:

```bash
node "$(ls -d ~/.claude/plugins/cache/*/router/*/scripts/report.mjs | tail -1)" $ARGUMENTS
```

The first run ingests all transcripts (about 30 s for a big history); later runs take a second or two.

Then summarize the 3-5 biggest levers in plain words, each with its dollar figure from the report:
- cache reads and context size (what share of spend is re-reading big contexts, which tasks have the largest ctxMax);
- which subagent types or models cost the most per run, and whether their context (ctxP50) suggests fat briefs;
- the what-ifs, quoted as "same tokens, re-priced; quality not measured";
- the settings comparison only if a group has 5+ tasks (it is confounded by task mix).

Figures are list-price estimates, not a bill. Do not change any settings; only recommend.
