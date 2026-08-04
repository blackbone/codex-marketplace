import path from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  addTaskArtifacts,
  atomicWriteJson,
  cancelTask,
  createTask,
  DAEMON_IMPLEMENTATION,
  DAEMON_PROTOCOL_VERSION,
  daemonStopRequestPath,
  findGitRoot,
  findLegacyRunner,
  getTaskDetails,
  getTaskStatus,
  initializeRepo,
  isActivated,
  isCurrentDaemonState,
  listTaskStatuses,
  listWorkerStatuses,
  loadConfig,
  processIsAlive,
  readDaemonState,
  retryTask,
  finishInteractiveTask,
  startInteractiveTask,
  updateTask,
} from "./lib.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";

const pluginManifest = JSON.parse(
  readFileSync(
    new URL("../.codex-plugin/plugin.json", import.meta.url),
    "utf8",
  ),
);
const pluginVersion = pluginManifest.version;

const artifactInputSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["image", "file", "code", "url", "text"],
      description:
        "image/file copies binary data; code records a repository file reference; url records an HTTP(S) link; text writes inline content to a nearby file.",
    },
    source: {
      type: "string",
      minLength: 1,
      maxLength: 8000,
      description:
        "Local path for image/file, repository path for code, or HTTP(S) address for url.",
    },
    dataBase64: {
      type: "string",
      minLength: 1,
      description:
        "Base64 bytes for image/file when no readable local source path is available.",
    },
    content: {
      type: "string",
      minLength: 1,
      description: "Inline content for a text artifact.",
    },
    filename: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description:
        "Original filename for base64 or text content, including an extension when known.",
    },
    label: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description:
        "Why this artifact matters and what the worker should inspect.",
    },
    mimeType: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
    lineStart: {
      type: "integer",
      minimum: 1,
      description: "First relevant line for a code artifact.",
    },
    lineEnd: {
      type: "integer",
      minimum: 1,
      description: "Last relevant line for a code artifact.",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

const externalWorkflowSchema = {
  type: "object",
  properties: {
    service: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      description: "External system identifier, for example jira or asana.",
    },
    resourceId: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Stable external issue, task, or work-item identifier.",
    },
    url: {
      type: "string",
      minLength: 1,
      maxLength: 8000,
      description: "HTTP(S) URL of the external work item when available.",
    },
    label: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
  },
  required: ["service", "resourceId"],
  additionalProperties: false,
};

const externalSyncSchema = {
  type: "object",
  properties: {
    service: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    },
    resourceId: { type: "string", minLength: 1, maxLength: 512 },
    startedStatus: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Exact external status selected before implementation, normally the service-native In Progress state.",
    },
    finalStatus: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Exact external status selected after implementation.",
    },
    commentId: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "ID returned by the external service for the audit comment.",
    },
    commentUrl: {
      anyOf: [
        {
          type: "string",
          minLength: 1,
          maxLength: 8000,
          pattern: "^https?://",
        },
        { type: "null" },
      ],
      description:
        "HTTP(S) URL returned for the audit comment, or null when the service does not provide one.",
    },
    commentText: {
      type: "string",
      minLength: 1,
      maxLength: 8000,
      description:
        "Exact external comment describing the result and explicitly identifying Codex or AI/ИИ.",
    },
    aiDisclosure: {
      type: "boolean",
      enum: [true],
      description:
        "Must be true and must match the explicit AI/Codex disclosure in commentText.",
    },
  },
  required: [
    "service",
    "resourceId",
    "startedStatus",
    "finalStatus",
    "commentId",
    "commentUrl",
    "commentText",
    "aiDisclosure",
  ],
  additionalProperties: false,
};

