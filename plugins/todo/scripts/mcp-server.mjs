import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  addTaskArtifacts,
  atomicWriteJson,
  bindSupervisor,
  cancelTask,
  clearSupervisor,
  createTaskBatch,
  currentGitBranch,
  DAEMON_IMPLEMENTATION,
  DAEMON_PROTOCOL_VERSION,
  daemonStopRequestPath,
  findGitRoot,
  findLegacyRunner,
  getTaskDetails,
  getTaskStatus,
  getSupervisorStatus,
  initializeRepo,
  isActivated,
  isCurrentDaemonState,
  listTaskStatuses,
  listWorkerStatuses,
  loadConfig,
  processIsAlive,
  readDaemonState,
  readJson,
  retryTask,
  reopenTask,
  finishInteractiveTask,
  startInteractiveTask,
  updateTask,
  todoDir,
} from "./lib.mjs";
import { ensureDaemon, verifyDaemonProcess } from "./ensure-daemon.mjs";
import {
  commandCheck,
  createPreflightReceipt,
  runLocalPreflightChecks,
  validatePreflightReceipt,
} from "./preflight.mjs";
import {
  daemonRestartRequestPath,
  readDaemonRestartRequest,
  runtimeDescriptor,
} from "./runtime-update.mjs";

const pluginManifest = JSON.parse(
  readFileSync(
    new URL("../.codex-plugin/plugin.json", import.meta.url),
    "utf8",
  ),
);
const pluginVersion = pluginManifest.version;
const pluginRuntime = runtimeDescriptor(
  fileURLToPath(new URL("..", import.meta.url)),
);

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

const capabilityInputSchema = {
  type: "object",
  properties: {
    connector: { type: "string", minLength: 1, maxLength: 200 },
    scope: { type: "string", minLength: 1, maxLength: 1000 },
    access: { type: "string", enum: ["read", "write"] },
  },
  required: ["connector", "scope", "access"],
  additionalProperties: false,
};

const taskInputProperties = {
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
  },
  modelProfile: { type: "string", minLength: 1 },
  ephemeral: { type: "boolean", default: false },
  runMode: {
    type: "string",
    enum: ["background", "interactive"],
    default: "background",
  },
  delivery: {
    type: "string",
    enum: ["keep", "merge", "pr"],
    description:
      "Git delivery. pr must be explicitly requested; otherwise the repository default is used.",
  },
  allowWorkerTaskCreation: { type: "boolean", default: false },
};

