---
name: start
description: Start the detached ToDo runner for an activated Git repository and return its dashboard URL. Use only when the user explicitly invokes /todo:start.
---

# ToDo Start

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `runner_start` for the repository. Executor metadata binds this task as the dashboard owner for live counter titles. The runner owns its Claude executor and task sessions.
   If it returns `start-blocked` with `profileProblems`, the runner did not start because a model profile is invalid or names a model outside the Claude CLI model list. Show each problem and tell the user to fix the profiles in the dashboard Settings → Model profiles (`/todo-dashboard`, or the web dashboard settings), then start again. Do not edit `.todo/config.json` or pick replacement models yourself.
2. Call `runner_status` once to verify the resolved state, PID, worker count, and dashboard URL.
3. Return the exact `dashboardUrl` as a clickable link. Never guess a port or reuse an earlier URL.
4. Do not create or update host automations, open application tabs, or call desktop application tools. Runner startup does not depend on a host chat or heartbeat.
5. Do not initialize an inactive repository; tell the user to invoke `/todo:init`.
