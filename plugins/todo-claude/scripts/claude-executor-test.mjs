import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient, CLAUDE_MODELS, permissionArgs } from "./app-server-client.mjs";
import { parseAppServerExecutionStats } from "./execution-stats.mjs";
import { classifyFailure } from "./attempt-ledger.mjs";
import { DEFAULT_MODEL_PROFILES, profileDiagnostic, refreshModelCatalog } from "./model-profiles.mjs";
import { createTask, getTaskStatus, initializeRepo, readDaemonState } from "./lib.mjs";
import { executionOwner, recordClaudeTurn } from "./execution-owner.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(scripts, "claude-fake.test.mjs");
chmodSync(fake, 0o755);
const resultSchema = JSON.parse(readFileSync(path.join(scripts, "result.schema.json"), "utf8"));

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-claude-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    FAKE_CLAUDE_LOG: path.join(root, "claude.log"),
    FAKE_CLAUDE_SESSIONS: path.join(root, "sessions"),
  };
  const calls = () => existsSync(env.FAKE_CLAUDE_LOG)
    ? readFileSync(env.FAKE_CLAUDE_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  return { root, env, calls };
}

async function runTurn(client, threadId, text, { cwd, onStart } = {}) {
  const lines = [];
  const turnId = await client.startTurn(
    { threadId, input: [{ type: "text", text }], cwd, model: "claude-sonnet-5-5", effort: "high", outputSchema: resultSchema },
    (message, line) => lines.push(line),
  );
  await onStart?.(turnId);
  const turn = await client.waitForTurn(threadId, turnId);
  return { turnId, turn, lines, messages: lines.map((line) => JSON.parse(line)) };
}

test("a turn runs claude -p and reports app-server events, usage and the structured result", async (t) => {
  const { root, env, calls } = workspace(t);
  const client = await new AppServerClient({ command: fake, cwd: root, env }).start();
  const thread = await client.startThread({ cwd: root, sandbox: "workspace-write" });
  const { turnId, turn, lines, messages } = await runTurn(client, thread.id, "Implement it", { cwd: root });
  assert.equal(turn.status, "completed");
  const final = messages.filter((m) => m.method === "item/completed" && m.params.item.type === "agentMessage").at(-1);
  assert.deepEqual(JSON.parse(final.params.item.text).validation, ["fake check"]);
  assert(messages.some((m) => m.params.item?.type === "commandExecution" && m.params.item.command === "echo check"));
  const stats = parseAppServerExecutionStats(lines.join("\n"), turnId);
  assert.equal(stats.tokenUsage.available, true);
  assert.equal(stats.tokenUsage.inputTokens, 130);
  assert.equal(stats.tokenUsage.cachedInputTokens, 100);
  assert.equal(stats.tokenUsage.cacheWriteInputTokens, 20);
  assert.equal(stats.tokenUsage.outputTokens, 30);
  assert.equal(stats.tokenUsage.reasoningOutputTokens, 5);
  const [call] = calls();
  assert.deepEqual(call.args.slice(0, 6), ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]);
  assert.equal(call.args[call.args.indexOf("--session-id") + 1], thread.id);
  assert.equal(call.args[call.args.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.equal(call.args[call.args.indexOf("--effort") + 1], "high");
  const schema = JSON.parse(call.args[call.args.indexOf("--json-schema") + 1]);
  assert.equal(schema.$schema, undefined);
  assert.deepEqual(schema.required, resultSchema.required);
  assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "acceptEdits");
  const sandbox = JSON.parse(call.args[call.args.indexOf("--settings") + 1]).sandbox;
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true, "workspace-write never runs unsandboxed");
  await client.close();
});

