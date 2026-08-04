---
name: run
description: Execute a referenced ToDo Markdown task directly in the current ChatGPT or Codex thread instead of a background CLI worker. Use when the user invokes $todo:run, or mentions the ToDo plugin with a task filename or attached task file and asks to run, continue, fix, or solve it interactively, especially when Browser, Chrome, Computer Use, current-thread tools, or user approvals are required.
---

# ToDo Run

1. Resolve the referenced `.todo/<task>.md` file, filename, full task ID, or unique numeric prefix in the active repository.
2. Call `task_run_start` before implementation. Keep the returned `claimToken`; this prevents the background daemon from executing the same task.
3. Read the returned task body, artifacts, recorded error, repository instructions, and relevant source context.
4. If `externalWorkflows` is non-empty:
   - resolve every listed work item through its purpose-built connector;
   - inspect allowed transitions and move it to the service-native semantic `In Progress` state before implementation;
   - retain the exact resulting status name for the finish receipt.
5. Execute the task in this current thread. Do not enqueue it and do not invoke a background retry.
6. Use structured integrations first. When the task genuinely requires a GUI, use an available `@Browser`, `@Chrome`, or `@Computer` capability and let the host request any required user approval. Never claim GUI access that is not available in the current thread.
7. Validate the result in proportion to the task.
8. For every external work item after the outcome:
   - move it to the closest legal service-native semantic final state matching the result;
   - add a comment with the outcome, what changed, validation, and the explicit disclosure `Performed by Codex (AI)` or an equally clear ИИ attribution;
   - retain the exact final status, comment ID/URL, and exact comment text.
9. Always call `task_run_finish` with the same task ID and `claimToken`:
   - use `completed` only when the requested outcome and validation are complete;
   - otherwise use `failed` with one concrete error and the strongest available evidence.
   - when `externalWorkflows` is non-empty, pass one complete `externalSync` receipt per work item;
   - if external synchronization itself failed, never report completed: use `failed` and pass `externalSyncError`.
10. Report the final task status. Interactive host token usage is recorded as `0` because the plugin cannot read the current thread's token counter.
