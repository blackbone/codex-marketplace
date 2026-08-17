---
name: update
description: Revise the body, blockers, model profile, ephemeral setting, or Git delivery of an existing unclaimed ToDo task. Use only when the user explicitly invokes $todo:update.
---

# ToDo Update

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `task_get` for the full task ID or unique numeric prefix.
2. Preserve every requirement the user did not ask to change.
3. Call `task_update` with the complete replacement body or blocker list and any explicit execution changes. Change `allowWorkerTaskCreation` only when the current user explicitly grants or revokes that permission.
   - A delivery change requires a fresh `task_preflight` receipt covering that exact mode and any required connector capabilities. Set `pr` only from an explicit user request.
4. Never edit `.todo` files directly.
5. Do not retry a failed task unless the user separately requests retry.
