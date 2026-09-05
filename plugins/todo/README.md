# ToDo

ToDo gives Codex a durable, repository-local task queue with automatic atomic
decomposition, Ponytail full task formation and execution, connector and Git
preflight, atomic DAG publication, optional repository-defined execution
pipelines, isolated worktree delivery, persistent per-task Codex threads,
tier-escalating retries, a local rebase merge queue, per-attempt telemetry, and
a live dashboard.

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
The bundled MCP launcher resolves its runtime from the installed plugin directory,
so local marketplace installs do not depend on an inherited `PLUGIN_ROOT` value.

Use `$todo:start` to start the detached runner and `$todo:dashboard` to retrieve
its current local URL.

## How routing works

In an activated repository, `$todo:route` applies to repository mutations even
when ToDo is not mentioned explicitly. Read-only analysis, planning, status, and
inspection stay in the current thread. The legacy config value `all-mutations`
means project mutations subject to the following purpose-based exception.

<!-- TODO TOOLING EXCEPTION START -->
Classify each operation by its purpose and effects, not just its file path or the fact that a plugin/tool is invoked.
- Perform Codex plugin and auxiliary tool installation, configuration, updates, diagnostics, tool connections, and creation or refresh of their service configurations, indexes, and caches directly, without creating a ToDo task. This includes service files inside the repository.
- Product code, project documentation, application dependencies, build, CI/CD, and deployment changes still require ToDo, even when performed through a plugin or described as "tooling setup". Developing a plugin as the repository's product is also a project change.
- Split mixed requests: perform tool setup directly and route project changes through ToDo. Complete prerequisite setup before publishing dependent project tasks; a setup failure must not publish tasks that depend on it.
- A user's request to configure a tool already authorizes that setup; do not ask for a separate routing confirmation. Preserve existing permission, access, authentication, and hook-trust requirements; never approve hook trust on the user's behalf.
- Examples: semantic-search:init writing .semantic-search.json and indexing docs/ is direct; configuring another Codex plugin or MCP connection is direct; editing source code or docs/ through a plugin requires ToDo; changing a build pipeline or deployment under the label "tooling setup" requires ToDo; connecting a documentation search tool and then rewriting project documentation splits into direct setup and a ToDo documentation task.

The tooling exception does not expand a claimed worker's assigned task scope, repository access, permissions, or authority to create follow-up tasks. Perform tool setup only when required for the assigned task and already allowed by its restrictions; never use it to alter unrelated repositories, managed routing instructions, or .todo runtime state.
<!-- TODO TOOLING EXCEPTION END -->

After a plugin update, trusted `SessionStart` and `UserPromptSubmit` hooks refresh
existing ToDo-managed blocks in root `AGENTS.md` and `AGENTS.override.md`.
Content outside the markers, configuration, and task state are preserved.
Missing blocks are not silently installed; use `$todo:init` to restore one.
Malformed or duplicate markers and symlinked instruction files are left intact
and reported. Background workers and subagent hooks do not refresh blocks.
Without trusted hooks, run the bundled maintenance command directly for explicit
repository roots (or invoke `$todo:init`); no ToDo task or additional routing
confirmation is needed:

```bash
node "$PLUGIN_ROOT/scripts/refresh-routing-policy.mjs" /path/to/repository
```

Reinstallation does not scan all repositories or grant hook trust. Open a new
Codex task to load updated skills and MCP descriptions; repository blocks update
on their next trusted hook or the explicit maintenance command.

Routing always prefers independently implementable and independently verifiable
tasks over one broad change. Lists, separate owners, runtime layers, migrations,
and validation surfaces are split into an atomic dependency DAG. Changes are
batched only when they touch the same files in one logical scope and splitting
would create artificial conflicts or an invalid intermediate state, such as one
surface's related layout and style edits.

Before any task is created, the interactive agent makes one minimal ping or
fetch through every connector the task will need. It passes only normalized
connector, scope, access, and outcome reports to `task_preflight`; credentials
and probe responses are not stored. The preflight also checks the current plugin
runtime, configuration, Codex command, Git root, target branch, identity,
worktree support, and requested delivery. Authentication or any other required
failure is resolved interactively before task creation is attempted again.

