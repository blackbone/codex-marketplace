---
name: init
description: Initialize or repair a project's .ori configuration, local directories and Git ignore rules while preserving its product graph and settings.
---

# Initialize Ori

Resolve the plugin root two directories above this skill directory. Run its `scripts/ori` launcher with `--root` set to the user's target repository, never to the installed plugin directory.

Read existing `.ori/config.json` if present. Run `scripts/ori --root REPOSITORY init`; initialization resolves the repository root from subdirectories and can be repeated safely. It preserves existing settings, graph content and `.ori/INSTRUCTIONS.md` while restoring missing scaffolding and updating the Ori-managed instructions in root `AGENTS.md` and any existing `AGENTS.override.md`. A fresh setup refuses a pre-existing graph directory collision. For runtime prerequisites and full first-time setup, use `$ori:install`.

Read `.ori/INSTRUCTIONS.md` for this chat, then run `doctor`. Confirm `.ori/config.json`, `.ori/.gitignore` and `.ori/README.md` are trackable; state and generated projections must be ignored. Inspect reported parent/global ignore rules rather than deleting the user's `.gitignore`. The graph lives outside `.ori` at the configured path. Summarize the actual project root, graph path and readiness report.

The default semantic search downloads a pinned local model on first use. Do not download it just to initialize. Graph JSON/Markdown and `.ori/config.json` belong in Git; `.ori/state` and generated projection outputs are local state. Do not create a Git commit unless requested.

Read [the package documentation](../../README.md) when explaining component schemas, model settings or source execution.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
