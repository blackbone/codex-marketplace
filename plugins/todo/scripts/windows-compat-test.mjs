// These tests also run on Windows CI; fixtures never contact the desktop app.
delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
delete process.env.TODO_RUNNER_WORKER;
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandDaemonPath, inspectProcess, signalDaemon } from "./daemon-process.mjs";
import { ensureDaemon, verifyDaemonProcess } from "./ensure-daemon.mjs";
import { atomicWriteJson, daemonStopRequestPath, processIsAlive, readDaemonState,
  initializeRepo, createTask } from "./lib.mjs";
import { withRepositoryExecution } from "./single-branch.mjs";
import { runtimeDescriptor, requestDaemonRestart } from "./runtime-update.mjs";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const repo = String.raw`C:\Users\Тест User\my project`;
const daemon = String.raw`C:\Users\Тест User\.codex\plugins\cache\blackbone\todo\1\scripts\daemon.mjs`;
const node = String.raw`C:\Program Files\nodejs\node.exe`;
const command = `"${node}" "${daemon}" --repo "${repo}"`;
const waitFor = async (check, message) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

test("Windows process identity handles quoted Unicode paths and rejects decoy arguments", () => {
  assert.equal(commandDaemonPath(command, repo, "win32"), daemon);
  assert.equal(commandDaemonPath(`${command} extra`, repo, "win32"), null);
  assert.equal(commandDaemonPath(command, `${repo}-other`, "win32"), null);
  assert.equal(commandDaemonPath(`"${node}" -e "${daemon}" --repo "${repo}"`, repo, "win32"), null);
  assert.equal(commandDaemonPath(command.replace("node.exe", "other.exe"), repo, "win32"), null);
  assert.equal(commandDaemonPath(command.slice(0, -1), repo, "win32"), null);
  assert.equal(commandDaemonPath(`"${node}" "${daemon}" --repo "C:\\\\"`, "C:\\", "win32"), daemon);
});

test("Windows inspection uses bounded hidden CIM and fails closed on inaccessible processes", () => {
  const startedAt = "2026-09-21T10:00:00.123Z";
  const result = inspectProcess(123, { platform: "win32", run(exe, args, options) {
    assert.equal(exe, "powershell.exe");
    assert.ok(args.includes("-NoProfile"));
    assert.match(args.at(-1), /ProcessId = 123/);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000);
    return { status: 0, stdout: JSON.stringify({ startedAt, command }) };
  } });
  assert.deepEqual(result, { startedAt: Date.parse(startedAt), command });
  for (const response of [
    { status: 1 }, { status: null, error: new Error("timeout") },
    { status: 0, stdout: "invalid" }, { status: 0, stdout: "null" },
    { status: 0, stdout: JSON.stringify({ startedAt, command: null }) },
    { status: 0, stdout: JSON.stringify({ startedAt: "invalid", command }) },
  ]) assert.equal(inspectProcess(123, { platform: "win32", run: () => response }), null);
  assert.equal(inspectProcess("123; exit", { platform: "win32", run: () => assert.fail("must not run") }), null);
  // Sending SIGTERM to ourselves would kill this test if Windows took the Unix branch.
  signalDaemon(process.pid, "SIGTERM", "win32");
  signalDaemon(process.pid, "SIGUSR2", "win32");
});