The resulting receipt is short-lived and bound to the repository and effective
configuration. `task_batch_create` validates it and publishes the whole batch,
including a one-task batch, behind a publication lock. A failed preflight,
expired or mismatched receipt, missing required capability, or failed publication
creates zero runnable tasks.

Each atomic task uses the lowest configured model tier that can confidently
implement, test or otherwise verify, and self-review it. Built-in retries follow the task-role escalation path described below; custom profiles advance through their configured order. Tasks run in background workers by default. Choose interactive execution only
when requested or when a worker records a concrete current-thread-only capability
requirement. A claim token prevents background and interactive execution of the
same task at the same time.

A claimed worker implements its task directly and cannot create follow-up ToDo
tasks by default. Task creation is available only when the user explicitly asks
for delegation and the parent task records `allowWorkerTaskCreation: true`.
Authorized follow-up tasks automatically depend on their parent, record its task
ID, and cannot inherit the permission. For example, a user may explicitly ask a
`fast` verification task to create an `expert` implementation task from confirmed
findings.

Task IDs are monotonically increasing and are not limited to three digits.
Dependencies keep tasks blocked until their prerequisites complete. Failed tasks
can retry automatically according to configuration or manually through
`$todo:retry`.

An optional `$todo:supervise` heartbeat keeps the queue moving across failures
that require interactive diagnosis. It runs every 15 minutes while active task
files exist, performs one terminal check after the queue becomes empty, then
pauses instead of deleting itself. Creating, retrying, reopening, or starting
work resumes the same bound heartbeat, so an idle repository has no recurring
model runs.

The default execution backend is one long-lived Codex `app-server` process per
repository. Each task receives its own persistent Codex thread, and its thread
ID is stored with the task. Retries add turns to that same thread, so Codex can
reuse the task conversation and repository findings instead of starting a fresh
`codex exec` session. Retry turns send only a compact continuation with the
recorded failure instead of repeating the original task body and execution
contour. The runner creates or unarchives the saved thread when an attempt
starts and archives it whenever that attempt ends, including failure and daemon
shutdown. Retries and `$todo:reopen` unarchive that same thread before the next
turn.

## Ponytail full lifecycle

Every activated session, submitted prompt, and started subagent receives the
same canonical Ponytail full contour together with the routing policy. Task
formation applies it after tracing the real owner, flow, and affected callers.
The task keeps the original user request and acceptance criteria plus a concise
implementation brief: the owner and callers, existing contract to reuse, minimal
path, explicitly excluded alternatives, and minimal validation. The full contour
is not copied into each task body.

The daemon places that same canonical contour before the body sent to every
background worker. `$todo:run` applies it to interactive execution through the
same hook. The brief is treated as the accepted plan, so workers recheck only
necessary or changed facts instead of repeating broad discovery. Model-profile
selection remains unchanged.

Before completing, the same worker or interactive agent reviews its own diff,
removes only unnecessary wrappers, configuration, dependencies, duplication, or
out-of-scope code introduced by that task, and runs the smallest relevant check.
It never removes pre-existing repository code or user functionality merely to
simplify it. This review does not create another task or model run. A retry keeps
the same task body and brief and resumes from the concrete failed fact.

## Skills

| Skill | Purpose |
| --- | --- |
| `$todo:init` | Activate ToDo in a Git repository. |
| `$todo:route` | Route project changes into tasks; perform tool setup directly. |
| `$todo:create` | Create an explicit self-contained task. |
| `$todo:run` | Claim and execute a task in the current thread. |
| `$todo:start` | Start the runner, bind its supervisor, and open its dashboard in the in-app Browser. |
| `$todo:stop` | Stop the runner and pause its supervisor. |
| `$todo:supervise` | Bind a persistent, idle-pausing heartbeat to the current chat. |
| `$todo:status`, `$todo:list`, `$todo:get` | Inspect tasks, workers, and results. |
| `$todo:dashboard`, `$todo:workers` | Show the dashboard or worker state. |
| `$todo:update`, `$todo:retry`, `$todo:reopen`, `$todo:cancel` | Manage an unclaimed or closed task. |
| `$todo:artifact-add` | Attach files, images, URLs, code, or text context. |

The plugin exposes 23 corresponding MCP tools for preflight, atomic batch
publication, activation, task lifecycle, interactive claims, runner control,
artifacts, supervisor binding, status, and workers. Skills are the supported
user-facing entry points; direct tool calls are agent internals.

