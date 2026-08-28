---
name: stop
description: Stop the detached ToDo daemon without interrupting active tasks by default. Use only when the user explicitly invokes $todo:stop.
---

# ToDo Stop

Pass the target repository's absolute root as `repoPath` to every ToDo MCP call.

1. Call `runner_stop` for the target repository.
2. Keep `force` false unless the user explicitly asks to interrupt running tasks.
3. If active tasks prevent shutdown, report their IDs and leave the daemon running.
4. After a confirmed stop, call `supervisor_get`. If `actionRequired` is `"rebind"`, do not update the heartbeat; report that `$todo:start` must be invoked in the owner chat. If a supervisor is configured and active, update that exact heartbeat with its stored complete definition, explicitly pass its stored `targetThreadId`, and set `status: "PAUSED"`; after host confirmation persist the same target and paused definition with `supervisor_bind`. Never retarget it to the stop chat.
5. Report the confirmed terminal state returned by the tool.
