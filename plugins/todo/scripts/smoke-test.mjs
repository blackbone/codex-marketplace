import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  addTaskArtifacts,
  applyGitExcludes,
  canAutoRetry,
  cancelTask,
  claimTask,
  createTask,
  finishInteractiveTask,
  getTaskDetails,
  getTaskStatus,
  initializeRepo,
  listTaskStatuses,
  listWorkerStatuses,
  loadConfig,
  processIsAlive,
  readDaemonState,
  releaseClaim,
  startInteractiveTask,
  taskArtifactDir,
  taskArtifactManifestPath,
  taskBatchLockPath,
  updateTask,
  writeHistory,
} from "./lib.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";
import {
  prepareTaskWorktree,
  taskWorktreePlan,
} from "./git-worktree.mjs";
import {
  ROUTING_POLICY_END,
  ROUTING_POLICY_START,
  TODO_ROUTING_POLICY,
} from "./routing-policy.mjs";
import { TODO_PONYTAIL_FULL_CONTOUR } from "./ponytail-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const repoRoot = mkdtempSync(path.join(os.tmpdir(), "todo-smoke-"));
let daemonPid = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertStrictObjectSchemas(schema, location = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (schema.type === "object" && schema.properties) {
    const required = new Set(schema.required || []);
    const missing = Object.keys(schema.properties).filter(
      (key) => !required.has(key),
    );
    assert(
      missing.length === 0,
      `${location} strict object required is missing: ${missing.join(", ")}`,
    );
  }
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        assertStrictObjectSchemas(item, `${location}.${key}[${index}]`),
      );
    } else if (value && typeof value === "object") {
      assertStrictObjectSchemas(value, `${location}.${key}`);
    }
  }
}

