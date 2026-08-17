---
name: run
description: Execute a referenced ToDo Markdown task directly in the current ChatGPT or Codex thread instead of a background CLI worker. Use when the user invokes $todo:run, or mentions the ToDo plugin with a task filename or attached task file and asks to run, continue, fix, or solve it interactively, especially when Browser, Chrome, Computer Use, current-thread tools, or user approvals are required.
---

# ToDo Run

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Resolve the referenced `.todo/<task>.md` file, filename, full task ID, or unique numeric prefix in the active repository.
2. Call `task_run_start` before implementation. Keep the returned `claimToken`; this prevents the background daemon from executing the same task. Use the returned `worktreePath` as the root for every repository read, edit, and validation command.
3. Apply the injected Ponytail full execution contour. Read the returned task body, artifacts, recorded error, repository instructions, and relevant source context. Treat the `Ponytail implementation brief` as the accepted plan and recheck only facts necessary for safety, current correctness, or the failed step; do not repeat broad research from zero.
4. If `deliveryOnly` is true, do not rerun implementation; finish the claim so the runner can resume commit/delivery. Otherwise execute the task in this current thread. Do not enqueue it, invoke a background retry, create a second task, or start a separate model run for review.
5. Use structured integrations first. When the task genuinely requires a GUI, use an available `@Browser`, `@Chrome`, or `@Computer` capability and let the host request any required user approval. Never claim GUI access that is not available in the current thread.
6. Before validation, inspect the diff created in this task in the same agent run. Remove only unnecessary wrappers, configuration, dependencies, duplication, unrelated edits, and out-of-scope code introduced by this task; never remove pre-existing repository code or user functionality merely to simplify it. Then run the exact minimal relevant validation. Do not run mutating Git commands: the runner verifies `HEAD`, stages, commits, and performs the task's configured delivery after `task_run_finish`.
7. Always call `task_run_finish` with the same task ID and `claimToken`:
   - use `completed` only when the requested outcome and validation are complete;
   - otherwise use `failed` with the concrete root cause, the strongest available evidence, and the smallest actionable next step.
8. Report the final task status and delivery result. Interactive host token usage has `none` coverage because the plugin cannot read the current thread's token counter.
