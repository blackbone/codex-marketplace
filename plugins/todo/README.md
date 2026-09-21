# ToDo

ToDo gives Codex a durable, repository-local task queue with automatic atomic
decomposition, Ponytail full task formation and execution, connector and Git
preflight, atomic DAG publication, optional repository-defined execution
pipelines, isolated worktree delivery by default, optional single-branch
execution, persistent per-task Codex threads,
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

Windows startup requires Node.js 22+ (`node`) and Git on the Codex process's
`PATH`, plus Windows PowerShell with `Get-CimInstance` for process verification.
The MCP entry point runs directly with Node; Windows hooks resolve `PLUGIN_ROOT`
without Unix shell expansion. Background startup and inspection commands hide
their console windows. Stop requests are checked by PID and token and consumed
by the daemon, so Windows shutdown runs cleanup without Unix signals. Updating
the plugin requires a new Codex session and review of changed hook definitions.
Very old runtimes without cooperative restart support need a manual stop before
upgrading on Windows.

Periodic task/claim polling reads files and checks PIDs through Node.js. Resolving
the shared execution registry reads `.git` and `commondir` directly, including
linked worktrees, without spawning Git on each poll.

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
- Examples: docs:init writing .semantic-search.json and indexing docs/ is direct; configuring another Codex plugin or MCP connection is direct; editing source code or docs/ through a plugin requires ToDo; changing a build pipeline or deployment under the label "tooling setup" requires ToDo; connecting a documentation search tool and then rewriting project documentation splits into direct setup and a ToDo documentation task.

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

`$todo:supervise` inspects runner health and failed tasks on request. Queue
execution and retries belong to the detached runner; no desktop host automation
or chat binding is required.

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
| `$todo:start` | Start the runner and return its dashboard URL. |
| `$todo:stop` | Stop the runner. |
| `$todo:supervise` | Inspect runner health and failed tasks on request. |
| `$todo:status`, `$todo:list`, `$todo:get` | Inspect tasks, workers, and results. |
| `$todo:dashboard`, `$todo:workers` | Show the dashboard or worker state. |
| `$todo:update`, `$todo:retry`, `$todo:reopen`, `$todo:cancel` | Manage an unclaimed or closed task. |
| `$todo:artifact-add` | Attach files, images, URLs, code, or text context. |

The plugin exposes 23 corresponding MCP tools for preflight, atomic batch
publication, activation, task lifecycle, interactive claims, runner control,
artifacts, supervisor binding, status, and workers. Skills are the supported
user-facing entry points; direct tool calls are agent internals.

## Human input through app-server

The dashboard task chat shows live messages and local execution history.
**Send answer** responds to a live `item/tool/requestUserInput` request on its
original app-server turn. The answer must match the question and claim.
**Steer** targets the exact active turn. Drafts, expanded tools, and scroll
position survive polling; a changed question requires reviewing the draft.

When a task is waiting after its run ended, **Send answer** saves the response
and queues the same task for the runner. **Continue task** does the same for an
inactive task. The runner unarchives and resumes its stored thread, then sends
a new turn through app-server. Answers do not escalate the selected model.
Repeated submissions and stale questions are rejected. A pipeline resumes the
paused implementation or repair stage with the answer, then runs its required
shell checks. An answer is never treated as a passed stage or permission to
skip validation. The original task worktree and runner-owned Git delivery remain
in use.

Worker session management uses app-server JSON-RPC. Dashboard counter titles use
the bundled `codex-app-tools` MCP's `set_thread_title` when the host provides its
desktop connection and Node runtime. This notifies the application immediately;
the adapter only renames the bound dashboard task and never navigates, starts
model turns, or creates host automations. The dashboard has no application-open
button. Worker sessions are named and archived through app-server. An unavailable
runtime capability remains an explicit waiting-input condition; answering does
not grant tools, permissions, or access that the worker lacks.

