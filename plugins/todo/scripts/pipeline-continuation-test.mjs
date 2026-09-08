// Isolated daemon regression: never contact the native app or a real model.
delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beginPipelineContinuation, claimTask, createTask, finishInteractiveTask, getTaskStatus,
  initializeRepo, markTaskModelCompleted, readTask, releaseClaim, retryTask, setTaskError,
  startInteractiveTask, writeTask } from "./lib.mjs";
import { appendModelAttempt } from "./attempt-ledger.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), "todo-continuation-"));
let daemon;
let output = "";
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    assert.equal(daemon?.exitCode, null, output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out: ${output}`);
}
function start() {
  daemon = spawn(process.execPath, [path.join(scripts, "daemon.mjs"), "--repo", root], {
    cwd: root, env: { ...process.env, FIXTURE_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", chunk => { output += chunk; });
  daemon.stderr.on("data", chunk => { output += chunk; });
}
async function stop() {
  if (daemon?.exitCode === null && daemon?.signalCode === null) {
    const closed = once(daemon, "close");
    daemon.kill("SIGINT");
    await closed;
  }
}
try {
  git("init", "-b", "main");
  git("config", "user.name", "Continuation Test");
  git("config", "user.email", "todo@example.invalid");
  writeFileSync(path.join(root, ".gitignore"), "codex\nmodel-calls\nshell-calls\nfail-gate\n");
  writeFileSync(path.join(root, "pipeline.yaml"), `version: 1
steps:
  - id: implement
    type: codex-exec
    prompt: Implement once
  - id: backend-tests
    type: shell
    command: node check.mjs backend
  - id: frontend-tests
    type: shell
    command: node check.mjs frontend
`);
  writeFileSync(path.join(root, "check.mjs"), `import { appendFileSync, existsSync } from "node:fs";
const root = process.env.FIXTURE_ROOT;
appendFileSync(root + "/shell-calls", process.argv[2] + "\\n");
if (process.argv[2] === "frontend" && existsSync(root + "/fail-gate")) {
  console.error("CONTINUATION_GATE_FAILURE"); process.exit(1);
}
`);
  const fake = path.join(root, "codex");
  writeFileSync(fake, `#!/usr/bin/env node
import { fakeModelList } from ${JSON.stringify(new URL("./model-catalog-test.mjs", import.meta.url).href)};
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] !== "app-server") process.exit(64);
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line); if (message.id == null) continue;
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "continuation-thread" } } });
  } else if (message.method === "turn/start") {
    appendFileSync(process.env.FIXTURE_ROOT + "/model-calls", "implement\\n");
    writeFileSync(message.params.cwd + "/implementation.txt", "preserved implementation\\n");
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: {threadId: message.params.threadId, turnId: "turn-1", item: {id:"result",type:"agentMessage",text:"invalid result"}} });
    send({ method: "turn/completed", params: {threadId: message.params.threadId, turn:{id:"turn-1",status:"completed",items:[]}} });
  } else send({ id: message.id, result: message.method === "model/list" ? fakeModelList() : {} });
}

