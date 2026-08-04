---
name: dashboard
description: Show the local ToDo dashboard URL for an activated repository without starting or changing the runner. Use only when the user explicitly invokes $todo:dashboard.
---

# ToDo Dashboard

1. Call `runner_status`.
2. Return `dashboardUrl` when the daemon is running.
3. If no URL is available, report the runner state and tell the user to invoke `$todo:start`; do not start it automatically.
