import {
  closeSync,
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
import { fileURLToPath } from "node:url";
import { startDashboard } from "./dashboard.mjs";
import {
  applyGitExcludes,
  atomicWriteJson,
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
  getTaskStatus,
  isActivated,
  isCurrentDaemonState,
  listTaskFiles,
  loadConfig,
  normalizeExternalTaskOutcome,
  processIsAlive,
  readDaemonState,
  readTask,
  releaseClaim,
  resolveTaskExecution,
  retryTask,
  setTaskError,
  taskMetrics,
  taskIdFromFilename,
  todoDir,
  writeTask,
} from "./lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const resultSchema = path.join(scriptDir, "result.schema.json");
const repoIndex = process.argv.indexOf("--repo");
const repoRoot =
  repoIndex >= 0 && process.argv[repoIndex + 1]
    ? path.resolve(process.argv[repoIndex + 1])
    : path.resolve(process.env.TODO_RUNNER_REPO_ROOT || process.cwd());
const daemonToken = randomUUID();
const pluginVersion = (() => {
  try {
    return JSON.parse(
      readFileSync(
        path.join(scriptDir, "..", ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    ).version;
  } catch {
    return null;
  }
})();
const active = new Map();
let dashboard = null;
let stopping = false;
let lastWarning = null;
let runtimeConfig = null;
let configLastCheckedAt = null;
let configAppliedAt = null;
let configReloadWarning = null;
let deactivationDeferred = false;

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
  const resolvedStatus = status || (stopping ? "stopping" : "running");
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
      pid: entry?.child?.pid || null,
      daemonPid: process.pid,
      taskId: entry?.taskId || null,
      taskTitle: entry?.taskTitle || null,
    });
  }
  for (const entry of active.values()) {
    if (entry.workerId <= config.workers) continue;
    workerStates.push({
      id: entry.workerId,
      status: "draining",
      runner: "node",
      pid: entry.child?.pid || null,
      daemonPid: process.pid,
      taskId: entry.taskId,
      taskTitle: entry.taskTitle,
    });
  }
  atomicWriteJson(daemonStatePath(repoRoot), {
    implementation: DAEMON_IMPLEMENTATION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pluginVersion,
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
      codexSandbox: config.codexSandbox,
      modelProfiles: config.modelProfiles,
      defaultModelProfile: config.defaultModelProfile,
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
        }
      : null,
    active: [...active.keys()],
    workerStates,
    startedAt:
      readDaemonState(repoRoot)?.startedAt || new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  });
}