const tools = [
  {
    name: "task_preflight",
    description:
      "Validate local Git/Codex readiness and record the minimal results of interactive connector probes before any task is created.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        capabilityReports: {
          type: "array",
          default: [],
          items: {
            type: "object",
            properties: {
              ...capabilityInputSchema.properties,
              required: { type: "boolean", default: true },
              status: {
                type: "string",
                enum: ["ok", "failed", "interactive_required"],
              },
              summary: { type: "string", minLength: 1, maxLength: 500 },
            },
            required: ["connector", "scope", "access", "status"],
            additionalProperties: false,
          },
        },
        gitDeliveries: {
          type: "array",
          items: { type: "string", enum: ["keep", "merge", "pr"] },
          default: ["keep"],
        },
        targetBranch: {
          type: "string",
          minLength: 1,
          description:
            "Exact target branch to validate. Defaults to git.targetBranch or the current branch.",
        },
      },
      required: ["repoPath"],
      additionalProperties: false,
    },
    annotations: {
      title: "Preflight task batch",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "task_batch_create",
    description:
      "Create a fully validated batch only after a current matching preflight receipt; failed validation creates zero runnable tasks.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        preflightId: { type: "string", minLength: 1 },
        requiredCapabilities: {
          type: "array",
          items: capabilityInputSchema,
          default: [],
        },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: taskInputProperties,
            required: ["title", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["repoPath", "preflightId", "tasks"],
      additionalProperties: false,
    },
    annotations: {
      title: "Create task batch",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "task_create",
    description:
      "Create one self-contained implementation task with an unbounded monotonically increasing numeric ID. A claimed worker call is accepted only when its parent records explicit user authorization.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: {
          type: "string",
          description: "Path inside the target Git repository.",
        },
        preflightId: { type: "string", minLength: 1 },
        requiredCapabilities: {
          type: "array",
          items: capabilityInputSchema,
          default: [],
        },
        ...taskInputProperties,
      },
      required: ["repoPath", "title", "description"],
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
      required: ["repoPath", "id", "artifacts"],
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
      "Replace the Markdown body, blockers, execution settings, and/or worker task-creation permission of an existing queued, blocked, or failed task without manually editing .todo files. Existing artifacts and error state are preserved.",
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
        delivery: {
          type: "string",
          enum: ["keep", "merge", "pr"],
          description:
            "Replace Git delivery; a matching fresh preflightId is required.",
        },
        preflightId: { type: "string", minLength: 1 },
        requiredCapabilities: {
          type: "array",
          items: capabilityInputSchema,
          default: [],
        },
        allowWorkerTaskCreation: {
          type: "boolean",
          description:
            "Replace the worker task-creation permission. Set true only from an explicit current-user instruction; omit to preserve it.",
        },
      },
      required: ["repoPath", "id"],
      anyOf: [
        { required: ["body"] },
        { required: ["blockers"] },
        { required: ["modelProfile"] },
        { required: ["ephemeral"] },
        { required: ["delivery"] },
        { required: ["allowWorkerTaskCreation"] },
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
          description: "Path inside the target Git repository.",
        },
      },
      required: ["repoPath"],
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
      required: ["repoPath", "id"],
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
      required: ["repoPath"],
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
      required: ["repoPath"],
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
      required: ["repoPath"],
      additionalProperties: false,
    },
    annotations: {
      title: "Todo status",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_get",
    description:
      "Return the repository-bound heartbeat definition and whether ToDo currently needs it active or paused.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
      },
      required: ["repoPath"],
      additionalProperties: false,
    },
    annotations: {
      title: "Get ToDo supervisor state",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_bind",
    description:
      "Persist the repository binding for a Codex heartbeat after the host automation was successfully created, updated, paused, or resumed.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        automationId: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 20000 },
        rrule: { type: "string", minLength: 1, maxLength: 1000 },
        status: { type: "string", enum: ["ACTIVE", "PAUSED"] },
      },
      required: [
        "repoPath",
        "automationId",
        "name",
        "prompt",
        "rrule",
        "status",
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Bind ToDo supervisor",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "supervisor_clear",
    description:
      "Remove the repository heartbeat binding after the host automation was successfully deleted.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
      },
      required: ["repoPath"],
      additionalProperties: false,
    },
    annotations: {
      title: "Clear ToDo supervisor binding",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
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
      required: ["repoPath", "id"],
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
    name: "task_reopen",
    description:
      "Reopen a completed or canceled task and continue its persistent Codex thread.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        id: { type: "string", minLength: 1 },
      },
      required: ["repoPath", "id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Reopen closed task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
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
      required: ["repoPath", "id"],
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
      "Finish a task claimed by task_run_start.",
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
      },
      required: ["repoPath", "id", "claimToken", "status", "summary"],
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
      required: ["repoPath", "id"],
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
      required: ["repoPath"],
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
      required: ["repoPath"],
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
      required: ["repoPath"],
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

function gitCommonDir(repoRoot) {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", timeout: 10000 },
  );
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const commonDir = path.resolve(repoRoot, result.stdout.trim());
  return existsSync(commonDir) ? realpathSync(commonDir) : null;
}

