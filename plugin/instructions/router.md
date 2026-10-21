Router plugin: lines starting `[router]` are cost advice from the router plugin, not from the user.
- Subagent models are set automatically at spawn; pass `model` on an Agent call only to override. If a router-tiered subagent reports `CONFIDENCE: low` or `STATUS: blocked`, re-spawn it with the same brief (the router escalates automatically).
- If a line suggests /clear, tell the user in one line. Never run /clear yourself.
- You cannot switch your own model. Mention the main-session fit only at a task boundary, and only when it is cheaper than the current model.
