---
name: supervise
description: Inspect an activated repository's runner and task failures on request. Supervision uses the ToDo runner and app-server without host automations.
---

# ToDo Supervise

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `runner_status` and `todo_status`. Leave healthy running work alone.
2. If active work exists and the runner is stopped, call `runner_start` and verify its state.
3. Inspect failed tasks with `task_get`, including the error, attempt ledger, logs, and Git phase. A generic failed or interrupted label is not a diagnosis.
4. Retry the original task with `task_retry` only after the cause is addressed or the user explicitly requests another attempt. Preserve completed implementation and delivery checkpoints.
5. For `waiting-input`, report the exact question and the dashboard URL. An answer there continues the existing task through app-server.
6. Report a concrete blocker if recovery requires user input, authentication, or an external change. Do not bypass permissions, checks, or claims.
7. Do not create, update, pause, resume, or delete host automations. This skill performs one inspection and does not schedule future turns. Legacy scheduled invocations must also make no host automation calls.