function resolveRepo(args = {}) {
  const worker = process.env.TODO_RUNNER_WORKER === "1";
  const claimedPath = worker && process.env.TODO_RUNNER_REPO_ROOT;
  if (!args.repoPath && !claimedPath) {
    throw new Error("repoPath is required");
  }
  const startPath = path.resolve(args.repoPath || claimedPath);
  const repoRoot = findGitRoot(startPath);
  if (!repoRoot) throw new Error(`Not inside a Git repository: ${startPath}`);
  if (!worker) return repoRoot;

  const claimedRepoRoot = claimedPath
    ? findGitRoot(path.resolve(claimedPath))
    : null;
  const requestedCommonDir = gitCommonDir(repoRoot);
  const claimedCommonDir = claimedRepoRoot
    ? gitCommonDir(claimedRepoRoot)
    : null;
  if (
    !claimedRepoRoot ||
    !requestedCommonDir ||
    requestedCommonDir !== claimedCommonDir
  ) {
    throw new Error(
      "A claimed ToDo worker may access only its claimed Git repository",
    );
  }
  return claimedRepoRoot;
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

function workerTaskCreationArgs(repoRoot, args) {
  if (process.env.TODO_RUNNER_WORKER !== "1") return args;

  const workerRepoRoot = process.env.TODO_RUNNER_REPO_ROOT;
  const claimedRepoRoot = workerRepoRoot
    ? findGitRoot(path.resolve(workerRepoRoot))
    : null;
  if (!claimedRepoRoot || claimedRepoRoot !== repoRoot) {
    throw new Error(
      "A claimed ToDo worker may create follow-up tasks only in its claimed repository",
    );
  }

  const parentTaskId = process.env.TODO_RUNNER_TASK_ID;
  if (!parentTaskId) {
    throw new Error(
      "Claimed worker task creation is missing TODO_RUNNER_TASK_ID",
    );
  }
  const parent = getTaskDetails(repoRoot, parentTaskId);
  if (
    parent.status !== "running" ||
    parent.workerId === null ||
    parent.workerId === "interactive"
  ) {
    throw new Error(
      `Claimed parent task is not running in a background worker: ${parentTaskId}`,
    );
  }
  if (parent.allowWorkerTaskCreation !== true) {
    throw new Error(
      `Task ${parent.id} does not record explicit user authorization to create follow-up tasks`,
    );
  }

  if (!args.preflightId) {
    throw new Error(
      "Claimed workers must run task_preflight and provide its fresh preflightId",
    );
  }
  const capabilities = [
    ...(parent.preflight?.capabilities || []),
    ...(args.requiredCapabilities || []),
  ];
  const requiredCapabilities = [
    ...new Map(
      capabilities.map((item) => [
        JSON.stringify([item.connector, item.scope, item.access]),
        item,
      ]),
    ).values(),
  ];

  return {
    ...args,
    preflightId: args.preflightId,
    requiredCapabilities,
    blockers: [...(args.blockers || []), parent.id],
    allowWorkerTaskCreation: false,
    parentTaskId: parent.id,
  };
}

function ensureWorkerTaskCreationRuntime(repoRoot) {
  const daemon = readDaemonState(repoRoot);
  const identity = daemon
    ? verifyDaemonProcess(repoRoot, daemon)
    : { ok: false };
  const restartPath = daemonRestartRequestPath(repoRoot);
  const restart = readDaemonRestartRequest(repoRoot);
  if (
    !daemon ||
    !processIsAlive(daemon.pid) ||
    !isCurrentDaemonState(daemon) ||
    !identity.ok ||
    !pluginRuntime.available ||
    daemon.pluginVersion !== pluginVersion ||
    (daemon.runtime?.fingerprint || daemon.runtimeFingerprint) !==
      pluginRuntime.fingerprint ||
    daemon.status !== "running" ||
    (daemon.runtimeUpdate?.status && daemon.runtimeUpdate.status !== "current") ||
    existsSync(restartPath) ||
    restart
  ) {
    throw new Error(
      "ToDo worker cannot publish tasks while the daemon runtime is unavailable or updating",
    );
  }
  return { status: "worker-parent" };
}

async function stopRunner(repoRoot, force = false) {
  const daemon = readDaemonState(repoRoot);
  if (!daemon || !processIsAlive(daemon.pid)) {
    const staleStopRequest = daemonStopRequestPath(repoRoot);
    if (existsSync(staleStopRequest)) unlinkSync(staleStopRequest);
    return { repoRoot, status: "stopped", pid: daemon?.pid || null };
  }
  const identity = verifyDaemonProcess(repoRoot, daemon);
  if (!identity.ok) {
    throw new Error(`Refusing to stop an unverified daemon PID: ${identity.reason}`);
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
  const daemonRestartPending =
    daemonCurrent && daemon.status === "restart-pending";
  const appliedConfig = daemonCurrent ? daemon.appliedConfig || null : null;
  const conflictingDaemon =
    daemonAlive && !isCurrentDaemonState(daemon) ? daemon : null;
  const legacy = activated && !daemonAlive ? findLegacyRunner(repoRoot) : null;
  const running =
    daemonRunning || daemonStarting || daemonRestartPending || legacy !== null;
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
    dashboardUrl:
      daemonRunning || daemonRestartPending
        ? daemon.dashboard?.url || null
        : null,
    modelProfiles: appliedConfig?.modelProfiles ?? config.modelProfiles,
    defaultModelProfile:
      appliedConfig?.defaultModelProfile ?? config.defaultModelProfile,
    configWarning: daemonCurrent
      ? daemon.configReload?.warning || null
      : config.warning,
    configReload: daemonCurrent ? daemon.configReload || null : null,
    git: appliedConfig?.git ?? config.git,
    runtime: daemonCurrent ? daemon.runtime || null : null,
    runtimeUpdate: daemonCurrent ? daemon.runtimeUpdate || null : null,
    daemon: daemonCurrent ? daemon : null,
    daemonStarting,
    daemonStopping,
    daemonRestartPending,
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
      git: runner.git,
      runtime: runner.runtime,
      runtimeUpdate: runner.runtimeUpdate,
    },
    tasks: { counts, items: tasks },
    workers: runner.workerStates,
    supervisor: getSupervisorStatus(repoRoot),
  };
}