## Human input and native app execution

The dashboard's **Answer** / **Chat / input** control shows the outstanding
question, accepts answers, sends instructions, and opens the associated Codex
chat. **Logs** continues to show per-attempt execution evidence. `waiting-input`
is a separate status; automatic retries do not consume unanswered questions.
An app-server `item/tool/requestUserInput` request stays attached to its live
turn. Dashboard replies must match its request and claim; steer must match the
active turn. If the run ends before an answer, the task stays waiting and can
continue in a native chat instead of pretending that the old request is live.

Native execution uses `$todo:run`, `task_run_start`, `task_run_wait`, and
`task_run_finish`. The executor must supply both thread and turn metadata;
missing ownership is an error before claiming, not a shared-MCP-PID lease.
Repeated starts from the same prepared turn return the same claim. A different
turn cannot finish it. `task_run_wait` persists the question and releases the
claim. A trusted Stop hook releases only an exact matching turn; otherwise the
runner needs a host-confirmed ended turn to recover the claim. Unknown or active
host status never expires it. Use `$todo:run` again after answering.

Native dashboard actions and automatic dispatch of queued `runMode: interactive`
tasks require the installed official `codex-app-tools` MCP, an inherited
`CODEX_APP_TOOLS_PIPE_PATH`, and a host-confirmed supervisor owner. This adapter
is conditional: an app-server process alone does not provide the Codex app's
Browser or user-interaction capabilities. If the official MCP connection is
unavailable (including `Codex app tools pipe closed`), dashboard app actions
report the error and native dispatch remains unavailable. Continue from a Codex
app chat with `$todo:run`; do not assume native access was established merely
because a task was queued. The adapter uses the official MCP server and does not
modify Codex's database or reproduce its private socket protocol.

A connection or project-discovery failure does not reserve a dispatch. If the
connection fails after a create/send request, its outcome is uncertain: the
runner preserves that marker and refuses duplicate dispatch. Inspect the chat
named `projectname [999]: taskname` and continue the original task with
`$todo:run`; claiming it clears the marker. Native jobs use the saved project to
start the app session and the existing ToDo worktree for implementation, so Git
delivery remains owned by ToDo. The host retains its normal tool permissions.
Dashboard writes require the exact loopback Host/Origin, JSON, and a custom
request header; stale answers and turns are rejected.

Worker names follow `projectname [999]: taskname`. Task/claim changes trigger
supervisor title updates in code. When the desktop connection is available,
the runner also reconciles registered inactive worker chats through the app;
archived chats are temporarily unarchived for renaming and then archived again
without starting a turn. A missing chat does not block cleanup of later chats.
Ordinary user discussions that execute `$todo:run` are not automatically renamed
or archived; the runner manages only explicitly associated worker chats.

Blockers retain their existing semantics: canceling a blocker makes dependent
tasks eligible to recheck their preconditions. This is not a tree cancellation.
For a live preview, configure merge delivery to the working branch (for example
`main`); Vite, backend watchers, or the Unity editor own rebuild/restart.

## Supervisor lifecycle

Invoke `$todo:start` in the project chat that should own recovery. In addition
to starting the runner, every invocation replaces any previously bound
heartbeat with one 15-minute heartbeat owned by the current chat. An empty
queue creates it paused; active work creates it active. The host automation ID
and non-secret definition, including the host-confirmed `targetThreadId`, are
stored in ignored `.todo/supervisor.json` only after the host confirms
creation. Every later pause or resume passes that exact target explicitly, so
task creation in another chat cannot take ownership. Legacy bindings without a
target require `$todo:start` in the intended owner chat instead of guessing.
`$todo:supervise` can also configure or
synchronize the heartbeat directly. Scheduled runs leave healthy work alone.
For a failed task, the supervisor claims the original task and delegates
bounded diagnosis or repair to one subagent inside that existing task worktree
without creating a helper ToDo task.

While the runner is active, its shared Codex app-server connection keeps the
bound supervisor thread named `-> ToDo (Nr / Mq / Sf)`. `r` counts running
tasks, `q` combines queued, blocked, staging, merge-queued, and merge-conflict
tasks, and `f` counts failed tasks. A nonzero `w` counts tasks waiting for input.
Title changes do not wait for the 15-minute supervisor heartbeat. The daemon reacts to task and claim file changes as well as scheduling passes,
sends `thread/name/set` only when the target or title
changes, and needs no model turn or worker slot. Rename failures are non-fatal,
visible in runner state and logs, and retried with a short backoff. Without a
persisted `targetThreadId`, title synchronization stays unbound until
`$todo:start` rebinds the owner thread.

