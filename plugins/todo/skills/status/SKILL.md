---
name: status
description: Show the complete ToDo state with separate task, worker, runner, and dashboard information. Use only when the user explicitly invokes $todo:status.
---

# ToDo Status

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `todo_status` for the target repository.
2. Render separate `Tasks` and `Workers` sections.
3. For tasks show ID, status, assigned worker, blockers, and error when present.
4. For finished attempts, show attempt count, final completion, cumulative human duration, and cumulative total tokens.
5. For workers show ID, state, PID, and current task.
6. Include runner state and the dashboard URL when returned.
7. Include the supervisor's configured status, desired status, required action, and active-task count when returned.
8. Preserve status values exactly as returned.
