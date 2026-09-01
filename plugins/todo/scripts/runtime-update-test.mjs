import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDaemon } from "./ensure-daemon.mjs";
import {
  DAEMON_IMPLEMENTATION,
  DAEMON_PROTOCOL_VERSION,
  atomicWriteJson,
  claimTask,
  daemonStatePath,
  daemonStopRequestPath,
  processIsAlive,
} from "./lib.mjs";
import {
  daemonRestartDecision,
  daemonRestartRequestPath,
  readDaemonRestartRequest,
  runtimeDescriptor,
} from "./runtime-update.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "todo-update-"));
const children = [];

function remove(file) {
  if (existsSync(file)) unlinkSync(file);
}

async function mockDaemon(extraArgument = null) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ...(extraArgument ? [extraArgument] : []),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  await once(child.stdout, "data");
  return child;
}

try {
  const fixturePlugin = path.join(temporaryRoot, "plugin");
  mkdirSync(path.join(fixturePlugin, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(fixturePlugin, "scripts"));
  mkdirSync(path.join(fixturePlugin, "hooks"));
  writeFileSync(
    path.join(fixturePlugin, ".codex-plugin", "plugin.json"),
    '{"version":"1.0.0"}\n',
  );
  writeFileSync(path.join(fixturePlugin, ".mcp.json"), "{}\n");
  writeFileSync(path.join(fixturePlugin, "hooks", "hooks.json"), "{}\n");
  const runtimeModules = [
    "attempt-ledger.mjs",
    "daemon.mjs",
    "dashboard.mjs",
    "ensure-daemon.mjs",
    "execution-stats.mjs",
    "git-worktree.mjs",
    "lib.mjs",
    "mcp-server.mjs",
    "pipeline.mjs",
    "ponytail-policy.mjs",
    "preflight.mjs",
    "routing-policy.mjs",
    "runtime-update.mjs",
    "session-context.mjs",
  ];
  for (const name of runtimeModules) {
    writeFileSync(path.join(fixturePlugin, "scripts", name), "export {};\n");
  }
  writeFileSync(
    path.join(fixturePlugin, "scripts", "result.schema.json"),
    '{"type":"object"}\n',
  );
  writeFileSync(
    path.join(fixturePlugin, "scripts", "pipeline-result.schema.json"),
    '{"type":"object"}\n',
  );
  const ignoredTest = path.join(
    fixturePlugin,
    "scripts",
    "runtime-update-test.mjs",
  );
  writeFileSync(ignoredTest, "first test version\n");
  const firstRuntime = runtimeDescriptor(fixturePlugin);
  assert.equal(firstRuntime.available, true);
  const importedModule = path.join(
    fixturePlugin,
    "scripts",
    "attempt-ledger.mjs",
  );
  unlinkSync(importedModule);
  const missingImport = runtimeDescriptor(fixturePlugin);
  assert.equal(missingImport.available, false);
  assert(missingImport.missing.includes("scripts/attempt-ledger.mjs"));
  writeFileSync(importedModule, "export {};\n");
  assert.equal(runtimeDescriptor(fixturePlugin).available, true);
  writeFileSync(
    path.join(fixturePlugin, "scripts", "daemon.mjs"),
    'import "./typo.mjs";\n',
  );
  const brokenImport = runtimeDescriptor(fixturePlugin);
  assert.equal(brokenImport.available, false);
  assert.equal(brokenImport.diagnostics[0].path, "scripts/daemon.mjs");
  assert.equal(brokenImport.diagnostics[0].check, "imports");
  assert.match(brokenImport.diagnostics[0].message, /typo\.mjs/);
  writeFileSync(
    path.join(fixturePlugin, "scripts", "daemon.mjs"),
    "export {};\n",
  );
  assert.equal(runtimeDescriptor(fixturePlugin).available, true);
  writeFileSync(ignoredTest, "second test version\n");
  assert.equal(
    runtimeDescriptor(fixturePlugin).fingerprint,
    firstRuntime.fingerprint,
  );
  writeFileSync(
    path.join(fixturePlugin, "scripts", "daemon.mjs"),
    "changed runtime\n",
  );
  assert.notEqual(
    runtimeDescriptor(fixturePlugin).fingerprint,
    firstRuntime.fingerprint,
  );
  const brokenSyntax = runtimeDescriptor(fixturePlugin);
  assert.equal(brokenSyntax.available, false);
  assert.equal(brokenSyntax.diagnostics[0].path, "scripts/daemon.mjs");
  assert.equal(brokenSyntax.diagnostics[0].check, "syntax");
  writeFileSync(
    path.join(fixturePlugin, "scripts", "daemon.mjs"),
    "export {};\n",
  );
  writeFileSync(
    path.join(fixturePlugin, "scripts", "result.schema.json"),
    "{\n",
  );
  const brokenSchema = runtimeDescriptor(fixturePlugin);
  assert.equal(brokenSchema.available, false);
  assert.equal(brokenSchema.diagnostics[0].path, "scripts/result.schema.json");
  assert.equal(brokenSchema.diagnostics[0].check, "json");
  writeFileSync(
    path.join(fixturePlugin, "scripts", "result.schema.json"),
    '{"type":"object"}\n',
  );
  writeFileSync(
    path.join(fixturePlugin, ".codex-plugin", "plugin.json"),
    "{\n",
  );
  const brokenManifest = runtimeDescriptor(fixturePlugin);
  assert.equal(brokenManifest.available, false);
  assert.equal(brokenManifest.pluginVersion, null);
  assert.equal(
    brokenManifest.diagnostics[0].path,
    ".codex-plugin/plugin.json",
  );
  writeFileSync(
    path.join(fixturePlugin, ".codex-plugin", "plugin.json"),
    '{"version":"1.0.0"}\n',
  );
  assert.equal(runtimeDescriptor(fixturePlugin).available, true);

  const repoRoot = path.join(temporaryRoot, "repo");
  const todoRoot = path.join(repoRoot, ".todo");
  mkdirSync(todoRoot, { recursive: true });
  writeFileSync(
    path.join(todoRoot, "config.json"),
    '{"gitExclude":[]}\n',
  );
  assert.equal(spawnSync("git", ["init", "-q", repoRoot]).status, 0);
  const statePath = daemonStatePath(repoRoot);
  const restartPath = daemonRestartRequestPath(repoRoot);
  const stopPath = daemonStopRequestPath(repoRoot);

  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: "0.0.0-stale",
    pid: process.pid,
    token: "busy-token",
    status: "running",
    repoRoot,
    active: ["task-1"],
  });
  const firstPending = ensureDaemon(repoRoot);
  assert.equal(firstPending.status, "restart-pending");
  assert.equal(firstPending.runtimeUpdate.status, "pending");
  assert.equal(firstPending.runtimeUpdate.activeTasks, 1);
  assert.equal(existsSync(stopPath), false);
  const firstRequest = readDaemonRestartRequest(repoRoot);
  const secondPending = ensureDaemon(repoRoot);
  assert.equal(secondPending.runtimeUpdate.requestId, firstRequest.requestId);
  assert.equal(
    readDaemonRestartRequest(repoRoot).requestedAt,
    firstRequest.requestedAt,
  );
  const gatedTask = path.join(todoRoot, "1-gated.md");
  writeFileSync(gatedTask, "gated\n");
  assert.throws(
    () => claimTask(gatedTask, 1),
    (error) => error.code === "EEXIST" && /runtime update/.test(error.message),
  );
  remove(gatedTask);

  const oldRuntime = {
    pluginVersion: "0.0.0-stale",
    fingerprint: "sha256:old",
  };
  assert.equal(
    daemonRestartDecision(
      repoRoot,
      { pid: process.pid, token: "wrong-token" },
      oldRuntime,
    ).pending,
    false,
  );
  assert.equal(existsSync(restartPath), true);
  assert.equal(
    daemonRestartDecision(
      repoRoot,
      { pid: process.pid, token: "busy-token" },
      oldRuntime,
    ).pending,
    true,
  );

  const target = runtimeDescriptor(pluginRoot);
  remove(statePath);
  writeFileSync(path.join(todoRoot, "config.json"), "{\n");
  assert.equal(ensureDaemon(repoRoot).status, "start-blocked");
  assert.equal(existsSync(restartPath), true);
  writeFileSync(path.join(todoRoot, "config.json"), '{"gitExclude":[]}\n');
  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: target.pluginVersion,
    runtimeFingerprint: target.fingerprint,
    pid: process.pid,
    token: "current-token",
    status: "starting",
    repoRoot,
    active: [],
  });
  assert.equal(ensureDaemon(repoRoot).status, "starting");
  assert.equal(existsSync(restartPath), true);
  atomicWriteJson(statePath, {
    ...JSON.parse(readFileSync(statePath, "utf8")),
    status: "running",
  });
  assert.equal(ensureDaemon(repoRoot).status, "conflict");
  assert.equal(existsSync(restartPath), true);
  remove(restartPath);
  remove(statePath);

  const unknownLegacy = await mockDaemon();
  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: "0.0.0-stale",
    pid: unknownLegacy.pid,
    token: "unknown-token",
    status: "running",
    repoRoot,
  });
  const unknownPending = ensureDaemon(repoRoot);
  assert.equal(unknownPending.status, "restart-pending");
  assert.equal(unknownPending.runtimeUpdate.activeTasks, null);
  assert.equal(unknownPending.runtimeUpdate.status, "pending");
  assert.equal(existsSync(stopPath), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(unknownLegacy.exitCode, null);
  unknownLegacy.kill("SIGTERM");
  await once(unknownLegacy, "close");
  remove(restartPath);
  remove(statePath);

  const unrelated = spawn("/bin/sleep", ["30"]);
  children.push(unrelated);
  const unrelatedStartedAt = new Date().toISOString();
  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: target.pluginVersion,
    runtimeFingerprint: target.fingerprint,
    pid: unrelated.pid,
    token: "stale-token",
    status: "running",
    repoRoot,
    active: [],
    startedAt: unrelatedStartedAt,
    heartbeatAt: unrelatedStartedAt,
  });
  const unrelatedResult = ensureDaemon(repoRoot);
  assert.equal(unrelatedResult.status, "conflict");
  assert.match(unrelatedResult.reason, /refusing daemon state for pid/);
  assert.equal(existsSync(stopPath), false);
  assert.equal(existsSync(restartPath), false);
  assert.equal(processIsAlive(unrelated.pid), true);
  unrelated.kill("SIGTERM");
  await once(unrelated, "close");
  remove(restartPath);
  remove(statePath);

  const previousCodexHome = path.join(temporaryRoot, "previous-codex-home");
  const previousPlugin = path.join(
    previousCodexHome,
    "plugins",
    "cache",
    "blackbone",
    "todo",
    "0.0.0-old",
  );
  const previousDaemon = path.join(previousPlugin, "scripts", "daemon.mjs");
  mkdirSync(path.dirname(previousDaemon), { recursive: true });
  writeFileSync(
    previousDaemon,
    'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready\\n");setInterval(()=>{},1000);\n',
  );
  const previousChild = spawn(
    process.execPath,
    [previousDaemon, "--repo", repoRoot],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(previousChild);
  await once(previousChild.stdout, "data");
  rmSync(previousPlugin, { recursive: true, force: true });
  const previousStartedAt = new Date().toISOString();
  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: "0.0.0-old",
    pid: previousChild.pid,
    token: "previous-token",
    status: "running",
    repoRoot,
    active: [],
    startedAt: previousStartedAt,
    heartbeatAt: previousStartedAt,
  });
  const previousCodexHomeValue = process.env.CODEX_HOME;
  process.env.CODEX_HOME = previousCodexHome;
  const previousResult = ensureDaemon(repoRoot);
  if (previousCodexHomeValue === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHomeValue;
  assert.equal(previousResult.status, "restart-pending");
  assert.equal(previousResult.runtimeUpdate.status, "stopping");
  assert.equal(existsSync(stopPath), true);
  if (previousChild.exitCode === null) await once(previousChild, "close");
  assert.equal(processIsAlive(previousChild.pid), false);
  remove(stopPath);
  remove(restartPath);
  remove(statePath);

  mkdirSync(path.dirname(previousDaemon), { recursive: true });
  writeFileSync(
    previousDaemon,
    'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready\\n");setInterval(()=>{},1000);\n',
  );
  const wrongVersion = spawn(
    process.execPath,
    [previousDaemon, "--repo", repoRoot],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(wrongVersion);
  await once(wrongVersion.stdout, "data");
  const wrongVersionStartedAt = new Date().toISOString();
  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: "different-version",
    pid: wrongVersion.pid,
    token: "wrong-version-token",
    status: "running",
    repoRoot,
    active: [],
    startedAt: wrongVersionStartedAt,
    heartbeatAt: wrongVersionStartedAt,
  });
  process.env.CODEX_HOME = previousCodexHome;
  const wrongVersionResult = ensureDaemon(repoRoot);
  if (previousCodexHomeValue === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHomeValue;
  assert.equal(wrongVersionResult.status, "conflict");
  assert.equal(processIsAlive(wrongVersion.pid), true);
  assert.equal(existsSync(stopPath), false);
  assert.equal(existsSync(restartPath), false);
  wrongVersion.kill("SIGTERM");
  await once(wrongVersion, "close");
  remove(statePath);

  const racingChild = spawn(
    process.execPath,
    [previousDaemon, "--repo", repoRoot],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(racingChild);
  await once(racingChild.stdout, "data");
  const racingStartedAt = new Date().toISOString();
  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: "0.0.0-old",
    pid: racingChild.pid,
    token: "racing-token",
    status: "running",
    repoRoot,
    active: [],
    startedAt: racingStartedAt,
    heartbeatAt: racingStartedAt,
  });
  const racingTask = path.join(todoRoot, "1-race.md");
  writeFileSync(racingTask, "race\n");
  writeFileSync(
    `${racingTask}.lock`,
    `${JSON.stringify({ pid: racingChild.pid })}\n`,
  );
  process.env.CODEX_HOME = previousCodexHome;
  const racingResult = ensureDaemon(repoRoot);
  if (previousCodexHomeValue === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHomeValue;
  assert.equal(racingResult.status, "restart-pending");
  assert.equal(racingResult.runtimeUpdate.status, "pending");
  assert.equal(processIsAlive(racingChild.pid), true);
  assert.equal(existsSync(stopPath), false);
  remove(`${racingTask}.lock`);
  remove(racingTask);
  remove(restartPath);
  remove(statePath);
  racingChild.kill("SIGTERM");
  await once(racingChild, "close");

  const decoy = await mockDaemon(`${previousDaemon} --repo ${repoRoot}`);
  const decoyStartedAt = new Date().toISOString();
  atomicWriteJson(statePath, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: "0.0.0-old",
    pid: decoy.pid,
    token: "decoy-token",
    status: "running",
    repoRoot,
    active: [],
    startedAt: decoyStartedAt,
    heartbeatAt: decoyStartedAt,
  });
  const decoyResult = ensureDaemon(repoRoot);
  assert.equal(decoyResult.status, "conflict");
  assert.match(decoyResult.reason, /not an owned ToDo runtime/);
  assert.equal(processIsAlive(decoy.pid), true);
  assert.equal(existsSync(stopPath), false);
  assert.equal(existsSync(restartPath), false);
  decoy.kill("SIGTERM");
  await once(decoy, "close");
  remove(statePath);

  const incompatibleLegacy = await mockDaemon();
  atomicWriteJson(statePath, {
    implementation: "legacy-todo",
    protocolVersion: 1,
    pid: incompatibleLegacy.pid,
    token: "legacy-token",
    status: "running",
    repoRoot,
    active: [],
  });
  const conflict = ensureDaemon(repoRoot);
  assert.equal(conflict.status, "conflict");
  assert.equal(existsSync(restartPath), false);
  assert.equal(existsSync(stopPath), false);
  incompatibleLegacy.kill("SIGTERM");
  await once(incompatibleLegacy, "close");

  const brokenPlugin = path.join(temporaryRoot, "broken-plugin");
  cpSync(pluginRoot, brokenPlugin, { recursive: true });
  const brokenRepo = path.join(temporaryRoot, "broken-repo");
  mkdirSync(path.join(brokenRepo, ".todo"), { recursive: true });
  writeFileSync(
    path.join(brokenRepo, ".todo", "config.json"),
    '{"gitExclude":[]}\n',
  );
  assert.equal(spawnSync("git", ["init", "-q", brokenRepo]).status, 0);
  const { ensureDaemon: ensureBrokenDaemon } = await import(
    `${pathToFileURL(path.join(brokenPlugin, "scripts", "ensure-daemon.mjs"))}?test=${Date.now()}`
  );
  writeFileSync(
    path.join(brokenPlugin, "scripts", "daemon.mjs"),
    'import "./typo.mjs";\n',
  );
  assert.equal(runtimeDescriptor(brokenPlugin).available, false);
  atomicWriteJson(daemonStatePath(brokenRepo), {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion: "0.0.0-stale",
    pid: process.pid,
    token: "broken-update-token",
    status: "running",
    repoRoot: brokenRepo,
    active: [],
  });
  const blockedUpdate = ensureBrokenDaemon(brokenRepo);
  assert.equal(blockedUpdate.status, "update-blocked");
  assert.equal(existsSync(daemonStopRequestPath(brokenRepo)), false);
  assert.equal(existsSync(daemonRestartRequestPath(brokenRepo)), false);
  remove(daemonStatePath(brokenRepo));
  writeFileSync(
    path.join(brokenPlugin, "scripts", "daemon.mjs"),
    'throw new Error("startup boom");\n',
  );
  const brokenRuntime = runtimeDescriptor(brokenPlugin);
  const brokenRestartPath = daemonRestartRequestPath(brokenRepo);
  atomicWriteJson(brokenRestartPath, {
    requestId: "broken-start",
    status: "pending",
    target: brokenRuntime,
  });
  const brokenStart = ensureBrokenDaemon(brokenRepo, {
    startupTimeoutMs: 100,
  });
  assert.equal(brokenStart.status, "start-failed");
  assert.equal(
    existsSync(daemonStatePath(brokenRepo)),
    false,
    "failed startup left an optimistic daemon state",
  );
  assert.equal(
    existsSync(brokenRestartPath),
    true,
    "failed startup discarded its restart request",
  );

  process.stdout.write("runtime update tests passed\n");
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
