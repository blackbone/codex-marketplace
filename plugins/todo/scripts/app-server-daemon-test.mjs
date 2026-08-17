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
  cancelTask,
  createTask,
  getTaskStatus,
  initializeRepo,
  reopenTask,
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
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.FAKE_TRACE;
let turnNumber = 0;
let threadNumber = 0;
let archiveFailures = 1;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(trace, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "thread/start") { threadNumber += 1; send({ id: message.id, result: { thread: { id: "persistent-task-thread-" + threadNumber } } }); }
  else if (message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  else if (message.method === "thread/archive") {
    if (archiveFailures > 0) {
      archiveFailures -= 1;
      send({ id: message.id, error: { code: -32000, message: "temporary archive failure" } });
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
    const shutdownFixture = message.params.input.some((item) => item.text?.includes("SHUTDOWN_FIXTURE"));
    if (cleanupFixture) {
      writeFileSync(message.params.cwd + "/merged.txt", "merged\\n");
      writeFileSync(message.params.cwd + "/build.tmp", "discard after merge\\n");
    }
    if (shutdownFixture) continue;
    const failed = turnNumber === 1 || cancelFixture;
    const failureMessage = cancelFixture ? "validation failure" : "temporary service unavailable";
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
assert.equal(canceledReceipt.codexThread.id, "persistent-task-thread-3");
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
assert.equal(shutdownReceipt.codexThread.id, "persistent-task-thread-4");
assert.equal(shutdownReceipt.codexThread.state, "archived");

assert(existsSync(trace));
const requests = readFileSync(trace, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(requests.filter((item) => item.method === "thread/start").length, 4);
assert.equal(requests.filter((item) => item.method === "turn/start").length, 6);
assert.equal(requests.filter((item) => item.method === "thread/archive").length, 7);
assert.equal(requests.filter((item) => item.method === "thread/unarchive").length, 2);
assert.equal(requests.filter((item) => item.method === "turn/interrupt").length, 1);
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
assert.equal(
  new Set(
    requests
      .filter((item) => item.method === "turn/start")
      .map((item) => item.params.threadId),
  ).size,
  4,
);

process.stdout.write("todo app-server daemon test passed\n");