The popup reads up to 300 recent messages from bounded local log tails; full
older evidence remains in **Logs**. Dashboard writes require the exact loopback
Host/Origin, JSON, and a custom header. Replies retain the saved question identity
and live turn ownership checks.

Manual `$todo:run` execution remains available in the invoking executor. Its
claims require the exact executor-supplied thread and turn; a different turn
cannot finish a claim. `task_run_wait` persists a question and releases the claim.
The Stop hook releases only an exact matching turn. No desktop transport is used.

Blockers retain their existing semantics: canceling a blocker makes dependent
tasks eligible to recheck their preconditions. This is not a tree cancellation.
For a live preview, configure merge delivery to the working branch (for example
`main`); Vite, backend watchers, or the Unity editor own rebuild/restart.

## Runner lifecycle

`$todo:start` starts the detached runner and returns its current dashboard URL.
`$todo:stop` leaves active tasks alone unless interruption is explicitly requested.
`$todo:supervise` performs a single health and failure inspection; it does not
schedule host heartbeats. `runner_start` binds the dashboard to the executor's
thread metadata when available, or an explicitly supplied `dashboardThreadId`.
Existing dashboard ownership takes precedence over legacy supervisor metadata.
The plugin does not change previously configured host automations.

Worker threads are archived after an attempt and unarchived before resuming.
Closed-task archive reconciliation and task names use the same app-server
connection as execution. Runtime updates drain active tasks before replacing
the runner, preserving task worktrees, logs, and waiting questions.

## Git execution

Each task is assigned a `codex/todo-<numeric-id>-<slug>` branch when it is
created. Before model execution, the runner creates or reuses its isolated
`.todo/worktrees/<task>` checkout and runs the worker there. Workers must not run
mutating Git commands; the runner verifies `HEAD`, stages all task changes, and
creates the task commit.

Delivery is selected per task, with the repository default used when omitted:

| Mode | Result |
| --- | --- |
| `keep` | Remove the clean worktree and keep the committed task branch; remove a no-change branch unless `git.push` is enabled. |
| `merge` | Commit and preserve the branch like `keep`, enqueue it for the singleton local merge worker, rebase it onto the latest target, then fast-forward and remove the task branch. |
| `pr` | Push the branch and create a pull request with `gh`; this mode must be explicitly requested. |

`git.push` controls remote publication independently of `keep` / `merge`:

| Setting | `keep` | `merge` |
| --- | --- | --- |
| `false` (default) | Keep the result locally. | Update the local target branch. |
| `true` | Push the task branch to `git.remote`. | Push the target branch to `git.remote` after successful validation and fast-forward. |

Push uses an explicit commit and branch ref without force or automatic tag
publication. Pushing a target branch also publishes its earlier local commits.
The setting and remote are captured at task creation; configuration changes
affect new tasks. Existing tasks without the setting retain local delivery,
including retries and reopening. `pr` still requires a push regardless of this
setting. With `git.push: true`, delivery completes only after Git accepts the
push. A failed push preserves the local commit, task branch and worktree; fix
remote access or divergence, then use `task_retry` to resume delivery without
another model attempt. A merge that already succeeded locally is not rolled
back. Preflight checks that the push remote is configured; it does not prove
remote write access.

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

Textual rebase conflicts and mandatory gate failures after a clean or repaired
rebase use the same `merge-conflict` repair lifecycle. ToDo resumes the original
persistent Codex thread, existing task branch and worktree; it never reruns the
initial implementation. The bounded prompt includes original requirements, the
failed gate and command, task/target HEAD, log excerpts and receipt paths under
`.todo/logs/<task>/merge-validation-*`. Each repair raises the configured model
tier and records a separate `merge_conflict` or `merge_validation` model attempt;
completed implementation attempts remain immutable.

