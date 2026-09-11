---
name: packages
description: Discover, add, remove or change versions of Unity UPM packages through the current Editor's native Pipeline commands. Use for Unity package dependencies; use unity:init only for initial Pipeline setup.
---

# Unity packages

First read [the editor skill](../editor/SKILL.md) for project selection, ToDo guards,
wrapper request files and operation ownership. Use that wrapper for all Editor
commands. Package changes belong to the target project's normal change workflow.
Do not modify another checkout, start a second Editor or bypass a pending operation.

## Discover before changing

Read `Packages/manifest.json` and `Packages/packages-lock.json` to establish current
direct/transitive dependencies and any requested version constraint. Discover
`package_list`, `package_search`, `package_add`, `package_remove` and `package_status`
with wrapper `list`, then inspect the selected commands with `--detail full`.
Use the installed contract; do not assume every Pipeline version includes them.

Prefer the native commands: they already call `UnityEditor.PackageManager.Client`.
The official agent plugin's older recipe says package commands are absent and adds
an installer script; that statement does not apply to inspected Pipeline 0.6.
Do not duplicate the installer or launch a headless Editor against this open project.
If these commands are absent, report the capability gap before choosing a version-
appropriate Client API solution; do not silently upgrade Pipeline or hand-edit its
manifest to bypass it. `$unity:init` is for requested initial Pipeline setup only.

Verify the requested package exists and choose the version against the project's
Editor and existing constraints using native package search/registry metadata.
Apply only the dependencies needed for the user's task. Authorization for a named
package/change is sufficient; do not require a second generic approval.

## Preview and execute through UPM

In inspected Pipeline 0.6, the following are wrapper JSON request examples. Replace
the placeholder identifier with the verified package and use the discovered flags:

```json
{"command":"package_add","args":["--identifier","com.example.package@1.2.3","--dry_run","true"]}
```

Review the preview, then execute the authorized change once:

```json
{"command":"package_add","args":["--identifier","com.example.package@1.2.3","--confirm","true","--wait","false"],"completionTimeoutSeconds":600}
```

Removal uses `package_remove --name <package-id>` with the same native preview and
confirmation flags. Upgrading/pinning uses `package_add` with the selected version.
Run one package mutation at a time. Keep registry credentials out of request files,
URLs, source, logs and receipts; use the project's existing credential setup.

The wrapper recognizes an async add/remove acknowledgement, persists a correlation
hash rather than its raw identifier, and follows `package_status` while holding the
project lease. On native completion it waits for compilation/import readiness too.
Do not use `job:true`: package changes can reload the domain. Keep the tool session
alive, and resume a pending operation by its ID instead of reinstalling it.

UPM status is a shared last-operation file, not a durable per-request job. A changed
operation/argument or Editor PID causes an unknown result, not success. The lease
coordinates our callers only: simultaneous installs through the Editor UI or another
client must be coordinated, particularly repeated installs of the same identifier.

## Verify the resolved result

After completion, use native `package_list` to read back the actual package/version
(or its absence after removal), inspect the manifest and lock diff, then perform any
relevant compile/runtime check. Keep unrelated manifest entries and local changes.
Terminal status is only an installation-phase result: the package's reload recovery
can synthesize completion, so installed-version read-back is necessary.

`package_resolve` schedules resolution and may immediately return completed before
UPM finishes. Do not report that acknowledgement as resolved dependencies. Follow it
with wrapper readiness and the actual package list. Do not loop `package_resolve`.
Inspect compiler/package errors as such; do not label them connection failures.

If an outcome remains unknown, `inspect --query package_status --recovery-id <id>`
reads the native status without releasing the lease. Reconcile before explicit
unlocking. There is no automatic retry, forced removal or Library cleanup.

Upstream background: [Unity package management](https://github.com/Unity-Technologies/unity-agent-plugin/blob/673d9c45ceeb0ef46044cd68bcd90fa0254b248f/skills/unity-package-management/SKILL.md).
For actual commands, inspect the resolved package's
`Editor/Commands/PackageManager/PackageManagerCommand.cs`; native discovery wins
over the upstream recipe when versions differ.
