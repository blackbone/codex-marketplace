# Validation record — 2026-09-09

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
