# Changelog

## Merge validation recovery

- Continue post-rebase gate failures through the original task, worktree and Codex thread, with bounded repair context and fresh mandatory checks.
- Fence interactive repair continuation with the task claim; recover legacy validation failures through supported retry/continue actions.
- Preserve unfinished repairs, model/delivery history and retry limits across pauses and runner restarts; reject stale target validation.

## App-server dashboard replies

- Remove the legacy `codex exec` runtime. Old backend settings and pipeline
  step types use app-server on their next attempt.
- Remove the desktop MCP adapter, native dispatch, application navigation, and
  host automation instructions. Task session management uses app-server.
- Persist dashboard answers and resume the existing task and paused pipeline
  stage through the runner, including after restart and archival. Preserve
  selected models, worktrees, required shell checks, and Git delivery ownership.
- Reject stale or duplicate answers and retain live request/turn fencing.


## Unreleased - 2026-09-05

- Add waiting-input state, dashboard answers/open-chat/steer controls, exact
  request/turn fencing, and explicit recovery when a pending execution ends.
- Bind interactive claims to executor thread/turn metadata; add task_run_wait,
  same-turn start recovery, confirmed-end reconciliation, and a fenced Stop hook.
- Resume interactive pipeline stages and repairs without bypassing remaining
  stages or mandatory shell gates. Preserve existing blocker semantics.
- Name workers as projectname [999]: taskname and react to task/claim file events
  for supervisor titles. Add conditional official-desktop-MCP dispatch and
  registered-chat reconciliation; report unavailable connections without false
  dispatch success or duplicate retries. Native bridge live support remains
  dependent on the host connection.
- Cover lifecycle, pipeline checkpoints, dashboard request boundaries, and MCP
  ownership; refresh the dashboard screenshot with the input dialog.

- Exempt requested Codex plugin/tool maintenance, service configurations, indexes,
  and caches from task routing by purpose, including inside repositories. Keep
  product/docs/dependencies/build/CI/CD/deployment changes routed; split mixed
  requests and preserve permissions, hook trust, and claimed worker scope.
- Share the rule across skills, MCP descriptions, hooks, and worker prompts.
  Refresh existing managed AGENTS blocks on trusted interactive hooks or via
  explicit maintenance; preserve user content and reject malformed markers.

- Recover persisted merge queues after daemon/runtime restart by retiring the
  predecessor's restart request under the publication gate. Preserve current
  update requests and reuse delivery attempts and archived task threads.
- Log changed merge-queue wait reasons; cover runtime-update handoff, ordinary
  restart/poll recovery, claim/batch gates, and same-batch Git ancestry.
- Return the completed history receipt when an active task disappears during
  status reads or timestamp lookup. Preserve metadata and non-ENOENT errors.
- Add deterministic completion-race coverage for full and numeric task IDs.

## Unreleased - 2026-09-04

- Remove Spark from task profiles, retries, and model discovery; reject stale
  custom Spark profiles and offer their removal during config cleanup.

- Make `models` optional and omit it in new repository configs, inheriting current
  plugin profiles instead of copying model IDs into every repository.
- Resolve saved tasks and pipeline steps by their current profile on each new
  attempt, preserving active attempts, profile names, pipeline commands and past
  logs. Unavailable-model retries refresh the same profile without escalation.

- Added task-role profiles for seven Codex models, live paginated
  executor discovery, unsupported/retired profile diagnostics, and explicit
  preview/apply config updates with backups and stale-preview protection.
- Rejected invalid profiles instead of selecting fallback models; validate saved
  task/pipeline profiles before any agent turn while preserving pipeline commands.
- Rerun snapshotted shell gates on the final rebased commit before merging,
  including conflict repairs and delivery retries; block stale validation.
- Terminate shell process trees on timeout/shutdown before continuing execution.
- Read log tails by bounded bytes and cap dashboard previews at 256 KiB.

