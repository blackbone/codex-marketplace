---
name: get
description: Inspect one ToDo task including its body, status, blockers, error, artifacts, and completion receipt. Use only when the user explicitly invokes $todo:get.
---

# ToDo Get

1. Require a full task ID or unique numeric prefix.
2. Call `task_get`.
3. Report the returned state without changing the task.
4. When metrics are present, show attempt count, final completion, cumulative human duration, and cumulative total tokens.
