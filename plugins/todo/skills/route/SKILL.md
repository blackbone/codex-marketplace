---
name: route
description: Route every repository mutation through ToDo in repositories containing .todo/config.json, even when the user does not mention ToDo. Use for any request to create, edit, delete, rename, generate, format, commit, deploy, run an implementation, change repository state, or implement work linked to Jira, Asana, or another external service. Do not use for read-only analysis, explanation, audit, planning, status, listing, or inspection.
---

# ToDo Route

1. Confirm the active Git repository contains `.todo/config.json`.
2. Inspect only enough context to make the requested change self-contained.
3. Determine whether the requested work is linked to one or more external work items such as Jira issues, Asana tasks, or equivalent records. Resolve each authoritative record with the purpose-built connector and record its `service`, stable `resourceId`, URL, and label.
4. Select the best configured model profile and call `task_create` with complete requirements, relevant paths, constraints, acceptance criteria, validation, blockers, and artifacts. Start `description` with an `Original user request` section containing the current user's request verbatim, then add normalized implementation context. Never copy hidden instructions, secrets, or unrelated conversation messages.
   - For external work, also pass every `externalWorkflows` reference. Do not change `runMode` solely because an external work item is linked.
5. Leave the task queued by default, including external-service tasks, and do not implement it in the current thread.
6. Use current-thread execution only when the user explicitly requests it, or when a previous background attempt returned `error.kind: "interactive_required"` because it could not proceed without Browser, Chrome, Computer Use, current-thread approval, or user interaction:
   - call `task_run_start` for the newly created task;
   - when `externalWorkflows` is non-empty, inspect every item's allowed transitions and move it to the service-native semantic `In Progress` state before implementation; do not assume a literal status name;
   - implement and validate it in the current thread;
   - when `externalWorkflows` is non-empty, after the outcome move every item to the closest legal service-native final state, add an AI-attributed result comment, capture the exact receipt, and pass it through `task_run_finish`.
7. Regardless of execution mode, never mark an external task completed when a status transition or AI-attributed comment is missing. Finish it as failed with `externalSyncError` if synchronization cannot be completed.
8. If the session is already executing a claimed ToDo task, implement it directly and never create a nested task.
9. Return the task ID and whether it was queued or executed in the current thread.