- Set GPT-6 Astra as the default most capable model for complex (`expert`,
  `xhigh`) and very complex (`ultra`, `max`) tasks, preserving lighter profiles,
  explicit repository configurations, and existing task/pipeline profile names.

## Unreleased - 2026-08-12

- Added optional repository-defined YAML task pipelines with snapshotted
  `codex-exec`, persistent `codex-thread`, and deterministic `shell` steps,
  bounded repair loops, full shell receipts, and strict legacy fallback when no
  pipeline is configured.
- Replaced dashboard worker-capacity counters with the same task lifecycle
  counters as the supervisor title, including interactive claims in `running`.
- Removed unsupported conditional keywords from the Codex worker output schema
  while retaining mandatory completed-task validation in the daemon runtime.
- Made the daemon keep the supervisor thread title synchronized as
  `-> ToDo (Nr / Mq / Sf)` through app-server `thread/name/set`, without model
  turns or worker-quota usage, with duplicate suppression and non-fatal retry.
- Made `$todo:route` always decompose broad requests and lists into an atomic
  dependency DAG, batching only same-file changes in one logical scope.
- Selected the lowest adequate model tier per atomic task while keeping tests,
  focused verification, and same-attempt self-review mandatory; model retries
  now advance one configured tier.
- Replaced inline `merge` delivery with keep-style branch preservation plus a
  singleton local merge queue that rebases onto the latest target and
  fast-forwards without merge commits or stale-base cherry-picks.
- Made same-batch `merge` siblings wait for earlier same-target task IDs before
  queue delivery, so a faster later task cannot invert the intended Git order.
- Returned textual rebase conflicts to the task's original persistent Codex
  thread through an out-of-quota escalated repair worker, requeued successful
  repairs, and retained logical conflicts as recoverable task errors.
- Added the same paused-rebase conflict-repair flow to the legacy `exec`
  backend instead of failing with `merge_thread_unavailable`.
- Kept OS-assigned dashboard ports stable per host-confirmed Codex thread,
  replacing an occupied reservation and reopening the fresh URL on start.
- Persisted the supervisor's host-confirmed target thread and made every pause
  or resume pass it explicitly, preventing task-creation chats from taking over.
- Archived retained background worker threads after interactive recovery and
  reconciled legacy closed receipts left in `active` instead of only pending.
- Treated an already-missing archived rollout as an idempotent archive success,
  preventing closed receipts from retrying and logging forever.
- Made `$todo:start` open the current runner-provided dashboard URL in a new
  in-app Browser tab, with runner, Browser, and supervisor outcomes separated.
- Made every `$todo:start` invocation replace the repository heartbeat with one
  supervisor bound to the current invoking chat, initially paused when idle.
- Added `$todo:supervise`, repository-local heartbeat binding, active/paused
  reconciliation, lifecycle-driven resume, and idle pausing after one terminal
  queue check so supervision persists without recurring idle model runs.
- Removed successfully merged runner-owned worktrees and task branches even
  when the worktree contains only ignored build output, while continuing to
  preserve any uncommitted tracked or untracked files.
- Replaced fresh `codex exec` worker sessions with one repository-local Codex
  `app-server` and a persistent thread per task by default.
- Reused the saved thread across retries, archived it after every worker attempt
  including failures and shutdown, and added `$todo:reopen` to unarchive and
  continue the same thread.
- Added app-server JSON-RPC usage parsing, cached-input telemetry, lifecycle
  receipts, a legacy explicit `exec` backend, and end-to-end retry/reopen tests.
- Normalized command-check output to a bounded single line so multiline
  `codex app-server --help` output cannot invalidate a successful preflight.

## 0.1.0+codex.20260806214539 - 2026-08-06

- Made `merge` delivery strictly linear: fast-forward an unchanged target or
  cherry-pick onto an advanced target, with no merge commits and retry-safe
  patch-equivalence recovery.
- Added the Git worktree self-check to the default test suite.

## 0.1.0+codex.20260806160436 - 2026-08-06

- Allowed a verified daemon from the exact recorded previous cache version or
  local ToDo package to hand off to the current runtime, while rejecting command
  decoys, mismatched cache versions, stale identity, and PID reuse.
