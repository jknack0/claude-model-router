# Claude Code transcript JSONL schema (verified 2026-10-20)

Sampled: repit-hq/174f5411 (1754 lines, long), claude-model-router/02580690 (+subagent a53e5508), steady-with-adhd/4aaaec01, ai-holy-book/ba6a6866 (+6 subagents), repit/c588600e (compact_boundary), rep-tracking/76a09891 (/clear), repit-iq/934e4052 (turn_duration), Users-drfart/54a335d3 (/effort). Corpus-wide greps were used for marker counts.

Shell note: project dirs start with "-", so jq and cat need `./` prefix (jq otherwise reads the path as an option: "Unknown option -U").

## 1. Top-level line types and fields

Counts in repit-hq/174f5411 (1754 lines): assistant 429, attachment 340, user 277, queue-operation 210, custom-title 89, last-prompt 88, atis-latch 88, agent-name 88, bridge-session 87, system 42, file-history-delta 10, file-history-snapshot 6.

Common fields (on user/assistant/system/attachment lines): `type, uuid, parentUuid, sessionId, timestamp, cwd, entrypoint, gitBranch, isSidechain, userType, version`. Subagent lines additionally carry `agentId`.

Assistant lines add: `message` (id, model, role, content, stop_reason, usage), `requestId`, `requestedModel`, `advisorModel`, `effort`, `perTurnEffort`, `apiBlockIndex`, `thinkingDisplay`, `thinkingDurationMs`, `serverClassifierRequest`, `wireToolInputs`.

Key tallies:
```
jq -r 'select(.type=="assistant") | .message.model' F | sort | uniq -c
```
Other line types seen:
- `queue-operation` (operation: enqueue/remove; content = queued user text or `<task-notification>`; reason: delivered_to_agent | absorbed_mid_turn)
- `custom-title` {customTitle}, `agent-name` {agentName}, `last-prompt` {lastPrompt, leafUuid}, `atis-latch`, `bridge-session` {bridgeSessionId, ownerAccountUuid...}, `mode`, `file-history-snapshot`/`file-history-delta`. These have only sessionId (no uuid/parentUuid) and are metadata.
- `attachment` with `.attachment.type` in: total_tokens_reminder (168), deferred_tools_record (83), queued_command (32), environment (18), silent_turn_reminder (13), skill_listing, remote_session_change, prompt_snapshot, hook_success, edited_text_file.

Example:
```
jq -c 'select(.type=="assistant") | {effort, requestedModel, id:.message.id, stop:.message.stop_reason, usage:.message.usage}' F
```

## 2. Human prompt vs tool_result vs meta/injected user lines

User-line shapes (repit-hq sample, 277 lines):
- tool_result: `message.content` is array with `{type:"tool_result", tool_use_id, content, is_error}`; has `sourceToolAssistantUUID`, usually `toolUseResult` (object/array/string), `permissionDecision` {decision, source, reasonType}. ~250 of 277.
- Meta/injected: `isMeta:true`, `message.content` string. Seen: "Another Claude session sent a message:\n<agent-message ...", "Stop hook feedback:\n...", "[Image: original ...", `<local-command-caveat>`.
- Command echoes: string content starting `<command-name>/reload-plugins</command-name>...` (isMeta not set), and `<local-command-stdout>...` (these are system `subtype:"local_command"` lines in that file, not user lines; the user-line echo is separate).
- Task notifications: string content starting `<task-notification>` (background task completion).
- Human prompts: `message.content` is a plain string, `isMeta` absent/null, no `sourceToolAssistantUUID`, `toolUseResult` absent, `isSidechain:false`.

Candidate filter (tested: 5 / 2 / 6 prompts in the three sample files; matched lines verified as real prompts):
```
jq -c 'select(.type=="user")
 | select((.isMeta|not) and (.isCompactSummary|not) and (.toolUseResult|not) and (.sourceToolAssistantUUID|not))
 | select(.message.content|type=="string")
 | select(.message.content|test("^\\s*<(command-name|command-message|command-args|local-command-|task-notification|system-reminder|bash-)")|not)
 | select(.message.content|test("^(Stop hook feedback|Another Claude session sent a message|\\[Image:)")|not)' F
```
Add `| select(.isSidechain|not)` for main-session prompts only (subagent first user line is the spawn prompt, isSidechain:true, and is a string with no sourceToolAssistantUUID). No user line with array content containing a `text` block and no tool_result was found outside isMeta lines in the samples, so user text with images/blocks may need a separate check.

