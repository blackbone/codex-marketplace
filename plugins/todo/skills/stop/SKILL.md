---
name: stop
description: Stop the detached ToDo daemon without interrupting active tasks by default. Use only when the user explicitly invokes $todo:stop.
---

# ToDo Stop

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `runner_stop` for the target repository.
2. Keep `force` false unless the user explicitly asks to interrupt running tasks.
3. If active tasks prevent shutdown, report their IDs and leave the daemon running.
4. Report the confirmed terminal state returned by the tool. Do not call host automation or desktop application tools.
