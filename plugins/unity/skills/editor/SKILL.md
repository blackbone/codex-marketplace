---
name: editor
description: Work inside the current Unity Editor through the official Unity CLI and Pipeline package. Use for scenes, objects, assets, play mode, live C# or other Editor actions, and opening or checking the current Unity project. Source-only coding does not need a live connection.
---

# Unity Editor

Unity commands require ToDo single-branch mode in repositories initialized with
ToDo (`.todo/config.json`). The wrapper enforces `git.executionMode: "single-branch"`
before opening the Editor, probing Pipeline, discovering or executing commands.
Missing mode means worktree and is incompatible. On `TODO_SINGLE_BRANCH_REQUIRED`,
stop and explicitly require this setting in the reported config file. Do not
bypass the guard with direct Unity CLI, another integration, or another checkout.
Do not change the mode automatically or migrate a running task. A task already
in a worktree must finish or stop there; use a new single-branch task for Unity.
Unreadable config and an inherited worktree also block commands. Repositories
without ToDo keep the usual workflow. Source-only work needs no Editor commands.

The session hook recognizes the task's Unity project and opens or reuses its
Editor. It performs local descriptor/process diagnosis without a network readiness probe. Use the bundled wrapper for
Editor operations; it waits for readiness, compilation and import completion before dispatch, and pins the target.

`<PLUGIN_ROOT>` is two directories above this skill folder. Expand it to an
absolute path from this skill's supplied location; do not depend on a shell
environment variable or change directory to the plugin cache.

Pass the absolute current task directory as `--cwd`. If the wrapper returns
multiple project candidates, ask the user to choose and add `--project` with that
exact absolute Unity root to subsequent calls. Never choose the first candidate
or redirect a worktree to its original checkout.

## Connect and discover

```bash
node "<PLUGIN_ROOT>/scripts/cli.mjs" status --cwd "<task-folder>"
node "<PLUGIN_ROOT>/scripts/cli.mjs" open --cwd "<task-folder>"
node "<PLUGIN_ROOT>/scripts/cli.mjs" list --cwd "<task-folder>" --query "<intent>"
node "<PLUGIN_ROOT>/scripts/cli.mjs" list --cwd "<task-folder>" --query "<selected-command>" --detail full
```

Use `open` when the user requests opening/reopening Unity or after they choose a
project that the hook could not select. `launch_requested` only means a launch
was submitted. `doctor` is for immediate diagnosis; `status` waits for readiness; `list` and `run` already perform their
own readiness check, so they do not need a preceding status call.

Discover relevant commands and then their argument contracts from this project's
Pipeline. The compact list is limited to 20 entries; narrow the query when needed.
Use registered commands first, and `eval_file` only when the task needs C# and
the connected Editor advertises it. Do not assume commands or parameters from a
different project's package version.

## Execute

Write a JSON request file under `<project>/Temp/CodexUnity/` and pass its absolute
path to `run`. Use a unique filename for concurrent tasks. The request contains
the discovered command and its CLI arguments as strings, for example:

```json
{"command":"get_scene_hierarchy","args":[],"timeoutSeconds":30}
```

```bash
node "<PLUGIN_ROOT>/scripts/cli.mjs" run --cwd "<task-folder>" --input "<absolute-request.json>"
```

Use the actual discovered contract; the example command may not be available.
For `eval_file`, write C# into the same Temp directory and pass the absolute file
path as the command argument. Never put scratch C# under Assets, where Unity
would import it. Supply paths/arguments through the request file, not interpolated
shell code. Target overrides, runtime Players and detached jobs are excluded.

Check `ok`, `outcome`, the process exit code and the nested command result. A dispatched
mutation with an error or timeout has an uncertain outcome: report it, never
resend it automatically. Verify successful mutations with the smallest relevant
read-back command. Follow the target repository's existing change workflow.

## Diagnose and recover explicitly

`doctor` returns one bounded read-only diagnosis; `status`, `list` and `run` wait for readiness by default. Do not run it before
`list`/`run`, which already wait before sending their command. Read `reason`, `facts` and `nextAction`;
`state: pipeline_unavailable` does not mean Editor is closed. Missing/invalid/stale
or mismatched descriptor, authentication, transport and protocol failures are
separate reasons. Do not infer compilation or Safe Mode from old logs. Unknown
process ownership blocks opening and dispatch even if a matching Editor is present.

