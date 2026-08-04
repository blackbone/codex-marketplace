---
name: workers
description: List ToDo worker states, process IDs, and current task assignments separately from tasks. Use only when the user explicitly invokes $todo:workers.
---

# ToDo Workers

1. Call `worker_list`.
2. Report each worker ID, exact state, PID, and assigned task.
3. Do not infer task state from worker state.
