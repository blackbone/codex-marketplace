---
name: start
description: Start the detached ToDo daemon, bind its supervisor to the invoking chat, and open its dashboard in the in-app Browser for an activated Git repository. Use only when the user explicitly invokes $todo:start.
---

# ToDo Start

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call. Use the Codex app automation capability for heartbeat mutations; never edit automation files directly.

1. Call `supervisor_get`. Every `$todo:start` invocation must bind supervision to the current invoking chat before starting the dashboard, even when another heartbeat is already configured.
2. If a heartbeat is configured, delete that exact host automation by its stored ID. After confirmed deletion call `supervisor_clear`. If deletion fails, leave the existing binding unchanged, report the monitoring error separately, and do not create a duplicate.
3. Create one heartbeat in the current chat with:
   - name `Keep <repository-name> ToDo running`;
   - prompt `Use $todo:supervise in scheduled-run mode for this repository. Do not create another automation.`;
   - recurrence `FREQ=MINUTELY;INTERVAL=15`;
   - kind `heartbeat` and destination `thread`, which attaches it to the current invoking chat;
   - status equal to `desiredStatus` from `supervisor_get`, so an idle repository starts as `PAUSED` and active work starts as `ACTIVE`.
4. After the host confirms creation, read the host-persisted definition for that exact automation ID and capture its non-empty `target_thread_id`. This read verifies the thread selected by the host; never edit the automation file.
5. Call `supervisor_bind` with the returned automation ID, `targetThreadId` equal to that captured `target_thread_id`, and the exact name, prompt, recurrence, and confirmed status. Never persist a new binding before host confirmation or without the target thread ID.
6. Call `runner_start` with `dashboardThreadId` equal to that exact host-confirmed `target_thread_id`. This makes the OS-assigned dashboard port sticky for the invoking thread. If supervisor binding failed, still start the runner without `dashboardThreadId`, but report that thread-sticky dashboard ownership was not established.
7. Call `runner_status` once afterward to report the resolved state, PID, worker count, `dashboardThreadId`, and dashboard URL. When a target thread was confirmed, require the returned `dashboardThreadId` to match it; never open a stale URL owned by another thread.
8. When matching status returns `dashboardUrl`, invoke `$browser:control-in-app-browser` and open a new in-app Browser tab at that exact returned URL. This is required on every start, including when a previously reserved port was occupied and the runner replaced it. Do not substitute Chrome, another browser, a connector, or a system URL opener. Do not inspect or interact with the dashboard unless the user also asks for that.
9. If no matching `dashboardUrl` is returned, or the in-app Browser is unavailable or cannot open the tab, report the dashboard error separately. Never guess a dashboard URL or reuse one from an earlier runner session.
10. Treat runner startup, dashboard opening, and monitoring setup as separate outcomes. A Browser or heartbeat failure must not be represented as runner failure, but `$todo:start` is not fully successful until the dashboard tab is open and monitoring is bound to the current chat with its target thread persisted.
11. Do not initialize an inactive repository; tell the user to invoke `$todo:init`.
