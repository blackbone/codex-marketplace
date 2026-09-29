import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimTask,
  createTask,
  ensureRepoHost,
  getTaskStatus,
  initializeRepo,
  loadConfig,
} from "./lib.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";
import {
  HOST_ID,
  HOST_MISMATCH,
  LEGACY_HOST_ID,
  claimRepoHost,
  hostModels,
  readRepoHost,
  threadIsForeign,
  withHostModels,
} from "./host.mjs";

// Identical in every fork: the other host is derived from HOST_ID.
const FOREIGN = HOST_ID === "codex" ? "claude" : "codex";
const DEAD_PID = 2 ** 22 + 12345;
const scripts = path.dirname(fileURLToPath(import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"], ["commit", "--allow-empty", "-m", "fixture"]]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  initializeRepo(root);
  return root;
}

const configFile = root => path.join(root, ".todo", "config.json");
const readConfig = root => JSON.parse(readFileSync(configFile(root), "utf8"));
const writeConfig = (root, value) => writeFileSync(configFile(root), JSON.stringify(value, null, 2));

function handToForeign(root, pid) {
  writeConfig(root, { ...readConfig(root), host: { id: FOREIGN, claimedAt: new Date().toISOString() } });
  writeFileSync(path.join(root, ".todo", "daemon.json"), JSON.stringify({ host: FOREIGN, pid, status: "running" }));
}

test("activation claims the repository for this host", t => {
  const root = fixture(t);
  assert.equal(readConfig(root).host.id, HOST_ID);
  assert.equal(loadConfig(root).host, HOST_ID);
  assert.equal(claimRepoHost(root).status, "own");
});

test("repositories without a host claim belong to the legacy host", t => {
  const root = fixture(t);
  const { host, ...legacy } = readConfig(root);
  writeConfig(root, legacy);
  assert.equal(readRepoHost(root), LEGACY_HOST_ID);
});

test("a live runner of another host keeps the repository", t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Blocked", description: "Host claim" });
  handToForeign(root, process.pid);
  assert.equal(claimRepoHost(root).status, "busy");
  assert.throws(() => ensureRepoHost(root), error => error.code === HOST_MISMATCH && error.host === FOREIGN);
  assert.throws(() => claimTask(task.path, 1), error => error.code === HOST_MISMATCH);
  const daemon = ensureDaemon(root);
  assert.equal(daemon.status, "host-busy");
  assert.match(daemon.reason, /stop the runner/);
  assert.equal(readConfig(root).host.id, FOREIGN, "a busy repository is never reclaimed");
});

test("a dead runner PID frees the repository for this host", t => {
  const root = fixture(t);
  handToForeign(root, DEAD_PID);
  const result = ensureRepoHost(root);
  assert.equal(result.status, "claimed");
  assert.equal(result.previousHost, FOREIGN);
  assert.equal(readConfig(root).host.id, HOST_ID);
  assert.equal(ensureRepoHost(root).status, "own");
});

test("another host's live task claim keeps the repository; a dead one is adopted", t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Interactive", description: "Host claim", runMode: "interactive" });
  writeConfig(root, { ...readConfig(root), host: { id: FOREIGN } });
  const lock = {
    token: "foreign-token",
    pid: process.pid,
    host: FOREIGN,
    workerId: "interactive",
    task: path.basename(task.path),
    claimedAt: new Date().toISOString(),
    owner: { threadId: "foreign-thread", turnId: "foreign-turn" },
  };
  writeFileSync(`${task.path}.lock`, JSON.stringify(lock));
  assert.equal(claimRepoHost(root).status, "busy");
  writeFileSync(`${task.path}.lock`, JSON.stringify({ ...lock, pid: DEAD_PID }));
  assert.equal(ensureRepoHost(root).status, "claimed");
  const status = getTaskStatus(root, task.id);
  assert.equal(status.status, "waiting-input");
  assert.equal(status.claim, null);
  assert.match(status.interaction.question, /moved to/);
});

test("the session hook disables ToDo while another host is busy", t => {
  const root = fixture(t);
  handToForeign(root, process.pid);
  const hook = spawnSync(process.execPath, [path.join(scripts, "session-context.mjs")], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: root, session_id: "s" }),
    encoding: "utf8",
    env: { ...process.env, TODO_RUNNER_WORKER: "" },
  });
  assert.equal(hook.status, 0, hook.stderr);
  const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /ToDo is disabled in this session/);
  assert.doesNotMatch(context, /Ponytail/);
});

test("MCP refuses mutations and keeps reads while another host is busy", async t => {
  const root = fixture(t);
  handToForeign(root, process.pid);
  const server = spawn(process.execPath, [path.join(scripts, "mcp-server.mjs")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, TODO_RUNNER_WORKER: "" },
  });
  t.after(() => server.kill());
  const responses = new Map();
  let buffer = "";
  server.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      responses.get(message.id)?.(message);
    }
  });
  const call = (id, name, args) => new Promise(resolve => {
    responses.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
  const mutation = await call(1, "task_cancel", { repoPath: root, id: "001" });
  assert.equal(mutation.result.isError, true);
  assert.match(mutation.result.content[0].text, new RegExp(`^${HOST_MISMATCH}:`));
  const read = await call(2, "task_list", { repoPath: root });
  assert.equal(read.result.isError, false);
});

test("model profiles are stored per host", () => {
  const legacy = [{ name: "fast", model: "legacy-model", reasoningEffort: "low" }];
  const own = [{ name: "fast", model: "own-model", reasoningEffort: "low" }];
  assert.equal(hostModels(undefined), undefined);
  assert.deepEqual(hostModels(legacy), HOST_ID === LEGACY_HOST_ID ? legacy : undefined);
  assert.deepEqual(hostModels({ [HOST_ID]: own }), own);
  const stored = withHostModels({ models: legacy }, own);
  assert.deepEqual(hostModels(stored.models), own);
  if (HOST_ID !== LEGACY_HOST_ID) assert.deepEqual(stored.models[LEGACY_HOST_ID], legacy);
  assert.deepEqual(hostModels(withHostModels({ models: { [FOREIGN]: legacy } }, own).models), own);
});

test("threads created by another host are foreign", () => {
  assert.equal(threadIsForeign({ id: "t", host: FOREIGN }), true);
  assert.equal(threadIsForeign({ id: "t", host: HOST_ID }), false);
  assert.equal(threadIsForeign({ id: "t" }), HOST_ID !== LEGACY_HOST_ID);
  assert.equal(threadIsForeign(null), false);
});
