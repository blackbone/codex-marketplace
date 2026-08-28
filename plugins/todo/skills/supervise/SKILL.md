---
name: supervise
description: Create, synchronize, run, pause, resume, or disable the persistent chat heartbeat that keeps an activated repository's ToDo queue moving without recurring model runs while the queue is idle. Use when the user invokes $todo:supervise or when its bound heartbeat invokes this skill.
---

# ToDo Supervise

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call. Use the Codex app automation capability for every heartbeat mutation; never edit automation files directly.

## Configure or synchronize

1. Call `supervisor_get`.
2. `$todo:start` owns the rebind-to-current-chat flow. When this skill is invoked directly for first-time setup, create the heartbeat in the current chat. Existing bindings store their owner as `targetThreadId`; never replace it with the chat that happens to create, retry, or reopen work.
3. For first-time setup, create one heartbeat in the current chat with:
   - name `Keep <repository-name> ToDo running`;
   - prompt `Use $todo:supervise in scheduled-run mode for this repository. Do not create another automation.`;
   - recurrence `FREQ=MINUTELY;INTERVAL=15` unless the user explicitly requests another interval;
   - kind `heartbeat` and destination `thread`;
   - status equal to `desiredStatus` from `supervisor_get`.
4. After the host confirms creation, read the host-persisted definition for that exact automation ID, capture its `target_thread_id`, and call `supervisor_bind` with `targetThreadId` equal to it plus the exact name, prompt, recurrence, and confirmed status. Reading verifies the host-selected current chat; never edit the automation file. The binding is mutable local `.todo` state and must not be committed.
5. If `actionRequired` is `rebind`, do not update the heartbeat; invoke `$todo:start` in the intended owner chat. When it is `resume` or `pause`, update that exact heartbeat with its complete stored definition, kind `heartbeat`, its stored `targetThreadId`, and the requested status. Only after the host confirms the update, persist the same target and status with `supervisor_bind`. Never send `destination: thread` without the stored target because that would retarget ownership to the current chat.
6. If a configured automation no longer exists, recreate it from the stored definition in the current chat and replace the binding with the new confirmed ID. Never create a duplicate when the configured automation still exists.
7. To disable supervision, first delete the exact configured heartbeat through the host. After confirmed deletion call `supervisor_clear`.

## Scheduled run

1. Call `supervisor_get`, then `todo_status`. Treat every active task file, including `queued`, `running`, `blocked`, `failed`, or `staging`, as active work.
2. If `activeTasks.total` is zero, update this exact heartbeat to `PAUSED` while explicitly passing its stored `targetThreadId`, persist the same target and `PAUSED` status through `supervisor_bind`, and stop. This is the single terminal detection run; once paused there must be no recurring idle runs. Do not delete or retarget the heartbeat.
3. If work exists but the runner is genuinely stopped, call `runner_start` and confirm the resolved state. Leave a healthy runner and healthy `running` work alone.
4. For a failed task, call `task_get` and inspect its attempt ledger, error, Git phase, logs, worktree, and current repository evidence. A generic `failed` or `interrupted` label is not a root cause. Do not retry blindly.
5. Claim the original failed task with `task_run_start` and retain its claim token. Spawn exactly one bounded subagent for that task with the returned worktree path, task body, recorded failure, and relevant evidence. The subagent must not call ToDo tools, create tasks, mutate Git, or expand scope; it diagnoses and repairs directly inside the already claimed original task worktree.
6. In the supervising agent, inspect the resulting diff and run the smallest relevant validation. Finish the original claim with the same token:
   - use `completed` when the original task is complete and validated;
   - otherwise use `failed` with the concrete remaining fact. If only the failure cause was repaired and the original task remains incomplete, call `task_retry` for that same task and confirm it is `queued` or `running`.
7. For delivery, cleanup, dependency, or worktree failures, verify the actual Git result first and resume only the failed lifecycle phase. Do not rerun completed implementation.
8. If recovery needs user input, new authority, authentication, or an external-state change, report the exact blocker and smallest next step. Do not bypass security or the claim.
9. Process failed tasks one at a time. If no failure or stopped runner was found, make no changes and emit no routine success message.

## Resume protocol for other ToDo skills

After an operation creates or reactivates work, call `supervisor_get`. If `actionRequired` is `"rebind"`, do not update anything and require `$todo:start` in the intended owner chat. If it is `"resume"`, update that exact heartbeat using its complete stored definition, explicitly pass its stored `targetThreadId`, and set `status: "ACTIVE"`; after host confirmation call `supervisor_bind` with the same target, definition, and active status. Failure to resume supervision must be reported separately and must not be represented as failure of an otherwise successful task publication or runner operation.
