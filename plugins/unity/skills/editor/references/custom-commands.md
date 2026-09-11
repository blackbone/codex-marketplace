# Project-specific commands through native Pipeline

Use a project command when a recurring domain operation benefits from a stable
typed interface. Use `run_script` for a one-off builder. Do not add a custom MCP,
HTTP server, dispatcher or command registry: Pipeline already discovers static
methods marked with `Unity.Pipeline.Commands.CliCommand`.

Before adding code, inspect the resolved package's attribute definitions and the
project's assembly layout. Put the command in an existing Editor-only assembly or
an appropriate `Editor/` folder. An asmdef using these attributes needs a reference
to the installed `Unity.Pipeline` assembly; do not guess assembly GUIDs or change
unrelated assembly boundaries. Source changes follow the target project's workflow.

Small read-only example, adapted to the project's naming convention:

```csharp
using Unity.Pipeline.Commands;
using UnityEngine.SceneManagement;

public static class ProjectCommands
{
    [CliCommand("project_scene_path", "Read the active scene path", MainThreadRequired = true)]
    public static string ScenePath() => SceneManager.GetActiveScene().path;
}
```

Use native `[CliArg("name", "description")]` on typed parameters. Avoid names
colliding with existing commands. Keep `MainThreadRequired = true` for Unity object,
scene, asset and serialization access. Set false only for thread-safe work; do not
set `RuntimeOnly = true` for an Editor command. Async methods must yield to Editor
updates; never busy-wait on a Unity request or block its main thread.

For mutation commands, validate input and target before changes, use the applicable
Undo/serialization APIs, and return useful identifiers plus an explicit success
result. An exception can follow partial mutation. Do not add automatic retries or
claim transaction/rollback guarantees supplied by neither Unity nor the command.

Await native compilation through the wrapper, discover the command with
`list --query <name> --detail full`, and execute a scoped probe. Verify the actual
result; source compilation alone does not prove registration or behavior. Do not
change the wrapper allowlist to let a new arbitrary command bypass a pending lease.

Reference: [Official custom-command extension mechanism](https://github.com/Unity-Technologies/unity-agent-plugin/blob/673d9c45ceeb0ef46044cd68bcd90fa0254b248f/skills/unity-cli/references/integration-advanced.md).
