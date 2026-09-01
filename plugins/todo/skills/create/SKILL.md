---
name: create
description: Create one explicitly requested self-contained repository implementation task without decomposing it into a batch. Tasks run through background codex exec by default. Use only when the user explicitly invokes $todo:create for one task; use $todo:route for a list or broad change that requires atomic decomposition.
---

# ToDo Create

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Apply the injected Ponytail full execution contour. Inspect only enough repository context to make the task self-contained and resolve the real owner, flow, affected callers, existing reusable contract, smallest correct implementation, unnecessary alternatives, and exact minimal validation.
2. Identify every connector capability the task requires. Before creating any task, call each connector once in the current interactive thread with the smallest safe ping or fetch that proves the required scope and read/write access. Resolve authentication or user interaction now; do not create a task after a required probe fails.
3. Call `task_preflight` with the normalized probe outcomes and every requested Git delivery. Never include credentials or raw connector responses. Continue only with a successful `preflightId`.
4. Select the lowest `modelProfile` from `.todo/config.json` that can confidently implement and self-review the task. When no repository pipeline is configured, it must also run the mandatory tests or focused verification itself. When a pipeline is configured, its runner-owned shell steps provide authoritative validation after the agent stages. Use the configured default only when no lower profile clearly fits.
5. Call `task_batch_create` with the `preflightId`, exact `requiredCapabilities`, and a one-item `tasks` array. Its description starts with an `Original user request` section containing the current user's request verbatim, followed by the complete intent, relevant paths, constraints, blockers, acceptance criteria, validation expectations, and chat artifacts. It must also contain a concise, fully resolved section with exactly this shape:

   ```markdown
   ## Ponytail implementation brief
   - Owner, flow, and affected callers: ...
   - Existing solution or contract to reuse: ...
   - Minimal implementation path: ...
   - Explicitly excluded options: ...
   - Minimal validation: ...
   ```

   Fill every item with task-specific decisions, not placeholders. The brief preserves the original request and acceptance criteria while preventing the worker from repeating broad research. Do not copy the full injected Ponytail contour into the task body. Failed validation or publication must leave zero runnable tasks.
   - Set `allowWorkerTaskCreation: true` only when the current user explicitly instructs this task's worker to create follow-up ToDo tasks. Include the exact delegation scope and requested model profiles in the description; never infer permission.
   - Omit `delivery` to use the repository default. Set `pr` only when the user explicitly requests a pull request.
6. Use `runMode: "interactive"` only when the user explicitly requests current-thread execution.
7. Keep `ephemeral` true unless the user explicitly requires a persisted Codex session.
8. After successful publication, call `supervisor_get`. If `actionRequired` is `"rebind"`, do not update the heartbeat; report that `$todo:start` must be invoked in the owner chat. If it is `"resume"`, update that exact heartbeat with its stored complete definition, explicitly pass its stored `targetThreadId`, and set `status: "ACTIVE"`; after host confirmation persist the same target and active definition with `supervisor_bind`. Never use the current task-creation chat as the update destination.
9. Do not implement the queued task in the interactive session unless current-thread-only capabilities are independently required or the user explicitly asks for current-thread execution.
10. Return only the task ID and initial status for the implementation portion, plus a separate supervisor-resume error if publication succeeded but the heartbeat could not be resumed.
