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
5. For workers show ID, state, PID, and current task. Report the singleton merge worker and out-of-quota merge-repair worker separately from the configured implementation worker count.
6. Include runner state, merge worker state, and the dashboard URL when returned.
7. Include the supervisor's configured status, desired status, required action, persisted `targetThreadId`, computed `threadTitle`, active-task count, and the runner's `supervisorThreadTitle` synchronization state when returned.
8. Preserve status values exactly as returned.

9. Inspect `runner.modelDiagnostics`. For stale, unsupported, retired, or unverified profiles, call `model_profiles` with `action: inspect`, show the exact affected profile/model and proposed replacements/removals, and offer the update. Do not apply it without authorization for the displayed plan. Distinguish executor-unavailable models from globally retired models.