test("later turns resume the task session; a never-created session is created", async (t) => {
  const { root, env, calls } = workspace(t);
  const client = await new AppServerClient({ command: fake, cwd: root, env }).start();
  const thread = await client.startThread({ cwd: root });
  await runTurn(client, thread.id, "first", { cwd: root });
  await runTurn(client, thread.id, "retry", { cwd: root });
  const restarted = await new AppServerClient({ command: fake, cwd: root, env }).start();
  await restarted.resumeThread(thread.id, { cwd: root });
  assert.equal((await runTurn(restarted, thread.id, "after restart", { cwd: root })).turn.status, "completed");
  const orphan = "00000000-0000-4000-8000-00000000abcd";
  await restarted.resumeThread(orphan, { cwd: root });
  assert.equal((await runTurn(restarted, orphan, "never started", { cwd: root })).turn.status, "completed");
  const modes = calls().map(({ args }) => (args.includes("--resume") ? "resume" : "session"));
  assert.deepEqual(modes, ["session", "resume", "resume", "resume", "session"]);
});

test("API failures are reported with wording the attempt ledger classifies", async (t) => {
  const { root, env } = workspace(t);
  const client = await new AppServerClient({ command: fake, cwd: root, env }).start();
  const thread = await client.startThread({ cwd: root });
  const failed = await runTurn(client, thread.id, "FAKE:FAIL", { cwd: root });
  assert.equal(failed.turn.status, "failed");
  assert.equal(classifyFailure({ errorKind: "app_server", message: failed.turn.error.message }).status, "failed_transient");
  const limited = await runTurn(client, thread.id, "FAKE:RATE", { cwd: root });
  assert.match(limited.turn.error.message, /rate limit/);
  assert.equal(classifyFailure({ errorKind: "app_server", message: limited.turn.error.message }).status, "failed_transient");
});

test("steer queues an instruction into the running turn; interrupt stops it", async (t) => {
  const { root, env } = workspace(t);
  const client = await new AppServerClient({ command: fake, cwd: root, env }).start();
  const thread = await client.startThread({ cwd: root });
  const steered = await runTurn(client, thread.id, "FAKE:SLOW work", {
    cwd: root,
    onStart: async (turnId) => {
      assert.deepEqual(await client.steerTurn(thread.id, turnId, "also this"), { turnId });
    },
  });
  assert.equal(steered.turn.status, "completed");
  const usage = steered.messages.filter((m) => m.method === "thread/tokenUsage/updated").at(-1).params.tokenUsage.total;
  assert.equal(usage.outputTokens, 60, "usage covers both answers");
  const interrupted = await runTurn(client, thread.id, "FAKE:SLOW stop", {
    cwd: root,
    onStart: (turnId) => client.interruptTurn(thread.id, turnId),
  });
  assert.equal(interrupted.turn.status, "interrupted");
});

test("sandbox modes map to Claude Code permission modes", () => {
  assert.deepEqual(permissionArgs("danger-full-access"), ["--permission-mode", "bypassPermissions"]);
  const readOnly = permissionArgs("read-only");
  assert.equal(readOnly[1], "dontAsk");
  assert.match(readOnly[2], /^--allowedTools=Read,/);
  assert.doesNotMatch(readOnly[2], /Edit|Write/);
  const workspace = permissionArgs("workspace-write");
  assert.deepEqual(workspace.slice(0, 3), ["--permission-mode", "acceptEdits", "--allowedTools=mcp__plugin_todo_todo"]);
  const sandbox = JSON.parse(workspace[4]).sandbox;
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.network.strictAllowlist, true);
});

test("built-in profiles are available in the Claude model catalog", async (t) => {
  const { root } = workspace(t);
  mkdirSync(path.join(root, ".todo"));
  const catalog = await refreshModelCatalog(root, fake, { force: true });
  assert.deepEqual(catalog.models.map((m) => m.model), CLAUDE_MODELS.map((m) => m.model));
  for (const profile of DEFAULT_MODEL_PROFILES) {
    assert.equal(profileDiagnostic(profile, catalog).status, "available", profile.name);
  }
  assert.deepEqual([...new Set(DEFAULT_MODEL_PROFILES.map((p) => p.name))],
    ["mini", "fast", "standard", "medium", "proven", "advanced", "expert", "ultra"]);
});

test("interactive ownership comes from the session hook record of the parent Claude process", (t) => {
  const { root } = workspace(t);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = root;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous; });
  assert.equal(executionOwner({}, {}), null);
  recordClaudeTurn(process.ppid, { sessionId: "session-1", promptId: "prompt-1" });
  assert.deepEqual(executionOwner({}, {}), { threadId: "session-1", turnId: "prompt-1" });
  assert.deepEqual(executionOwner({ threadId: "explicit", turnId: "turn" }, {}), { threadId: "explicit", turnId: "turn" });
});

