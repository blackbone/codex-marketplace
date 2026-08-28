# blackbone Codex plugins

A Git-backed Codex marketplace for plugins maintained by [blackbone](https://github.com/blackbone).

[![Tests](https://github.com/blackbone/codex-marketplace/actions/workflows/test.yml/badge.svg)](https://github.com/blackbone/codex-marketplace/actions/workflows/test.yml)

## Plugins

| Plugin | What it does | Package |
| --- | --- | --- |
| ToDo | Atomic repository task routing with tiered retries, persistent threads, a local rebase merge queue, and telemetry. | [Documentation](plugins/todo/README.md) |

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

Requirements: Node.js 22 or newer, Git, and the Codex CLI.

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

See [CONTRIBUTING.md](CONTRIBUTING.md), [repository architecture](docs/ARCHITECTURE.md),
and [AGENTS.md](AGENTS.md) before changing a package.

## License

[MIT](LICENSE)
