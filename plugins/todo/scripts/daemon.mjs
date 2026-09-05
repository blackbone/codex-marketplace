import { refreshModelCatalog, assertProfilesAvailable } from "./model-profiles.mjs";
import {
  closeSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  watch,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { readLogTail } from "./bounded-log.mjs";
import { runShellCommand } from "./shell-step.mjs";
import { startDashboard } from "./dashboard.mjs";
import {
  applyGitExcludes,
  atomicWriteJson,
  beginModelAttempt,
  canAutoRetry,
  claimTask,
  cleanupStaleClaims,
  completeTask,
  cumulativeTaskMetrics,
  DAEMON_IMPLEMENTATION,
  DAEMON_PROTOCOL_VERSION,
  daemonStatePath,
  daemonStopRequestPath,
  emptyTokenUsage,
  ensureLayout,
  getSupervisorStatus,
  getTaskStatus,
  listTaskStatuses,
  reconcileInteractiveClaim,
  formatTaskThreadTitle,
  isActivated,
  isCurrentDaemonState,
  listTaskFiles,
  listPendingThreadArchives,
  loadConfig,
  processIsAlive,
  finalizeTaskGit,
  markTaskModelCompleted,
  markClosedTaskThreadArchived,
  prepareTaskGit,
  prepareTaskMergeConflictRepair,
  processTaskMergeQueue,
  readDaemonState,
  readDashboardThreadRequest,
  readTask,
  readClaim,
  releaseClaim,
  resolveTaskExecution,
  resolveSavedExecution,
  resolvePipelineProfiles,
  retryTask,
  setTaskError,
  finishTaskMergeConflictRepair,
  taskBatchPublicationActive,
  taskMetrics,
  taskIdFromFilename,
  todoDir,
  updateTaskCodexThread,
  writeTask,
} from "./lib.mjs";
import {
  buildAttemptUsageV2,
  parseAppServerExecutionStats,
  parseExecutionStats,
  parseOtlpRequestStats,
} from "./execution-stats.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { createTaskInteraction } from "./task-interaction.mjs";
import { DesktopClient } from "./desktop-client.mjs";
import { classifyFailure } from "./attempt-ledger.mjs";
import { loadPipelineSnapshot, runPipeline } from "./pipeline.mjs";
import { WORKER_TOOLING_BOUNDARY } from "./routing-policy.mjs";
import { TODO_PONYTAIL_FULL_CONTOUR } from "./ponytail-policy.mjs";
import {
  daemonRestartDecision,
  runtimeDescriptor,
} from "./runtime-update.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const ownRuntime = runtimeDescriptor(pluginRoot);
const resultSchema = path.join(scriptDir, "result.schema.json");
const pipelineResultSchema = path.join(
  scriptDir,
  "pipeline-result.schema.json",
);
const repoIndex = process.argv.indexOf("--repo");
const repoRoot =
  repoIndex >= 0 && process.argv[repoIndex + 1]
    ? path.resolve(process.argv[repoIndex + 1])
    : path.resolve(process.env.TODO_RUNNER_REPO_ROOT || process.cwd());
const daemonToken = randomUUID();
const daemonStartedAt = new Date().toISOString();
const pluginVersion = ownRuntime.pluginVersion;
const active = new Map();
let desktopClient = null;
let desktopMaintenance = null;
let nextDesktopAttemptAt = 0;
const desktopThreadStates = new Map();
const desktopThreadRetryAt = new Map();
const desktopDispatches = new Set();
let nextDesktopDispatchAt = 0;
let dashboard = null;
let stopping = false;
let lastWarning = null;
let runtimeConfig = null;
let configLastCheckedAt = null;
let configAppliedAt = null;
let configReloadWarning = null;
let deactivationDeferred = false;
let runtimeUpdateRequest = null;
let appServer = null;
let appServerStartPromise = null;
let dashboardSyncPromise = null;
let supervisorTitleSyncPromise = null;
let supervisorTitleSyncQueued = false;
let lastSupervisorTitleSuccessKey = null;
let lastSupervisorTitleAttemptKey = null;
let lastSupervisorTitleAttemptAt = 0;
let supervisorThreadTitleState = {
  status: "unbound",
  threadId: null,
  title: null,
  updatedAt: null,
  error: null,
};

const SUPERVISOR_TITLE_RETRY_MS = 5000;

function implementationActiveCount() {
  return [...active.values()].filter(
    (entry) => Number.isInteger(entry.workerId),
  ).length;
}

ensureLayout(repoRoot);
const existingDaemon = readDaemonState(repoRoot);
if (
  existingDaemon &&
  existingDaemon.pid !== process.pid &&
  processIsAlive(existingDaemon.pid)
) {
  const owner = isCurrentDaemonState(existingDaemon)
    ? "another current ToDo daemon"
    : "an incompatible ToDo daemon";
  process.stderr.write(
    `${owner} already owns ${repoRoot} (pid ${existingDaemon.pid})\n`,
  );
  process.exit(1);
}

function log(event, fields = {}) {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  process.stdout.write(
    `${new Date().toISOString()} [todo pid=${process.pid}] event=${event}${suffix ? ` ${suffix}` : ""}\n`,
  );
}

function writeState(status = null) {
  const resolvedStatus =
    status ||
    (runtimeUpdateRequest
      ? "restart-pending"
      : stopping
        ? "stopping"
        : "running");
  const config = runtimeConfig || loadConfig(repoRoot);
  const activeByWorker = new Map(
    [...active.values()].map((entry) => [entry.workerId, entry]),
  );
  const workerStates = [];
  for (let id = 1; id <= config.workers; id += 1) {
    const entry = activeByWorker.get(id);
    workerStates.push({
      id,
      status: entry ? "busy" : "idle",
      runner: "node",
      pid: entry?.child?.pid || (entry?.threadId ? appServer?.pid : null),
      daemonPid: process.pid,
      taskId: entry?.taskId || null,
      taskTitle: entry?.taskTitle || null,
    });
  }
  for (const entry of active.values()) {
    if (!Number.isInteger(entry.workerId) || entry.workerId <= config.workers) {
      continue;
    }
    workerStates.push({
      id: entry.workerId,
      status: "draining",
      runner: "node",
      pid: entry.child?.pid || (entry.threadId ? appServer?.pid : null),
      daemonPid: process.pid,
      taskId: entry.taskId,
      taskTitle: entry.taskTitle,
    });
  }
  const mergeEntry = [...active.values()].find(
    (entry) => entry.workerId === "merge-queue",
  );
  const repairEntry = [...active.values()].find(
    (entry) => entry.workerId === "merge-repair",
  );
  atomicWriteJson(daemonStatePath(repoRoot), {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion,
    runtimeFingerprint: ownRuntime.fingerprint,
    runtime: ownRuntime,
    runtimeUpdate: runtimeUpdateRequest
      ? {
          status: "pending",
          requestId: runtimeUpdateRequest.requestId,
          reason: runtimeUpdateRequest.reason,
          activeTasks: active.size,
          current: runtimeUpdateRequest.current,
          target: runtimeUpdateRequest.target,
          hooksReload: runtimeUpdateRequest.hooksReload,
          newSessionRequired: true,
        }
      : { status: "current" },
    token: daemonToken,
    pid: process.pid,
    status: resolvedStatus,
    repoRoot,
    workers: config.workers,
    appliedConfig: {
      workers: config.workers,
      pollIntervalMs: config.pollIntervalMs,
      configReloadIntervalMs: config.configReloadIntervalMs,
      dashboardPort: config.dashboardPort,
      retries: config.retries,
      executionBackend: config.executionBackend,
      appServerPid: appServer?.pid || null,
      codexSandbox: config.codexSandbox,
      modelProfiles: config.modelProfiles,
      defaultModelProfile: config.defaultModelProfile,
      git: config.git,
    },
    configReload: {
      intervalMs: config.configReloadIntervalMs,
      lastCheckedAt: configLastCheckedAt,
      appliedAt: configAppliedAt,
      warning: configReloadWarning,
    },
    dashboard: dashboard
      ? {
          host: dashboard.host,
          port: dashboard.port,
          url: dashboard.url,
          threadId: dashboard.threadId || null,
        }
      : null,
    active: [...active.keys()],
    workerStates,
    mergeWorker: {
      status: mergeEntry ? "busy" : "idle",
      taskId: mergeEntry?.taskId || null,
      taskTitle: mergeEntry?.taskTitle || null,
    },
    mergeRepairWorker: {
      status: repairEntry ? "busy" : "idle",
      pid: repairEntry?.threadId ? appServer?.pid || null : null,
      taskId: repairEntry?.taskId || null,
      taskTitle: repairEntry?.taskTitle || null,
    },
    supervisorThreadTitle: supervisorThreadTitleState,
    startedAt: daemonStartedAt,
    heartbeatAt: new Date().toISOString(),
  });
}

const RUNTIME_CONFIG_KEYS = [
  "workers",
  "pollIntervalMs",
  "configReloadIntervalMs",
  "dashboardPort",
  "retries",
  "executionBackend",
  "gitExclude",
  "codexCommand",
  "codexSandbox",
  "modelProfiles",
  "defaultModelProfile",
  "routingMode",
  "git",
  "pipeline",
];

function changedConfigKeys(previous, next) {
  return RUNTIME_CONFIG_KEYS.filter(
    (key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next?.[key]),
  );
}

async function closeDashboard(server) {
  if (!server) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    setTimeout(finish, 1000);
  });
}

function watchDashboardErrors(instance) {
  instance.server.on("error", (error) => {
    log("dashboard_error", { error: error.message });
  });
}

async function reloadDashboard(previousConfig, nextConfig) {
  if (previousConfig.dashboardPort === nextConfig.dashboardPort) return;
  if (dashboard?.port === nextConfig.dashboardPort) {
    log("dashboard_config_reloaded", {
      requestedPort: nextConfig.dashboardPort,
      dashboardUrl: dashboard.url,
    });
    return;
  }

  let replacement;
  try {
    replacement = await startDashboard(
      repoRoot,
      nextConfig.dashboardPort,
      dashboard?.threadId || null,
      desktopTaskAction,
    );
  } catch (error) {
    log("dashboard_config_reload_error", {
      requestedPort: nextConfig.dashboardPort,
      error: error.message,
    });
    return;
  }
  watchDashboardErrors(replacement);
  const previous = dashboard;
  dashboard = replacement;
  writeState();
  await closeDashboard(previous?.server);
  log("dashboard_config_reloaded", {
    requestedPort: nextConfig.dashboardPort,
    dashboardUrl: dashboard.url,
  });
}

async function syncDashboardThread() {
  const threadId = readDashboardThreadRequest(repoRoot)?.threadId || null;
  if (!threadId || dashboard?.threadId === threadId) return false;
  if (runtimeConfig.dashboardPort !== 0) {
    dashboard.threadId = threadId;
    writeState();
    log("dashboard_thread_reloaded", {
      threadId,
      dashboardUrl: dashboard.url,
    });
    return true;
  }

  let replacement;
  try {
    replacement = await startDashboard(repoRoot, 0, threadId, desktopTaskAction);
  } catch (error) {
    log("dashboard_thread_reload_error", {
      threadId,
      error: error.message,
    });
    return false;
  }
  watchDashboardErrors(replacement);
  const previous = dashboard;
  dashboard = replacement;
  writeState();
  await closeDashboard(previous?.server);
  log("dashboard_thread_reloaded", {
    threadId,
    dashboardUrl: dashboard.url,
  });
  return true;
}

function scheduleDashboardThreadSync() {
  if (!dashboardSyncPromise) {
    dashboardSyncPromise = syncDashboardThread().finally(() => {
      dashboardSyncPromise = null;
    });
  }
  return dashboardSyncPromise;
}

async function reloadRuntimeConfig() {
  const checkedAt = new Date().toISOString();
  const candidate = loadConfig(repoRoot);
  configLastCheckedAt = checkedAt;
  if (candidate.readError) {
    configReloadWarning = candidate.readError;
    if (candidate.readError !== lastWarning) {
      log("config_reload_rejected", { warning: candidate.readError });
      lastWarning = candidate.readError;
    }
    writeState();
    return [];
  }

  const previous = runtimeConfig;
  const changed = changedConfigKeys(previous, candidate);
  runtimeConfig = candidate;
  if (changed.length > 0) configAppliedAt = checkedAt;
  configReloadWarning = candidate.warning;
  if (candidate.warning && candidate.warning !== lastWarning) {
    log("config_warning", {
      warning: candidate.warning,
      workers: candidate.workers,
    });
  }
  lastWarning = candidate.warning;

  if (changed.includes("gitExclude")) {
    try {
      applyGitExcludes(repoRoot, candidate.gitExclude);
    } catch (error) {
      log("config_git_exclude_error", { error: error.message });
    }
  }
  if (changed.includes("dashboardPort")) {
    await reloadDashboard(previous, candidate);
  }
  if (changed.length > 0) {
    log("config_reloaded", {
      changed,
      workers: candidate.workers,
      defaultModelProfile: candidate.defaultModelProfile,
      activeTasksPreserved: active.size,
    });
  }
  writeState();
  return changed;
}

