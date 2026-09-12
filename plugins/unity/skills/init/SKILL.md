---
name: init
description: Install or update the official Unity Pipeline package to the latest registry version in the current task's Unity project. Use when the user asks to initialize, connect or upgrade Pipeline for Editor actions.
---

# Initialize Unity

For ordinary UPM dependencies, upgrades or removals, use [the packages skill](../packages/SKILL.md).
This skill installs or updates the Pipeline connection package.

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

This selects the latest registry version of `com.unity.pipeline` through the official
CLI: `pipeline install` when missing, `pipeline upgrade` when already declared.
The CLI resolves the version at call time; there is no bundled version pin or
custom registry/version comparator. An already-current package is left as-is.
A request to initialize or upgrade Pipeline authorizes this setup; state the change
and proceed. Other dependencies are preserved. The manifest changes first; Unity
subsequently resolves packages and may update its lock. This does not upgrade the
CLI or Unity Editor. A requested exact version/custom package source is a separate
package-management action; do not use latest-mode init to satisfy a pin request.

The operation uses the same project lease as Editor commands. An uncertain failure
retains its operation ID for reconciliation; do not repeat an upgrade automatically.
Only explicit init performs this version check. Startup, status, doctor, list and
run never automatically upgrade Pipeline. Historical versions in validation notes
describe inspected contracts, not installation requirements.

After successful setup, call the wrapper's `open` operation once if opening the
project is part of the request. Report `pipeline_installed`, `pipeline_upgraded` or `pipeline_present`
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
