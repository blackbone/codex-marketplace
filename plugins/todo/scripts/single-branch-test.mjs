import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeRepo, createTask, startInteractiveTask, finishInteractiveTask, getTaskStatus,
  loadConfig, cleanupStaleClaims, claimTask, releaseClaim, retryTask, recordTaskChangedFiles,
  readTask, writeTask, finalizeTaskGit, markTaskModelCompleted, completeTask, taskMetrics, emptyTokenUsage, cumulativeTaskMetrics } from "./lib.mjs";
import { executionCwd, commitSingleBranch, singleBranchPlan, withRepositoryExecution, recoverSingleBranchHead } from "./single-branch.mjs";
const lib = new URL("./lib.mjs", import.meta.url).href;
function git(root, ...args) {
  const p = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr); return p.stdout.trim();
}
function fixture(t, mode = "single-branch") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "todo-single-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, ".gitignore"), "Library/\ncache/\n");
  writeFileSync(path.join(root, "foreign.txt"), "original\n");
  git(root, "add", "."); git(root, "commit", "-m", "fixture");
  initializeRepo(root); git(root, "add", "AGENTS.md"); git(root, "commit", "-m", "routing");
  config(root, { workers: 8, git: { executionMode: mode, delivery: "merge", targetBranch: "does-not-exist" } });
  mkdirSync(path.join(root, "Library")); writeFileSync(path.join(root, "Library", "cache.bin"), "valuable cache");
  return root;
}
function config(root, change) {
  const file = path.join(root, ".todo", "config.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), ...change }));
}
const make = (root, title, extra = {}) => createTask(root, { title, description: "Scoped fixture", runMode: "interactive", ...extra });
const done = (root, task, run, changedFiles) => finishInteractiveTask(root, task.id, {
  claimToken: run.claimToken, status: "completed", summary: "Done", validation: ["Verified fixture"], changedFiles,
});

test("two dependent tasks keep the current directory/branch, foreign index and Unity cache", async t => {
  const root = fixture(t);
  writeFileSync(path.join(root, "foreign.txt"), "foreign staged\n"); git(root, "add", "foreign.txt");
  writeFileSync(path.join(root, "foreign.txt"), "foreign unstaged\n");
  writeFileSync(path.join(root, "personal.txt"), "personal\n");
  const foreignIndex = git(root, "ls-files", "--stage", "foreign.txt");
  const branches = git(root, "branch", "--list"), worktrees = git(root, "worktree", "list", "--porcelain");
  const one = make(root, "One"), two = make(root, "Two", { blockers: [one.id] });
  await assert.rejects(startInteractiveTask(root, two.id), /blocked by/);
  assert.equal(loadConfig(root).workers, 1);
  for (const task of [one, two]) {
    const run = await startInteractiveTask(root, task.id);
    assert.equal(run.worktreePath, root);
    assert.match(run.executionInstructions, /Unity.*Editor project path/);
    assert.equal(git(root, "branch", "--show-current"), "main");
    writeFileSync(path.join(root, `${task.id}.txt`), "task\n");
    const receipt = await done(root, task, run, [`${task.id}.txt`]);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.git.executionMode, "single-branch");
    assert.equal(receipt.git.deliveryResult.delivery, "current-branch");
    assert.deepEqual(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n"), [`${task.id}.txt`]);
    assert.equal(git(root, "ls-files", "--stage", "foreign.txt"), foreignIndex);
  }
  assert.equal(readFileSync(path.join(root, "foreign.txt"), "utf8"), "foreign unstaged\n");
  assert.equal(readFileSync(path.join(root, "personal.txt"), "utf8"), "personal\n");
  assert.equal(readFileSync(path.join(root, "Library", "cache.bin"), "utf8"), "valuable cache");
  assert.equal(git(root, "branch", "--list"), branches);
  assert.equal(git(root, "worktree", "list", "--porcelain").replace(/HEAD [a-f0-9]+/, "HEAD"), worktrees.replace(/HEAD [a-f0-9]+/, "HEAD"));
  assert.equal(existsSync(path.join(root, ".todo", "worktrees")), false);
});

test("different threads/processes and linked copies cannot run concurrently; failure reserves the task", async t => {
  const root = fixture(t), one = make(root, "Owner"), two = make(root, "Other");
  const run = await startInteractiveTask(root, one.id, { owner: { threadId: "one", turnId: "one-turn" } });
  await assert.rejects(startInteractiveTask(root, one.id, { owner: { threadId: "two", turnId: "two-turn" } }), /running/);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { startInteractiveTask } from ${JSON.stringify(lib)}; try { await startInteractiveTask(${JSON.stringify(root)}, ${JSON.stringify(two.id)}); process.exit(1); } catch(e) { console.log(e.message); }`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /reserved/);
  writeFileSync(path.join(root, "partial.txt"), "retained\n");
  await finishInteractiveTask(root, one.id, { claimToken: run.claimToken, owner: { threadId: "one", turnId: "one-turn" }, status: "failed", summary: "fixture failure", error: "fixture failure" });
  await assert.rejects(startInteractiveTask(root, two.id), /reserved/);
  const resumed = await startInteractiveTask(root, one.id);
  assert.equal(readFileSync(path.join(root, "partial.txt"), "utf8"), "retained\n");
  await done(root, one, resumed, ["partial.txt"]);
  const next = await startInteractiveTask(root, two.id); await done(root, two, next, []);
});

test("direct local build and launch preserve an active reservation and its task delivery", async t => {
  const root = fixture(t), owner = make(root, "Active implementation"), other = make(root, "Other implementation");
  const run = await startInteractiveTask(root, owner.id);
  writeFileSync(path.join(root, "foreign.txt"), "worker changes in progress\n");
  const reservationFile = path.join(root, ".git", "todo-execution.json");
  const reservation = readFileSync(reservationFile);
  const claim = readFileSync(`${owner.path}.lock`);
  const taskBody = readFileSync(owner.path);
  const head = git(root, "rev-parse", "HEAD");
  const index = git(root, "ls-files", "--stage");

  // A small build fixture generates a runnable artifact and a report from the
  // current source, using only ignored outputs and no ToDo claim or state edits.
  const build = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    mkdirSync('cache', { recursive: true });
    const source = readFileSync('foreign.txt', 'utf8');
    writeFileSync('cache/preview.mjs', 'console.log(' + JSON.stringify(source.trim()) + ');');
    writeFileSync('cache/build.log', 'Local build complete');
  `], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const launch = spawnSync(process.execPath, ["cache/preview.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout.trim(), "worker changes in progress");
  assert.deepEqual(readFileSync(reservationFile), reservation);
  assert.deepEqual(readFileSync(`${owner.path}.lock`), claim);
  assert.deepEqual(readFileSync(owner.path), taskBody);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "ls-files", "--stage"), index);
  await assert.rejects(startInteractiveTask(root, other.id), error => {
    assert.equal(error.kind, "single_branch_reserved");
    assert.match(error.message, /Local builds, tests, and previews without project edits run directly/);
    return true;
  });
  const receipt = await done(root, owner, run, ["foreign.txt"]);
  assert.equal(receipt.status, "completed");
  assert.equal(readFileSync(path.join(root, "cache/build.log"), "utf8"), "Local build complete");
  assert.equal(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "foreign.txt");
});