async function waitFor(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function stopDaemon(pid) {
  if (!processIsAlive(pid)) return;
  process.kill(pid, "SIGINT");
  await waitFor(
    () => !processIsAlive(pid),
    "detached daemon did not stop",
    3000,
  );
}

function runRoutingHook(event, env = {}) {
  const hook = path.join(scriptDir, "session-context.mjs");
  const result = spawnSync(process.execPath, [hook], {
    cwd: event.cwd || repoRoot,
    env: { ...process.env, ...env },
    input: JSON.stringify(event),
    encoding: "utf8",
  });
  assert(result.status === 0, result.stderr || "routing hook failed");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function loadMcpLaunchConfig() {
  const mcpConfig = JSON.parse(
    readFileSync(path.join(scriptDir, "..", ".mcp.json"), "utf8"),
  ).mcpServers.todo;
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.PLUGIN_ROOT;
  return {
    ...mcpConfig,
    cwd: path.resolve(pluginRoot, mcpConfig.cwd || "."),
    env: {
      ...inheritedEnv,
      ...(mcpConfig.env || {}),
    },
  };
}

async function callMcp() {
  const mcpConfig = loadMcpLaunchConfig();
  const child = spawn(mcpConfig.command, mcpConfig.args, {
    cwd: mcpConfig.cwd,
    env: mcpConfig.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.end(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "todo_status",
          arguments: { repoPath: repoRoot },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "worker_list",
          arguments: { repoPath: repoRoot },
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "repo_init",
          arguments: { repoPath: repoRoot },
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n",
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const responses = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const toolsResponse = responses.find((item) => item.id === 2);
  const statusResponse = responses.find((item) => item.id === 3);
  const workersResponse = responses.find((item) => item.id === 4);
  const expectedToolNames = [
    "repo_init",
    "runner_start",
    "runner_status",
    "runner_stop",
    "task_artifact_add",
    "task_batch_create",
    "task_cancel",
    "task_create",
    "task_get",
    "task_list",
    "task_preflight",
    "task_reopen",
    "task_retry",
    "task_run_finish",
    "task_run_start",
    "task_update",
    "todo_status",
    "worker_list",
  ];
  assert(
    JSON.stringify(
      toolsResponse?.result?.tools?.map((tool) => tool.name).sort(),
    ) === JSON.stringify(expectedToolNames),
    "MCP tool contract changed",
  );
  assert(
    toolsResponse.result.tools.some(
      (tool) => tool.name === "task_artifact_add",
    ),
    "MCP did not list task_artifact_add",
  );
  assert(
    toolsResponse.result.tools.some((tool) => tool.name === "task_update"),
    "MCP did not list task_update",
  );
  assert(
    toolsResponse.result.tools.some((tool) => tool.name === "task_preflight") &&
      toolsResponse.result.tools.some(
        (tool) => tool.name === "task_batch_create",
      ),
    "MCP did not list preflight and atomic batch tools",
  );
  assert(
    toolsResponse.result.tools.some((tool) => tool.name === "repo_init"),
    "MCP did not list repo_init",
  );
  assert(
    toolsResponse.result.tools.every((tool) =>
      tool.inputSchema.required?.includes("repoPath"),
    ),
    "repo-bound MCP tools did not require repoPath",
  );
  assert(
    toolsResponse.result.tools.some((tool) => tool.name === "runner_stop"),
    "MCP did not list runner_stop",
  );
  assert(
    toolsResponse.result.tools.some((tool) => tool.name === "task_run_start") &&
      toolsResponse.result.tools.some((tool) => tool.name === "task_run_finish"),
    "MCP did not list current-thread execution tools",
  );
  const createTool = toolsResponse.result.tools.find(
    (tool) => tool.name === "task_create",
  );
  assert(
    createTool?.inputSchema?.properties?.runMode &&
      createTool.inputSchema.properties.allowWorkerTaskCreation,
    "MCP did not expose execution and worker delegation fields",
  );
  assert(
    statusResponse?.result?.structuredContent?.runner?.activated === true,
    "MCP todo_status did not resolve the activated repository",
  );
  assert(
    statusResponse.result.structuredContent.runner.dashboardUrl?.startsWith(
      "http://127.0.0.1:",
    ),
    "MCP todo_status did not expose the dashboard URL",
  );
  assert(
    statusResponse.result.structuredContent.runner.configReloadIntervalMs ===
        250 &&
      typeof statusResponse.result.structuredContent.runner.configReload
        ?.appliedAt === "string",
    "MCP todo_status did not expose applied config reload state",
  );
  assert(
    Array.isArray(statusResponse?.result?.structuredContent?.tasks?.items),
    "MCP todo_status did not return a separate tasks section",
  );
  assert(
    workersResponse?.result?.structuredContent?.items?.length === 2,
    "MCP worker_list did not return configured workers",
  );
}

async function callMcpTool(name, args, env = {}) {
  const mcpConfig = loadMcpLaunchConfig();
  const child = spawn(mcpConfig.command, mcpConfig.args, {
    cwd: mcpConfig.cwd,
    env: { ...mcpConfig.env, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.end(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n",
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((item) => item.id === 2)?.result;
}

async function callMcpStop({ force = false, expectError = false } = {}) {
  const mcpConfig = loadMcpLaunchConfig();
  const child = spawn(mcpConfig.command, mcpConfig.args, {
    cwd: mcpConfig.cwd,
    env: mcpConfig.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.end(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "runner_stop",
          arguments: { repoPath: repoRoot, force },
        },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n",
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const response = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((item) => item.id === 2);
  if (expectError) {
    assert(
      response?.result?.isError === true &&
        response.result.content?.[0]?.text?.includes("active tasks"),
      `MCP runner_stop did not refuse to interrupt active tasks: ${JSON.stringify(response)}`,
    );
    return;
  }
  assert(
    response?.result?.structuredContent?.status === "stopped",
    "MCP runner_stop did not stop the detached daemon",
  );
}

try {
  const outputSchema = JSON.parse(
    readFileSync(path.join(scriptDir, "result.schema.json"), "utf8"),
  );
  assertStrictObjectSchemas(outputSchema);
  const expectedResultFields = [
    "error",
    "interactiveReason",
    "requiresInteractive",
    "status",
    "summary",
    "validation",
  ];
  assert(
    outputSchema.type === "object" &&
      outputSchema.additionalProperties === false &&
      JSON.stringify(Object.keys(outputSchema.properties).sort()) ===
        JSON.stringify(expectedResultFields) &&
      JSON.stringify([...outputSchema.required].sort()) ===
        JSON.stringify(expectedResultFields) &&
      JSON.stringify(outputSchema.properties.status.enum) ===
        JSON.stringify(["completed", "failed"]),
    "worker result schema contract changed",
  );

  const git = spawnSync("git", ["init", "--quiet", repoRoot], {
    encoding: "utf8",
  });
  assert(git.status === 0, git.stderr || "git init failed");
  const agentsFile = path.join(repoRoot, "AGENTS.md");
  writeFileSync(
    agentsFile,
    "# Existing repository instructions\n\nKeep this instruction.\n",
    "utf8",
  );
  const initialized = initializeRepo(repoRoot);
  assert(
    initialized.created === true &&
      JSON.stringify(initialized.config.modelProfiles) ===
        JSON.stringify([
          {
            name: "fast",
            model: "gpt-5.6-luna",
            reasoningEffort: "medium",
            description: "Mechanical file operations and exact text insertions.",
          },
          {
            name: "medium",
            model: "gpt-5.6-terra",
            reasoningEffort: "medium",
            description: "Small, bounded edits across a few files.",
          },
          {
            name: "expert",
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
            description: "Most coding tasks and complex implementation work.",
          },
          {
            name: "ultra",
            model: "gpt-5.6-sol",
            reasoningEffort: "ultra",
            description: "Large, high-risk, cross-cutting refactors.",
          },
        ]) &&
      initialized.config.defaultModelProfile === "expert" &&
      initialized.config.retries === 0 &&
      initialized.config.configReloadIntervalMs === 5000 &&
      initialized.config.routingMode === "all-mutations" &&
      canAutoRetry(initialized.config, { attempts: 1 }) === false,
    "repo initialization did not create the default config",
  );
  const initializedAgents = readFileSync(agentsFile, "utf8");
  assert(
    initialized.routingPolicy.path === agentsFile &&
      initialized.routingPolicy.updated === true &&
      initializedAgents.includes("Keep this instruction.") &&
      initializedAgents.includes(ROUTING_POLICY_START) &&
      initializedAgents.includes(TODO_ROUTING_POLICY) &&
      initializedAgents.includes(ROUTING_POLICY_END),
    "repo initialization did not preserve and install AGENTS routing policy",
  );
  const initializedAgain = initializeRepo(repoRoot);
  const repeatedAgents = readFileSync(agentsFile, "utf8");
  assert(
    initializedAgain.created === false &&
      initializedAgain.routingPolicy.updated === false &&
      repeatedAgents.split(ROUTING_POLICY_START).length === 2,
    "repo initialization routing policy is not idempotent",
  );
  const routingHookEvents = [
    { hook_event_name: "SessionStart", source: "startup" },
    { hook_event_name: "UserPromptSubmit", prompt: "Fix the selected bug." },
    { hook_event_name: "SubagentStart", agent_type: "general-purpose" },
  ];
  const routingContexts = routingHookEvents.map((event) =>
    runRoutingHook({ cwd: repoRoot, ...event }),
  );
  for (const context of routingContexts) {
    const additionalContext =
      context?.hookSpecificOutput?.additionalContext || "";
    assert(
      additionalContext.includes(TODO_ROUTING_POLICY) &&
        additionalContext.includes(TODO_PONYTAIL_FULL_CONTOUR) &&
        additionalContext.indexOf(TODO_ROUTING_POLICY) ===
          additionalContext.lastIndexOf(TODO_ROUTING_POLICY) &&
        additionalContext.indexOf(TODO_PONYTAIL_FULL_CONTOUR) ===
          additionalContext.lastIndexOf(TODO_PONYTAIL_FULL_CONTOUR),
      `${context?.hookSpecificOutput?.hookEventName || "routing"} hook did not inject the complete routing and Ponytail context exactly once`,
    );
  }
  const workerContext = runRoutingHook(
    {
      cwd: repoRoot,
      hook_event_name: "SessionStart",
      source: "startup",
    },
    { TODO_RUNNER_WORKER: "1", TODO_RUNNER_REPO_ROOT: repoRoot },
  );
  assert(
    workerContext?.hookSpecificOutput?.additionalContext?.includes(
      "explicit user authorization",
    ) &&
      workerContext.hookSpecificOutput.additionalContext.includes(
        TODO_ROUTING_POLICY,
      ) &&
      workerContext.hookSpecificOutput.additionalContext.includes(
        TODO_PONYTAIL_FULL_CONTOUR,
      ),
    "routing hook did not provide the full context and claimed-worker exception",
  );

  const fakeCodex = path.join(repoRoot, "fake-codex.mjs");
  const invocationLog = path.join(repoRoot, "codex-invocations.jsonl");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "app-server" && args.includes("--help")) {
  process.stdout.write(Array.from(
    { length: 81 },
    (_, index) => "app-server help line " + (index + 1) + " with repeated   spacing",
  ).join("\\n") + "\\n");
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write("fake-codex 1.0\\n");
  process.exit(0);
}
const outputIndex = args.indexOf("--output-last-message");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, input }) + "\\n");
	  const telemetryConfig = args.find((arg) => arg.startsWith("otel.exporter="));
	  const telemetryEndpoint = telemetryConfig?.match(/endpoint="([^"]+)"/)?.[1];
	  if (telemetryEndpoint) {
	    await fetch(telemetryEndpoint, {
	      method: "POST",
	      headers: { "content-type": "application/json" },
	      body: JSON.stringify({
	        resourceLogs: [{
	          resource: { attributes: [{ key: "user.email", value: { stringValue: "RAW_OTLP_SHOULD_NOT_PERSIST" } }] },
	          scopeLogs: [{ logRecords: [
	            { attributes: [
	              { key: "event.name", value: { stringValue: "codex.api_request" } },
	              { key: "attempt", value: { intValue: "0" } }
	            ] },
	            { body: { stringValue: "RAW_OTLP_SHOULD_NOT_PERSIST" }, attributes: [
	              { key: "event.name", value: { stringValue: "codex.sse_event" } },
	              { key: "event.kind", value: { stringValue: "response.completed" } },
	              { key: "input_token_count", value: { intValue: "101" } },
	              { key: "cached_token_count", value: { intValue: "40" } },
	              { key: "cache_write_token_count", value: { intValue: "0" } },
	              { key: "output_token_count", value: { intValue: "17" } },
	              { key: "reasoning_token_count", value: { intValue: "3" } },
	              { key: "ttft_ms", value: { intValue: "25" } }
	            ] }
	          ] }]
	        }]
	      })
	    });
	  }
	  const retryFixture = input.includes("Retry this task after first failure.");
	  const interactiveRequiredFixture = input.includes(
	    "This task requires a current-thread browser capability.",
	  );
  const retryAttempt = retryFixture
    ? readFileSync(${JSON.stringify(invocationLog)}, "utf8")
        .trim()
        .split(/\\r?\\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.input.includes("Retry this task after first failure."))
        .length
    : 0;
	  const shouldFail =
	    (retryFixture && retryAttempt === 1) || interactiveRequiredFixture;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: "item.completed",
      item: {
        id: "fake-agent-message",
        type: "agent_message",
        text: "fake agent execution message"
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 101,
        cached_input_tokens: 40,
        output_tokens: 17,
        reasoning_output_tokens: 3
      }
    }) + "\\n");
	    writeFileSync(args[outputIndex + 1], JSON.stringify({
	      status: shouldFail ? "failed" : "completed",
	      summary: interactiveRequiredFixture
	        ? "current-thread browser capability required"
	        : shouldFail
	          ? "fake first attempt failure"
	          : "fake completion",
		      error: interactiveRequiredFixture
		        ? "browser capability is unavailable in the background worker"
		        : shouldFail
		          ? "temporary service unavailable"
	          : null,
	      validation: ["fake validation"],
	      requiresInteractive: interactiveRequiredFixture,
	      interactiveReason: interactiveRequiredFixture
	        ? "Browser access is required to finish the task"
	        : null
	    }));
    process.exit(0);
  }, 1200);
});
`,
    "utf8",
  );
  chmodSync(fakeCodex, 0o755);

  const configFile = path.join(repoRoot, ".todo", "config.json");
  const baseRuntimeConfig = {
    workers: 2,
    pollIntervalMs: 250,
    configReloadIntervalMs: 250,
    dashboardPort: 0,
    retries: 1,
    gitExclude: [".todo/", "todo-fixtures/"],
    codexCommand: fakeCodex,
    executionBackend: "exec",
    models: [
      {
        name: "fast",
        model: "gpt-test-fast",
        reasoningEffort: "low",
        description: "Focused changes.",
      },
      {
        name: "expert",
        model: "gpt-test-expert",
        reasoningEffort: "high",
        description: "Complex changes.",
      },
    ],
    defaultModelProfile: "expert",
  };
  writeFileSync(
    configFile,
    `${JSON.stringify(baseRuntimeConfig)}\n`,
    "utf8",
  );
  assert(
    loadConfig(repoRoot).workers === 2 &&
      loadConfig(repoRoot).retries === 1 &&
      loadConfig(repoRoot).configReloadIntervalMs === 250,
    "runtime config was not loaded",
  );
  const added = applyGitExcludes(repoRoot, loadConfig(repoRoot).gitExclude);
  assert(added.includes("todo-fixtures/"), "gitExclude was not applied");
  const excludePath = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--git-path", "info/exclude"],
    { encoding: "utf8" },
  ).stdout.trim();
  assert(
    readFileSync(
      path.isAbsolute(excludePath)
        ? excludePath
        : path.resolve(repoRoot, excludePath),
      "utf8",
    ).includes(".todo/"),
    ".git/info/exclude does not contain the configured path",
  );

  const sourceDir = path.join(repoRoot, "src");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    path.join(sourceDir, "example.js"),
    "export function example() {\n  return true;\n}\n",
    "utf8",
  );
  const sourcePng = path.join(repoRoot, "screenshot.png");
  writeFileSync(
    sourcePng,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  for (const [key, value] of [
    ["user.name", "ToDo Smoke Test"],
    ["user.email", "todo@example.invalid"],
  ]) {
    const configured = spawnSync("git", ["-C", repoRoot, "config", key, value], {
      encoding: "utf8",
    });
    assert(configured.status === 0, configured.stderr || `git config ${key} failed`);
  }
  const stagedFixture = spawnSync(
    "git",
    ["-C", repoRoot, "add", "AGENTS.md", "src/example.js", "fake-codex.mjs"],
    { encoding: "utf8" },
  );
  assert(stagedFixture.status === 0, stagedFixture.stderr || "git add failed");
  const fixtureCommit = spawnSync(
    "git",
    ["-C", repoRoot, "commit", "--quiet", "-m", "smoke fixture"],
    { encoding: "utf8" },
  );
  assert(fixtureCommit.status === 0, fixtureCommit.stderr || "git commit failed");
  const tagFixture = spawnSync(
    "git",
    ["-C", repoRoot, "tag", "target-tag-only"],
    { encoding: "utf8" },
  );
  assert(tagFixture.status === 0, tagFixture.stderr || "git tag failed");
  assert(
    (() => {
      try {
        createTask(repoRoot, {
          title: "Invalid tag target",
          description: "A tag must not be accepted as a target branch.",
          gitTargetBranch: "target-tag-only",
        });
        return false;
      } catch (error) {
        return error.message.includes("existing local branch");
      }
    })(),
    "task creation accepted a tag as targetBranch",
  );

  const first = createTask(repoRoot, {
    title: "First task",
    description: "Create the first result.",
    modelProfile: "fast",
    artifacts: [
      {
        kind: "image",
        source: sourcePng,
        label: "UI screenshot",
        description: "Inspect the selected UI state.",
        mimeType: "image/png",
      },
      {
        kind: "code",
        source: "src/example.js",
        lineStart: 1,
        lineEnd: 3,
        description: "Relevant implementation.",
      },
      {
        kind: "url",
        source: "https://example.com/reference?q=todo",
        label: "Web reference",
      },
      {
        kind: "text",
        content: "The selected button should remain visible.",
        filename: "browser-comment.txt",
        label: "Browser comment",
      },
    ],
  });
  const withAddedArtifact = addTaskArtifacts(repoRoot, first.id, [
    {
      kind: "file",
      dataBase64: Buffer.from('{"fixture":true}\n').toString("base64"),
      filename: "fixture.json",
      label: "JSON fixture",
      mimeType: "application/json",
    },
  ]);
  assert(
    withAddedArtifact.artifacts.length === 5,
    "task status did not return all artifact kinds",
  );
  assert(
    withAddedArtifact.execution.model === "gpt-test-fast" &&
      withAddedArtifact.execution.reasoningEffort === "low" &&
      withAddedArtifact.execution.ephemeral === false,
    "task execution profile was not persisted",
  );
  const updatedFirst = updateTask(repoRoot, "001", {
    body: [
      "# Revised first task",
      "",
      "Use the revised implementation requirements.",
      "",
    ].join("\n"),
  });
  assert(
    updatedFirst.title === "Revised first task",
    "task_update did not replace the task body",
  );
  const updatedDetails = getTaskDetails(repoRoot, "001");
  assert(
    updatedDetails.body.includes("Use the revised implementation requirements."),
    "task_get details did not return the updated body",
  );
  const publicationGate = taskBatchLockPath(repoRoot);
  writeFileSync(
    publicationGate,
    `${JSON.stringify({ token: "smoke-batch", pid: process.pid })}\n`,
    "utf8",
  );
  try {
    let claimBlocked = false;
    try {
      claimTask(first.path, "smoke-batch-race");
    } catch (error) {
      claimBlocked = error.code === "EEXIST";
    }
    assert(claimBlocked, "task claim crossed an active batch publication gate");
  } finally {
    unlinkSync(publicationGate);
  }
  const editClaim = claimTask(first.path, "smoke-edit");
  try {
    let runningUpdateRejected = false;
    try {
      updateTask(repoRoot, "001", {
        body: "# Invalid concurrent edit\n",
      });
    } catch (error) {
      runningUpdateRejected = error.message.includes("Task is running");
    }
    assert(
      runningUpdateRejected,
      "task_update did not reject a running task",
    );
  } finally {
    releaseClaim(editClaim);
  }
  assert(
    existsSync(taskArtifactManifestPath(repoRoot, first.id)),
    "artifact manifest was not created",
  );
  const manifest = JSON.parse(
    readFileSync(taskArtifactManifestPath(repoRoot, first.id), "utf8"),
  );
  assert(manifest.artifacts.length === 5, "artifact manifest is incomplete");
  assert(
    new Set(manifest.artifacts.map((artifact) => artifact.kind)).size === 5,
    "artifact manifest did not preserve all artifact kinds",
  );
  const firstTaskText = readFileSync(first.path, "utf8");
  assert(
    firstTaskText.includes("## Artifacts") &&
      firstTaskText.includes("artifacts/001-first-task/") &&
      !firstTaskText.includes(TODO_PONYTAIL_FULL_CONTOUR),
    "task_update did not preserve copied artifact links",
  );
  assert(
    firstTaskText.includes("../src/example.js#L1-L3") &&
      firstTaskText.includes("https://example.com/reference?q=todo"),
    "task Markdown did not link code and URL references",
  );
  unlinkSync(sourcePng);
  assert(
    existsSync(
      path.join(
        taskArtifactDir(repoRoot, first.id),
        path.basename(manifest.artifacts[0].path),
      ),
    ),
    "copied image depended on the original source",
  );
  const canceled = createTask(repoRoot, {
    title: "Canceled task",
    description: "This task should be canceled before execution.",
    artifacts: [
      {
        kind: "text",
        content: "Keep this receipt artifact.",
        label: "Cancellation evidence",
      },
    ],
  });
  const updatedCanceled = updateTask(repoRoot, canceled.id, {
    modelProfile: "fast",
    ephemeral: false,
  });
  assert(
    updatedCanceled.execution.modelProfile === "fast" &&
      updatedCanceled.execution.ephemeral === false,
    "task_update did not replace execution settings",
  );
  const canceledReceipt = await cancelTask(repoRoot, canceled.id);
  assert(
    canceledReceipt.status === "canceled" &&
      canceledReceipt.artifacts?.length === 1,
    "cancellation receipt did not preserve artifacts",
  );
  assert(
    existsSync(path.join(repoRoot, canceledReceipt.artifacts[0].path)),
    "canceled artifact was removed",
  );
  const blocked = createTask(repoRoot, {
    title: "Blocked task",
    description: "Run after the first task.",
    blockers: [first.id],
  });
  const parallel = createTask(repoRoot, {
    title: "Parallel task",
    description: "Run alongside the first task.",
    modelProfile: "expert",
    ephemeral: false,
  });
  const backgroundExec = createTask(repoRoot, {
    title: "Background exec task",
    description: "Run this task through the background worker.",
  });
  assert(
    backgroundExec.execution.mode === "background",
    "default task execution mode was not background",
  );
  const disappearingTarget = "todo-pre-model-target";
  const createDisappearingTarget = spawnSync(
    "git",
    ["-C", repoRoot, "branch", disappearingTarget],
    { encoding: "utf8" },
  );
  assert(
    createDisappearingTarget.status === 0,
    createDisappearingTarget.stderr || "failed to create disappearing target",
  );
  const preModelFailure = createTask(repoRoot, {
    title: "Pre-model Git failure",
    description: "Never reach the model after the target branch disappears.",
    gitTargetBranch: disappearingTarget,
  });
  const deleteDisappearingTarget = spawnSync(
    "git",
    ["-C", repoRoot, "branch", "-D", disappearingTarget],
    { encoding: "utf8" },
  );
  assert(
    deleteDisappearingTarget.status === 0,
    deleteDisappearingTarget.stderr || "failed to delete disappearing target",
  );
  const explicitInteractive = createTask(repoRoot, {
    title: "Explicit interactive task",
    description:
      "Run in the current thread because the user explicitly selected interactive execution.",
    runMode: "interactive",
  });
  assert(
    explicitInteractive.execution.mode === "interactive",
    "explicit interactive execution was not preserved",
  );
  const interactiveFallback = createTask(repoRoot, {
    title: "Background task requiring interactive fallback",
    description:
      "This task requires a current-thread browser capability.",
  });
  assert(
    getTaskStatus(repoRoot, blocked.id).status === "blocked",
    "dependency status was not blocked",
  );
  writeHistory(repoRoot, "900-completed-fixture.md", {
    title: "Completed fixture",
    status: "completed",
    closedAt: new Date().toISOString(),
  });
  writeHistory(repoRoot, "901-failed-fixture.md", {
    title: "Failed fixture",
    status: "failed",
    closedAt: new Date().toISOString(),
    error: { kind: "fixture", message: "Expected smoke-test failure" },
  });
  writeHistory(repoRoot, "999-sequence-ceiling-fixture.md", {
    title: "Legacy sequence ceiling fixture",
    status: "completed",
    closedAt: new Date().toISOString(),
  });
  for (let sequence = 500; sequence <= 704; sequence += 1) {
    writeHistory(repoRoot, `${sequence}-dashboard-unbounded-fixture.md`, {
      title: `Dashboard unbounded fixture ${sequence}`,
      status: "completed",
      closedAt: new Date().toISOString(),
    });
  }

  const explicitSkills = [
    "artifact-add",
    "cancel",
    "create",
    "dashboard",
    "get",
    "init",
    "list",
    "retry",
    "reopen",
    "start",
    "status",
    "stop",
    "update",
    "workers",
  ];
  for (const skill of explicitSkills) {
    const skillDir = path.join(scriptDir, "..", "skills", skill);
    assert(existsSync(path.join(skillDir, "SKILL.md")), `missing ${skill} skill`);
    assert(
      readFileSync(path.join(skillDir, "agents", "openai.yaml"), "utf8").includes(
        "allow_implicit_invocation: false",
      ),
      `${skill} skill allows implicit invocation`,
    );
  }
  const runSkillDir = path.join(scriptDir, "..", "skills", "run");
  const runSkillText = readFileSync(path.join(runSkillDir, "SKILL.md"), "utf8");
  assert(existsSync(path.join(runSkillDir, "SKILL.md")), "missing run skill");
  assert(
    readFileSync(path.join(runSkillDir, "agents", "openai.yaml"), "utf8").includes(
      "allow_implicit_invocation: true",
    ) &&
      runSkillText.includes("Ponytail implementation brief") &&
      runSkillText.includes("inspect the diff created in this task") &&
      runSkillText.includes("exact minimal relevant validation") &&
      runSkillText.includes("concrete root cause"),
    "run skill does not allow plugin-plus-filename invocation",
  );
  const routeSkillDir = path.join(scriptDir, "..", "skills", "route");
  const routeSkillText = readFileSync(
    path.join(routeSkillDir, "SKILL.md"),
    "utf8",
  );
  assert(
    existsSync(path.join(routeSkillDir, "SKILL.md")) &&
      readFileSync(
        path.join(routeSkillDir, "agents", "openai.yaml"),
        "utf8",
      ).includes("allow_implicit_invocation: true") &&
      routeSkillText.includes("even when the user does not mention ToDo"),
    "route skill does not allow implicit repository mutation routing",
  );
  const createSkillText = readFileSync(
    path.join(scriptDir, "..", "skills", "create", "SKILL.md"),
    "utf8",
  );
  const implementationBriefFields = [
    "## Ponytail implementation brief",
    "Owner, flow, and affected callers",
    "Existing solution or contract to reuse",
    "Minimal implementation path",
    "Explicitly excluded options",
    "Minimal validation",
  ];
  for (const [name, skillText] of [
    ["route", routeSkillText],
    ["create", createSkillText],
  ]) {
    assert(
      skillText.includes("Original user request") &&
        skillText.includes("acceptance criteria") &&
        implementationBriefFields.every((field) => skillText.includes(field)) &&
        skillText.includes("Do not copy the full injected Ponytail contour"),
      `${name} skill does not require the complete Ponytail implementation brief`,
    );
  }
  const hooksFile = path.join(scriptDir, "..", "hooks", "hooks.json");
  const hookConfig = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert(
    hookConfig.hooks?.SessionStart?.length === 1 &&
      hookConfig.hooks?.UserPromptSubmit?.length === 1 &&
      hookConfig.hooks?.SubagentStart?.length === 1,
    "routing lifecycle hooks are incomplete",
  );
  for (const [index, event] of routingHookEvents.entries()) {
    const commandHook =
      hookConfig.hooks[event.hook_event_name][0].hooks[0];
    const additionalContext =
      routingContexts[index].hookSpecificOutput.additionalContext;
    assert(
      commandHook.additionalContextLimit >=
        Buffer.byteLength(additionalContext),
      `${event.hook_event_name} hook context limit truncates routing or Ponytail policy`,
    );
  }
  assert(
    hookConfig.hooks.SessionStart[0].hooks[0].additionalContextLimit >=
      Buffer.byteLength(workerContext.hookSpecificOutput.additionalContext),
    "claimed-worker hook context limit truncates routing or Ponytail policy",
  );
  const daemonStateFile = path.join(repoRoot, ".todo", "daemon.json");
  writeFileSync(
    daemonStateFile,
    `${JSON.stringify({
      pid: process.pid,
      status: "running",
      repoRoot,
      active: [],
    })}\n`,
    "utf8",
  );
  const conflictingDaemon = ensureDaemon(repoRoot);
  assert(
    conflictingDaemon.status === "conflict",
    "runner_start did not reject an incompatible live daemon",
  );
  unlinkSync(daemonStateFile);
  ensureDaemon(repoRoot);
  daemonPid = await waitFor(() => {
    const state = readDaemonState(repoRoot);
    return processIsAlive(state?.pid) ? state.pid : null;
  }, "runner_start path did not start a detached daemon");
  const dashboardUrl = await waitFor(
    () => readDaemonState(repoRoot)?.dashboard?.url || null,
    "daemon did not publish the dashboard URL",
  );

  let maxActive = 0;
  await waitFor(() => {
    const state = readDaemonState(repoRoot);
    maxActive = Math.max(maxActive, state?.active?.length || 0);
    return state?.active?.length === 2;
  }, "daemon did not execute two tasks in parallel");
  const dashboardApiResponse = await fetch(
    new URL("/api/status", dashboardUrl),
  );
  const dashboardApi = await dashboardApiResponse.json();
  const liveTask = dashboardApi.tasks.find((task) => task.status === "running");
  const dashboardApiChecks = [
    ["status", dashboardApiResponse.status === 200],
    ["tasks", Array.isArray(dashboardApi.tasks)],
    ["unbounded", dashboardApi.tasks.length > 200],
    [
      "first-fixture",
      dashboardApi.tasks.some(
        (task) => task.id === "500-dashboard-unbounded-fixture",
      ),
    ],
    [
      "last-fixture",
      dashboardApi.tasks.some(
        (task) => task.id === "704-dashboard-unbounded-fixture",
      ),
    ],
    ["workers", Array.isArray(dashboardApi.workers?.items)],
    ["implementation", dashboardApi.runner?.implementation === "todo"],
    ["protocol", dashboardApi.runner?.protocolVersion === 2],
    ["reload-interval", dashboardApi.config?.configReloadIntervalMs === 250],
    [
      "reload-applied",
      typeof dashboardApi.runner?.configReload?.appliedAt === "string",
    ],
    ["live-duration", liveTask?.metrics?.durationMs > 0],
    ["live-tokens", liveTask?.metrics?.tokenUsage?.totalTokens === 0],
    ["live-start", typeof liveTask?.metrics?.startedAt === "string"],
    ["live-end", liveTask?.metrics?.completedAt === null],
    [
      "live-run-start",
      typeof liveTask?.metrics?.lastRun?.startedAt === "string",
    ],
    ["live-run-end", liveTask?.metrics?.lastRun?.completedAt === null],
    ["claim-shape", !Object.hasOwn(liveTask?.claim || {}, "claimedAt")],
  ];
  assert(
    dashboardApiChecks.every(([, passed]) => passed),
    `dashboard status API did not return tasks and workers: ${dashboardApiChecks
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ")}`,
  );
  const taskFileResponse = await fetch(
    new URL(
      `/api/task?task=${encodeURIComponent(liveTask.id)}`,
      dashboardUrl,
    ),
  );
  const taskFileContent = await taskFileResponse.text();
  const rejectedTaskFileResponse = await fetch(
    new URL("/api/task?task=..", dashboardUrl),
  );
  assert(
    taskFileResponse.status === 200 &&
      taskFileResponse.headers.get("content-type")?.startsWith("text/markdown") &&
      taskFileContent.includes(`# ${liveTask.title}`) &&
      rejectedTaskFileResponse.status === 404,
    "dashboard task Markdown endpoint was missing or accepted an invalid path",
  );
  await waitFor(() => {
    const workers = listWorkerStatuses(repoRoot);
    return workers.items.filter((worker) => worker.status === "busy").length ===
        2 &&
      workers.items.every(
        (worker) => worker.taskId && worker.taskTitle && worker.pid,
      );
  }, "worker status did not expose two busy workers with assigned task details");
  const beforeConfigReload = readDaemonState(repoRoot);
  const reloadedRuntimeConfig = {
    ...baseRuntimeConfig,
    workers: 1,
    models: [
      {
        name: "fast",
        model: "gpt-reloaded-fast",
        reasoningEffort: "medium",
        description: "Hot-reloaded fast profile.",
      },
      {
        name: "expert",
        model: "gpt-reloaded-expert",
        reasoningEffort: "xhigh",
        description: "Hot-reloaded expert profile.",
      },
    ],
    defaultModelProfile: "fast",
  };
  writeFileSync(
    configFile,
    `${JSON.stringify(reloadedRuntimeConfig)}\n`,
    "utf8",
  );
  const reloadedState = await waitFor(() => {
    const state = readDaemonState(repoRoot);
    return state?.workers === 1 &&
      state.configReload?.appliedAt !==
        beforeConfigReload.configReload?.appliedAt
      ? state
      : null;
  }, "daemon did not hot-reload worker/profile config");
  const drainingWorkers = listWorkerStatuses(repoRoot);
  assert(
    reloadedState.active.length === 2 &&
      reloadedState.workerStates.some(
        (worker) => worker.id === 2 && worker.status === "draining",
      ) &&
      drainingWorkers.configured === 1 &&
      drainingWorkers.items.some(
        (worker) => worker.id === 2 && worker.status === "draining",
      ) &&
      getTaskStatus(repoRoot, first.id).execution.model === "gpt-test-fast" &&
      getTaskStatus(repoRoot, parallel.id).execution.model ===
        "gpt-test-expert",
    `config reload stopped or mutated active task snapshots: ${JSON.stringify({
      active: reloadedState.active,
      workerStates: reloadedState.workerStates,
      workers: drainingWorkers,
      first: getTaskStatus(repoRoot, first.id),
      parallel: getTaskStatus(repoRoot, parallel.id),
    })}`,
  );
  await callMcpStop({ expectError: true });
  assert(
    processIsAlive(daemonPid),
    "runner_stop interrupted active tasks without force",
  );
  writeFileSync(configFile, "{ invalid json\n", "utf8");
  const rejectedReloadState = await waitFor(() => {
    const state = readDaemonState(repoRoot);
    return state?.configReload?.warning &&
      state.configReload.lastCheckedAt !==
        reloadedState.configReload.lastCheckedAt
      ? state
      : null;
  }, "daemon did not reject an invalid config reload");
  assert(
    rejectedReloadState.workers === 1 &&
      rejectedReloadState.active.length === 2 &&
      rejectedReloadState.configReload.appliedAt ===
        reloadedState.configReload.appliedAt,
    `invalid config replaced the last valid snapshot or stopped active tasks: ${JSON.stringify({
      before: reloadedState,
      after: rejectedReloadState,
    })}`,
  );
  writeFileSync(
    configFile,
    `${JSON.stringify(reloadedRuntimeConfig)}\n`,
    "utf8",
  );
  const hotProfileTask = createTask(repoRoot, {
    title: "Hot-reloaded profile task",
    description: "Verify that new tasks receive the reloaded profile.",
    runMode: "interactive",
    modelProfile: "fast",
  });
  assert(
    hotProfileTask.id === "1000-hot-reloaded-profile-task" &&
      getTaskStatus(repoRoot, "1000").id === hotProfileTask.id &&
      hotProfileTask.execution.model === "gpt-reloaded-fast" &&
      hotProfileTask.execution.reasoningEffort === "medium",
    "new task did not cross 999 monotonically or receive the reloaded profile",
  );
  await cancelTask(repoRoot, hotProfileTask.id);
  writeFileSync(
    configFile,
    `${JSON.stringify(baseRuntimeConfig)}\n`,
    "utf8",
  );
  await waitFor(
    () => readDaemonState(repoRoot)?.workers === 2,
    "daemon did not hot-reload the restored worker limit",
  );
  process.kill(daemonPid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(
    processIsAlive(daemonPid),
    "unowned SIGTERM stopped the detached daemon",
  );
  const dashboardResponse = await fetch(`${dashboardUrl}?sort=id&dir=desc`);
  const dashboardHtml = await dashboardResponse.text();
  const dashboardChecks = [
    ["status", dashboardResponse.status === 200],
    ["no-refresh", !dashboardHtml.includes('http-equiv="refresh"')],
    ["script", dashboardHtml.includes('<script src="/dashboard.js" defer></script>')],
    ["table", dashboardHtml.includes("<table>")],
    ["all-logs", dashboardHtml.includes("data-log-all")],
    ["task-logs", dashboardHtml.includes("data-log-task=")],
    ["dialog", dashboardHtml.includes('id="log-dialog"')],
    ["filter", dashboardHtml.includes('id="task-filter"')],
    ["placeholder", dashboardHtml.includes('placeholder="status:completed|rejected"')],
    ["status-filter", dashboardHtml.includes('data-filter-field="status"')],
    ["profile-filter", dashboardHtml.includes('data-filter-field="profile"')],
    [
      "blocker-link",
      dashboardHtml.includes(`data-blocker-task="${first.id}"`),
    ],
    ["rejected-status", dashboardHtml.includes(">rejected</button>")],
    ["rejected-color", dashboardHtml.includes(".status-rejected { color: #84cc16; }")],
    [
      "task-link",
      /href="\/api\/task\?task=[0-9]+-[^"]+"[^>]*>[0-9]+<\/a>/.test(
        dashboardHtml,
      ),
    ],
    ["numeric-id", !dashboardHtml.includes(">001-first-task</td>")],
    ["sort-href", dashboardHtml.includes('/?sort=id&amp;dir=asc')],
    ["sort-field", dashboardHtml.includes('data-sort="id"')],
    ["first-unbounded", dashboardHtml.includes("500-dashboard-unbounded-fixture")],
    ["last-unbounded", dashboardHtml.includes("704-dashboard-unbounded-fixture")],
    [
      "sort-order",
      dashboardHtml.indexOf("004-parallel-task") <
        dashboardHtml.indexOf("001-first-task"),
    ],
  ];
  assert(
    dashboardChecks.every(([, passed]) => passed),
    `dashboard did not render its live table or initial sort: ${dashboardChecks
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ")}`,
  );
  const dashboardScriptResponse = await fetch(
    new URL("/dashboard.js", dashboardUrl),
  );
  const dashboardScript = await dashboardScriptResponse.text();
  const dashboardScriptSyntax = spawnSync(
    process.execPath,
    ["--check", "-"],
    { input: dashboardScript, encoding: "utf8" },
  );
  assert(
    dashboardScriptResponse.status === 200 &&
      dashboardScriptSyntax.status === 0 &&
      dashboardScript.includes('fetch("/api/status"') &&
      dashboardScript.includes('fetch("/api/logs"') &&
      dashboardScript.includes("function filterTasks") &&
      dashboardScript.includes("function compactDuration") &&
      dashboardScript.includes("function filterAlternatives") &&
      dashboardScript.includes('field === "status" || field === "profile"') &&
      dashboardScript.includes('alternatives.join("|")') &&
      dashboardScript.includes('status.dataset.filterField = "status"') &&
      dashboardScript.includes('profileButton.dataset.filterField = "profile"') &&
      dashboardScript.includes("link.dataset.blockerTask = target.id") &&
      dashboardScript.includes('setTimeout(() => loadLog(entry, true), 2000)') &&
      dashboardScript.includes("function reconcileTaskRows") &&
      !dashboardScript.includes("tableBody.replaceChildren(fragment)") &&
      dashboardScript.includes("window.history.replaceState"),
    "dashboard live DOM updater was not served",
  );
  const filteredDashboardResponse = await fetch(
    new URL("/?q=profile%3Afast", dashboardUrl),
  );
  const filteredDashboardHtml = await filteredDashboardResponse.text();
  const filterChecks = [
    ["status", filteredDashboardResponse.status === 200],
    ["value", filteredDashboardHtml.includes('value="profile:fast"')],
    ["included", filteredDashboardHtml.includes("Canceled task")],
    ["excluded", !filteredDashboardHtml.includes("Parallel task")],
    ["count", filteredDashboardHtml.includes(" of ")],
  ];
  assert(
    filterChecks.every(([, passed]) => passed),
    `dashboard field filter did not narrow server-rendered rows: ${filterChecks
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ")}`,
  );
  const defaultDashboardResponse = await fetch(dashboardUrl);
  const defaultDashboardHtml = await defaultDashboardResponse.text();
  const renderedStatuses = [
    ...defaultDashboardHtml.matchAll(
      /data-filter-field="status"[^>]*>([^<]+)<\/button>/g,
    ),
  ].map((match) => match[1]);
  const renderedStatusRanks = renderedStatuses.map((status) => {
    const rank = ["running", "blocked", "completed", "failed"].indexOf(status);
    return rank < 0 ? 4 : rank;
  });
  assert(
    defaultDashboardResponse.status === 200 &&
      defaultDashboardHtml.includes('/?sort=status&amp;dir=desc') &&
      renderedStatuses.includes("completed") &&
      renderedStatuses.includes("failed") &&
      renderedStatusRanks.every(
        (rank, index) => index === 0 || rank >= renderedStatusRanks[index - 1],
      ),
    "dashboard default status order was not running, blocked, completed, failed",
  );
  assert(
    dashboardHtml.includes(">Start<") &&
      dashboardHtml.includes(">End<") &&
      dashboardHtml.includes(">Last Run<"),
    "dashboard did not render task run columns",
  );
  await waitFor(
    () =>
      [first, blocked, parallel, backgroundExec].every(
        (task) => getTaskStatus(repoRoot, task.id).status === "completed",
      ) &&
      getTaskStatus(repoRoot, interactiveFallback.id).status === "failed" &&
      getTaskStatus(repoRoot, preModelFailure.id).status === "failed",
    "tasks did not complete",
  );
  const preModelFailureReceipt = getTaskStatus(repoRoot, preModelFailure.id);
  assert(
    preModelFailureReceipt.attemptLedger?.attempts?.length === 0 &&
      preModelFailureReceipt.metrics === null,
    "Git preparation failure was counted as a model attempt",
  );
  for (const query of [
    "status:completed|rejected",
    "status:(completed|rejected)",
  ]) {
    const response = await fetch(
      new URL(`/?q=${encodeURIComponent(query)}`, dashboardUrl),
    );
    const html = await response.text();
    assert(
      response.status === 200 &&
        html.includes(`value="${query}"`) &&
        html.includes("Canceled task") &&
        html.includes("Completed fixture") &&
        !html.includes("Failed fixture"),
      `dashboard OR filter did not support ${query}`,
    );
  }
  const rejectedDashboardResponse = await fetch(
    new URL("/?q=status%3Arejected", dashboardUrl),
  );
  const rejectedDashboardHtml = await rejectedDashboardResponse.text();
  assert(
    rejectedDashboardResponse.status === 200 &&
      rejectedDashboardHtml.includes("Canceled task") &&
      rejectedDashboardHtml.includes(">rejected</button>") &&
      !rejectedDashboardHtml.includes(">canceled</button>"),
    "dashboard did not expose canceled tasks as rejected",
  );
  const backgroundReceipt = getTaskStatus(repoRoot, backgroundExec.id);
  assert(
    backgroundReceipt.status === "completed" &&
      backgroundReceipt.execution?.mode === "background",
    "background task did not complete through the daemon",
  );
  const interactiveFallbackReceipt = getTaskStatus(
    repoRoot,
    interactiveFallback.id,
  );
  assert(
    interactiveFallbackReceipt.status === "failed" &&
      interactiveFallbackReceipt.execution?.mode === "interactive" &&
      interactiveFallbackReceipt.error?.kind === "interactive_required" &&
      interactiveFallbackReceipt.metrics?.attempts === 1,
    "background capability failure did not stop retries and require interactive execution",
  );
  assert(maxActive === 2, "configured worker limit was not observed");
  const invocations = readFileSync(invocationLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const firstInvocations = invocations.filter((entry) =>
    entry.input.includes(`Task ID: ${first.id}`),
  );
  const fastInvocation = firstInvocations[0];
  const persistentInvocation = invocations.find((entry) =>
    entry.input.includes("Task ID: 004-parallel-task"),
  );
  assert(
    invocations.some((entry) =>
      entry.input.includes(`Task ID: ${backgroundExec.id}`),
    ) &&
      invocations.some((entry) =>
        entry.input.includes(`Task ID: ${interactiveFallback.id}`),
      ) &&
      !invocations.some((entry) =>
        entry.input.includes(`Task ID: ${explicitInteractive.id}`),
      ),
    "daemon did not respect background, fallback, and explicit interactive modes",
  );
  assert(
    fastInvocation &&
      !fastInvocation.args.includes("--ephemeral") &&
      fastInvocation.args.includes("--json") &&
      fastInvocation.args[fastInvocation.args.indexOf("--model") + 1] ===
        "gpt-test-fast" &&
      fastInvocation.args.includes('model_reasoning_effort="low"'),
    "daemon did not pass the selected fast profile",
  );
  assert(
    persistentInvocation &&
      !persistentInvocation.args.includes("--ephemeral") &&
      persistentInvocation.args[
        persistentInvocation.args.indexOf("--model") + 1
      ] === "gpt-test-expert" &&
      persistentInvocation.args.includes('model_reasoning_effort="high"'),
    "daemon did not honor ephemeral=false and the expert profile",
  );
  for (const task of [first, blocked, parallel]) {
    assert(
      getTaskStatus(repoRoot, task.id).status === "completed",
      `${task.id} did not produce a completion receipt`,
    );
  }
  const firstReceipt = getTaskStatus(repoRoot, first.id);
  const firstAttemptRoot = path.join(
    repoRoot,
    ".todo",
    "logs",
    first.id,
  );
  const firstAttempt = readdirSync(firstAttemptRoot).sort().at(-1);
  const firstUsage = JSON.parse(
    readFileSync(
      path.join(firstAttemptRoot, firstAttempt, "usage.json"),
      "utf8",
    ),
  );
  const runnerLog = readFileSync(
    path.join(repoRoot, ".todo", "runner.log"),
    "utf8",
  );
  const firstPrompt = readFileSync(
    path.join(firstAttemptRoot, firstAttempt, "prompt.txt"),
    "utf8",
  );
  const ponytailPromptIndex = firstPrompt.indexOf(
    TODO_PONYTAIL_FULL_CONTOUR,
  );
  const taskBodyPromptIndex = firstPrompt.indexOf(`Task ID: ${first.id}`);
  const logsResponse = await fetch(
    new URL(`/api/logs?task=${encodeURIComponent(first.id)}`, dashboardUrl),
  );
  const logsPayload = await logsResponse.json();
  const transcriptEntry = logsPayload.logs.find(
    (entry) => entry.file === "transcript.txt",
  );
  const transcriptQuery = new URLSearchParams({
    scope: transcriptEntry?.scope || "",
    task: transcriptEntry?.taskId || "",
    attempt: transcriptEntry?.attempt || "",
    file: transcriptEntry?.file || "",
  });
  const transcriptResponse = await fetch(
    new URL(`/api/log?${transcriptQuery}`, dashboardUrl),
  );
  const transcript = await transcriptResponse.text();
  const runnerLogResponse = await fetch(
    new URL("/api/log?scope=runner", dashboardUrl),
  );
  const rejectedLogResponse = await fetch(
    new URL(
      "/api/log?scope=task&task=..&attempt=..&file=stdout.log",
      dashboardUrl,
    ),
  );
  assert(
    ponytailPromptIndex >= 0 &&
      ponytailPromptIndex ===
        firstPrompt.lastIndexOf(TODO_PONYTAIL_FULL_CONTOUR) &&
      ponytailPromptIndex < taskBodyPromptIndex &&
      !firstPrompt.includes('<!-- TODO {"version":'),
    "worker prompt did not contain the canonical Ponytail contour exactly once before the metadata-free task body",
  );
  assert(
      firstUsage.schemaVersion === 2 &&
      firstUsage.status === "completed" &&
      firstUsage.attempt === 1 &&
      typeof firstUsage.startedAt === "string" &&
      typeof firstUsage.completedAt === "string" &&
      Date.parse(firstUsage.completedAt) >= Date.parse(firstUsage.startedAt) &&
      firstUsage.durationMs >= 750 &&
      firstUsage.tokenUsage.available === true &&
      firstUsage.tokenUsage.coverage === "full" &&
      firstUsage.tokenUsage.inputTokens === 101 &&
      firstUsage.tokenUsage.cachedInputTokens === 40 &&
      firstUsage.tokenUsage.outputTokens === 17 &&
      firstUsage.tokenUsage.reasoningOutputTokens === 3 &&
      firstUsage.tokenUsage.totalTokens === 118 &&
      firstUsage.requestStats?.available === true &&
      firstUsage.requestStats.coverage === "full" &&
      firstUsage.requestStats.requests?.length === 1 &&
      firstUsage.requestStats.requests[0].ttftMs === 25 &&
      !JSON.stringify(firstUsage).includes("RAW_OTLP_SHOULD_NOT_PERSIST") &&
      firstUsage.promptFile === "prompt.txt" &&
      firstPrompt.includes("You are a ToDo worker") &&
      firstPrompt.includes("Do not create follow-up ToDo tasks") &&
      taskBodyPromptIndex >= 0 &&
      logsResponse.status === 200 &&
      transcriptEntry?.label === "Readable transcript" &&
      logsPayload.logs.some((entry) => entry.file === "prompt.txt") &&
      logsPayload.logs.some((entry) => entry.file === "stdout.log") &&
      transcriptResponse.status === 200 &&
      transcript.includes("=== EXECUTION PROMPT ===") &&
      transcript.includes("=== AGENT AND TOOL EVENTS ===") &&
      transcript.includes("fake agent execution message") &&
      runnerLogResponse.status === 200 &&
      rejectedLogResponse.status === 404 &&
      runnerLog.includes("event=task_start") &&
      runnerLog.includes("event=task_end") &&
      runnerLog.includes("startedAt=") &&
      runnerLog.includes("durationMs=") &&
      runnerLog.includes("totalTokens=118") &&
      runnerLog.includes('coverage="full"') &&
      runnerLog.includes("event=config_reloaded") &&
      runnerLog.includes('changed=["workers","modelProfiles","defaultModelProfile"]') &&
      runnerLog.includes("activeTasksPreserved=2") &&
      runnerLog.includes("event=config_reload_rejected"),
    "task time and token usage were not logged at start and completion",
  );
  assert(
    firstReceipt.metrics?.startedAt === firstUsage.startedAt &&
      firstReceipt.metrics?.completedAt === firstUsage.completedAt &&
      firstReceipt.metrics?.durationMs === firstUsage.durationMs &&
      firstReceipt.metrics?.runs?.length === 1 &&
      firstReceipt.metrics?.lastRun?.startedAt === firstUsage.startedAt &&
      firstReceipt.metrics?.lastRun?.completedAt === firstUsage.completedAt &&
      firstReceipt.metrics?.tokenUsage?.totalTokens === 118 &&
      firstInvocations.length === 1 &&
      firstReceipt.attemptLedger?.attempts?.length === 1 &&
      firstReceipt.attemptLedger.attempts[0].trigger === "initial" &&
      firstReceipt.attemptLedger.attempts[0].status === "completed" &&
      firstReceipt.retryStats?.modelRetries === 0 &&
      firstReceipt.retryStats?.deliveryRetries === 0,
    "successful task did not preserve one-pass completion and usage",
  );
  const completedDashboardResponse = await fetch(dashboardUrl);
  const completedDashboardHtml = await completedDashboardResponse.text();
  assert(
    completedDashboardResponse.status === 200 &&
      completedDashboardHtml.includes(">Start<") &&
      completedDashboardHtml.includes(">End<") &&
      completedDashboardHtml.includes(">Duration<") &&
      completedDashboardHtml.includes(">Last Run<") &&
      completedDashboardHtml.includes(">Tokens<") &&
      completedDashboardHtml.includes(">Retries<") &&
      completedDashboardHtml.includes("<th>Logs</th>") &&
      !completedDashboardHtml.includes("00d 00h 00m") &&
      completedDashboardHtml.includes(">118</td>"),
    "dashboard did not expose task time and token usage",
  );
  const retryImplementationBrief = [
    "## Ponytail implementation brief",
    "- Owner, flow, and affected callers: fake retry worker path.",
    "- Existing solution or contract to reuse: existing daemon retry contract.",
    "- Minimal implementation path: retry the unchanged body once.",
    "- Explicitly excluded options: no broad rediscovery.",
    "- Minimal validation: both prompts retain this exact brief.",
  ].join("\n");
  const retrying = createTask(repoRoot, {
    title: "Retry metrics task",
    description: `Retry this task after first failure.\n\n${retryImplementationBrief}`,
  });
  await waitFor(
    () => getTaskStatus(repoRoot, retrying.id).status === "completed",
    "retry fixture did not complete after its automatic retry",
  );
  const retriedReceipt = getTaskStatus(repoRoot, retrying.id);
  const retriedRunnerLog = readFileSync(
    path.join(repoRoot, ".todo", "runner.log"),
    "utf8",
  );
  const retryAttemptDirs = readdirSync(
    path.join(repoRoot, ".todo", "logs", retrying.id),
  )
    .filter((name) => name.startsWith("attempt-"))
    .sort();
  const retryUsageFiles = retryAttemptDirs
    .map((name) =>
      JSON.parse(
        readFileSync(
          path.join(
            repoRoot,
            ".todo",
            "logs",
            retrying.id,
            name,
            "usage.json",
          ),
          "utf8",
        ),
      ),
    );
  const retryPrompts = retryAttemptDirs.map((name) =>
    readFileSync(
      path.join(
        repoRoot,
        ".todo",
        "logs",
        retrying.id,
        name,
        "prompt.txt",
      ),
      "utf8",
    ),
  );
  assert(
    retriedReceipt.metrics?.attempts === 2 &&
      retriedReceipt.metrics?.tokenUsage?.totalTokens === 236 &&
      retriedReceipt.metrics?.durationMs >= 1500 &&
      retriedReceipt.metrics?.runs?.length === 2 &&
      retriedReceipt.metrics?.runs.every(
        (run) =>
          typeof run.startedAt === "string" &&
          typeof run.completedAt === "string",
      ) &&
      retriedReceipt.metrics?.lastRun?.tokenUsage?.totalTokens === 118 &&
      retriedReceipt.metrics.durationMs ===
        retriedReceipt.metrics.runs.reduce(
          (total, run) => total + run.durationMs,
          0,
        ) &&
      retryUsageFiles.length === 2 &&
      retryUsageFiles.every(
        (usage, index) =>
          usage.schemaVersion === 2 &&
          usage.attempt === index + 1 &&
          usage.tokenUsage.totalTokens === 118 &&
          usage.requestStats.coverage === "full" &&
          usage.runs === undefined &&
          usage.lastRun === undefined,
      ) &&
      retryUsageFiles[0].status === "failed_transient" &&
      retryUsageFiles[1].status === "completed" &&
      retryPrompts.length === 2 &&
      retryPrompts.every(
        (prompt) =>
          prompt.includes(retryImplementationBrief) &&
          prompt.indexOf(TODO_PONYTAIL_FULL_CONTOUR) ===
            prompt.lastIndexOf(TODO_PONYTAIL_FULL_CONTOUR) &&
          !prompt.includes('<!-- TODO {"version":'),
      ) &&
      retriedReceipt.attemptLedger?.attempts?.length === 2 &&
      retriedReceipt.attemptLedger.attempts[0].trigger === "initial" &&
      retriedReceipt.attemptLedger.attempts[1].trigger ===
        "automatic_retry" &&
      retriedReceipt.retryStats?.modelRetries === 1 &&
      retriedReceipt.retryStats?.automaticRetries === 1 &&
      retriedReceipt.retryStats?.deliveryRetries === 0 &&
      retriedRunnerLog.includes("event=task_auto_retry"),
    "automatic retry did not accumulate time and token usage",
  );
  const explicitClaim = await startInteractiveTask(
    repoRoot,
    explicitInteractive.id,
  );
  const explicitReceipt = await finishInteractiveTask(
    repoRoot,
    explicitInteractive.id,
    {
      claimToken: explicitClaim.claimToken,
      status: "completed",
      summary: "Completed through explicit current-thread execution.",
      validation: ["interactive execution smoke validation"],
    },
  );
  assert(
    explicitReceipt.status === "completed" &&
      explicitReceipt.execution?.mode === "interactive",
    "explicit interactive task did not complete",
  );
  const interactive = createTask(repoRoot, {
    title: "Interactive browser task",
    description: "Complete this task in the current Codex thread.",
    runMode: "interactive",
  });
  const interactiveClaim = await startInteractiveTask(repoRoot, interactive.id);
  assert(
    interactiveClaim.task.status === "running" &&
      interactiveClaim.task.workerId === "interactive",
    "current-thread task was not claimed interactively",
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const firstLiveInteractive = await (
    await fetch(new URL("/api/status", dashboardUrl))
  ).json();
  const firstLiveDuration = firstLiveInteractive.tasks.find(
    (task) => task.id === interactive.id,
  )?.metrics?.durationMs;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const secondLiveInteractive = await (
    await fetch(new URL("/api/status", dashboardUrl))
  ).json();
  const secondInteractiveTask = secondLiveInteractive.tasks.find(
    (task) => task.id === interactive.id,
  );
  assert(
    firstLiveDuration > 0 &&
      secondInteractiveTask.metrics.durationMs > firstLiveDuration &&
      secondInteractiveTask.metrics.tokenUsage.totalTokens === 0 &&
      typeof secondInteractiveTask.metrics.startedAt === "string" &&
      secondInteractiveTask.metrics.completedAt === null &&
      secondInteractiveTask.metrics.lastRun.completedAt === null,
    "interactive duration was not live or tokens did not default to zero",
  );
  const interactiveReceipt = await finishInteractiveTask(
    repoRoot,
    interactive.id,
    {
      claimToken: interactiveClaim.claimToken,
      status: "completed",
      summary: "Completed in current thread.",
      validation: ["interactive smoke validation"],
    },
  );
  assert(
    interactiveReceipt.status === "completed" &&
      interactiveReceipt.metrics?.tokenUsage?.totalTokens === 0 &&
      typeof interactiveReceipt.metrics?.startedAt === "string" &&
      typeof interactiveReceipt.metrics?.completedAt === "string" &&
      interactiveReceipt.metrics?.runs?.length === 1 &&
      interactiveReceipt.metrics?.lastRun?.startedAt ===
        interactiveReceipt.metrics.startedAt,
    "current-thread completion was not recorded correctly",
  );
  const transientInteractive = createTask(repoRoot, {
    title: "Transient interactive failure",
    description: "Classify a concrete interactive execution failure.",
    runMode: "interactive",
  });
  const transientInteractiveClaim = await startInteractiveTask(
    repoRoot,
    transientInteractive.id,
  );
  const transientInteractiveReceipt = await finishInteractiveTask(
    repoRoot,
    transientInteractive.id,
    {
      claimToken: transientInteractiveClaim.claimToken,
      status: "failed",
      summary: "Interactive execution failed.",
      error: "HTTP 503 service unavailable",
    },
  );
  assert(
    transientInteractiveReceipt.outcome === "failed_transient" &&
      transientInteractiveReceipt.attemptLedger?.attempts?.at(-1)?.status ===
        "failed_transient",
    "interactive HTTP 503 was not classified as transient",
  );
  await cancelTask(repoRoot, transientInteractive.id);
  assert(
    firstReceipt.artifacts?.length === 5,
    "completion receipt did not preserve artifacts",
  );
  for (const artifact of firstReceipt.artifacts.filter((item) => item.path?.startsWith(".todo/"))) {
    assert(
      existsSync(path.join(repoRoot, artifact.path)),
      `completed artifact was removed: ${artifact.path}`,
    );
  }

  const unauthorizedParent = createTask(repoRoot, {
    title: "Unauthorized worker delegation",
    description: "Verify that implicit delegation is rejected.",
    modelProfile: "fast",
    runMode: "interactive",
  });
  const unauthorizedClaim = claimTask(unauthorizedParent.path, 77);
  try {
    const rejectedCreation = await callMcpTool(
      "task_create",
      {
        repoPath: repoRoot,
        title: "Forbidden nested task",
        description: "This task must not be created.",
        modelProfile: "expert",
      },
      {
        TODO_RUNNER_WORKER: "1",
        TODO_RUNNER_REPO_ROOT: repoRoot,
        TODO_RUNNER_TASK_ID: unauthorizedParent.id,
      },
    );
    assert(
      rejectedCreation?.isError === true &&
        rejectedCreation.content?.[0]?.text?.includes(
          "does not record explicit user authorization",
        ),
      `claimed worker created a follow-up task without explicit authorization: ${JSON.stringify(rejectedCreation)}`,
    );
  } finally {
    releaseClaim(unauthorizedClaim);
  }
  const unverifiedDeliveryUpdate = await callMcpTool("task_update", {
    repoPath: repoRoot,
    id: unauthorizedParent.id,
    delivery: "pr",
  });
  assert(
    unverifiedDeliveryUpdate?.isError === true &&
      getTaskStatus(repoRoot, unauthorizedParent.id).git?.delivery === "keep",
    "task_update changed Git delivery without a matching preflight",
  );

  const tasksBeforePreflight = listTaskStatuses(repoRoot).map((task) => task.id);
  const failedPreflight = await callMcpTool("task_preflight", {
    repoPath: repoRoot,
    gitDeliveries: ["keep"],
    capabilityReports: [
      {
        connector: "firebase",
        scope: "projects/test/events",
        access: "read",
        status: "interactive_required",
      },
    ],
  });
  const missingPreflightCreate = await callMcpTool("task_create", {
    repoPath: repoRoot,
    title: "Must not exist",
    description: "Creation without a successful preflight must fail.",
  });
  const missingRepoPath = await callMcpTool("runner_status", {});
  assert(
    failedPreflight?.isError === true &&
      missingPreflightCreate?.isError === true &&
      missingRepoPath?.isError === true &&
      JSON.stringify(listTaskStatuses(repoRoot).map((task) => task.id)) ===
        JSON.stringify(tasksBeforePreflight),
    "failed or missing preflight created a task",
  );

  writeFileSync(
    configFile,
    `${JSON.stringify({
      ...baseRuntimeConfig,
      executionBackend: "app-server",
    })}\n`,
    "utf8",
  );
  const appServerPreflight = await callMcpTool("task_preflight", {
    repoPath: repoRoot,
    gitDeliveries: ["keep"],
    capabilityReports: [],
  });
  assert(
    appServerPreflight?.isError !== true &&
      appServerPreflight?.structuredContent?.preflightId,
    `app-server preflight failed: ${JSON.stringify(appServerPreflight)}`,
  );
  writeFileSync(
    configFile,
    `${JSON.stringify(baseRuntimeConfig)}\n`,
    "utf8",
  );

  const authorizedPreflight = await callMcpTool("task_preflight", {
    repoPath: repoRoot,
    gitDeliveries: ["keep"],
    capabilityReports: [],
  });
  assert(
    authorizedPreflight?.isError !== true &&
      authorizedPreflight?.structuredContent?.preflightId,
    `task preflight failed: ${JSON.stringify(authorizedPreflight)}`,
  );
  const tasksBeforeInvalidBatch = listTaskStatuses(repoRoot).map(
    (task) => task.id,
  );
  const invalidBatch = await callMcpTool("task_batch_create", {
    repoPath: repoRoot,
    preflightId: authorizedPreflight.structuredContent.preflightId,
    tasks: [
      {
        title: "Batch rollback first",
        description: "This staged task must be rolled back.",
        runMode: "interactive",
      },
      {
        title: "Batch rollback invalid",
        description: "",
        runMode: "interactive",
      },
    ],
  });
  assert(
    invalidBatch?.isError === true &&
      JSON.stringify(listTaskStatuses(repoRoot).map((task) => task.id)) ===
        JSON.stringify(tasksBeforeInvalidBatch),
    "invalid batch left a partial runnable task",
  );
  const authorizedParent = createTask(repoRoot, {
    title: "Fast verification with expert follow-up",
    description:
      "Verify the behavior and create an expert implementation task for confirmed findings.",
    modelProfile: "fast",
    runMode: "interactive",
    allowWorkerTaskCreation: true,
    preflightId: authorizedPreflight.structuredContent.preflightId,
  });
  const workerPlan = taskWorktreePlan({
    repoRoot,
    taskId: authorizedParent.id,
    title: authorizedParent.title,
    targetBranch: authorizedParent.git.targetBranch,
    delivery: authorizedParent.git.delivery,
    branch: authorizedParent.git.branch,
  });
  await prepareTaskWorktree(workerPlan);
  const workerEnv = {
    TODO_RUNNER_WORKER: "1",
    TODO_RUNNER_REPO_ROOT: repoRoot,
    TODO_RUNNER_WORKTREE: workerPlan.worktreePath,
    TODO_RUNNER_TASK_ID: authorizedParent.id,
  };
  const worktreeHookContext = runRoutingHook(
    {
      cwd: workerPlan.worktreePath,
      hook_event_name: "SubagentStart",
      agent_type: "general-purpose",
    },
    workerEnv,
  );
  assert(
    worktreeHookContext?.hookSpecificOutput?.additionalContext?.includes(
      TODO_ROUTING_POLICY,
    ) &&
      worktreeHookContext.hookSpecificOutput.additionalContext.includes(
        TODO_PONYTAIL_FULL_CONTOUR,
      ) &&
      worktreeHookContext.hookSpecificOutput.additionalContext.includes(
        "already claimed ToDo background worker",
      ),
    "claimed-worker hook did not resolve activation from a real task worktree",
  );
  const authorizedClaim = claimTask(authorizedParent.path, 78);
  let authorizedCreation;
  try {
    const workerPreflight = await callMcpTool(
      "task_preflight",
      {
        repoPath: workerPlan.worktreePath,
        gitDeliveries: ["keep"],
        capabilityReports: [
          {
            connector: "jira",
            scope: "issues/read",
            access: "read",
            status: "ok",
          },
        ],
      },
      workerEnv,
    );
    const workerPreflightId =
      workerPreflight?.structuredContent?.preflightId;
    assert(
      workerPreflight?.isError !== true && workerPreflightId,
      `worker worktree preflight was not normalized to the claimed repository: ${JSON.stringify(workerPreflight)}`,
    );

    const foreignRepo = path.join(repoRoot, ".todo", "foreign-worker-repo");
    mkdirSync(foreignRepo, { recursive: true });
    const foreignInit = spawnSync("git", ["-C", foreignRepo, "init", "--quiet"], {
      encoding: "utf8",
    });
    assert(foreignInit.status === 0, foreignInit.stderr || "foreign git init failed");
    const foreignPreflight = await callMcpTool(
      "task_preflight",
      { repoPath: foreignRepo, gitDeliveries: ["keep"] },
      workerEnv,
    );
    assert(
      foreignPreflight?.isError === true,
      "worker repoPath escaped to a repository with a different git-common-dir",
    );

    const tasksBeforeWorkerFailures = listTaskStatuses(repoRoot).map(
      (task) => task.id,
    );
    const restartRequest = path.join(repoRoot, ".todo", ".daemon-restart.json");
    writeFileSync(restartRequest, '{"status":"pending"}\n', "utf8");
    let updateBlocked;
    try {
      updateBlocked = await callMcpTool(
        "task_create",
        {
          repoPath: workerPlan.worktreePath,
          preflightId: workerPreflightId,
          requiredCapabilities: [
            { connector: "jira", scope: "issues/read", access: "read" },
          ],
          title: "Blocked during runtime update",
          description: "This follow-up must not be published.",
          runMode: "interactive",
        },
        workerEnv,
      );
    } finally {
      unlinkSync(restartRequest);
    }
    const uncoveredCapability = await callMcpTool(
      "task_create",
      {
        repoPath: workerPlan.worktreePath,
        preflightId: workerPreflightId,
        requiredCapabilities: [
          {
            connector: "firebase",
            scope: "projects/test/events",
            access: "read",
          },
        ],
        title: "Unverified connector follow-up",
        description: "This follow-up must not be published.",
        runMode: "interactive",
      },
      workerEnv,
    );
    assert(
      updateBlocked?.isError === true &&
        uncoveredCapability?.isError === true &&
        JSON.stringify(listTaskStatuses(repoRoot).map((task) => task.id)) ===
          JSON.stringify(tasksBeforeWorkerFailures),
      "worker published during runtime update or dropped a requested capability",
    );

    authorizedCreation = await callMcpTool(
      "task_create",
      {
        repoPath: workerPlan.worktreePath,
        preflightId: workerPreflightId,
        requiredCapabilities: [
          { connector: "jira", scope: "issues/read", access: "read" },
        ],
        title: "Expert implementation follow-up",
        description: "Implement the findings confirmed by the parent task.",
        modelProfile: "expert",
        runMode: "interactive",
        allowWorkerTaskCreation: true,
      },
      workerEnv,
    );
  } finally {
    releaseClaim(authorizedClaim);
  }
  const followUp = authorizedCreation?.structuredContent?.task;
  assert(
    authorizedCreation?.isError !== true &&
      followUp?.parentTaskId === authorizedParent.id &&
      followUp.blockers?.includes(authorizedParent.id) &&
      followUp.allowWorkerTaskCreation === false &&
      followUp.preflight?.capabilities?.some(
        (capability) => capability.connector === "jira",
      ) &&
      followUp.execution?.modelProfile === "expert",
    `explicitly authorized worker follow-up did not preserve parent, dependency, profile, or non-propagation: ${JSON.stringify(authorizedCreation)}`,
  );

  await callMcp();
  await callMcpStop();

  writeFileSync(configFile, '{"retries":-1}\n', "utf8");
  assert(
    loadConfig(repoRoot).retries === -1 &&
      canAutoRetry(loadConfig(repoRoot), {
        attemptLedger: {
          attempts: [{ status: "failed_transient" }],
          deliveryAttempts: [],
        },
      }),
    "retries=-1 was not loaded as unlimited",
  );
  writeFileSync(configFile, "{ invalid json\n", "utf8");
  const fallback = loadConfig(repoRoot);
  assert(
    fallback.workers === 4 && fallback.retries === 0,
    "invalid config did not fall back to workers=4 and retries=0",
  );
  assert(fallback.warning, "invalid config did not report a warning");

  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      maxActive,
      dependencyUnlocked: true,
      completionReceipts: 5,
      invalidWorkersFallback: fallback.workers,
      mcpTools: 18,
      repoInit: true,
      modelProfiles: true,
      taskEphemeralOverride: true,
      dashboard: dashboardUrl,
      dashboardDefaultStatusSort: true,
      dashboardLiveDomUpdates: true,
      dashboardTaskNumberLinks: true,
      dashboardFieldFilter: true,
      dashboardFilterClicks: true,
      dashboardCompactDurations: true,
      dashboardReadableUpdated: true,
      dashboardUnlimitedTasks: true,
      dashboardLogViewer: true,
      readableExecutionTranscript: true,
      executionPromptLogging: true,
      monotonicTaskIdsBeyond999: true,
      tokenUsageLogging: true,
      taskTimeLogging: true,
      retryMetricsAccumulated: true,
      runTimestampPairs: true,
      lastRunDuration: true,
      automaticRetries: true,
      unlimitedRetriesConfig: true,
      configHotReload: true,
      configReloadDefaultSeconds: 5,
      activeTasksPreservedOnReload: true,
      workerLimitDrain: true,
      modelProfilesHotReloaded: true,
      invalidConfigSnapshotRejected: true,
      liveDuration: true,
      zeroDefaultTokens: true,
      interactiveCurrentThread: true,
      explicitWorkerTaskCreation: true,
      backgroundFailureRequiresInteractive: true,
      strictResultSchemaObjects: true,
      daemonConflictProtection: true,
      unownedSigtermIgnored: true,
      taskUpdate: true,
      shortTaskIds: true,
      separateTaskAndWorkerStatus: true,
      artifactTypesPersisted: firstReceipt.artifacts.length,
      explicitSkills: explicitSkills.length,
      implicitRunSkill: true,
      implicitRouteSkill: true,
      durableRoutingPolicy: true,
      implicitSessionHook: true,
      promptRoutingHook: true,
      subagentRoutingHook: true,
    })}\n`,
  );
} finally {
  await stopDaemon(daemonPid);
  if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
}
