---
name: init
description: Initialize durable ToDo routing in a Git repository by creating .todo/config.json and installing the managed repository instruction policy. Use only when the user explicitly invokes $todo:init.
---

# ToDo Init

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `repo_init` for the target repository.
2. Never overwrite an existing `.todo/config.json`.
3. Ensure the managed ToDo routing block exists in the repository instruction file returned by `repo_init`; preserve every instruction outside that block.
4. Treat the routing policy as active immediately for subsequent mutation requests in this thread.
5. Report whether configuration and routing instructions were created or updated, plus their resolved paths.
