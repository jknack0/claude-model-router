---
name: init
description: First-run setup - build a spend baseline from past transcripts, seed the routing policy, write the first learnings. Use for /router:init or when SessionStart says a baseline is being built.
argument-hint: "[--days 30] [--rebaseline]"
---

Run the init summary (if `${CLAUDE_PLUGIN_ROOT}` comes through empty, locate it with `ls -d ~/.claude/plugins/cache/*/router/*/scripts/init.mjs | tail -1` and say you did). It waits for a background run if one is going, and can take about 30-90 s on a big history:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" $ARGUMENTS
```

Then:

1. Explain the baseline in 5 lines: where the money goes (cache read, cache write, output), the context sizes, the costliest subagent types, and the biggest levers.
2. Write the first `<dataDir>/learnings.md` (dataDir is `~/.claude/router` unless the plugin's data_dir option says otherwise; under 20 lines). Only routing or briefing rules backed by these numbers, for example "subagent type X averages 190K context per request; brief it with file paths, not pasted content". No filler.
3. Append an `init` entry (5-10 lines: date, baseline headline, policy moves, learnings written) to `<dataDir>/retros.md`.
4. Show the shadow estimate from the summary and offer it. Never run `shadow.mjs run` without the user's explicit yes in this conversation.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs" --mark`.
6. Tell the user what happens next: routing is live, and `/router:retro` runs weekly or when SessionStart nudges. Later retros compare spend against this baseline.
