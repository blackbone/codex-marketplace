---
name: init
description: Set up the official Unity Pipeline package in the Unity project belonging to the current task. Use when the user asks to initialize or connect a Unity project for Editor actions.
---

# Initialize Unity

In a repository initialized with ToDo, Unity setup also requires
`git.executionMode: "single-branch"` in `.todo/config.json`. The wrapper blocks
installation in worktree mode (including an omitted mode). Report its `TODO_*`
error and require single-branch mode explicitly; do not bypass it with a direct
CLI call, change the mode automatically, or move an already running task.

Use the absolute current task folder as `--cwd`. Resolve `<PLUGIN_ROOT>` as two
directories above this skill folder, using this skill's supplied absolute path.

```bash
node "<PLUGIN_ROOT>/scripts/cli.mjs" init --cwd "<task-folder>"
```

If several projects are found, ask which one to initialize and add
`--project "<absolute-unity-root>"`. Do not select a candidate on the user's behalf.

This installs `com.unity.pipeline` through the official CLI into the selected
project's `Packages/manifest.json`. Unity subsequently resolves packages and may
update its package lock. A request to initialize authorizes this setup; state
the change and proceed. Existing dependencies and an existing Pipeline version
are preserved. This command does not upgrade or install Unity itself.

After successful setup, call the wrapper's `open` operation once if opening the
project is part of the request. Report `pipeline_installed` or `pipeline_present`
separately from Editor readiness. Do not wait for package import, compilation,
or Pipeline startup and do not repeatedly check status. The next requested
Editor action waits for readiness, compilation and import completion itself.

Requirements: Node.js 22+, official `unity` CLI on PATH (or `UNITY_CLI` pointing
to its executable), and Unity 6+. If missing, report the prerequisite. Do not
silently install/upgrade the CLI or Editor or enable privileged eval access.

An installed package with an unavailable connection is not a reason to reinstall.
Use `doctor` for an explicit diagnosis and follow `$unity:editor`'s guarded recovery
procedure. Do not open an Editor already identified for the target project. A missing
connection descriptor does not establish package absence or a compilation failure.
