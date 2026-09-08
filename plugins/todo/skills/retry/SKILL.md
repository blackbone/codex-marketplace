---
name: retry
description: Manually retry a failed ToDo task after its configured automatic retries are exhausted or intentionally disabled. Use only when the user explicitly invokes $todo:retry.
---

# ToDo Retry

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `task_get` for the requested task.
2. Inspect `attemptLedger`, `retryStats`, the latest classified status, and the Git phase. Automatic retry is fail-closed and applies only to `failed_transient`; unknown, authentication, permission, cancellation, preflight, and interactive failures never qualify automatically.
3. Retry only after the recorded cause has been addressed or the user explicitly accepts a new manual attempt. Resolve authentication, connector probes, or required interaction in the current thread first.
4. Call `task_retry`. A failed Git delivery resumes the runner-owned delivery phase without spending another model attempt. Every model retry uses the next configured model tier when one exists. A failed merge conflict or post-rebase validation resumes bounded repair in the original task, branch/worktree and Codex thread, with a separate repair model attempt. After exhaustion, an explicit retry permits one further repair without resetting history; the queue then recomputes integration and reruns mandatory gates.
5. Preserve the task's configured execution mode.
6. If the task was changed to `interactive` after a background failure with `error.kind: "interactive_required"`, continue with `$todo:run` in the current thread. Otherwise leave the retry to the daemon.
7. Use `runner_status` to verify queue execution. Start a stopped runner with `runner_start` when work is ready; never call host automation or desktop application tools.
8. Report the returned task status and model/delivery retry counts, and any separate runner startup error.
