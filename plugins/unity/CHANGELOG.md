# Changelog

## 2026-09-10 — Native engine workflows

- Add focused recipes for native file scripts/dry-run, targeted validation, Safe Mode
  diagnostics, UPM dependencies and project-specific CliCommand extensions.
- Follow native async package add/remove status under the existing operation lease,
  preserve hashed correlation across resumption, and wait for import readiness.
- Add opt-in full doctor evidence from official pipeline list without changing
  ordinary preflight, auto-recovering or disclosing unrelated Editor information.
- Recognize serialized nested failures and redact URL credentials from results.

## 2026-09-10 — Core reliability

- Preserve bounded, credential-filtered engine diagnostics, including nested failures.
- Retry transient readiness loss before dispatch; tolerate brief lock-owner publication.
- Inspect known read-only statuses without releasing an unknown mutation's lease.
- Follow native compilation/test completion across reload; add opt-in managed jobs
  and resumption by operation ID without mutation replay.
- Keep normal synchronous calls and exact project/PID targeting; retain unresolved
  operations and require explicit reconciliation before unlocking.


## 0.1.0 — ToDo compatibility guard

- Require `git.executionMode: "single-branch"` when ToDo is initialized.
- Block startup, status, command discovery/execution and Pipeline installation
  before invoking Unity in worktree mode; include the required config setting.
- Inspect main-checkout config for linked worktrees and reject inherited copies
  after a mode change; keep explicit projects inside the task's working copy.
- Document the guard in both skills; leave repositories without ToDo supported.

## 0.1.0 — AssetImportWorker detection fix

- Exclude recognized AssetImportWorker processes in shared Editor discovery.
- Preserve genuine batch-mode Editors, multiple-Editor protection, unknown
  ownership handling and exact worktree matching.
- Cover hook, wrapper and launcher recheck with regression tests.