function preflightBindingConfig(config, targetBranch) {
  return {
    ...config,
    git: { ...config.git, resolvedTargetBranch: targetBranch },
  };
}

function branchWorktrees(repoRoot, branch) {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "worktree", "list", "--porcelain"],
    { encoding: "utf8", timeout: 10000 },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      return {
        path: lines.find((line) => line.startsWith("worktree "))?.slice(9),
        branch: lines.find((line) => line.startsWith("branch "))?.slice(7),
      };
    })
    .filter(
      (item) => item.path && item.branch === `refs/heads/${branch}`,
    )
    .map((item) => item.path);
}

function preflightPath(repoRoot, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) {
    throw new Error("Invalid preflightId");
  }
  return path.join(todoDir(repoRoot), "preflight", `${id}.json`);
}

function requiredLocalChecks(deliveries) {
  const checks = [
    "config",
    "runtime",
    "git-root",
    "git-target",
    "git-identity",
    "codex-command",
    "git-worktree",
  ];
  if (deliveries.includes("merge")) checks.push("git-merge-target");
  if (deliveries.includes("pr")) checks.push("github-pr");
  return checks;
}

async function taskPreflight(repoRoot, args) {
  const config = loadConfig(repoRoot);
  const deliveries = [
    ...new Set(
      (Array.isArray(args.gitDeliveries) && args.gitDeliveries.length > 0
        ? args.gitDeliveries
        : [config.git.delivery]),
    ),
  ];
  const targetBranch =
    args.targetBranch || config.git.targetBranch || currentGitBranch(repoRoot);
  let runtime;
  try {
    runtime =
      process.env.TODO_RUNNER_WORKER === "1"
        ? ensureWorkerTaskCreationRuntime(repoRoot)
        : ensureDaemon(repoRoot);
  } catch (error) {
    runtime = { status: "failed", reason: error.message };
  }
  const runtimeReady = ["running", "already-running", "worker-parent"].includes(
    runtime.status,
  );
  const probePath = path.join(
    todoDir(repoRoot),
    `preflight-worktree-${randomUUID()}`,
  );
  const checks = await runLocalPreflightChecks(
    [
      {
        name: "config",
        run: () => ({
          status: config.readError ? "failed" : "ok",
          summary: config.readError || "configuration loaded",
        }),
      },
      {
        name: "runtime",
        run: () => ({
          status: runtimeReady ? "ok" : "failed",
          summary: runtimeReady
            ? `runtime ${runtime.status}`
            : `runtime ${runtime.status}: ${runtime.reason || runtime.runtimeUpdate?.reason || "not ready"}`,
        }),
      },
      {
        name: "git-root",
        run: () => commandCheck("git", ["rev-parse", "--show-toplevel"], repoRoot),
      },
      {
        name: "git-target",
        run: () => {
          if (!targetBranch) {
            return { status: "failed", summary: "target branch is unavailable" };
          }
          const valid = commandCheck(
            "git",
            ["check-ref-format", "--branch", targetBranch],
            repoRoot,
          );
          return valid.status === "ok"
            ? commandCheck(
                "git",
                [
                  "rev-parse",
                  "--verify",
                  "--end-of-options",
                  `refs/heads/${targetBranch}^{commit}`,
                ],
                repoRoot,
              )
            : valid;
        },
      },
      {
        name: "git-identity",
        run: () => {
          const name = commandCheck("git", ["config", "user.name"], repoRoot);
          const email = commandCheck("git", ["config", "user.email"], repoRoot);
          return name.status === "ok" && email.status === "ok"
            ? { status: "ok", summary: "Git identity configured" }
            : { status: "failed", summary: "Git user.name/user.email missing" };
        },
      },
      {
        name: "codex-command",
        run: () =>
          commandCheck(
            config.codexCommand,
            config.executionBackend === "app-server"
              ? ["app-server", "--help"]
              : ["--version"],
            repoRoot,
          ),
      },
      {
        name: "git-worktree",
        run: () => {
          if (!targetBranch) {
            return { status: "failed", summary: "target branch is unavailable" };
          }
          const valid = commandCheck(
            "git",
            ["check-ref-format", "--branch", targetBranch],
            repoRoot,
          );
          if (valid.status !== "ok") return valid;
          const added = commandCheck(
            "git",
            [
              "worktree",
              "add",
              "--detach",
              probePath,
              `refs/heads/${targetBranch}`,
            ],
            repoRoot,
          );
          if (added.status !== "ok") return added;
          const removed = commandCheck(
            "git",
            ["worktree", "remove", "--force", probePath],
            repoRoot,
          );
          return existsSync(probePath)
            ? {
                status: "failed",
                summary: `probe worktree cleanup failed; preserved ${probePath}`,
              }
            : removed;
        },
      },
      {
        name: "git-merge-target",
        required: deliveries.includes("merge"),
        run: () => {
          const checkouts = branchWorktrees(repoRoot, targetBranch);
          if (checkouts.length === 0) {
            return { status: "ok", summary: "target is not checked out" };
          }
          if (checkouts.length > 1) {
            return { status: "failed", summary: "target has multiple checkouts" };
          }
          const dirty = spawnSync(
            "git",
            [
              "status",
              "--porcelain",
              "--untracked-files=all",
              "--",
              ".",
              ":(exclude).todo/**",
            ],
            { cwd: checkouts[0], encoding: "utf8" },
          );
          return dirty.status === 0 && !dirty.stdout.trim()
            ? { status: "ok", summary: "merge target is clean" }
            : { status: "failed", summary: "merge target is dirty" };
        },
      },
      {
        name: "github-pr",
        required: deliveries.includes("pr"),
        run: () => {
          const remote = commandCheck(
            "git",
            ["remote", "get-url", config.git.remote],
            repoRoot,
          );
          if (remote.status !== "ok") return remote;
          return commandCheck("gh", ["auth", "status"], repoRoot);
        },
      },
    ],
    { repoRoot },
  );
  if (process.env.TODO_RUNNER_WORKER === "1") {
    ensureWorkerTaskCreationRuntime(repoRoot);
  }
  const receipt = createPreflightReceipt({
    repoRoot,
    config: preflightBindingConfig(config, targetBranch),
    capabilityReports: args.capabilityReports || [],
    localPreflight: checks,
  });
  const receiptFile = preflightPath(repoRoot, receipt.id);
  mkdirSync(path.dirname(receiptFile), { recursive: true });
  atomicWriteJson(receiptFile, receipt);
  return {
    preflightId: receipt.id,
    expiresAt: new Date(receipt.expiresAt).toISOString(),
    capabilities: receipt.capabilities,
    localChecks: receipt.localChecks,
    deliveries,
    targetBranch,
  };
}

