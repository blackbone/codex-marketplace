---
name: start
description: Start the detached ToDo daemon, bind its supervisor to the invoking chat, and open its dashboard in the in-app Browser for an activated Git repository. Use only when the user explicitly invokes $todo:start.
---

# ToDo Start

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call. Use the Codex app automation capability for heartbeat mutations; never edit automation files directly.

1. Call `runner_start` for the target repository.
2. Call `runner_status` once afterward to report the resolved state, PID, worker count, and dashboard URL when available.
3. When `runner_status` returns `dashboardUrl`, invoke `$browser:control-in-app-browser` and open a new in-app Browser tab at that exact returned URL. This is an explicit in-app Browser requirement: do not substitute Chrome, another browser, a connector, or a system URL opener. Do not inspect or interact with the dashboard unless the user also asks for that.
4. If no `dashboardUrl` is returned, or the in-app Browser is unavailable or cannot open the tab, report the dashboard error separately and continue supervisor setup. Never guess a dashboard URL or reuse one from an earlier runner session.
5. Call `supervisor_get`. Every `$todo:start` invocation must bind supervision to the current invoking chat, even when another heartbeat is already configured.
6. If a heartbeat is configured, delete that exact host automation by its stored ID. After confirmed deletion call `supervisor_clear`. If deletion fails, leave the existing binding unchanged, report the monitoring error separately, and do not create a duplicate.
7. Create one heartbeat in the current chat with:
   - name `Keep <repository-name> ToDo running`;
   - prompt `Use $todo:supervise in scheduled-run mode for this repository. Do not create another automation.`;
   - recurrence `FREQ=MINUTELY;INTERVAL=15`;
   - kind `heartbeat` and destination `thread`, which attaches it to the current invoking chat;
   - status equal to `desiredStatus` from `supervisor_get`, so an idle repository starts as `PAUSED` and active work starts as `ACTIVE`.
8. After the host confirms creation, call `supervisor_bind` with the returned automation ID plus the exact name, prompt, recurrence, and confirmed status. Never persist a new binding before host confirmation.
9. Treat runner startup, dashboard opening, and monitoring setup as separate outcomes. A Browser or heartbeat failure must not be represented as runner failure, but `$todo:start` is not fully successful until the dashboard tab is open and monitoring is bound to the current chat.
10. Do not initialize an inactive repository; tell the user to invoke `$todo:init`.
