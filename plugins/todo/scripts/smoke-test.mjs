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
  normalizeExternalTaskOutcome,
  processIsAlive,
  readDaemonState,
  releaseClaim,
  startInteractiveTask,
  taskArtifactDir,
  taskArtifactManifestPath,
  updateTask,
  writeHistory,
} from "./lib.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";
import {
  ROUTING_POLICY_END,
  ROUTING_POLICY_START,
  TODO_ROUTING_POLICY,
} from "./routing-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
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

async function callMcp() {
  const mcpConfig = JSON.parse(
    readFileSync(path.join(scriptDir, "..", ".mcp.json"), "utf8"),
  ).mcpServers.todo;
  const child = spawn(mcpConfig.command, mcpConfig.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PLUGIN_ROOT: path.resolve(scriptDir, ".."),
    },
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
        params: { name: "todo_status", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "worker_list", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "repo_init", arguments: {} },
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
  assert(
    toolsResponse?.result?.tools?.length === 15,
    "MCP did not list 15 tools",
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
    toolsResponse.result.tools.some((tool) => tool.name === "repo_init"),
    "MCP did not list repo_init",
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
  const finishTool = toolsResponse.result.tools.find(
    (tool) => tool.name === "task_run_finish",
  );
  assert(
    createTool?.inputSchema?.properties?.externalWorkflows &&
      createTool.inputSchema.properties.runMode &&
      finishTool?.inputSchema?.properties?.externalSync &&
      finishTool.inputSchema.properties.externalSyncError,
    "MCP did not expose external workflow synchronization fields",
  );
  const mcpExternalSyncItem =
    finishTool.inputSchema.properties.externalSync.items;
  assert(
    mcpExternalSyncItem.required?.includes("commentUrl") &&
      mcpExternalSyncItem.properties.commentUrl?.anyOf?.some(
        (entry) => entry.type === "string",
      ) &&
      mcpExternalSyncItem.properties.commentUrl.anyOf.some(
        (entry) => entry.type === "null",
      ),
    "MCP externalSync commentUrl must be required and nullable",
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

async function callMcpStop({ force = false, expectError = false } = {}) {
  const mcpConfig = JSON.parse(
    readFileSync(path.join(scriptDir, "..", ".mcp.json"), "utf8"),
  ).mcpServers.todo;
  const child = spawn(mcpConfig.command, mcpConfig.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PLUGIN_ROOT: path.resolve(scriptDir, ".."),
    },
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
        params: { name: "runner_stop", arguments: { force } },
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
      "MCP runner_stop did not refuse to interrupt active tasks",
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
  const externalSyncItemSchema = outputSchema.properties?.externalSync?.items;
  const commentUrlSchema = externalSyncItemSchema?.properties?.commentUrl;
  assert(
    externalSyncItemSchema?.required?.includes("commentUrl") &&
      commentUrlSchema?.anyOf?.some((entry) => entry.type === "string") &&
      commentUrlSchema.anyOf.some((entry) => entry.type === "null"),
    "result schema externalSync commentUrl must be required and nullable",
  );
  const aiDisclosureSchema =
    outputSchema.properties?.externalSync?.items?.properties?.aiDisclosure;
  assert(
    aiDisclosureSchema?.type === "boolean" &&
      aiDisclosureSchema.const === true,
    "result schema aiDisclosure must declare boolean type for Codex CLI compatibility",
  );
  const externalSchemaWorkflows = [
    { service: "jira", resourceId: "TODO-1" },
  ];
  const externalSchemaReceipt = {
    service: "jira",
    resourceId: "TODO-1",
    startedStatus: "In Progress",
    finalStatus: "Done",
    commentId: "10001",
    commentText: "Performed by Codex (AI). Strict schema regression test.",
    aiDisclosure: true,
  };
  const nullCommentUrlOutcome = normalizeExternalTaskOutcome(
    externalSchemaWorkflows,
    {
      status: "completed",
      externalSync: [{ ...externalSchemaReceipt, commentUrl: null }],
    },
  );
  assert(
    nullCommentUrlOutcome.externalSync[0].commentUrl === null &&
      nullCommentUrlOutcome.externalSync[0].aiDisclosure === true,
    "externalSync commentUrl null or aiDisclosure true was not preserved",
  );
  for (const commentUrl of [
    "http://jira.example.test/browse/TODO-1",
    "https://jira.example.test/browse/TODO-1?focusedCommentId=10001",
  ]) {
    const urlOutcome = normalizeExternalTaskOutcome(externalSchemaWorkflows, {
      status: "completed",
      externalSync: [{ ...externalSchemaReceipt, commentUrl }],
    });
    assert(
      urlOutcome.externalSync[0].commentUrl === commentUrl,
      `valid externalSync commentUrl was not accepted: ${commentUrl}`,
    );
  }
  let invalidCommentUrlRejected = false;
  try {
    normalizeExternalTaskOutcome(externalSchemaWorkflows, {
      status: "completed",
      externalSync: [
        { ...externalSchemaReceipt, commentUrl: "not-a-url" },
      ],
    });
  } catch (error) {
    invalidCommentUrlRejected = error.message.includes(
      "external sync commentUrl is invalid",
    );
  }
  assert(
    invalidCommentUrlRejected,
    "invalid externalSync commentUrl was accepted",
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
      initialized.config.modelProfiles.length === 2 &&
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
  const sessionContext = runRoutingHook({
    cwd: repoRoot,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  assert(
    sessionContext?.hookSpecificOutput?.additionalContext?.includes(
      "Route every request",
    ),
    "SessionStart hook did not inject ToDo routing policy",
  );
  const promptContext = runRoutingHook({
    cwd: repoRoot,
    hook_event_name: "UserPromptSubmit",
    prompt: "Fix the selected bug.",
  });
  assert(
    promptContext?.hookSpecificOutput?.additionalContext?.includes(
      "$todo:route",
    ),
    "UserPromptSubmit hook did not reinforce ToDo routing policy",
  );
  const workerContext = runRoutingHook(
    {
      cwd: repoRoot,
      hook_event_name: "SessionStart",
      source: "startup",
    },
    { TODO_RUNNER_WORKER: "1" },
  );
  assert(
    workerContext?.hookSpecificOutput?.additionalContext?.includes(
      "already claimed ToDo background worker",
    ),
    "routing hook did not exempt an already claimed worker",
  );

  const fakeCodex = path.join(repoRoot, "fake-codex.mjs");
  const invocationLog = path.join(repoRoot, "codex-invocations.jsonl");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, input }) + "\\n");
	  const retryFixture = input.includes("Retry this task after first failure.");
	  const externalFixture = input.includes('"resourceId":"GBX-123"');
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
	          ? "expected retry fixture failure"
	          : null,
	      validation: ["fake validation"],
	      requiresInteractive: interactiveRequiredFixture,
	      interactiveReason: interactiveRequiredFixture
	        ? "Browser access is required to finish the task"
	        : null,
	      ...(externalFixture
	        ? {
	            externalSync: [
	              {
	                service: "jira",
	                resourceId: "GBX-123",
	                startedStatus: "In Progress",
	                finalStatus: "Done",
	                commentId: "background-10001",
	                commentUrl:
	                  "https://jira.example.test/browse/GBX-123?focusedCommentId=background-10001",
	                commentText:
	                  "Performed by Codex (AI). Completed and validated the background task.",
	                aiDisclosure: true
	              }
	            ],
	            externalSyncError: null
	          }
	        : {})
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
        label: "External reference",
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
      withAddedArtifact.execution.ephemeral === true,
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
      firstTaskText.includes("artifacts/001-first-task/"),
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
    externalWorkflows: [
      {
        service: "jira",
        resourceId: "LEGACY-42",
        url: "https://jira.example.test/browse/LEGACY-42",
        label: "LEGACY-42",
      },
    ],
  });
  assert(
    updatedCanceled.execution.modelProfile === "fast" &&
      updatedCanceled.execution.ephemeral === false &&
      updatedCanceled.externalWorkflows?.[0]?.resourceId === "LEGACY-42",
    "task_update did not replace execution settings and external workflows",
  );
  const canceledReceipt = cancelTask(repoRoot, canceled.id);
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
  const external = createTask(repoRoot, {
    title: "External Jira task",
    description:
      "Mirror the linked Jira workflow and leave an AI-attributed result comment.",
    externalWorkflows: [
      {
        service: "jira",
        resourceId: "GBX-123",
        url: "https://jira.example.test/browse/GBX-123",
        label: "GBX-123",
      },
    ],
  });
  assert(
    external.execution.mode === "background" &&
      external.externalWorkflows?.[0]?.resourceId === "GBX-123",
    "external linkage changed the default background execution mode",
  );
  const externalInteractive = createTask(repoRoot, {
    title: "Explicit interactive external Jira task",
    description:
      "Run in the current thread because the user explicitly selected interactive execution.",
    runMode: "interactive",
    externalWorkflows: [
      {
        service: "jira",
        resourceId: "GBX-124",
        url: "https://jira.example.test/browse/GBX-124",
        label: "GBX-124",
      },
    ],
  });
  assert(
    externalInteractive.execution.mode === "interactive",
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
  assert(existsSync(path.join(runSkillDir, "SKILL.md")), "missing run skill");
  assert(
    readFileSync(path.join(runSkillDir, "agents", "openai.yaml"), "utf8").includes(
      "allow_implicit_invocation: true",
    ),
    "run skill does not allow plugin-plus-filename invocation",
  );
  const routeSkillDir = path.join(scriptDir, "..", "skills", "route");
  assert(
    existsSync(path.join(routeSkillDir, "SKILL.md")) &&
      readFileSync(
        path.join(routeSkillDir, "agents", "openai.yaml"),
        "utf8",
      ).includes("allow_implicit_invocation: true") &&
      readFileSync(path.join(routeSkillDir, "SKILL.md"), "utf8").includes(
        "even when the user does not mention ToDo",
      ),
    "route skill does not allow implicit repository mutation routing",
  );
  const hooksFile = path.join(scriptDir, "..", "hooks", "hooks.json");
  const hookConfig = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert(
    hookConfig.hooks?.SessionStart?.length === 1 &&
      hookConfig.hooks?.UserPromptSubmit?.length === 1 &&
      hookConfig.hooks?.SubagentStart?.length === 1,
    "routing lifecycle hooks are incomplete",
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
    "config reload stopped or mutated active task snapshots",
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
    "invalid config replaced the last valid snapshot or stopped active tasks",
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
  cancelTask(repoRoot, hotProfileTask.id);
  writeFileSync(
    configFile,
    `${JSON.stringify(baseRuntimeConfig)}\n`,
    "utf8",
  );
  await waitFor(
    () => readDaemonState(repoRoot)?.workers === 2,
    "daemon did not hot-reload the restored worker limit",
  );
  await callMcpStop({ expectError: true });
  assert(
    processIsAlive(daemonPid),
    "runner_stop interrupted active tasks without force",
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
    ["placeholder", dashboardHtml.includes('placeholder="crashlytics status:failed"')],
    ["status-filter", dashboardHtml.includes('data-filter-field="status"')],
    ["profile-filter", dashboardHtml.includes('data-filter-field="profile"')],
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
      dashboardScript.includes('status.dataset.filterField = "status"') &&
      dashboardScript.includes('profileButton.dataset.filterField = "profile"') &&
      dashboardScript.includes('setTimeout(() => loadLog(entry, true), 2000)') &&
      dashboardScript.includes("tableBody.replaceChildren(fragment)") &&
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
  const dashboardApiResponse = await fetch(
    new URL("/api/status", dashboardUrl),
  );
  const dashboardApi = await dashboardApiResponse.json();
  const liveTask = dashboardApi.tasks.find((task) => task.status === "running");
  assert(
    dashboardApiResponse.status === 200 &&
      Array.isArray(dashboardApi.tasks) &&
      dashboardApi.tasks.length > 200 &&
      dashboardApi.tasks.some(
        (task) => task.id === "500-dashboard-unbounded-fixture",
      ) &&
      dashboardApi.tasks.some(
        (task) => task.id === "704-dashboard-unbounded-fixture",
      ) &&
      Array.isArray(dashboardApi.workers?.items) &&
    dashboardApi.runner?.implementation === "todo" &&
      dashboardApi.runner?.protocolVersion === 2 &&
      dashboardApi.config?.configReloadIntervalMs === 250 &&
      typeof dashboardApi.runner?.configReload?.appliedAt === "string" &&
      liveTask?.metrics?.durationMs > 0 &&
      liveTask?.metrics?.tokenUsage?.totalTokens === 0 &&
      typeof liveTask?.metrics?.startedAt === "string" &&
      liveTask?.metrics?.completedAt === null &&
      typeof liveTask?.metrics?.lastRun?.startedAt === "string" &&
      liveTask?.metrics?.lastRun?.completedAt === null &&
      !Object.hasOwn(liveTask.claim || {}, "claimedAt"),
    "dashboard status API did not return tasks and workers",
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
  assert(
    dashboardHtml.includes(">Start<") &&
      dashboardHtml.includes(">End<") &&
      dashboardHtml.includes(">Last Run<"),
    "dashboard did not render task run columns",
  );
  const busyWorkers = listWorkerStatuses(repoRoot);
  assert(
    busyWorkers.items.filter((worker) => worker.status === "busy").length === 2,
    "worker status did not show two busy workers",
  );
  assert(
    busyWorkers.items.every(
      (worker) => worker.taskId && worker.taskTitle && worker.pid,
    ),
    "busy workers did not expose assigned task details",
  );
  await waitFor(
    () =>
      [first, blocked, parallel, external].every(
        (task) => getTaskStatus(repoRoot, task.id).status === "completed",
      ) &&
      getTaskStatus(repoRoot, interactiveFallback.id).status === "failed",
    "tasks did not complete",
  );
  const externalBackgroundReceipt = getTaskStatus(repoRoot, external.id);
  assert(
    externalBackgroundReceipt.status === "completed" &&
      externalBackgroundReceipt.execution?.mode === "background" &&
      externalBackgroundReceipt.externalSync?.[0]?.commentId ===
        "background-10001" &&
      typeof externalBackgroundReceipt.externalSync?.[0]?.syncedAt ===
        "string",
    "background external task did not complete with a synchronization receipt",
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
  const fastInvocation = invocations.find((entry) =>
    entry.input.includes(".todo/001-first-task.md"),
  );
  const persistentInvocation = invocations.find((entry) =>
    entry.input.includes(".todo/004-parallel-task.md"),
  );
  assert(
    invocations.some((entry) =>
      entry.input.includes(`.todo/${path.basename(external.path)}`),
    ) &&
      invocations.some((entry) =>
        entry.input.includes(
          `.todo/${path.basename(interactiveFallback.path)}`,
        ),
      ) &&
      !invocations.some((entry) =>
        entry.input.includes(
          `.todo/${path.basename(externalInteractive.path)}`,
        ),
      ),
    "daemon did not respect background, fallback, and explicit interactive modes",
  );
  assert(
    fastInvocation?.args.includes("--ephemeral") &&
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
      firstUsage.status === "completed" &&
      firstUsage.attempts === 1 &&
      typeof firstUsage.startedAt === "string" &&
      typeof firstUsage.completedAt === "string" &&
      Date.parse(firstUsage.completedAt) >= Date.parse(firstUsage.startedAt) &&
      firstUsage.durationMs >= 750 &&
      firstUsage.durationSeconds > 0 &&
      firstUsage.durationMinutes > 0 &&
      /^\d{2,}d \d{2}h \d{2}m \d{2}s$/.test(firstUsage.durationHuman) &&
      firstUsage.runs?.length === 1 &&
      firstUsage.runs[0].startedAt === firstUsage.startedAt &&
      firstUsage.runs[0].completedAt === firstUsage.completedAt &&
      firstUsage.lastRun.startedAt === firstUsage.startedAt &&
      firstUsage.lastRun.completedAt === firstUsage.completedAt &&
      firstUsage.tokenUsage.available === true &&
      firstUsage.tokenUsage.inputTokens === 101 &&
      firstUsage.tokenUsage.cachedInputTokens === 40 &&
      firstUsage.tokenUsage.outputTokens === 17 &&
      firstUsage.tokenUsage.reasoningOutputTokens === 3 &&
      firstUsage.tokenUsage.totalTokens === 118 &&
      firstUsage.promptFile === "prompt.txt" &&
      firstPrompt.includes("You are a ToDo worker") &&
      firstPrompt.includes("Task file: .todo/001-first-task.md") &&
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
      runnerLog.includes("completedAt=") &&
      runnerLog.includes("durationSeconds=") &&
      runnerLog.includes("durationMinutes=") &&
      runnerLog.includes("tokenUsage=") &&
      runnerLog.includes("event=config_reloaded") &&
      runnerLog.includes('changed=["workers","modelProfiles","defaultModelProfile"]') &&
      runnerLog.includes("activeTasksPreserved=2") &&
      runnerLog.includes("event=config_reload_rejected"),
    "task time and token usage were not logged at start and completion",
  );
  assert(
    firstReceipt.metrics?.startedAt === firstUsage.startedAt &&
      firstReceipt.metrics?.completedAt === firstUsage.completedAt &&
      firstReceipt.metrics?.durationHuman === firstUsage.durationHuman &&
      firstReceipt.metrics?.runs?.length === 1 &&
      firstReceipt.metrics?.lastRun?.startedAt === firstUsage.startedAt &&
      firstReceipt.metrics?.lastRun?.completedAt === firstUsage.completedAt &&
      firstReceipt.metrics?.tokenUsage?.totalTokens === 118,
    "completion receipt did not expose task time and token usage",
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
      completedDashboardHtml.includes("<th>Logs</th>") &&
      !completedDashboardHtml.includes("00d 00h 00m") &&
      completedDashboardHtml.includes(">118</td>"),
    "dashboard did not expose task time and token usage",
  );
  const retrying = createTask(repoRoot, {
    title: "Retry metrics task",
    description: "Retry this task after first failure.",
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
      retriedRunnerLog.includes("event=task_auto_retry"),
    "automatic retry did not accumulate time and token usage",
  );
  const externalClaim = startInteractiveTask(
    repoRoot,
    externalInteractive.id,
  );
  let missingExternalSyncRejected = false;
  try {
    finishInteractiveTask(repoRoot, externalInteractive.id, {
      claimToken: externalClaim.claimToken,
      status: "completed",
      summary: "Implementation completed but no external receipt supplied.",
    });
  } catch (error) {
    missingExternalSyncRejected = error.message.includes(
      "AI-attributed comment receipts",
    );
  }
  assert(
    missingExternalSyncRejected &&
      getTaskStatus(repoRoot, externalInteractive.id).status === "running",
    "external task completed without synchronization evidence",
  );
  let missingDisclosureRejected = false;
  try {
    finishInteractiveTask(repoRoot, externalInteractive.id, {
      claimToken: externalClaim.claimToken,
      status: "completed",
      summary: "Implementation and Jira synchronization completed.",
      externalSync: [
        {
          service: "jira",
          resourceId: "GBX-124",
          startedStatus: "In Progress",
          finalStatus: "Done",
          commentId: "10001",
          commentText: "Implemented and validated the requested change.",
          aiDisclosure: true,
        },
      ],
    });
  } catch (error) {
    missingDisclosureRejected = error.message.includes(
      "Codex or AI/ИИ",
    );
  }
  assert(
    missingDisclosureRejected,
    "external comment without an AI disclosure was accepted",
  );
  const externalComment =
    "Performed by Codex (AI). Completed the requested implementation and smoke validation.";
  const externalReceipt = finishInteractiveTask(
    repoRoot,
    externalInteractive.id,
    {
      claimToken: externalClaim.claimToken,
      status: "completed",
      summary: "Implementation and Jira synchronization completed.",
      validation: ["external workflow smoke validation"],
      externalSync: [
        {
          service: "jira",
          resourceId: "GBX-124",
          startedStatus: "In Progress",
          finalStatus: "Done",
          commentId: "10002",
          commentUrl:
            "https://jira.example.test/browse/GBX-124?focusedCommentId=10002",
          commentText: externalComment,
          aiDisclosure: true,
        },
      ],
    },
  );
  assert(
    externalReceipt.status === "completed" &&
      externalReceipt.execution?.mode === "interactive" &&
      externalReceipt.externalWorkflows?.[0]?.resourceId === "GBX-124" &&
      externalReceipt.externalSync?.[0]?.startedStatus === "In Progress" &&
      externalReceipt.externalSync?.[0]?.finalStatus === "Done" &&
      externalReceipt.externalSync?.[0]?.commentId === "10002" &&
      externalReceipt.externalSync?.[0]?.commentText === externalComment &&
      externalReceipt.externalSync?.[0]?.aiDisclosure === true &&
      typeof externalReceipt.externalSync?.[0]?.syncedAt === "string",
    "external workflow completion receipt was incomplete",
  );
  const externalFailure = createTask(repoRoot, {
    title: "External Asana sync failure",
    description: "Record a connector failure without false completion.",
    runMode: "interactive",
    externalWorkflows: [
      {
        service: "asana",
        resourceId: "1200123456789",
      },
    ],
  });
  const externalFailureClaim = startInteractiveTask(
    repoRoot,
    externalFailure.id,
  );
  const externalFailureReceipt = finishInteractiveTask(
    repoRoot,
    externalFailure.id,
    {
      claimToken: externalFailureClaim.claimToken,
      status: "failed",
      summary: "Could not synchronize the Asana workflow.",
      error: "Asana connector was unavailable.",
      externalSyncError: "Asana connector was unavailable.",
    },
  );
  assert(
    externalFailureReceipt.status === "failed" &&
      externalFailureReceipt.externalSyncError ===
        "Asana connector was unavailable.",
    "external synchronization failure was falsely completed or not recorded",
  );
  const interactive = createTask(repoRoot, {
    title: "Interactive browser task",
    description: "Complete this task in the current Codex thread.",
    runMode: "interactive",
  });
  const interactiveClaim = startInteractiveTask(repoRoot, interactive.id);
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
  const interactiveReceipt = finishInteractiveTask(
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

  await callMcp();
  await callMcpStop();

  writeFileSync(configFile, '{"retries":-1}\n', "utf8");
  assert(
    loadConfig(repoRoot).retries === -1 &&
      canAutoRetry(loadConfig(repoRoot), { attempts: 999 }),
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
      completionReceipts: 6,
      invalidWorkersFallback: fallback.workers,
      mcpTools: 15,
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
      externalWorkflowModeIndependent: true,
      backgroundFailureRequiresInteractive: true,
      externalWorkflowSyncRequired: true,
      externalAiDisclosureRecorded: true,
      externalSyncFailureRecorded: true,
      codexCliTypedConstSchema: true,
      strictResultSchemaObjects: true,
      nullableExternalSyncCommentUrl: true,
      validExternalSyncCommentUrl: true,
      invalidExternalSyncCommentUrlRejected: true,
      mcpNullableExternalSyncCommentUrl: true,
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
