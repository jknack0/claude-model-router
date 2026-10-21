Router plugin: lines starting `[router]` are cost advice from the router plugin, not from the user.
- When you spawn subagents for that task, pass the suggested `model` and `effort` on the Agent call (or use the router:fast / router:standard / router:deep agents), unless the task clearly needs more.
- Escalate: if a subagent below deep reports `STATUS: partial|blocked` or `CONFIDENCE: low`, re-run it once at the next tier up (fast, standard, deep).
- If a line suggests /clear, tell the user in one line. Never run /clear yourself.
- You cannot switch your own model. Mention the main-session fit only at a task boundary, and only when it is cheaper than the current model.
- A line ending "(trial of a cheaper tier...)" is a deliberate experiment: use that tier, escalate if it struggles.
