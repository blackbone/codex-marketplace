---
name: cancel
description: Cancel an unclaimed queued, blocked, or failed ToDo task. Use only when the user explicitly invokes $todo:cancel.
---

# ToDo Cancel

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Require a full task ID or unique numeric prefix.
2. Call `task_get` to resolve the exact task and current state.
3. Call `task_cancel` only for an unclaimed task.
4. Report the cancellation receipt and preserved artifacts.
