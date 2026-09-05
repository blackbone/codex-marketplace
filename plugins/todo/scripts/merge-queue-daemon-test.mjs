// Fixture runners must never contact the user's native Codex app.
delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireTaskBatchGate, releaseTaskBatchGate, claimTask, releaseClaim,
  createTask, initializeRepo, prepareTaskGit, markTaskModelCompleted,
  finalizeTaskGit, getTaskStatus, readDaemonState, readTask, writeTask,
  taskMetrics, emptyTokenUsage, cumulativeTaskMetrics,
} from "./lib.mjs";
import { requestDaemonRestart, daemonRestartRequestPath } from "./runtime-update.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonScript = process.env.TODO_TEST_DAEMON_SCRIPT || path.join(scriptDir, "daemon.mjs");
const root = mkdtempSync(path.join(os.tmpdir(), "todo-merge-restart-"));
const children = [];
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || args.join(" "));
  return result.stdout.trim();
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`${message}\n${children.map(child => child.output).join("\n")}`);
}
function start(onOutput = () => {}) {
  const child = spawn(process.execPath, [daemonScript, "--repo", root], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
    child.output += data;
    onOutput(child);
  });
  children.push(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, "daemon did not stop");
}
function assertNoLocks() {
  assert(!readdirSync(path.join(root, ".todo")).some(name => name.endsWith(".lock")), "restart fixture has locks");
}
async function prepared(title, options = {}) {
  const task = createTask(root, { title, description: title, delivery: "merge", ...options });
  const claim = claimTask(task.path, "fixture-model", { modelAttempt: true });
  const worktree = await prepareTaskGit(root, task.path);
  writeFileSync(path.join(worktree.worktreePath, `${task.id}.txt`), `${title}\n`);
  markTaskModelCompleted(task.path, claim, { summary: title, validation: ["fixture validated"] },
    cumulativeTaskMetrics(null, taskMetrics(Date.now(), Date.now(), emptyTokenUsage())), null);
  releaseClaim(claim);
  const stored = readTask(task.path);
  stored.metadata.codexThread = { id: `archived-${task.id}`, state: "archived", createdAt: new Date().toISOString(), archivedAt: new Date().toISOString() };
  writeTask(stored);
  return task;
}
function events(child, event) {
  return child.output.split("\n").filter(line => line.includes(`event=${event} `));
}

