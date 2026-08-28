import {
  closeSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
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
  releaseClaim,
  resolveTaskExecution,
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
import { classifyFailure } from "./attempt-ledger.mjs";
import { TODO_PONYTAIL_FULL_CONTOUR } from "./ponytail-policy.mjs";
import {
  daemonRestartDecision,
  runtimeDescriptor,
} from "./runtime-update.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const ownRuntime = runtimeDescriptor(pluginRoot);
const resultSchema = path.join(scriptDir, "result.schema.json");
const repoIndex = process.argv.indexOf("--repo");
const repoRoot =
  repoIndex >= 0 && process.argv[repoIndex + 1]
    ? path.resolve(process.argv[repoIndex + 1])
    : path.resolve(process.env.TODO_RUNNER_REPO_ROOT || process.cwd());
const daemonToken = randomUUID();
const daemonStartedAt = new Date().toISOString();
const pluginVersion = ownRuntime.pluginVersion;
const active = new Map();
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
    replacement = await startDashboard(repoRoot, 0, threadId);
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
    ...taskCreationInstructions,
    "Read AGENTS.md and all applicable nested AGENTS.md files before acting.",
    "Preserve unrelated and concurrent changes.",
    "Do not create, switch, commit, merge, cherry-pick, rebase, push, or delete Git branches and do not create pull requests. The ToDo runner owns all mutating Git operations.",
    "Read-only Git inspection such as status, diff, and log is allowed.",
    "Do not edit or delete .todo task, claim, history, daemon, log, or config files.",
    "Complete only this task, run the smallest relevant tests or verification, and report at least one concrete validation result. A completed result with no validation evidence is invalid.",
    "Reuse tool results within this attempt. Prefer narrow field filters, limits, and targeted log ranges; do not repeatedly fetch unchanged resources.",
    "Do not ask for user input. If blocked, return status failed with one concrete actionable error.",
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
  writeTask(task);
}

function readLogTail(file, maxBytes = 12000) {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  return text.slice(Math.max(0, text.length - maxBytes)).trim();
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
  return thread;
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
    active.delete(task.id);
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
    active.delete(task.id);
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
    active.delete(task.id);
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
    active.delete(task.id);
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
    active.delete(task.id);
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

async function executeTask(taskPath, claim, workerId, config) {
  const task = readTask(taskPath);
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
  return entries.some((entry) => {
    if (entry.taskPath === candidate.taskPath) return false;
    if (entry.batchId !== candidateBatch) return false;
    if (entry.status.git?.delivery !== "merge") return false;
    if (entry.status.git?.targetBranch !== targetBranch) return false;
    if (!MERGE_QUEUE_BLOCKING_STATUSES.has(entry.status.status)) return false;
    const entrySequence = taskSequenceValue(entry.status.id);
    return entrySequence !== null && entrySequence < candidateSequence;
  });
}

function queuedMergeCandidates() {
  const entries = listTaskFiles(repoRoot).map(mergeQueueEntry);
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

function startMergeQueueWorker(config) {
  if (taskBatchPublicationActive(repoRoot) || hasSpecialWorker("merge-queue")) {
    return;
  }
  const candidate = queuedMergeCandidates().find(
    ({ status }) => !active.has(status.id),
  );
  if (!candidate) return;
  const { taskPath, status } = candidate;
  let claim;
  try {
    claim = claimTask(taskPath, "merge-queue");
  } catch (error) {
    if (error.code !== "EEXIST") {
      log("merge_queue_claim_error", { task: status.id, error: error.message });
    }
    return;
  }
  const entry = {
    claim,
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
      active.delete(status.id);
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
    active.delete(status.id);
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
      active.delete(id);
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
      entry.child.kill();
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
        entry.child.kill("SIGKILL");
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
  );
} catch (error) {
  if (runtimeConfig.dashboardPort === 0) throw error;
  log("dashboard_port_fallback", {
    requestedPort: runtimeConfig.dashboardPort,
    error: error.message,
  });
  dashboard = await startDashboard(repoRoot, 0, initialDashboardThreadId);
}
watchDashboardErrors(dashboard);
log("daemon_start", {
  repoRoot,
  dashboardThreadId: dashboard.threadId,
  dashboardUrl: dashboard.url,
});
cleanupStaleClaims(repoRoot);
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
