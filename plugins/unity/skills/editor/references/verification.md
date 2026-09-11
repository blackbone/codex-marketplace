# Verify the requested effect

Choose the smallest check that proves the change. Discover each command and its
arguments in the connected project's catalog; execute through the wrapper. A
successful trigger, an idle Editor, and an empty source diff are different facts.

| Change | Evidence to collect |
| --- | --- |
| Scene objects or serialized fields | Read back the exact objects, component types, references and values. Save only the intended scene, then confirm the saved path/content. |
| Prefab or asset | Verify the exact asset path/GUID, type and serialized values; apply the intended prefab changes and save that asset. Inspect its diff and required meta file. |
| C# source or registered command | Use native `recompile` if compilation is required; await the wrapper's terminal result, inspect compiler errors, then discover the new command. |
| Runtime behavior | Exercise the requested flow in the exact scene; verify its observable result and relevant new console errors. Record the final Play Mode state. |
| Tests | Discover `run_tests`, select the relevant EditMode/PlayMode scope, await terminal `test_status` through the wrapper, and inspect failures and any returned artifact. |
| Package | Follow the packages skill: terminal UPM status, idle Editor, actual installed version and relevant compilation. |

Prefer a targeted save over `save_all`: another task or the user may have unsaved
changes. Preserve the initial scene/Play Mode state when the requested operation
allows it. Entering/exiting Play Mode can invoke project code; do it only for a
relevant runtime check, and never assume all in-memory changes were persisted.

For a reusable builder, verify its owned output after the first run. Check a second
run for duplication only in an isolated test project or where rerunning the builder
is explicitly within scope. An unknown first outcome does not authorize a repeat.

Do not turn every micro-edit into a full build, audit, or whole-project test run.
Do not install test/audit packages just to perform optional validation. Build or
audit when it addresses the request, using the discovered native contract and a
supported completion protocol; arbitrary async acknowledgements are not proof.

Report source checks, Editor compile/import, runtime behavior and artifacts
separately. A transient readiness wait stays inside the current tool call. If it
expires before dispatch, say the validation was not run; preserve completed code
and do not invent a requirement to reopen an already running Editor.
