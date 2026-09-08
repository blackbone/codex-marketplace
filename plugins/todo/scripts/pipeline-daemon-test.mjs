// Fixture runners must never contact the user's native Codex app.
delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTask,
  loadConfig,
  getTaskStatus,
  initializeRepo,
} from "./lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), "todo-pipeline-daemon-"));
const fake = path.join(root, "codex");
const trace = path.join(root, "pipeline-trace.jsonl");
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
};

git("init", "-b", "main");
git("config", "user.name", "ToDo Pipeline Test");
git("config", "user.email", "todo-pipeline@example.invalid");
writeFileSync(
  path.join(root, ".gitignore"),
  "codex\npipeline-trace.jsonl\n.pipeline-once\n",
  "utf8",
);
writeFileSync(
  path.join(root, "pipeline-check.mjs"),
  `import { existsSync, writeFileSync } from "node:fs";
const marker = ".pipeline-once";
if (!existsSync(marker)) {
  writeFileSync(marker, "failed once\\n");
  console.error("BUILD_FIXTURE_FAILURE");
  process.exit(1);
}
console.log("BUILD_FIXTURE_PASSED");
`,
  "utf8",
);
writeFileSync(
  path.join(root, "todo-pipeline.yaml"),
  `version: 1
name: daemon-integration
steps:
  - id: inspect
    type: codex-exec
    modelProfile: fast
    prompt: |
      PIPELINE_EXEC_INSPECT
  - id: implement
    type: codex-thread
    modelProfile: medium
    prompt: |
      PIPELINE_IMPLEMENT
  - id: build
    type: shell
    command: node pipeline-check.mjs
    timeoutSeconds: 30
  - id: test
    type: shell
    command: node --check implemented.mjs
    timeoutSeconds: 30
repair:
  type: codex-thread
  modelProfile: expert
  maxRounds: 2
  prompt: |
    PIPELINE_REPAIR
`,
  "utf8",
);
writeFileSync(
  fake,
  `#!/usr/bin/env node
import { fakeModelList } from ${JSON.stringify(new URL("./model-catalog-test.mjs", import.meta.url).href)};
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.FAKE_TRACE;
const result = { status: "completed", summary: "fake step complete", error: null, validation: [], requiresInteractive: false, interactiveReason: null };
const writeTrace = (value) => appendFileSync(trace, JSON.stringify(value) + "\\n");
if (process.argv[2] !== "app-server") process.exit(64);
let threadNumber = 0;
let turnNumber = 0;
let cumulativeInput = 0;
let cumulativeOutput = 0;
let cumulativeCached = 0;
let cumulativeReasoning = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  writeTrace({ mode: "app-server", message });
  if (message.method === "initialize") send({ id: message.id, result: {} });
  else if (message.method === "model/list") send({ id: message.id, result: fakeModelList() });
  else if (message.method === "thread/start") {
    threadNumber += 1;
    send({ id: message.id, result: { thread: { id: "pipeline-thread-" + threadNumber } } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  } else if (message.method === "thread/archive" || message.method === "thread/unarchive" || message.method === "thread/name/set" || message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  } else if (message.method === "turn/start") {
    turnNumber += 1;
    const threadId = message.params.threadId;
    const turnId = "pipeline-turn-" + turnNumber;
    const prompt = message.params.input.map((item) => item.text || "").join("\\n");
    if (prompt.includes("PIPELINE_IMPLEMENT")) {
      writeFileSync(message.params.cwd + "/implemented.mjs", "export const implemented = true;\\n");
    }
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { id: "pipeline-item-" + turnNumber, type: "agentMessage", text: JSON.stringify(result) } } });
    const last = { inputTokens: 20, cachedInputTokens: turnNumber > 1 ? 10 : 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 };
    for (let request = 0; request < 2; request++) {
      cumulativeInput += last.inputTokens; cumulativeOutput += last.outputTokens;
      cumulativeCached += last.cachedInputTokens; cumulativeReasoning += last.reasoningOutputTokens;
      const total = { inputTokens: cumulativeInput, outputTokens: cumulativeOutput, cachedInputTokens: cumulativeCached, reasoningOutputTokens: cumulativeReasoning };
      const notification = { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last, total, modelContextWindow: 1000 } } };
      send(notification); send(notification); // Transport repeats must not double count.
    }
    if (turnNumber === 1) {
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: "temporary service unavailable" }, items: [] } } });
      continue;
    }
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  }
}
`,
  "utf8",
);
chmodSync(fake, 0o755);
git("add", ".gitignore", "pipeline-check.mjs", "todo-pipeline.yaml");
git("commit", "-m", "pipeline fixture");