test("crash preserves partial work, requires explicit recovery and never releases another owner's claim", async t => {
  const root = fixture(t), one = make(root, "Crash"), two = make(root, "Next");
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", `import { startInteractiveTask } from ${JSON.stringify(lib)}; import {writeFileSync} from 'node:fs'; const run = await startInteractiveTask(${JSON.stringify(root)}, ${JSON.stringify(one.id)}); writeFileSync(${JSON.stringify(path.join(root, "partial.txt"))}, 'crash work'); console.log(JSON.stringify(run));`], { encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr); const old = JSON.parse(p.stdout);
  cleanupStaleClaims(root);
  await assert.rejects(startInteractiveTask(root, two.id), /reserved/);
  await assert.rejects(startInteractiveTask(root, one.id), /Unreviewed/);
  retryTask(root, one.id); // Explicit ownership review acknowledgement, existing retry mechanism.
  const run = await startInteractiveTask(root, one.id);
  releaseClaim({ lockPath: `${one.path}.lock`, token: old.claimToken });
  assert(existsSync(`${one.path}.lock`));
  await assert.rejects(startInteractiveTask(root, two.id), /reserved/);
  assert.equal(readFileSync(path.join(root, "partial.txt"), "utf8"), "crash work");
  await done(root, one, run, ["partial.txt"]);
});

test("editing a dirty API commits its latest complete contents while unrelated edits stay out", async t => {
  const root = fixture(t);
  writeFileSync(path.join(root, "foreign.txt"), "API v2 staged\n"); git(root, "add", "foreign.txt");
  writeFileSync(path.join(root, "foreign.txt"), "API v3 unstaged\n");
  const task = make(root, "Use latest API"), run = await startInteractiveTask(root, task.id);
  const current = readFileSync(path.join(root, "foreign.txt"), "utf8");
  assert.equal(current, "API v3 unstaged\n");
  writeFileSync(path.join(root, "foreign.txt"), current + "Task implementation\n");
  writeFileSync(path.join(root, "personal.txt"), "new foreign staged work\n"); git(root, "add", "personal.txt");
  writeFileSync(path.join(root, "personal.txt"), "new foreign unstaged work\n");
  const index = git(root, "ls-files", "--stage", "personal.txt");
  const result = await done(root, task, run, ["foreign.txt"]);
  assert.equal(result.status, "completed");
  assert.equal(git(root, "show", "HEAD:foreign.txt"), "API v3 unstaged\nTask implementation");
  assert.equal(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "foreign.txt");
  assert.equal(git(root, "ls-files", "--stage", "personal.txt"), index);
  assert.equal(readFileSync(path.join(root, "personal.txt"), "utf8"), "new foreign unstaged work\n");
  assert.equal(git(root, "diff", "HEAD", "--", "foreign.txt"), "");
  assert.equal(readFileSync(path.join(root, "Library", "cache.bin"), "utf8"), "valuable cache");
});

test("files modified after review still stop without committing or cleaning", async t => {
  const otherRoot = fixture(t), other = make(otherRoot, "Review");
  const claim = claimTask(other.path, "test-worker");
  const { prepareTaskGit } = await import("./lib.mjs"); await prepareTaskGit(otherRoot, other.path);
  writeFileSync(path.join(otherRoot, "owned.txt"), "reviewed");
  recordTaskChangedFiles(otherRoot, other.path, { changedFiles: ["owned.txt"] });
  writeFileSync(path.join(otherRoot, "owned.txt"), "later external edit");
  const saved = readTask(other.path);
  assert.throws(() => commitSingleBranch(singleBranchPlan(otherRoot, saved), saved), /after task review/);
  releaseClaim(claim);
});

test("mode changes do not migrate started tasks, and invalid mode fails closed", async t => {
  const root = fixture(t, "worktree"); config(root, { git: { delivery: "keep", targetBranch: "main" } });
  const first = make(root, "Old mode"), second = make(root, "New mode");
  const legacy = readTask(second.path); delete legacy.metadata.git; writeTask(legacy);
  const firstRun = await startInteractiveTask(root, first.id);
  assert.notEqual(firstRun.worktreePath, root);
  config(root, { git: { executionMode: "single-branch", delivery: "merge" } });
  await assert.rejects(startInteractiveTask(root, second.id), /executor is already active/);
  await done(root, first, firstRun, []);
  const secondRun = await startInteractiveTask(root, second.id); assert.equal(secondRun.worktreePath, root);
  config(root, { git: { executionMode: "worktree", delivery: "keep", targetBranch: "main" } });
  const third = make(root, "Later mode");
  await assert.rejects(startInteractiveTask(root, third.id), /reserved/);
  await done(root, second, secondRun, []);
  config(root, { git: { executionMode: "typo" } });
  assert.match(loadConfig(root).readError, /git.executionMode/);
  assert.throws(() => claimTask(third.path, "test"), /git.executionMode/);
});

