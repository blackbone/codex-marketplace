# blackbone Codex plugins

A Git-backed Codex marketplace for plugins maintained by [blackbone](https://github.com/blackbone).

[![Tests](https://github.com/blackbone/codex-marketplace/actions/workflows/test.yml/badge.svg)](https://github.com/blackbone/codex-marketplace/actions/workflows/test.yml)

## Plugins

| Plugin | What it does | Package |
| --- | --- | --- |
| ToDo | Atomic repository task routing with optional YAML execution pipelines, persistent threads, deterministic gates, and telemetry. | [Documentation](plugins/todo/README.md) |
| Docs | Search local documentation with shared indexing, project-local SQLite indexes, and a live dashboard with project search. | [Documentation](plugins/docs/README.md) |
| Unity | Open the current Unity project and run Editor actions through the official CLI, with Pipeline checks only on demand. | [Documentation](plugins/unity/README.md) |
| Ori | Git-native product graphs, local semantic search, portable projections and isolated source execution. | [Documentation](plugins/ori/README.md) |

![ToDo plugin details](plugins/todo/assets/screenshots/plugin-details.png)

## Install

From GitHub:

```bash
codex plugin marketplace add blackbone/codex-marketplace --ref main
codex plugin add todo@blackbone
```

For a private repository, use an HTTPS or SSH Git URL available through the
recipient's existing Git credentials. To install directly from a checkout:

```bash
git clone git@github.com:blackbone/codex-marketplace.git
cd codex-marketplace
codex plugin marketplace add .
codex plugin add todo@blackbone
```

Update the marketplace and reinstall a plugin with:

```bash
codex plugin marketplace upgrade blackbone
codex plugin add todo@blackbone
```

## Repository layout

```text
.agents/plugins/marketplace.json  Marketplace catalog
plugins/<name>/                   Self-contained plugin packages
docs/ARCHITECTURE.md              Packaging and runtime boundaries
tests/                            Marketplace contract tests
```

Each plugin owns its manifest, documentation, screenshots, skills, servers,
hooks, and runtime code. The root README is only the marketplace index.

## Development

Requirements: Node.js 22.16 or newer, npm, Go 1.27.1 or newer, Git, and the Codex CLI.

```bash
make test
```

Individual targets are available as `make test-contract` and
`make test-smoke`. GitHub Actions runs the same `make test` entry point on every
push to `main`, pull request, and manual dispatch.

The suite validates the marketplace and documentation contracts, then runs the
ToDo runtime smoke test across preflight and atomic DAG publication, isolated
execution, tiered retries, the local rebase merge queue, attempt-local metrics,
the dashboard, and safe runtime updates.
Ori adds Go tests and a build-and-CLI smoke test with the embedded React interface.

See [CONTRIBUTING.md](CONTRIBUTING.md), [repository architecture](docs/ARCHITECTURE.md),
and [AGENTS.md](AGENTS.md) before changing a package.

## License

[MIT](LICENSE)