initializeRepo(root);
git("add", "AGENTS.md");
git("commit", "-m", "activate todo");
const configPath = path.join(root, ".todo", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      ...config,
      workers: 1,
      pollIntervalMs: 250,
      configReloadIntervalMs: 250,
      dashboardPort: 0,
      retries: 1,
      codexCommand: fake,
      executionBackend: "app-server",
      pipeline: { file: "todo-pipeline.yaml" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const task = createTask(root, {
  title: "Run repository pipeline",
  description: "Exercise exec, thread, shell, repair, and shell restart.",
});
// The saved task and immutable pipeline still name the previous models.
const currentConfig = JSON.parse(readFileSync(configPath, "utf8"));
writeFileSync(configPath, JSON.stringify({ ...currentConfig,
  models: loadConfig(root).modelProfiles.map(profile => ({ ...profile, model: `current-${profile.name}` })),
}));
const daemon = spawn(
  process.execPath,
  [path.join(scriptDir, "daemon.mjs"), "--repo", root],
  {
    cwd: root,
    env: { ...process.env, FAKE_TRACE: trace },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
daemon.stderr.on("data", (chunk) => {
  stderr += chunk;
});
let receipt;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  receipt = getTaskStatus(root, task.id);
  if (receipt.status === "completed" || (receipt.status === "failed" && receipt.metrics?.attempts >= 2)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
daemon.kill("SIGINT");
await new Promise((resolve) => daemon.once("close", resolve));

assert.equal(receipt?.status, "completed", stderr || JSON.stringify(receipt));
assert.equal(receipt.execution.modelProfile, "ultra");
assert.equal(receipt.execution.model, "current-ultra");
assert.equal(receipt.pipeline.source, "todo-pipeline.yaml");
assert.equal(receipt.codexThread.id, "pipeline-thread-1");
assert.equal(receipt.codexThread.state, "archived");
assert.equal(receipt.attemptLedger.attempts.length, 2);
assert.equal(receipt.metrics.tokenUsage.totalTokens, 200);
assert.deepEqual(receipt.metrics.runs.map(run => run.tokenUsage.totalTokens), [50, 150]);
assert.equal(receipt.metrics.tokenUsage.coverage, "full");
assert.equal(receipt.attemptLedger.attempts[0].status, "failed_transient");
assert.equal(receipt.attemptLedger.attempts[1].status, "completed");
assert.deepEqual(receipt.validation, [
  "build: node pipeline-check.mjs",
  "test: node --check implemented.mjs",
]);
assert.equal(
  spawnSync("git", ["show", `${receipt.git.branch}:implemented.mjs`], {
    cwd: root,
    encoding: "utf8",
  }).stdout,
  "export const implemented = true;\n",
);

const attemptsRoot = path.join(root, ".todo", "logs", task.id);
const attemptName = spawnSync("find", [attemptsRoot, "-maxdepth", "1", "-type", "d"], {
  encoding: "utf8",
}).stdout
  .trim()
  .split("\n")
  .map((entry) => path.basename(entry))
  .find((entry) => entry.startsWith("attempt-002-"));
assert(attemptName);
const pipelineRun = JSON.parse(
  readFileSync(path.join(attemptsRoot, attemptName, "pipeline.json"), "utf8"),
);
assert.equal(pipelineRun.status, "completed");
assert.equal(pipelineRun.repairRound, 1);
assert.deepEqual(
  pipelineRun.executions.map((entry) => entry.stepId),
  ["inspect", "implement", "build", "repair", "build", "test"],
);
const traceText = readFileSync(trace, "utf8");
assert.match(traceText, /PIPELINE_EXEC_INSPECT/);
assert.match(traceText, /PIPELINE_IMPLEMENT/);
assert.match(traceText, /PIPELINE_REPAIR/);
assert.match(JSON.stringify(pipelineRun), /BUILD_FIXTURE_FAILURE/);

const calls = traceText.trim().split("\n").map(line => JSON.parse(line));
assert(!calls.some(call => call.mode === "exec"));
assert.deepEqual(calls.filter(call => call.message?.method === "turn/start").map(call => call.message.params.model),
  ["current-fast", "current-fast", "current-medium", "current-expert"]);
console.log("todo pipeline daemon test passed");
await import("./pipeline-continuation-test.mjs");
