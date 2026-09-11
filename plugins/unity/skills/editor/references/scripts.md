# File-based C# and repeatable builders

Use existing registered commands first. For multi-step C# work, discover
`run_script` with the editor skill's wrapper `list --detail full`. Use the installed
contract; do not assume the upstream manual matches this project's package.

Keep temporary scripts in `<project>/Temp/CodexUnity/<unique-name>.cs`. Keep a
reusable, versioned builder in the project's established tools directory outside
`Assets/`, for example `AgentScripts/`. Writing it there does not trigger Unity
import; changes it makes to assets still can. Never add a scratch runner to Assets.

In Pipeline 0.6, a normal C# file can expose a static entry, such as
`public static int Build.All()`. Example wrapper request, after discovery:

```json
{"command":"run_script","args":["--file","AgentScripts/Build.cs","--entry","Build.All","--dry_run","true"],"timeoutSeconds":60}
```

Write the JSON to a unique request file and use the editor skill's `run --input`.
Native `dry_run` compiles without loading or executing the emitted assembly. It
does not simulate scene changes, prove behavior, or validate the intended outcome.
Once the compile check passes and the change is in scope, remove `--dry_run true`
and execute once. No additional approval is needed for an already authorized edit.

Pass entry arguments as the discovered `--args` JSON array in the request, not
shell interpolation. Use native `references`, `defines`, and `pdb` only when needed.
Default `mode: ephemeral` is suitable here; hotpatch is a different operation.
Do not enable privileged eval capability automatically when the Editor rejects it.

Native `timeout_ms` and wrapper `timeoutSeconds` are separate. Budget the wrapper
long enough for compilation plus execution. An async entry's timeout does **not**
cancel its Task: it may still change the scene. Preserve an unknown outcome and
reconcile side effects; never silently replay. Jobs are suitable only if the
operation will not cause domain reload and the inner Task has its own adequate limit.

Builders should identify their own objects/assets by stable paths or identifiers,
validate inputs before mutation, update those objects deliberately, and return
paths/counts useful for read-back. Use Unity Undo/serialization/save APIs where
appropriate. Do not clear a scene, overwrite unrelated assets, save all dirty work,
or advertise an operation as idempotent without checking its actual behavior.

After execution, follow [verification.md](verification.md). If `run_script` is absent,
use an advertised `eval_file` for small file-based work when appropriate; do not
install a second runner or upgrade Pipeline just to match this recipe.

For version-specific details, read the installed `com.unity.pipeline` package's
`.claude/skills/unity-pipeline/SKILL.md` and `Editor/Commands/Scripts/RunScriptCommand.cs`.
Locate the resolved package from its package metadata, including embedded/local
packages; do not assume a PackageCache hash. Treat embedded direct CLI examples as
API reference and keep execution through this plugin's wrapper.
