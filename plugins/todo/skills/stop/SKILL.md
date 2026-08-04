---
name: stop
description: Stop the detached ToDo daemon without interrupting active tasks by default. Use only when the user explicitly invokes $todo:stop.
---

# ToDo Stop

1. Call `runner_stop` for the target repository.
2. Keep `force` false unless the user explicitly asks to interrupt running tasks.
3. If active tasks prevent shutdown, report their IDs and leave the daemon running.
4. Report the confirmed terminal state returned by the tool.