function parseResult(resultFile) {
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  if (
    !result ||
    (result.status !== "completed" && result.status !== "failed") ||
    typeof result.summary !== "string" ||
    !Array.isArray(result.validation) ||
    result.validation.some(
      (item) => typeof item !== "string" || !item.trim(),
    ) ||
    (result.status === "completed" && result.validation.length === 0) ||
    typeof result.requiresInteractive !== "boolean" ||
    (result.requiresInteractive &&
      (result.status !== "failed" ||
        typeof result.interactiveReason !== "string" ||
        !result.interactiveReason.trim())) ||
    (!result.requiresInteractive && result.interactiveReason !== null)
  ) {
    throw new Error("Codex returned an invalid structured result");
  }
  return result;
}

function parsePipelineStepResult(resultFile) {
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  if (
    !result ||
    (result.status !== "completed" && result.status !== "failed") ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    !Array.isArray(result.validation) ||
    result.validation.some(
      (item) => typeof item !== "string" || !item.trim(),
    ) ||
    typeof result.requiresInteractive !== "boolean" ||
    (result.requiresInteractive &&
      (result.status !== "failed" ||
        typeof result.interactiveReason !== "string" ||
        !result.interactiveReason.trim())) ||
    (!result.requiresInteractive && result.interactiveReason !== null)
  ) {
    throw new Error("Codex returned an invalid pipeline step result");
  }
  return result;
}

function combinedTokenUsage(records) {
  const available = records.filter((record) => record?.available);
  if (available.length === 0) return emptyTokenUsage();
  const keys = [
    "inputTokens",
    "cachedInputTokens",
    "uncachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "visibleOutputTokens",
    "totalTokens",
  ];
  const usage = {
    available: true,
    coverage: available.every((record) => record.coverage === "full")
      ? "full"
      : "partial",
    turns: available.reduce((total, record) => total + (record.turns || 0), 0),
  };
  for (const key of keys) {
    usage[key] = available.reduce(
      (total, record) => total + (Number(record[key]) || 0),
      0,
    );
  }
  return usage;
}

function buildPrompt(task, worktreePath) {
  const taskCreationInstructions =
    task.metadata.allowWorkerTaskCreation === true
      ? [
          "The parent task records explicit user authorization to create follow-up ToDo tasks.",
          "You may call task_create only when the task body requires it. Give each follow-up complete requirements and the explicitly requested model profile.",
          "Follow-up tasks automatically depend on this task and cannot create further tasks.",
        ]
      : [
          "Do not create follow-up ToDo tasks and do not call ToDo MCP tools.",
        ];
  return [
    `You are a ToDo worker in the task worktree ${worktreePath}.`,
    "Implement the claimed task directly. Do not enqueue the claimed task again.",
    WORKER_TOOLING_BOUNDARY,
    ...taskCreationInstructions,
    "Read AGENTS.md and all applicable nested AGENTS.md files before acting.",
    "Preserve unrelated and concurrent changes.",
    "Do not create, switch, commit, merge, cherry-pick, rebase, push, or delete Git branches and do not create pull requests. The ToDo runner owns all mutating Git operations.",
    "Read-only Git inspection such as status, diff, and log is allowed.",
    "Do not edit or delete .todo task, claim, history, daemon, log, or config files.",
    "Complete only this task, run the smallest relevant tests or verification, and report at least one concrete validation result. A completed result with no validation evidence is invalid.",
    "Reuse tool results within this attempt. Prefer narrow field filters, limits, and targeted log ranges; do not repeatedly fetch unchanged resources.",
    "If a user decision is required, use the runtime's user-input tool when available. Otherwise return status failed with requiresInteractive=true and the exact question as interactiveReason so the dashboard can request an answer.",
    "Set requiresInteractive=true only when the task cannot be completed without current-thread Browser, Chrome, Computer Use, user approval, or user interaction. Include one concrete interactiveReason. For every other result set requiresInteractive=false and interactiveReason=null.",
    "Return only the JSON object required by the output schema.",
    "",
    TODO_PONYTAIL_FULL_CONTOUR,
    "",
    `Task ID: ${task.id}`,
    "",
    task.body,
  ].join("\n");
}

