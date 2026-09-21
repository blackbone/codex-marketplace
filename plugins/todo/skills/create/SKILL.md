---
name: create
description: Create one explicitly requested self-contained repository implementation task without decomposing it into a batch. Tasks run through background app-server workers by default. Use only when the user explicitly invokes $todo:create for one task; use $todo:route for a list or broad change that requires atomic decomposition.
---

# ToDo Create

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

<!-- TODO TOOLING EXCEPTION START -->
Classify each operation by its purpose and effects, not just its file path or the fact that a plugin/tool is invoked.
- Perform Codex plugin and auxiliary tool installation, configuration, updates, diagnostics, tool connections, and creation or refresh of their service configurations, indexes, and caches directly, without creating a ToDo task. This includes service files inside the repository.
- Run local builds, tests, application launches, previews, and runtime inspection directly in the current thread when they do not edit product code, project documentation, application dependencies, or build/CI/CD/deployment configuration. Generated local build outputs, caches, logs, test reports, and disposable runtime data are allowed effects of this verification; they do not require a ToDo task.
- Local verification requires no task creation, task_preflight, task_run_start, or task_run_finish, including while another task owns a single-branch reservation. Do not add task dependencies, wait for task completion, stop a worker, or release/recover its reservation merely to run local verification. Respect actual tool/resource conflicts (for example, an occupied Editor or output directory); use separate local outputs where needed and report the concrete conflict if it cannot be avoided.
- Changes to product code, project documentation, application dependencies, build scripts/settings, CI/CD, or deployment still require ToDo, even when performed through a plugin or described as "tooling setup" or "verification". Route any required implementation fixes separately; the local verification exception does not authorize source edits, dependency upgrades, Git mutations, publishing, or deployment. Developing a plugin as the repository's product is also a project change.
- Split mixed requests: perform tool setup directly and route project changes through ToDo. Complete prerequisite setup before publishing dependent project tasks; a setup failure must not publish tasks that depend on it.
- A user's request to configure a tool already authorizes that setup; do not ask for a separate routing confirmation. Preserve existing permission, access, authentication, and hook-trust requirements; never approve hook trust on the user's behalf.
- Examples: docs:init writing .semantic-search.json and indexing docs/ is direct; configuring another Codex plugin or MCP connection is direct; editing source code or docs/ through a plugin requires ToDo; changing a build pipeline or deployment under the label "tooling setup" requires ToDo; connecting a documentation search tool and then rewriting project documentation splits into direct setup and a ToDo documentation task.

The tooling and local verification exceptions do not expand a claimed worker's assigned task scope, repository access, permissions, or authority to create follow-up tasks. Perform tool setup or local verification only when required for the assigned task and already allowed by its restrictions; never use these exceptions to alter unrelated repositories, managed routing instructions, or .todo runtime state.
<!-- TODO TOOLING EXCEPTION END -->

Use `modelDiagnostics` and `modelProfiles` returned by preflight when selecting a model. Report outdated, retired, unsupported, or unverified profiles explicitly; never silently fall back. Use `model_profiles` with `action: inspect` to show all executor models, task roles, and the proposed cleanup/update. Show the exact removals/replacements before applying the returned `planId`; apply only within the user's authorization. The `models` config block is optional; omission inherits the plugin profiles. Preserve valid custom profiles, task profile names, and pipeline commands. Resolve saved tasks and pipeline steps through their current named profiles at each new attempt; an old model ID must not pin the task to a retired model. If the profile itself is missing or its current model is unavailable, report it instead of changing profiles. Prefer `fast`/`medium`/`advanced` for routine work and Astra `expert`/`ultra` for complex/very complex work. Spark is excluded from ToDo and must not be selected or added back. Built-in profiles use GPT-5.6 or newer: mini/fast use Luna (low/medium), standard/medium use Terra (low/medium), proven/advanced use Sol (medium/high), and expert/ultra use Astra (xhigh/max). Older profile names remain compatible; availability still comes from the executor catalog.


1. Apply the tooling and local verification exceptions above first; do not automatically create implementation tasks for tool setup or local builds, tests, launches, and previews without project edits. For the project mutation portion, apply the injected Ponytail full execution contour. Inspect only enough repository context to make the task self-contained and resolve the real owner, flow, affected callers, existing reusable contract, smallest correct implementation, unnecessary alternatives, and exact minimal validation.
2. Identify every connector capability the task requires. Before creating any task, call each connector once in the current interactive thread with the smallest safe ping or fetch that proves the required scope and read/write access. Resolve authentication or user interaction now; do not create a task after a required probe fails.
3. Call `task_preflight` with the normalized probe outcomes and every requested Git delivery. Never include credentials or raw connector responses. Continue only with a successful `preflightId`.
4. Select the lowest `modelProfile` from `.todo/config.json` that can confidently implement and self-review the task. When no repository pipeline is configured, it must also run the mandatory tests or focused verification itself. When a pipeline is configured, its runner-owned shell steps provide authoritative validation after the agent stages. Use the configured default only when no lower profile clearly fits.
5. Call `task_batch_create` with the `preflightId`, exact `requiredCapabilities`, and a one-item `tasks` array. Its description starts with an `Original user request` section containing the current user's request verbatim, followed by the complete intent, relevant paths, constraints, blockers, acceptance criteria, validation expectations, and chat artifacts. It must also contain a concise, fully resolved section with exactly this shape:

   ```markdown
   ## Ponytail implementation brief
   - Owner, flow, and affected callers: ...
   - Existing solution or contract to reuse: ...
   - Minimal implementation path: ...
   - Explicitly excluded options: ...
   - Minimal validation: ...
   ```

   Fill every item with task-specific decisions, not placeholders. The brief preserves the original request and acceptance criteria while preventing the worker from repeating broad research. Do not copy the full injected Ponytail contour into the task body. Failed validation or publication must leave zero runnable tasks.
   - Set `allowWorkerTaskCreation: true` only when the current user explicitly instructs this task's worker to create follow-up ToDo tasks. Include the exact delegation scope and requested model profiles in the description; never infer permission.
   - Omit `delivery` to use the repository default. Set `pr` only when the user explicitly requests a pull request.
6. Use `runMode: "interactive"` only when the user explicitly requests current-thread execution.
7. Background tasks use persistent app-server sessions. The legacy `ephemeral` field does not switch the transport.
8. Use `runner_status` to verify queue execution. Start a stopped runner with `runner_start` when work is ready; never call host automation or desktop application tools.
9. Do not implement the queued task in the interactive session unless current-thread-only capabilities are independently required or the user explicitly asks for current-thread execution.
10. Return only the task ID and initial status for the implementation portion, and any separate runner startup error.
