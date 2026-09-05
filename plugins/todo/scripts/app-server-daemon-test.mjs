// Fixture runners must never contact the user's native Codex app.
delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindSupervisor,
  cancelTask,
  createTask,
  getTaskStatus,
  finishInteractiveTask,
  initializeRepo,
  reopenTask,
  startInteractiveTask,
  updateTaskCodexThread,
  writeHistory,
} from "./lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), "todo-app-server-daemon-"));
const trace = path.join(root, "app-server-trace.jsonl");
const fake = path.join(root, "codex");
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};
git("init", "-b", "main");
git("config", "user.name", "ToDo Test");
git("config", "user.email", "todo@example.invalid");
writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
writeFileSync(
  path.join(root, ".gitignore"),
  "*.tmp\ncodex\napp-server-trace.jsonl\n",
  "utf8",
);
git("add", "README.md", ".gitignore");
git("commit", "-m", "fixture");

writeFileSync(
  fake,
	`#!/usr/bin/env node
import { fakeModelList } from ${JSON.stringify(new URL("./model-catalog-test.mjs", import.meta.url).href)};
import { appendFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
const trace = process.env.FAKE_TRACE;
let turnNumber = 0;
let threadNumber = 0;
let archiveFailures = 1;
let titleFailures = 1;
const logicalConflictThreads = new Set();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(trace, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "model/list") send({ id: message.id, result: fakeModelList() });
  else if (message.method === "thread/start") { threadNumber += 1; send({ id: message.id, result: { thread: { id: "persistent-task-thread-" + threadNumber } } }); }
  else if (message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  else if (message.method === "thread/archive") {
    if (message.params.threadId === "persistent-missing-closed-thread") {
      send({ id: message.id, error: { code: -32000, message: "no rollout found for thread id persistent-missing-closed-thread" } });
    } else if (archiveFailures > 0) {
      archiveFailures -= 1;
      send({ id: message.id, error: { code: -32000, message: "temporary archive failure" } });
    } else send({ id: message.id, result: {} });
  }
  else if (message.method === "thread/name/set") {
    if (titleFailures > 0) {
      titleFailures -= 1;
      send({ id: message.id, error: { code: -32000, message: "temporary title failure" } });
    } else send({ id: message.id, result: {} });
  }
  else if (message.method === "thread/unarchive" || message.method === "turn/interrupt") send({ id: message.id, result: {} });
  else if (message.method === "turn/start") {
    turnNumber += 1;
    const threadId = message.params.threadId;
    const turnId = "turn-" + turnNumber;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
	    const cancelFixture = message.params.input.some((item) => item.text?.includes("CANCEL_FIXTURE"));
	    const cleanupFixture = message.params.input.some((item) => item.text?.includes("MERGE_CLEANUP_FIXTURE"));
	    const conflictFixture = message.params.input.some((item) => item.text?.includes("MERGE_CONFLICT_FIXTURE"));
	    const logicalConflictFixture = message.params.input.some((item) => item.text?.includes("MERGE_LOGICAL_CONFLICT_FIXTURE"));
	    const conflictRepair = message.params.input.some((item) => item.text?.includes("merge-conflict repair attempt"));
	    const shutdownFixture = message.params.input.some((item) => item.text?.includes("SHUTDOWN_FIXTURE"));
	    if (cleanupFixture) {
	      writeFileSync(message.params.cwd + "/merged.txt", "merged\\n");
	      writeFileSync(message.params.cwd + "/build.tmp", "discard after merge\\n");
	    }
	    if (conflictFixture) {
	      writeFileSync(message.params.cwd + "/merge-conflict.txt", "task\\n");
	      writeFileSync(process.env.TODO_RUNNER_REPO_ROOT + "/merge-conflict.txt", "main\\n");
	      spawnSync("git", ["-C", process.env.TODO_RUNNER_REPO_ROOT, "add", "merge-conflict.txt"]);
	      spawnSync("git", ["-C", process.env.TODO_RUNNER_REPO_ROOT, "commit", "-m", "advance conflict target"]);
	    }
	    if (conflictRepair) {
	      writeFileSync(message.params.cwd + "/merge-conflict.txt", "main and task\\n");
	    }
	    if (logicalConflictFixture) {
	      logicalConflictThreads.add(threadId);
	      writeFileSync(message.params.cwd + "/merge-logical.txt", "task\\n");
	      writeFileSync(process.env.TODO_RUNNER_REPO_ROOT + "/merge-logical.txt", "main\\n");
	      spawnSync("git", ["-C", process.env.TODO_RUNNER_REPO_ROOT, "add", "merge-logical.txt"]);
	      spawnSync("git", ["-C", process.env.TODO_RUNNER_REPO_ROOT, "commit", "-m", "advance logical conflict target"]);
	    }
	    if (shutdownFixture) continue;
	    const logicalConflict = conflictRepair && logicalConflictThreads.has(threadId);
	    const failed = turnNumber === 1 || cancelFixture || logicalConflict;
	    const failureMessage = logicalConflict ? "incompatible target requirements" : cancelFixture ? "validation failure" : "temporary service unavailable";
    const result = { status: failed ? "failed" : "completed", summary: failed ? failureMessage : "done", error: failed ? failureMessage : null, validation: failed ? [] : ["fake"], requiresInteractive: false, interactiveReason: null };
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { id: "item-" + turnNumber, type: "agentMessage", text: JSON.stringify(result) } } });
    const last = { inputTokens: failed ? 50 : 10, cachedInputTokens: failed ? 0 : 8, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: failed ? 55 : 15 };
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last, total: last, modelContextWindow: 1000 } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  }
}
`,
  "utf8",
);
chmodSync(fake, 0o755);