- Added the cross-version runtime regression to the default test suite.
- Serialized restart requests with task publication and claims, and required the
  worker-parent daemon fingerprint to match the current package.

## 0.1.0+codex.20260806151743 - 2026-08-06

- Added one canonical Ponytail full execution contour to routing, session,
  prompt, subagent, background-worker, and interactive task flows.
- Required a concise implementation brief with the resolved owner and callers,
  reused contract, minimal path, excluded alternatives, and minimal validation
  while preserving the original request and acceptance criteria.
- Added same-attempt diff review and minimal validation, kept the brief unchanged
  across retries, and stopped sending internal task metadata to the worker prompt.

## 0.1.0+codex.20260806145958 - 2026-08-06

- Added mandatory connector-aware preflight and repository readiness receipts,
  followed by all-or-nothing runnable task-batch publication.
- Isolated every task in a runner-owned Git worktree and branch with `keep`,
  `merge`, or explicitly requested pull-request delivery.
- Split model and delivery attempts into an immutable ledger, made automatic
  retries fail-closed, and recorded retry counts by trigger and phase.
- Replaced cumulative task usage with schema v2 attempt-local numeric telemetry;
  raw model-request telemetry is reduced in memory and never persisted.
- Reconciled dashboard rows, cells, and logs incrementally to preserve selection
  and scroll while polling.
- Added runtime fingerprints and drain-before-restart updates so the next hook or
  MCP boundary starts fresh code and configuration without interrupting tasks.

## 0.1.0+codex.20260806123319 - 2026-08-06

- Changed the Luna-backed `fast` profile from unsupported `minimal` reasoning
  to `medium`.

## 0.1.0+codex.20260806120615 - 2026-08-06

- Expanded the default model configuration to four task-complexity profiles:
  Luna/minimal `fast`, Terra/medium `medium`, Sol/xhigh `expert`, and
  Sol/ultra `ultra`.
- Kept `expert` as the default profile and added smoke coverage for the exact
  generated configuration.

## 0.1.0+codex.20260806115840 - 2026-08-06

- Removed linked-service metadata, synchronization receipts, completion gates,
  worker instructions, dashboard fields, and MCP inputs.
- Kept ordinary tasks on background `codex exec` by default, with interactive
  execution available only through the existing explicit fallback path.

## 0.1.0+codex.20260806113309 - 2026-08-06

- Allowed claimed workers to create follow-up tasks only when the parent records
  explicit user authorization through `allowWorkerTaskCreation`.
- Added server-side authorization, parent linkage and dependency, non-propagating
  delegation, worker prompt guidance, and smoke coverage for the contract.

## 0.1.0+codex.20260805091718 - 2026-08-05

- Made the MCP launcher self-contained for local marketplace installs by setting
  its plugin-relative working directory and `PLUGIN_ROOT` explicitly.
- Added smoke coverage for MCP startup without an inherited `PLUGIN_ROOT`.
- Moved the MCP stop-safety assertion next to the active-worker snapshot and made
  all MCP smoke calls target the fixture repository explicitly.

## 0.1.0+codex.20260804121103 - 2026-08-04

- Moved dashboard OR-filter smoke assertions after live-worker checks so CI
  cannot finish the short-lived worker fixtures before their metrics are read.

## 0.1.0+codex.20260804115237 - 2026-08-04

- Linked resolvable dependency IDs to their task Markdown in the dashboard.
- Displayed canceled tasks as lime-colored `rejected` records without changing
  the persisted lifecycle status.
- Added `|` alternatives and parenthesized OR values to field filters, including
  OR composition when status or profile values are clicked.

## 0.1.0 - 2026-08-04

- Initial Git-backed marketplace package.
- Added durable task routing, background and interactive execution, configurable
  workers and model profiles, retries, artifacts, metrics, hooks, and dashboard.
- Added package documentation, screenshots, contract tests, and runtime smoke
  coverage.
