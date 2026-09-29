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
- hooks inject the repository routing policy and canonical Ponytail full contour
  at session, prompt, and subagent boundaries.

Activation creates repository-local `.todo/config.json` and runtime directories.
The detached daemon polls durable tasks, executes background Codex workers, and
serves a local dashboard. Interactive tasks are explicitly claimed by the current
thread so the daemon cannot run the same task concurrently.

Repositories may optionally select one versioned YAML execution pipeline from
`.todo/config.json`. The pipeline is validated and snapshotted when a task is
published. Agent steps use either independent `codex exec` runs or the task's
persistent app-server thread; deterministic shell gates run directly in the
task worktree. A failed shell gate emits a bounded receipt to the configured
repair agent step, then restarts all shell gates. Pipeline tasks stay
runner-owned so interactive execution cannot bypass the configured gates. With
no pipeline selected, the existing single-attempt lifecycle remains unchanged.

By default the daemon owns one Codex `app-server` child process for the
repository and multiplexes active tasks over JSON-RPC. Each task stores a unique,
persistent Codex thread ID; attempts are turns in that thread. A transient
every attempt archives the thread when worker execution ends, and retry or task
reopen unarchives it before the next turn. The explicit legacy `exec` backend is
kept for compatibility but does not provide this continuity.

Task publication starts in the interactive host. It performs one minimal probe
for every required connector, then `task_preflight` validates the current
repository, configuration, Codex command, target branch, Git identity, worktree
support, and requested delivery. A short-lived receipt binds those results to the
repository and configuration. `task_batch_create` validates the receipt before
publishing the complete batch; a failed preflight or publication leaves no
runnable subset.

`scripts/ponytail-policy.mjs` is the single source for the adapted Ponytail full
execution contour. The session hook and daemon import that exact text. Routing
and creation skills require a resolved implementation brief inside the existing
task description while preserving the original request and acceptance criteria;
they do not duplicate the full contour in every task. The daemon sends the
contour before the task body, and interactive `$todo:run` receives it from the
hook. Both paths perform diff review and minimal validation in the same model
run. The brief remains unchanged across retries, so only the failed or changed
fact needs renewed investigation. This uses the existing task, MCP, worker-result,
usage, and attempt-ledger schemas.

Every task gets a runner-owned `codex/todo-<id>-<slug>` branch and an isolated
worktree. The worker edits only that worktree; the runner owns staging, commits,
and delivery. `keep` retains the branch, `merge` fast-forwards the configured
target or cherry-picks the task commit without a merge commit, and `pr` pushes it
and creates a pull request only when the task explicitly requests that mode. Git
finalization is separate from model execution so a delivery retry does not spend
another model attempt.

Each model and delivery attempt has an immutable ledger record with its trigger,
outcome, timing, error classification, and retry linkage. Automatic retries are
fail-closed and run only after a classified transient failure in the same model
or delivery phase. Usage schema v2 stores attempt-local numeric token, tool-call,
and payload-size statistics with explicit coverage. App-server usage includes
cached-input totals per turn; request-level transport retry counts remain
unavailable rather than being inferred. Raw model-request telemetry is never
written to disk. The dashboard reconciles keyed rows, cells, and log text incrementally
so polling does not replace unchanged content or destroy selection and scroll.

The daemon records a fingerprint of the installed manifest, MCP declaration,
hooks, scripts, and skills. When a new runtime is detected, it stops claiming
tasks, lets active work drain, and exits. The next hook or MCP boundary starts the
new daemon and reloads configuration. Host-loaded skill and hook definitions need
a new Codex session after an update.

## Hosts and forks

The repository serves two hosts. `.agents/plugins/marketplace.json` is the Codex
catalog and `.claude-plugin/marketplace.json` is the Claude Code catalog. A
package that runs on both hosts is either shared or, when its host integration
and executor differ, split into host forks: `plugins/todo/` for Codex and
`plugins/todo-claude/` for Claude Code, both listed as `todo` in their catalog.

The ToDo forks share the `.todo/` state format, tasks, pipelines, routing rules,
MCP tool contracts, dashboard, and model profile names. They differ only in:

- the manifest, hooks, and MCP launch (`$PLUGIN_ROOT` versus exec-form hooks
  with `${CLAUDE_PLUGIN_ROOT}`, and a second hook entry for the Ponytail contour
  because Claude Code caps each injected context at 10,000 characters);
- skill and prompt wording, and the managed routing file (`AGENTS.md` versus
  `CLAUDE.md`);
- the executor: the Codex fork drives `codex app-server`; the Claude fork's
  `scripts/app-server-client.mjs` keeps the same client interface over
  `claude -p` in stream-json mode, with one Claude session per task, structured
  output for results, and a built-in model catalog;
- interactive ownership: Codex passes thread and turn in MCP metadata; Claude
  Code hooks record the session and prompt under the Claude process ID, which
  the session's MCP server reads as its parent PID.

`scripts/host.mjs` is identical in both forks except for the host identity. It
records the owning host in `.todo/config.json` and refuses task changes, runner
starts, and hook policy while a live runner or task claim of the other host
works in the repository. A dead PID hands the repository to the host that acts
next. Every functional change is made in both forks in the same change, followed
by an agent pass over both forks' functionality.

## Release flow

Package changes require a manifest version bump, contract and runtime validation,
and refreshed documentation when behavior is user-visible. Publishing a Git tag
or branch revision makes the catalog reproducible; upgrading the marketplace
fetches the selected revision before a plugin is reinstalled.
