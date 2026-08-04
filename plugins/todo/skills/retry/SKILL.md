---
name: retry
description: Manually retry a failed ToDo task after its configured automatic retries are exhausted or intentionally disabled. Use only when the user explicitly invokes $todo:retry.
---

# ToDo Retry

1. Call `task_get` for the requested task.
2. Retry only a failed task and only after the recorded error has been addressed or the user explicitly accepts another attempt beyond the configured automatic retry limit.
3. Call `task_retry`.
4. Preserve the task's configured execution mode. External workflow linkage alone must not move a background task into the current thread.
5. If the task was changed to `interactive` after a background failure with `error.kind: "interactive_required"`, continue with `$todo:run` in the current thread. Otherwise leave a background retry to the daemon.
6. Report the returned task status.
