# Validation record — 2026-09-09

## Latest Pipeline setup — 2026-09-11

Official `unity pipeline list-versions` reported latest `0.7.0-exp.1`. A disposable
Unity-shaped project exercised the real CLI through the source wrapper: missing
package installation selected 0.7.0-exp.1, upgrading a 0.6.0-exp.1 manifest selected
0.7.0-exp.1, and a second init reported the unchanged current version. An unrelated
dependency survived all three calls and their leases were released. No user project
was changed and no Editor was opened; this proves registry/manifest installation,
not 0.7 Editor import or command compatibility. The older observations below remain
historical evidence, not version pins.

77 Unity regressions pass, including latest install/upgrade dispatch, already-current
behavior, setup/action exclusion, uncertain-result retention and cancellation.

The regression suite uses disposable projects, fake process/CLI executables and
loopback HTTP fixtures. No fault injection targets a user's Unity project.
It exercises descriptor/process identity, hook/wrapper/launcher parity, ToDo guards,
shared diagnostic deadlines, authentication/protocol/transport failures, modal and
busy signals, nested result handling, secret filtering, command/recovery exclusion,
unknown-outcome retention and cross-process launch/recovery ownership.

Source live checks against the requested `exohell/client` project found one real
Editor, matching descriptor/Editor PID and exact project path, and CLI readiness.
Discovery returned `editor_status`; its read-only result reported the target
project, `compiling: false`, `domainReloadInProgress: false`, `playMode: stopped`.
Observed tools: Unity CLI `1.0.0-beta.8`, Editor `6000.6.0f1`, Pipeline `0.6.0-exp.1`.
A later installed-copy smoke is part of the delivery procedure: verify package
hash parity, doctor, discovery and the same read-only command from that copy.
Final gate and installed-copy outcomes are reported with the delivery result.

No Editor was restarted, no server was stopped, no package was changed in Exohell,
and no game source or ToDo task was edited by this work. Source/runtime inspection
establishes descriptor lifecycle mechanisms, not the cause of its historical
removal. UI Stop/Start recovery is regression-tested as a lease/protocol flow in
fixtures; the historical live recovery is user-reported and was not reproduced
against the working project. Linux live behavior, arbitrary custom commands and
Codex's native hook invocation lifecycle remain outside this live proof.


## Blocking calls — 2026-09-10

Added fixture coverage for one call crossing compilation, asset updating, a missing
descriptor and process-inspection timeouts before a single user-command dispatch.
Also covered bounded timeout, cancelled waiting, cancelled dispatched commands,
waiting behind a live caller, retained unknown outcomes and permanent EPERM denial.
The Codex workspace permission profile reproduced an OS process-inspection EPERM
in a read-only diagnostic. The original worker receipt did not retain its low-level
exception, so the reproduction establishes the configuration blocker, not a recovered
incident trace. Worker permissions are not changed by the plugin itself.

## Core operation lifecycle — 2026-09-10

Regressions cover nested diagnostic preservation/redaction, pre-dispatch reload,
unpublished owner grace, status inspection while an unknown mutation remains locked,
compiler/test terminal failures, reload-surviving completion, job IDs, cancellation,
exclusive resume, lost jobs and project/PID mismatches. Existing regressions remain.
A source-copy live read-only `editor_status` job on Exohell verified the shipped CLI's
flat detached acknowledgement and matching terminal `job status` result. The first
smoke exposed an envelope mismatch; the same issued job was read by ID and confirmed
complete before its test-owned lease was explicitly reconciled. The parser was
corrected and the exact flat response added to regression coverage. The next smoke
completed through the wrapper and released its lease automatically.
No live compilation/test fault was injected and no game source or ToDo task changed.
Compiler/test failure and reload recovery evidence is fixture-based. Jobs are not
persistent across Editor domain reload and never authorize automatic resubmission.

## Native workflows — 2026-09-10

Compared upstream unity-agent-plugin commit 673d9c45ceeb0ef46044cd68bcd90fa0254b248f
with CLI 1.0.0-beta.8 help/output and resolved Pipeline 0.6.0-exp.1 source. Native
package_add/remove/status already implement the Client API; the upstream standalone
installer is unnecessary here. Package resolve is fire-and-forget; status recovery
across reload can synthesize completion, so the recipe requires installed-version
read-back. Script dry-run and async timeout semantics are grounded in RunScriptCommand.

74 Unity regressions pass, including package reload/import waiting, hashed saved
correlation, non-replaying resume, mismatched status/PID rejection, failed/malformed
responses, native preview pass-through, URL credential filtering, serialized failures
and full-doctor evidence isolation. No live package mutation, custom command or
builder was installed in a user's game. These new execution branches have fixture
coverage, not live installation/build proof. The official read-only pipeline list
was checked against the running Editor's actual structured response.