function buildAppServerPrompt(task, worktreePath, claim) {
  if (!task.metadata.codexThread?.id) return buildPrompt(task, worktreePath);
  const previousError = task.metadata.error?.message;
  return [
    `Continue ToDo task ${task.id} in the existing Codex thread.`,
    `This is ${claim.trigger || "manual_retry"} attempt ${claim.attempt || 1}.`,
    `The current task worktree is ${worktreePath}.`,
    "Reuse the task requirements, repository findings, and tool results already present in this thread.",
    "Inspect only facts that may have changed, address the recorded failure, finish the implementation, and run the smallest relevant validation.",
    previousError ? `Recorded failure: ${previousError}` : null,
    "Return only the JSON object required by the existing output schema.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPipelineStepPrompt(
  task,
  worktreePath,
  step,
  context,
  { continueThread = false } = {},
) {
  const previousSummaries = context.executions
    .filter(
      (execution) =>
        execution.status === "completed" &&
        typeof execution.summary === "string" &&
        execution.summary.trim(),
    )
    .slice(-6)
    .map((execution) => `- ${execution.stepId}: ${execution.summary.trim()}`);
  const failure = context.failure;
  const failurePayload = failure
    ? JSON.stringify(
        {
          step: failure.step.id,
          type: failure.step.type,
          round: context.repairRound,
          summary: failure.result.summary,
          error: failure.result.error || null,
          receipt: failure.result.receipt || null,
        },
        null,
        2,
      ).slice(0, 16000)
    : null;
  const stage = [
    `Pipeline step: ${step.id} (${step.type}).`,
    step.prompt,
    previousSummaries.length > 0
      ? `Previously completed pipeline steps:\n${previousSummaries.join("\n")}`
      : null,
    failurePayload
      ? `The deterministic pipeline step failed. Repair the worktree so the step passes. Do not lower quality thresholds, disable checks, or remove meaningful tests unless the task explicitly requires it.\n\nFailure receipt:\n${failurePayload}`
      : null,
    "The runner executes the configured shell gates authoritatively after agent steps. Do not proactively rerun those full commands inside this Codex step; use only a narrower diagnostic command when it is necessary to implement or repair the change.",
    WORKER_TOOLING_BOUNDARY,
    "Do not run Git mutation or delivery commands; the ToDo runner owns Git finalization.",
    "Return only the JSON object required by the pipeline step output schema. Validation may be empty because the runner executes authoritative shell gates.",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (continueThread) {
    return [
      `Continue ToDo task ${task.id} in its existing Codex thread.`,
      `The current task worktree is ${worktreePath}.`,
      "Reuse the requirements and repository findings already present in this thread.",
      stage,
    ].join("\n\n");
  }
  const taskCreationInstructions =
    task.metadata.allowWorkerTaskCreation === true
      ? "The task records explicit user authorization for follow-up ToDo tasks; use it only within the task's stated scope."
      : "Do not create follow-up ToDo tasks and do not call ToDo MCP tools.";
  return [
    `You are a ToDo pipeline worker in the task worktree ${worktreePath}.`,
    "Implement only the claimed task directly and preserve unrelated changes.",
    taskCreationInstructions,
    "Read AGENTS.md and applicable nested AGENTS.md files before editing.",
    "Do not edit or delete .todo runtime files.",
    "When a user decision or current-thread capability is required, use the runtime's user-input tool when available, or return a failed result with requiresInteractive=true and the exact question or capability needed as interactiveReason.",
    "For all other results set requiresInteractive=false and interactiveReason=null.",
    "",
    TODO_PONYTAIL_FULL_CONTOUR,
    "",
    `Task ID: ${task.id}`,
    "",
    task.body,
    "",
    stage,
  ].join("\n");
}

function buildMergeConflictPrompt(task, worktreePath, claim) {
  const conflict = task.metadata.git?.mergeConflict || {};
  return [
    `Continue original ToDo task ${task.id} in its existing Codex thread.`,
    `This is merge-conflict repair attempt ${claim.attempt || 1}.`,
    `The merge queue rebased ${task.metadata.git?.branch} onto the current ${task.metadata.git?.targetBranch} at ${conflict.targetCommit || "the latest target commit"}.`,
    `The rebase is paused in ${worktreePath}.`,
    conflict.files?.length
      ? `Conflicted files: ${conflict.files.join(", ")}.`
      : "Inspect the paused rebase to identify every conflict.",
    "Resolve the files so the original task functionality remains correct while preserving the newer target-branch functionality and contracts.",
    "Review the target changes made since the task branch diverged and check affected callers; do not choose one side mechanically.",
    "Edit the conflicted files and run the smallest relevant tests or verification. Do not run git add, commit, merge, cherry-pick, rebase, push, or branch commands; the merge worker owns the paused rebase and will continue it after your result.",
    "If the two requirements are logically incompatible or a safe resolution needs a product decision, return status failed with the concrete logical conflict. The task will leave the merge queue with that error.",
    "Return only the JSON object required by the existing output schema.",
  ].join("\n");
}

function markInteractiveRequired(
  taskPath,
  execution,
  message,
  metrics,
  attemptContext,
) {
  setTaskError(
    taskPath,
    "interactive_required",
    null,
    message,
    metrics,
    attemptContext,
  );
  const task = readTask(taskPath);
  task.metadata.execution = { ...execution, mode: "interactive" };
  task.metadata.interaction = { state: "waiting-input", question: message,
    nativeThreadId: task.metadata.interaction?.nativeThreadId || null,
    updatedAt: new Date().toISOString() };
  writeTask(task);
}


function attemptFailure(
  claim,
  errorKind,
  code,
  message,
  usagePath,
  requiresInteractive = false,
) {
  const failure = classifyFailure({
    errorKind,
    code,
    message,
    requiresInteractive,
  });
  return {
    claim,
    status: failure.status,
    errorKind: failure.errorKind,
    usagePath,
  };
}

async function startRequestTelemetry() {
  const nonce = randomUUID();
  const batches = [];
  let retainedBytes = 0;
  const maxRequestBytes = 2 * 1024 * 1024;
  const maxRetainedBytes = 8 * 1024 * 1024;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== `/${nonce}/v1/logs`) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxRequestBytes) chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes <= maxRequestBytes && retainedBytes + bytes <= maxRetainedBytes) {
        try {
          batches.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          retainedBytes += bytes;
        } catch {
          // Telemetry is optional; malformed batches only reduce coverage.
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/${nonce}/v1/logs`,
    batches,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections?.();
      }),
  };
}

function readExecutionStats(eventsFile, telemetry) {
  const stats = parseExecutionStats(
    existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : "",
  );
  stats.requestStats = parseOtlpRequestStats(
    telemetry?.batches || [],
    stats.tokenUsage,
  );
  if (!stats.tokenUsage.available && stats.requestStats.available) {
    stats.tokenUsage = {
      ...stats.requestStats.tokenUsage,
      coverage: "partial",
    };
  } else if (stats.tokenUsage.available) {
    stats.tokenUsage.coverage =
      stats.requestStats.available && stats.requestStats.coverage === "full"
        ? "full"
        : "partial";
  } else {
    stats.tokenUsage.coverage = "none";
  }
  return stats;
}

async function ensureAppServer(config) {
  if (appServer?.running) return appServer;
  if (appServerStartPromise) return appServerStartPromise;
  appServerStartPromise = (async () => {
    if (appServer) {
      await appServer.close().catch(() => {});
      appServer = null;
    }
    const stderrPath = path.join(todoDir(repoRoot), "app-server.stderr.log");
    const client = new AppServerClient({
      command: config.codexCommand,
      cwd: repoRoot,
      env: {
        ...process.env,
        TODO_RUNNER_WORKER: "1",
        TODO_RUNNER_REPO_ROOT: repoRoot,
      },
      onStderr: (chunk) => appendFileSync(stderrPath, chunk, "utf8"),
      onServerRequest: handleAgentInputRequest,
    });
    try {
      await client.start();
      appServer = client;
      log("app_server_start", { pid: client.pid });
      writeState();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  })();
  try {
    return await appServerStartPromise;
  } finally {
    appServerStartPromise = null;
  }
}

function appTools(config) {
  desktopClient ||= new DesktopClient({ command: config.codexCommand });
  return desktopClient;
}

const interaction = createTaskInteraction({
  repoRoot, active, getAppServer: () => appServer,
  getClient: () => appTools(runtimeConfig),
  getOwnerThreadId: () => getSupervisorStatus(repoRoot).automation?.targetThreadId,
  onChange: () => scheduleSupervisorThreadTitleSync(runtimeConfig),
});
const desktopTaskAction = interaction.action;
const handleAgentInputRequest = interaction.onServerRequest;

function scheduleDesktopMaintenance(config) {
  if (desktopMaintenance || Date.now() < nextDesktopAttemptAt || !process.env.CODEX_APP_TOOLS_PIPE_PATH) return;
  const ownerThreadId = getSupervisorStatus(repoRoot).automation?.targetThreadId;
  if (!ownerThreadId) return;
  const tasks = listTaskStatuses(repoRoot, { includeClosed: true, limit: null });
  const claimed = tasks.filter(task => task.claim?.owner?.threadId && task.claim.owner.turnId);
  desktopMaintenance = (async () => {
    const client = appTools(config);
    const title = getSupervisorStatus(repoRoot).threadTitle;
    if (desktopThreadStates.get(ownerThreadId) !== title) {
      await client.call("set_thread_title", { threadId: ownerThreadId, title }, ownerThreadId);
      desktopThreadStates.set(ownerThreadId, title);
    }
    for (const task of claimed) {
      try {
        const claim = readClaim(`${task.path}.lock`, { includeToken: true });
        if (!claim?.owner) continue;
        const observed = await client.call("read_thread", {
          threadId: claim.owner.threadId, turnLimit: 10, includeOutputs: false,
        }, ownerThreadId);
        reconcileInteractiveClaim(repoRoot, task.id, observed, claim.token);
      } catch (error) { log("desktop_claim_reconcile_error", { task: task.id, error: error.message }); }
    }
    let synced = 0;
    for (const task of tasks) {
      const threadId = task.interaction?.nativeThreadId || task.codexThread?.id;
      if (!threadId || task.claim || active.has(task.id)) continue;
      if (Date.now() < (desktopThreadRetryAt.get(threadId) || 0)) continue;
      const name = formatTaskThreadTitle(repoRoot, task);
      const shouldArchive = task.status !== "waiting-input" &&
        (task.codexThread?.state === "archived" || ["completed", "failed", "canceled", "rejected"].includes(task.status));
      const key = `${name}:${shouldArchive}`;
      if (desktopThreadStates.get(threadId) === key) continue;
      try {
      const observed = await client.call("read_thread", { threadId, turnLimit: 1, includeOutputs: false }, ownerThreadId);
      if (observed.thread?.status?.type === "active") continue;
      // The app cannot rename an archived rollout. Reopen it without starting
      // a turn, then restore archival even if renaming fails.
      if (shouldArchive) await client.call("set_thread_archived", { threadId, archived: false }, ownerThreadId);
      try {
        await client.call("set_thread_title", { threadId, title: name }, ownerThreadId);
      } finally {
        if (shouldArchive) await client.call("set_thread_archived", { threadId, archived: true }, ownerThreadId);
      }
      desktopThreadStates.set(threadId, key);
      } catch (error) {
        desktopThreadRetryAt.set(threadId, Date.now() + 60000);
        log("desktop_thread_reconcile_error", { task: task.id, error: error.message });
      }
      if (++synced >= 4) break;
    }
  })().catch(error => {
    nextDesktopAttemptAt = Date.now() + 30000;
    log("desktop_reconcile_error", { error: error.message });
  })
    .finally(() => { desktopMaintenance = null; });
}

function scheduleNativeTasks(config) {
  if (Date.now() < nextDesktopDispatchAt || !process.env.CODEX_APP_TOOLS_PIPE_PATH ||
      !getSupervisorStatus(repoRoot).automation?.targetThreadId || taskBatchPublicationActive(repoRoot)) return;
  const tasks = listTaskStatuses(repoRoot);
  let occupied = implementationActiveCount() + desktopDispatches.size +
    tasks.filter(task => task.claim?.owner?.threadId || task.interaction?.dispatching).length;
  for (const task of tasks) {
    if (occupied >= config.workers) break;
    if (task.execution?.mode !== "interactive" || task.status !== "queued" || task.claim ||
        task.existingBlockers?.length || desktopDispatches.has(task.id) || task.interaction?.dispatching) continue;
    desktopDispatches.add(task.id); occupied++;
    desktopTaskAction({ taskId: task.id, action: "native" }).catch(error => {
      nextDesktopDispatchAt = Date.now() + 30000;
      log("desktop_dispatch_error", { task: task.id, error: error.message });
    }).finally(() => desktopDispatches.delete(task.id));
  }
}

async function syncSupervisorThreadTitle(config) {
  const supervisor = getSupervisorStatus(repoRoot);
  const threadId = supervisor.automation?.targetThreadId || null;
  const title = supervisor.threadTitle;
  if (!threadId) {
    lastSupervisorTitleSuccessKey = null;
    lastSupervisorTitleAttemptKey = null;
    lastSupervisorTitleAttemptAt = 0;
    supervisorThreadTitleState = {
      status: "unbound",
      threadId: null,
      title,
      updatedAt: null,
      error: supervisor.readError || null,
    };
    return false;
  }

  const key = `${threadId}\n${title}`;
  if (key === lastSupervisorTitleSuccessKey) return false;
  const now = Date.now();
  if (
    key === lastSupervisorTitleAttemptKey &&
    now - lastSupervisorTitleAttemptAt < SUPERVISOR_TITLE_RETRY_MS
  ) {
    return false;
  }
  lastSupervisorTitleAttemptKey = key;
  lastSupervisorTitleAttemptAt = now;
  supervisorThreadTitleState = {
    status: "syncing",
    threadId,
    title,
    updatedAt: new Date(now).toISOString(),
    error: null,
  };

  try {
    const client = await ensureAppServer(config);
    await client.setThreadName(threadId, title);
    lastSupervisorTitleSuccessKey = key;
    supervisorThreadTitleState = {
      status: "synced",
      threadId,
      title,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    log("supervisor_thread_title_updated", { threadId, title });
    return true;
  } catch (error) {
    supervisorThreadTitleState = {
      status: "error",
      threadId,
      title,
      updatedAt: new Date().toISOString(),
      error: String(error.message).slice(0, 4000),
    };
    log("supervisor_thread_title_error", {
      threadId,
      title,
      error: error.message,
    });
    return false;
  }
}

function scheduleSupervisorThreadTitleSync(config) {
  if (supervisorTitleSyncPromise) {
    supervisorTitleSyncQueued = true;
    return;
  }
  supervisorTitleSyncPromise = syncSupervisorThreadTitle(config)
    .catch((error) => {
      log("supervisor_thread_title_unhandled_error", {
        error: error.message,
      });
    })
    .finally(() => {
      supervisorTitleSyncPromise = null;
      if (!supervisorTitleSyncQueued || stopping) return;
      supervisorTitleSyncQueued = false;
      scheduleSupervisorThreadTitleSync(runtimeConfig || config);
    });
}

async function loadTaskThread(taskPath, execution, worktreePath, config) {
  const client = await ensureAppServer(config);
  let task = readTask(taskPath);
  let thread = task.metadata.codexThread;
  const common = {
    cwd: worktreePath,
    model: execution.model,
    approvalPolicy: "never",
    sandbox: config.codexSandbox,
  };
  if (!thread) {
    const started = await client.startThread({
      ...common,
      serviceName: "todo",
    });
    thread = updateTaskCodexThread(taskPath, {
      id: started.id,
      state: "active",
      createdAt: new Date().toISOString(),
    });
    log("task_thread_created", { task: task.id, threadId: thread.id });
    await nameTaskThread(client, taskPath, task);
    return thread;
  }
  if (
    ["archived", "archive-pending", "unarchive-pending"].includes(
      thread.state,
    )
  ) {
    await client.unarchiveThread(thread.id);
    thread = updateTaskCodexThread(taskPath, {
      state: "active",
      archivedAt: undefined,
    });
    log("task_thread_unarchived", { task: task.id, threadId: thread.id });
  }
  await client.resumeThread(thread.id, common);
  await nameTaskThread(client, taskPath, task);
  return thread;
}

async function nameTaskThread(client, taskPath, task = readTask(taskPath)) {
  const saved = readTask(taskPath).metadata.codexThread;
  const name = formatTaskThreadTitle(repoRoot, task);
  if (!saved?.id || saved.name === name) return;
  try {
    await client.setThreadName(saved.id, name);
    updateTaskCodexThread(taskPath, { name });
  } catch (error) {
    log("task_thread_name_error", { task: task.id, error: error.message });
  }
}

async function archiveTaskThread(taskPath, config) {
  if (!existsSync(taskPath)) return;
  const task = readTask(taskPath);
  const thread = task.metadata.codexThread;
  if (!thread || thread.state === "archived") return;
  updateTaskCodexThread(taskPath, { state: "archive-pending" });
  const client = await ensureAppServer(config);
  await archiveThreadIdempotently(client, thread.id);
  updateTaskCodexThread(taskPath, {
    state: "archived",
    archivedAt: new Date().toISOString(),
  });
  log("task_thread_archived", { task: task.id, threadId: thread.id });
}

function isMissingArchivedThread(error) {
  return /no rollout found for thread id/i.test(error?.message || "");
}

async function archiveThreadIdempotently(client, threadId) {
  try {
    await client.archiveThread(threadId);
  } catch (error) {
    if (!isMissingArchivedThread(error)) throw error;
  }
}

async function processPendingThreadArchives(config) {
  for (const taskPath of listTaskFiles(repoRoot)) {
    let task;
    try {
      task = readTask(taskPath);
      if (active.has(task.id)) continue;
      if (existsSync(`${taskPath}.lock`)) continue;
      if (task.metadata.codexThread?.state !== "archive-pending") continue;
      await archiveTaskThread(taskPath, config);
    } catch (error) {
      log("open_task_thread_archive_error", {
        task: task?.id || path.basename(taskPath),
        error: error.message,
      });
    }
  }
  for (const receiptPath of listPendingThreadArchives(repoRoot)) {
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      const client = await ensureAppServer(config);
      await archiveThreadIdempotently(client, receipt.codexThread.id);
      markClosedTaskThreadArchived(receiptPath);
      log("closed_task_thread_archived", {
        task: receipt.id,
        threadId: receipt.codexThread.id,
      });
    } catch (error) {
      log("closed_task_thread_archive_error", {
        task: receipt?.id || path.basename(receiptPath),
        error: error.message,
      });
    }
  }
}

async function executeDeliveryOnly(taskPath, claim, workerId, config) {
  const task = readTask(taskPath);
  const attemptDir = path.join(
    todoDir(repoRoot),
    "logs",
    task.id,
    `delivery-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(attemptDir, { recursive: true });
  const deliveryPath = path.join(attemptDir, "delivery.json");
  const startedAt = Date.now();
  log("delivery_start", {
    task: task.id,
    worker: workerId,
    delivery: task.metadata.git?.delivery,
    phase: task.metadata.git?.phase,
  });
  try {
    const finalized = await finalizeTaskGit(
      repoRoot,
      taskPath,
      path.relative(repoRoot, deliveryPath),
    );
    atomicWriteJson(deliveryPath, {
      status: finalized.mergeQueued ? "merge-queued" : "completed",
      deliveryAttemptId: finalized.deliveryAttemptId,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      delivery: finalized.delivery,
    });
    if (
      (task.metadata.execution?.backend || config.executionBackend) ===
      "app-server"
    ) {
      await archiveTaskThread(taskPath, config);
    }
    if (!finalized.mergeQueued) {
      completeTask(
        repoRoot,
        taskPath,
        finalized.result,
        task.metadata.metrics || null,
      );
    }
  } catch (error) {
    const deliveryAttemptId = getTaskStatus(
      repoRoot,
      task.id,
    ).attemptLedger?.deliveryAttempts?.at(-1)?.attemptId;
    atomicWriteJson(deliveryPath, {
      status: "failed",
      deliveryAttemptId: deliveryAttemptId || null,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      errorKind: error.taskFailure?.errorKind || error.kind || "git_delivery",
      error: String(error.message).slice(0, 4000),
    });
    setTaskError(
      taskPath,
      error.taskFailure?.errorKind || error.kind || "git_delivery",
      null,
      error.message,
      task.metadata.metrics || null,
      error.taskFailure
        ? {
            status: error.taskFailure.status,
            errorKind: error.taskFailure.errorKind,
          }
        : null,
    );
  } finally {
    if (
      (task.metadata.execution?.backend || config.executionBackend) ===
      "app-server"
    ) {
      try {
        await archiveTaskThread(taskPath, config);
      } catch (error) {
        log("task_thread_archive_error", {
          task: task.id,
          error: error.message,
        });
      }
    }
    releaseClaim(claim);
    interaction.abandon(task.id); active.delete(task.id);
    const status = getTaskStatus(repoRoot, task.id).status;
    log("delivery_end", { task: task.id, status });
    writeState();
  }
}

async function executeTaskWithExec(taskPath, claim, workerId, config) {
  const task = readTask(taskPath);
  const isMergeRepair = task.metadata.git?.phase === "merge-conflict";
  if (
    ["model-completed", "committing", "committed", "delivered"].includes(
      task.metadata.git?.phase,
    )
  ) {
    await executeDeliveryOnly(taskPath, claim, workerId, config);
    return;
  }
  const previousMetrics = task.metadata.metrics || null;
  const execution =
    task.metadata.execution || resolveTaskExecution(config, {});
  let preparedGit;
  try {
    preparedGit = isMergeRepair
      ? {
          worktreePath: task.metadata.git.worktreePath,
          expectedHead: task.metadata.git.headCommit,
        }
      : await prepareTaskGit(repoRoot, taskPath);
  } catch (error) {
    setTaskError(
      taskPath,
      error.kind || "git_prepare",
      null,
      error.message,
      previousMetrics,
    );
    releaseClaim(claim);
    interaction.abandon(task.id); active.delete(task.id);
    log("task_pre_model_failure", {
      task: task.id,
      kind: error.kind || "git_prepare",
      error: error.message,
    });
    writeState();
    return;
  }
  beginModelAttempt(taskPath, claim);
  const attemptDir = path.join(
    todoDir(repoRoot),
    "logs",
    task.id,
    `attempt-${String(claim.attempt || 1).padStart(3, "0")}-${claim.attemptId}`,
  );
  mkdirSync(attemptDir, { recursive: true });
  const stdoutPath = path.join(attemptDir, "stdout.log");
  const stderrPath = path.join(attemptDir, "stderr.log");
  const resultPath = path.join(attemptDir, "result.json");
  const usagePath = path.join(attemptDir, "usage.json");
  const promptPath = path.join(attemptDir, "prompt.txt");
  const executionPrompt = isMergeRepair
    ? buildMergeConflictPrompt(task, preparedGit.worktreePath, claim)
    : buildPrompt(task, preparedGit.worktreePath);
  writeFileSync(promptPath, `${executionPrompt}\n`, "utf8");
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  let telemetry = null;
  try {
    telemetry = await startRequestTelemetry();
  } catch (error) {
    log("request_telemetry_unavailable", {
      task: task.id,
      error: error.message,
    });
  }

  const args = [
    "exec",
    ...(execution.ephemeral ? ["--ephemeral"] : []),
    "--model",
    execution.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(execution.reasoningEffort)}`,
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    ...(telemetry
      ? [
          "-c",
          "otel.log_user_prompt=false",
          "-c",
          `otel.exporter={otlp-http={endpoint=${JSON.stringify(telemetry.endpoint)},protocol="json"}}`,
          "-c",
          'otel.trace_exporter="none"',
          "-c",
          'otel.metrics_exporter="none"',
        ]
      : []),
    "-C",
    preparedGit.worktreePath,
    "--color",
    "never",
    "--json",
    "--output-schema",
    resultSchema,
    "--output-last-message",
    resultPath,
    "-",
  ];

  const claimedAt = Date.parse(claim.claimedAt);
  const startedAt = Number.isFinite(claimedAt) ? claimedAt : Date.now();
  log("task_start", {
    task: task.id,
    worker: workerId,
    startedAt: new Date(startedAt).toISOString(),
    modelProfile: execution.modelProfile,
    model: execution.model,
    reasoningEffort: execution.reasoningEffort,
    ephemeral: execution.ephemeral,
    attempt: claim.attempt,
    attemptId: claim.attemptId,
    trigger: claim.trigger,
    usagePath: path.relative(repoRoot, usagePath),
    promptPath: path.relative(repoRoot, promptPath),
    worktreePath: preparedGit.worktreePath,
    branch: task.metadata.git?.branch,
  });
  atomicWriteJson(usagePath, {
    schemaVersion: 2,
    taskId: task.id,
    attempt: claim.attempt,
    attemptId: claim.attemptId,
    retryOf: claim.retryOf,
    trigger: claim.trigger,
    status: "running",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: null,
    durationMs: 0,
    modelProfile: execution.modelProfile,
    model: execution.model,
    reasoningEffort: execution.reasoningEffort,
    threadId: null,
    source: "codex exec --json + numeric OTLP",
    eventsFile: path.basename(stdoutPath),
    promptFile: path.basename(promptPath),
    tokenUsage: emptyTokenUsage(),
    observable: {
      context: {
        promptBytes: Buffer.byteLength(executionPrompt),
        taskBodyBytes: Buffer.byteLength(task.body),
        outputSchemaBytes: readFileSync(resultSchema).length,
      },
    },
    requestStats: {
      available: false,
      coverage: "none",
      requests: [],
      transportRetries: 0,
      reason: "attempt_running",
    },
  });
  let child;
  let exitCode = null;
  let spawnError = null;
  let tokenUsage = emptyTokenUsage();
  let executionStats = parseExecutionStats("");
  let metrics = null;

  try {
    if (stopping) {
      const error = new Error("ToDo daemon stopped before model start");
      error.kind = "interrupted";
      throw error;
    }
    child = spawn(config.codexCommand, args, {
      cwd: preparedGit.worktreePath,
      env: {
        ...process.env,
        TODO_RUNNER_WORKER: "1",
        TODO_RUNNER_REPO_ROOT: repoRoot,
        TODO_RUNNER_WORKTREE: preparedGit.worktreePath,
        TODO_RUNNER_TASK_ID: task.id,
      },
      stdio: ["pipe", stdoutFd, stderrFd],
    });
    active.get(task.id).child = child;
    if (stopping && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    writeState();
    child.stdin.end(executionPrompt);
    exitCode = await new Promise((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
        resolve(null);
      });
      child.once("close", (code) => resolve(code));
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    if (telemetry) await telemetry.close();
    executionStats = readExecutionStats(stdoutPath, telemetry);
    executionStats.observable.context = {
      promptBytes: Buffer.byteLength(executionPrompt),
      taskBodyBytes: Buffer.byteLength(task.body),
      outputSchemaBytes: readFileSync(resultSchema).length,
    };
    tokenUsage = executionStats.tokenUsage;
    metrics = cumulativeTaskMetrics(
      previousMetrics,
      taskMetrics(startedAt, Date.now(), tokenUsage),
    );
  }

  try {
    if (isMergeRepair) {
      let repairResult;
      if (spawnError) {
        repairResult = {
          status: "failed",
          summary: spawnError.message,
          error: spawnError.message,
          validation: [],
        };
      } else if (exitCode !== 0) {
        const detail = readLogTail(stderrPath) || readLogTail(stdoutPath);
        const message = detail || `codex exec exited with code ${exitCode}`;
        repairResult = {
          status: "failed",
          summary: message,
          error: message,
          validation: [],
        };
      } else {
        try {
          repairResult = parseResult(resultPath);
        } catch (error) {
          repairResult = {
            status: "failed",
            summary: error.message,
            error: error.message,
            validation: [],
          };
        }
      }
      await finishTaskMergeConflictRepair(
        repoRoot,
        taskPath,
        claim,
        repairResult,
        metrics,
        path.relative(repoRoot, usagePath),
      );
      return;
    }
    if (spawnError) {
      setTaskError(
        taskPath,
        "codex_spawn",
        null,
        spawnError.message,
        metrics,
        attemptFailure(
          claim,
          "codex_spawn",
          null,
          spawnError.message,
          path.relative(repoRoot, usagePath),
        ),
      );
      return;
    }
    if (exitCode !== 0) {
      const detail = readLogTail(stderrPath) || readLogTail(stdoutPath);
      const message = detail || `codex exec exited with code ${exitCode}`;
      setTaskError(
        taskPath,
        "codex_exec",
        exitCode,
        message,
        metrics,
        attemptFailure(
          claim,
          "codex_exec",
          exitCode,
          message,
          path.relative(repoRoot, usagePath),
        ),
      );
      return;
    }

    let result;
    try {
      result = parseResult(resultPath);
    } catch (error) {
      setTaskError(
        taskPath,
        "invalid_result",
        exitCode,
        error.message,
        metrics,
        attemptFailure(
          claim,
          "invalid_result",
          exitCode,
          error.message,
          path.relative(repoRoot, usagePath),
        ),
      );
      return;
    }
    if (result.status === "failed") {
      if (result.requiresInteractive) {
        markInteractiveRequired(
          taskPath,
          execution,
          result.interactiveReason,
          metrics,
          attemptFailure(
            claim,
            "interactive_required",
            exitCode,
            result.interactiveReason,
            path.relative(repoRoot, usagePath),
            true,
          ),
        );
        return;
      }
      setTaskError(
        taskPath,
        "agent_reported_failure",
        exitCode,
        result.error || result.summary,
        metrics,
        attemptFailure(
          claim,
          "agent_reported_failure",
          exitCode,
          result.error || result.summary,
          path.relative(repoRoot, usagePath),
        ),
      );
      return;
    }
    markTaskModelCompleted(
      taskPath,
      claim,
      result,
      metrics,
      path.relative(repoRoot, usagePath),
    );
    try {
      const finalized = await finalizeTaskGit(
        repoRoot,
        taskPath,
        path.relative(repoRoot, path.join(attemptDir, "delivery.json")),
      );
      atomicWriteJson(path.join(attemptDir, "delivery.json"), {
        status: finalized.mergeQueued ? "merge-queued" : "completed",
        deliveryAttemptId: finalized.deliveryAttemptId,
        delivery: finalized.delivery,
      });
      if (!finalized.mergeQueued) {
        completeTask(repoRoot, taskPath, finalized.result, metrics);
      }
    } catch (error) {
      const deliveryAttemptId = getTaskStatus(
        repoRoot,
        task.id,
      ).attemptLedger?.deliveryAttempts?.at(-1)?.attemptId;
      atomicWriteJson(path.join(attemptDir, "delivery.json"), {
        status: "failed",
        deliveryAttemptId: deliveryAttemptId || null,
        errorKind:
          error.taskFailure?.errorKind || error.kind || "git_delivery",
        error: String(error.message).slice(0, 4000),
      });
      setTaskError(
        taskPath,
        error.taskFailure?.errorKind || error.kind || "git_delivery",
        null,
        error.message,
        metrics,
        error.taskFailure
          ? {
              status: error.taskFailure.status,
              errorKind: error.taskFailure.errorKind,
            }
          : null,
      );
    }
  } catch (error) {
    setTaskError(
      taskPath,
      "runner",
      exitCode,
      error.message,
      metrics,
      getTaskStatus(repoRoot, task.id).attemptLedger?.attempts?.some(
        (attempt) => attempt.attemptId === claim.attemptId,
      )
        ? null
        : attemptFailure(
            claim,
            "runner",
            exitCode,
            error.message,
            path.relative(repoRoot, usagePath),
          ),
    );
  } finally {
    releaseClaim(claim);
    interaction.abandon(task.id); active.delete(task.id);
    const finalStatus = getTaskStatus(repoRoot, task.id);
    const status = finalStatus.status;
    const modelAttemptStatus =
      finalStatus.attemptLedger?.attempts?.find(
        (attempt) => attempt.attemptId === claim.attemptId,
      )?.status || status;
    try {
      atomicWriteJson(usagePath, {
        ...buildAttemptUsageV2({
          taskId: task.id,
          attempt: claim.attempt,
          status: modelAttemptStatus,
          startedAt: metrics?.lastRun?.startedAt,
          completedAt: metrics?.lastRun?.completedAt,
          durationMs: metrics?.lastRun?.durationMs,
          modelProfile: execution.modelProfile,
          model: execution.model,
          reasoningEffort: execution.reasoningEffort,
          stats: executionStats,
        }),
        attemptId: claim.attemptId,
        retryOf: claim.retryOf,
        trigger: claim.trigger,
        eventsFile: path.basename(stdoutPath),
        promptFile: path.basename(promptPath),
      });
    } catch (error) {
      log("usage_log_error", { task: task.id, error: error.message });
    }
    log("task_end", {
      task: task.id,
      status,
      outcome: modelAttemptStatus,
      attempt: claim.attempt,
      attemptId: claim.attemptId,
      durationMs: metrics?.lastRun?.durationMs || 0,
      totalTokens: metrics?.lastRun?.tokenUsage?.totalTokens || 0,
      coverage: metrics?.lastRun?.tokenUsage?.coverage || "none",
      usagePath: path.relative(repoRoot, usagePath),
    });
    writeState();
  }
}

async function executeTaskWithAppServer(taskPath, claim, workerId, config) {
  const task = readTask(taskPath);
  const isMergeRepair = task.metadata.git?.phase === "merge-conflict";
  if (
    ["model-completed", "committing", "committed", "delivered"].includes(
      task.metadata.git?.phase,
    )
  ) {
    await executeDeliveryOnly(taskPath, claim, workerId, config);
    return;
  }
  const execution =
    task.metadata.execution || resolveTaskExecution(config, {});
  const previousMetrics = task.metadata.metrics || null;
  let preparedGit;
  try {
    preparedGit = isMergeRepair
      ? {
          worktreePath: task.metadata.git.worktreePath,
          expectedHead: task.metadata.git.headCommit,
        }
      : await prepareTaskGit(repoRoot, taskPath);
  } catch (error) {
    setTaskError(
      taskPath,
      error.kind || "git_prepare",
      null,
      error.message,
      previousMetrics,
    );
    releaseClaim(claim);
    interaction.abandon(task.id); active.delete(task.id);
    log("task_pre_model_failure", {
      task: task.id,
      kind: error.kind || "git_prepare",
      error: error.message,
    });
    writeState();
    return;
  }

  beginModelAttempt(taskPath, claim);
  const attemptDir = path.join(
    todoDir(repoRoot),
    "logs",
    task.id,
    `attempt-${String(claim.attempt || 1).padStart(3, "0")}-${claim.attemptId}`,
  );
  mkdirSync(attemptDir, { recursive: true });
  const stdoutPath = path.join(attemptDir, "stdout.log");
  const stderrPath = path.join(attemptDir, "stderr.log");
  const resultPath = path.join(attemptDir, "result.json");
  const usagePath = path.join(attemptDir, "usage.json");
  const promptPath = path.join(attemptDir, "prompt.txt");
  const executionPrompt = isMergeRepair
    ? buildMergeConflictPrompt(task, preparedGit.worktreePath, claim)
    : buildAppServerPrompt(task, preparedGit.worktreePath, claim);
  const outputSchema = JSON.parse(readFileSync(resultSchema, "utf8"));
  writeFileSync(promptPath, `${executionPrompt}\n`, "utf8");
  const claimedAt = Date.parse(claim.claimedAt);
  const startedAt = Number.isFinite(claimedAt) ? claimedAt : Date.now();
  let threadId = null;
  let turnId = null;
  let finalMessage = null;
  let turn = null;
  let runError = null;
  let executionStats = parseAppServerExecutionStats("");
  let metrics = null;

  log("task_start", {
    task: task.id,
    worker: workerId,
    backend: "app-server",
    modelProfile: execution.modelProfile,
    model: execution.model,
    reasoningEffort: execution.reasoningEffort,
    attempt: claim.attempt,
    attemptId: claim.attemptId,
    trigger: claim.trigger,
    worktreePath: preparedGit.worktreePath,
  });
  atomicWriteJson(usagePath, {
    schemaVersion: 2,
    taskId: task.id,
    attempt: claim.attempt,
    attemptId: claim.attemptId,
    retryOf: claim.retryOf,
    trigger: claim.trigger,
    status: "running",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: null,
    durationMs: 0,
    modelProfile: execution.modelProfile,
    model: execution.model,
    reasoningEffort: execution.reasoningEffort,
    threadId: task.metadata.codexThread?.id || null,
    source: "codex app-server JSON-RPC",
    eventsFile: path.basename(stdoutPath),
    promptFile: path.basename(promptPath),
    tokenUsage: emptyTokenUsage(),
    observable: {},
    requestStats: {
      available: false,
      coverage: "none",
      requests: [],
      transportRetries: 0,
      reason: "attempt_running",
    },
  });

  try {
    if (stopping) throw new Error("ToDo daemon stopped before model start");
    const thread = await loadTaskThread(
      taskPath,
      execution,
      preparedGit.worktreePath,
      config,
    );
    threadId = thread.id;
    const client = await ensureAppServer(config);
    const entry = active.get(task.id);
    if (entry) entry.threadId = threadId;
    turnId = await client.startTurn(
      {
        threadId,
        input: [{ type: "text", text: executionPrompt }],
        cwd: preparedGit.worktreePath,
        model: execution.model,
        effort: execution.reasoningEffort,
        approvalPolicy: "never",
        outputSchema,
      },
      (message, line) => {
        appendFileSync(stdoutPath, `${line}\n`, "utf8");
        const item = message.params?.item;
        if (
          message.method === "item/completed" &&
          item?.type === "agentMessage" &&
          typeof item.text === "string"
        ) {
          finalMessage = item.text;
        }
      },
    );
    updateTaskCodexThread(taskPath, { state: "active", lastTurnId: turnId });
    if (entry) entry.turnId = turnId;
    turn = await client.waitForTurn(threadId, turnId);
    if (turn.status !== "completed") {
      const error = new Error(
        turn.error?.message || `Codex turn ended with status ${turn.status}`,
      );
      error.kind = turn.status === "interrupted" ? "interrupted" : "app_server";
      throw error;
    }
    if (!finalMessage) {
      const item = [...(turn.items || [])]
        .reverse()
        .find((candidate) => candidate?.type === "agentMessage");
      finalMessage = item?.text || null;
    }
    if (!finalMessage) throw new Error("Codex app-server returned no final result");
    writeFileSync(resultPath, finalMessage, "utf8");
  } catch (error) {
    runError = error;
    appendFileSync(stderrPath, `${error.stack || error.message}\n`, "utf8");
  }

  executionStats = parseAppServerExecutionStats(
    existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
    turnId,
  );
  executionStats.threadId = threadId;
  executionStats.observable.context = {
    promptBytes: Buffer.byteLength(executionPrompt),
    taskBodyBytes: Buffer.byteLength(task.body),
    outputSchemaBytes: readFileSync(resultSchema).length,
  };
  metrics = cumulativeTaskMetrics(
    previousMetrics,
    taskMetrics(startedAt, Date.now(), executionStats.tokenUsage),
  );

  try {
    if (isMergeRepair) {
      let repairResult;
      if (runError) {
        repairResult = {
          status: "failed",
          summary: runError.message,
          error: runError.message,
          validation: [],
        };
      } else {
        try {
          repairResult = parseResult(resultPath);
        } catch (error) {
          repairResult = {
            status: "failed",
            summary: error.message,
            error: error.message,
            validation: [],
          };
        }
      }
      await finishTaskMergeConflictRepair(
        repoRoot,
        taskPath,
        claim,
        repairResult,
        metrics,
        path.relative(repoRoot, usagePath),
      );
      return;
    }
    if (runError) {
      const kind = runError.kind || "app_server";
      setTaskError(
        taskPath,
        kind,
        null,
        runError.message,
        metrics,
        attemptFailure(
          claim,
          kind,
          null,
          runError.message,
          path.relative(repoRoot, usagePath),
        ),
      );
      return;
    }
    let result;
    try {
      result = parseResult(resultPath);
    } catch (error) {
      setTaskError(
        taskPath,
        "invalid_result",
        null,
        error.message,
        metrics,
        attemptFailure(
          claim,
          "invalid_result",
          null,
          error.message,
          path.relative(repoRoot, usagePath),
        ),
      );
      return;
    }
    if (result.status === "failed") {
      if (result.requiresInteractive) {
        markInteractiveRequired(
          taskPath,
          execution,
          result.interactiveReason,
          metrics,
          attemptFailure(
            claim,
            "interactive_required",
            null,
            result.interactiveReason,
            path.relative(repoRoot, usagePath),
            true,
          ),
        );
      } else {
        setTaskError(
          taskPath,
          "agent_reported_failure",
          null,
          result.error || result.summary,
          metrics,
          attemptFailure(
            claim,
            "agent_reported_failure",
            null,
            result.error || result.summary,
            path.relative(repoRoot, usagePath),
          ),
        );
      }
      return;
    }
    markTaskModelCompleted(
      taskPath,
      claim,
      result,
      metrics,
      path.relative(repoRoot, usagePath),
    );
    try {
      const deliveryPath = path.join(attemptDir, "delivery.json");
      const finalized = await finalizeTaskGit(
        repoRoot,
        taskPath,
        path.relative(repoRoot, deliveryPath),
      );
      atomicWriteJson(deliveryPath, {
        status: finalized.mergeQueued ? "merge-queued" : "completed",
        deliveryAttemptId: finalized.deliveryAttemptId,
        delivery: finalized.delivery,
      });
      await archiveTaskThread(taskPath, config);
      if (!finalized.mergeQueued) {
        completeTask(repoRoot, taskPath, finalized.result, metrics);
      }
    } catch (error) {
      setTaskError(
        taskPath,
        error.taskFailure?.errorKind || error.kind || "git_delivery",
        null,
        error.message,
        metrics,
        error.taskFailure
          ? {
              status: error.taskFailure.status,
              errorKind: error.taskFailure.errorKind,
            }
          : null,
      );
    }
  } finally {
    try {
      await archiveTaskThread(taskPath, config);
    } catch (error) {
      log("task_thread_archive_error", {
        task: task.id,
        error: error.message,
      });
    }
    releaseClaim(claim);
    interaction.abandon(task.id); active.delete(task.id);
    const finalStatus = getTaskStatus(repoRoot, task.id);
    const modelAttemptStatus =
      finalStatus.attemptLedger?.attempts?.find(
        (attempt) => attempt.attemptId === claim.attemptId,
      )?.status || finalStatus.status;
    try {
      atomicWriteJson(usagePath, {
        ...buildAttemptUsageV2({
          taskId: task.id,
          attempt: claim.attempt,
          status: modelAttemptStatus,
          startedAt: metrics?.lastRun?.startedAt,
          completedAt: metrics?.lastRun?.completedAt,
          durationMs: metrics?.lastRun?.durationMs,
          modelProfile: execution.modelProfile,
          model: execution.model,
          reasoningEffort: execution.reasoningEffort,
          stats: executionStats,
          source: "codex app-server JSON-RPC",
        }),
        attemptId: claim.attemptId,
        retryOf: claim.retryOf,
        trigger: claim.trigger,
        turnId,
        eventsFile: path.basename(stdoutPath),
        promptFile: path.basename(promptPath),
      });
    } catch (error) {
      log("usage_log_error", { task: task.id, error: error.message });
    }
    log("task_end", {
      task: task.id,
      status: finalStatus.status,
      backend: "app-server",
      threadId,
      turnId,
      attempt: claim.attempt,
      totalTokens: metrics?.lastRun?.tokenUsage?.totalTokens || 0,
    });
    writeState();
  }
}

async function executeTaskWithPipeline(taskPath, claim, workerId, config) {
  const task = readTask(taskPath);
  if (
    ["model-completed", "committing", "committed", "delivered"].includes(
      task.metadata.git?.phase,
    )
  ) {
    await executeDeliveryOnly(taskPath, claim, workerId, config);
    return;
  }
  const previousMetrics = task.metadata.metrics || null;
  let pipeline;
  let preparedGit;
  try {
    pipeline = resolvePipelineProfiles(config,
      loadPipelineSnapshot(repoRoot, task.metadata.pipeline),
      task.metadata.execution || resolveTaskExecution(config, {}));
    preparedGit = await prepareTaskGit(repoRoot, taskPath);
  } catch (error) {
    setTaskError(
      taskPath,
      error.message.includes("pipeline") ? "pipeline_config" : error.kind || "git_prepare",
      null,
      error.message,
      previousMetrics,
    );
    releaseClaim(claim);
    interaction.abandon(task.id); active.delete(task.id);
    log("task_pre_model_failure", {
      task: task.id,
      kind: error.message.includes("pipeline")
        ? "pipeline_config"
        : error.kind || "git_prepare",
      error: error.message,
    });
    writeState();
    return;
  }

  beginModelAttempt(taskPath, claim);
  const attemptDir = path.join(
    todoDir(repoRoot),
    "logs",
    task.id,
    `attempt-${String(claim.attempt || 1).padStart(3, "0")}-${claim.attemptId}`,
  );
  mkdirSync(attemptDir, { recursive: true });
  const usagePath = path.join(attemptDir, "usage.json");
  const pipelineRunPath = path.join(attemptDir, "pipeline.json");
  const startedAt = Number.isFinite(Date.parse(claim.claimedAt))
    ? Date.parse(claim.claimedAt)
    : Date.now();
  const baseExecution =
    task.metadata.execution || resolveTaskExecution(config, {});
  const outputSchema = JSON.parse(readFileSync(pipelineResultSchema, "utf8"));
  const stepStats = [];
  let stepSequence = 0;
  let threadTurns = 0;
  let threadId = null;
  let turnId = null;
  let metrics = null;
  let pipelineResult = null;
  let runError = null;

  const stepDirectory = (step, context) => {
    stepSequence += 1;
    const suffix = context.mode === "repair" ? `repair-${context.repairRound}` : "run";
    const directory = path.join(
      attemptDir,
      "pipeline",
      `${String(stepSequence).padStart(3, "0")}-${step.id}-${suffix}`,
    );
    mkdirSync(directory, { recursive: true });
    return directory;
  };

  const stepExecution = (step, backend) => {
    if (step.modelProfile && step.model && step.reasoningEffort) {
      return {
        backend,
        modelProfile: step.modelProfile,
        model: step.model,
        reasoningEffort: step.reasoningEffort,
        ephemeral: baseExecution.ephemeral,
        mode: "background",
      };
    }
    return {
      ...baseExecution,
      backend,
      mode: "background",
    };
  };

  const runExecStep = async (step, context) => {
    const execution = stepExecution(step, "exec");
    const directory = stepDirectory(step, context);
    const stdoutPath = path.join(directory, "stdout.log");
    const stderrPath = path.join(directory, "stderr.log");
    const resultPath = path.join(directory, "result.json");
    const promptPath = path.join(directory, "prompt.txt");
    const receiptPath = path.join(directory, "receipt.json");
    const prompt = buildPipelineStepPrompt(
      readTask(taskPath),
      preparedGit.worktreePath,
      step,
      context,
    );
    writeFileSync(promptPath, `${prompt}\n`, "utf8");
    const stdoutFd = openSync(stdoutPath, "a");
    const stderrFd = openSync(stderrPath, "a");
    const args = [
      "exec",
      ...(execution.ephemeral ? ["--ephemeral"] : []),
      "--model",
      execution.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(execution.reasoningEffort)}`,
      "--sandbox",
      config.codexSandbox,
      "-c",
      'approval_policy="never"',
      "-C",
      preparedGit.worktreePath,
      "--color",
      "never",
      "--json",
      "--output-schema",
      pipelineResultSchema,
      "--output-last-message",
      resultPath,
      "-",
    ];
    log("pipeline_step_start", {
      task: task.id,
      step: step.id,
      type: step.type,
      repairRound: context.repairRound,
      modelProfile: execution.modelProfile,
    });
    let child;
    let spawnError = null;
    let exitCode = null;
    try {
      child = spawn(config.codexCommand, args, {
        cwd: preparedGit.worktreePath,
        env: {
          ...process.env,
          TODO_RUNNER_WORKER: "1",
          TODO_RUNNER_REPO_ROOT: repoRoot,
          TODO_RUNNER_TASK_FILE: taskPath,
        },
        stdio: ["pipe", stdoutFd, stderrFd],
      });
      const entry = active.get(task.id);
      if (entry) entry.child = child;
      child.stdin.end(prompt);
      exitCode = await new Promise((resolve) => {
        child.once("error", (error) => {
          spawnError = error;
          resolve(null);
        });
        child.once("close", (code) => resolve(code));
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      const entry = active.get(task.id);
      if (entry?.child === child) entry.child = null;
    }
    const stats = parseExecutionStats(
      existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
    );
    stepStats.push({ stepId: step.id, type: step.type, execution, stats });
    if (spawnError || exitCode !== 0) {
      const detail = readLogTail(stderrPath) || readLogTail(stdoutPath);
      const error = new Error(
        spawnError?.message || detail || `codex exec exited with code ${exitCode}`,
      );
      error.kind = spawnError ? "codex_spawn" : "codex_exec";
      error.code = exitCode;
      throw error;
    }
    let result;
    try {
      result = parsePipelineStepResult(resultPath);
    } catch (error) {
      error.kind = "invalid_result";
      throw error;
    }
    const receipt = {
      status: result.status,
      summary: result.summary,
      modelProfile: execution.modelProfile,
      resultPath: path.relative(repoRoot, resultPath),
      stdoutPath: path.relative(repoRoot, stdoutPath),
      stderrPath: path.relative(repoRoot, stderrPath),
    };
    atomicWriteJson(receiptPath, receipt);
    log("pipeline_step_end", {
      task: task.id,
      step: step.id,
      type: step.type,
      status: result.status,
      repairRound: context.repairRound,
    });
    return { ...result, receipt };
  };

  const runThreadStep = async (step, context) => {
    const execution = stepExecution(step, "app-server");
    const directory = stepDirectory(step, context);
    const stdoutPath = path.join(directory, "stdout.log");
    const stderrPath = path.join(directory, "stderr.log");
    const resultPath = path.join(directory, "result.json");
    const promptPath = path.join(directory, "prompt.txt");
    const receiptPath = path.join(directory, "receipt.json");
    const prompt = buildPipelineStepPrompt(
      readTask(taskPath),
      preparedGit.worktreePath,
      step,
      context,
      { continueThread: threadTurns > 0 },
    );
    writeFileSync(promptPath, `${prompt}\n`, "utf8");
    const thread = await loadTaskThread(
      taskPath,
      execution,
      preparedGit.worktreePath,
      config,
    );
    threadId = thread.id;
    const client = await ensureAppServer(config);
    const entry = active.get(task.id);
    if (entry) { entry.threadId = threadId; entry.turnId = null; }
    let finalMessage = null;
    log("pipeline_step_start", {
      task: task.id,
      step: step.id,
      type: step.type,
      repairRound: context.repairRound,
      modelProfile: execution.modelProfile,
      threadId,
    });
    try {
      turnId = await client.startTurn(
        {
          threadId,
          input: [{ type: "text", text: prompt }],
          cwd: preparedGit.worktreePath,
          model: execution.model,
          effort: execution.reasoningEffort,
          approvalPolicy: "never",
          outputSchema,
        },
        (message, line) => {
          appendFileSync(stdoutPath, `${line}\n`, "utf8");
          const item = message.params?.item;
          if (
            message.method === "item/completed" &&
            item?.type === "agentMessage" &&
            typeof item.text === "string"
          ) {
            finalMessage = item.text;
          }
        },
      );
      updateTaskCodexThread(taskPath, { state: "active", lastTurnId: turnId });
      if (entry) entry.turnId = turnId;
      const turn = await client.waitForTurn(threadId, turnId);
      if (turn.status !== "completed") {
        const error = new Error(
          turn.error?.message || `Codex turn ended with status ${turn.status}`,
        );
        error.kind = turn.status === "interrupted" ? "interrupted" : "app_server";
        throw error;
      }
      if (!finalMessage) {
        const item = [...(turn.items || [])]
          .reverse()
          .find((candidate) => candidate?.type === "agentMessage");
        finalMessage = item?.text || null;
      }
      if (!finalMessage) throw new Error("Codex app-server returned no pipeline result");
      writeFileSync(resultPath, finalMessage, "utf8");
    } catch (error) {
      appendFileSync(stderrPath, `${error.stack || error.message}\n`, "utf8");
      throw error;
    } finally {
      threadTurns += 1;
    }
    const stats = parseAppServerExecutionStats(
      existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
      turnId,
    );
    stats.threadId = threadId;
    stepStats.push({ stepId: step.id, type: step.type, execution, stats });
    let result;
    try {
      result = parsePipelineStepResult(resultPath);
    } catch (error) {
      error.kind = "invalid_result";
      throw error;
    }
    const receipt = {
      status: result.status,
      summary: result.summary,
      modelProfile: execution.modelProfile,
      threadId,
      turnId,
      resultPath: path.relative(repoRoot, resultPath),
      stdoutPath: path.relative(repoRoot, stdoutPath),
      stderrPath: path.relative(repoRoot, stderrPath),
    };
    atomicWriteJson(receiptPath, receipt);
    log("pipeline_step_end", {
      task: task.id,
      step: step.id,
      type: step.type,
      status: result.status,
      repairRound: context.repairRound,
      threadId,
      turnId,
    });
    return { ...result, receipt };
  };

  const runShellStep = async (step, context) => {
    const directory = stepDirectory(step, { ...context, mode: "shell" });
    const stdoutPath = path.join(directory, "stdout.log");
    const stderrPath = path.join(directory, "stderr.log");
    const receiptPath = path.join(directory, "receipt.json");
    const cwd = path.resolve(preparedGit.worktreePath, step.cwd);
    log("pipeline_step_start", { task: task.id, step: step.id, type: step.type,
      repairRound: context.repairRound, command: step.command, cwd: step.cwd });
    const receipt = await runShellCommand({
      command: step.command, cwd, timeoutSeconds: step.timeoutSeconds,
      stdoutPath, stderrPath,
      env: { ...process.env, TODO_RUNNER_WORKER: "1", TODO_RUNNER_REPO_ROOT: repoRoot, TODO_RUNNER_TASK_FILE: taskPath },
      onChild: child => { const entry = active.get(task.id); if (entry) entry.child = child; },
    });
    receipt.cwd = step.cwd;
    receipt.stdoutPath = path.relative(repoRoot, stdoutPath);
    receipt.stderrPath = path.relative(repoRoot, stderrPath);
    const { exitCode, signal, timedOut } = receipt;
    const passed = receipt.status === "completed";
    atomicWriteJson(receiptPath, receipt);
    log("pipeline_step_end", {
      task: task.id,
      step: step.id,
      type: step.type,
      status: receipt.status,
      repairRound: context.repairRound,
      exitCode,
      signal,
      timedOut,
    });
    const error = passed
      ? null
      : receipt.error ||
        (timedOut
          ? `timed out after ${step.timeoutSeconds}s`
          : receipt.stderrTail || receipt.stdoutTail || `exit code ${exitCode}`);
    return {
      status: receipt.status,
      summary: passed
        ? `${step.id} passed: ${step.command}`
        : `${step.id} failed: ${error}`,
      error,
      validation: passed ? [`${step.id}: ${step.command}`] : [],
      requiresInteractive: false,
      interactiveReason: null,
      receipt,
    };
  };

  log("task_start", {
    task: task.id,
    worker: workerId,
    backend: "pipeline",
    pipeline: pipeline.source,
    pipelineDigest: pipeline.digest,
    attempt: claim.attempt,
    attemptId: claim.attemptId,
    worktreePath: preparedGit.worktreePath,
  });
  atomicWriteJson(usagePath, {
    schemaVersion: 2,
    taskId: task.id,
    attempt: claim.attempt,
    attemptId: claim.attemptId,
    status: "running",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: null,
    durationMs: 0,
    modelProfile: baseExecution.modelProfile,
    model: baseExecution.model,
    reasoningEffort: baseExecution.reasoningEffort,
    threadId: null,
    source: "ToDo repository pipeline",
    tokenUsage: emptyTokenUsage(),
    observable: { pipeline: { source: pipeline.source, digest: pipeline.digest } },
    requestStats: {
      available: false,
      coverage: "none",
      requests: [],
      transportRetries: 0,
      reason: "pipeline_running",
    },
  });

  try {
    pipelineResult = await runPipeline(pipeline, {
      runCodex: (step, context) => {
        if (stopping) throw new Error("Pipeline interrupted by runner shutdown");
        return step.type === "codex-exec" ? runExecStep(step, context) : runThreadStep(step, context);
      },
      runShell: (step, context) => {
        if (stopping) throw new Error("Pipeline interrupted by runner shutdown");
        return runShellStep(step, context);
      },
      onState: async (state) => {
        atomicWriteJson(pipelineRunPath, {
          schemaVersion: 1,
          taskId: task.id,
          attemptId: claim.attemptId,
          pipeline: {
            source: pipeline.source,
            digest: pipeline.digest,
            name: pipeline.name,
          },
          updatedAt: new Date().toISOString(),
          ...state,
        });
      },
    }, task.metadata.pipelineContinuation?.ready ? task.metadata.pipelineContinuation : null);
  } catch (error) {
    runError = error;
  }

  const executionStats = {
    threadId,
    tokenUsage: combinedTokenUsage(stepStats.map((entry) => entry.stats.tokenUsage)),
    observable: {
      pipeline: {
        source: pipeline.source,
        digest: pipeline.digest,
        steps: stepStats.map((entry) => ({
          id: entry.stepId,
          type: entry.type,
          modelProfile: entry.execution.modelProfile,
        })),
      },
    },
    requestStats: {
      available: false,
      coverage: "none",
      requests: [],
      transportRetries: 0,
      reason: "pipeline_aggregates_step_usage",
    },
  };
  metrics = cumulativeTaskMetrics(
    previousMetrics,
    taskMetrics(startedAt, Date.now(), executionStats.tokenUsage),
  );

  try {
    if (runError) {
      const kind = runError.kind || "pipeline_runner";
      setTaskError(
        taskPath,
        kind,
        runError.code || null,
        runError.message,
        metrics,
        attemptFailure(
          claim,
          kind,
          runError.code || null,
          runError.message,
          path.relative(repoRoot, usagePath),
        ),
      );
      return;
    }
    if (pipelineResult.status === "failed") {
      const failure = pipelineResult.failure;
      if (failure.requiresInteractive) {
        setTaskError(
          taskPath,
          "interactive_required",
          null,
          failure.interactiveReason,
          metrics,
          attemptFailure(
            claim,
            "interactive_required",
            null,
            failure.interactiveReason,
            path.relative(repoRoot, usagePath),
            true,
          ),
        );
        const waiting = readTask(taskPath);
        waiting.metadata.pipelineContinuation = pipelineResult.continuation;
        waiting.metadata.interaction = { state: "waiting-input", question: failure.interactiveReason,
          nativeThreadId: waiting.metadata.interaction?.nativeThreadId || null,
          updatedAt: new Date().toISOString() };
        waiting.metadata.execution = { ...waiting.metadata.execution, mode: "interactive" };
        writeTask(waiting);
      } else {
        const message =
          failure.error || failure.summary || `pipeline step ${pipelineResult.failedStep.id} failed`;
        setTaskError(
          taskPath,
          pipelineResult.failedStep.type === "shell"
            ? "pipeline_validation"
            : "agent_reported_failure",
          failure.receipt?.exitCode ?? null,
          message,
          metrics,
          attemptFailure(
            claim,
            pipelineResult.failedStep.type === "shell"
              ? "pipeline_validation"
              : "agent_reported_failure",
            failure.receipt?.exitCode ?? null,
            message,
            path.relative(repoRoot, usagePath),
          ),
        );
      }
      return;
    }

    const finalShellResults = new Map();
    for (const execution of pipelineResult.executions) {
      if (execution.type === "shell" && execution.status === "completed") {
        finalShellResults.set(execution.stepId, execution);
      }
    }
    const validation = pipeline.steps
      .filter((step) => step.type === "shell")
      .map((step) => finalShellResults.get(step.id)?.validation?.[0])
      .filter(Boolean);
    if (validation.length === 0) {
      validation.push(`pipeline ${pipeline.name}: completed`);
    }
    const result = {
      status: "completed",
      summary: `Pipeline ${pipeline.name} completed${
        pipelineResult.repairRound > 0
          ? ` after ${pipelineResult.repairRound} repair round${pipelineResult.repairRound === 1 ? "" : "s"}`
          : ""
      }.`,
      validation,
    };
    markTaskModelCompleted(
      taskPath,
      claim,
      result,
      metrics,
      path.relative(repoRoot, usagePath),
    );
    try {
      const deliveryPath = path.join(attemptDir, "delivery.json");
      const finalized = await finalizeTaskGit(
        repoRoot,
        taskPath,
        path.relative(repoRoot, deliveryPath),
      );
      atomicWriteJson(deliveryPath, {
        status: finalized.mergeQueued ? "merge-queued" : "completed",
        deliveryAttemptId: finalized.deliveryAttemptId,
        delivery: finalized.delivery,
      });
      if (threadId) await archiveTaskThread(taskPath, config);
      if (!finalized.mergeQueued) {
        completeTask(repoRoot, taskPath, finalized.result, metrics);
      }
    } catch (error) {
      setTaskError(
        taskPath,
        error.taskFailure?.errorKind || error.kind || "git_delivery",
        null,
        error.message,
        metrics,
        error.taskFailure
          ? {
              status: error.taskFailure.status,
              errorKind: error.taskFailure.errorKind,
            }
          : null,
      );
    }
  } finally {
    if (threadId) {
      try {
        await archiveTaskThread(taskPath, config);
      } catch (error) {
        log("task_thread_archive_error", { task: task.id, error: error.message });
      }
    }
    releaseClaim(claim);
    interaction.abandon(task.id); active.delete(task.id);
    const finalStatus = getTaskStatus(repoRoot, task.id);
    const attemptStatus =
      finalStatus.attemptLedger?.attempts?.find(
        (attempt) => attempt.attemptId === claim.attemptId,
      )?.status || finalStatus.status;
    try {
      atomicWriteJson(usagePath, {
        ...buildAttemptUsageV2({
          taskId: task.id,
          attempt: claim.attempt,
          status: attemptStatus,
          startedAt: metrics?.lastRun?.startedAt,
          completedAt: metrics?.lastRun?.completedAt,
          durationMs: metrics?.lastRun?.durationMs,
          modelProfile: baseExecution.modelProfile,
          model: baseExecution.model,
          reasoningEffort: baseExecution.reasoningEffort,
          stats: executionStats,
          source: "ToDo repository pipeline",
        }),
        attemptId: claim.attemptId,
        retryOf: claim.retryOf,
        trigger: claim.trigger,
        pipelineFile: pipeline.source,
        pipelineDigest: pipeline.digest,
        pipelineRunFile: path.basename(pipelineRunPath),
      });
    } catch (error) {
      log("usage_log_error", { task: task.id, error: error.message });
    }
    log("task_end", {
      task: task.id,
      status: finalStatus.status,
      backend: "pipeline",
      pipeline: pipeline.source,
      pipelineDigest: pipeline.digest,
      threadId,
      turnId,
      attempt: claim.attempt,
      totalTokens: metrics?.lastRun?.tokenUsage?.totalTokens || 0,
    });
    writeState();
  }
}

async function executeTask(taskPath, claim, workerId, config) {
  const task = readTask(taskPath);
  // Resolve once per attempt, so a config reload cannot change an active turn.
  if (!["model-completed", "committing", "committed", "delivered"].includes(task.metadata.git?.phase)) {
    try {
      const profileConfig = { ...config, modelCatalog: null };
      const previous = task.metadata.execution;
      const execution = resolveSavedExecution(profileConfig, previous);
      const profiles = [{ ...execution, name: execution.modelProfile }];
      if (task.metadata.pipeline && task.metadata.git?.phase !== "merge-conflict") {
        const pipeline = resolvePipelineProfiles(profileConfig,
          loadPipelineSnapshot(repoRoot, task.metadata.pipeline), execution);
        profiles.push(...[...pipeline.steps, pipeline.repair].filter(step => step?.model).map(step => ({ ...step, name: step.modelProfile })));
      }
      task.metadata.execution = execution;
      writeTask(task);
      if (previous && (previous.model !== execution.model || previous.reasoningEffort !== execution.reasoningEffort)) {
        log("task_model_refreshed", { task: task.id, profile: execution.modelProfile,
          previousModel: previous.model, model: execution.model, reasoningEffort: execution.reasoningEffort });
      }
      let catalog = await refreshModelCatalog(repoRoot, config.codexCommand);
      try { assertProfilesAvailable(profiles, catalog); }
      catch { catalog = await refreshModelCatalog(repoRoot, config.codexCommand, { force: true }); }
      assertProfilesAvailable(profiles, catalog);
      config = { ...config, modelCatalog: catalog };
    } catch (error) {
      setTaskError(taskPath, "model_unavailable", null, `Current model profile check failed: ${error.message}`, task.metadata.metrics || null);
      releaseClaim(claim); interaction.abandon(task.id); active.delete(task.id); writeState(); return;
    }
  }
  if (
    task.metadata.pipeline &&
    task.metadata.git?.phase !== "merge-conflict"
  ) {
    return executeTaskWithPipeline(taskPath, claim, workerId, config);
  }
  const execution =
    task.metadata.execution || resolveTaskExecution(config, {});
  return execution.backend === "exec"
    ? executeTaskWithExec(taskPath, claim, workerId, config)
    : executeTaskWithAppServer(taskPath, claim, workerId, config);
}

function hasSpecialWorker(workerId) {
  return [...active.values()].some((entry) => entry.workerId === workerId);
}

const MERGE_QUEUE_BLOCKING_STATUSES = new Set([
  "queued",
  "running",
  "blocked",
  "staging",
  "merge-queued",
  "merge-conflict",
]);

function taskSequenceValue(taskId) {
  const match = /^([0-9]+)/.exec(String(taskId));
  return match ? BigInt(match[1]) : null;
}

function mergeQueueEntry(taskPath) {
  const status = getTaskStatus(repoRoot, taskIdFromFilename(path.basename(taskPath)));
  let batchId = null;
  try {
    batchId = readTask(taskPath).metadata.batchId || null;
  } catch {
    batchId = null;
  }
  return { taskPath, status, batchId };
}

function mergeQueueBlockedByEarlierBatchSibling(candidate, entries) {
  const candidateSequence = taskSequenceValue(candidate.status.id);
  const candidateBatch = candidate.batchId;
  const targetBranch = candidate.status.git?.targetBranch || null;
  if (candidateSequence === null || !candidateBatch || !targetBranch) {
    return false;
  }
  return entries.find((entry) => {
    if (entry.taskPath === candidate.taskPath) return false;
    if (entry.batchId !== candidateBatch) return false;
    if (entry.status.git?.delivery !== "merge") return false;
    if (entry.status.git?.targetBranch !== targetBranch) return false;
    if (!MERGE_QUEUE_BLOCKING_STATUSES.has(entry.status.status)) return false;
    const entrySequence = taskSequenceValue(entry.status.id);
    return entrySequence !== null && entrySequence < candidateSequence;
  });
}

function queuedMergeCandidates(entries) {
  return entries
    .filter(({ status }) => status.status === "merge-queued")
    .filter((candidate) => !mergeQueueBlockedByEarlierBatchSibling(candidate, entries))
    .sort((left, right) => {
      const leftSequence = taskSequenceValue(left.status.id);
      const rightSequence = taskSequenceValue(right.status.id);
      if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
        return leftSequence < rightSequence ? -1 : 1;
      }
      const leftAt = Date.parse(left.status.git?.mergeQueuedAt || left.status.updatedAt);
      const rightAt = Date.parse(right.status.git?.mergeQueuedAt || right.status.updatedAt);
      return leftAt - rightAt || left.status.id.localeCompare(right.status.id);
    });
}

