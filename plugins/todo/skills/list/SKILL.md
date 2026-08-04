---
name: list
description: List active ToDo tasks and optionally recent closed tasks. Use only when the user explicitly invokes $todo:list.
---

# ToDo List

1. Call `task_list`.
2. Include closed tasks only when requested.
3. Report ID, title, status, assigned worker, blockers, updated time, and error when present.
4. For finished attempts, show attempt count, cumulative human duration, and cumulative total tokens.
