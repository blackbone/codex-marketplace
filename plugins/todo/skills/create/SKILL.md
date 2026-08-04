---
name: create
description: Create one self-contained repository implementation task. Tasks run in the background by default, including tasks linked to external services. Use only when the user explicitly invokes $todo:create.
---

# ToDo Create

1. Inspect only enough repository context to make the task self-contained.
2. Select the best `modelProfile` from `.todo/config.json`; use the configured default when no profile clearly fits.
3. Call `task_create` with the complete intent, relevant paths, constraints, blockers, acceptance criteria, validation expectations, and chat artifacts.
4. Use `runMode: "interactive"` only when the user explicitly requests current-thread execution. If the task references Jira, Asana, or another external work item, also pass its stable `externalWorkflows` reference; the linkage itself never changes `runMode`.
5. Keep `ephemeral` true unless the user explicitly requires a persisted Codex session.
6. Do not implement the queued task in the interactive session unless current-thread-only capabilities are independently required or the user explicitly asks for current-thread execution.
7. Return only the task ID and initial status for the implementation portion.
