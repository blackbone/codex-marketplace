---
name: status
description: Inspect an Ori repository's graph revision, graph-change reviews and source execution evidence without starting new work.
---

# Inspect Ori

Resolve the plugin's `scripts/ori` launcher two directories above this skill directory. Run `scripts/ori --root REPOSITORY status`; use `change list`, `graph` or `validate` when the user needs the underlying detail.

Summarize current graph revision, actionable pending reviews or questions, source run status and retained worktree paths. Distinguish the snapshot a run consumed from the current graph. Report failed checks and conflicts with their concrete evidence. A missing index or model does not invalidate Git graph files; status inspection should not download a model or start source execution.

See [the package documentation](../../README.md) for state locations and module boundaries.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