A running Editor with `descriptor_missing` must not be opened again. The official
CLI has no Start/Stop Server command. If explicit connection recovery is appropriate:

```bash
node "<PLUGIN_ROOT>/scripts/cli.mjs" recover --cwd "<task-folder>" --phase begin
```

This claims a shared operation lease and returns an ID plus exact UI instructions
only for eligible failures. Keep the lease across the UI operation. Confirm the
project and PID in UI and establish that no other client has an active command.
If external quiescence cannot be established, stop with the lease pending.
In **Window → Pipeline**, choose **Start Server** if enabled; if already running,
deliberately **Stop Server → Start Server**. Never cycle a server automatically,
restart/close an Editor, clean Library/Temp, fake a descriptor, copy a token or
reinstall the package blindly. Never use eval through a broken connection to fix it.

After that distinct recovery action, verify exactly once:

```bash
node "<PLUGIN_ROOT>/scripts/cli.mjs" recover --cwd "<task-folder>" --phase finish --recovery-id "<returned-id>"
```

`recovery: verified` requires matching project/PID and CLI readiness. If not verified,
report the current reason; do not loop. Abandoning the procedure requires explicit
`recover --phase cancel --recovery-id <id>`. A lease coordinates this plugin only;
external UI/CLI clients still require deliberate coordination. `requiresInteractive`
means a specific returned UI step, never merely STATUS_NO_INSTANCES.

`outcome` distinguishes `not_sent`, `succeeded`, `rejected`, `unknown`. CLI exit zero
is insufficient: the wrapper checks nested Pipeline success. Never replay an unknown
mutation. Its operation lease is retained; doctor shows the ID. The owning task must
reconcile possible side effects before explicitly cancelling it. A crashed owner is
not auto-unlocked and a live command owner cannot be cancelled. Use a deliberate UI
inspection if read-back commands are blocked by this lease. Do not remove lock files.

- `editor_closed`: explicit open for the exact project.
- `launch_requested` / `launching`: do not open again; the requested wrapper call waits within its deadline.
- `launch_stale`: explicit open can recover a dead launch lease after 30 seconds.
- `pipeline_missing`: init only for requested installation.
- `compiling`, `domain_reload`, `settling`: the wrapper waits inside this call, then continues.
- `blocked_by_dialog`: inspect the confirmed modal; do not guess a button.
- `protocol_incompatible` / `cli_missing`: resolve the prerequisite explicitly.
- `editor_unidentified` / `multiple_editors`: establish ownership; never kill users' processes.

## ToDo worker execution

Keep the same wrapper tool call alive while it waits. If the shell tool returns a
running session ID, continue waiting for **that session**; do not report a failed
ToDo attempt or start another command just because the first call is still running.
Allow at least readiness timeout + command timeout + 30 seconds for the surrounding
shell execution. The default readiness limit is 600 seconds, overridable with
`--wait-seconds <0..3600>` or `UNITY_READY_TIMEOUT_SECONDS`; zero makes one attempt.
This is separate from the command's JSON `timeoutSeconds` (1..120 seconds).

Only process/connection checks and the known read-only `editor_status` probe are
repeated. Both `compiling` and `domainReloadInProgress` (Pipeline's name for Unity
`isUpdating`, including asset import) must be false. A live command from another
plugin caller is waited out within the same deadline. Recovery/unknown-outcome
leases are never automatically released. A pending call is cancellable. No daemon
queue, task restart, scheduled wakeup or replay of a dispatched operation is used.

`readiness_timeout` means that the requested operation was not sent; preserve the
implementation and report its last observed reason separately from code correctness.
`process_inspection_denied` with EPERM/EACCES is a worker permission problem, not
compilation. Waiting cannot fix it. Report the exact required permission change;
do not change sandbox policy without authorization or bypass it via another tool.
In ToDo, `codexSandbox` can override the app's global setting; check the actual worker
configuration. Do not ask to open an Editor already detected for this project.

Source-only work can continue independently. See README for diagnostic evidence
and the still-unestablished root cause of the historical missing descriptor.
