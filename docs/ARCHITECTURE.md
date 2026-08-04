# Marketplace architecture

## Catalog and packages

The repository has two layers:

1. `.agents/plugins/marketplace.json` lists installable packages and their policy.
2. `plugins/<name>/` contains everything required to install and run one plugin.

Marketplace sources point to local package directories so a Git checkout is a
complete, immutable revision of the catalog. Codex can cache that revision and
install only the requested plugin; users do not need to install every package in
the repository.

## Package contract

The manifest at `.codex-plugin/plugin.json` declares presentation metadata and
capability entry points. Package-relative paths keep installation independent of
the repository checkout location. Bundled processes resolve their code through
`$PLUGIN_ROOT`; per-install mutable data should use `$PLUGIN_DATA`.

Each package owns its documentation and screenshots because release cadence and
runtime boundaries differ between plugins. Cross-plugin files are limited to the
catalog, root index, governance documents, and contract tests.

## ToDo runtime

The ToDo plugin contributes three cooperating surfaces:

- skills decide when and how an agent should call ToDo;
- one MCP server owns repository activation, task state, workers, and status;
- hooks inject the repository routing policy at session and prompt boundaries.

Activation creates repository-local `.todo/config.json` and runtime directories.
The detached daemon polls durable tasks, executes background Codex workers, and
serves a local dashboard. Interactive tasks are explicitly claimed by the current
thread so the daemon cannot run the same task concurrently.

External workflow references are metadata, not an execution mode. A linked task
must synchronize the authoritative service state and record an AI-attributed
result before it can complete.

## Release flow

Package changes require a manifest version bump, contract and runtime validation,
and refreshed documentation when behavior is user-visible. Publishing a Git tag
or branch revision makes the catalog reproducible; upgrading the marketplace
fetches the selected revision before a plugin is reinstalled.
