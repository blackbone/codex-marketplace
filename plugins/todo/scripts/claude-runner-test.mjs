import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunnerClient, CLAUDE_MODELS } from "./claude-runner.mjs";
import { parseAppServerExecutionStats } from "./execution-stats.mjs";
import { CLAUDE_MODEL_PROFILES, DEFAULT_MODEL_PROFILES, modelProfilePlan, profileDiagnostic, refreshModelCatalog } from "./model-profiles.mjs";
import { configPath, createTask, getTaskStatus, initializeRepo, loadConfig, updateTaskCodexThread } from "./lib.mjs";
import { startDashboard } from "./dashboard.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(scripts, "claude-fake.test.mjs");
chmodSync(fake, 0o755);
const resultSchema = JSON.parse(readFileSync(path.join(scripts, "result.schema.json"), "utf8"));

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-claude-runner-"));
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

function repo(t) {
  const context = workspace(t);
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: context.root }).status, 0, args.join(" "));
  git("init", "-b", "main");
  git("config", "user.name", "ToDo Test");
  git("config", "user.email", "todo@example.invalid");
  writeFileSync(path.join(context.root, ".gitignore"), "claude.log\nsessions/\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  initializeRepo(context.root);
  const edit = (patch) => {
    const config = JSON.parse(readFileSync(configPath(context.root), "utf8"));
    writeFileSync(configPath(context.root), JSON.stringify({ ...config, ...patch }, null, 2));
  };
  return { ...context, edit };
}

test("a Claude runner turn reports app-server events, usage, the result and loads the ToDo MCP server", async (t) => {
  const { root, env, calls } = workspace(t);
  const client = await new ClaudeRunnerClient({ command: fake, cwd: root, env }).start();
  const thread = await client.startThread({ cwd: root, sandbox: "workspace-write" });
  const lines = [];
  const turnId = await client.startTurn(
    { threadId: thread.id, input: [{ type: "text", text: "Implement it" }], cwd: root, model: "claude-sonnet-5-5", effort: "high", outputSchema: resultSchema },
    (message, line) => lines.push(line),
  );
  const turn = await client.waitForTurn(thread.id, turnId);
  assert.equal(turn.status, "completed");
  assert.equal(parseAppServerExecutionStats(lines.join("\n"), turnId).tokenUsage.cachedInputTokens, 100);
  const [call] = calls();
  assert.equal(call.args[call.args.indexOf("--session-id") + 1], thread.id);
  assert.equal(call.args[call.args.indexOf("--model") + 1], "claude-sonnet-5-5");
  const mcp = JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1]).mcpServers.todo;
  assert.equal(mcp.command, process.execPath);
  assert.equal(mcp.args[0], path.join(scripts, "mcp-server.mjs"));
  assert(call.args.includes("--allowedTools=mcp__todo"));
  await client.close();
});

test("the Claude runner has its own profiles and catalog with the same profile names", async (t) => {
  const { root, edit } = repo(t);
  assert.deepEqual(CLAUDE_MODEL_PROFILES.map((p) => p.name), DEFAULT_MODEL_PROFILES.map((p) => p.name));
  assert.equal(loadConfig(root).runner, "codex");
  edit({ runner: "claude", claudeCommand: fake });
  const config = loadConfig(root);
  assert.equal(config.runner, "claude");
  assert.deepEqual(config.modelProfiles, CLAUDE_MODEL_PROFILES);
  const catalog = await refreshModelCatalog(root, fake, { force: true, runner: "claude" });
  assert.equal(catalog.runner, "claude");
  assert.deepEqual(catalog.models.map((m) => m.model), CLAUDE_MODELS.map((m) => m.model));
  for (const profile of CLAUDE_MODEL_PROFILES) assert.equal(profileDiagnostic(profile, catalog).status, "available", profile.name);
  assert.equal(loadConfig(root).modelCatalog?.runner, "claude");
  // Custom Claude profiles live under models.claude and leave Codex profiles alone.
  edit({ models: { claude: CLAUDE_MODEL_PROFILES.filter((p) => p.name !== "ultra") } });
  const plan = modelProfilePlan(root, catalog);
  assert.equal(plan.runner, "claude");
  assert(plan.next.models.claude.some((p) => p.name === "ultra"));
  assert.equal(plan.next.models.codex, undefined);
  edit({ runner: "unknown" });
  assert.match(loadConfig(root).warning, /runner must be codex or claude/);
});

test("settings switch the runner and validate the profile against that runner", async (t) => {
  const { root, edit } = repo(t);
  edit({ models: { codex: DEFAULT_MODEL_PROFILES, claude: CLAUDE_MODEL_PROFILES.filter((p) => p.name !== "ultra") } });
  const dashboard = await startDashboard(root);
  t.after(() => { dashboard.server.close(); dashboard.server.closeAllConnections(); });
  const url = `${dashboard.url}api/settings`;
  const post = (input) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: dashboard.url.slice(0, -1), "X-ToDo-Action": "1" }, body: JSON.stringify(input) });
  const loaded = await (await fetch(url)).json();
  assert.equal(loaded.values.runner, "codex");
  assert(loaded.runnerProfiles.codex.includes("ultra"));
  assert(!loaded.runnerProfiles.claude.includes("ultra"));
  const input = structuredClone(loaded);
  input.values.runner = "claude";
  input.values.defaultModelProfile = "ultra";
  assert.equal((await post(input)).status, 409, "ultra is not a Claude profile here");
  input.values.runner = "gemini";
  input.values.defaultModelProfile = "expert";
  assert.equal((await post(input)).status, 409);
  input.values.runner = "claude";
  const saved = await post(input);
  assert.equal(saved.status, 200, await saved.text());
  assert.equal(JSON.parse(readFileSync(configPath(root), "utf8")).runner, "claude");
  assert.equal(loadConfig(root).runner, "claude");
  const html = await (await fetch(dashboard.url + "?settings=1")).text();
  assert.match(html, /<select name="runner"/);
});

test("the daemon runs tasks through the Claude runner and starts a new session for a Codex thread", async (t) => {
  const { root, env, calls, edit } = repo(t);
  edit({ workers: 1, pollIntervalMs: 250, configReloadIntervalMs: 250, retries: 0,
    runner: "claude", claudeCommand: fake, codexCommand: "must-not-run" });
  const task = createTask(root, { title: "Write hello", description: "Create the greeting file. FAKE:EDIT hello.txt", modelProfile: "medium" });
  // A thread left by the Codex app-server cannot be resumed by Claude.
  updateTaskCodexThread(task.path, { id: "codex-thread", host: "codex", state: "active", createdAt: new Date().toISOString() });
  const daemon = spawn(process.execPath, [path.join(scripts, "daemon.mjs"), "--repo", root], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  daemon.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => daemon.kill("SIGKILL"));
  let receipt;
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    receipt = getTaskStatus(root, task.id);
    if (["completed", "failed"].includes(receipt.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(receipt?.status, "completed", stderr || JSON.stringify(receipt));
  assert.equal(receipt.codexThread.runner, "claude");
  assert.notEqual(receipt.codexThread.id, "codex-thread");
  const file = spawnSync("git", ["show", `${receipt.git.branch}:hello.txt`], { cwd: root, encoding: "utf8" });
  assert.equal(file.stdout, "written by fake claude\n", file.stderr);
  const worker = calls().find((call) => call.args.includes("--json-schema"));
  assert.equal(worker.worker, "1");
  assert.equal(worker.args[worker.args.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.equal(worker.args[worker.args.indexOf("--session-id") + 1], receipt.codexThread.id);
  daemon.kill("SIGTERM");
});
