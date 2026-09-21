---
name: build
description: Generate source changes from an immutable Ori projection in an isolated Git worktree, retaining check results and snapshot evidence.
---

# Build from intent

Resolve the plugin's `scripts/ori` launcher two directories above this skill directory. Identify the graph repository, projection artifact and target source Git repository. These repositories can differ. Read the graph's `.ori/config.json` to understand the executor and configured check commands; do not invent commands for an unfamiliar source project.

Run `scripts/ori --root GRAPH_REPOSITORY build --projection ARTIFACT --source SOURCE_REPOSITORY`. Use `--base REF` only for a requested source base, and `--previous ARTIFACT` when comparing with a known previous projection. The executor works in a retained isolated Git worktree and branch; it does not publish or merge the result.

Inspect `status` and the run result. `generated` means execution completed without configured checks; `verified` means all configured checks passed for the captured projection and source commit. Neither status proves that a later graph revision is satisfied. Keep the worktree path, branch, generated commit and check evidence in the handoff.

If a run is `waiting`, relay its product questions. An explicit new build can carry answers with `--intent "ANSWER AND CONTEXT"`. Retries within one run are bounded by `executor.maxAttempts`; do not loop indefinitely or override user approval settings to force an executor through a block.

See [the package documentation](../../README.md) for the direct-argv executor protocol and privacy boundaries.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