test("shell cwd symlinks cannot point at another Unity copy", t => {
  const root = fixture(t), outside = fixture(t);
  symlinkSync(outside, path.join(root, "other-copy"));
  assert.throws(() => executionCwd(root, "other-copy", "single-branch"), /leaves the working copy/);
  assert.equal(executionCwd(root, "Library", "single-branch"), path.join(root, "Library"));
});

test("recovery after committing does not create a second commit or model attempt", async t => {
  const root = fixture(t), task = make(root, "Commit recovery");
  const run = await startInteractiveTask(root, task.id);
  const claim = { ...JSON.parse(readFileSync(`${task.path}.lock`)), lockPath: `${task.path}.lock` };
  writeFileSync(path.join(root, "result.txt"), "committed once");
  markTaskModelCompleted(task.path, claim, { status: "completed", summary: "done", validation: ["checked"], changedFiles: ["result.txt"] }, cumulativeTaskMetrics(null, taskMetrics(Date.now() - 1, Date.now(), emptyTokenUsage())), null);
  const saved = readTask(task.path); saved.metadata.git.phase = "committing"; writeTask(saved);
  const committed = commitSingleBranch(singleBranchPlan(root, saved), saved);
  releaseClaim(claim); // Simulate missing phase journal after successful Git commit.
  const resumed = await startInteractiveTask(root, task.id); assert(resumed.deliveryOnly);
  const receipt = await done(root, task, resumed, undefined);
  assert.equal(receipt.status, "completed");
  assert.equal(git(root, "rev-parse", "HEAD"), committed.headCommit);
  assert.equal(receipt.attemptLedger.attempts.length, 1);
});

test("cancellation preserves foreign baseline and successful tasks leave unreported edits uncommitted", async t => {
  const { cancelTask } = await import("./lib.mjs");
  const root = fixture(t), task = make(root, "Cancellation");
  writeFileSync(path.join(root, "personal.txt"), "foreign");
  const run = await startInteractiveTask(root, task.id);
  await finishInteractiveTask(root, task.id, { claimToken: run.claimToken, status: "failed", summary: "paused" });
  assert.equal((await cancelTask(root, task.id)).status, "canceled");
  assert.equal(readFileSync(path.join(root, "personal.txt"), "utf8"), "foreign");
  const other = make(root, "Unattributed"), next = await startInteractiveTask(root, other.id);
  writeFileSync(path.join(root, "unknown.txt"), "unreviewed work");
  const head = git(root, "rev-parse", "HEAD");
  assert.equal((await done(root, other, next, [])).status, "completed");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(path.join(root, "unknown.txt"), "utf8"), "unreviewed work");
  const last = make(root, "Continue with dirty copy"), lastRun = await startInteractiveTask(root, last.id);
  writeFileSync(path.join(root, "personal.txt"), "updated foreign work during the task");
  writeFileSync(path.join(root, "own.txt"), "task work");
  assert.equal((await done(root, last, lastRun, ["own.txt"])).status, "completed");
  assert.equal(readFileSync(path.join(root, "personal.txt"), "utf8"), "updated foreign work during the task");
  assert.equal(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "own.txt");
});

test("a live orphan executor prevents takeover even after its claim process is gone", async t => {
  const { recordSingleBranchExecutor } = await import("./single-branch.mjs");
  const root = fixture(t), task = make(root, "Orphan executor");
  const run = await startInteractiveTask(root, task.id);
  const claim = { token: run.claimToken, lockPath: `${task.path}.lock` };
  recordSingleBranchExecutor(root, task.path, claim, "app-server", { pid: process.pid });
  const owner = JSON.parse(readFileSync(claim.lockPath));
  writeFileSync(claim.lockPath, JSON.stringify({ ...owner, pid: 99999999 }));
  assert.deepEqual(cleanupStaleClaims(root), []);
  assert(existsSync(claim.lockPath));
  releaseClaim(claim);
  assert.throws(() => retryTask(root, task.id), /executor may still be running/);
  // Authoritative executor termination notification, not PID-based takeover.
  withRepositoryExecution(root, (state, save) => { state.reservation.executors = {}; save(state); });
  retryTask(root, task.id);
  const resumed = await startInteractiveTask(root, task.id); await done(root, task, resumed, []);
});

test("a linked checkout cannot bypass the common Git-directory reservation", async t => {
  const root = fixture(t), task = make(root, "Original copy");
  const linked = path.join(root, "cache", "linked");
  git(root, "worktree", "add", "-b", "existing-copy", linked);
  initializeRepo(linked); config(linked, { git: { executionMode: "single-branch", delivery: "keep" } });
  const other = make(linked, "Another copy");
  const run = await startInteractiveTask(root, task.id);
  await assert.rejects(startInteractiveTask(linked, other.id), /reserved/);
  await done(root, task, run, []);
});

