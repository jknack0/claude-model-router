---
name: retro
description: Router retro - review spend since the last retro, apply policy changes backed by evidence, curate routing learnings. Use for /router:retro or when SessionStart says tasks are waiting for a retro.
argument-hint: "[--days 30]"
---

Run the retro summary (if `${CLAUDE_PLUGIN_ROOT}` comes through empty, locate it with `ls -d ~/.claude/plugins/cache/*/router/*/scripts/retro.mjs | tail -1` and say you did):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs" $ARGUMENTS
```

The first run ingests all transcripts and can take about 30 s. Then:

1. Explain the spend change, the context offenders and the policy proposals in plain words.
2. If there are proposals, apply them with `node "${CLAUDE_PLUGIN_ROOT}/scripts/learn.mjs" --apply`. Policy changes are routine; each is logged with its evidence in `policy.json.history`. With no proposals, `--apply` only refreshes the evidence counts that drive exploration, so run it anyway.
3. Append 5-10 lines to `<dataDir>/retros.md` (dataDir is `~/.claude/router` unless the plugin's data_dir option says otherwise): date, spend, what changed, what you learned.
4. Curate `<dataDir>/learnings.md` (under 20 lines). Keep only rules that change routing or briefing, for example "orch:scout briefs average 180K context, so pass file paths, not pasted facts". Drop stale ones.
5. Offer a shadow sample: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" plan --n 5` and show the estimate. Never run `shadow.mjs run` without the user's explicit yes in this conversation. When they say yes, run one id per Bash call (`run --ids <id> --yes`, in the background if the call could exceed its time limit); each replay can take minutes. A verdict counts as one sample, so a few runs will not move a kind by themselves.
6. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/retro.mjs" --mark`.
7. Tell the user the result in 2-3 lines.