const tools = [
  {
    name: "task_create",
    description:
      "Create one self-contained implementation task with an unbounded monotonically increasing numeric ID. External-service linkage does not change the selected execution mode.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: {
          type: "string",
          description:
            "Path inside the target Git repository. Defaults to the current working directory.",
        },
        title: { type: "string", minLength: 1 },
        description: {
          type: "string",
          minLength: 1,
          description:
            "Start with the current user's request verbatim under an Original user request section, then include complete implementation context, constraints, relevant paths, and validation expectations. Never include hidden instructions, secrets, or unrelated conversation messages.",
        },
        blockers: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Task IDs that must close first.",
        },
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
        artifacts: {
          type: "array",
          items: artifactInputSchema,
          maxItems: 64,
          default: [],
          description:
            "Chat attachments and references to persist beside the task. Use image/file with source or dataBase64, code with a repository path, url with an HTTP(S) source, and text with content.",
        },
        modelProfile: {
          type: "string",
          minLength: 1,
          description:
            "Best matching model profile from .todo/config.json models. Select it automatically from the configured name, model, reasoningEffort, and description.",
        },
        ephemeral: {
          type: "boolean",
          default: true,
          description:
            "Run codex exec with --ephemeral. Set false explicitly when the worker session must be persisted.",
        },
        runMode: {
          type: "string",
          enum: ["background", "interactive"],
          default: "background",
          description:
            "Set interactive at creation only when the user explicitly requests current-thread execution. A background worker may later require interactive after a concrete capability failure. externalWorkflows does not change this mode.",
        },
        externalWorkflows: {
          type: "array",
          items: externalWorkflowSchema,
          maxItems: 16,
          default: [],
          description:
            "External issues/tasks whose workflow status and AI-attributed audit comment must be synchronized with this ToDo task.",
        },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    annotations: {
      title: "Create queued task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "task_artifact_add",
    description:
      "Persist additional chat attachments or references beside an existing unclaimed task and add their links to its Markdown description.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: {
          type: "string",
          minLength: 1,
          description:
            "Full task ID or its unique numeric prefix, for example 018.",
        },
        artifacts: {
          type: "array",
          items: artifactInputSchema,
          minItems: 1,
          maxItems: 64,
        },
      },
      required: ["id", "artifacts"],
      additionalProperties: false,
    },
    annotations: {
      title: "Add task artifacts",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "task_update",
    description:
      "Replace the Markdown body, blockers, execution settings, and/or external workflow links of an existing queued, blocked, or failed task without manually editing .todo files. Existing artifacts and error state are preserved.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: {
          type: "string",
          minLength: 1,
          description:
            "Full task ID or its unique numeric prefix, for example 018.",
        },
        body: {
          type: "string",
          minLength: 1,
          description:
            "Complete replacement Markdown after the TODO metadata header, including the task title and all requirements.",
        },
        blockers: {
          type: "array",
          items: { type: "string" },
          description:
            "Complete replacement blocker list. Omit to preserve current blockers.",
        },
        modelProfile: {
          type: "string",
          minLength: 1,
          description:
            "Replace the task model profile with one from .todo/config.json models.",
        },
        ephemeral: {
          type: "boolean",
          description:
            "Replace the task ephemeral setting. false omits --ephemeral.",
        },
        externalWorkflows: {
          type: "array",
          items: externalWorkflowSchema,
          maxItems: 16,
          description:
            "Complete replacement external workflow list. Use this to migrate legacy unclaimed tasks that contain authoritative external work links but no structured workflow metadata.",
        },
      },
      required: ["id"],
      anyOf: [
        { required: ["body"] },
        { required: ["blockers"] },
        { required: ["modelProfile"] },
        { required: ["ephemeral"] },
        { required: ["externalWorkflows"] },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Update queued task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "repo_init",
    description:
      "Activate durable ToDo routing in a Git repository by creating .todo/config.json and installing an idempotent managed routing block in the applicable root AGENTS instruction file. Existing configuration and unrelated instructions are never overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: {
          type: "string",
          description:
            "Path inside the target Git repository. Defaults to the current working directory.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Initialize ToDo",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_get",
    description:
      "Get one task body, status, blockers, recorded error, and completion receipt.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: {
          type: "string",
          minLength: 1,
          description:
            "Full task ID or its unique numeric prefix, for example 018.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Get task status",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_list",
    description: "List active tasks and optionally recent closed tasks.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        includeClosed: { type: "boolean", default: false },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "List tasks",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "worker_list",
    description:
      "List workers separately from tasks, including idle, busy, draining, or stopped state and the assigned task.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "List worker statuses",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "todo_status",
    description:
      "Return the complete ToDo status with separate tasks/workers sections and the daemon's last applied config reload state.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        includeClosed: { type: "boolean", default: false },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Todo status",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_retry",
    description:
      "Clear a failed task error so the background runner can retry it.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: { type: "string", minLength: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Retry failed task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_run_start",
    description:
      "Claim a queued or failed ToDo task for direct execution in the current interactive Codex thread. This prevents the background daemon from running the same task.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: {
          type: "string",
          minLength: 1,
          description:
            "Full task ID, filename, or unique numeric prefix, for example 018.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Run task in current thread",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "task_run_finish",
    description:
      "Finish a task claimed by task_run_start. A task linked to external services cannot complete without one status and AI-attributed comment receipt per external work item.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: { type: "string", minLength: 1 },
        claimToken: { type: "string", minLength: 1 },
        status: {
          type: "string",
          enum: ["completed", "failed"],
        },
        summary: { type: "string", minLength: 1 },
        validation: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
        error: {
          type: "string",
          description: "Concrete failure reason when status is failed.",
        },
        externalSync: {
          type: "array",
          items: externalSyncSchema,
          maxItems: 16,
          default: [],
          description:
            "Exact external start/final statuses and comment receipts. Required for completion of every task with externalWorkflows.",
        },
        externalSyncError: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description:
            "Why external workflow or comment synchronization could not be completed. Valid only when finishing an external task as failed.",
        },
      },
      required: ["id", "claimToken", "status", "summary"],
      additionalProperties: false,
    },
    annotations: {
      title: "Finish current-thread task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "task_cancel",
    description: "Cancel an unclaimed queued, blocked, or failed task.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: { type: "string", minLength: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Cancel task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "runner_status",
    description:
      "Report whether ToDo is activated and running, including the local dashboard URL and last applied config reload state.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Get runner status",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "runner_start",
    description:
      "Start the detached ToDo daemon for an activated repository.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Start runner",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "runner_stop",
    description:
      "Stop the detached ToDo daemon. Refuse while tasks are active unless force is explicitly true.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        force: {
          type: "boolean",
          default: false,
          description:
            "Interrupt active tasks and stop the daemon. Use only when the user explicitly requests interruption.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Stop runner",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function resolveRepo(args = {}) {
  const startPath = args.repoPath
    ? path.resolve(args.repoPath)
    : process.cwd();
  const repoRoot = findGitRoot(startPath);
  if (!repoRoot) throw new Error(`Not inside a Git repository: ${startPath}`);
  return repoRoot;
}

function activatedRepo(args) {
  const repoRoot = resolveRepo(args);
  if (!isActivated(repoRoot)) {
    throw new Error(
      `ToDo is not activated; create ${path.join(repoRoot, ".todo", "config.json")}`,
    );
  }
  return repoRoot;
}

async function stopRunner(repoRoot, force = false) {
  const daemon = readDaemonState(repoRoot);
  if (!daemon || !processIsAlive(daemon.pid)) {
    const staleStopRequest = daemonStopRequestPath(repoRoot);
    if (existsSync(staleStopRequest)) unlinkSync(staleStopRequest);
    return { repoRoot, status: "stopped", pid: daemon?.pid || null };
  }
  const active = Array.isArray(daemon.active) ? daemon.active : [];
  if (active.length > 0 && force !== true) {
    throw new Error(
      `ToDo has active tasks: ${active.join(", ")}. Invoke stop with force=true only to interrupt them.`,
    );
  }

  const stopRequest = daemonStopRequestPath(repoRoot);
  atomicWriteJson(stopRequest, {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    token: daemon.token,
    pid: daemon.pid,
    force: force === true,
    requestedAt: new Date().toISOString(),
  });

  try {
    process.kill(daemon.pid, "SIGTERM");
  } catch (error) {
    if (existsSync(stopRequest)) unlinkSync(stopRequest);
    if (error.code !== "ESRCH") throw error;
  }

  const deadline = Date.now() + 5000;
  while (processIsAlive(daemon.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processIsAlive(daemon.pid)) {
    throw new Error(`ToDo daemon ${daemon.pid} did not stop within 5 seconds`);
  }
  if (existsSync(stopRequest)) unlinkSync(stopRequest);
  return {
    repoRoot,
    status: "stopped",
    pid: daemon.pid,
    interruptedTasks: force === true ? active : [],
  };
}

function runnerStatus(repoRoot) {
  const activated = isActivated(repoRoot);
  const config = loadConfig(repoRoot);
  const daemon = activated ? readDaemonState(repoRoot) : null;
  const daemonAlive = daemon ? processIsAlive(daemon.pid) : false;
  const daemonCurrent = daemonAlive && isCurrentDaemonState(daemon);
  const daemonRunning = daemonCurrent && daemon.status === "running";
  const daemonStarting = daemonCurrent && daemon.status === "starting";
  const daemonStopping = daemonCurrent && daemon.status === "stopping";
  const appliedConfig = daemonCurrent ? daemon.appliedConfig || null : null;
  const conflictingDaemon =
    daemonAlive && !isCurrentDaemonState(daemon) ? daemon : null;
  const legacy = activated && !daemonAlive ? findLegacyRunner(repoRoot) : null;
  const running = daemonRunning || daemonStarting || legacy !== null;
  const tasks = activated ? listTaskStatuses(repoRoot) : [];
  const workerStatuses = activated ? listWorkerStatuses(repoRoot) : null;
  const counts = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }
  return {
    repoRoot,
    activated,
    running,
    workers: appliedConfig?.workers ?? config.workers,
    pollIntervalMs: appliedConfig?.pollIntervalMs ?? config.pollIntervalMs,
    configReloadIntervalMs:
      appliedConfig?.configReloadIntervalMs ?? config.configReloadIntervalMs,
    retries: appliedConfig?.retries ?? config.retries,
    dashboardPort: appliedConfig?.dashboardPort ?? config.dashboardPort,
    dashboardUrl: daemonRunning ? daemon.dashboard?.url || null : null,
    modelProfiles: appliedConfig?.modelProfiles ?? config.modelProfiles,
    defaultModelProfile:
      appliedConfig?.defaultModelProfile ?? config.defaultModelProfile,
    configWarning: daemonCurrent
      ? daemon.configReload?.warning || null
      : config.warning,
    configReload: daemonCurrent ? daemon.configReload || null : null,
    daemon: daemonCurrent ? daemon : null,
    daemonStarting,
    daemonStopping,
    conflictingDaemon,
    legacyRunner: legacy,
    tasks: counts,
    workerStates: workerStatuses,
  };
}

function todoStatus(repoRoot, args = {}) {
  const runner = runnerStatus(repoRoot);
  if (!runner.activated) {
    return {
      repoRoot,
      runner,
      tasks: { counts: {}, items: [] },
      workers: runner.workerStates,
    };
  }
  const tasks = listTaskStatuses(repoRoot, {
    includeClosed: args.includeClosed === true,
    limit:
      Number.isInteger(args.limit) && args.limit > 0
        ? Math.min(args.limit, 500)
        : 100,
  });
  const counts = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }
  return {
    repoRoot,
    runner: {
      activated: runner.activated,
      running: runner.running,
      type: runner.daemon
        ? "node"
        : runner.conflictingDaemon
          ? "conflict"
        : runner.legacyRunner
          ? "legacy"
          : null,
      state: runner.conflictingDaemon
        ? "conflict"
        : runner.daemon?.status || (runner.legacyRunner ? "running" : "stopped"),
      pid: runner.daemon?.pid ?? runner.legacyRunner?.pid ?? null,
      configuredWorkers: runner.workers,
      pollIntervalMs: runner.pollIntervalMs,
      configReloadIntervalMs: runner.configReloadIntervalMs,
      retries: runner.retries,
      dashboardUrl: runner.dashboardUrl,
      conflictingDaemon: runner.conflictingDaemon,
      modelProfiles: runner.modelProfiles,
      defaultModelProfile: runner.defaultModelProfile,
      configWarning: runner.configWarning,
      configReload: runner.configReload,
    },
    tasks: { counts, items: tasks },
    workers: runner.workerStates,
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case "task_create": {
      const repoRoot = activatedRepo(args);
      const task = createTask(repoRoot, args);
      if (task.execution?.mode === "interactive") {
        return {
          task: getTaskStatus(repoRoot, task.id),
          daemon: "deferred-interactive",
        };
      }
      const daemon = ensureDaemon(repoRoot);
      return { task: getTaskStatus(repoRoot, task.id), daemon: daemon.status };
    }
    case "task_artifact_add":
      return addTaskArtifacts(activatedRepo(args), args.id, args.artifacts);
    case "task_update":
      return updateTask(activatedRepo(args), args.id, args);
    case "repo_init":
      return initializeRepo(resolveRepo(args));
    case "task_get": {
      const repoRoot = activatedRepo(args);
      return getTaskDetails(repoRoot, args.id);
    }
    case "task_list": {
      const repoRoot = activatedRepo(args);
      return {
        repoRoot,
        tasks: listTaskStatuses(repoRoot, {
          includeClosed: args.includeClosed === true,
          limit:
            Number.isInteger(args.limit) && args.limit > 0
              ? Math.min(args.limit, 500)
              : 100,
        }),
      };
    }
    case "worker_list": {
      const repoRoot = activatedRepo(args);
      return { repoRoot, ...listWorkerStatuses(repoRoot) };
    }
    case "todo_status":
      return todoStatus(resolveRepo(args), args);
    case "task_retry": {
      const repoRoot = activatedRepo(args);
      const task = retryTask(repoRoot, args.id);
      if (task.execution?.mode !== "interactive") ensureDaemon(repoRoot);
      return task;
    }
    case "task_run_start":
      return startInteractiveTask(activatedRepo(args), args.id);
    case "task_run_finish":
      return finishInteractiveTask(
        activatedRepo(args),
        args.id,
        args,
      );
    case "task_cancel":
      return cancelTask(activatedRepo(args), args.id);
    case "runner_status":
      return runnerStatus(resolveRepo(args));
    case "runner_start": {
      const repoRoot = activatedRepo(args);
      return ensureDaemon(repoRoot);
    }
    case "runner_stop":
      return stopRunner(activatedRepo(args), args.force === true);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

async function handle(message) {
  if (message.method === "initialize") {
    return success(message.id, {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "todo", version: pluginVersion },
      instructions:
        "In repositories containing .todo/config.json, route every mutation through $todo:route even when the user does not mention ToDo: create it with task_create before changing repository state and leave it queued by default. Interactive execution is allowed only when the user explicitly requests it, or after a background attempt reports that it cannot proceed without a current-thread-only capability. Task IDs use an unbounded monotonic numeric sequence and continue past 999. Tasks linked to Jira, Asana, or any external service must include externalWorkflows, but that linkage never changes execution mode. In either mode, mirror the service-native workflow status before and after implementation and leave a result comment that explicitly says Codex/AI performed the work; pass its receipt through externalSync before completion. Already claimed ToDo workers must implement directly without nesting tasks. Read-only work stays inline. Use repo_init to activate durable routing. Never edit .todo task files directly.",
    });
  }
  if (message.method === "ping") return success(message.id, {});
  if (message.method === "tools/list") {
    return success(message.id, { tools });
  }
  if (message.method === "tools/call") {
    try {
      const value = await callTool(
        message.params?.name,
        message.params?.arguments || {},
      );
      return success(message.id, {
        content: [
          { type: "text", text: JSON.stringify(value, null, 2) },
        ],
        structuredContent: value,
        isError: false,
      });
    } catch (error) {
      return success(message.id, {
        content: [{ type: "text", text: error.message }],
        isError: true,
      });
    }
  }
  if (
    typeof message.method === "string" &&
    message.method.startsWith("notifications/")
  ) {
    return null;
  }
  return failure(message.id ?? null, -32601, "Method not found");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify(failure(null, -32700, "Parse error", error.message))}\n`,
      );
      continue;
    }
    handle(message)
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .catch((error) => {
        process.stdout.write(
          `${JSON.stringify(failure(message.id ?? null, -32603, error.message))}\n`,
        );
      });
  }
});
