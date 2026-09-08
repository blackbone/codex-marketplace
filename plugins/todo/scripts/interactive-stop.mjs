import { existsSync } from "node:fs";
import path from "node:path";
import { findGitRoot, listTaskStatuses, readClaim, waitForTaskInput } from "./lib.mjs";

// The app emits Stop for the owning session. This closes an abandoned turn's
// claim without depending on the lifetime of its shared MCP server process.
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const event = JSON.parse(input);
  if (event.hook_event_name !== "Stop" || !event.session_id) process.exit(0);
  const cwd = path.resolve(event.cwd || process.cwd());
  const marker = `${path.sep}.todo${path.sep}worktrees${path.sep}`;
  const index = cwd.indexOf(marker);
  const root = index >= 0 ? cwd.slice(0, index) : findGitRoot(cwd);
  if (!root || !existsSync(path.join(root, ".todo", "config.json"))) process.exit(0);
  for (const task of listTaskStatuses(root)) {
    const claim = readClaim(`${task.path}.lock`, { includeToken: true });
    if (claim?.workerId !== "interactive" || claim.owner?.threadId !== event.session_id) continue;
    // A session-only Stop can arrive after another turn has claimed the task.
    // Without an exact turn ID leave recovery to the host status reconciliation.
    if (!event.turn_id || !claim.owner.turnId || event.turn_id !== claim.owner.turnId) continue;
    waitForTaskInput(root, task.id, {
      claimToken: claim.token, owner: claim.owner,
      question: "The executor turn ended before finishing this task. Continue in its chat or send an instruction from the dashboard.",
    });
  }
} catch (error) {
  // A malformed event must not release an unverified owner or prevent the app
  // from stopping. Daemon reconciliation remains available for recovery.
  process.stderr.write(`ToDo interactive Stop: ${error.message}\n`);
}
