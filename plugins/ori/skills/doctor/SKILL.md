---
name: doctor
description: Diagnose an Ori project's setup, graph validity and Git ignore rules without creating an index or downloading the model.
---

# Check Ori setup

Resolve `scripts/ori` two directories above this skill directory. Run `scripts/ori --root PROJECT doctor` and inspect the JSON report, including failed checks when the process exits nonzero.

Report the concrete file or Git rule causing each failure. If the user asked to repair setup, `init` restores owned scaffolding without replacing graph content or configuration; then rerun `doctor`. Preserve unrelated ignore rules and local runtime files. Graph errors require fixing the relevant product files, not deleting `.ori/state` or reinitializing the repository.

An absent configuration needs project initialization through `$ori:install` or `$ori:init`. Missing model weights or an optional source executor are not a reason to block local graph editing.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
