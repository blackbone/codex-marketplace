import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TODO_ROUTING_POLICY,
} from "./routing-policy.mjs";
import { TODO_PONYTAIL_FULL_CONTOUR } from "./ponytail-policy.mjs";
import {
  processIsAlive,
  readDaemonState,
} from "./lib.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";
import { daemonRestartRequestPath } from "./runtime-update.mjs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let event = {};
  try {
    event = input.trim() ? JSON.parse(input) : {};
  } catch {
    process.exitCode = 0;
    return;
  }

  const hookEventName = event.hook_event_name;
  if (
    hookEventName !== "SessionStart" &&
    hookEventName !== "UserPromptSubmit" &&
    hookEventName !== "SubagentStart"
  ) {
    return;
  }

  const cwd =
    typeof event.cwd === "string" && event.cwd
      ? path.resolve(event.cwd)
      : process.cwd();
  const git = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  if (git.status !== 0) return;
  let repoRoot = git.stdout.trim();
  if (
    process.env.TODO_RUNNER_WORKER === "1" &&
    process.env.TODO_RUNNER_REPO_ROOT
  ) {
    const workerRepoRoot = path.resolve(process.env.TODO_RUNNER_REPO_ROOT);
    if (existsSync(path.join(workerRepoRoot, ".todo", "config.json"))) {
      repoRoot = workerRepoRoot;
    }
  }
  if (!repoRoot || !existsSync(path.join(repoRoot, ".todo", "config.json"))) {
    return;
  }

  let runtimeNotice = "";
  if (process.env.TODO_RUNNER_WORKER !== "1") {
    try {
      const daemon = readDaemonState(repoRoot);
      const updateRequested = existsSync(
        daemonRestartRequestPath(repoRoot),
      );
      if (
        (daemon && processIsAlive(daemon.pid)) ||
        updateRequested
      ) {
        const ensured = ensureDaemon(repoRoot);
        if (ensured.status === "restart-pending") {
          runtimeNotice = `\nToDo runtime update is pending at a safe task boundary (${ensured.runtimeUpdate?.activeTasks || 0} active). Do not create tasks until it is current.`;
        } else if (ensured.status === "running" && updateRequested) {
          runtimeNotice =
            "\nToDo runtime update was applied and the daemon restarted with current plugin files and repository config.";
        } else if (
          ["conflict", "start-failed", "start-blocked", "update-blocked"].includes(
            ensured.status,
          )
        ) {
          runtimeNotice = `\nToDo runtime update is blocked: ${ensured.reason || ensured.runtimeUpdate?.reason || ensured.status}. Do not create tasks until it is current.`;
        }
      }
    } catch (error) {
      runtimeNotice = `\nToDo runtime update check failed: ${error.message}`;
    }
  }

  const contextBlocks = [TODO_ROUTING_POLICY, TODO_PONYTAIL_FULL_CONTOUR];
  if (process.env.TODO_RUNNER_WORKER === "1") {
    contextBlocks.push(
      "This session is an already claimed ToDo background worker. Implement the supplied task directly and do not modify .todo runtime files. Create follow-up ToDo tasks only when the claimed task records explicit user authorization; otherwise do not call ToDo MCP tools.",
    );
  } else if (runtimeNotice) {
    contextBlocks.push(runtimeNotice.trim());
  }
  const additionalContext = contextBlocks.join("\n\n");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext,
      },
    }),
  );
});
