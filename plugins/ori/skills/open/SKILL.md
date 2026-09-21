---
name: open
description: Open Ori's local web interface to browse product graphs, search components and inspect projections and source runs.
---

# Open Ori

Resolve `scripts/ori` from the plugin root two directories above this skill directory. Identify the user's graph repository and run `scripts/ori --root REPOSITORY open`. It starts or reuses the local server and returns its URL. Use that URL to open a browser or Codex browser panel when needed. The equivalent MCP operation is `ori_open`.

Do not report an open dashboard until the URL is returned. `web --port 0 --no-open` is the foreground alternative for an explicitly managed terminal session. If the repository is uninitialized, explain that `init` is needed and initialize only when that fits the user's request.

Graph files remain the source of truth. Desk renders them and derived local state; the UI is bundled in the Go binary. See [the package documentation](../../README.md) for setup and configuration.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
