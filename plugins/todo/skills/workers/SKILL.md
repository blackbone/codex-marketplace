---
name: workers
description: List ToDo worker states, process IDs, and current task assignments separately from tasks. Use only when the user explicitly invokes $todo:workers.
---

# ToDo Workers

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `worker_list`.
2. Report each worker ID, exact state, PID, and assigned task.
3. Report the singleton merge worker and out-of-quota merge-repair worker separately; neither consumes a configured implementation worker slot.
4. Do not infer task state from worker state.
