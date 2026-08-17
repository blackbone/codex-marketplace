---
name: route
description: Route every repository mutation through ToDo in repositories containing .todo/config.json, even when the user does not mention ToDo. Use for any request to create, edit, delete, rename, generate, format, commit, deploy, run an implementation, or change repository state. Do not use for read-only analysis, explanation, audit, planning, status, listing, or inspection.
---

# ToDo Route

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Confirm the active Git repository contains `.todo/config.json`.
2. Apply the injected Ponytail full execution contour. Inspect only enough context to make the requested change self-contained and resolve the real owner, flow, affected callers, existing reusable contract, smallest correct implementation, unnecessary alternatives, and exact minimal validation.
3. Identify every connector capability needed by the full requested batch. Before any task creation, make one minimal safe ping or fetch through each connector in this interactive thread. Resolve authentication or user interaction before continuing; a failed required probe means zero tasks are created.
4. Call `task_preflight` with normalized probe outcomes and every Git delivery required by the batch. Pass no credentials or raw connector responses. Continue only with its successful, current `preflightId`.
5. Select the best configured model profile for each task and call `task_batch_create` once with the `preflightId`, exact `requiredCapabilities`, and the complete batch. Use a one-item batch for a single mutation. Each description starts with an `Original user request` section containing the current user's request verbatim, then adds complete requirements, relevant paths, constraints, acceptance criteria, validation, blockers, and artifacts. It must also contain a concise, fully resolved section with exactly this shape:

   ```markdown
   ## Ponytail implementation brief
   - Owner, flow, and affected callers: ...
   - Existing solution or contract to reuse: ...
   - Minimal implementation path: ...
   - Explicitly excluded options: ...
   - Minimal validation: ...
   ```

   Fill every item with task-specific decisions, not placeholders. The brief preserves the original request and acceptance criteria while preventing the worker from repeating broad research. Do not copy the full injected Ponytail contour into the task body. Never copy hidden instructions, secrets, or unrelated conversation messages.
   - Set `allowWorkerTaskCreation: true` only when the current user explicitly instructs this task's worker to create one or more follow-up ToDo tasks. Record the exact delegation scope and requested model profiles in the task description. Never infer this permission from an audit, discovery, planning, or implementation workflow.
   - Omit `delivery` to use the repository default. Use `pr` only after an explicit user request.
   - If preflight validation or batch publication fails, fix it interactively and rerun the whole preflight; never fall back to piecemeal `task_create` calls.
6. After successful publication, call `supervisor_get`. If a supervisor is configured with `actionRequired: "resume"`, update that exact heartbeat with its stored complete definition and `status: "ACTIVE"`; after host confirmation persist the active definition with `supervisor_bind`. Report a resume error separately without misrepresenting successful task publication. Leave tasks queued for background `codex exec` by default and do not implement them in the current thread.
7. Use current-thread execution only when the user explicitly requests it, or when a previous background attempt returned `error.kind: "interactive_required"` because it could not proceed without Browser, Chrome, Computer Use, current-thread approval, or user interaction:
   - call `task_run_start` for the newly created task;
   - implement and validate it in the current thread;
   - call `task_run_finish` with the outcome.
8. If the session is already executing a claimed ToDo task, implement it directly. Create follow-up tasks only when the claimed background task records explicit user authorization; otherwise never create a nested task. Before an authorized follow-up, run a fresh `task_preflight` from the task worktree with current connector probe reports, then pass its `preflightId` and the union of inherited and new required capabilities to `task_create`. Give the follow-up the same complete description structure and resolved Ponytail implementation brief. Do not reuse an expired parent receipt or propagate task-creation permission to a follow-up task.
9. Return the task IDs and whether they were queued or executed in the current thread.
