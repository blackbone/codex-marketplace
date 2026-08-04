# Contributing

## Add a plugin

1. Create `plugins/<name>/` with a valid `.codex-plugin/plugin.json`.
2. Keep the directory name, manifest name, and marketplace entry name identical.
3. Add portable package paths; use `$PLUGIN_ROOT` for bundled executables.
4. Add a package README and PNG screenshots under `assets/screenshots/`.
5. Add the plugin to `.agents/plugins/marketplace.json` and the root plugin table.
6. Add contract tests and, for executable plugins, a representative smoke test.
7. Run `make test` and the current Codex plugin validator.

## Update a plugin

Keep changes inside the owning package when possible. Update the README and
screenshots with visible or behavioral changes, add a changelog entry, and bump
the manifest version so marketplace caches can distinguish the package revision.

## Pull requests

Keep a pull request scoped to one plugin or one marketplace-level concern. The
description should state what changed, how it was validated, and any capability
or security boundary affected. Do not include credentials, `.todo/` runtime
state, Codex session data, or machine-specific paths.

GitHub Actions executes `make test` for pushes to `main`, pull requests, and
manual workflow runs. Keep local and CI entry points identical.