The task claim remains exclusive across the merge worker, repair worker and
interactive execution. `task_run_start` can resume a stopped repair only in the
original Codex thread and returns `mergeRepair`; `task_run_finish` hands the result
back to the queue. Dashboard continuation and `task_retry` also recover existing
`merge-failed` / `pipeline_validation` tasks without editing runtime files.
The queue commits repairs or continues the paused rebase, rebases against current
main and reruns every snapshotted shell gate. Receipts cannot authorize a changed
HEAD or target; a target change during validation stops delivery until a fresh
rebase and validation. Model success alone never marks delivery complete.

Semantic repairs use the pipeline's `repair.maxRounds` when configured;
otherwise they allow one repair plus `retries`. Conflict repairs allow one plus
`retries`. Unlimited transient retries (`-1`) do not remove these integration
bounds (one repair without an explicit pipeline limit). Counts persist across
runner restarts and target changes. At exhaustion, code, the exact error and
repair context remain available. An explicit `task_retry`, dashboard continuation
or `task_run_start` grants one additional repair if needed, without resetting
counts or history. Delivery is checkpointed before branch/worktree cleanup, so a
runner crash resumes completion without another delivery attempt. Failed or
interrupted repairs retain all work, including a
paused rebase; the runner does not abort it and discard the executor's changes.

## Single-branch execution

Set `git.executionMode` to `"single-branch"` in the repository's
`.todo/config.json`. Omission (or `"worktree"`) preserves the existing isolated
worktree workflow. See [the configuration example](examples/single-branch.config.json).

```json
{
  "git": {
    "executionMode": "single-branch",
    "delivery": "keep",
    "push": false
  }
}
```

This policy covers **every task in the repository**, including retries, pipeline
repair, interactive execution and delivery-only continuation. Effective worker
capacity is one even if `workers` is larger. Each started task records its mode,
current branch and absolute working-copy path. Config reloads affect unstarted
tasks; running tasks and their retries keep their recorded mode and copy. The
runner never changes branches or creates task, retry, validation or preflight
worktrees in this mode. It commits directly to the current branch, without the
merge queue. `git.targetBranch` is ignored; `keep` and `merge` both mean local
current-branch completion here. PR delivery and `git.push: true` are rejected
explicitly. Detached HEAD and active merge/rebase operations must be resolved
before execution.

Registered, initialized Git submodules are included in workspace snapshots, including
HEAD, index entries and dirty files even when Git is configured to hide submodule
changes. Report reviewed files as parent-relative paths such as `server/src/api.cs`.
The runner uses a private index in each repository, commits the deepest submodules
first, then commits their gitlinks in the parent. Initialized submodules may have
a detached HEAD; the parent still requires a local branch. Uninitialized modules,
unregistered nested repositories and directory ownership are rejected for delivery.

Each repository commit has a durable tree/base/message journal. A retry recognizes
an already published submodule commit and finishes the remaining parent delivery.
Concurrent changes invalidate review without discarding commits or unrelated
staging. Old saved nested `ownedFiles` remain recoverable but require fresh review
because they lack submodule HEAD receipts. A checkpoint error releases the finished
worker claim while retaining the reservation and an explicit recovery requirement.
These are local commits only; this mode does not push submodules or the parent.

The existing task claim and token still own execution. A second, repository-wide
reservation in the common Git directory prevents concurrent executors from
other threads, processes or linked checkouts. It covers implementation, all
pipeline/self-review stages, shell gates, commit and result recording. Switching
configuration cannot bypass an unfinished reservation or relocate it. Finish
old worktree attempts before starting new single-branch work. All participating
runners must use a plugin version supporting this policy; a legacy running
claim is detected and must drain before entry.

The worker, app-server thread and every pipeline step use the same copy.
Pipeline `cwd` remains relative and symlinks escaping the copy are rejected.
Unity workers must resolve the Unity project inside that copy and verify the
Editor reports that exact project path before using Editor commands. An Editor
connected to another project is a blocking mismatch, not a reason to redirect
source edits. Shell commands must likewise use project-relative paths, rather
than an absolute path to another clone. The runner keeps the working directory,
ignored Unity `Library` and other local caches between tasks; configure cache
ignore rules before execution.