function validatedPreflight(
  repoRoot,
  args,
  tasks,
  { targetBranch: requestedTargetBranch } = {},
) {
  const config = loadConfig(repoRoot);
  const receiptFile = preflightPath(repoRoot, args.preflightId);
  if (!existsSync(receiptFile)) throw new Error("Preflight receipt not found");
  const deliveries = [
    ...new Set(tasks.map((task) => task.delivery || config.git.delivery)),
  ];
  const targetBranch =
    requestedTargetBranch || config.git.targetBranch || currentGitBranch(repoRoot);
  const receipt = validatePreflightReceipt(readJson(receiptFile), {
    repoRoot,
    config: preflightBindingConfig(config, targetBranch),
    requiredCapabilities: args.requiredCapabilities || [],
    requiredLocalChecks: requiredLocalChecks(deliveries),
  });
  return {
    receipt,
    gitSnapshot: {
      delivery: config.git.delivery,
      targetBranch,
      remote: config.git.remote,
    },
  };
}

function ensureTaskCreationRuntime(repoRoot) {
  const daemon = ensureDaemon(repoRoot);
  if (!["running", "already-running"].includes(daemon.status)) {
    throw new Error(
      `ToDo runtime is not current (${daemon.status}): ${daemon.reason || daemon.runtimeUpdate?.reason || "retry after the safe restart"}`,
    );
  }
  return daemon;
}