The host scheduler exposes recurring active and paused states, not a repository
event trigger. The heartbeat therefore makes one final run to observe that the
queue became empty and pause itself. Later task publication, retry, or reopen
resumes the same binding. A later `$todo:start` intentionally moves ownership
to its invoking chat by deleting the exact old heartbeat before creating and
binding the replacement. `$todo:stop` pauses it. Disabling the supervisor
deletes the exact host automation first and clears the local binding only after
confirmed deletion.

Supervisor automation requires the Codex desktop host. Core queue execution and
transient retry remain independent of it, and a failure to resume the heartbeat
is reported separately from successful task publication.

App-server worker threads are archived after every attempt. Interactive recovery
marks any retained background worker thread `archive-pending` before closing or
failing the claim, and the daemon reconciles every non-archived closed receipt,
including legacy receipts incorrectly left `active`.

`$todo:start` resolves and persists the host-confirmed owner thread before
starting the dashboard. In the default random-port mode, the successfully bound
port is saved per thread under ignored `.todo` state and reused on later starts.
If that port is occupied, the daemon binds and saves a new free port. Fresh
startup status then supplies the exact URL that `$todo:start` opens again in a
new in-app Browser tab. It does not guess a port, reuse stale status, substitute
Chrome, or inspect the dashboard unless requested. Browser opening, runner
startup, and supervisor binding are reported as separate outcomes.

## Git execution

Each task is assigned a `codex/todo-<numeric-id>-<slug>` branch when it is
created. Before model execution, the runner creates or reuses its isolated
`.todo/worktrees/<task>` checkout and runs the worker there. Workers must not run
mutating Git commands; the runner verifies `HEAD`, stages all task changes, and
creates the task commit.

Delivery is selected per task, with the repository default used when omitted:

| Mode | Result |
| --- | --- |
| `keep` | Remove the clean worktree and keep the committed task branch; remove a no-change branch. |
| `merge` | Commit and preserve the branch like `keep`, enqueue it for the singleton local merge worker, rebase it onto the latest target, then fast-forward and remove the task branch. |
| `pr` | Push the branch and create a pull request with `gh`; this mode must be explicitly requested. |

The preflight checks the exact requested mode, including a clean checked-out
merge target or GitHub remote and authentication for a pull request. A Git
failure preserves recoverable state. Delivery is recorded separately and can be
retried without rerunning the completed model attempt.

### Local merge queue

`merge` implementation workers stop after validation, self-review, and the task
commit. The task then becomes `merge-queued`, its clean worktree is removed, and
its branch is retained. One daemon-owned merge worker, outside the configured
implementation-worker quota, rebases each queued branch onto the current target
and fast-forwards the target, so merge commits and stale-base cherry-picks are
not created. When multiple same-target `merge` tasks were published in one batch,
later siblings wait until every earlier sibling leaves the runnable merge
lifecycle, so faster model completion cannot invert the intended Git order.

Startup and every ordinary poll resume eligible persisted `merge-queued` tasks,
reusing their delivery attempt and completed result without reopening archived
task threads. The published daemon owner retires restart requests addressed to
its predecessor, including requests for a superseded intermediate runtime.
`runtime_update_request_retired` records that recovery. `merge_queue_waiting`
records why queued work cannot start (batch publication, an existing claim,
blockers, earlier batch sibling, busy merge worker, or claim failure), only when
the waiting state changes. A request addressed to the current daemon still
blocks new claims while active work drains.

A textual rebase conflict moves the task to `merge-conflict` without blocking
other queued branches. ToDo unarchives the task's original persistent Codex
thread, raises it by one configured model tier, and starts one out-of-quota
merge-repair turn in the paused rebase worktree. The repair must preserve both
the task functionality and newer target contracts, run focused verification,
and leave Git continuation to the runner. A successful repair re-enters the
queue and must pass a fresh rebase before fast-forward. For pipeline tasks, every
snapshotted shell gate runs again against that final rebased commit under the
merge lock. Failure or tracked-file changes block delivery, retain the worktree,
and save receipts under `.todo/logs/<task>/merge-validation-*`. Retrying a failed
merge reruns these gates; previous validation cannot authorize a new commit. A reported logical
conflict becomes `merge_logical_conflict`, leaves the queue, and retains its
recoverable branch and error evidence.

