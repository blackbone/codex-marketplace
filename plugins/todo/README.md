# ToDo

ToDo gives Codex a durable, repository-local task queue. It routes mutations
through numbered Markdown tasks, executes background work with configurable
workers, and preserves prompts, transcripts, logs, results, timing, and token
usage for later inspection.

| Plugin details | Local dashboard |
| --- | --- |
| ![ToDo plugin details](assets/screenshots/plugin-details.png) | ![ToDo dashboard](assets/screenshots/dashboard.png) |

## Install

Add the marketplace and install only this plugin:

```bash
codex plugin marketplace add blackbone/codex-marketplace --ref main
codex plugin add todo@blackbone
```

Installing ToDo does not activate it in every repository. In a target Git
repository, ask Codex to use `$todo:init`. Initialization creates
`.todo/config.json`, excludes `.todo/` from Git by default, and installs a managed
routing block in the applicable root `AGENTS.md` without replacing other rules.

Use `$todo:start` to start the detached runner and `$todo:dashboard` to retrieve
its current local URL.

## How routing works

In an activated repository, `$todo:route` applies to repository mutations even
when ToDo is not mentioned explicitly. Read-only analysis, planning, status, and
inspection stay in the current thread.

Tasks run in background workers by default. Choose interactive execution only
when requested or when a worker records a concrete current-thread-only capability
requirement. A claim token prevents background and interactive execution of the
same task at the same time.

Task IDs are monotonically increasing and are not limited to three digits.
Dependencies keep tasks blocked until their prerequisites complete. Failed tasks
can retry automatically according to configuration or manually through
`$todo:retry`.

## Skills

| Skill | Purpose |
| --- | --- |
| `$todo:init` | Activate ToDo in a Git repository. |
| `$todo:route` | Route a repository mutation into a durable task. |
| `$todo:create` | Create an explicit self-contained task. |
| `$todo:run` | Claim and execute a task in the current thread. |
| `$todo:start`, `$todo:stop` | Control the detached runner. |
| `$todo:status`, `$todo:list`, `$todo:get` | Inspect tasks, workers, and results. |
| `$todo:dashboard`, `$todo:workers` | Show the dashboard or worker state. |
| `$todo:update`, `$todo:retry`, `$todo:cancel` | Manage an unclaimed task. |
| `$todo:artifact-add` | Attach files, images, URLs, code, or text context. |

The plugin exposes 15 corresponding MCP tools for activation, task lifecycle,
interactive claims, runner control, artifacts, status, and workers. Skills are
the supported user-facing entry points; direct tool calls are agent internals.

## Configuration

The default `.todo/config.json` is:

```json
{
  "workers": 4,
  "pollIntervalMs": 2000,
  "configReloadIntervalMs": 5000,
  "dashboardPort": 0,
  "retries": 0,
  "gitExclude": [".todo/"],
  "models": [
    {
      "name": "fast",
      "model": "gpt-5.6-terra",
      "reasoningEffort": "medium",
      "description": "Focused, low-risk implementation work."
    },
    {
      "name": "expert",
      "model": "gpt-5.6-sol",
      "reasoningEffort": "high",
      "description": "Complex or cross-cutting implementation work."
    }
  ],
  "defaultModelProfile": "expert",
  "routingMode": "all-mutations"
}
```

`workers` accepts 1–32. Poll and reload intervals accept 250–60000 ms.
`dashboardPort: 0` selects a free local port. `retries` is a non-negative integer
or `-1` for unlimited retries. The daemon hot-reloads valid worker, profile,
polling, retry, and dashboard configuration without interrupting active tasks.

Advanced local execution fields `codexCommand` and `codexSandbox` are also
supported. The default sandbox is `workspace-write`.

## Dashboard and records

The dashboard shows tasks separately from worker state, including dependencies,
attempts, timing, exact recorded per-task token usage, errors, and links to logs.
Its URL and port are ephemeral; query `$todo:dashboard` or `$todo:status` instead
of bookmarking one. Prompts, readable transcripts, raw JSONL logs, results, and
metrics remain in `.todo/` for audit and debugging.

Dependency IDs link to their task Markdown when the referenced task is available.
Canceled lifecycle records are labeled `rejected` in the dashboard. Field filters
accept OR values as either `status:completed|rejected` or
`status:(completed|rejected)`; clicking multiple status or profile values builds
the same `|` expression.

The dashboard is local operational tooling, not an account-quota display. Token
usage appears only when Codex emits usage records for the task attempt.

## External workflows

A task may reference Jira, Asana, or another authoritative work item through
`externalWorkflows`. The reference never forces interactive execution. Before a
linked task completes, the agent must synchronize the service-native start and
final statuses and post a result comment that explicitly discloses Codex/AI
authorship. The completion receipt records that synchronization.

## Safety and limitations

- ToDo executes Codex with the current user's local permissions and configured
  sandbox; it is workflow coordination, not isolation.
- The local dashboard can expose repository context, prompts, logs, and errors.
- Do not commit `.todo/` runtime state or place secrets in task descriptions.
- Stopping the runner does not interrupt active tasks unless explicitly forced.
- A running daemon or queued task does not prove that implementation succeeded;
  inspect the task result and validation receipt.

## Development

From the marketplace repository root:

```bash
make test
```

This runs marketplace/documentation contract tests and the ToDo runtime smoke
suite. See [CHANGELOG.md](CHANGELOG.md) and the repository
[architecture](../../docs/ARCHITECTURE.md).

## License

[MIT](../../LICENSE)
