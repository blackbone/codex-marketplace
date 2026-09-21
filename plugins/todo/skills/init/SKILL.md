---
name: init
description: Initialize durable ToDo routing in a Git repository by creating .todo/config.json and installing the managed repository instruction policy. Use only when the user explicitly invokes $todo:init.
---

# ToDo Init

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

1. Call `repo_init` for the target repository. By default it opens the browser with the dashboard Settings dialog, without starting workers. Set `openBrowser: false` only when the user requests headless initialization.
2. Never overwrite an existing `.todo/config.json`.
3. Ensure the managed ToDo routing block exists in the repository instruction file returned by `repo_init`; preserve every instruction outside that block.
4. Treat the routing policy, including direct tool setup, as active immediately. Initialization and refreshing ToDo-owned instruction blocks are direct plugin maintenance. Existing blocks are also refreshed by trusted SessionStart/UserPromptSubmit hooks; missing blocks require explicit initialization.
5. Report whether configuration and routing instructions were created or updated, plus their resolved paths. Include `settingsUrl`; if browser opening failed, report `browserError` and offer that URL for manual opening. Do not open a second browser tab when `browserOpened` is true. The setup dashboard lasts for the MCP session; `$todo:start` provides the runner dashboard afterward.