## Configuration

The default `.todo/config.json` is:

```json
{
  "workers": 4,
  "pollIntervalMs": 2000,
  "configReloadIntervalMs": 5000,
  "dashboardPort": 0,
  "retries": 0,
  "executionBackend": "app-server",
  "gitExclude": [
    ".todo/"
  ],
  "defaultModelProfile": "expert",
  "routingMode": "all-mutations",
  "git": {
    "delivery": "keep",
    "targetBranch": null,
    "remote": "origin"
  }
}
```

`workers` accepts 1–32. Poll and reload intervals accept 250–60000 ms. The
optional `models` array overrides the plugin task-role profiles. When omitted,
the current built-in profiles are used without copying them into the config. Task formation selects the lowest adequate
available profile. Built-in retries follow Mini → fast, standard → medium,
proven → advanced, and fast → medium → advanced → expert → ultra, staying at
ultra after the highest tier is reached. Custom profiles retain array-order
escalation. Retired or unsupported profiles are skipped; if no usable higher
profile exists, retry stops with an update message.
The default `expert` profile uses GPT-6 Astra with `xhigh` reasoning for complex
work; `ultra` uses Astra with `max` reasoning for very complex work. Astra is
OpenAI's most capable model ([model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)).
New repositories omit `models` and inherit the plugin profiles, so a plugin
update changes the effective models automatically. Existing explicit `models`
arrays remain repository overrides; remove that array to inherit the plugin.
Saved tasks retain their profile names. Before each new attempt, the task and
its pipeline steps resolve the current model and reasoning level from those
profiles. Old model IDs in saved tasks do not pin execution to retired models.
An unavailable-model retry keeps the same profile; ordinary model retries retain
the escalation policy above. Active attempts keep the model selected at start.

`dashboardPort: 0` selects a free local port and keeps the successful port for
each host-confirmed Codex thread. An occupied reservation is atomically replaced
after a new listener succeeds. `retries` is a non-negative integer or `-1` for
unlimited retries. `executionBackend` defaults to `app-server`;
`exec` is retained as an explicit legacy fallback. `git.delivery` accepts
`keep` or `merge`; pull
requests are an explicit per-task choice. `git.targetBranch: null` resolves to the
branch active at preflight, and `git.remote` defaults to `origin`. The daemon
hot-reloads valid worker, profile, polling, retry, dashboard, execution, and Git
configuration without interrupting active tasks.

### Model availability and config updates

Seven Codex models are represented by eight task profiles (Astra has
separate complex and very complex roles). The executor's paginated `model/list`
catalog determines availability for the actual account/CLI: the desktop picker
can expose models that a background executor cannot yet use. Legacy model names
remain in the template so their status and replacement are visible; listing
is not a claim of availability. Spark is excluded from profiles, execution, and automatic model discovery.

`task_preflight` returns model diagnostics. Before starting an agent, the runner
resolves each saved profile against the current config (or built-in profiles),
then checks the resulting model and reasoning level. An unsupported
model produces `model_unavailable` without a model turn or silent substitution.
Invalid profile configuration fails closed. Catalogs are cached locally for five
minutes and invalidated when the configured models or executor change.

Use the `model_profiles` MCP tool with `action: inspect` to refresh availability
and preview the complete update: available/deprecated/retired/unsupported models,
unsupported reasoning levels, replacements, removals, and newly discovered
models. Newly discovered models use their executor description and default
reasoning level; review their suitability before assigning work. The preview
preserves supported custom profiles, replaces retired models when the executor
supplies a supported successor, and removes unsupported entries.

After approving the exact preview, call `action: apply` with its `planId`.
A changed config or catalog invalidates the preview. Applying creates a private
backup beside `.todo/config.json` and atomically updates only the profile/default
fields. With `models` omitted, inspect/apply preserves inheritance and does not
materialize a custom model list. Other config fields, task profile names, past
attempt logs, and snapshotted pipeline commands/prompts are preserved. Saved model
IDs are refreshed from the same profiles on the next attempt. If a profile was
removed or its current model is still unsupported, the task reports that exact
problem instead of selecting a different profile. Runtime model catalogs and config
backups are local data and must not be committed.