const RUNTIME_CONFIG_KEYS = [
  "workers",
  "pollIntervalMs",
  "configReloadIntervalMs",
  "dashboardPort",
  "retries",
  "gitExclude",
  "codexCommand",
  "codexSandbox",
  "modelProfiles",
  "defaultModelProfile",
  "routingMode",
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
    replacement = await startDashboard(repoRoot, nextConfig.dashboardPort);
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
  configAppliedAt = checkedAt;
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

function buildPrompt(task) {
  const externalWorkflows = task.metadata.externalWorkflows || [];
  const externalInstructions =
    externalWorkflows.length === 0
      ? []
      : [
          "This task is linked to external work items. The linkage does not change the execution mode.",
          `External workflows: ${JSON.stringify(externalWorkflows)}`,
          "Use an available purpose-built connector or authenticated CLI for every linked item.",
          "Before implementation, move each item to its service-native semantic In Progress state. After the outcome, move it to the matching final state and add a result comment explicitly identifying Codex (AI) or ИИ as the actor.",
          "For completed work, return one exact externalSync status/comment receipt per linked item. If any external transition or comment cannot be synchronized, return status failed with externalSyncError. Never fabricate a receipt.",
        ];
  return [
    `You are a ToDo worker in ${repoRoot}.`,
    "Implement the claimed task directly. Do not enqueue it again and do not call ToDo MCP tools.",
    "Read AGENTS.md and all applicable nested AGENTS.md files before acting.",
    "Preserve unrelated and concurrent changes.",
    "Do not edit or delete .todo task, claim, history, daemon, log, or config files.",
    "Complete only this task and run the smallest relevant validation.",
    "Do not ask for user input. If blocked, return status failed with one concrete actionable error.",
    "Set requiresInteractive=true only when the task cannot be completed without current-thread Browser, Chrome, Computer Use, user approval, or user interaction. Include one concrete interactiveReason. For every other result set requiresInteractive=false and interactiveReason=null.",
    ...externalInstructions,
    "Return only the JSON object required by the output schema.",
    "",
    `Task file: .todo/${task.filename}`,
    "",
    task.text,
  ].join("\n");
}

function externalFailureEvidence(task, message) {
  if ((task.metadata.externalWorkflows || []).length === 0) return null;
  return {
    externalSync: [],
    externalSyncError: String(message || "External workflow synchronization failed")
      .trim()
      .slice(0, 4000),
  };
}

function markInteractiveRequired(
  taskPath,
  execution,
  message,
  metrics,
  externalEvidence,
) {
  setTaskError(
    taskPath,
    "interactive_required",
    null,
    message,
    metrics,
    externalEvidence,
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

function readTokenUsage(eventsFile) {
  const total = emptyTokenUsage();
  if (!existsSync(eventsFile)) return total;

  for (const line of readFileSync(eventsFile, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "turn.completed" || !event.usage) continue;
    total.turns += 1;
    total.inputTokens += Number(event.usage.input_tokens) || 0;
    total.cachedInputTokens += Number(event.usage.cached_input_tokens) || 0;
    total.outputTokens += Number(event.usage.output_tokens) || 0;
    total.reasoningOutputTokens +=
      Number(event.usage.reasoning_output_tokens) || 0;
  }

  total.available = total.turns > 0;
  total.totalTokens = total.inputTokens + total.outputTokens;
  return total;
}

async function executeTask(taskPath, claim, workerId, config) {
  const task = readTask(taskPath);
  const previousMetrics = task.metadata.metrics || null;
  const execution =
    task.metadata.execution || resolveTaskExecution(config, {});
  const attemptDir = path.join(
    todoDir(repoRoot),
    "logs",
    task.id,
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(attemptDir, { recursive: true });
  const stdoutPath = path.join(attemptDir, "stdout.log");
  const stderrPath = path.join(attemptDir, "stderr.log");
  const resultPath = path.join(attemptDir, "result.json");
  const usagePath = path.join(attemptDir, "usage.json");
  const promptPath = path.join(attemptDir, "prompt.txt");
  const executionPrompt = buildPrompt(task);
  writeFileSync(promptPath, `${executionPrompt}\n`, "utf8");
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
    repoRoot,
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
    attempt: (Number(previousMetrics?.attempts) || 0) + 1,
    attemptTokenUsage: emptyTokenUsage(),
    cumulativeTokenUsage:
      previousMetrics?.tokenUsage || emptyTokenUsage(),
    usagePath: path.relative(repoRoot, usagePath),
    promptPath: path.relative(repoRoot, promptPath),
  });
  atomicWriteJson(usagePath, {
    status: "running",
    attempts: (Number(previousMetrics?.attempts) || 0) + 1,
    startedAt:
      previousMetrics?.startedAt || new Date(startedAt).toISOString(),
    completedAt: null,
    durationMs: Number(previousMetrics?.durationMs) || 0,
    durationSeconds: Number(previousMetrics?.durationSeconds) || 0,
    durationMinutes: Number(previousMetrics?.durationMinutes) || 0,
    durationHuman:
      previousMetrics?.durationHuman || "00d 00h 00m 00s",
    currentRun: {
      startedAt: new Date(startedAt).toISOString(),
      completedAt: null,
    },
    source: "codex exec --json turn.completed",
    eventsFile: path.basename(stdoutPath),
    promptFile: path.basename(promptPath),
    tokenUsage: emptyTokenUsage(),
  });
  let child;
  let exitCode = null;
  let spawnError = null;
  let tokenUsage = emptyTokenUsage();
  let metrics = null;

  try {
    child = spawn(config.codexCommand, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        TODO_RUNNER_WORKER: "1",
        TODO_RUNNER_REPO_ROOT: repoRoot,
      },
      stdio: ["pipe", stdoutFd, stderrFd],
    });
    active.get(task.id).child = child;
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
    tokenUsage = readTokenUsage(stdoutPath);
    metrics = cumulativeTaskMetrics(
      previousMetrics,
      taskMetrics(startedAt, Date.now(), tokenUsage),
    );
  }

  try {
    if (spawnError) {
      setTaskError(
        taskPath,
        "codex_spawn",
        null,
        spawnError.message,
        metrics,
        externalFailureEvidence(task, spawnError.message),
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
        externalFailureEvidence(task, message),
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
        externalFailureEvidence(task, error.message),
      );
      return;
    }
    let externalOutcome;
    try {
      const externalResult =
        result.requiresInteractive === true &&
        (task.metadata.externalWorkflows || []).length > 0 &&
        !result.externalSyncError
          ? {
              ...result,
              externalSyncError: result.interactiveReason,
            }
          : result;
      externalOutcome = normalizeExternalTaskOutcome(
        task.metadata.externalWorkflows || [],
        externalResult,
      );
    } catch (error) {
      setTaskError(
        taskPath,
        "external_sync",
        exitCode,
        error.message,
        metrics,
        externalFailureEvidence(task, error.message),
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
          externalOutcome,
        );
        return;
      }
      setTaskError(
        taskPath,
        "agent_reported_failure",
        exitCode,
        result.error || result.summary,
        metrics,
        externalOutcome,
      );
      return;
    }
    completeTask(
      repoRoot,
      taskPath,
      { ...result, externalSync: externalOutcome.externalSync },
      metrics,
    );
  } catch (error) {
    setTaskError(
      taskPath,
      "runner",
      exitCode,
      error.message,
      metrics,
      externalFailureEvidence(task, error.message),
    );
  } finally {
    releaseClaim(claim);
    active.delete(task.id);
    const status = getTaskStatus(repoRoot, task.id).status;
    try {
      atomicWriteJson(usagePath, {
        status,
        ...metrics,
        source: "codex exec --json turn.completed",
        eventsFile: path.basename(stdoutPath),
        promptFile: path.basename(promptPath),
      });
    } catch (error) {
      log("usage_log_error", { task: task.id, error: error.message });
    }
    log("task_end", {
      task: task.id,
      status,
      ...metrics,
      usagePath: path.relative(repoRoot, usagePath),
    });
    writeState();
  }
}