**Dirty working copies:** tasks use the current on-disk code, including existing
staged, unstaged and untracked changes. Dirty files, overlaps with pre-existing
edits and unrelated edits appearing during execution do not block completion.
Agents preserve unrelated work and return `changedFiles`, the exact
repository-relative files they intentionally changed and reviewed (including
deleted paths), or `[]`. In interactive execution pass this field to `task_run_finish` and obey
`executionInstructions` returned by `task_run_start`. Pipeline agent steps
accumulate reviewed file receipts. A generator that modifies source files needs
a later review step reporting their final content. The runner checks content
fingerprints and commits only the listed files through a private index,
preserving the user's index for unrelated paths. Each listed file is committed
with its **full current content**, including existing edits in that file: the
runner never substitutes an older HEAD or staged version. For example, when a
task edits an already modified API file, its commit contains the latest API plus
the task's edits. This is file-level selection, not automatic separation of
authors' hunks. Unlisted changes stay in the working copy/index and do not block
completion or the next task after successful completion. Agents must report all
intentional task changes; the runner does not infer authorship from dirty status.
It never stashes, cleans, resets working files, deletes the working copy or
removes caches. Concurrent edits to reviewed files or commits on the same branch
invalidate the old review and automatically continue the same task from the
current code. The runner repeats review and all configured pipeline gates before
committing; it does not record this as a failed delivery or escalate the model.
Unlisted dirty files alone do not trigger another review. Commit publication uses
an atomic expected-HEAD check, so a concurrent commit cannot be overwritten.
Normal Git commit hooks still run in the same working directory, using a private
index and temporary detached Git metadata (no new branch, checkout or worktree).
Hooks must not depend on a symbolic HEAD; the repository branch itself never switches.

**Recovery:** ordinary failures and pauses preserve a checkpoint and reserve the
copy for the same task. Existing dependency checks, retry/model escalation,
pipeline continuation, mandatory checks and attempt/delivery accounting still
apply. Edits made while a task is safely paused are accepted on resume. After a crash, inspect `git status`, the staged
and unstaged diffs, and the task error. Confirm the previous executor has stopped,
then call `task_retry` for that same task and continue through the normal runner
or `task_run_start`. An explicit retry acknowledges that review; it neither
cleans files nor commits them. The resumed agent must attribute the retained
changes through `changedFiles`. Live/uncertain executor ownership blocks recovery;
known child PIDs and shell process groups are fenced even if the daemon exited.
Native interactive claims still require the existing exact-turn reconciliation.
Never delete task locks or the common-directory reservation to skip recovery.
A short registry-lock recovery interrupted by another crash reports the exact
lock requiring operator inspection and remains closed to new executors.

A commit journal records the expected tree and a unique commit marker before
commit. A crash after committing resumes only that matching commit, without a
second implementation run or duplicate commit. Completed history can release an
orphaned reservation after its process exits. Cancellation is allowed only if
the copy still matches its original baseline; otherwise finish/recover the
retained work first. An attribution failure during finalization can be corrected
by reviewing the diff and returning a corrected `changedFiles` list from an
interactive delivery-only continuation.

**Manual commits during an unfinished task:** the next execution or finalization
automatically adopts the current HEAD on the same branch and schedules a fresh
review, retaining the task, model settings and implementation. This is recorded
as a `workspace_refresh` attempt and an automatic receipt in `git.headRecoveries`.
A ready pipeline checkpoint is discarded so checks run against current code.
You can still explicitly acknowledge a reviewed HEAD for a stopped task through
the supported recovery operation:

```text
task_retry(repoPath, id, acceptCurrentHead: "<full SHA from git rev-parse HEAD>")
```

This accepts only the exact current commit in the task's original working copy
and branch, for an already started single-branch task with no active or uncertain
executor. A stale SHA, worktree mode, active merge/rebase, waiting input or a
delivered task is rejected. It never switches branches, changes files/index,
creates commits, or edits caches. Manual commits (including amendments) stay as-is.
The task records old/new HEADs and recovery time in `git.headRecoveries`; existing
attempt history, model settings and the task/thread identity remain intact.

