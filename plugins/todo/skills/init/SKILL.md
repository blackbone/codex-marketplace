---
name: init
description: Initialize durable ToDo routing in a Git repository by creating .todo/config.json and installing the managed repository instruction policy. Use only when the user explicitly invokes $todo:init.
---

# ToDo Init

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

<!-- TODO TOOLING EXCEPTION START -->
Classify each operation by its purpose and effects, not just its file path or the fact that a plugin/tool is invoked.
- Perform Codex plugin and auxiliary tool installation, configuration, updates, diagnostics, tool connections, and creation or refresh of their service configurations, indexes, and caches directly, without creating a ToDo task. This includes service files inside the repository.
- Product code, project documentation, application dependencies, build, CI/CD, and deployment changes still require ToDo, even when performed through a plugin or described as "tooling setup". Developing a plugin as the repository's product is also a project change.
- Split mixed requests: perform tool setup directly and route project changes through ToDo. Complete prerequisite setup before publishing dependent project tasks; a setup failure must not publish tasks that depend on it.
- A user's request to configure a tool already authorizes that setup; do not ask for a separate routing confirmation. Preserve existing permission, access, authentication, and hook-trust requirements; never approve hook trust on the user's behalf.
- Examples: docs:init writing .semantic-search.json and indexing docs/ is direct; configuring another Codex plugin or MCP connection is direct; editing source code or docs/ through a plugin requires ToDo; changing a build pipeline or deployment under the label "tooling setup" requires ToDo; connecting a documentation search tool and then rewriting project documentation splits into direct setup and a ToDo documentation task.

The tooling exception does not expand a claimed worker's assigned task scope, repository access, permissions, or authority to create follow-up tasks. Perform tool setup only when required for the assigned task and already allowed by its restrictions; never use it to alter unrelated repositories, managed routing instructions, or .todo runtime state.
<!-- TODO TOOLING EXCEPTION END -->

1. Call `repo_init` for the target repository.
2. Never overwrite an existing `.todo/config.json`.
3. Ensure the managed ToDo routing block exists in the repository instruction file returned by `repo_init`; preserve every instruction outside that block.
4. Treat the routing policy, including direct tool setup, as active immediately. Initialization and refreshing ToDo-owned instruction blocks are direct plugin maintenance. Existing blocks are also refreshed by trusted SessionStart/UserPromptSubmit hooks; missing blocks require explicit initialization.
5. Report whether configuration and routing instructions were created or updated, plus their resolved paths.
