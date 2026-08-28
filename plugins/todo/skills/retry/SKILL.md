---
name: retry
description: Manually retry a failed ToDo task after its configured automatic retries are exhausted or intentionally disabled. Use only when the user explicitly invokes $todo:retry.
---

# ToDo Retry

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `task_get` for the requested task.
2. Inspect `attemptLedger`, `retryStats`, the latest classified status, and the Git phase. Automatic retry is fail-closed and applies only to `failed_transient`; unknown, authentication, permission, cancellation, preflight, and interactive failures never qualify automatically.
3. Retry only after the recorded cause has been addressed or the user explicitly accepts a new manual attempt. Resolve authentication, connector probes, or required interaction in the current thread first.
4. Call `task_retry`. A failed Git delivery resumes the runner-owned delivery phase without spending another model attempt. Every model retry uses the next configured model tier when one exists. A failed logical merge repair re-enters the merge queue; if it conflicts again, its original thread receives a newly escalated repair turn.
5. Preserve the task's configured execution mode.
6. If the task was changed to `interactive` after a background failure with `error.kind: "interactive_required"`, continue with `$todo:run` in the current thread. Otherwise leave the retry to the daemon.
7. Call `supervisor_get`. If `actionRequired` is `"rebind"`, do not update the heartbeat; report that `$todo:start` must be invoked in the owner chat. If it is `"resume"`, update that exact heartbeat with its stored complete definition, explicitly pass its stored `targetThreadId`, and set `status: "ACTIVE"`; after host confirmation persist the same target and active definition with `supervisor_bind`. Never retarget it to the retry chat.
8. Report the returned task status and model/delivery retry counts, plus any separate supervisor-resume error.