Recovery invalidates old file-review, result, commit and pipeline checkpoints.
The next run inspects the retained implementation and repeats normal review and
configured pipeline checks before completion, recorded as a `head_recovery`
attempt. It must not recreate the implementation from scratch. Repeating the same
accepted SHA is idempotent. Interrupted acceptance can be retried through this
same operation; do not edit task metadata or reservation files manually.

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
    "executionMode": "worktree",
    "delivery": "keep",
    "targetBranch": null,
    "remote": "origin",
    "push": false
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
unlimited retries. `executionBackend` uses `app-server`;
legacy `exec` settings are migrated to app-server when the next attempt starts. `git.delivery` accepts
`keep` or `merge`; pull
requests are an explicit per-task choice. `git.targetBranch: null` resolves to the
branch active at preflight, and `git.remote` defaults to `origin`. The daemon
hot-reloads valid worker, profile, polling, retry, dashboard, execution, and Git
configuration without interrupting active tasks.

### Model availability and config updates

Four current Codex models serve eight task profiles. Profile names remain stable
for existing tasks; built-in profiles use GPT-5.6 or newer.

| Profile | Model | Reasoning |
| --- | --- | --- |
| `mini` | `gpt-5.6-luna` | `low` |
| `fast` | `gpt-5.6-luna` | `medium` |
| `standard` | `gpt-5.6-terra` | `low` |
| `medium` | `gpt-5.6-terra` | `medium` |
| `proven` | `gpt-5.6-sol` | `medium` |
| `advanced` | `gpt-5.6-sol` | `high` |
| `expert` | `gpt-6-astra` | `xhigh` |
| `ultra` | `gpt-6-astra` | `max` |

The executor's paginated `model/list` catalog determines availability for the
actual account/CLI: the desktop picker can expose models that a background
executor cannot yet use. Spark is excluded from profiles, execution, and
automatic model discovery.

`task_preflight` returns model diagnostics. Before starting an agent, the runner
resolves each saved profile against the current config (or built-in profiles),
then checks the resulting model and reasoning level. An unsupported
model produces `model_unavailable` without a model turn or silent substitution.
Invalid profile configuration fails closed. Catalogs are cached locally for five
minutes and invalidated when the configured models or executor change.

Use the `model_profiles` MCP tool with `action: inspect` to refresh availability
and preview the complete update: available/deprecated/retired/unsupported models,
unsupported reasoning levels, replacements, removals, and newly discovered
models. Automatic discovery skips GPT generations older than 5.6. Newly
discovered models use their executor description and default reasoning level; review their suitability before assigning work. The preview
migrates known old built-in mappings (`mini`, `standard`, `proven`, `expert`,
`ultra`) to their current roles when available, preserves supported custom
profiles and custom efforts on current models, replaces retired models when the
executor supplies a supported successor, and removes unsupported entries.

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
steps must come before all `shell` gates. `codex-thread` creates or continues the task's
persistent app-server thread. Legacy `codex-exec` steps now use that same
app-server transport without changing the stored pipeline snapshot. Both accept an optional `modelProfile` and a
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

After `task_run_finish(status: "completed")`, a ready checkpoint continues the
accepted implementation without allocating a model retry. Continuation receipts
live in `.todo/logs/<task>/continuation-<run-id>/` and link to the completed
attempt; shell-only runs do not increase model attempt counts. The attempt ledger
still rejects retries of completed implementations. A failed gate or delivery
keeps its concrete error; a secondary ledger-recording failure is retained as
`error.attemptLedgerError` without replacing the original error or stopping the daemon.