test("runtime validation follows imports with native path separators", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-runtime-paths-"));
  try {
    cpSync(pluginRoot, root, { recursive: true });
    const file = path.join(root, "scripts", "daemon-process.mjs");
    writeFileSync(file, readFileSync(file, "utf8") + '\nimport "./missing-windows-module.mjs";\n');
    const runtime = runtimeDescriptor(root);
    assert.equal(runtime.available, false);
    assert.match(JSON.stringify(runtime), /missing-windows-module/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native daemon reuses its PID, polls authorized stop files and stops through packaged MCP", { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), process.platform === "win32" ? "todo Windows тест " : "todo Windows "));
  let pid;
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const start = () => {
    const result = ensureDaemon(root, { startupTimeoutMs: 10000 });
    pid = result.daemon?.pid || result.pid;
    assert.equal(result.status, "running", JSON.stringify(result));
    return result.daemon;
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "core.autocrlf", "false");
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    git("add", "."); git("commit", "-m", "fixture");
    initializeRepo(root);
    const configPath = path.join(root, ".todo", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    atomicWriteJson(configPath, { ...config, git: { ...config.git, targetBranch: "main" }, pollIntervalMs: 60000, dashboardPort: 0 });
    let state = start();
    assert.equal(verifyDaemonProcess(root, state).ok, true);
    assert.equal(ensureDaemon(root).daemon.pid, pid);
    const control = { implementation: state.implementation, protocolVersion: state.protocolVersion,
      pid, token: state.token, force: false };
    atomicWriteJson(daemonStopRequestPath(root), { ...control, token: "wrong-token" });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(processIsAlive(pid), true);
    atomicWriteJson(daemonStopRequestPath(root), control);
    await waitFor(() => !processIsAlive(pid), "file-only stop did not exit");
    assert.equal(readDaemonState(root), null);
    state = start();
    // Current runtimes restart cooperatively without SIGSTOP/SIGCONT on Windows.
    const runtime = runtimeDescriptor(pluginRoot);
    requestDaemonRestart(root, state, { ...runtime, fingerprint: "new-runtime" }, "test");
    await waitFor(() => !processIsAlive(pid), "runtime update did not exit");
    state = start();
    const mcp = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.todo;
    const child = spawn(mcp.command, mcp.args, { cwd: path.resolve(pluginRoot, mcp.cwd),
      env: { ...process.env, ...mcp.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", stderr = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "runner_stop", arguments: { repoPath: root, force: false } } }) + "\n");
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    const reply = output.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(item => item.id === 1);
    assert.equal(reply?.result?.isError, false, output);
    assert.equal(reply?.result?.structuredContent?.status, "stopped", output);
    assert.equal(readDaemonState(root), null);
  } finally {
    if (processIsAlive(pid)) { process.kill(pid, "SIGKILL"); await waitFor(() => !processIsAlive(pid), "cleanup"); }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Windows hook overrides resolve PLUGIN_ROOT from any working directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-hook тест "));
  try {
    const hooks = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
    for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
      const result = spawnSync(hook.commandWindows, { cwd: root, shell: true, windowsHide: true,
        env: { ...process.env, PLUGIN_ROOT: pluginRoot }, input: "{}\n", encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("polling shares the execution registry across Git directory layouts without git.exe", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-poll-layouts-"));
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const main = path.join(root, "main"), linked = path.join(root, "linked");
    const separate = path.join(root, "separate"), admin = path.join(root, "admin");
    mkdirSync(main); mkdirSync(separate);
    git(main, "init", "-b", "main");
    git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    git(main, "worktree", "add", "-b", "linked", linked);
    git(separate, "init", "--separate-git-dir", admin);
    writeFileSync(path.join(separate, ".git"), `gitdir: ${path.relative(separate, admin)}\r\n`);
    const common = realpathSync(path.join(main, ".git"));
    withRepositoryExecution(main, (state, save) => save({ ...state, marker: "shared" }));
    withRepositoryExecution(linked, state => assert.equal(state.marker, "shared"));
    withRepositoryExecution(separate, (_state, save) => save({ marker: "separate" }));
    assert.equal(JSON.parse(readFileSync(path.join(admin, "todo-execution.json"))).marker, "separate");
    assert.equal(JSON.parse(readFileSync(path.join(common, "todo-execution.json"))).marker, "shared");
    // Re-read the pointer each time; a moved/repaired worktree must not use a stale cache.
    const pointer = path.join(linked, ".git");
    const original = readFileSync(pointer, "utf8");
    writeFileSync(pointer, "malformed\n");
    assert.throws(() => withRepositoryExecution(linked, () => assert.fail("invalid pointer accepted")), /Invalid Git directory pointer/);
    writeFileSync(pointer, original);
    withRepositoryExecution(linked, state => assert.equal(state.marker, "shared"));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10 }); }
});

test("real daemon polls tasks, claims and config without creating child processes", { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-poll-audit-"));
  let child;
  try {
    const init = spawnSync("git", ["init", "-b", "main", root], { encoding: "utf8", windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const commit = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "fixture"], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(commit.status, 0, commit.stderr);
    initializeRepo(root);
    const configFile = path.join(root, ".todo", "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    atomicWriteJson(configFile, { ...config, pollIntervalMs: 250, configReloadIntervalMs: 1000, dashboardPort: 0 });
    const task = createTask(root, { title: "Waiting for interactive work", description: "Polling fixture", runMode: "interactive" });
    const audit = path.join(root, ".todo", "audit.mjs");
    const marker = path.join(root, ".todo", "audit-enabled"), trace = path.join(root, ".todo", "children.jsonl");
    writeFileSync(audit, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, appendFileSync } from 'node:fs';
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  function audited(...args) {
    if (existsSync(${JSON.stringify(marker)})) appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ name, command: args[0] }) + '\\n');
    return Reflect.apply(original, this, args);
  }
  Object.assign(audited, original);
  cp[name] = audited;
}
syncBuiltinESMExports();
`);
    child = spawn(process.execPath, ["--import", pathToFileURL(audit).href,
      path.join(pluginRoot, "scripts", "daemon.mjs"), "--repo", root], {
      cwd: root, env: process.env, windowsHide: true, stdio: "ignore",
    });
    const state = await waitFor(() => {
      const current = readDaemonState(root);
      return current?.status === "running" && current;
    }, "daemon did not start");
    writeFileSync(marker, "audit\n");
    // Exercise dead-claim recovery too, not only an empty queue.
    const dead = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    assert.equal(dead.status, 0);
    atomicWriteJson(`${task.path}.lock`, { pid: dead.pid, token: "stale", workerId: 1 });
    await waitFor(() => !existsSync(`${task.path}.lock`), "polling did not recover dead claim");
    await waitFor(() => {
      const current = readDaemonState(root);
      return Date.parse(current?.heartbeatAt) >= Date.parse(state.heartbeatAt) + 1500 &&
        Date.parse(current?.configReload?.lastCheckedAt) > Date.parse(state.configReload.lastCheckedAt);
    }, "polling/config reload stopped");
    const stopped = once(child, "close");
    atomicWriteJson(daemonStopRequestPath(root), { implementation: state.implementation,
      protocolVersion: state.protocolVersion, pid: state.pid, token: state.token, force: false });
    await stopped;
    assert.equal(existsSync(trace) ? readFileSync(trace, "utf8") : "", "", "polling launched an external process");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});