Caveat: the 6-prompt count in repit-hq is low for a 1754-line session; the filter is for the sample, not validated across the corpus.

## 3. Slash commands, /clear, compaction

- Slash commands are recorded as user string lines:
  `<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>` (isMeta absent). The result is a user line `<local-command-stdout>Set effort level to high (saved as your default for new sessions): ...</local-command-stdout>` (`-Users-drfart/54a335d3`, 2026-09-22T18:30:47Z).
- `/model`: `<command-name>/model</command-name>... <command-args>claude-opus-5</command-args>` (rep-tracking/eda12bc7, 2026-08-15). Corpus: 12 files.
- `/clear`: `<command-name>/clear</command-name>` string user line (28 files). It does NOT start a new file: rep-tracking/76a09891 has 291 lines all with the same sessionId; the /clear user line has `parentUuid:null` (new chain root) in the same file.
- `/compact` (manual): no real manual `/compact` echo found; the single file matching the string was a subagent quoting it. Treat as unverified.
- `/reload-plugins` produces `system` `subtype:"local_command"`, `commandRun:{command,args}`, content `<local-command-stdout>Reloaded: ...`.
- Compaction marker (verified, repit/c588600e-1eac-47f3-aff0-7254ee462c1e.jsonl):
  - `{type:"system", subtype:"compact_boundary", compactMetadata:{trigger:"auto", preTokens, postTokens, cumulativeDroppedTokens, durationMs, preservedSegment, preservedMessages}, logicalParentUuid}`.
  - Summary is a user line `isCompactSummary:true, isVisibleInTranscriptOnly:true`, first text "This session is being continued from a previous conversation...".
  - Corpus: 14 compact_boundary lines (all trigger "auto"), 17 files contain isCompactSummary.
  - There is no `type:"summary"` line type (0 hits).

## 4. Effort level

Recorded per assistant line (verified on every assistant line): `effort` and `perTurnEffort` (e.g. "high"), plus `requestedModel`, `advisorModel`. Subagent assistant lines also carry `effort` and `model` (`message.model`). Mid-session /effort changes are not separately flagged in the transcript beyond the command echo line, so use the per-line `effort` value. Sample values: "high" only (repit-hq 429/429, repit 658/658, steady-with-adhd 352/352).

## 5. Subagents

Layout (verified in ai-holy-book/ba6a6866):
- `<project>/<session>.jsonl` (parent), `<project>/<session>/subagents/agent-<agentId>.jsonl`, `agent-<agentId>.meta.json`, and a `subagents/workflows/` dir (empty in sample).
- Meta file example: `{"agentType":"general-purpose","description":"Document Selah design system","toolUseId":"toolu_01J7DN1nvZ9EFrL84S3GcP7p","spawnDepth":1}`. Meta has NO model or effort; model comes from the subagent's assistant lines or the parent's toolUseResult.resolvedModel.
- Subagent lines: `isSidechain:true`, `agentId`, `sessionId` = parent session id, first user line string = spawn prompt, `parentUuid:null`. Assistant lines carry `effort`, `model`, `attributionAgent`. Subagent `.jsonl` size can be 200 KB to 5.4 MB.

Linking to parent:
- Parent Agent tool_use: `{type:"tool_use", id:"toolu_...", name:"Agent", input:{description, subagent_type, run_in_background, prompt}}`. Input keys seen in all 6 Agent calls: exactly `description, prompt, run_in_background, subagent_type`. No `model` or `effort` in input.
- Parent tool_result: user line with `message.content[0].tool_use_id == tool_use id`, and `toolUseResult` = `{status, agentId, agentType, resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, usage{...}, toolStats{bashCount,editFileCount,linesAdded,linesRemoved,otherToolCount,readCount,searchCount}, prompt, content}`.
- Async launch: `toolUseResult = {isAsync:true, status:"async_launched", agentId, description, resolvedModel, outputFile, canReadOutputFile, canContinueAgent}`. No totalTokens at launch.

