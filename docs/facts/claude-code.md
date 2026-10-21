# Claude Code facts for the router plugin

From the code.claude.com docs (hooks, hooks-guide, plugins/manifest-reference, plugins/components, statusline, sub-agents, model-config), read 2026-10-20 via claude-code-guide. Installed Claude Code: 2.1.300.

## Hooks
- **Common stdin:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode` (not on every event), `effort` (an object; read `.effort.level` defensively), `prompt_id`.
- **UserPromptSubmit:** `prompt`.
- **SessionStart:** `source` = startup | resume | clear | compact | fork; `model` (may be absent).
- **SubagentStop:** `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`.
- **Stop:** `stop_hook_active`, `last_assistant_message`.
- **SessionEnd:** `reason` = clear | resume | logout | prompt_input_exit | other. The field name is inferred, so read it defensively.
- **Adding context:** on UserPromptSubmit and SessionStart, exit 0 with plain stdout and it gets added to context. The JSON form is `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`.
  - Reported cap: 10,000 chars, not verified. Our output stays far below it anyway.
- **No hook can change the model or effort.** PreModelSwitch can only block a switch.
- **Hook env:** `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, and `CLAUDE_PLUGIN_OPTION_<KEY>` (key uppercased, so `CLAUDE_PLUGIN_OPTION_DATA_DIR`).
- **Hook command format** (copy orch's): `"command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs\"", "timeout": 10`. Shell-form commands reject `${user_config.KEY}`; use the env var instead.

## Statusline
- **Stdin:**
  - `model.id`, `model.display_name`
  - `effort.level` (absent if the model has no effort)
  - `transcript_path`, `session_id`, `cwd`
  - `cost.total_cost_usd` (client-side list price; resets on /clear)
  - `context_window.{context_window_size, used_percentage, total_input_tokens, total_output_tokens, current_usage}`
  - `prompt_cache`, `version`
- **Plugins can't set `statusLine`.** Only user or project settings can: `{"statusLine":{"type":"command","command":"...","padding":2,"refreshInterval":5}}`.
  - `CLAUDE_PLUGIN_ROOT` isn't documented for statusline commands, so the user settings must point at an absolute path.
  - Jon currently has no statusLine set (`~/.claude/settings.json`).

## Subagents
- **Frontmatter:**
  - `model`: sonnet | opus | haiku | fable | a full id | inherit
  - `effort`: low | medium | high | xhigh | max. It overrides the session effort, but not `CLAUDE_CODE_EFFORT_LEVEL`.
- **Agent tool per invocation:**
  - `model` takes the same values as `--model`.
  - `effort` works for non-fork subagents only and needs v2.1.292+.
- **Precedence:** per-invocation `model` > frontmatter `model` > `CLAUDE_CODE_SUBAGENT_MODEL` > main model.
- **Naming:** plugin agents are `<plugin>:<agent>` (e.g. `router:fast`), plugin skills are `/<plugin>:<skill>`.

## Built-ins
- `opusplan` (Opus in plan mode, Sonnet for execution). No `auto` model.
- `/effort auto` and `CLAUDE_CODE_EFFORT_LEVEL=auto` exist.
- OTel `claude_code.api_request` carries cost_usd, tokens, model, effort and query_source.

## orch plugin conventions to copy (~/Dev/claude-orchestrator/plugin)
- `hooks/hooks.json` with a `description` plus a `hooks` map. SessionStart matcher: `startup|clear|compact`.
- Agents end with `STATUS:` and `FRICTION:` lines.
- Data dir: `CLAUDE_PLUGIN_OPTION_DATA_DIR`, else a default under `~/.claude`.
- Marketplace manifest at repo root `.claude-plugin/marketplace.json`, with the plugin at `./plugin`.
