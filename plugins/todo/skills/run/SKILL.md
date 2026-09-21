---
name: run
description: Execute a referenced ToDo Markdown task directly in the current ChatGPT or Codex thread instead of a background CLI worker. Use when the user invokes $todo:run, or mentions the ToDo plugin with a task filename or attached task file and asks to run, continue, fix, or solve it interactively, especially when Browser, Chrome, Computer Use, current-thread tools, or user approvals are required.
---

# ToDo Run

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

<!-- TODO TOOLING EXCEPTION START -->
Classify each operation by its purpose and effects, not just its file path or the fact that a plugin/tool is invoked.
- Perform Codex plugin and auxiliary tool installation, configuration, updates, diagnostics, tool connections, and creation or refresh of their service configurations, indexes, and caches directly, without creating a ToDo task. This includes service files inside the repository.
- Run local builds, tests, application launches, previews, and runtime inspection directly in the current thread when they do not edit product code, project documentation, application dependencies, or build/CI/CD/deployment configuration. Generated local build outputs, caches, logs, test reports, and disposable runtime data are allowed effects of this verification; they do not require a ToDo task.
- Local verification requires no task creation, task_preflight, task_run_start, or task_run_finish, including while another task owns a single-branch reservation. Do not add task dependencies, wait for task completion, stop a worker, or release/recover its reservation merely to run local verification. Respect actual tool/resource conflicts (for example, an occupied Editor or output directory); use separate local outputs where needed and report the concrete conflict if it cannot be avoided.
- Changes to product code, project documentation, application dependencies, build scripts/settings, CI/CD, or deployment still require ToDo, even when performed through a plugin or described as "tooling setup" or "verification". Route any required implementation fixes separately; the local verification exception does not authorize source edits, dependency upgrades, Git mutations, publishing, or deployment. Developing a plugin as the repository's product is also a project change.
- Split mixed requests: perform tool setup directly and route project changes through ToDo. Complete prerequisite setup before publishing dependent project tasks; a setup failure must not publish tasks that depend on it.
- A user's request to configure a tool already authorizes that setup; do not ask for a separate routing confirmation. Preserve existing permission, access, authentication, and hook-trust requirements; never approve hook trust on the user's behalf.
- Examples: docs:init writing .semantic-search.json and indexing docs/ is direct; configuring another Codex plugin or MCP connection is direct; editing source code or docs/ through a plugin requires ToDo; changing a build pipeline or deployment under the label "tooling setup" requires ToDo; connecting a documentation search tool and then rewriting project documentation splits into direct setup and a ToDo documentation task.

The tooling and local verification exceptions do not expand a claimed worker's assigned task scope, repository access, permissions, or authority to create follow-up tasks. Perform tool setup or local verification only when required for the assigned task and already allowed by its restrictions; never use these exceptions to alter unrelated repositories, managed routing instructions, or .todo runtime state.
<!-- TODO TOOLING EXCEPTION END -->