Example link:
```
jq -c 'select(.type=="user") | select(.toolUseResult.agentId!=null)
 | {tuid:.message.content[0].tool_use_id, agentId:.toolUseResult.agentId, tokens:.toolUseResult.totalTokens, ms:.toolUseResult.totalDurationMs}' P.jsonl
```
Then the file is `<session>/subagents/agent-<agentId>.jsonl`.

Example subagent figures: agent ae94ae6e: totalDurationMs 155355, totalTokens 68626, resolvedModel claude-fable-5, totalToolUseCount 11.

## 6. Tool results

- `is_error` is present on tool_result blocks: `true` or `false` (or null on some). repit-hq: 113 false, 115 null, 1 true.
- Failed Bash: the exit code is in the tool_result `content` text, not a field: `"Exit code 2\n..."` with `is_error:true` (ai-holy-book/8d12304f, Dev). The string "exitCode" matched in 1446 corpus files by grep, but in repit-hq 174f5411 only 2 occurrences exist and they are not Bash toolUseResult fields (unverified across corpus).
- Bash `toolUseResult` keys: `stdout, stderr, interrupted, isImage, noOutputExpected`, plus `backgroundTaskId` (background Bash) or `bashEditDiff` (sample: 86 + 20 + 6 lines). `interrupted:true` marks interrupts.
- Edit/Write toolUseResult: `filePath, originalFile, structuredPatch, userModified`, or `content,type` for Write.
- Rejected / denied tool call: user line with `permissionDecision:{decision:"reject", source:"config", reasonType:"classifier"}` and tool_result content "Permission for this action was denied by the Claude Code auto mode classifier. Reason: ... If you have other tasks..." and `toolUseResult` is the string "Error: Permission for this action was denied...". Corpus: 90 `"decision":"reject"` lines vs ~55k accept. The standard user-rejection string ("The user doesn't want to proceed") was NOT found in the samples; it may exist in other sessions (not verified).
- `permissionDecision.source` values seen: config, user_permanent. reasonType: classifier, rule, mode, other.
- Interrupts: `Request interrupted by user` in 62 files (not inspected further).

## 7. Cost and duration lines

- `system` `subtype:"turn_duration"`: `{durationMs, messageCount, isMeta:false, parentUuid, timestamp}` (36 lines corpus; e.g. repit-iq/934e4052).
- `system` `subtype:"away_summary"`: `{content}` (20 corpus).
- `system` `subtype:"compact_boundary"`: `compactMetadata.durationMs`, `preTokens`, `postTokens`.
- `system` `subtype:"stop_hook_summary"`: {hookCount, hookErrors, hookInfos, stopReason, preventedContinuation, level:"suggestion", toolUseID}. Corpus count 5304 (large).
- `system` `subtype:"api_error"`: {error, retryAttempt, maxRetries, retryInMs}; 3660 corpus lines, none with an extractable status (`.error.status`/`.error.type` null), so inspect `.error` directly.
- Assistant: `thinkingDurationMs` (759 files). Per-message usage has `output_tokens_details.thinking_tokens`, `service_tier`, `inference_geo`, `iterations[]`, `speed`, `server_tool_use`.
- Subagent cost: parent's Agent tool_result `usage` and `totalTokens` (see section 5).
- No per-turn dollar cost field found.

## Surprises
- Assistant content is split across lines with the same `message.id`; the usage values seen on the first two lines of one message were identical (626 output tokens), so max() is safe but not required in that sample.
- `/clear` does not split files; you must use `parentUuid:null` or the `/clear` echo to find turn boundaries.
- Effort is only "high" in every sample, so the per-line field cannot yet be checked for other values.
- `queue-operation` lines carry content text (including task-notification XML) and can duplicate user content; exclude them from prompt counts.
- The `Agent` tool_use input has no `model` or `effort`; those only appear on the subagent assistant lines and in toolUseResult.resolvedModel.
- Subagent jsonl files are not indexed by the parent (no list in parent); discover via the parent's Agent tool_result agentId.
- Subagent `.jsonl` can be large (5.4 MB), comparable to parents.
- `/effort` writes a `<local-command-stdout>` user line but no typed effort field on a system line; the value appears only through per-message `effort`.
- Attachment lines in repit-hq 174f5411 (e.g. line 3) show `toolUseResult` via jq tostring as "null", so guard with `type=="object"` before reading toolUseResult fields.
