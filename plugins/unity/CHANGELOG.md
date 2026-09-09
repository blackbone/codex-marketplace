# Changelog

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
