# Changelog

## Unreleased - 2026-08-12

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
