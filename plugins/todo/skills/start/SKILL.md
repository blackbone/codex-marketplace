---
name: start
description: Start the detached ToDo runner for an activated Git repository and return its dashboard URL. Use only when the user explicitly invokes $todo:start.
---

# ToDo Start

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `runner_start` for the repository. The runner owns its persistent app-server connection and task sessions.
2. Call `runner_status` once to verify the resolved state, PID, worker count, and dashboard URL.
3. Return the exact `dashboardUrl` as a clickable link. Never guess a port or reuse an earlier URL.
4. Do not create or update host automations, open application tabs, or call desktop application tools. Runner startup does not depend on a host chat or heartbeat.
5. Do not initialize an inactive repository; tell the user to invoke `$todo:init`.
