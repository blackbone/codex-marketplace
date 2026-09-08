import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readLogTail } from "./bounded-log.mjs";
import { runShellCommand } from "./shell-step.mjs";
import { initializeRepo, createTask, prepareTaskGit, markTaskModelCompleted, finalizeTaskGit,
  processTaskMergeQueue, finishTaskMergeConflictRepair, getTaskStatus, retryTask, claimTask, beginModelAttempt, releaseClaim, cumulativeTaskMetrics, taskMetrics, emptyTokenUsage } from "./lib.mjs";

test("log tails use bounded byte reads for huge sparse files and preserve UTF-8", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-log-test-"));
  try {
    const file = path.join(root, "huge.log"), fd = openSync(file, "w");
    writeSync(fd, Buffer.from("а".repeat(3000) + "END"), 0, 6003, 512 * 1024 * 1024);
    closeSync(fd);
    const before = process.memoryUsage().rss;
    const text = readLogTail(file, 1000);
    assert.ok(text.endsWith("END"));
    assert.ok(!text.includes("�"));
    assert.ok(Buffer.byteLength(text) <= 1000);
    assert.ok(process.memoryUsage().rss - before < 32 * 1024 * 1024);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shell timeout kills descendants that ignore SIGTERM before returning", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-tree-test-"));
  let pid;
  try {
    writeFileSync(path.join(root, "child.cjs"), `const fs=require('node:fs');fs.writeFileSync('pid',String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>fs.writeFileSync('escaped','yes'),3000);setInterval(()=>{},1000);`);
    const result = await runShellCommand({ command: "node child.cjs & wait", cwd: root, env: process.env,
      timeoutSeconds: 0.2, stdoutPath: path.join(root, "stdout"), stderrPath: path.join(root, "stderr") });
    pid = Number(readFileSync(path.join(root, "pid"), "utf8"));
    assert.equal(result.status, "failed");
    assert.equal(result.timedOut, true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(existsSync(path.join(root, "escaped")), false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-conflict merge reruns snapshotted gates and a retry cannot bypass a failed gate", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-merge-gates-"));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  try {
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(path.join(root, "value.txt"), "base\n");
    writeFileSync(path.join(root, "check.cjs"), `const fs=require('node:fs'),path=require('node:path');const root=process.env.TODO_RUNNER_REPO_ROOT;fs.appendFileSync(path.join(root,'.todo/gates'),'run\\n');if(!fs.existsSync(path.join(root,'.todo/allow')))process.exit(1);if(fs.readFileSync('value.txt','utf8')!=='main and task\\n')process.exit(2);`);
    writeFileSync(path.join(root, "quality.yaml"), 'version: 1\nsteps:\n  - id: check\n    type: shell\n    command: node check.cjs\n');
    initializeRepo(root);
    git("add", "."); git("commit", "-m", "fixture");
    const cfg = path.join(root, ".todo/config.json");
    writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), pipeline: { file: "quality.yaml" } }));
    const task = createTask(root, { title: "Merge with gates", description: "Test", delivery: "merge" });
    const prepared = await prepareTaskGit(root, task.path);
    writeFileSync(path.join(prepared.worktreePath, "value.txt"), "task\n");
    const claim = claimTask(task.path, 1);
    beginModelAttempt(task.path, claim);
    const metrics = cumulativeTaskMetrics(null, taskMetrics(Date.now(), Date.now(), emptyTokenUsage()));
    markTaskModelCompleted(task.path, claim, { summary: "done", validation: ["initial pass"] }, metrics, null);
    releaseClaim(claim);
    await finalizeTaskGit(root, task.path);
    writeFileSync(path.join(root, "value.txt"), "main\n"); git("add", "value.txt"); git("commit", "-m", "advance main");
    const before = git("rev-parse", "HEAD");
    assert.equal((await processTaskMergeQueue(root, task.path)).status, "conflict");
    writeFileSync(path.join(prepared.worktreePath, "value.txt"), "main and task\n");
    const repairClaim = claimTask(task.path, "merge-repair");
    beginModelAttempt(task.path, repairClaim);
    await finishTaskMergeConflictRepair(root, task.path, repairClaim, { status: "completed", summary: "resolved", validation: [] }, metrics);
    releaseClaim(repairClaim);
    assert.equal((await processTaskMergeQueue(root, task.path)).status, "conflict");
    assert.equal(git("rev-parse", "HEAD"), before);
    assert.equal(getTaskStatus(root, task.id).git.phase, "merge-conflict");
    writeFileSync(path.join(root, ".todo/allow"), "yes");
    const gateRepair = claimTask(task.path, "merge-repair");
    beginModelAttempt(task.path, gateRepair);
    await finishTaskMergeConflictRepair(root, task.path, gateRepair, { status: "completed", summary: "gate repaired", validation: [] }, metrics);
    releaseClaim(gateRepair);
    const merged = await processTaskMergeQueue(root, task.path);
    assert.equal(merged.status, "merged");
    assert.equal(merged.delivery.pipelineValidation.headCommit, git("rev-parse", "HEAD"));
    assert.equal(merged.delivery.pipelineValidation.gates, 1);
    assert.equal(readFileSync(path.join(root, ".todo/gates"), "utf8"), "run\nrun\n");
    assert.equal(readFileSync(path.join(root, "value.txt"), "utf8"), "main and task\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