test("simultaneous process claims select one executor", async t => {
  const root = fixture(t), tasks = [make(root, "Race one"), make(root, "Race two")];
  const results = await Promise.all(tasks.map(task => new Promise((resolve, reject) => {
    const code = `import {startInteractiveTask} from ${JSON.stringify(lib)};
      try { await startInteractiveTask(${JSON.stringify(root)}, ${JSON.stringify(task.id)}); console.log('won'); }
      catch (e) { console.log(e.kind || e.message); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
    let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.on("error", reject); child.on("close", code => code ? reject(new Error(stderr)) : resolve(stdout.trim()));
  })));
  assert.equal(results.filter(r => r === "won").length, 1);
  assert(results.includes("single_branch_reserved"));
});

test("a crash after history publication releases only the completed reservation", async t => {
  const root = fixture(t), task = make(root, "Closed crash"), next = make(root, "After close");
  const code = `import * as todo from ${JSON.stringify(lib)};
    const root = ${JSON.stringify(root)}, id = ${JSON.stringify(task.id)}, file = ${JSON.stringify(task.path)};
    const run = await todo.startInteractiveTask(root, id);
    const claim = { ...JSON.parse((await import('node:fs')).readFileSync(file + '.lock')), lockPath: file + '.lock' };
    const metrics = todo.cumulativeTaskMetrics(null, todo.taskMetrics(Date.now()-1, Date.now(), todo.emptyTokenUsage()));
    todo.markTaskModelCompleted(file, claim, { status:'completed', summary:'done', validation:['checked'], changedFiles:[] }, metrics, null);
    const result = await todo.finalizeTaskGit(root, file);
    todo.completeTask(root, file, result.result, metrics);
    // Exit before releasing the claim, as in the completion crash window.
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert(existsSync(`${task.path}.lock`));
  writeFileSync(path.join(root, "foreign.txt"), "user edit after completion");
  const resumed = await startInteractiveTask(root, next.id);
  assert.equal(existsSync(`${task.path}.lock`), false);
  await done(root, next, resumed, []);
});

test("explicit HEAD recovery preserves manual commits, dirty index, models and task history", async t => {
  const root = fixture(t), task = make(root, "Manual commit"), next = make(root, "Next");
  const run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(root, "api.txt"), "latest API\n");
  await finishInteractiveTask(root, task.id, { claimToken: run.claimToken, status: "failed", summary: "paused" });
  git(root, "add", "api.txt"); git(root, "commit", "-m", "manual API commit");
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "foreign.txt"), "staged personal work"); git(root, "add", "foreign.txt");
  writeFileSync(path.join(root, "foreign.txt"), "unstaged personal work");
  const index = git(root, "ls-files", "--stage");
  const execution = readTask(task.path).metadata.execution;
  const server = path.join(path.dirname(new URL(import.meta.url).pathname), "mcp-server.mjs");
  const rpc = spawnSync(process.execPath, [server], { encoding: "utf8", timeout: 15000,
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_retry", arguments: { repoPath: root, id: task.id, acceptCurrentHead: head } } },
    ].map(JSON.stringify).join("\n") + "\n" });
  assert.equal(rpc.status, 0, rpc.stderr);
  const messages = rpc.stdout.trim().split("\n").map(JSON.parse);
  assert(messages.find(m => m.id === 2).result.tools.find(t => t.name === "task_retry").inputSchema.properties.acceptCurrentHead);
  const response = messages.find(m => m.id === 3).result;
  assert(!response.isError, JSON.stringify(response));
  const recovery = JSON.parse(response.content[0].text);
  assert.notEqual(recovery.status, "running");
  let saved = readTask(task.path);
  assert.equal(saved.metadata.git.baseCommit, head);
  // A plain retry may escalate; accepting HEAD itself preserves the chosen settings.
  assert.deepEqual(saved.metadata.execution, execution);
  assert.equal(saved.metadata.nextAttemptTrigger, "head_recovery");
  const history = JSON.stringify(saved.metadata.git.headRecoveries);
  retryTask(root, task.id, { acceptCurrentHead: head });
  assert.equal(JSON.stringify(readTask(task.path).metadata.git.headRecoveries), history);
  assert.equal(git(root, "ls-files", "--stage"), index);
  await assert.rejects(startInteractiveTask(root, next.id), /reserved/);
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal(resumed.expectedHead, head);
  assert.match(resumed.executionInstructions, /Recovery after explicitly accepting manual commits/);
  const receipt = await done(root, task, resumed, []);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.attemptLedger.attempts.at(-1).trigger, "head_recovery");
  assert.equal(git(root, "rev-parse", "HEAD"), head, 'no duplicate commit');
  assert.equal(git(root, "ls-files", "--stage"), index);
  assert.equal(readFileSync(path.join(root, "Library/cache.bin"), "utf8"), "valuable cache");
});

test("HEAD recovery invalidates a completed model result and requires fresh review", async t => {
  const root = fixture(t), task = make(root, "Recover finalizer");
  const run = await startInteractiveTask(root, task.id);
  const claim = { ...JSON.parse(readFileSync(`${task.path}.lock`)), lockPath: `${task.path}.lock` };
  writeFileSync(path.join(root, "api.txt"), "implemented");
  markTaskModelCompleted(task.path, claim, { status: "completed", summary: "implemented", validation: ["old check"], changedFiles: ["api.txt"] }, cumulativeTaskMetrics(null, taskMetrics(Date.now()-1, Date.now(), emptyTokenUsage())), null);
  releaseClaim(claim);
  git(root, "add", "api.txt"); git(root, "commit", "-m", "manual implementation");
  const head = git(root, "rev-parse", "HEAD"), ledger = readTask(task.path).metadata.attemptLedger;
  retryTask(root, task.id, { acceptCurrentHead: head });
  const recovered = readTask(task.path);
  assert.equal(recovered.metadata.git.pendingResult, undefined);
  assert.deepEqual(recovered.metadata.git.ownedFiles, {});
  assert.deepEqual(recovered.metadata.attemptLedger, ledger);
  retryTask(root, task.id); // Another ordinary retry must not erase the pending recovery trigger.
  assert.equal(readTask(task.path).metadata.nextAttemptTrigger, "head_recovery");
  assert.deepEqual(readTask(task.path).metadata.execution, recovered.metadata.execution);
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal(resumed.deliveryOnly, false);
  const receipt = await done(root, task, resumed, []);
  assert.deepEqual(receipt.attemptLedger.attempts.map(a => a.trigger), ["initial", "head_recovery"]);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
});

