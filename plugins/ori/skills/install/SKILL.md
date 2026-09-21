---
name: install
description: Install Ori's bundled runtime and set up the current project's .ori configuration, graph folders, Git ignore rules and chat instructions through the install command. Use for first setup or completing an interrupted installation.
---

# Install Ori for a project

This skill is available after the Ori plugin is added to Codex. It prepares the bundled runtime and the user's project; it does not register a second plugin or install an unrelated service.

Resolve the plugin root two directories above this skill directory. Use its `scripts/ori` launcher and the user's target project path. The launcher selects the bundled macOS/Linux/Windows executable for x64 or ARM64 and runs it without compilation or downloads. In Windows PowerShell use `scripts/ori.ps1` with the same arguments. MCP and hooks on Windows require Git for Windows `sh.exe` on the Codex process PATH. Do not copy plugin sources, models or node_modules into the project, install a global PATH shim, or build inside the installed package.

1. Identify the intended Git repository. `init` resolves its root even when invoked from a project subdirectory. If the project has no Git repository, initialize Git when that is within the requested setup; do not attach it to a different parent repository by accident.
2. Execute the repository installation command with the resolved absolute paths:

   ```sh
   "<plugin-root>/scripts/ori" --root "<project-root>" install
   ```

   This is the implementation of installation; do not reproduce setup with ad hoc file writes. This runs the bundled runtime, initializes or repairs `.ori`, then returns a readiness report. It creates `.ori/INSTRUCTIONS.md` and updates only the Ori-managed block in root `AGENTS.md` (and an existing `AGENTS.override.md`). Existing graph content, configuration, custom instruction text and unrelated agent rules are retained.
3. If the launcher reports a missing binary, the package is incomplete: reinstall the plugin instead of installing a build toolchain. Go, Node.js and npm are not runtime prerequisites. Git is required for repository operations; on Windows MCP/hooks also need Git for Windows `sh.exe` on PATH. Preserve existing toolchains and shell configuration. Report unsupported OS/architecture combinations explicitly.
4. Inspect the report. `ready: true` means project setup is complete. Missing owned scaffolding can be repaired with `init`; invalid graph content or conflicting existing configuration requires preserving and fixing those files. If an existing root/global Git ignore rule excludes graph files or `.ori/config.json`, inspect `git check-ignore -v --no-index` and add narrowly scoped exceptions where the rule is owned by this project. Preserve unrelated rules. If mutable runtime files are already tracked, explain the affected files before changing their tracking; never delete their local contents or rewrite Git history as setup.

Verify with `scripts/ori --root PROJECT doctor` after any repairs. Read `.ori/INSTRUCTIONS.md` immediately so this chat uses the installed workflow too.

The package supplies `SessionStart` (including resume and compact), `UserPromptSubmit`, and `SubagentStart` hooks. They add compact Ori context only for this configured Git worktree. Codex requires hook review/trust in its plugin UI; installation does not edit trust settings or register duplicate workspace hooks. Explain this requirement if hooks are not yet trusted. A hook never builds or downloads the binary; a missing executable requires reinstalling the plugin. Repository instruction files remain available while hook execution is unavailable.

Initialization leaves the model download for the first semantic search and creates no Git commit. Report the actual repository root, successful readiness checks and any remaining issue. Open the UI with `open` when the user requested it.

See [the package documentation](../../README.md) for the tracked/local file boundary and executor configuration.