1. Apply the local verification exception above first: a request only to build, test, launch, or inspect the current application without project edits runs directly, even if another task is referenced as context. Do not claim that task or create a verification task. For a request to implement or continue a ToDo task, resolve the referenced `.todo/<task>.md` file, filename, full task ID, or unique numeric prefix in the active repository and follow the task execution steps below.
2. Call `task_run_start` before implementation. Keep the returned `claimToken`; this prevents the background daemon from executing the same task. Use the returned `worktreePath` as the root for every repository read, edit, and validation command. Follow `executionInstructions` when present. In `single-branch` mode this is the existing current copy: do not create or switch branches/worktrees, and verify Unity Editor is connected to a project inside this exact copy before Editor commands.
3. Apply the injected Ponytail full execution contour. Read the returned task body, artifacts, recorded error, repository instructions, and relevant source context. Treat the `Ponytail implementation brief` as the accepted plan and recheck only facts necessary for safety, current correctness, or the failed step; do not repeat broad research from zero.
4. If `mergeRepair` is present, execute only its bounded repair prompt in the existing worktree. It includes the failed gate, logs, task/target HEAD and original requirements. Continue in the original Codex thread; another thread or active owner cannot acquire the repair. Do not rerun the original implementation. Finish with `task_run_finish`; the merge queue commits/continues the rebase, recomputes integration and reruns all mandatory gates before delivery. Existing `merge-failed` validation errors can use `task_retry` or `task_run_start`; an explicit continuation after exhaustion authorizes one additional bounded repair without resetting history.
   If `deliveryOnly` is true, do not rerun implementation; finish the claim so the runner can resume commit/delivery. If `pipelineStage` is present, execute only that paused stage using its prompt and the recorded failure. Otherwise execute the task in this current thread. Do not enqueue it, invoke a background retry, create a second task, or start a separate model run for review. When `requiresPipelineValidation` is true, successful interactive completion returns the task to the runner for the remaining pipeline and mandatory shell gates; it does not mean the task has been delivered.
5. Use structured integrations first. When the task genuinely requires a GUI, use an available `@Browser`, `@Chrome`, or `@Computer` capability and let the host request any required user approval. Never claim GUI access that is not available in the current thread.
6. Before validation, inspect the diff created in this task in the same agent run. Remove only unnecessary wrappers, configuration, dependencies, duplication, unrelated edits, and out-of-scope code introduced by this task; never remove pre-existing repository code or user functionality merely to simplify it. Then run the exact minimal relevant validation. Do not run mutating Git commands: the runner verifies `HEAD`, stages, commits, and performs the task's configured delivery after `task_run_finish`.
7. If user input is required, call `task_run_wait` with the task ID, claim token, and the exact question before ending the turn. Ask the user in this chat. On their answer call `task_run_start` again and use its new token. Do not leave a claim running while waiting, and do not turn missing user input into a generic failure.
8. Otherwise always call `task_run_finish` with the same task ID and `claimToken`:
   - for `single-branch`, use the current on-disk code, including existing staged/unstaged changes. Include `changedFiles`: the exact repository-relative files intentionally changed by the task and reviewed, including deletions, or `[]`. A listed file is committed with its full current content, including pre-existing edits in that file; never restore an API or other task file to its older HEAD/staged version. Preserve unrelated edits and leave unlisted files uncommitted; their dirty state does not block completion. For pipeline stages, report files changed in that stage after reviewing their final content; a finalizer attribution error requires a corrected full list.
   - use `completed` only when the requested outcome and validation are complete;
   - otherwise use `failed` with the concrete root cause, the strongest available evidence, and the smallest actionable next step.
9. Report the final task status and delivery result. Interactive host token usage has `none` coverage because the plugin cannot read the current thread's token counter. Interactive claims belong to the executor-provided thread and turn; never invent those IDs or reuse a different turn's claim token.

## Recovery after manual commits

In single-branch, concurrent commits and changes to previously reviewed files
schedule fresh review in the same task instead of failing delivery. If finish
returns a pending task with `reviewRequired: true`, continue
with `task_run_start`, follow the refreshed instructions, review retained task
files and repeat required checks. Do not report completion until task status is
completed. Background tasks resume automatically. Unlisted dirty files alone
are allowed; branch/copy changes and uncertain live executors still block.

For explicit recovery of a stopped single-branch task after manual commits, inspect the current log and diff, then call `task_retry` with `acceptCurrentHead`
set to the full SHA returned by `git rev-parse HEAD`. This is the supported
operation; never edit task metadata, the reservation, or lock files manually.
Use it only after the previous executor has stopped. A stale SHA, wrong branch,
worktree mode or uncertain executor is rejected. It preserves files, index,
caches and model settings, and requires fresh review and configured checks.
Continue the same task with `task_run_start`, inspect the retained implementation
and make only necessary remaining fixes; do not redo completed work from scratch.
