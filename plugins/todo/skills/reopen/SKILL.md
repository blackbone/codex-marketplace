---
name: reopen
description: Reopen a completed or canceled ToDo task and continue its persistent Codex task thread. Use only when the user explicitly invokes $todo:reopen.
---

# ToDo Reopen

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `task_get` and confirm that the task is closed and has a retained `codexThread.id`.
2. Call `task_reopen`. The task reuses its saved Codex thread, and the daemon unarchives it before starting the next turn.
3. Treat the reopened execution as a new attempt ledger while preserving prior closure timestamps in the receipt.
4. Call `supervisor_get`. If a supervisor is configured with `actionRequired: "resume"`, update that exact heartbeat with its stored complete definition and `status: "ACTIVE"`; after host confirmation persist the active definition with `supervisor_bind`.
5. Report the returned task status, thread ID, reopen count, and any separate supervisor-resume error.