test("HEAD adoption rejects stale SHA, worktree mode, another branch and active or uncertain ownership", async t => {
  const root = fixture(t), task = make(root, "Guard recovery");
  const run = await startInteractiveTask(root, task.id), head = git(root, "rev-parse", "HEAD");
  assert.throws(() => retryTask(root, task.id, { acceptCurrentHead: head }), /running/);
  await finishInteractiveTask(root, task.id, { claimToken: run.claimToken, status: "failed", summary: "paused" });
  for (const value of [true, "HEAD", head.slice(0,7)]) assert.throws(() => retryTask(root, task.id, { acceptCurrentHead: value }), /full reviewed commit SHA/);
  assert.throws(() => retryTask(root, task.id, { trigger: "automatic_retry", acceptCurrentHead: head }), /explicit manual retry/);
  const before = readFileSync(task.path, "utf8");
  assert.throws(() => retryTask(root, task.id, { acceptCurrentHead: "a".repeat(40) }), /is stale/);
  assert.equal(readFileSync(task.path, "utf8"), before);
  withRepositoryExecution(root, (state, save) => { state.reservation.executors = { old: { pid: 99999999, uncertain: true } }; save(state); });
  assert.throws(() => retryTask(root, task.id, { acceptCurrentHead: head }), /executor may still be running/);
  withRepositoryExecution(root, (state, save) => { state.reservation.executors = {}; save(state); });
  git(root, "switch", "-c", "other");
  assert.throws(() => retryTask(root, task.id, { acceptCurrentHead: head }), /Expected current branch/);
  git(root, "switch", "main");
  writeFileSync(path.join(root, ".git/MERGE_HEAD"), head);
  assert.throws(() => retryTask(root, task.id, { acceptCurrentHead: head }), /active Git operation/);
  rmSync(path.join(root, ".git/MERGE_HEAD"));
  const legacy = fixture(t, "worktree"); config(legacy, { git: { executionMode: "worktree", delivery: "keep", targetBranch: "main" } });
  const other = make(legacy, "Worktree");
  assert.throws(() => retryTask(legacy, other.id, { acceptCurrentHead: git(legacy,"rev-parse","HEAD") }), /already started single-branch/);
});

test("interrupted HEAD adoption resumes its journal without duplicating a recovery", async t => {
  const root = fixture(t), task = make(root, "Recovery journal");
  const run = await startInteractiveTask(root, task.id);
  await finishInteractiveTask(root, task.id, { claimToken: run.claimToken, status: "failed", summary: "paused" });
  git(root, "commit", "--amend", "-m", "manual amendment");
  const head = git(root, "rev-parse", "HEAD");
  const claim = claimTask(task.path, "task-retry", { recoverSingleBranch: "head" });
  const saved = readTask(task.path);
  assert.throws(() => recoverSingleBranchHead(singleBranchPlan(root, saved), saved, head, () => { throw new Error("crash before task write"); }), /crash before task write/);
  const id = withRepositoryExecution(root, state => state.reservation.headRecovery.id);
  releaseClaim(claim);
  retryTask(root, task.id, { acceptCurrentHead: head });
  assert.equal(readTask(task.path).metadata.git.headRecoveries[0].id, id);
  const resumed = await startInteractiveTask(root, task.id); await done(root, task, resumed, []);
});

test("HEAD recovery discards a ready pipeline checkpoint and keeps mandatory gates pending", async t => {
  const root = fixture(t);
  writeFileSync(path.join(root, "recovery.yaml"), `version: 1
name: recover
steps:
  - id: inspect-existing
    type: codex-thread
    modelProfile: expert
    prompt: Inspect the retained implementation.
  - id: mandatory
    type: shell
    command: node --check api.mjs
    timeoutSeconds: 30
`);
  config(root, { pipeline: { file: "recovery.yaml" } });
  const task = make(root, "Pipeline recovery"), run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(root, "api.mjs"), "export const api = 2;\n");
  await done(root, task, run, ["api.mjs"]);
  assert.equal(readTask(task.path).metadata.pipelineContinuation.ready, true);
  git(root, "add", "api.mjs"); git(root, "commit", "-m", "manual API");
  const head = git(root, "rev-parse", "HEAD");
  retryTask(root, task.id, { acceptCurrentHead: head });
  assert.equal(readTask(task.path).metadata.pipelineContinuation, undefined);
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal(resumed.pipelineStage.id, "inspect-existing");
  assert.equal(resumed.requiresPipelineValidation, true);
  assert.equal(resumed.deliveryOnly, false);
  const pending = await done(root, task, resumed, []);
  assert.notEqual(pending.status, "completed");
  assert.equal(readTask(task.path).metadata.pipelineContinuation.nextIndex, 1);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
});

test("competing recovery processes publish a single HEAD acceptance", async t => {
  const root = fixture(t), task = make(root, "Competing recovery");
  const run = await startInteractiveTask(root, task.id);
  await finishInteractiveTask(root, task.id, { claimToken: run.claimToken, status: "failed", summary: "paused" });
  git(root, "commit", "--allow-empty", "-m", "manual commit");
  const head = git(root, "rev-parse", "HEAD");
  const code = `import {retryTask} from ${JSON.stringify(lib)};
    try { retryTask(${JSON.stringify(root)}, ${JSON.stringify(task.id)}, {acceptCurrentHead:${JSON.stringify(head)}}); console.log('accepted'); }
    catch(e) { console.log(e.message); }`;
  const results = await Promise.all([1,2].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
    let output = "", error = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => error += chunk);
    child.on("error", reject); child.on("close", status => status === 0 ? resolve(output.trim()) : reject(new Error(error)));
  })));
  assert(results.includes("accepted"));
  for (const result of results) assert.match(result, /accepted|Task is running|registry is busy|executor is already active/);
  const recovered = readTask(task.path);
  assert.equal(recovered.metadata.git.baseCommit, head);
  assert.equal(recovered.metadata.git.headRecoveries.length, 1);
});