async function runnerFixture(t, extraConfig = {}, files = {}) {
  const context = workspace(t);
  const { root, env } = context;
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: root }).status, 0, args.join(" "));
  git("init", "-b", "main");
  git("config", "user.name", "ToDo Test");
  git("config", "user.email", "todo@example.invalid");
  writeFileSync(path.join(root, ".gitignore"), "claude.log\nsessions/\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  git("add", ".");
  git("commit", "-m", "fixture");
  initializeRepo(root);
  const configPath = path.join(root, ".todo", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.host.id, "claude");
  writeFileSync(configPath, JSON.stringify({ ...config, workers: 1, pollIntervalMs: 250, configReloadIntervalMs: 250,
    retries: 0, claudeCommand: fake, codexCommand: "must-not-run", ...extraConfig }, null, 2));
  const start = () => {
    const daemon = spawn(process.execPath, [path.join(scripts, "daemon.mjs"), "--repo", root], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stderrText = "";
    daemon.stderr.on("data", (chunk) => { daemon.stderrText += chunk; });
    t.after(() => daemon.kill("SIGKILL"));
    return daemon;
  };
  const waitClosed = async (id) => {
    let receipt;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      receipt = getTaskStatus(root, id);
      if (["completed", "failed"].includes(receipt.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return receipt;
  };
  return { ...context, start, waitClosed };
}

test("the runner executes a task end to end through the Claude executor", async (t) => {
  const { root, calls, start, waitClosed } = await runnerFixture(t);
  const task = createTask(root, { title: "Write hello", description: "Create the greeting file. FAKE:EDIT hello.txt", modelProfile: "medium" });
  const daemon = start();
  const receipt = await waitClosed(task.id);
  assert.equal(receipt?.status, "completed", daemon.stderrText || JSON.stringify(receipt));
  assert.equal(readDaemonState(root).host, "claude");
  assert.equal(receipt.codexThread.host, "claude");
  assert.equal(receipt.metrics.runs.at(-1).tokenUsage.cachedInputTokens, 100);
  const file = spawnSync("git", ["show", `${receipt.git.branch}:hello.txt`], { cwd: root, encoding: "utf8" });
  assert.equal(file.stdout, "written by fake claude\n", file.stderr);
  const worker = calls().find((call) => call.args.includes("--json-schema"));
  assert.equal(worker.worker, "1");
  assert.equal(worker.args[worker.args.indexOf("--model") + 1], "claude-sonnet-5-5");
  daemon.kill("SIGTERM");
});

test("pipeline agent steps run as Claude turns before the runner-owned shell gates", { skip: process.platform === "win32" }, async (t) => {
  const pipeline = `version: 1
steps:
  - id: implement
    type: codex-thread
    modelProfile: fast
    prompt: Implement the task.
  - id: gate
    type: shell
    command: test -f piped.txt
repair:
  type: codex-thread
  prompt: Repair the failed gate.
  maxRounds: 1
`;
  const { root, calls, start, waitClosed } = await runnerFixture(t, { pipeline: { file: "pipeline.yaml" } }, { "pipeline.yaml": pipeline });
  const task = createTask(root, { title: "Piped", description: "Create the piped file. FAKE:EDIT piped.txt" });
  const daemon = start();
  const receipt = await waitClosed(task.id);
  assert.equal(receipt?.status, "completed", daemon.stderrText || JSON.stringify(receipt));
  const file = spawnSync("git", ["show", `${receipt.git.branch}:piped.txt`], { cwd: root, encoding: "utf8" });
  assert.equal(file.status, 0, file.stderr);
  const step = calls().find((call) => call.args.includes("--json-schema"));
  assert.equal(step.args[step.args.indexOf("--model") + 1], "claude-haiku-4-5");
  assert.equal(step.args.includes("--effort"), false, "Haiku has no effort control");
  daemon.kill("SIGTERM");
});
