---
name: start
description: Start the detached ToDo daemon for an activated Git repository. Use only when the user explicitly invokes $todo:start.
---

# ToDo Start

1. Call `runner_start` for the target repository.
2. Call `runner_status` once afterward to report the resolved state, PID, worker count, and dashboard URL when available.
3. Do not initialize an inactive repository; tell the user to invoke `$todo:init`.
