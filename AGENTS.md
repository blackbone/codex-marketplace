# Repository instructions

This repository is a multi-plugin Codex marketplace. Keep every plugin
self-contained under `plugins/<name>/` and keep the root focused on catalog,
governance, and cross-plugin validation.

## Source of truth

- `.agents/plugins/marketplace.json` is the marketplace catalog.
- `plugins/<name>/.codex-plugin/plugin.json` is the installed plugin contract.
- A marketplace entry name, plugin directory name, and manifest `name` must match.
- Plugin paths must be relative and portable. Never embed a developer home path.
- Runtime commands should resolve files from `$PLUGIN_ROOT`; mutable state belongs
  under `$PLUGIN_DATA` or the target repository, as appropriate.

## Required package contents

Every plugin must include:

- `.codex-plugin/plugin.json`;
- `README.md` with installation, usage, configuration, and limitations;
- PNG screenshots under `assets/screenshots/`, referenced by the manifest;
- automated contract or smoke coverage appropriate to its runtime;
- an entry in the root plugin table and marketplace catalog.

Optional capabilities such as `skills/`, MCP servers, hooks, apps, and commands
remain inside the package that owns them.

## Change rules

- Preserve unrelated changes and do not edit generated runtime data.
- Keep public descriptions aligned across marketplace metadata, manifest, and docs.
- Update screenshots when the visible plugin or dashboard contract changes.
- Bump the plugin version whenever distributed package contents change.
- Append new plugins; do not reshape existing package boundaries for a shared
  abstraction unless more than one package genuinely uses it.
- Document security-sensitive behavior and never commit credentials or local data.

## Validation

Run `make test` after a package or catalog change. Also validate each changed
plugin manifest with the current Codex plugin validator. Do not claim runtime
support based only on documentation or a marketplace entry.
