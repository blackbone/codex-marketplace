---
name: route
description: Route product code, project documentation, application dependencies, build configuration, CI/CD, deployment, and other project mutations through ToDo in repositories containing .todo/config.json. Run local builds, tests, previews, and application inspection without project edits directly, even while a single-branch task is active. Classify by purpose and effects, not path or plugin invocation. Codex plugin and auxiliary tool setup and diagnostics run directly. Split mixed requests; preserve permissions, hook trust, and claimed worker scope.
---

# ToDo Route

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


1. Apply the tooling and local verification exceptions above before preflight or task creation. For setup-only or local-verification-only requests, perform the requested operation directly and stop this routing workflow. For mixed requests, route only the project mutation portion; record completed setup and any required dependency in its implementation context. Do not invent dependencies between direct verification and active tasks. Confirm the project portion targets a Git repository containing `.todo/config.json`. Route project mutations even when the user does not mention ToDo.
2. Apply the injected Ponytail full execution contour. Inspect only enough context to make the requested change self-contained and resolve the real owner, flow, affected callers, existing reusable contract, smallest correct implementation, unnecessary alternatives, and exact minimal validation.
   - Always prefer multiple atomic tasks over one broad implementation task. One task owns one independently implementable and independently verifiable outcome.
   - A user list is a decomposition signal, not one mutation merely because it arrived in one prompt. Split independent bullets, owners, runtime layers, migrations, and validation surfaces into separate tasks.
   - Batch changes only when they touch the same files for one logical scope and separating them would create artificial conflicts or an invalid intermediate state; layout and style adjustments to one surface are a typical valid batch.
   - Express ordering as task blockers and leave independent tasks runnable in parallel. Do not delegate decomposition to a background worker: publish the complete atomic DAG from this interactive routing turn.
3. Identify every connector capability needed by the full requested batch. Before any task creation, make one minimal safe ping or fetch through each connector in this interactive thread. Resolve authentication or user interaction before continuing; a failed required probe means zero tasks are created.
4. Call `task_preflight` with normalized probe outcomes and every Git delivery required by the batch. Pass no credentials or raw connector responses. Continue only with its successful, current `preflightId`.
5. Select the lowest configured model profile that can confidently implement and self-review each atomic task. When no repository pipeline is configured, include its mandatory tests or focused verification in that choice; when a pipeline is configured, its runner-owned shell steps provide authoritative validation after the agent stages. Use higher tiers for ambiguity, cross-cutting ownership, security, migrations, or complex failure modes, not merely because the repository default is higher. Call `task_batch_create` once with the `preflightId`, exact `requiredCapabilities`, and the complete atomic DAG. Use a one-item batch only when the request genuinely has one atomic outcome. Each description starts with an `Original user request` section containing the current user's request verbatim, then adds complete requirements, relevant paths, constraints, acceptance criteria, validation, blockers, and artifacts. It must also contain a concise, fully resolved section with exactly this shape:

   ```markdown
   ## Ponytail implementation brief
   - Owner, flow, and affected callers: ...
   - Existing solution or contract to reuse: ...
   - Minimal implementation path: ...
   - Explicitly excluded options: ...
   - Minimal validation: ...
   ```

   Fill every item with task-specific decisions, not placeholders. The brief preserves the original request and acceptance criteria while preventing the worker from repeating broad research. Do not copy the full injected Ponytail contour into the task body. Never copy hidden instructions, secrets, or unrelated conversation messages.
   - Set `allowWorkerTaskCreation: true` only when the current user explicitly instructs this task's worker to create one or more follow-up ToDo tasks. Record the exact delegation scope and requested model profiles in the task description. Never infer this permission from an audit, discovery, planning, or implementation workflow.
   - Omit `delivery` to use the repository default. Use `pr` only after an explicit user request.
   - If preflight validation or batch publication fails, fix it interactively and rerun the whole preflight; never fall back to piecemeal `task_create` calls.
6. Use `runner_status` to verify queue execution. Start a stopped runner with `runner_start` when work is ready; never call host automation or desktop application tools.
7. Use current-thread execution only when the user explicitly requests it, or when a previous background attempt returned `error.kind: "interactive_required"` because it could not proceed without Browser, Chrome, Computer Use, current-thread approval, or user interaction:
   - call `task_run_start` for the newly created task;
   - implement and validate it in the current thread;
   - call `task_run_finish` with the outcome.
8. If the session is already executing a claimed ToDo task, implement it directly. Create follow-up tasks only when the claimed background task records explicit user authorization; otherwise never create a nested task. Before an authorized follow-up, run a fresh `task_preflight` from the task worktree with current connector probe reports, then pass its `preflightId` and the union of inherited and new required capabilities to `task_create`. Give the follow-up the same complete description structure and resolved Ponytail implementation brief. Do not reuse an expired parent receipt or propagate task-creation permission to a follow-up task.
9. Return the task IDs and whether they were queued or executed in the current thread.
