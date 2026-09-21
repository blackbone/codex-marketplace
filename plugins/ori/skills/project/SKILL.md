---
name: project
description: Export a revision-bound Ori projection artifact for local or remote source generation, with explicit selections and constraints.
---

# Export a projection

Resolve the plugin's `scripts/ori` launcher two directories above this skill directory. Pass `--root REPOSITORY` before every command. Inspect the graph and `graph/projections/*.json` to identify the requested projection.

Run `project --id PROJECTION_ID --out OUTPUT_FILE`. Add `--ref GIT_REF` when the user requests a committed revision; otherwise explicitly describe the output as a working-tree snapshot. Preserve the exported JSON as a unit: it includes graph input files, selected objects, selection reasons and a digest.

Report the output path, projection digest and graph revision. Check constraint inclusion and any completeness diagnostics. A projection is input to source execution, not evidence that source code already implements it. It can be transported to a different machine or source repository without assuming a one-to-one graph/source commit relationship.

Read [the package documentation](../../README.md) for selection format. Changing a projection definition is a graph change and should be reviewed for its effect on scope.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