initializeRepo(root);
git("add", "AGENTS.md");
git("commit", "-m", "activate routing");
const configPath = path.join(root, ".todo", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
writeFileSync(
  configPath,
  JSON.stringify(
    {
      ...config,
      workers: 1,
      pollIntervalMs: 250,
      configReloadIntervalMs: 250,
      dashboardPort: 0,
      retries: 1,
      codexCommand: fake,
      executionBackend: "app-server",
    },
    null,
    2,
  ),
  "utf8",
);
const task = createTask(root, {
  title: "Persistent retry",
  description: "Exercise one retry in the same Codex thread.",
});
bindSupervisor(root, {
  automationId: "todo-app-server-daemon-test",
  targetThreadId: "persistent-monitoring-thread",
  name: "Keep ToDo app-server test running",
  prompt: "Use $todo:supervise in scheduled-run mode.",
  rrule: "FREQ=MINUTELY;INTERVAL=15",
  status: "ACTIVE",
});
const daemon = spawn(process.execPath, [path.join(scriptDir, "daemon.mjs"), "--repo", root], {
  cwd: root,
  env: { ...process.env, FAKE_TRACE: trace },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
daemon.stderr.on("data", (chunk) => {
  stderr += chunk;
});
let deadline = Date.now() + 20000;
let receipt;
while (Date.now() < deadline) {
  receipt = getTaskStatus(root, task.id);
  if (receipt.status === "completed") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(receipt?.status, "completed", stderr || JSON.stringify(receipt));
assert.equal(receipt.codexThread.id, "persistent-task-thread-1");
assert.equal(receipt.codexThread.state, "archived");
assert.equal(receipt.attemptLedger.attempts.length, 2);
assert.equal(receipt.attemptLedger.attempts[0].status, "failed_transient");
assert.equal(receipt.attemptLedger.attempts[1].status, "completed");
assert.equal(receipt.metrics.runs[1].tokenUsage.cachedInputTokens, 8);

writeHistory(root, "900-legacy-active-thread", {
  title: "Legacy active closed thread",
  status: "completed",
  closedAt: new Date().toISOString(),
  codexThread: {
    id: "persistent-legacy-active-thread",
    state: "active",
    createdAt: new Date().toISOString(),
  },
});
deadline = Date.now() + 20000;
let legacyReceipt;
while (Date.now() < deadline) {
  legacyReceipt = getTaskStatus(root, "900");
  if (legacyReceipt.codexThread?.state === "archived") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(legacyReceipt.codexThread.state, "archived");

writeHistory(root, "901-missing-archived-thread", {
  title: "Already archived closed thread",
  status: "completed",
  closedAt: new Date().toISOString(),
  codexThread: {
    id: "persistent-missing-closed-thread",
    state: "active",
    createdAt: new Date().toISOString(),
  },
});
deadline = Date.now() + 20000;
let missingArchivedReceipt;
while (Date.now() < deadline) {
  missingArchivedReceipt = getTaskStatus(root, "901");
  if (missingArchivedReceipt.codexThread?.state === "archived") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(missingArchivedReceipt.codexThread.state, "archived");

const interactiveCleanupTask = createTask(root, {
  title: "Interactive cleanup archive",
  description: "Complete interactively and archive the old worker thread.",
  runMode: "interactive",
});
updateTaskCodexThread(interactiveCleanupTask.path, {
  id: "persistent-interactive-cleanup-thread",
  state: "active",
  createdAt: new Date().toISOString(),
});
const interactiveCleanupClaim = await startInteractiveTask(
  root,
  interactiveCleanupTask.id,
);
let interactiveCleanupReceipt = await finishInteractiveTask(
  root,
  interactiveCleanupTask.id,
  {
    claimToken: interactiveCleanupClaim.claimToken,
    status: "completed",
    summary: "Interactive cleanup completed.",
    validation: ["fake"],
  },
);
assert(
  ["archive-pending", "archived"].includes(
    interactiveCleanupReceipt.codexThread.state,
  ),
);
deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  interactiveCleanupReceipt = getTaskStatus(root, interactiveCleanupTask.id);
  if (interactiveCleanupReceipt.codexThread?.state === "archived") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(interactiveCleanupReceipt.codexThread.state, "archived");

const reopened = reopenTask(root, task.id.split("-")[0]);
assert.equal(reopened.codexThread.state, "unarchive-pending");
deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  receipt = getTaskStatus(root, task.id);
  if (receipt.status === "completed") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(receipt?.status, "completed", stderr || JSON.stringify(receipt));
assert.equal(receipt.codexThread.id, "persistent-task-thread-1");
assert.equal(receipt.codexThread.state, "archived");
assert.equal(receipt.reopenCount, 1);
assert.equal(receipt.priorClosures.length, 1);

writeFileSync(path.join(root, "merge-conflict.txt"), "base\n", "utf8");
git("add", "merge-conflict.txt");
git("commit", "-m", "merge conflict base");
const conflictTask = createTask(root, {
  title: "Reactivate original thread for merge conflict",
  description: "MERGE_CONFLICT_FIXTURE",
  delivery: "merge",
  modelProfile: "fast",
});
deadline = Date.now() + 20000;
let conflictReceipt;
while (Date.now() < deadline) {
  conflictReceipt = getTaskStatus(root, conflictTask.id);
  if (conflictReceipt.status === "completed") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(
  conflictReceipt?.status,
  "completed",
  stderr || JSON.stringify(conflictReceipt),
);
assert.equal(conflictReceipt.execution.modelProfile, "medium");
assert.equal(conflictReceipt.codexThread.id, "persistent-task-thread-2");
assert.equal(conflictReceipt.codexThread.state, "archived");
assert.equal(conflictReceipt.attemptLedger.attempts.length, 2);
assert.equal(conflictReceipt.attemptLedger.attempts[1].status, "completed");
assert.equal(
  conflictReceipt.git.deliveryResult.strategy,
  "rebase-fast-forward",
);
assert.equal(
  readFileSync(path.join(root, "merge-conflict.txt"), "utf8"),
  "main and task\n",
);

writeFileSync(path.join(root, "merge-logical.txt"), "base\n", "utf8");
git("add", "merge-logical.txt");
git("commit", "-m", "logical conflict base");
const logicalConflictTask = createTask(root, {
  title: "Fail an incompatible merge repair",
  description: "MERGE_LOGICAL_CONFLICT_FIXTURE",
  delivery: "merge",
  modelProfile: "fast",
});
deadline = Date.now() + 20000;
let logicalConflictReceipt;
while (Date.now() < deadline) {
  logicalConflictReceipt = getTaskStatus(root, logicalConflictTask.id);
  if (logicalConflictReceipt.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(
  logicalConflictReceipt?.status,
  "failed",
  stderr || JSON.stringify(logicalConflictReceipt),
);
assert.equal(logicalConflictReceipt.error.kind, "merge_logical_conflict");
assert.equal(logicalConflictReceipt.git.phase, "merge-failed");
assert.equal(logicalConflictReceipt.execution.modelProfile, "medium");
assert.equal(
  logicalConflictReceipt.codexThread.id,
  "persistent-task-thread-3",
);
assert.equal(logicalConflictReceipt.codexThread.state, "archived");
assert.equal(logicalConflictReceipt.attemptLedger.attempts.length, 2);
assert.equal(
  logicalConflictReceipt.attemptLedger.attempts[1].status,
  "failed_permanent",
);

const cleanupTask = createTask(root, {
  title: "Merge cleanup and archive",
  description: "MERGE_CLEANUP_FIXTURE",
  delivery: "merge",
});
deadline = Date.now() + 20000;
let cleanupReceipt;
while (Date.now() < deadline) {
  cleanupReceipt = getTaskStatus(root, cleanupTask.id);
  if (cleanupReceipt.status === "completed") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(
  cleanupReceipt?.status,
  "completed",
  stderr || JSON.stringify(cleanupReceipt),
);
assert.equal(cleanupReceipt.codexThread.state, "archived");
assert.equal(
  existsSync(path.join(root, ".todo", "worktrees", cleanupTask.id)),
  false,
);
assert.equal(
  spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${cleanupReceipt.git.branch}`],
    { cwd: root },
  ).status,
  1,
);
assert.equal(readFileSync(path.join(root, "merged.txt"), "utf8"), "merged\n");

const canceledTask = createTask(root, {
  title: "Cancel and archive",
  description: "CANCEL_FIXTURE",
});
deadline = Date.now() + 20000;
let canceledReceipt;
while (Date.now() < deadline) {
  canceledReceipt = getTaskStatus(root, canceledTask.id);
  if (canceledReceipt.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(canceledReceipt?.status, "failed");
assert.equal(canceledReceipt.codexThread.state, "archived");
canceledReceipt = await cancelTask(root, canceledTask.id);
assert.equal(canceledReceipt.codexThread.state, "archived");
deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  canceledReceipt = getTaskStatus(root, canceledTask.id);
  if (canceledReceipt.codexThread?.state === "archived") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(canceledReceipt.codexThread.id, "persistent-task-thread-5");
assert.equal(canceledReceipt.codexThread.state, "archived");

const shutdownTask = createTask(root, {
  title: "Shutdown and archive",
  description: "SHUTDOWN_FIXTURE",
});
deadline = Date.now() + 20000;
let shutdownReceipt;
while (Date.now() < deadline) {
  shutdownReceipt = getTaskStatus(root, shutdownTask.id);
  if (shutdownReceipt.codexThread?.lastTurnId) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(shutdownReceipt?.status, "running");
daemon.kill("SIGINT");
await new Promise((resolve) => daemon.once("close", resolve));
shutdownReceipt = getTaskStatus(root, shutdownTask.id);
assert.equal(shutdownReceipt.codexThread.id, "persistent-task-thread-6");
assert.equal(shutdownReceipt.codexThread.state, "archived");

assert(existsSync(trace));
const requests = readFileSync(trace, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(requests.filter((item) => item.method === "thread/start").length, 6);
assert.equal(requests.filter((item) => item.method === "turn/start").length, 10);
assert.equal(requests.filter((item) => item.method === "thread/archive").length, 14);
assert.equal(requests.filter((item) => item.method === "thread/unarchive").length, 4);
assert.equal(requests.filter((item) => item.method === "turn/interrupt").length, 1);
const titleRequests = requests.filter(
  (item) => item.method === "thread/name/set" && item.params.threadId === "persistent-monitoring-thread",
);
const workerTitles = requests.filter(item => item.method === "thread/name/set" && item.params.threadId.startsWith("persistent-task-thread-"));
assert(workerTitles.length >= 6);
assert(workerTitles.every(item => item.params.name.startsWith(path.basename(root) + " [")));
assert(workerTitles.every(item => /\[\d+\]: .+/.test(item.params.name)));
assert(titleRequests.length >= 3);
assert(
  titleRequests.every(
    (item) => item.params.threadId === "persistent-monitoring-thread",
  ),
);
const titles = titleRequests.map((item) => item.params.name);
assert(titles.includes("-> ToDo (0r / 1q / 0f)"));
assert(titles.includes("-> ToDo (1r / 0q / 0f)"));
assert(titles.some((title) => title.endsWith(" / 1f)")));
assert(
  titles.every((title, index) => index === 0 || title !== titles[index - 1]),
);
assert.deepEqual(
  requests
    .filter(
      (item) =>
        ["thread/archive", "thread/unarchive"].includes(item.method) &&
        item.params.threadId === "persistent-task-thread-1",
    )
    .map((item) => item.method),
  [
    "thread/archive",
    "thread/archive",
    "thread/unarchive",
    "thread/archive",
    "thread/unarchive",
    "thread/archive",
  ],
);
const persistentTurns = requests.filter(
  (item) =>
    item.method === "turn/start" &&
    item.params.threadId === "persistent-task-thread-1",
);
assert.match(persistentTurns[0].params.input[0].text, /Exercise one retry/);
assert.doesNotMatch(persistentTurns[1].params.input[0].text, /Exercise one retry/);
assert.match(persistentTurns[1].params.input[0].text, /Reuse the task requirements/);
assert.match(persistentTurns[2].params.input[0].text, /Reuse the task requirements/);
const mergeConflictTurns = requests.filter(
  (item) =>
    item.method === "turn/start" &&
    item.params.threadId === "persistent-task-thread-2",
);
assert.equal(mergeConflictTurns.length, 2);
assert.match(
  mergeConflictTurns[0].params.input[0].text,
  /MERGE_CONFLICT_FIXTURE/,
);
assert.match(
  mergeConflictTurns[1].params.input[0].text,
  /merge-conflict repair attempt/,
);
assert.match(
  mergeConflictTurns[1].params.input[0].text,
  /preserving the newer target-branch functionality/,
);
assert.equal(
  new Set(
    requests
      .filter((item) => item.method === "turn/start")
      .map((item) => item.params.threadId),
  ).size,
  6,
);

process.stdout.write("todo app-server daemon test passed\n");
