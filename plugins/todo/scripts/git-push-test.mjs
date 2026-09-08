import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeRepo, loadConfig, createTask, claimTask, releaseClaim,
  prepareTaskGit, markTaskModelCompleted, finalizeTaskGit, processTaskMergeQueue,
  readTask, writeTask, retryTask, taskMetrics, emptyTokenUsage, cumulativeTaskMetrics,
} from "./lib.mjs";

function fixture(t, delivery, push) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "todo-push-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo");
  const remote = path.join(directory, "remote.git");
  function gitAt(cwd, ...args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  gitAt(directory, "init", "-b", "main", root);
  const git = (...args) => gitAt(root, ...args);
  git("config", "user.name", "ToDo push test");
  git("config", "user.email", "todo@example.invalid");
  writeFileSync(path.join(root, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  initializeRepo(root);
  git("add", "AGENTS.md");
  git("commit", "-qm", "activate todo");
  gitAt(directory, "init", "--bare", remote);
  git("remote", "add", "publish", remote);
  git("push", "publish", "main");
  const base = git("rev-parse", "main");
  const configPath = path.join(root, ".todo", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  function configure(value) {
    writeFileSync(configPath, JSON.stringify({ ...config,
      git: { delivery, targetBranch: "main", remote: "publish",
        ...(value === undefined ? {} : { push: value }) } }));
  }
  configure(push);
  const remoteHead = branch => {
    const result = spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${branch}`],
      { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  async function prepare({ changed = true, legacy = false } = {}) {
    const task = createTask(root, { title: "Publish result", description: "Push fixture" });
    if (legacy) {
      const stored = readTask(task.path);
      delete stored.metadata.git.push;
      writeTask(stored);
    }
    const claim = claimTask(task.path, "fixture-model", { modelAttempt: true });
    const prepared = await prepareTaskGit(root, task.path);
    if (changed) writeFileSync(path.join(prepared.worktreePath, "result.txt"), "result\n");
    markTaskModelCompleted(task.path, claim, { summary: "done", validation: ["fixture"] },
      cumulativeTaskMetrics(null, taskMetrics(Date.now(), Date.now(), emptyTokenUsage())), null);
    releaseClaim(claim);
    return { ...task, prepared };
  }
  async function deliver(task) {
    if (readTask(task.path).metadata.git.phase !== "merge-queued") {
      await finalizeTaskGit(root, task.path);
    }
    if (delivery === "merge") await processTaskMergeQueue(root, task.path);
    return readTask(task.path).metadata.git;
  }
  return { root, remote, git, base, configure, prepare, deliver, remoteHead };
}

for (const delivery of ["keep", "merge"]) {
  for (const push of [undefined, false, true]) {
    test(`${delivery}: git.push=${push} delivers the correct ref`, async t => {
      const f = fixture(t, delivery, push);
      assert.equal(loadConfig(f.root).git.push, push === true);
      const task = await f.prepare();
      // Captured policy wins over a later repository setting, in both directions.
      f.configure(push !== true);
      const result = await f.deliver(task);
      const branch = delivery === "keep" ? task.git.branch : "main";
      assert.equal(result.phase, "delivered");
      assert.equal(result.deliveryResult.pushResult.status, push === true ? "pushed" : "local");
      assert.equal(f.remoteHead(branch), push === true ? result.headCommit : delivery === "merge" ? f.base : null);
      if (delivery === "keep") assert.equal(f.remoteHead("main"), f.base);
      else assert.equal(f.remoteHead(task.git.branch), null);
      assert.equal(readTask(task.path).metadata.attemptLedger.attempts.length, 1);
    });
  }

  test(`${delivery}: legacy task stays local when config enables push`, async t => {
    const f = fixture(t, delivery, true);
    const task = await f.prepare({ legacy: true });
    const result = await f.deliver(task);
    assert.equal(result.deliveryResult.pushResult.status, "local");
    assert.equal(f.remoteHead("main"), f.base);
    assert.equal(f.remoteHead(task.git.branch), null);
  });

  test(`${delivery}: rejected push preserves rebased commit and retries delivery only`, async t => {
    const f = fixture(t, delivery, true);
    const task = await f.prepare();
    if (delivery === "merge") {
      // Force a rebase so the failure must journal the NEW commit for recovery.
      writeFileSync(path.join(f.root, "advance.txt"), "advance\n");
      f.git("add", "advance.txt");
      f.git("commit", "-qm", "advance target");
    }
    const hook = path.join(f.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho private-remote-output >&2\nexit 1\n", { mode: 0o755 });
    await assert.rejects(f.deliver(task), error => {
      assert.equal(error.kind, "git_push_failed");
      assert(!JSON.stringify(error).includes("private-remote-output"));
      return true;
    });
    const failed = readTask(task.path).metadata.git;
    assert.equal(failed.phase, delivery === "merge" ? "merge-failed" : "committed");
    assert(existsSync(task.prepared.worktreePath));
    assert.equal(f.git("rev-parse", task.git.branch), failed.headCommit);
    if (delivery === "merge") assert.equal(f.git("rev-parse", "main"), failed.headCommit);
    assert.equal(f.remoteHead("main"), f.base);
    rmSync(hook);
    retryTask(f.root, task.id);
    const result = await f.deliver(task);
    assert.equal(result.headCommit, failed.headCommit);
    assert.equal(f.remoteHead(delivery === "keep" ? task.git.branch : "main"), result.headCommit);
    const ledger = readTask(task.path).metadata.attemptLedger;
    assert.equal(ledger.attempts.length, 1);
    assert.equal(ledger.deliveryAttempts.length, 2);
    // Repeating an accepted finalizer must not commit or publish a second time.
    await finalizeTaskGit(f.root, task.path);
    assert.equal(readTask(task.path).metadata.attemptLedger.deliveryAttempts.length, 2);
  });

  test(`${delivery}: divergent remote is never force-pushed`, async t => {
    const f = fixture(t, delivery, true);
    const task = await f.prepare();
    const remoteBranch = delivery === "keep" ? task.git.branch : "main";
    const divergent = f.git("commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "remote change");
    f.git("push", "publish", `${divergent}:refs/heads/${remoteBranch}`);
    await assert.rejects(f.deliver(task), { kind: "git_push_failed" });
    assert.equal(f.remoteHead(remoteBranch), divergent);
    assert(existsSync(task.prepared.worktreePath));
  });
}

test("keep: no-change task is pushed and its local branch is retained", async t => {
  const f = fixture(t, "keep", true);
  const task = await f.prepare({ changed: false });
  const result = await f.deliver(task);
  assert.equal(result.noChanges, true);
  assert.equal(f.remoteHead(task.git.branch), f.base);
  assert.equal(f.git("rev-parse", task.git.branch), f.base);
});

test("invalid push configuration fails closed", t => {
  const f = fixture(t, "keep", "true");
  assert.match(loadConfig(f.root).readError, /git.push must be a boolean/);
  assert.throws(() => createTask(f.root, { title: "Invalid", description: "Invalid" }), /git.push must be a boolean/);
});

test("push rejects invalid remote config instead of falling back to origin", t => {
  const f = fixture(t, "keep", true);
  const file = path.join(f.root, ".todo", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.git.remote = "--invalid";
  writeFileSync(file, JSON.stringify(config));
  assert.match(loadConfig(f.root).readError, /fallback push remote/);
});

test("snapshot validates push type and preserves explicit false", t => {
  const f = fixture(t, "keep", true);
  const options = { title: "Snapshot", description: "Snapshot fixture",
    gitSnapshot: { delivery: "keep", targetBranch: "main", remote: "publish", push: "false" } };
  assert.throws(() => createTask(f.root, options), /gitSnapshot is invalid/);
  options.gitSnapshot.push = false;
  assert.equal(createTask(f.root, options).git.push, false);
});