let lastMergeQueueWaitKey = null;

function reportMergeQueueWait(entries, override = null) {
  const waiting = entries.filter(({ status }) => status.git?.phase === "merge-queued")
    .map((entry) => {
      const { status } = entry;
      const sibling = mergeQueueBlockedByEarlierBatchSibling(entry, entries);
      return { task: status.id, ...(override || (
        active.has(status.id) ? { reason: "task_active" } :
        status.claim || existsSync(`${entry.taskPath}.lock`) ? { reason: "task_claimed" } :
        status.existingBlockers?.length ? { reason: "task_blockers", blockers: status.existingBlockers } :
        status.status !== "merge-queued" ? { reason: "task_status", status: status.status } :
        sibling ? { reason: "earlier_batch_sibling", blocker: sibling.status.id, status: sibling.status.status } :
        { reason: "no_candidate" }
      )) };
    });
  const key = waiting.length ? JSON.stringify(waiting) : null;
  if (key && key !== lastMergeQueueWaitKey) log("merge_queue_waiting", { waiting });
  lastMergeQueueWaitKey = key;
}

function startMergeQueueWorker(config) {
  const entries = listTaskFiles(repoRoot).map(mergeQueueEntry);
  if (taskBatchPublicationActive(repoRoot)) {
    reportMergeQueueWait(entries, { reason: "task_batch_active" });
    return;
  }
  if (hasSpecialWorker("merge-queue")) {
    reportMergeQueueWait(entries, { reason: "merge_worker_busy" });
    return;
  }
  const candidate = queuedMergeCandidates(entries).find(
    ({ status }) => !active.has(status.id),
  );
  if (!candidate) {
    reportMergeQueueWait(entries);
    return;
  }
  const { taskPath, status } = candidate;
  let claim;
  try {
    claim = claimTask(taskPath, "merge-queue");
  } catch (error) {
    reportMergeQueueWait(entries, {
      reason: error.kind || (error.code === "EEXIST" ? "claim_contended" : "claim_error"),
      candidate: status.id,
      error: error.message,
    });
    if (error.code !== "EEXIST") {
      log("merge_queue_claim_error", { task: status.id, error: error.message });
    }
    return;
  }
  lastMergeQueueWaitKey = null;
  const entry = {
    claim,
    abortController: new AbortController(),
    child: null,
    taskPath,
    workerId: "merge-queue",
    taskId: status.id,
    taskTitle: status.title,
    promise: null,
  };
  active.set(status.id, entry);
  writeState();
  const promise = (async () => {
    const attemptDir = path.join(
      todoDir(repoRoot),
      "logs",
      status.id,
      `merge-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    mkdirSync(attemptDir, { recursive: true });
    const deliveryPath = path.join(attemptDir, "delivery.json");
    log("merge_queue_start", { task: status.id, target: status.git?.targetBranch });
    try {
      const merged = await processTaskMergeQueue(
        repoRoot,
        taskPath,
        path.relative(repoRoot, deliveryPath),
        { onChild: child => { entry.child = child; }, signal: entry.abortController.signal },
      );
      atomicWriteJson(deliveryPath, merged);
      if (merged.status === "merged") {
        if ((status.execution?.backend || config.executionBackend) === "app-server") {
          await archiveTaskThread(taskPath, config);
        }
        completeTask(repoRoot, taskPath, merged.result, status.metrics || null);
        log("merge_queue_merged", {
          task: status.id,
          targetCommit: merged.delivery?.targetCommit,
        });
      } else {
        log("merge_queue_conflict", {
          task: status.id,
          files: merged.conflict?.files || [],
        });
      }
    } catch (error) {
      atomicWriteJson(deliveryPath, {
        status: "failed",
        errorKind: error.taskFailure?.errorKind || error.kind || "git_delivery",
        error: String(error.message).slice(0, 4000),
      });
      log("merge_queue_error", { task: status.id, error: error.message });
    } finally {
      releaseClaim(claim);
      interaction.abandon(status.id); active.delete(status.id);
      writeState();
    }
  })();
  entry.promise = promise;
}

function startMergeConflictRepair(config) {
  if (hasSpecialWorker("merge-repair")) return;
  const candidate = listTaskFiles(repoRoot)
    .map((taskPath) => ({ taskPath, status: getTaskStatus(repoRoot, taskIdFromFilename(path.basename(taskPath))) }))
    .find(({ status }) => status.status === "merge-conflict" && !active.has(status.id));
  if (!candidate) return;
  const { taskPath } = candidate;
  let status = candidate.status;
  const backend = status.execution?.backend || config.executionBackend;
  if (backend === "app-server" && !status.codexThread?.id) {
    const task = readTask(taskPath);
    task.metadata.git = {
      ...task.metadata.git,
      phase: "merge-failed",
      deliveryError: "Merge conflict repair requires the original persistent app-server thread",
    };
    task.metadata.error = {
      at: new Date().toISOString(),
      kind: "merge_thread_unavailable",
      exit_code: null,
      message: task.metadata.git.deliveryError,
    };
    task.metadata.outcome = "failed_permanent";
    writeTask(task);
    log("merge_repair_unavailable", { task: status.id });
    return;
  }
  try {
    status = prepareTaskMergeConflictRepair(repoRoot, taskPath);
  } catch (error) {
    log("merge_repair_prepare_error", { task: status.id, error: error.message });
    return;
  }
  let claim;
  try {
    claim = claimTask(taskPath, "merge-repair");
  } catch (error) {
    if (error.code !== "EEXIST") {
      log("merge_repair_claim_error", { task: status.id, error: error.message });
    }
    return;
  }
  const entry = {
    claim,
    child: null,
    taskPath,
    workerId: "merge-repair",
    taskId: status.id,
    taskTitle: status.title,
    promise: null,
  };
  active.set(status.id, entry);
  writeState();
  const promise = executeTask(
    taskPath,
    claim,
    "merge-repair",
    config,
  ).catch((error) => {
    log("merge_repair_error", { task: status.id, error: error.message });
    if (existsSync(`${taskPath}.lock`)) releaseClaim(claim);
    interaction.abandon(status.id); active.delete(status.id);
    writeState();
  });
  entry.promise = promise;
}

function startReadyTasks(config) {
  if (taskBatchPublicationActive(repoRoot)) return;
  for (const taskPath of listTaskFiles(repoRoot)) {
    if (implementationActiveCount() >= config.workers) return;
    const id = taskIdFromFilename(path.basename(taskPath));
    if (active.has(id)) continue;
    let status = getTaskStatus(repoRoot, id);
    if (status.execution?.mode === "interactive") continue;
    if (status.codexThread?.state === "archive-pending") continue;
    if (status.status === "failed" && canAutoRetry(config, status)) {
      try {
        const deliveryOnly = [
          "model-completed",
          "committing",
          "committed",
          "delivered",
        ].includes(status.git?.phase);
        const failedAttempts = deliveryOnly
          ? status.attemptLedger?.deliveryAttempts?.length || 0
          : status.attemptLedger?.attempts?.length || 0;
        retryTask(repoRoot, id, { trigger: "automatic_retry" });
        log("task_auto_retry", {
          task: id,
          retry: failedAttempts,
          retries: config.retries,
          phase: deliveryOnly ? "delivery" : "model",
        });
        status = getTaskStatus(repoRoot, id);
      } catch (error) {
        log("task_auto_retry_error", { task: id, error: error.message });
        continue;
      }
    }
    if (status.status !== "queued") continue;

    const usedWorkerIds = new Set(
      [...active.values()].map((entry) => entry.workerId),
    );
    let workerId = null;
    for (let candidate = 1; candidate <= config.workers; candidate += 1) {
      if (!usedWorkerIds.has(candidate)) {
        workerId = candidate;
        break;
      }
    }
    if (workerId === null) return;

    let claim;
    try {
      claim = claimTask(taskPath, workerId);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      log("claim_error", { task: id, error: error.message });
      continue;
    }
    const current = getTaskStatus(repoRoot, id);
    if (current.status !== "running") {
      releaseClaim(claim);
      continue;
    }

    active.set(id, {
      claim,
      child: null,
      taskPath,
      workerId,
      taskId: id,
      taskTitle: status.title,
      promise: null,
    });
    writeState();
    const promise = executeTask(taskPath, claim, workerId, config).catch((error) => {
      const current = getTaskStatus(repoRoot, id);
      const alreadyRecorded = current.attemptLedger?.attempts?.some(
        (attempt) => attempt.attemptId === claim.attemptId,
      );
      const modelAttemptStarted = Boolean(claim.attemptId);
      const completedAt = Date.now();
      const claimedAt = Date.parse(claim.claimedAt);
      const metrics = !modelAttemptStarted || alreadyRecorded
        ? current.metrics || null
        : cumulativeTaskMetrics(
            current.metrics || null,
            taskMetrics(
              Number.isFinite(claimedAt) ? claimedAt : completedAt,
              completedAt,
              emptyTokenUsage(),
            ),
          );
      setTaskError(
        taskPath,
        "runner_unhandled",
        null,
        error.message,
        metrics,
        !modelAttemptStarted || alreadyRecorded
          ? null
          : attemptFailure(
              claim,
              "runner_unhandled",
              null,
              error.message,
              null,
            ),
      );
      releaseClaim(claim);
      interaction.abandon(id); active.delete(id);
      log("task_unhandled_error", { task: id, error: error.message });
    });
    const entry = active.get(id);
    if (entry) entry.promise = promise;
  }
}

function consumeAuthorizedStopRequest() {
  const requestPath = daemonStopRequestPath(repoRoot);
  if (!existsSync(requestPath)) return false;
  try {
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    if (
      request?.implementation !== DAEMON_IMPLEMENTATION ||
      request?.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
      request?.pid !== process.pid ||
      request?.token !== daemonToken
    ) {
      return false;
    }
    unlinkSync(requestPath);
    return true;
  } catch {
    return false;
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("daemon_stop", { signal });
  try {
    writeState("stopping");
  } catch (error) {
    log("daemon_stopping_state_error", { error: error.message });
  }
  const interrupted = [...active.values()];
  for (const entry of interrupted) {
    entry.abortController?.abort();
    if (appServer && entry.threadId && entry.turnId) {
      appServer.interruptTurn(entry.threadId, entry.turnId).catch((error) => {
        log("turn_interrupt_error", {
          task: entry.taskId,
          error: error.message,
        });
      });
    }
    if (
      entry.child &&
      entry.child.exitCode === null &&
      entry.child.signalCode === null
    ) {
      if (entry.child.terminateTree) entry.child.terminateTree();
      else entry.child.kill();
    }
  }
  const pending = Promise.allSettled(
    interrupted.map((entry) => entry.promise).filter(Boolean),
  );
  const settled = await Promise.race([
    pending.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!settled) {
    for (const entry of interrupted) {
      if (
        entry.child &&
        entry.child.exitCode === null &&
        entry.child.signalCode === null
      ) {
        if (entry.child.terminateTree) entry.child.terminateTree();
        else entry.child.kill("SIGKILL");
      }
    }
    await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  for (const entry of interrupted) {
    if (!entry.threadId || !entry.taskPath) continue;
    try {
      await archiveTaskThread(entry.taskPath, runtimeConfig);
    } catch (error) {
      log("shutdown_task_thread_archive_error", {
        task: entry.taskId,
        error: error.message,
      });
    }
  }
  if (dashboard) {
    const server = dashboard.server;
    dashboard = null;
    await closeDashboard(server);
  }
  if (appServer) {
    const client = appServer;
    appServer = null;
    await client.close();
  }
  writeState("stopped");
  const current = readDaemonState(repoRoot);
  if (current?.token === daemonToken && existsSync(daemonStatePath(repoRoot))) {
    unlinkSync(daemonStatePath(repoRoot));
  }
  desktopClient?.close();
  process.exit(0);
}

async function shutdownForRuntimeUpdate() {
  if (stopping) return;
  stopping = true;
  log("runtime_update_ready", {
    requestId: runtimeUpdateRequest?.requestId,
    target: runtimeUpdateRequest?.target,
  });
  writeState("restart-pending");
  if (dashboard) {
    const server = dashboard.server;
    dashboard = null;
    await closeDashboard(server);
  }
  if (appServer) {
    const client = appServer;
    appServer = null;
    await client.close();
  }
  const current = readDaemonState(repoRoot);
  if (current?.token === daemonToken && existsSync(daemonStatePath(repoRoot))) {
    unlinkSync(daemonStatePath(repoRoot));
  }
  desktopClient?.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => {
  if (!consumeAuthorizedStopRequest()) {
    log("daemon_signal_ignored", {
      signal: "SIGTERM",
      reason: "missing_or_invalid_stop_request",
    });
    return;
  }
  shutdown("SIGTERM");
});
process.on("SIGHUP", () => shutdown("SIGHUP"));

runtimeConfig = loadConfig(repoRoot);
configLastCheckedAt = new Date().toISOString();
configAppliedAt = configLastCheckedAt;
configReloadWarning = runtimeConfig.warning;
const initialDashboardThreadId =
  readDashboardThreadRequest(repoRoot)?.threadId || null;
try {
  dashboard = await startDashboard(
    repoRoot,
    runtimeConfig.dashboardPort,
    initialDashboardThreadId,
    desktopTaskAction,
  );
} catch (error) {
  if (runtimeConfig.dashboardPort === 0) throw error;
  log("dashboard_port_fallback", {
    requestedPort: runtimeConfig.dashboardPort,
    error: error.message,
  });
  dashboard = await startDashboard(repoRoot, 0, initialDashboardThreadId, desktopTaskAction);
}
watchDashboardErrors(dashboard);
log("daemon_start", {
  repoRoot,
  dashboardThreadId: dashboard.threadId,
  dashboardUrl: dashboard.url,
});
cleanupStaleClaims(repoRoot);
// File events include mutations made by MCP and interactive app sessions. Keep
// polling as recovery for lost fs events; no scheduled model run is involved.
let titleChangeTimer = null;
const taskChanges = watch(todoDir(repoRoot), (_event, filename) => {
  const name = String(filename || "");
  if (name && !/^[0-9].*\.md(?:\.lock)?$/.test(name) && name !== "supervisor.json") return;
  clearTimeout(titleChangeTimer);
  titleChangeTimer = setTimeout(() => {
    if (!stopping) {
      scheduleSupervisorThreadTitleSync(runtimeConfig);
      scheduleDesktopMaintenance(runtimeConfig);
    scheduleNativeTasks(runtimeConfig);
    }
  }, 25);
});
taskChanges.on("error", error => log("task_watch_error", { error: error.message }));
process.once("exit", () => { clearTimeout(titleChangeTimer); taskChanges.close(); });
process.on("SIGUSR2", () => {
  scheduleDashboardThreadSync().catch((error) => {
    log("dashboard_thread_reload_error", { error: error.message });
  });
});
writeState();

let nextTaskPollAt = Date.now();
let nextConfigReloadAt =
  Date.now() + runtimeConfig.configReloadIntervalMs;
while (!stopping) {
  const restartDecision = daemonRestartDecision(
    repoRoot,
    { pid: process.pid, token: daemonToken },
    ownRuntime,
  );
  if (restartDecision.retiredRequest) {
    log("runtime_update_request_retired", {
      requestId: restartDecision.retiredRequest.requestId,
      reason: "predecessor_daemon",
      previousDaemon: restartDecision.retiredRequest.daemon,
    });
  }
  if (restartDecision.pending) {
    runtimeUpdateRequest = restartDecision.request;
    if (active.size === 0) {
      await shutdownForRuntimeUpdate();
      break;
    }
    writeState("restart-pending");
    await new Promise((resolve) => setTimeout(resolve, 250));
    continue;
  }
  runtimeUpdateRequest = null;
  if (!isActivated(repoRoot)) {
    if (active.size === 0) {
      await shutdown("deactivated");
      break;
    }
    if (!deactivationDeferred) {
      log("config_deactivation_deferred", {
        activeTasksPreserved: active.size,
      });
      deactivationDeferred = true;
    }
    writeState("draining");
    await new Promise((resolve) => setTimeout(resolve, 250));
    continue;
  }
  if (deactivationDeferred) {
    deactivationDeferred = false;
    log("config_reactivated", { activeTasksPreserved: active.size });
  }

  await scheduleDashboardThreadSync();

  const now = Date.now();
  if (now >= nextConfigReloadAt) {
    const changed = await reloadRuntimeConfig();
    nextConfigReloadAt =
      Date.now() + runtimeConfig.configReloadIntervalMs;
    if (changed.length > 0) nextTaskPollAt = Date.now();
  }

  if (Date.now() >= nextTaskPollAt) {
    cleanupStaleClaims(repoRoot);
    await processPendingThreadArchives(runtimeConfig);
    scheduleSupervisorThreadTitleSync(runtimeConfig);
    startReadyTasks(runtimeConfig);
    scheduleDesktopMaintenance(runtimeConfig);
    scheduleNativeTasks(runtimeConfig);
    startMergeQueueWorker(runtimeConfig);
    startMergeConflictRepair(runtimeConfig);
    scheduleSupervisorThreadTitleSync(runtimeConfig);
    writeState();
    nextTaskPollAt = Date.now() + runtimeConfig.pollIntervalMs;
  }

  const sleepUntil = Math.min(nextTaskPollAt, nextConfigReloadAt);
  const sleepMs = Math.max(10, sleepUntil - Date.now());
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}