Advanced local execution fields `codexCommand` and `codexSandbox` are also
supported. The default sandbox is `workspace-write`. A change to the backend or
Codex command takes effect for newly claimed tasks; existing tasks retain their
snapshotted backend and profile name; the model is resolved at the next attempt.

## Repository execution pipelines

When `pipeline` is absent from `.todo/config.json`, ToDo uses the existing
single Codex attempt lifecycle without any behavior change. To apply one
mandatory pipeline to every newly published background task, point the config
at a repository-relative YAML file:

```json
{
  "pipeline": {
    "file": ".codex/todo/pipelines/default.yaml"
  }
}
```

Keep each additional scenario in its own `.yaml` or `.yml` file and change the
configured file for future tasks. At publication, ToDo validates and snapshots
the normalized pipeline under ignored runtime state. Queued and reopened tasks
therefore retain the exact pipeline and explicit model-profile resolutions they
were created with even if the source YAML or config changes later. A configured
file that is missing or invalid fails configuration and preflight instead of
silently falling back. Only an absent `pipeline` section selects the legacy
lifecycle.

The v1 format is deliberately linear. `codex-exec` and `codex-thread` agent
steps must come before all `shell` gates. `codex-exec` starts an independent
structured Codex execution; `codex-thread` creates or continues the task's
persistent app-server thread. Both accept an optional `modelProfile` and a
required `prompt`. Omitting `modelProfile` uses the task's profile. Model IDs and
reasoning levels are resolved from current profiles at attempt start, including
for old pipeline snapshots; pipeline commands and prompts remain immutable.

```yaml
version: 1
name: required-quality
steps:
  - id: inspect
    type: codex-exec
    modelProfile: fast
    prompt: |
      Inspect the bounded task and identify the smallest implementation path.

  - id: implement
    type: codex-thread
    prompt: |
      Implement the task and self-review the resulting diff.

  - id: build
    type: shell
    command: npm run build
    timeoutSeconds: 600

  - id: test
    type: shell
    command: npm test
    timeoutSeconds: 900

repair:
  type: codex-thread
  modelProfile: expert
  maxRounds: 3
  prompt: |
    Repair the failed deterministic validation step without weakening it.
```

Shell commands run in the task worktree through the platform shell. `cwd`
defaults to `.` and may name only a path inside that worktree;
`timeoutSeconds` defaults to 600 and accepts 1–3600. Each execution writes full
stdout, stderr, and a structured receipt under the task attempt logs. On
failure, the runner sends the repair step a bounded receipt containing the
command, exit status, timeout state, log paths, and output tails. A successful
repair restarts every shell gate from the first one, so delivery is possible
only after a complete green pass made after the final agent edit. Exhausting
`maxRounds`, failing the repair step, or omitting `repair` leaves the task
failed with the preserved evidence.

Pipeline tasks can pause a Codex stage for interactive execution. The saved
checkpoint includes the stage, completed executions, repair round, and pipeline
digest. `task_run_finish` returns a successful stage to the runner: remaining
Codex stages and shell gates still run before delivery. An interactive repair
restarts all shell gates. An initially interactive task executes the first Codex
stage in the app; subsequent stages remain runner-owned. Shell commands run
with the same local permissions and environment as the runner; pipeline files
are trusted executable repository policy and should be reviewed like CI
configuration. The bundled parser supports the documented YAML subset:
two-space mappings and sequences, comments, plain or quoted scalars, JSON-style
inline collections, and `|`/`>` block strings. YAML tags, anchors, aliases, and
merge keys are rejected.

See [`examples/pipelines/quality.yaml`](examples/pipelines/quality.yaml) for a
copyable build, test, coverage, and lint pipeline.

## Dashboard and records

The dashboard shows tasks separately from worker state, including the singleton
merge worker, merge-queue and merge-conflict states, dependencies, model and
delivery retries, timing, attempt-local token usage, coverage, errors, and links
to logs. It patches keyed rows and cells in place and appends log text,
so polling does not rebuild unchanged completed tasks or disrupt text selection,
scroll positions, filters, or controls. The default random port is sticky within
its owning Codex thread, but can change after a collision; query
`$todo:dashboard` or `$todo:status` for current status instead of relying on a
stale URL. Prompts, readable transcripts, worker JSONL event logs, results, and
metrics remain in `.todo/` for audit and debugging.

