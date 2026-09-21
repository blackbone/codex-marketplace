---
name: find
description: Find requirements, constraints and related entities in an Ori graph using local semantic search and explicit links.
---

# Find intent

Use the plugin's `scripts/ori` launcher, resolved two directories above this skill directory, and pass `--root REPOSITORY` before the command.

Run `find --query "USER TOPIC" --limit 12`. First semantic use downloads and initializes the local multilingual model; allow the command to finish. If the user requests offline operation before model installation, use `--lexical` and identify the result as lexical. Do not silently substitute lexical results for a failed semantic search.

For a proposed change or a specific entity, run `impact --ids ID,ID` to inspect connected components and constraints. Check the returned truncation indicator before treating the impact set as complete. Search ranking identifies candidates; explicit graph text and links provide evidence. Cite relevant component IDs and file paths from results, and explain any unresolved conflicting intent.

Read [the package documentation](../../README.md) for model and graph format details.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