test("outside commits during execution requeue review without a failed attempt or duplicate task", async t => {
  const root = fixture(t), task = make(root, "Concurrent HEAD"), next = make(root, "Next");
  const run = await startInteractiveTask(root, task.id);
  const execution = readTask(task.path).metadata.execution;
  writeFileSync(path.join(root, "owned.txt"), "retained task work");
  writeFileSync(path.join(root, "manual.txt"), "outside commit");
  git(root, "add", "manual.txt"); git(root, "commit", "-m", "outside");
  const outside = git(root, "rev-parse", "HEAD");
  const pending = await done(root, task, run, ["owned.txt"]);
  assert.notEqual(pending.status, "completed");
  assert.equal(pending.error, null);
  assert.equal(pending.attemptLedger.deliveryAttempts.length, 0);
  assert.equal(readTask(task.path).metadata.git.baseCommit, outside);
  await assert.rejects(startInteractiveTask(root, next.id), /reserved/);
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal(resumed.deliveryOnly, false);
  assert.match(resumed.executionInstructions, /Concurrent edits or commits/);
  assert.match(resumed.executionInstructions, /owned.txt/);
  const receipt = await done(root, task, resumed, ["owned.txt"]);
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.execution, execution);
  assert.deepEqual(receipt.attemptLedger.attempts.map(a => [a.trigger, a.status]), [["initial", "completed"], ["workspace_refresh", "completed"]]);
  assert.equal(receipt.attemptLedger.retryStats.manualRetries, 0);
  assert.equal(git(root, "rev-parse", "HEAD^"), outside);
  assert.equal(git(root, "show", "HEAD:manual.txt"), "outside commit");
});

test("a reviewed file changed concurrently gets reviewed again, preserving foreign staging and caches", async t => {
  const root = fixture(t), task = make(root, "Concurrent file");
  await startInteractiveTask(root, task.id);
  const claim = { ...JSON.parse(readFileSync(`${task.path}.lock`)), lockPath: `${task.path}.lock` };
  writeFileSync(path.join(root, "owned.txt"), "task implementation");
  markTaskModelCompleted(task.path, claim, { status: "completed", summary: "done", validation: ["checked"], changedFiles: ["owned.txt"] }, cumulativeTaskMetrics(null, taskMetrics(Date.now()-1, Date.now(), emptyTokenUsage())), null);
  writeFileSync(path.join(root, "owned.txt"), "task implementation plus outside API");
  writeFileSync(path.join(root, "foreign.txt"), "foreign staged"); git(root, "add", "foreign.txt");
  const index = git(root, "ls-files", "--stage", "foreign.txt"), head = git(root, "rev-parse", "HEAD");
  const pending = await finalizeTaskGit(root, task.path);
  assert.equal(pending.reviewRequired, true);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  releaseClaim(claim);
  const resumed = await startInteractiveTask(root, task.id);
  const receipt = await done(root, task, resumed, ["owned.txt"]);
  assert.equal(receipt.status, "completed");
  assert.equal(git(root, "show", "HEAD:owned.txt"), "task implementation plus outside API");
  assert.equal(git(root, "ls-files", "--stage", "foreign.txt"), index);
  assert.equal(readFileSync(path.join(root, "Library/cache.bin"), "utf8"), "valuable cache");
  assert.equal(receipt.attemptLedger.deliveryAttempts.length, 1);
});

test("outside edits and amended HEAD while paused resume automatically in the same copy", async t => {
  const root = fixture(t), task = make(root, "Paused drift");
  const run = await startInteractiveTask(root, task.id);
  await finishInteractiveTask(root, task.id, { claimToken: run.claimToken, status: "failed", summary: "paused" });
  writeFileSync(path.join(root, "foreign.txt"), "outside edit while paused");
  git(root, "commit", "--amend", "-m", "amended routing");
  const head = git(root, "rev-parse", "HEAD");
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal(resumed.expectedHead, head);
  assert.equal(resumed.worktreePath, root);
  assert.equal((await done(root, task, resumed, [])).status, "completed");
  assert.equal(readFileSync(path.join(root, "foreign.txt"), "utf8"), "outside edit while paused");
});

test("external commit from another process during commit hooks is never overwritten", async t => {
  const root = fixture(t), task = make(root, "Commit race");
  const run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(root, "owned.txt"), "task work");
  const hook = path.join(root, ".git/hooks/pre-commit");
  writeFileSync(hook, `#!/bin/sh
if [ ! -f Library/race ]; then
  touch Library/race
  printf 'outside commit' > manual.txt
  env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE git add manual.txt
  env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE git -c core.hooksPath=/dev/null commit --only manual.txt -m external
fi
`, { mode: 0o755 });
  const pending = await done(root, task, run, ["owned.txt"]);
  assert.notEqual(pending.status, "completed");
  assert.equal(pending.error, null);
  assert.equal(git(root, "log", "-1", "--format=%s"), "external");
  assert.equal(git(root, "show", "HEAD:manual.txt"), "outside commit");
  assert.equal(readFileSync(path.join(root, "owned.txt"), "utf8"), "task work");
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal((await done(root, task, resumed, ["owned.txt"])).status, "completed");
  assert.equal(git(root, "show", "HEAD:manual.txt"), "outside commit");
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "4");
  assert.equal(git(root, "worktree", "list", "--porcelain").match(/worktree /g).length, 1);
});

