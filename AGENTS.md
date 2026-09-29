# Repository instructions

This repository is a multi-plugin marketplace for Codex and Claude Code. Keep
every plugin self-contained under `plugins/<name>/` and keep the root focused on
catalogs, governance, and cross-plugin validation.

## Source of truth

- `.agents/plugins/marketplace.json` is the Codex marketplace catalog.
- `.claude-plugin/marketplace.json` is the Claude Code marketplace catalog.
- `plugins/<name>/.codex-plugin/plugin.json` is the installed Codex plugin contract;
  `plugins/<name>/.claude-plugin/plugin.json` is the installed Claude Code contract.
- A marketplace entry name, plugin directory name, and manifest `name` must match.
  The only exception is a host fork (see below): its directory is
  `plugins/<name>-<host>/`, while its manifest and catalog entry keep `<name>`.
- Plugin paths must be relative and portable. Never embed a developer home path.
- Runtime commands resolve files from the plugin root (`$PLUGIN_ROOT` in Codex,
  `${CLAUDE_PLUGIN_ROOT}` in Claude Code); mutable state belongs under the host
  plugin data directory (`$PLUGIN_DATA`, `${CLAUDE_PLUGIN_DATA}`) or the target
  repository, as appropriate.

## Host forks

ToDo ships as two forks of one product:

- `plugins/todo/` — Codex fork, listed as `todo` in the Codex catalog;
- `plugins/todo-claude/` — Claude Code fork, listed as `todo` in the Claude catalog.

The forks share the repository state format (`.todo/`), tasks, pipelines,
routing rules, MCP tool contracts, dashboard, and model profile names. They
differ only in host integration (manifest, hooks, MCP launch, skill wording) and
the executor (Codex CLI and models versus Claude CLI and models).

- Every functional change to one fork must be made in the other fork in the same
  change: behavior, state format, MCP tools, skills, routing, pipelines, dashboard,
  host claim, and tests. Only host integration and executor code may differ.
- After such a change, do an agent pass over the functionality of both forks and
  confirm they still match.
- A repository is claimed by exactly one host at a time. Never weaken the host
  claim or allow both forks to run tasks in one repository.
- Each fork bumps its own version.

## Required package contents

Every plugin must include:

- a host manifest (`.codex-plugin/plugin.json` and/or `.claude-plugin/plugin.json`);
- `README.md` with installation, usage, configuration, and limitations;
- PNG screenshots under `assets/screenshots/`, referenced by the Codex manifest;
- automated contract or smoke coverage appropriate to its runtime;
- an entry in the root plugin table and the catalog of each host it supports.

Optional capabilities such as `skills/`, MCP servers, hooks, apps, and commands
remain inside the package that owns them.

## Change rules

- Preserve unrelated changes and do not edit generated runtime data.
- Keep public descriptions aligned across marketplace metadata, manifests, and docs.
- Update screenshots when the visible plugin or dashboard contract changes.
- Bump the plugin version whenever distributed package contents change.
- Append new plugins; do not reshape existing package boundaries for a shared
  abstraction unless more than one package genuinely uses it.
- `CLAUDE.md` imports this file; edit repository instructions here only.
- Document security-sensitive behavior and never commit credentials or local data.

## Validation

Run `make test` after a package or catalog change. Also validate each changed
plugin manifest with the current validator of its host (Codex plugin validator,
`claude plugin validate --strict`). Do not claim runtime support based only on
documentation or a marketplace entry.