`);
  chmodSync(fake, 0o755);
  git("add", ".gitignore", "pipeline.yaml", "check.mjs");
  git("commit", "-m", "fixture");
  initializeRepo(root);
  git("add", "AGENTS.md");
  git("commit", "-m", "activate todo");
  const configPath = path.join(root, ".todo", "config.json");
  const config = JSON.parse(readFileSync(configPath));
  writeFileSync(configPath, JSON.stringify({ ...config, workers: 1, retries: 0,
    pollIntervalMs: 100, configReloadIntervalMs: 100, dashboardPort: 0,
    codexCommand: fake, pipeline: { file: "pipeline.yaml" },
    git: { ...config.git, delivery: "merge", targetBranch: "main" } }));
  const task = createTask(root, { title: "Continue accepted implementation", description: "Preserve work and run gates" });
  const dependent = createTask(root, { title: "Dependent", description: "Wait for delivery", blockers: [path.basename(task.path)], runMode: "interactive" });
  start();
  await waitFor(() => getTaskStatus(root, task.id).status === "failed");
  await stop();
  const run = await startInteractiveTask(root, task.id);
  const accepted = await finishInteractiveTask(root, task.id, { claimToken: run.claimToken,
    status: "completed", summary: "Accept existing implementation", validation: ["Existing changes reviewed"] });
  assert.equal(accepted.status, "queued");
  assert.deepEqual(accepted.attemptLedger.attempts.map(a => a.status), ["failed_permanent", "completed"]);
  const attempts = accepted.attemptLedger.attempts;
  assert.equal(readFileSync(path.join(run.worktreePath, "implementation.txt"), "utf8"), "preserved implementation\n");
  assert.equal(getTaskStatus(root, dependent.id).status, "blocked");
  const claim = claimTask(task.path, 1);
  assert.throws(() => beginPipelineContinuation(task.path, { ...claim, token: "stale" }), /no longer owned/);
  beginPipelineContinuation(task.path, claim);
  assert.equal(claim.attemptId, undefined);
  assert.equal(claim.continuationOf, attempts.at(-1).attemptId);
  assert.throws(() => markTaskModelCompleted(task.path, { ...claim, token: "stale" }, {}, accepted.metrics), /no longer matches/);
  releaseClaim({ ...claim, token: "stale" });
  assert(existsSync(claim.lockPath));
  releaseClaim(claim);
  assert.throws(() => appendModelAttempt(accepted.attemptLedger, { trigger: "manual_retry", status: "completed" }), /cannot retry a completed model attempt/);
  // Even a stale legacy model-attempt context cannot mask a real task failure.
  setTaskError(task.path, "fixture_original_error", null, "ORIGINAL_FINALIZATION_FAILURE", accepted.metrics,
    { claim: { attemptId: "legacy-continuation", trigger: "manual_retry" }, status: "failed_permanent" });
  const recorded = getTaskStatus(root, task.id);
  assert.equal(recorded.error.message, "ORIGINAL_FINALIZATION_FAILURE");
  assert.match(recorded.error.attemptLedgerError, /cannot retry a completed model attempt/);
  assert.deepEqual(recorded.attemptLedger.attempts, attempts);
  retryTask(root, task.id);
  // Match checkpoints written by the affected installed version (no attemptId).
  const legacy = readTask(task.path);
  delete legacy.metadata.pipelineContinuation.attemptId;
  writeTask(legacy);

  // A failed remaining gate must retain its real error, keep delivery blocked,
  // and leave the daemon alive. Restart/retry must consume the same checkpoint.
  writeFileSync(path.join(root, "fail-gate"), "fail");
  start();
  await waitFor(() => getTaskStatus(root, task.id).status === "failed");
  const failed = getTaskStatus(root, task.id);
  assert.equal(failed.error.kind, "pipeline_validation");
  assert.match(failed.error.message, /CONTINUATION_GATE_FAILURE/);
  assert.deepEqual(failed.attemptLedger.attempts, attempts);
  assert.equal(failed.attemptLedger.deliveryAttempts.length, 0);
  assert.equal(getTaskStatus(root, dependent.id).status, "blocked");
  assert.equal(daemon.exitCode, null, output);
  await stop();
  rmSync(path.join(root, "fail-gate"));
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho DELIVERY_FIXTURE_FAILURE >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  retryTask(root, task.id);
  assert.deepEqual(getTaskStatus(root, task.id).execution, accepted.execution);
  start();
  await waitFor(() => getTaskStatus(root, task.id).status === "failed");
  const deliveryFailed = getTaskStatus(root, task.id);
  assert.match(deliveryFailed.error.message, /DELIVERY_FIXTURE_FAILURE/);
  assert.equal(deliveryFailed.git.phase, "committing");
  assert.deepEqual(deliveryFailed.attemptLedger.attempts, attempts);
  assert.equal(deliveryFailed.attemptLedger.deliveryAttempts.length, 1);
  assert.equal(getTaskStatus(root, dependent.id).status, "blocked");
  assert.equal(daemon.exitCode, null, output);
  await stop();
  rmSync(hook);
  retryTask(root, task.id);
  start();
  await waitFor(() => getTaskStatus(root, task.id).status === "completed");
  const delivered = getTaskStatus(root, task.id);
  assert.deepEqual(delivered.attemptLedger.attempts, attempts);
  assert.equal(delivered.metrics.attempts, accepted.metrics.attempts);
  assert.equal(delivered.attemptLedger.deliveryAttempts.at(-1).status, "completed");
  assert.equal(delivered.attemptLedger.deliveryAttempts.length, 2);
  assert.equal(delivered.git.phase, "delivered");
  assert.deepEqual(delivered.validation, ["backend-tests: node check.mjs backend", "frontend-tests: node check.mjs frontend"]);
  assert.equal(git("show", "main:implementation.txt"), "preserved implementation\n");
  assert.equal(readFileSync(path.join(root, "model-calls"), "utf8"), "implement\n");
  // The merge queue also validates the rebased commit before delivery.
  assert.equal(readFileSync(path.join(root, "shell-calls"), "utf8"), "backend\nfrontend\nbackend\nfrontend\nbackend\nfrontend\n");
  assert.notEqual(getTaskStatus(root, dependent.id).status, "blocked");
  const runs = readdirSync(path.join(root, ".todo", "logs", task.id)).filter(name => name.startsWith("continuation-"));
  assert.equal(runs.length, 2, "each continuation keeps separate receipts without a model retry");
  assert.equal(daemon.exitCode, null, output);
  await stop();
  start();
  await waitFor(() => existsSync(path.join(root, ".todo", "daemon.json")));
  assert.equal(getTaskStatus(root, task.id).status, "completed");
  await stop();
  console.log("todo pipeline continuation test passed");
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