for (const drift of ["head", "file"]) test(`paused pipeline discards stale gates after concurrent ${drift} changes`, async t => {
  const root = fixture(t);
  writeFileSync(path.join(root, "review.yaml"), `version: 1
name: review
steps:
  - id: inspect-current
    type: codex-thread
    modelProfile: expert
    prompt: Inspect retained code.
  - id: mandatory
    type: shell
    command: node --check api.mjs
    timeoutSeconds: 30
`);
  config(root, { pipeline: { file: "review.yaml" } });
  const task = make(root, `Paused pipeline ${drift}`), run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(root, "api.mjs"), "export const api = 1;\n");
  await done(root, task, run, ["api.mjs"]);
  assert.equal(readTask(task.path).metadata.pipelineContinuation.ready, true);
  if (drift === "head") {
    git(root, "add", "api.mjs"); git(root, "commit", "-m", "outside");
  } else writeFileSync(path.join(root, "api.mjs"), "export const api = 2;\n");
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal(resumed.pipelineStage.id, "inspect-current");
  assert.equal(readTask(task.path).metadata.pipelineContinuation.ready, undefined);
  const pending = await done(root, task, resumed, ["api.mjs"]);
  assert.notEqual(pending.status, "completed");
  assert.equal(pending.error, null);
  assert.equal(pending.attemptLedger.attempts.at(-1).trigger, "workspace_refresh");
  assert.equal(readTask(task.path).metadata.pipelineContinuation.nextIndex, 1);
});

function submoduleFixture(t) {
  const root = fixture(t), source = fixture(t);
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'server');
  git(root, 'commit', '-am', 'register server');
  const server = path.join(root, 'server');
  git(server, 'config', 'user.name', 'Test'); git(server, 'config', 'user.email', 'test@example.invalid');
  return { root, server };
}

test('submodule snapshot detects dirty files, staging and HEAD even with ignore=all', async t => {
  const { workspaceSnapshot } = await import('./single-branch.mjs');
  const { root, server } = submoduleFixture(t);
  git(root, 'config', 'submodule.server.ignore', 'all');
  const clean = workspaceSnapshot(root);
  writeFileSync(path.join(server, 'foreign.txt'), 'dirty');
  const dirty = workspaceSnapshot(root);
  assert.notDeepEqual(clean, dirty); assert(dirty.files['server/foreign.txt']);
  git(server, 'add', 'foreign.txt'); assert.notDeepEqual(workspaceSnapshot(root), dirty);
  git(server, 'commit', '-m', 'outside');
  assert.notEqual(workspaceSnapshot(root).repositories.server.head, clean.repositories.server.head);
  const task = make(root, 'Dirty claim'), run = await startInteractiveTask(root, task.id);
  await done(root, task, run, []);
});

test('submodule and parent delivery preserve foreign staged, unstaged and untracked files', async t => {
  const { root, server } = submoduleFixture(t);
  git(server, 'checkout', '--detach'); // Normal initialized submodules can be detached.
  const indexes = [];
  for (const repo of [root, server]) {
    writeFileSync(path.join(repo, 'foreign.txt'), 'foreign staged'); git(repo, 'add', 'foreign.txt');
    writeFileSync(path.join(repo, 'foreign.txt'), 'foreign unstaged');
    writeFileSync(path.join(repo, 'personal.txt'), 'foreign untracked');
    indexes.push(git(repo, 'ls-files', '--stage', 'foreign.txt'));
  }
  const task = make(root, 'Both repos'), run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(root, 'client.txt'), 'client'); writeFileSync(path.join(server, 'api.txt'), 'server');
  const result = await done(root, task, run, ['client.txt', 'server/api.txt']);
  assert.equal(result.status, 'completed');
  assert.equal(git(root, 'rev-parse', 'HEAD:server'), git(server, 'rev-parse', 'HEAD'));
  assert.equal(git(server, 'show', 'HEAD:api.txt'), 'server');
  assert.equal(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'client.txt\nserver');
  [root, server].forEach((repo, i) => {
    assert.equal(git(repo, 'ls-files', '--stage', 'foreign.txt'), indexes[i]);
    assert.equal(readFileSync(path.join(repo, 'foreign.txt'), 'utf8'), 'foreign unstaged');
    assert.equal(readFileSync(path.join(repo, 'personal.txt'), 'utf8'), 'foreign untracked');
  });
});

for (const drift of ['file', 'head']) test(`submodule concurrent ${drift} invalidates review on the same task`, async t => {
  const { root, server } = submoduleFixture(t), task = make(root, 'Concurrent server');
  await startInteractiveTask(root, task.id);
  const claim = { ...JSON.parse(readFileSync(`${task.path}.lock`)), lockPath: `${task.path}.lock` };
  writeFileSync(path.join(server, 'api.txt'), 'reviewed');
  markTaskModelCompleted(task.path, claim, { status: 'completed', summary: 'done', changedFiles: ['server/api.txt'] }, cumulativeTaskMetrics(null, taskMetrics(Date.now()-1, Date.now(), emptyTokenUsage())), null);
  if (drift === 'file') writeFileSync(path.join(server, 'api.txt'), 'concurrent');
  else { writeFileSync(path.join(server, 'manual.txt'), 'outside'); git(server, 'add', 'manual.txt'); git(server, 'commit', '-m', 'outside'); }
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal((await finalizeTaskGit(root, task.path)).reviewRequired, true);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  releaseClaim(claim);
  const run = await startInteractiveTask(root, task.id);
  assert.equal((await done(root, task, run, ['server/api.txt'])).status, 'completed');
});

test('partial submodule commit retries finalization once without losing either repository or foreign staging', async t => {
  const { root, server } = submoduleFixture(t), task = make(root, 'Partial delivery');
  const run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(root, 'client.txt'), 'client'); writeFileSync(path.join(server, 'api.txt'), 'server');
  const hook = path.join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const base = git(root, 'rev-parse', 'HEAD'), count = Number(git(server, 'rev-list', '--count', 'HEAD'));
  await assert.rejects(done(root, task, run, ['client.txt', 'server/api.txt']));
  assert.equal(getTaskStatus(root, task.id).status, 'failed'); assert.equal(existsSync(`${task.path}.lock`), false);
  const committed = git(server, 'rev-parse', 'HEAD');
  assert.equal(Number(git(server, 'rev-list', '--count', 'HEAD')), count + 1);
  assert.equal(git(root, 'rev-parse', 'HEAD'), base);
  rmSync(hook);
  retryTask(root, task.id);
  const resumed = await startInteractiveTask(root, task.id); assert(resumed.deliveryOnly);
  assert.equal((await done(root, task, resumed, undefined)).status, 'completed');
  assert.equal(git(server, 'rev-parse', 'HEAD'), committed);
  assert.equal(git(root, 'rev-parse', 'HEAD:server'), committed);
});