async function callTool(name, args = {}) {
  switch (name) {
    case "task_preflight":
      return taskPreflight(activatedRepo(args), args);
    case "task_batch_create": {
      if (process.env.TODO_RUNNER_WORKER === "1") {
        throw new Error("Background workers cannot create task batches");
      }
      const repoRoot = activatedRepo(args);
      const preflight = validatedPreflight(repoRoot, args, args.tasks);
      const daemon = ensureTaskCreationRuntime(repoRoot);
      const tasks = createTaskBatch(repoRoot, args.tasks, {
        preflightId: args.preflightId,
        requiredCapabilities: args.requiredCapabilities || [],
        gitSnapshot: preflight.gitSnapshot,
      });
      return { tasks, daemon: daemon.status };
    }
    case "task_create": {
      const repoRoot = activatedRepo(args);
      const input = workerTaskCreationArgs(repoRoot, args);
      const preflight = validatedPreflight(repoRoot, input, [input]);
      const daemon =
        process.env.TODO_RUNNER_WORKER === "1"
          ? ensureWorkerTaskCreationRuntime(repoRoot)
          : ensureTaskCreationRuntime(repoRoot);
      const [task] = createTaskBatch(repoRoot, [input], {
        preflightId: input.preflightId,
        requiredCapabilities: input.requiredCapabilities || [],
        gitSnapshot: preflight.gitSnapshot,
      });
      if (task.execution?.mode === "interactive") {
        return {
          task: getTaskStatus(repoRoot, task.id),
          daemon: "deferred-interactive",
        };
      }
      return { task: getTaskStatus(repoRoot, task.id), daemon: daemon.status };
    }
    case "task_artifact_add":
      return addTaskArtifacts(activatedRepo(args), args.id, args.artifacts);
    case "task_update": {
      const repoRoot = activatedRepo(args);
      if (args.delivery !== undefined) {
        const task = getTaskStatus(repoRoot, args.id);
        const targetBranch =
          task.git?.targetBranch ||
          loadConfig(repoRoot).git.targetBranch ||
          currentGitBranch(repoRoot);
        validatedPreflight(repoRoot, args, [{ delivery: args.delivery }], {
          targetBranch,
        });
      }
      return updateTask(repoRoot, args.id, args);
    }
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
    case "supervisor_get":
      return getSupervisorStatus(activatedRepo(args));
    case "supervisor_bind":
      return bindSupervisor(activatedRepo(args), args);
    case "supervisor_clear":
      return clearSupervisor(activatedRepo(args));
    case "task_retry": {
      const repoRoot = activatedRepo(args);
      const task = retryTask(repoRoot, args.id);
      if (task.execution?.mode !== "interactive") ensureDaemon(repoRoot);
      return task;
    }
    case "task_reopen": {
      const repoRoot = activatedRepo(args);
      const task = reopenTask(repoRoot, args.id);
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
    case "task_cancel": {
      const repoRoot = activatedRepo(args);
      const receipt = await cancelTask(repoRoot, args.id);
      if (receipt.codexThread?.state === "archive-pending") {
        ensureDaemon(repoRoot);
      }
      return receipt;
    }
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
        "In repositories containing .todo/config.json, route every mutation through $todo:route even when the user does not mention ToDo: create it with task_create before changing repository state and leave it queued for codex exec by default. Interactive execution is allowed only when the user explicitly requests it, or after a background attempt reports that it cannot proceed without a current-thread-only capability. Task IDs use an unbounded monotonic numeric sequence and continue past 999. A claimed background worker must implement directly and cannot create follow-up tasks unless its parent task records allowWorkerTaskCreation from an explicit user instruction. Authorized follow-up tasks automatically depend on the parent and cannot propagate that permission. Read-only work stays inline. Use repo_init to activate durable routing. Never edit .todo task files directly.",
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
