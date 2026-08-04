import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TODO_ROUTING_POLICY,
} from "./routing-policy.mjs";

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
  const repoRoot = git.stdout.trim();
  if (!repoRoot || !existsSync(path.join(repoRoot, ".todo", "config.json"))) {
    return;
  }

  const additionalContext =
    process.env.TODO_RUNNER_WORKER === "1"
      ? "This session is an already claimed ToDo background worker. Implement the supplied task directly, do not create a nested ToDo task, and do not modify .todo runtime files."
      : TODO_ROUTING_POLICY;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext,
      },
    }),
  );
});