try {
  git("init", "-b", "main");
  git("config", "user.name", "ToDo Merge Test");
  git("config", "user.email", "todo-merge@example.invalid");
  writeFileSync(path.join(root, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-qm", "base");
  initializeRepo(root);
  git("add", "AGENTS.md");
  git("commit", "-qm", "activate todo");
  const configPath = path.join(root, ".todo", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, workers: 1, pollIntervalMs: 250,
    configReloadIntervalMs: 250, dashboardPort: 0, retries: 0, executionBackend: "app-server",
    git: { delivery: "merge", targetBranch: "main", remote: "origin" },
    codexCommand: path.join(root, "must-not-start-model-or-archived-thread") }));

  const batchId = "restart-order";
  const first = await prepared("First", { batchId });
  const second = await prepared("Second", { batchId, blockers: [first.id] });
  const third = await prepared("Third", { batchId });
  // Faster later sibling is ready before the first daemon even starts.
  await finalizeTaskGit(root, third.path);
  const thirdAttemptId = readTask(third.path).metadata.git.deliveryAttemptId;
  let requested = false;
  const firstDaemon = start(child => {
    if (!requested && child.output.includes("event=delivery_start ")) {
      requested = true;
      requestDaemonRestart(root, readDaemonState(root), {
        pluginVersion: "intermediate-runtime", fingerprint: "sha256:intermediate-runtime",
      }, "regression: update after implementation, before merge");
    }
  });
  await waitFor(() => firstDaemon.exitCode !== null, "first daemon did not drain for runtime update");
  assert.equal(firstDaemon.exitCode, 0);
  assert(requested);
  assert.match(firstDaemon.output, /event=runtime_update_ready /);
  assert.equal(events(firstDaemon, "merge_queue_start").length, 0);
  assert.equal(getTaskStatus(root, first.id).status, "merge-queued");
  assert.equal(getTaskStatus(root, second.id).status, "blocked");
  assert.equal(getTaskStatus(root, third.id).status, "merge-queued");
  const firstGit = readTask(first.path).metadata.git;
  assert(firstGit.headCommit && firstGit.deliveryAttemptId && firstGit.pendingResult);
  assert.equal(readTask(first.path).metadata.codexThread.state, "archived");
  assertNoLocks();
  assert(existsSync(daemonRestartRequestPath(root)));

  const secondDaemon = start();
  await waitFor(() => [first, second, third].every(task => getTaskStatus(root, task.id).status === "completed"),
    "successor did not recover queued delivery and unblock its batch");
  await stop(secondDaemon);
  assert.match(secondDaemon.output, /event=runtime_update_request_retired /);
  assert(!existsSync(daemonRestartRequestPath(root)));
  assertNoLocks();
  const receipts = [first, second, third].map(task => getTaskStatus(root, task.id));
  for (const receipt of receipts) {
    assert.equal(receipt.attemptLedger.deliveryAttempts.length, 1, "duplicate delivery attempt");
    assert.equal(receipt.attemptLedger.deliveryAttempts[0].status, "completed");
    assert.equal(receipt.git.deliveryResult.strategy, "rebase-fast-forward");
    assert.equal(receipt.codexThread.state, "archived");
    assert.equal(receipt.attemptLedger.attempts.length, 1, "recovery repeated model execution");
    git("merge-base", "--is-ancestor", receipt.git.headCommit, "main");
    assert.equal(events(secondDaemon, "merge_queue_start").filter(line => line.includes(`task="${receipt.id}"`)).length, 1);
    assert.equal(events(secondDaemon, "merge_queue_merged").filter(line => line.includes(`task="${receipt.id}"`)).length, 1);
  }
  assert.equal(receipts[0].attemptLedger.deliveryAttempts[0].attemptId, firstGit.deliveryAttemptId);
  assert.equal(receipts[2].attemptLedger.deliveryAttempts[0].attemptId, thirdAttemptId);
  assert.equal(receipts[0].summary, firstGit.pendingResult.summary);
  for (let i = 1; i < receipts.length; i++) {
    git("merge-base", "--is-ancestor", receipts[i - 1].git.headCommit, receipts[i].git.headCommit);
  }
  assert.equal(git("rev-list", "--merges", "main"), "");
  const deliveredHead = git("rev-parse", "main");

  // Plain restart, with neither a restart request nor task/batch claim locks.
  const fourth = await prepared("Fourth");
  await finalizeTaskGit(root, fourth.path);
  assertNoLocks();
  const thirdDaemon = start();
  await waitFor(() => getTaskStatus(root, fourth.id).status === "completed", "plain restart did not pick up queued work");
  git("merge-base", "--is-ancestor", deliveredHead, "main");
  for (const task of [first, second, third]) {
    assert.equal(getTaskStatus(root, task.id).attemptLedger.deliveryAttempts.length, 1);
  }

  // Ordinary polls must pick up work added after startup, report specific
  // stable waits once, and notice gate/claim removal without a daemon restart.
  const fifth = await prepared("Fifth", { runMode: "interactive" });
  const claim = claimTask(fifth.path, "test-owner");
  const gate = acquireTaskBatchGate(root, { purpose: "regression-publication" });
  await finalizeTaskGit(root, fifth.path);
  await waitFor(() => thirdDaemon.output.includes('"reason":"task_batch_active"'), "missing batch wait diagnostic");
  const batchWaits = events(thirdDaemon, "merge_queue_waiting").length;
  await sleep(800);
  assert.equal(events(thirdDaemon, "merge_queue_waiting").length, batchWaits, "wait diagnostic repeated every poll");
  releaseTaskBatchGate(gate);
  await waitFor(() => thirdDaemon.output.includes('"reason":"task_claimed"'), "missing claim wait diagnostic");
  releaseClaim(claim);
  await waitFor(() => getTaskStatus(root, fifth.id).status === "completed", "normal poll did not pick up existing merge queue");
  await stop(thirdDaemon);
  assertNoLocks();
  assert.equal(events(thirdDaemon, "merge_queue_merged").length, 2, "restart redelivered closed tasks");
  assert.equal(getTaskStatus(root, fifth.id).attemptLedger.deliveryAttempts.length, 1);
  git("merge-base", "--is-ancestor", getTaskStatus(root, fourth.id).git.headCommit, "main");
  process.stdout.write("merge queue daemon restart tests passed (runtime update, plain restart, poll recovery, batch ancestry, attempt identity)\n");
} finally {
  for (const child of children) await stop(child);
  if (process.env.TODO_KEEP_TEST_FIXTURE) process.stderr.write(`fixture: ${root}\n`);
  else rmSync(root, { recursive: true, force: true });
}
