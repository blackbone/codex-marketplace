---
name: reopen
description: Reopen a completed or canceled ToDo task and continue its persistent Codex task thread. Use only when the user explicitly invokes $todo:reopen.
---

# ToDo Reopen

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `task_get` and confirm that the task is closed and has a retained `codexThread.id`.
2. Call `task_reopen`. The task reuses its saved Codex thread, and the daemon unarchives it before starting the next turn.
3. Treat the reopened execution as a new attempt ledger while preserving prior closure timestamps in the receipt.
4. Use `runner_status` to verify execution and `runner_start` if the runner is stopped. Do not call host automation or desktop application tools.
5. Report the returned task status, thread ID, reopen count, and any separate supervisor-resume error.