Dependency IDs link to their task Markdown when the referenced task is available.
Canceled lifecycle records are labeled `rejected` in the dashboard. Field filters
accept OR values as either `status:completed|rejected` or
`status:(completed|rejected)`; clicking multiple status or profile values builds
the same `|` expression.

The dashboard is local operational tooling, not an account-quota display. Usage
schema v2 is stored separately for each attempt. It contains numeric turn totals,
including cached-input tokens reported by `app-server`, observable tool
call counts, and payload byte counts. Coverage is `full`, `partial`, or `none`;
the dashboard marks partial totals with `*`. Raw model-request telemetry is held
only long enough to reduce it to these numeric statistics and is never persisted.
Existing `promptBytes`, usage schema v2, and the attempt ledger expose the actual
cost and retry count of the full contour. ToDo does not claim token savings
without a comparable measured baseline. `app-server` currently exposes
turn-level usage rather than transport-request retry counts, so request-level
telemetry is marked unavailable instead of being inferred.

Model attempts and Git delivery attempts are separate immutable ledger entries.
Each records its UUID, ordinal, retry trigger and predecessor, classified status,
timing, and error kind; model attempts also link their usage record. Automatic
retry is fail-closed: only a known transient failure is retried in the same model
or delivery phase. Unknown, authentication, permission, cancellation, preflight,
and interactive failures wait for an explicit fix or manual action.

## Runtime updates

The daemon publishes the version and fingerprint of the installed runtime. A
hook or MCP call that sees changed manifest, MCP, hook, script, or skill content
requests a safe restart. The old daemon stops claiming new tasks, lets active
tasks finish, and exits; an idle daemon stops immediately. The next hook or MCP
boundary starts the new runtime and loads the current repository configuration.
The handoff also recognizes a verified previous ToDo cache or local package,
including an already-evicted cache directory, without trusting an unrelated PID.

Already loaded host skills and hooks cannot be replaced inside an existing Codex
session. Start a new session after updating the plugin so those definitions and
the installed MCP process also come from the new package. An incomplete runtime
or invalid configuration reports `update-blocked` instead of interrupting work.

## Safety and limitations

- ToDo executes Codex with the current user's local permissions and configured
  sandbox; it is workflow coordination, not isolation.
- The local dashboard can expose repository context, prompts, logs, and errors.
- Do not commit `.todo/` runtime state or place secrets in task descriptions.
- Stopping the runner does not interrupt active tasks unless explicitly forced.
- A configured supervisor needs one terminal scheduled run to observe an empty
  queue before it can pause; it performs no recurring runs after that pause.
- `$todo:start` cannot move supervision to its current chat if deletion of the
  previously bound host heartbeat fails; runner startup is reported separately.
- Existing supervisor bindings created before `targetThreadId` persistence must
  be rebound once with `$todo:start`; lifecycle actions refuse to guess a chat.
- The runner leaves the last synchronized `-> ToDo (...)` title in place after
  it stops; it cannot publish later task-state changes while it is offline.
- Opening the dashboard from `$todo:start` requires the bundled in-app Browser;
  Browser failure does not roll back an otherwise successful runner start.
- Archiving a Codex thread hides it from the active thread list but does not
  securely erase its persisted Codex rollout record.
- `app-server` is still an experimental Codex CLI surface; protocol failures are
  recorded as transient task failures and retried in the saved thread.
- Preflight validates availability at creation time; it cannot guarantee that a
  connector or remote service stays available throughout execution.
- Task workers run in isolated worktrees, but they still use the current user's
  filesystem and process permissions.
- Worker-created follow-up tasks require explicit user authorization on the
  claimed parent; audits, findings, or complexity never imply that permission.
- Merge-conflict repair reuses the original persistent app-server thread when it
  exists. With the legacy `exec` backend, the runner falls back to a one-shot
  repair turn in the paused rebase worktree instead of inventing a new thread.
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

Shell-step timeouts and runner shutdown terminate the whole process group, wait
for a two-second grace period, then kill remaining descendants before another
step or repair can start. Windows uses `taskkill /T /F`. Log tails use bounded
byte reads; dashboard log previews show the last 256 KiB with a truncation notice,
while full logs remain on disk.