function startReadyTasks(config) {
  for (const taskPath of listTaskFiles(repoRoot)) {
    if (active.size >= config.workers) return;
    const id = taskIdFromFilename(path.basename(taskPath));
    if (active.has(id)) continue;
    let status = getTaskStatus(repoRoot, id);
    if (status.execution?.mode === "interactive") continue;
    if (status.status === "failed" && canAutoRetry(config, status.metrics)) {
      try {
        const failedAttempts = status.metrics.attempts;
        retryTask(repoRoot, id);
        log("task_auto_retry", {
          task: id,
          retry: failedAttempts,
          retries: config.retries,
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
      workerId,
      taskId: id,
      taskTitle: status.title,
    });
    writeState();
    executeTask(taskPath, claim, workerId, config).catch((error) => {
      setTaskError(taskPath, "runner_unhandled", null, error.message);
      releaseClaim(claim);
      active.delete(id);
      log("task_unhandled_error", { task: id, error: error.message });
    });
  }
}

function consumeAuthorizedStopRequest() {
  const requestPath = daemonStopRequestPath(repoRoot);
  if (!existsSync(requestPath)) return false;
  try {
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    if (request?.pid !== process.pid || request?.token !== daemonToken) {
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
  for (const entry of active.values()) {
    if (entry.child && !entry.child.killed) entry.child.kill();
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const entry of active.values()) releaseClaim(entry.claim);
  if (dashboard) {
    const server = dashboard.server;
    dashboard = null;
    await closeDashboard(server);
  }
  writeState("stopped");
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
try {
  dashboard = await startDashboard(repoRoot, runtimeConfig.dashboardPort);
} catch (error) {
  if (runtimeConfig.dashboardPort === 0) throw error;
  log("dashboard_port_fallback", {
    requestedPort: runtimeConfig.dashboardPort,
    error: error.message,
  });
  dashboard = await startDashboard(repoRoot, 0);
}
watchDashboardErrors(dashboard);
log("daemon_start", { repoRoot, dashboardUrl: dashboard.url });
cleanupStaleClaims(repoRoot);
writeState();

let nextTaskPollAt = Date.now();
let nextConfigReloadAt =
  Date.now() + runtimeConfig.configReloadIntervalMs;
while (!stopping) {
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

  const now = Date.now();
  if (now >= nextConfigReloadAt) {
    const changed = await reloadRuntimeConfig();
    nextConfigReloadAt =
      Date.now() + runtimeConfig.configReloadIntervalMs;
    if (changed.length > 0) nextTaskPollAt = Date.now();
  }

  if (Date.now() >= nextTaskPollAt) {
    cleanupStaleClaims(repoRoot);
    startReadyTasks(runtimeConfig);
    writeState();
    nextTaskPollAt = Date.now() + runtimeConfig.pollIntervalMs;
  }

  const sleepUntil = Math.min(nextTaskPollAt, nextConfigReloadAt);
  const sleepMs = Math.max(10, sleepUntil - Date.now());
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}