test('legacy nested ownedFiles retry and claim succeed then require fresh review', async t => {
  const { root, server } = submoduleFixture(t), task = make(root, 'Legacy 1283');
  await startInteractiveTask(root, task.id);
  const claim = { ...JSON.parse(readFileSync(`${task.path}.lock`)), lockPath: `${task.path}.lock` };
  writeFileSync(path.join(server, 'api.txt'), 'retained');
  markTaskModelCompleted(task.path, claim, { status: 'completed', summary: 'done', changedFiles: ['server/api.txt'] }, cumulativeTaskMetrics(null, taskMetrics(Date.now()-1, Date.now(), emptyTokenUsage())), null);
  const old = readTask(task.path); delete old.metadata.git.reviewedRepositories; old.metadata.git.phase = 'committing'; writeTask(old);
  releaseClaim(claim);
  retryTask(root, task.id);
  const run = await startInteractiveTask(root, task.id);
  const pending = await done(root, task, run, undefined);
  assert.notEqual(pending.status, 'completed');
  assert(readTask(task.path).metadata.git.reviewFiles.includes('server/api.txt'));
  const resumed = await startInteractiveTask(root, task.id);
  assert.equal((await done(root, task, resumed, ['server/api.txt'])).status, 'completed');
});

test('snapshot failure releases finished claim and keeps reservation recoverable', async t => {
  const root = fixture(t), task = make(root, 'Snapshot failure');
  const run = await startInteractiveTask(root, task.id);
  // An unregistered nested repository is still forbidden, not silently ignored.
  const nested = path.join(root, 'unknown'); mkdirSync(nested); git(nested, 'init', '-b', 'main');
  writeFileSync(path.join(nested, 'file'), 'retained'); git(nested, 'add', 'file');
  await finishInteractiveTask(root, task.id, { claimToken: run.claimToken, status: 'failed', summary: 'stopped' });
  assert.equal(existsSync(`${task.path}.lock`), false);
  assert.equal(getTaskStatus(root, task.id).status, 'failed');
  withRepositoryExecution(root, state => { assert.equal(state.reservation.checkpoint, null); assert(state.reservation.checkpointError); });
});

test('submodule HEAD changed during execution is detected before delivery', async t => {
  const { root, server } = submoduleFixture(t), task = make(root, 'Server drift during work');
  const run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(server, 'manual.txt'), 'outside'); git(server, 'add', 'manual.txt'); git(server, 'commit', '-m', 'outside');
  writeFileSync(path.join(server, 'api.txt'), 'task');
  assert.notEqual((await done(root, task, run, ['server/api.txt'])).status, 'completed');
  assert.equal(readTask(task.path).metadata.nextAttemptTrigger, 'workspace_refresh');
});

test('foreign staged gitlink is preserved and blocks implicit gitlink delivery', async t => {
  const { root, server } = submoduleFixture(t);
  const original = git(server, 'rev-parse', 'HEAD');
  git(server, 'commit', '--allow-empty', '-m', 'foreign staged head');
  git(root, 'add', 'server'); const staged = git(root, 'ls-files', '--stage', 'server');
  git(server, 'checkout', '--detach', original);
  const task = make(root, 'Foreign gitlink'), run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(server, 'api.txt'), 'task');
  assert.notEqual((await done(root, task, run, ['server/api.txt'])).status, 'completed');
  assert.equal(git(root, 'ls-files', '--stage', 'server'), staged);
  assert.equal(git(server, 'rev-parse', 'HEAD'), original);
});

test('concurrent submodule commit from a hook is preserved without publishing stale tree', async t => {
  const { root, server } = submoduleFixture(t), task = make(root, 'Server hook race');
  const run = await startInteractiveTask(root, task.id);
  writeFileSync(path.join(server, 'api.txt'), 'task');
  const hook = path.resolve(server, git(server, 'rev-parse', '--git-path', 'hooks/pre-commit'));
  writeFileSync(hook, `#!/bin/sh
printf outside > manual.txt
env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE git add manual.txt
env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE git -c core.hooksPath=/dev/null commit --only manual.txt -m outside
`, { mode: 0o755 });
  assert.notEqual((await done(root, task, run, ['server/api.txt'])).status, 'completed');
  assert.equal(git(server, 'log', '-1', '--format=%s'), 'outside');
  assert.equal(git(server, 'show', 'HEAD:manual.txt'), 'outside');
  assert.equal(readFileSync(path.join(server, 'api.txt'), 'utf8'), 'task');
});

test('finalizer snapshot failure records failed delivery and releases claim without caller error fallback', async t => {
  const root = fixture(t), task = make(root, 'Finalizer snapshot error');
  await startInteractiveTask(root, task.id);
  const claim = { ...JSON.parse(readFileSync(`${task.path}.lock`)), lockPath: `${task.path}.lock` };
  writeFileSync(path.join(root, 'owned.txt'), 'reviewed');
  markTaskModelCompleted(task.path, claim, { status: 'completed', summary: 'done', changedFiles: ['owned.txt'] }, cumulativeTaskMetrics(null, taskMetrics(Date.now()-1, Date.now(), emptyTokenUsage())), null);
  writeFileSync(path.join(root, 'owned.txt'), 'concurrent');
  const nested = path.join(root, 'unknown'); mkdirSync(nested); git(nested, 'init', '-b', 'main');
  writeFileSync(path.join(nested, 'file'), 'retained'); git(nested, 'add', 'file');
  await assert.rejects(finalizeTaskGit(root, task.path));
  releaseClaim(claim);
  assert.equal(getTaskStatus(root, task.id).status, 'failed');
  assert.equal(existsSync(`${task.path}.lock`), false);
  assert(readTask(task.path).metadata.git.deliveryError);
});
