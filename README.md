# scabr Codex plugins

Git-backed Codex marketplace for plugins maintained by scabr.

## Install from GitHub

After this repository is pushed to GitHub:

```bash
codex plugin marketplace add <owner>/codex-plugins --ref main
codex plugin add todo@scabr
```

For a private repository, use an HTTPS or SSH Git URL that works with the
recipient's existing Git credentials.

## Install from this checkout

```bash
cd /path/to/codex-plugins
codex plugin marketplace add .
codex plugin add todo@scabr
```

## Update

```bash
codex plugin marketplace upgrade scabr
codex plugin add todo@scabr
```

## Test

```bash
npm test
```

The test suite validates the marketplace/package contract and runs the ToDo
runtime smoke test, including its MCP tools, routing, task lifecycle, retries,
metrics, dashboard, hooks, and external-workflow behavior.