To recover a queued task stranded by an older daemon at this checkpoint, install
the updated plugin, open a new Codex task to load its MCP tools, and call
`runner_start` with the repository's absolute `repoPath`. Use `runner_status` to
verify the new runtime; if startup reports `restart-pending`, wait for the safe
restart and call `runner_start` again. If the task has a recorded failure, resolve
that error and call `task_retry` before starting the runner. Continuation retries
preserve the checkpoint, model profile, worktree, and completed model attempts;
all required shell and delivery checks still apply. Do not call `task_run_start`
to repeat an already accepted implementation or edit `.todo` statuses manually.

See [`examples/pipelines/quality.yaml`](examples/pipelines/quality.yaml) for a
copyable build, test, coverage, and lint pipeline.

## Dashboard and records

The dashboard shows tasks separately from worker state, including the singleton
merge worker, merge-queue and merge-conflict states, dependencies, model and
delivery retries, timing, cumulative task token usage, coverage, errors, and links
to logs. It patches keyed rows and cells in place and appends log text,
so polling does not rebuild unchanged completed tasks or disrupt text selection,
scroll positions, filters, or controls. The default random port is sticky within
its owning Codex thread, but can change after a collision; query
`$todo:dashboard` or `$todo:status` for current status instead of relying on a
stale URL. Prompts, readable transcripts, worker JSONL event logs, results, and
metrics remain in `.todo/` for audit and debugging.

The owning task's `-> ToDo (…r / …q / …f / …w)` counters are recomputed on task
and claim file changes, with a 25 ms event coalescing window independent of the
worker polling interval. Updates are serialized and changes during an in-flight
rename trigger another computation. Failed title updates retry after five seconds.
`r` counts running tasks; `q` includes queued, blocked, staging, merge-queued and
merge-conflict tasks; `f` counts failures; `w` appears while input is needed.
Without a desktop connection, app-server still stores the title, but immediate
refresh in the desktop UI is not guaranteed. `supervisorThreadTitle.transport`
in runner state identifies the successful path; connection failures remain errors.

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
without a comparable measured baseline. App-server accounting uses differences
between cumulative thread counters, with a saved baseline before each turn.
Repeated notifications contribute zero; repair turns exclude earlier turns;
failed and interrupted steps retain their measured usage. Task totals include
all model attempts and repair steps, including retries. Counter resets or an
unproven starting baseline reduce coverage to `partial`. Transport retry counts
and usage not reported by Codex remain unavailable rather than being inferred.

Historical app-server totals are recalculated from retained attempt/step logs
when task status or the dashboard is read. This is a cached, read-only projection:
original history, usage files, and ledger receipts remain unchanged as audit
evidence. Missing logs reduce coverage; no token count is fabricated. New runs
carry `tokenAccountingVersion: 2` in their metrics and do not need this recovery.

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
- The runner leaves the last synchronized `-> ToDo (...)` title in place after
  it stops; it cannot publish later task-state changes while it is offline.
- Desktop title updates require the host-provided `CODEX_APP_TOOLS_PIPE_PATH`
  and bundled MCP/Node runtime. Native peer authorization is left intact; rejected
  connections are reported and retried, never bypassed. Restart the runner from
  a new Codex task if its inherited desktop connection becomes stale after an app restart.
- Opening the dashboard from `$todo:start` requires the bundled in-app Browser;
  Browser failure does not roll back an otherwise successful runner start.
- Archiving a Codex thread hides it from the active thread list but does not
  securely erase its persisted Codex rollout record.
- `app-server` is still an experimental Codex CLI surface; protocol failures are
  recorded as transient task failures and retried in the saved thread.
- Preflight validates availability at creation time; it cannot guarantee that a
  connector or remote service stays available throughout execution.
- Task workers use isolated worktrees by default (or the shared current copy in
  single-branch mode), but they still use the current user's
  filesystem and process permissions.
- Worker-created follow-up tasks require explicit user authorization on the
  claimed parent; audits, findings, or complexity never imply that permission.
- Merge-conflict repair reuses the original persistent app-server thread when it
  exists, including tasks created with legacy `exec` settings.
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
