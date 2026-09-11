import { withRepositoryExecution, reserveSingleBranch, checkpointSingleBranch, singleBranchIdentity,
  singleBranchPlan, prepareSingleBranch, commitSingleBranch, singleBranchFiles, singleBranchInstructions, activeSingleBranchExecutors, verifySingleBranchDelivery, assertSingleBranchCancellation, recoverSingleBranchHead } from "./single-branch.mjs";
import { DEFAULT_MODEL_PROFILES, readModelCatalog, profileDiagnostic, profileUsable, assertProfilesAvailable } from "./model-profiles.mjs";
import { runShellCommand } from "./shell-step.mjs";
import { recoverUsageRuns, combineUsage } from "./usage-recovery.mjs";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ensureRepoRoutingPolicy } from "./routing-policy.mjs";
import {
  appendDeliveryAttempt,
  appendModelAttempt,
  classifyFailure,
  createAttemptLedger,
} from "./attempt-ledger.mjs";
import {
  cleanupTaskWorktree,
  commitTaskWorktree,
  continueQueuedTaskRebase,
  deliverTaskWorktree,
  mergeQueuedTaskWorktree,
  prepareTaskWorktree,
  queueTaskWorktreeForMerge,
  taskBranchName,
  taskWorktreePlan,
  verifyTaskWorktreeHead,
} from "./git-worktree.mjs";
import {
  loadPipelineSnapshot,
  loadConfiguredPipeline,
  storePipelineSnapshot,
} from "./pipeline.mjs";

export const DEFAULT_WORKERS = 4;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_CONFIG_RELOAD_INTERVAL_MS = 5000;
export const DEFAULT_DASHBOARD_PORT = 0;
export const DEFAULT_RETRIES = 0;
export const DAEMON_IMPLEMENTATION = "todo";
export const DAEMON_PROTOCOL_VERSION = 2;
export { DEFAULT_MODEL_PROFILES } from "./model-profiles.mjs";
export const DEFAULT_MODEL_PROFILE = "expert";
export const DEFAULT_ROUTING_MODE = "all-mutations";
export const DEFAULT_EXECUTION_BACKEND = "app-server";
export const DEFAULT_GIT_DELIVERY = "keep";
export const DEFAULT_GIT_REMOTE = "origin";
export const DEFAULT_CONFIG = {
  workers: DEFAULT_WORKERS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  configReloadIntervalMs: DEFAULT_CONFIG_RELOAD_INTERVAL_MS,
  dashboardPort: DEFAULT_DASHBOARD_PORT,
  retries: DEFAULT_RETRIES,
  executionBackend: DEFAULT_EXECUTION_BACKEND,
  gitExclude: [".todo/"],
  defaultModelProfile: DEFAULT_MODEL_PROFILE,
  routingMode: DEFAULT_ROUTING_MODE,
  git: {
    executionMode: "worktree",
    delivery: DEFAULT_GIT_DELIVERY,
    targetBranch: null,
    remote: DEFAULT_GIT_REMOTE,
    push: false,
  },
};
export const TASK_NAME_PATTERN =
  /^[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const HEADER_PATTERN = /^<!-- TODO (\{.*\}) -->$/;
const MODEL_PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_RUN_MODES = new Set(["background", "interactive"]);
const TASK_GIT_DELIVERIES = new Set(["keep", "merge", "pr"]);
const CONFIG_GIT_DELIVERIES = new Set(["keep", "merge"]);
const TASK_GIT_PHASES = new Set([
  "queued",
  "working",
  "model-completed",
  "committing",
  "committed",
  "merge-queued",
  "merge-conflict",
  "merge-failed",
  "delivered",
]);
const TASK_GIT_FINALIZER_PHASES = new Set([
  "model-completed",
  "committing",
  "committed",
  "merge-queued",
  "delivered",
]);
const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const ARTIFACTS_START = "<!-- TODO ARTIFACTS START -->";
const ARTIFACTS_END = "<!-- TODO ARTIFACTS END -->";
const MAX_ARTIFACTS_PER_TASK = 64;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/webp", ".webp"],
  ["application/json", ".json"],
  ["application/pdf", ".pdf"],
  ["text/markdown", ".md"],
  ["text/plain", ".txt"],
]);
const EXTENSION_MIME_TYPES = new Map(
  [...MIME_EXTENSIONS].map(([mimeType, extension]) => [extension, mimeType]),
);

export function findGitRoot(startPath = process.cwd()) {
  const result = spawnSync(
    "git",
    ["-C", path.resolve(startPath), "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return root ? path.resolve(root) : null;
}

export function currentGitBranch(repoRoot) {
  const result = spawnSync(
    "git",
    ["-C", path.resolve(repoRoot), "symbolic-ref", "--quiet", "--short", "HEAD"],
    { encoding: "utf8" },
  );
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch || null;
}

function assertExistingLocalBranch(repoRoot, branch) {
  const valid = spawnSync(
    "git",
    ["-C", path.resolve(repoRoot), "check-ref-format", "--branch", branch],
    { encoding: "utf8" },
  );
  const exists =
    valid.status === 0
      ? spawnSync(
          "git",
          [
            "-C",
            path.resolve(repoRoot),
            "rev-parse",
            "--verify",
            "--end-of-options",
            `refs/heads/${branch}^{commit}`,
          ],
          { encoding: "utf8" },
        )
      : null;
  if (valid.status !== 0 || exists?.status !== 0) {
    throw new Error(`Git target branch is not an existing local branch: ${branch}`);
  }
}

export function todoDir(repoRoot) {
  return path.join(repoRoot, ".todo");
}

export function supervisorConfigPath(repoRoot) {
  return path.join(todoDir(repoRoot), "supervisor.json");
}

export function dashboardThreadRequestPath(repoRoot) {
  return path.join(todoDir(repoRoot), "dashboard-thread.json");
}

export function normalizeDashboardThreadId(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error("dashboard thread ID is required");
    return null;
  }
  const threadId = String(value).trim();
  if (!threadId || threadId.length > 200 || /[\r\n]/.test(threadId)) {
    throw new Error("dashboard thread ID must be a single-line string");
  }
  return threadId;
}

export function requestDashboardThread(repoRoot, value) {
  const threadId = normalizeDashboardThreadId(value, { required: true });
  atomicWriteJson(dashboardThreadRequestPath(repoRoot), {
    schemaVersion: 1,
    threadId,
    updatedAt: new Date().toISOString(),
  });
  return threadId;
}

export function readDashboardThreadRequest(repoRoot) {
  const file = dashboardThreadRequestPath(repoRoot);
  if (!existsSync(file)) return null;
  try {
    const value = readJson(file);
    return {
      threadId: normalizeDashboardThreadId(value.threadId, { required: true }),
      updatedAt:
        typeof value.updatedAt === "string" &&
        Number.isFinite(Date.parse(value.updatedAt))
          ? new Date(value.updatedAt).toISOString()
          : null,
    };
  } catch {
    return null;
  }
}

export function taskBatchLockPath(repoRoot) {
  return path.join(todoDir(repoRoot), ".task-batch.lock");
}

export function taskBatchPublicationActive(repoRoot) {
  const lockPath = taskBatchLockPath(repoRoot);
  if (!existsSync(lockPath)) return false;
  try {
    const lock = readJson(lockPath);
    if (Number.isInteger(lock.pid) && !processIsAlive(lock.pid)) {
      unlinkSync(lockPath);
      return false;
    }
  } catch {
    // An unrecognized lock is preserved instead of risking partial publication.
  }
  return true;
}

export function acquireTaskBatchGate(repoRoot, details) {
  const lockPath = taskBatchLockPath(repoRoot);
  if (taskBatchPublicationActive(repoRoot)) {
    const error = new Error("task batch publication is active");
    error.code = "EEXIST";
    error.kind = "task_batch_active";
    throw error;
  }
  const token = randomUUID();
  let fd;
  let created = false;
  try {
    fd = openSync(lockPath, "wx");
    created = true;
    writeFileSync(
      fd,
      `${JSON.stringify({
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...details,
      })}\n`,
      "utf8",
    );
    closeSync(fd);
    fd = undefined;
    return { lockPath, token };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created && existsSync(lockPath)) unlinkSync(lockPath);
    throw error;
  }
}

export function releaseTaskBatchGate(gate) {
  if (!gate || !existsSync(gate.lockPath)) return;
  try {
    if (readJson(gate.lockPath).token === gate.token) unlinkSync(gate.lockPath);
  } catch {
    // Never remove a gate whose ownership cannot be verified.
  }
}

export function configPath(repoRoot) {
  return path.join(todoDir(repoRoot), "config.json");
}

export function isActivated(repoRoot) {
  return existsSync(configPath(repoRoot));
}

export function ensureLayout(repoRoot) {
  const root = todoDir(repoRoot);
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  mkdirSync(path.join(root, "history"), { recursive: true });
  mkdirSync(path.join(root, "logs"), { recursive: true });
  mkdirSync(path.join(root, "pipelines"), { recursive: true });
  return root;
}

export function initializeRepo(repoRoot) {
  const file = configPath(repoRoot);
  const created = !existsSync(file);
  ensureLayout(repoRoot);
  if (created) atomicWriteJson(file, DEFAULT_CONFIG);
  const config = loadConfig(repoRoot);
  return {
    repoRoot,
    configPath: file,
    created,
    addedExcludes: applyGitExcludes(repoRoot, config.gitExclude),
    routingPolicy: ensureRepoRoutingPolicy(repoRoot),
    config,
  };
}

function integerInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function normalizeModelProfiles(value) {
  if (value === undefined) return { profiles: DEFAULT_MODEL_PROFILES, warning: null };
  if (!Array.isArray(value) || value.length === 0) {
    return { profiles: [], warning: "Custom model profiles are invalid or outdated: models must be a non-empty array. Inspect model_profiles to review an update." };
  }
  const profiles = [];
  const names = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        profiles: [],
        warning: "models must contain profile objects",
      };
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const reasoningEffort =
      typeof item.reasoningEffort === "string"
        ? item.reasoningEffort.trim()
        : "";
    const description =
      typeof item.description === "string" ? item.description.trim() : "";
    if (
      !MODEL_PROFILE_NAME_PATTERN.test(name) ||
      names.has(name) ||
      !model ||
      !REASONING_EFFORTS.has(reasoningEffort)
    ) {
      return {
        profiles: [],
        warning:
          "models require unique kebab-case names, a model, and a valid reasoningEffort",
      };
    }
    names.add(name);
    profiles.push({
      name,
      model,
      reasoningEffort,
      ...(description ? { description } : {}),
    });
  }
  return { profiles, warning: null };
}

export function loadConfig(repoRoot) {
  const file = configPath(repoRoot);
  if (!existsSync(file)) {
    return {
      activated: false,
      workers: DEFAULT_WORKERS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      configReloadIntervalMs: DEFAULT_CONFIG_RELOAD_INTERVAL_MS,
      dashboardPort: DEFAULT_DASHBOARD_PORT,
      retries: DEFAULT_RETRIES,
      executionBackend: DEFAULT_EXECUTION_BACKEND,
      gitExclude: [],
      codexCommand: "codex",
      codexSandbox: "workspace-write",
      modelProfiles: DEFAULT_MODEL_PROFILES,
      defaultModelProfile: DEFAULT_MODEL_PROFILE,
      routingMode: DEFAULT_ROUTING_MODE,
      git: { ...DEFAULT_CONFIG.git },
      pipeline: null,
      warning: null,
      readError: null,
    };
  }

  let raw = {};
  let warning = null;
  let readError = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("root value must be an object");
    }
  } catch (error) {
    readError = `Could not read ${file}: ${error.message}`;
    warning = readError;
    raw = {};
  }

  const gitExclude = Array.isArray(raw.gitExclude)
    ? raw.gitExclude.filter(
        (item) =>
          typeof item === "string" &&
          item.trim().length > 0 &&
          !item.includes("\n") &&
          !item.includes("\r"),
      )
    : [];
  const sandboxes = new Set([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
  const executionBackend = DEFAULT_EXECUTION_BACKEND;
  if (raw.executionBackend !== undefined && !["app-server", "exec"].includes(raw.executionBackend)) {
    warning = warning ? `${warning}; executionBackend must be app-server` : "executionBackend must be app-server";
  }
  const normalizedProfiles = normalizeModelProfiles(raw.models);
  if (normalizedProfiles.warning) {
    warning = warning ? `${warning}; ${normalizedProfiles.warning}` : normalizedProfiles.warning;
    readError = `Invalid custom model profiles: ${normalizedProfiles.warning}. Use model_profiles to inspect and update; no fallback model was selected.`;
  }
  const configuredDefault =
    typeof raw.defaultModelProfile === "string"
      ? raw.defaultModelProfile.trim()
      : DEFAULT_MODEL_PROFILE;
  const defaultModelProfile = normalizedProfiles.profiles.some(
    (profile) => profile.name === configuredDefault,
  )
    ? configuredDefault
    : normalizedProfiles.profiles[0]?.name || null;
  if (configuredDefault && configuredDefault !== defaultModelProfile) {
    readError = `Custom default profile ${configuredDefault} is missing or outdated. Inspect model_profiles to review an update; no fallback was selected.`
    warning = warning
      ? `${warning}; defaultModelProfile is not present in models`
      : "defaultModelProfile is not present in models";
  }
  let pipeline = null;
  if (!readError) {
    try {
      pipeline = loadConfiguredPipeline(
        repoRoot,
        raw.pipeline,
        normalizedProfiles.profiles,
      );
    } catch (error) {
      readError = `Could not load pipeline: ${error.message}`;
      warning = readError;
    }
  }
  const retries =
    Number.isInteger(raw.retries) && raw.retries >= -1
      ? raw.retries
      : DEFAULT_RETRIES;
  if (raw.retries !== undefined && raw.retries !== retries) {
    warning = warning
      ? `${warning}; retries must be -1 or a non-negative integer`
      : "retries must be -1 or a non-negative integer";
  }
  const routingMode = DEFAULT_ROUTING_MODE;
  if (
    raw.routingMode !== undefined &&
    raw.routingMode !== DEFAULT_ROUTING_MODE
  ) {
    warning = warning
      ? `${warning}; routingMode must be ${DEFAULT_ROUTING_MODE}`
      : `routingMode must be ${DEFAULT_ROUTING_MODE}`;
  }
  const rawGit =
    raw.git && typeof raw.git === "object" && !Array.isArray(raw.git)
      ? raw.git
      : {};
  const executionMode = rawGit.executionMode ?? "worktree";
  if (!["worktree", "single-branch"].includes(executionMode)) {
    readError = "git.executionMode must be worktree or single-branch";
    warning = warning ? `${warning}; ${readError}` : readError;
  }
  if (executionMode === "single-branch" && rawGit.push === true) {
    readError = "git.push is unsupported in single-branch; completion commits locally in the current branch";
    warning = warning ? `${warning}; ${readError}` : readError;
  }
  const gitDelivery = CONFIG_GIT_DELIVERIES.has(rawGit.delivery)
    ? rawGit.delivery
    : DEFAULT_GIT_DELIVERY;
  if (rawGit.delivery !== undefined && rawGit.delivery !== gitDelivery) {
    warning = warning
      ? `${warning}; git.delivery must be keep or merge`
      : "git.delivery must be keep or merge";
  }
  const targetBranch =
    typeof rawGit.targetBranch === "string" &&
    rawGit.targetBranch.trim() &&
    !/[\r\n]/.test(rawGit.targetBranch)
      ? rawGit.targetBranch.trim()
      : null;
  if (rawGit.targetBranch !== undefined && !targetBranch) {
    warning = warning
      ? `${warning}; git.targetBranch must be a non-empty branch name`
      : "git.targetBranch must be a non-empty branch name";
  }
  const remote =
    typeof rawGit.remote === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(rawGit.remote.trim())
      ? rawGit.remote.trim()
      : DEFAULT_GIT_REMOTE;
  if (rawGit.remote !== undefined && rawGit.remote !== remote) {
    warning = warning
      ? `${warning}; git.remote is invalid`
      : "git.remote is invalid";
    if (rawGit.push === true) readError = "git.remote is invalid; refusing to select a fallback push remote";
  }
  if (rawGit.push !== undefined && typeof rawGit.push !== "boolean") {
    readError = "git.push must be a boolean";
    warning = warning ? `${warning}; ${readError}` : readError;
  }

  return {
    activated: true,
    workers: executionMode === "single-branch" ? 1 : integerInRange(raw.workers, 1, 32, DEFAULT_WORKERS),
    pollIntervalMs: integerInRange(
      raw.pollIntervalMs,
      250,
      60000,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    configReloadIntervalMs: integerInRange(
      raw.configReloadIntervalMs,
      250,
      60000,
      DEFAULT_CONFIG_RELOAD_INTERVAL_MS,
    ),
    dashboardPort: integerInRange(
      raw.dashboardPort,
      0,
      65535,
      DEFAULT_DASHBOARD_PORT,
    ),
    retries,
    executionBackend,
    gitExclude,
    codexCommand:
      typeof raw.codexCommand === "string" && raw.codexCommand.trim()
        ? raw.codexCommand.trim()
        : "codex",
    codexSandbox: sandboxes.has(raw.codexSandbox)
      ? raw.codexSandbox
      : "workspace-write",
    modelCatalog: readModelCatalog(repoRoot, typeof raw.codexCommand === "string" && raw.codexCommand.trim() ? raw.codexCommand.trim() : "codex"),
    modelDiagnostics: normalizedProfiles.profiles.map(profile => profileDiagnostic(profile,
      readModelCatalog(repoRoot, typeof raw.codexCommand === "string" && raw.codexCommand.trim() ? raw.codexCommand.trim() : "codex"))),
    modelProfiles: normalizedProfiles.profiles,
    defaultModelProfile,
    routingMode,
    git: { executionMode, delivery: gitDelivery, targetBranch: executionMode === "single-branch" ? null : targetBranch, remote, push: rawGit.push === true },
    pipeline,
    warning,
    readError,
  };
}

export function emptyTokenUsage() {
  return {
    available: false,
    coverage: "none",
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    visibleOutputTokens: 0,
    totalTokens: 0,
  };
}

function normalizedTokenUsage(value) {
  if (!value || typeof value !== "object" || value.available !== true) {
    return emptyTokenUsage();
  }
  const inputTokens = Math.max(0, Number(value.inputTokens) || 0);
  const cachedInputTokens = Math.max(
    0,
    Number(value.cachedInputTokens) || 0,
  );
  const outputTokens = Math.max(0, Number(value.outputTokens) || 0);
  const reasoningOutputTokens = Math.max(
    0,
    Number(value.reasoningOutputTokens) || 0,
  );
  return {
    available: true,
    coverage: ["full", "partial", "unknown"].includes(value.coverage)
      ? value.coverage
      : "unknown",
    turns: Math.max(0, Number(value.turns) || 0),
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cacheWriteInputTokens: Math.max(
      0,
      Number(value.cacheWriteInputTokens) || 0,
    ),
    outputTokens,
    reasoningOutputTokens,
    visibleOutputTokens: Math.max(0, outputTokens - reasoningOutputTokens),
    totalTokens: inputTokens + outputTokens,
  };
}

function durationFields(durationMs) {
  const normalized = Math.max(0, Number(durationMs) || 0);
  const totalSeconds = Math.round(normalized / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const padded = (value) => String(value).padStart(2, "0");
  return {
    durationMs: normalized,
    durationSeconds: Number((normalized / 1000).toFixed(3)),
    durationMinutes: Number((normalized / 60000).toFixed(3)),
    durationHuman: `${padded(days)}d ${padded(hours)}h ${padded(minutes)}m ${padded(seconds)}s`,
  };
}

export function taskMetrics(startedAt, completedAt, tokenUsage) {
  return {
    tokenAccountingVersion: 2,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    ...durationFields(Math.max(0, completedAt - startedAt)),
    tokenUsage: normalizedTokenUsage(tokenUsage),
  };
}

function normalizedMetricRun(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const completedMs = Date.parse(run.completedAt);
  const durationMs = Math.max(0, Number(run.durationMs) || 0);
  const startedMs = Date.parse(run.startedAt);
  const resolvedStartedMs = Number.isFinite(startedMs)
    ? startedMs
    : Number.isFinite(completedMs)
      ? completedMs - durationMs
      : Number.NaN;
  if (!Number.isFinite(resolvedStartedMs) || !Number.isFinite(completedMs)) {
    return null;
  }
  return {
    ...(run.tokenAccountingVersion === 2 ? { tokenAccountingVersion: 2 } : {}),
    startedAt: new Date(resolvedStartedMs).toISOString(),
    completedAt: new Date(completedMs).toISOString(),
    ...durationFields(durationMs),
    tokenUsage: normalizedTokenUsage(run.tokenUsage),
    ...(typeof run.attemptId === "string" ? { attemptId: run.attemptId } : {}),
    ...(typeof run.usagePath === "string" ? { usagePath: run.usagePath } : {}),
    ...(run.legacyAggregate === true ? { legacyAggregate: true } : {}),
  };
}

export function metricRuns(metrics) {
  if (!metrics || typeof metrics !== "object") return [];
  if (Array.isArray(metrics.runs) && metrics.runs.length > 0) {
    return metrics.runs.map(normalizedMetricRun).filter(Boolean);
  }
  const completedMs = Date.parse(metrics.completedAt);
  const durationMs = Math.max(0, Number(metrics.durationMs) || 0);
  if (!Number.isFinite(completedMs)) return [];
  return [
    {
      startedAt: new Date(completedMs - durationMs).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
      ...durationFields(durationMs),
      tokenUsage: normalizedTokenUsage(metrics.tokenUsage),
      legacyAggregate: true,
    },
  ];
}

export function cumulativeTaskMetrics(previous, attempt) {
  const normalizedAttempt = normalizedMetricRun(attempt);
  if (!normalizedAttempt) throw new Error("invalid task run metrics");
  const previousRuns = metricRuns(previous);
  const previousUsage = normalizedTokenUsage(previous?.tokenUsage);
  const attemptUsage = normalizedAttempt.tokenUsage;
  const measuredRuns =
    previousRuns.filter((run) => run.tokenUsage.available).length +
    (attemptUsage.available ? 1 : 0);
  const totalRuns = previousRuns.length + 1;
  const tokenUsage = {
    available: measuredRuns > 0,
    coverage:
      measuredRuns === 0
        ? "none"
        : measuredRuns === totalRuns &&
            previousRuns.every((run) => run.tokenUsage.coverage === "full") &&
            attemptUsage.coverage === "full"
          ? "full"
          : "partial",
    turns:
      (Number(previousUsage.turns) || 0) +
      (Number(attemptUsage.turns) || 0),
    inputTokens:
      (Number(previousUsage.inputTokens) || 0) +
      (Number(attemptUsage.inputTokens) || 0),
    cachedInputTokens:
      (Number(previousUsage.cachedInputTokens) || 0) +
      (Number(attemptUsage.cachedInputTokens) || 0),
    uncachedInputTokens: 0,
    cacheWriteInputTokens:
      (Number(previousUsage.cacheWriteInputTokens) || 0) +
      (Number(attemptUsage.cacheWriteInputTokens) || 0),
    outputTokens:
      (Number(previousUsage.outputTokens) || 0) +
      (Number(attemptUsage.outputTokens) || 0),
    reasoningOutputTokens:
      (Number(previousUsage.reasoningOutputTokens) || 0) +
      (Number(attemptUsage.reasoningOutputTokens) || 0),
    visibleOutputTokens: 0,
    totalTokens: 0,
  };
  tokenUsage.uncachedInputTokens = Math.max(
    0,
    tokenUsage.inputTokens - tokenUsage.cachedInputTokens,
  );
  tokenUsage.visibleOutputTokens = Math.max(
    0,
    tokenUsage.outputTokens - tokenUsage.reasoningOutputTokens,
  );
  tokenUsage.totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;
  const runs = [...previousRuns, normalizedAttempt];
  const durationMs = runs.reduce(
    (total, run) => total + run.durationMs,
    0,
  );
  return {
    attempts: (Number(previous?.attempts) || 0) + 1,
    startedAt:
      previous?.startedAt ||
      runs[0]?.startedAt ||
      normalizedAttempt.startedAt,
    completedAt: normalizedAttempt.completedAt,
    ...durationFields(durationMs),
    tokenUsage,
    lastRun: normalizedAttempt,
    runs,
  };
}

export function recoveredTaskMetrics(repoRoot, taskId, metrics) {
  if (!metrics) return null;
  const runs = metricRuns(metrics);
  const recovered = recoverUsageRuns(repoRoot, taskId, runs);
  if (recovered === runs || recovered.every((run, index) => run.tokenUsage === runs[index]?.tokenUsage)) return metrics;
  return { ...metrics, runs: recovered, lastRun: recovered.at(-1), tokenUsage: combineUsage(recovered.map((run) => run.tokenUsage)) };
}

export function canAutoRetry(config, taskStatus) {
  const ledger = taskStatus?.attemptLedger;
  const repair = taskStatus?.git?.mergeConflict;
  const finalizerOnly = TASK_GIT_FINALIZER_PHASES.has(taskStatus?.git?.phase) ||
    (taskStatus?.git?.phase === "merge-failed" && !repair);
  const attempts = repair ? (ledger?.attempts || []).filter(attempt =>
    attempt.trigger === (repair.kind === "pipeline_validation" ? "merge_validation" : "merge_conflict")) : finalizerOnly
    ? ledger?.deliveryAttempts || []
    : ledger?.attempts || [];
  const last = attempts.at?.(-1);
  const retries = Math.max(0, attempts.length - 1);
  return (
    last?.status === "failed_transient" &&
    (config.retries === -1 || retries < config.retries)
  );
}

function storedAttemptLedger(task) {
  const ledger = task?.metadata?.attemptLedger;
  if (
    ledger &&
    Array.isArray(ledger.attempts) &&
    Array.isArray(ledger.deliveryAttempts)
  ) {
    return ledger;
  }
  const runs = metricRuns(task?.metadata?.metrics);
  if (runs.length === 0) return createAttemptLedger();
  let migrated = createAttemptLedger();
  for (const [index, run] of runs.entries()) {
    const last = index === runs.length - 1;
    const failure =
      last && task.metadata.nextAttemptTrigger !== "automatic_retry"
        ? task.metadata.error
          ? classifyFailure({
              errorKind: task.metadata.error.kind,
              code: task.metadata.error.exit_code,
              message: task.metadata.error.message,
            })
          : { status: "failed_permanent", errorKind: "legacy_retry" }
        : { status: "failed_transient", errorKind: "legacy_retry" };
    const digest = createHash("sha256")
      .update(`${task.id}:legacy-attempt:${index + 1}`)
      .digest("hex");
    const attemptId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    migrated = appendModelAttempt(migrated, {
      attemptId,
      trigger: index === 0 ? "initial" : "manual_retry",
      status: failure.status,
      errorKind: failure.errorKind,
      timing: {
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
      },
      tokenUsage: run.tokenUsage,
      usagePath: run.usagePath || null,
    });
  }
  return migrated;
}

function nextAttemptTrigger(task) {
  if (["head_recovery", "workspace_refresh"].includes(task.metadata.nextAttemptTrigger)) return task.metadata.nextAttemptTrigger;
  const attempts = storedAttemptLedger(task).attempts;
  if (attempts.length === 0) return "initial";
  if (task.metadata.git?.phase === "merge-conflict") return task.metadata.git.mergeConflict?.kind === "pipeline_validation" ? "merge_validation" : "merge_conflict";
  return task.metadata.nextAttemptTrigger === "automatic_retry"
    ? "automatic_retry"
    : "manual_retry";
}

function appendClaimedAttempt(task, claim, status, errorKind, metrics, usagePath) {
  if (!claim?.attemptId) return storedAttemptLedger(task);
  const run = metrics?.lastRun;
  if (!run) throw new Error("attempt metrics are missing");
  return appendModelAttempt(storedAttemptLedger(task), {
    attemptId: claim.attemptId,
    trigger: claim.trigger,
    status,
    errorKind: status === "completed" ? null : errorKind,
    timing: {
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
    },
    tokenUsage: run.tokenUsage,
    usagePath: usagePath || null,
  });
}

function completedPipelineContinuation(task) {
  const continuation = task.metadata.pipelineContinuation;
  const previous = storedAttemptLedger(task).attempts.at(-1);
  return Boolean(task.metadata.pipeline && continuation?.ready &&
    continuation.result?.status === "completed" &&
    continuation.digest === task.metadata.pipeline.digest && previous?.status === "completed" &&
    (!continuation.attemptId || continuation.attemptId === previous.attemptId));
}

export function beginPipelineContinuation(taskPath, claim) {
  const current = claim?.lockPath ? readJson(claim.lockPath) : null;
  if (!current || !claim.token || current.token !== claim.token) {
    throw new Error("Task claim is no longer owned by this worker");
  }
  const task = readTask(taskPath);
  if (current.attemptId || !completedPipelineContinuation(task)) {
    throw new Error("Pipeline continuation requires a completed implementation and a ready checkpoint");
  }
  const continuationOf = storedAttemptLedger(task).attempts.at(-1).attemptId;
  atomicWriteJson(claim.lockPath, { ...current, continuationOf });
  Object.assign(claim, { continuationOf });
  return claim;
}

export function resolveTaskExecution(
  config,
  { backend, modelProfile, ephemeral, runMode } = {},
) {
  if (config.readError) throw new Error(config.readError);
  const requestedProfile =
    typeof modelProfile === "string" && modelProfile.trim()
      ? modelProfile.trim()
      : config.defaultModelProfile;
  const profile = config.modelProfiles.find(
    (candidate) => candidate.name === requestedProfile,
  );
  if (!profile) {
    throw new Error(
      `Unknown modelProfile: ${requestedProfile}; available: ${config.modelProfiles
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }
  assertProfilesAvailable([profile], config.modelCatalog);
  if (ephemeral !== undefined && typeof ephemeral !== "boolean") {
    throw new Error("ephemeral must be a boolean");
  }
  if (runMode !== undefined && !TASK_RUN_MODES.has(runMode)) {
    throw new Error("runMode must be background or interactive");
  }
  if (backend !== undefined && !["app-server", "exec"].includes(backend)) {
    throw new Error("backend must be app-server or exec");
  }
  return {
    backend: "app-server", // Legacy exec snapshots migrate at the next attempt.
    modelProfile: profile.name,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    ephemeral: ephemeral === true,
    mode: runMode || "background",
  };
}

// Saved models are execution history; the stable profile name selects the model
// for each new attempt. Preserve the task's backend and interaction mode.
export function resolveSavedExecution(config, saved = {}) {
  return resolveTaskExecution(config, {
    backend: saved.backend,
    modelProfile: saved.modelProfile,
    ephemeral: saved.ephemeral,
    runMode: saved.mode,
  });
}

export function resolvePipelineProfiles(config, pipeline, baseExecution) {
  const resolveStep = step => {
    if (!step || step.type === "shell") return step;
    const execution = resolveSavedExecution(config, {
      ...baseExecution,
      modelProfile: step.modelProfile || baseExecution.modelProfile,
    });
    return { ...step, modelProfile: execution.modelProfile,
      model: execution.model, reasoningEffort: execution.reasoningEffort };
  };
  return { ...pipeline, steps: pipeline.steps.map(resolveStep), repair: resolveStep(pipeline.repair) };
}

function escalatedExecution(config, current) {
  current = resolveSavedExecution({ ...config, modelCatalog: null }, current);
  const currentIndex = config.modelProfiles.findIndex(
    (candidate) => candidate.name === current.modelProfile,
  );
  const fallbackIndex = config.modelProfiles.findIndex(
    (candidate) => candidate.name === config.defaultModelProfile,
  );
  const nextIndex = Math.min(
    config.modelProfiles.length - 1,
    (currentIndex >= 0 ? currentIndex : Math.max(0, fallbackIndex)) + 1,
  );
  const retryTargets = { mini: "fast", standard: "medium", proven: "advanced", fast: "medium", medium: "advanced", advanced: "expert", expert: "ultra", ultra: "ultra" };
  const builtin = DEFAULT_MODEL_PROFILES.find(p => p.name === current.modelProfile && p.model === current.model);
  const preferredIndex = builtin ? config.modelProfiles.findIndex(p => p.name === retryTargets[builtin.name]) : -1;
  const nextProfile = config.modelProfiles.slice(preferredIndex >= 0 ? preferredIndex : nextIndex).find(profile =>
    profileUsable(profileDiagnostic(profile, config.modelCatalog)));
  if (!nextProfile) throw new Error("No supported higher model profile; inspect model_profiles to update configuration.");
  return resolveTaskExecution(config, {
    backend:
      current.backend || config.executionBackend || DEFAULT_EXECUTION_BACKEND,
    modelProfile: nextProfile.name,
    ephemeral: current.ephemeral,
    runMode: current.mode || "background",
  });
}

function assertTaskClaim(taskPath, claim) {
  const current = readClaim(`${taskPath}.lock`, { includeToken: true });
  if (!claim?.token || current?.token !== claim.token) {
    throw new Error("Task claim is no longer owned by this worker");
  }
}

function mergeRepairKind(task) {
  return task.metadata.git?.mergeConflict?.kind === "pipeline_validation" ? "validation" : "conflict";
}

function mergeRepairCount(task) {
  const kind = mergeRepairKind(task);
  return task.metadata.git.mergeRepairAttempts?.[kind] ?? storedAttemptLedger(task).attempts.filter(attempt =>
    attempt.trigger === (kind === "validation" ? "merge_validation" : "merge_conflict")).length;
}

function mergeRepairLimit(repoRoot, task) {
  const config = loadConfig(repoRoot);
  const pipeline = task.metadata.pipeline && loadPipelineSnapshot(repoRoot, task.metadata.pipeline);
  const kind = mergeRepairKind(task);
  // Pipeline repair rounds bound semantic repairs; retries bound conflict repairs.
  // Unlimited transient retries must not create an unlimited integration loop.
  const limit = kind === "validation" && pipeline?.repair
    ? pipeline.repair.maxRounds : 1 + Math.max(0, config.retries);
  return limit + (task.metadata.git.mergeRepairExtra?.[kind] || 0);
}

export function resumeTaskMergeRepair(repoRoot, task, { manual = false } = {}) {
  const git = task.metadata.git;
  if (!git || !(git.phase === "merge-conflict" ||
      (git.phase === "merge-failed" && (git.mergeConflict || task.metadata.error?.kind === "pipeline_validation")))) return false;
  if (!git.mergeConflict) {
    // Compatibility with failures written before merge validation had a repair checkpoint.
    const directory = path.join(todoDir(repoRoot), "logs", task.id);
    const files = existsSync(directory) ? readdirSync(directory)
      .filter(name => name.startsWith("merge-validation-"))
      .map(name => path.join(directory, name, "validation.json")).filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
    let validation;
    for (const file of files) {
      const saved = readJson(file);
      if (saved.headCommit !== git.headCommit) continue;
      const gate = saved.receipts?.find(receipt => receipt.status !== "completed");
      if (gate) { validation = { ...gate, pipelineDigest: saved.pipelineDigest, receiptPath: path.relative(repoRoot, file) }; break; }
    }
    git.mergeConflict = { kind: "pipeline_validation", headCommit: git.headCommit,
      message: task.metadata.error?.message || git.deliveryError, ...(validation || {}) };
  }
  const kind = mergeRepairKind(task);
  if (manual && mergeRepairCount(task) >= mergeRepairLimit(repoRoot, task)) {
    git.mergeRepairExtra = { ...git.mergeRepairExtra, [kind]: (git.mergeRepairExtra?.[kind] || 0) + 1 };
  }
  git.phase = "merge-conflict";
  task.metadata.error = null;
  return true;
}

export function buildMergeConflictPrompt(task, worktreePath, claim) {
  const repair = task.metadata.git?.mergeConflict || {};
  const validation = repair.kind === "pipeline_validation";
  return [
    `Continue original ToDo task ${task.id} in its existing Codex thread. Do not restart its implementation or create another task.`,
    `This is ${validation ? "merge-validation" : "merge-conflict"} repair attempt ${claim.attempt || 1}.`,
    `Existing worktree: ${worktreePath}. Task HEAD: ${repair.currentHeadCommit || repair.headCommit || task.metadata.git.headCommit}. Target ${task.metadata.git.targetBranch} HEAD: ${repair.currentTargetCommit || repair.targetCommit || "inspect current target"}.`,
    validation ? `The rebase completed. Fix only the integration incompatibility reported by mandatory gate ${repair.stepId || "in the saved validation log"}.` :
      `The rebase is paused. Conflicted files: ${(repair.files || []).join(", ") || "inspect the paused rebase"}.`,
    validation ? `Failed gate evaluated task HEAD ${repair.headCommit} against target HEAD ${repair.targetCommit || "not recorded by older runtime"}.` : "",
    repair.command ? `Gate command: ${repair.command}; cwd: ${repair.cwd || "."}.` : "",
    repair.message || "", repair.stdoutTail || repair.stdout || "", repair.stderrTail || repair.stderr || "",
    repair.receiptPath ? `Full validation receipt: ${repair.receiptPath}; stdout: ${repair.stdoutPath}; stderr: ${repair.stderrPath}.` : "",
    "Preserve the original implementation while preserving the newer target-branch functionality and contracts; review affected callers and fixtures. Do not weaken gates or disable tests.",
    "Edit files and inspect your diff in this attempt. Do not run git add, commit, merge, cherry-pick, rebase, push, or branch commands. The merge worker owns integration and will rerun every mandatory shell gate on the current integrated HEAD before delivery.",
    "If a user decision is required, return requiresInteractive=true and the exact question; preserve all code. Return only the JSON object required by the existing output schema.",
    task.metadata.interaction?.response?.text ? `Continuation instruction: ${task.metadata.interaction.response.text}` : "",
    "Original task requirements:", task.body,
  ].filter(Boolean).join("\n\n");
}

export function prepareTaskMergeConflictRepair(repoRoot, taskPath, claim) {
  assertTaskClaim(taskPath, claim);
  const task = readTask(taskPath);
  if (task.metadata.git?.phase !== "merge-conflict") throw new Error(`Task is not waiting for merge repair: ${task.id}`);
  const kind = mergeRepairKind(task);
  if (mergeRepairCount(task) >= mergeRepairLimit(repoRoot, task)) {
    const error = new Error(`Merge ${kind} repair attempts exhausted. Code and repair context retained; use task_retry or task_run_start in the original thread for one further repair.`);
    error.kind = "merge_repair_exhausted";
    throw error;
  }
  if (!task.metadata.codexThread?.id) throw new Error("Merge repair requires the original persistent app-server thread");
  const head = (cwd, ref) => {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", ref], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `Cannot inspect ${ref}`);
    return result.stdout.trim();
  };
  const repair = task.metadata.git.mergeConflict;
  repair.currentHeadCommit = head(task.metadata.git.worktreePath, "HEAD");
  repair.currentTargetCommit = head(repoRoot, `refs/heads/${task.metadata.git.targetBranch}`);
  if (repair.profileEscalated !== true) {
    const config = loadConfig(repoRoot);
    task.metadata.execution = escalatedExecution(config, task.metadata.execution || resolveTaskExecution(config, {}));
    repair.profileEscalated = true;
    repair.repairProfile = task.metadata.execution.modelProfile;
  }
  if (task.metadata.codexThread.state === "archived") task.metadata.codexThread.state = "unarchive-pending";
  writeTask(task);
  return getTaskStatus(repoRoot, task.id);
}

export function applyGitExcludes(repoRoot, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--git-path", "info/exclude"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not resolve .git/info/exclude");
  }

  const reportedPath = result.stdout.trim();
  const excludePath = path.isAbsolute(reportedPath)
    ? reportedPath
    : path.resolve(repoRoot, reportedPath);
  mkdirSync(path.dirname(excludePath), { recursive: true });
  const existingText = existsSync(excludePath)
    ? readFileSync(excludePath, "utf8")
    : "";
  const known = new Set(existingText.split(/\r?\n/));
  const added = [];

  for (const pattern of patterns) {
    if (known.has(pattern)) continue;
    const separator =
      existingText.length === 0 && added.length === 0
        ? ""
        : existingText.endsWith("\n") && added.length === 0
          ? ""
          : "\n";
    appendFileSync(excludePath, `${separator}${pattern}`, "utf8");
    known.add(pattern);
    added.push(pattern);
  }
  if (added.length > 0) appendFileSync(excludePath, "\n", "utf8");
  return added;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function findLegacyRunner(repoRoot) {
  if (process.platform === "win32") return null;
  const runnerPath = path.join(repoRoot, ".todo", "run-tasks.sh");
  if (!existsSync(runnerPath)) return null;
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes(runnerPath)) continue;
    const match = /^\s*([0-9]+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (pid !== process.pid && processIsAlive(pid)) {
      return { pid, command: match[2] };
    }
  }
  return null;
}

export function findLegacyWorkers(
  repoRoot,
  configuredWorkers = DEFAULT_WORKERS,
) {
  if (process.platform === "win32") return [];
  const runnerPath = path.join(repoRoot, ".todo", "run-tasks.sh");
  if (!existsSync(runnerPath)) return [];
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];

  const taskStatuses = listTaskStatuses(repoRoot, { recoverUsage: false });
  const processes = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes(runnerPath)) continue;
    const match = /^\s*([0-9]+)\s+(.+)$/.exec(line);
    const workerMatch = /(?:^|\s)--worker\s+([^\s]+)/.exec(line);
    if (!match || !workerMatch) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!processIsAlive(pid)) continue;
    const id = /^\d+$/.test(workerMatch[1])
      ? Number.parseInt(workerMatch[1], 10)
      : workerMatch[1];
    const task = taskStatuses.find(
      (item) =>
        item.status === "running" &&
        (item.claim?.pid === pid ||
          String(item.claim?.workerId) === String(id)),
    );
    processes.push({
      id,
      status: task ? "busy" : "idle",
      runner: "legacy",
      pid,
      daemonPid: null,
      taskId: task?.id || null,
      taskTitle: task?.title || null,
    });
  }
  if (processes.length === 0) return [];

  const knownIds = new Set(processes.map((item) => String(item.id)));
  for (let id = 1; id <= configuredWorkers; id += 1) {
    if (knownIds.has(String(id))) continue;
    processes.push({
      id,
      status: "stopped",
      runner: "legacy",
      pid: null,
      daemonPid: null,
      taskId: null,
      taskTitle: null,
    });
  }
  return processes.sort((left, right) =>
    String(left.id).localeCompare(String(right.id), undefined, {
      numeric: true,
    }),
  );
}

export function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function readClaim(lockPath, { includeToken = false } = {}) {
  if (!existsSync(lockPath)) return null;
  const text = readFileSync(lockPath, "utf8").trim();
  if (!text) return null;

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = {};
    for (const line of text.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      raw[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  const pidValue = Number.parseInt(raw.pid, 10);
  const workerValue = raw.workerId ?? raw.worker ?? null;
  const workerId =
    typeof workerValue === "string" && /^\d+$/.test(workerValue)
      ? Number.parseInt(workerValue, 10)
      : workerValue;
  const task = raw.task ? path.basename(String(raw.task)) : null;

  return {
    ...(includeToken && typeof raw.token === "string" ? { token: raw.token } : {}),
    ...(typeof raw.owner?.threadId === "string" ? { owner: {
      threadId: raw.owner.threadId, turnId: typeof raw.owner.turnId === "string" ? raw.owner.turnId : null,
    } } : {}),
    source: raw.token ? "node" : "legacy",
    pid: Number.isInteger(pidValue) ? pidValue : null,
    workerId,
    taskId: task ? taskIdFromFilename(task) : null,
    claimedAt: raw.claimedAt ?? raw.started_at ?? null,
    attemptId: typeof raw.attemptId === "string" ? raw.attemptId : null,
    attempt: Number.isInteger(raw.attempt) ? raw.attempt : null,
    trigger: typeof raw.trigger === "string" ? raw.trigger : null,
    retryOf: typeof raw.retryOf === "string" ? raw.retryOf : null,
    ...(typeof raw.continuationOf === "string" ? { continuationOf: raw.continuationOf } : {}),
  };
}

export function daemonStatePath(repoRoot) {
  return path.join(todoDir(repoRoot), "daemon.json");
}

export function daemonStopRequestPath(repoRoot) {
  return path.join(todoDir(repoRoot), ".daemon-stop.json");
}

export function readDaemonState(repoRoot) {
  const file = daemonStatePath(repoRoot);
  if (!existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

export function isCurrentDaemonState(state) {
  return (
    state?.implementation === DAEMON_IMPLEMENTATION &&
    state?.protocolVersion === DAEMON_PROTOCOL_VERSION
  );
}

export function taskIdFromFilename(filename) {
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

export function taskFilenameFromId(id) {
  const basename = path.basename(String(id));
  const filename = basename.endsWith(".md") ? basename : `${basename}.md`;
  if (!TASK_NAME_PATTERN.test(filename)) {
    throw new Error(`Invalid task ID: ${id}`);
  }
  return filename;
}

export function existingTaskFilename(repoRoot, id) {
  let direct = null;
  let directError = null;
  try {
    direct = taskFilenameFromId(id);
  } catch (error) {
    directError = error;
  }
  if (direct && existsSync(path.join(todoDir(repoRoot), direct))) {
    return direct;
  }

  const shorthand = path
    .basename(String(id))
    .replace(/\.md$/, "");
  if (/^[0-9]+$/.test(shorthand)) {
    const requestedSequence = BigInt(shorthand);
    const matches = listTaskFiles(repoRoot)
      .map((file) => path.basename(file))
      .filter((filename) => {
        const match = /^([0-9]+)-/.exec(filename);
        return match && BigInt(match[1]) === requestedSequence;
      });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Task ID is ambiguous: ${id}`);
    }
  }

  if (direct) return direct;
  throw directError;
}

export function listTaskFiles(repoRoot) {
  const root = todoDir(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => TASK_NAME_PATTERN.test(name))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .map((name) => path.join(root, name));
}

function validMetricTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validMetricRun(run, { requireStartedAt = true } = {}) {
  return (
    run &&
    typeof run === "object" &&
    !Array.isArray(run) &&
    (!requireStartedAt || validMetricTimestamp(run.startedAt)) &&
    validMetricTimestamp(run.completedAt) &&
    Number.isFinite(run.durationMs) &&
    run.durationMs >= 0 &&
    run.tokenUsage &&
    typeof run.tokenUsage === "object" &&
    Number.isFinite(run.tokenUsage.totalTokens) &&
    run.tokenUsage.totalTokens >= 0
  );
}

function storedTaskExecution(repoRoot, task) {
  const execution =
    task.metadata.execution ||
    resolveTaskExecution(loadConfig(repoRoot), {});
  return {
    ...execution,
    mode: execution.mode || "background",
  };
}

export function readTask(taskPath) {
  const text = readFileSync(taskPath, "utf8");
  const newline = text.indexOf("\n");
  const firstLine = (
    newline === -1 ? text : text.slice(0, newline)
  ).replace(/\r$/, "");
  const match = HEADER_PATTERN.exec(firstLine);
  if (!match) throw new Error("first line is not a TODO metadata header");

  const metadata = JSON.parse(match[1]);
  if (
    !["version", "blockers", "error"].every((key) =>
      Object.hasOwn(metadata, key),
    )
  ) {
    throw new Error("task metadata is incomplete");
  }
  if (metadata.version !== 1 || !Array.isArray(metadata.blockers)) {
    throw new Error("unsupported metadata");
  }
  if (
    metadata.allowWorkerTaskCreation !== undefined &&
    typeof metadata.allowWorkerTaskCreation !== "boolean"
  ) {
    throw new Error("invalid allowWorkerTaskCreation metadata");
  }
  if (
    metadata.parentTaskId !== undefined &&
    (typeof metadata.parentTaskId !== "string" ||
      !TASK_NAME_PATTERN.test(`${metadata.parentTaskId}.md`))
  ) {
    throw new Error("invalid parentTaskId metadata");
  }
  if (
    metadata.batchReady !== undefined &&
    typeof metadata.batchReady !== "boolean"
  ) {
    throw new Error("invalid batchReady metadata");
  }
  if (
    metadata.nextAttemptTrigger !== undefined &&
    !["automatic_retry", "manual_retry", "head_recovery", "workspace_refresh"].includes(
      metadata.nextAttemptTrigger,
    )
  ) {
    throw new Error("invalid nextAttemptTrigger metadata");
  }
  if (metadata.preflight !== undefined) {
    const preflight = metadata.preflight;
    if (
      !preflight ||
      typeof preflight !== "object" ||
      Array.isArray(preflight) ||
      typeof preflight.id !== "string" ||
      !Array.isArray(preflight.capabilities)
    ) {
      throw new Error("invalid preflight metadata");
    }
  }
  if (metadata.pipeline !== undefined) {
    const pipeline = metadata.pipeline;
    if (
      !pipeline ||
      typeof pipeline !== "object" ||
      Array.isArray(pipeline) ||
      typeof pipeline.source !== "string" ||
      !pipeline.source ||
      typeof pipeline.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(pipeline.digest)
    ) {
      throw new Error("invalid pipeline metadata");
    }
  }
  if (metadata.git !== undefined) {
    const git = metadata.git;
    if (
      !git ||
      typeof git !== "object" ||
      Array.isArray(git) ||
      typeof git.branch !== "string" ||
      (git.executionMode !== "single-branch" && !git.branch.startsWith("codex/todo-")) ||
      (git.executionMode !== undefined && !["worktree", "single-branch"].includes(git.executionMode)) ||
      typeof git.targetBranch !== "string" ||
      !git.targetBranch ||
      !TASK_GIT_DELIVERIES.has(git.delivery) ||
      (git.push !== undefined && typeof git.push !== "boolean") ||
      !TASK_GIT_PHASES.has(git.phase) ||
      (git.worktreePath !== undefined &&
        typeof git.worktreePath !== "string") ||
      (git.baseCommit !== undefined &&
        !/^[0-9a-f]{40,64}$/i.test(git.baseCommit)) ||
      (git.headCommit !== undefined &&
        !/^[0-9a-f]{40,64}$/i.test(git.headCommit)) ||
      (git.deliveryAttemptId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          git.deliveryAttemptId,
        ))
    ) {
      throw new Error("invalid git metadata");
    }
  }
  if (metadata.attemptLedger !== undefined) {
    const ledger = metadata.attemptLedger;
    if (
      !ledger ||
      !Array.isArray(ledger.attempts) ||
      !Array.isArray(ledger.deliveryAttempts) ||
      !ledger.retryStats ||
      [
        "modelRetries",
        "automaticRetries",
        "manualRetries",
        "deliveryRetries",
      ].some(
        (key) =>
          !Number.isInteger(ledger.retryStats[key]) ||
          ledger.retryStats[key] < 0,
      )
    ) {
      throw new Error("invalid attempt ledger metadata");
    }
  }
  const seen = new Set();
  for (const blocker of metadata.blockers) {
    if (
      typeof blocker !== "string" ||
      !TASK_NAME_PATTERN.test(blocker) ||
      seen.has(blocker)
    ) {
      throw new Error(`invalid blocker: ${String(blocker)}`);
    }
    seen.add(blocker);
  }
  if (
    metadata.error !== null &&
    (!metadata.error ||
      typeof metadata.error !== "object" ||
      typeof metadata.error.message !== "string")
  ) {
    throw new Error("invalid error metadata");
  }
  if (metadata.execution !== undefined) {
    const execution = metadata.execution;
    const executionKeys =
      execution && typeof execution === "object" && !Array.isArray(execution)
        ? Object.keys(execution).sort()
        : [];
    const allowedExecutionKeys = new Set([
      "backend",
      "ephemeral",
      "mode",
      "model",
      "modelProfile",
      "reasoningEffort",
    ]);
    if (
      !["ephemeral", "model", "modelProfile", "reasoningEffort"].every(
        (key) => executionKeys.includes(key),
      ) ||
      executionKeys.some((key) => !allowedExecutionKeys.has(key)) ||
      typeof execution.modelProfile !== "string" ||
      !execution.modelProfile ||
      typeof execution.model !== "string" ||
      !execution.model ||
      (execution.backend !== undefined &&
        !["app-server", "exec"].includes(execution.backend)) ||
      !REASONING_EFFORTS.has(execution.reasoningEffort) ||
      typeof execution.ephemeral !== "boolean" ||
      (execution.mode !== undefined && !TASK_RUN_MODES.has(execution.mode))
    ) {
      throw new Error("invalid execution metadata");
    }
  }
  if (metadata.codexThread !== undefined) {
    const thread = metadata.codexThread;
    if (
      !thread ||
      typeof thread !== "object" ||
      Array.isArray(thread) ||
      typeof thread.id !== "string" ||
      !thread.id ||
      !["active", "archive-pending", "archived", "unarchive-pending"].includes(
        thread.state,
      ) ||
      !validMetricTimestamp(thread.createdAt) ||
      (thread.lastTurnId !== undefined &&
        (typeof thread.lastTurnId !== "string" || !thread.lastTurnId)) ||
      (thread.archivedAt !== undefined &&
        !validMetricTimestamp(thread.archivedAt))
    ) {
      throw new Error("invalid codexThread metadata");
    }
  }
  if (metadata.metrics !== undefined) {
    const metrics = metadata.metrics;
    const legacyLastRun = metrics?.lastAttempt;
    const runs = metrics?.runs;
    const hasValidRuns =
      validMetricTimestamp(metrics?.startedAt) &&
      Array.isArray(runs) &&
      runs.length > 0 &&
      runs.every((run) => validMetricRun(run)) &&
      validMetricRun(metrics?.lastRun) &&
      metrics.lastRun.startedAt === runs.at(-1).startedAt &&
      metrics.lastRun.completedAt === runs.at(-1).completedAt;
    const hasValidLegacyLastRun =
      runs === undefined &&
      validMetricRun(legacyLastRun, { requireStartedAt: false });
    if (
      !metrics ||
      typeof metrics !== "object" ||
      Array.isArray(metrics) ||
      !Number.isInteger(metrics.attempts) ||
      metrics.attempts < 1 ||
      typeof metrics.completedAt !== "string" ||
      !Number.isFinite(metrics.durationMs) ||
      metrics.durationMs < 0 ||
      !Number.isFinite(metrics.durationSeconds) ||
      metrics.durationSeconds < 0 ||
      !Number.isFinite(metrics.durationMinutes) ||
      metrics.durationMinutes < 0 ||
      typeof metrics.durationHuman !== "string" ||
      !metrics.tokenUsage ||
      typeof metrics.tokenUsage !== "object" ||
      !Number.isFinite(metrics.tokenUsage.totalTokens) ||
      metrics.tokenUsage.totalTokens < 0 ||
      (!hasValidRuns && !hasValidLegacyLastRun)
    ) {
      throw new Error("invalid task metrics metadata");
    }
  }

  return {
    path: taskPath,
    filename: path.basename(taskPath),
    id: taskIdFromFilename(path.basename(taskPath)),
    metadata,
    body: newline === -1 ? "" : text.slice(newline + 1),
    text,
  };
}

export function writeTask(task, metadata = task.metadata) {
  const temporary = `${task.path}.tmp-${process.pid}-${Date.now()}`;
  const next = `<!-- TODO ${JSON.stringify(metadata)} -->\n${task.body}`;
  try {
    writeFileSync(temporary, next, "utf8");
    renameSync(temporary, task.path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function titleFromBody(body, fallback) {
  const title = body
    .split(/\r?\n/)
    .find((line) => line.startsWith("# "));
  return title ? title.slice(2).trim() : fallback;
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "task";
}

function normalizedTaskId(id) {
  return taskIdFromFilename(taskFilenameFromId(id));
}

export function taskArtifactDir(repoRoot, id) {
  return path.join(todoDir(repoRoot), "artifacts", normalizedTaskId(id));
}

export function taskArtifactManifestPath(repoRoot, id) {
  return path.join(taskArtifactDir(repoRoot, id), "manifest.json");
}

function artifactText(value, name, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${name} must not exceed ${maxLength} characters`);
  }
  return normalized;
}

function artifactExtension(filename, mimeType) {
  const extension = path.extname(filename || "").toLowerCase();
  if (/^\.[a-z0-9]{1,12}$/.test(extension)) return extension;
  return MIME_EXTENSIONS.get(mimeType) || "";
}

function inferMimeType(filename, requested) {
  return (
    artifactText(requested, "artifact mimeType", 200) ||
    EXTENSION_MIME_TYPES.get(path.extname(filename || "").toLowerCase()) ||
    "application/octet-stream"
  );
}

function artifactFilename(sequence, label, originalName, mimeType) {
  const extension = artifactExtension(originalName || label, mimeType);
  const sourceStem = path.basename(
    originalName || label || "artifact",
    path.extname(originalName || label || ""),
  );
  const stem = slugify(sourceStem).slice(0, 80);
  return `${String(sequence).padStart(3, "0")}-${stem}${extension}`;
}

function normalizeBase64(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("artifact dataBase64 must be a non-empty string");
  }
  const compact = value.replace(/\s+/g, "");
  if (
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new Error("artifact dataBase64 is invalid");
  }
  const padded = compact.padEnd(
    compact.length + ((4 - (compact.length % 4)) % 4),
    "=",
  );
  const buffer = Buffer.from(padded, "base64");
  if (buffer.length > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `artifact exceeds the ${MAX_ARTIFACT_BYTES} byte size limit`,
    );
  }
  return buffer;
}

function resolveCodeReference(repoRoot, source) {
  const requested = artifactText(source, "code artifact source", 4000);
  const absolute = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(repoRoot, requested);
  const relative = path.relative(repoRoot, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("code artifact source must be a file inside the repository");
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`code artifact source is not a file: ${requested}`);
  }
  return relative.split(path.sep).join("/");
}

function normalizedLineRange(artifact) {
  const lineStart = artifact.lineStart ?? null;
  const lineEnd = artifact.lineEnd ?? null;
  if (
    (lineStart !== null && (!Number.isInteger(lineStart) || lineStart < 1)) ||
    (lineEnd !== null && (!Number.isInteger(lineEnd) || lineEnd < 1)) ||
    (lineEnd !== null && lineStart === null) ||
    (lineStart !== null && lineEnd !== null && lineEnd < lineStart)
  ) {
    throw new Error("code artifact lineStart/lineEnd range is invalid");
  }
  return { lineStart, lineEnd };
}

function displayLabel(value, fallback) {
  return artifactText(value, "artifact label", 200) || fallback;
}

function readArtifactManifest(repoRoot, id) {
  const file = taskArtifactManifestPath(repoRoot, id);
  if (!existsSync(file)) {
    return {
      version: 1,
      taskId: normalizedTaskId(id),
      artifacts: [],
      createdAt: null,
      updatedAt: null,
    };
  }
  const manifest = readJson(file);
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.taskId !== normalizedTaskId(id) ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error(`Invalid artifact manifest: ${file}`);
  }
  return manifest;
}

export function readTaskArtifacts(repoRoot, id) {
  return readArtifactManifest(repoRoot, id).artifacts;
}

function writeCopiedArtifact(
  repoRoot,
  taskId,
  artifact,
  sequence,
  copiedFiles,
) {
  const hasSource =
    typeof artifact.source === "string" && artifact.source.trim().length > 0;
  const hasBase64 =
    typeof artifact.dataBase64 === "string" &&
    artifact.dataBase64.trim().length > 0;
  if (hasSource === hasBase64) {
    throw new Error(
      `${artifact.kind} artifact requires exactly one of source or dataBase64`,
    );
  }

  let originalName;
  let sourcePath = null;
  let data = null;
  if (hasSource) {
    sourcePath = path.isAbsolute(artifact.source)
      ? path.resolve(artifact.source)
      : path.resolve(repoRoot, artifact.source);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error(`artifact source is not a file: ${artifact.source}`);
    }
    const size = statSync(sourcePath).size;
    if (size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact exceeds the ${MAX_ARTIFACT_BYTES} byte size limit`,
      );
    }
    originalName = path.basename(sourcePath);
  } else {
    data = normalizeBase64(artifact.dataBase64);
    originalName =
      artifactText(artifact.filename, "artifact filename", 255) ||
      artifactText(artifact.label, "artifact label", 200) ||
      "artifact";
  }

  const mimeType = inferMimeType(originalName, artifact.mimeType);
  const label = displayLabel(artifact.label, originalName);
  const filename = artifactFilename(
    sequence,
    label,
    originalName,
    mimeType,
  );
  const destination = path.join(taskArtifactDir(repoRoot, taskId), filename);
  if (sourcePath) copyFileSync(sourcePath, destination);
  else writeFileSync(destination, data);
  copiedFiles.push(destination);
  const sizeBytes = statSync(destination).size;

  return {
    id: `artifact-${String(sequence).padStart(3, "0")}`,
    kind: artifact.kind,
    label,
    description: artifactText(
      artifact.description,
      "artifact description",
      4000,
    ),
    path: path.posix.join(
      ".todo",
      "artifacts",
      taskId,
      filename,
    ),
    originalName,
    mimeType,
    sizeBytes,
  };
}

function normalizeReferenceArtifact(repoRoot, artifact, sequence) {
  const description = artifactText(
    artifact.description,
    "artifact description",
    4000,
  );
  const id = `artifact-${String(sequence).padStart(3, "0")}`;
  if (artifact.kind === "code") {
    const codePath = resolveCodeReference(repoRoot, artifact.source);
    const { lineStart, lineEnd } = normalizedLineRange(artifact);
    return {
      id,
      kind: "code",
      label: displayLabel(artifact.label, codePath),
      description,
      path: codePath,
      lineStart,
      lineEnd,
    };
  }
  if (artifact.kind === "url") {
    const source = artifactText(artifact.source, "URL artifact source", 8000);
    let url;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`URL artifact source is invalid: ${source}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("URL artifact source must use http or https");
    }
    return {
      id,
      kind: "url",
      label: displayLabel(artifact.label, url.hostname),
      description,
      url: url.toString(),
    };
  }
  if (artifact.kind === "text") {
    const content = artifactText(
      artifact.content,
      "text artifact content",
      MAX_ARTIFACT_BYTES,
    );
    const label = displayLabel(artifact.label, "Text note");
    const mimeType = inferMimeType(
      artifact.filename || `${label}.txt`,
      artifact.mimeType || "text/plain",
    );
    const filename = artifactFilename(
      sequence,
      label,
      artifact.filename || `${label}.txt`,
      mimeType,
    );
    const destination = path.join(
      taskArtifactDir(repoRoot, normalizedTaskId(artifact.taskId)),
      filename,
    );
    writeFileSync(destination, `${content}\n`, "utf8");
    return {
      entry: {
        id,
        kind: "text",
        label,
        description,
        path: path.posix.join(
          ".todo",
          "artifacts",
          normalizedTaskId(artifact.taskId),
          filename,
        ),
        originalName: artifact.filename || null,
        mimeType,
        sizeBytes: statSync(destination).size,
      },
      copiedFile: destination,
    };
  }
  throw new Error(`unsupported artifact kind: ${String(artifact.kind)}`);
}

function storeTaskArtifacts(repoRoot, taskId, artifacts) {
  if (!Array.isArray(artifacts)) {
    throw new Error("artifacts must be an array");
  }
  if (artifacts.length === 0) {
    return {
      manifest: readArtifactManifest(repoRoot, taskId),
      previousManifest: null,
      copiedFiles: [],
    };
  }

  const previousManifest = readArtifactManifest(repoRoot, taskId);
  if (
    previousManifest.artifacts.length + artifacts.length >
    MAX_ARTIFACTS_PER_TASK
  ) {
    throw new Error(
      `a task may contain at most ${MAX_ARTIFACTS_PER_TASK} artifacts`,
    );
  }
  const artifactRoot = taskArtifactDir(repoRoot, taskId);
  mkdirSync(artifactRoot, { recursive: true });
  const copiedFiles = [];
  const added = [];
  let sequence = previousManifest.artifacts.length + 1;

  try {
    for (const raw of artifacts) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("each artifact must be an object");
      }
      if (raw.kind === "image" || raw.kind === "file") {
        added.push(
          writeCopiedArtifact(
            repoRoot,
            normalizedTaskId(taskId),
            raw,
            sequence,
            copiedFiles,
          ),
        );
      } else {
        const normalized = normalizeReferenceArtifact(
          repoRoot,
          { ...raw, taskId: normalizedTaskId(taskId) },
          sequence,
        );
        if (normalized.entry) {
          added.push(normalized.entry);
          copiedFiles.push(normalized.copiedFile);
        } else {
          added.push(normalized);
        }
      }
      sequence += 1;
    }

    const now = new Date().toISOString();
    const manifest = {
      version: 1,
      taskId: normalizedTaskId(taskId),
      artifacts: [...previousManifest.artifacts, ...added],
      createdAt: previousManifest.createdAt || now,
      updatedAt: now,
    };
    atomicWriteJson(taskArtifactManifestPath(repoRoot, taskId), manifest);
    return { manifest, previousManifest, copiedFiles };
  } catch (error) {
    for (const file of copiedFiles) {
      if (existsSync(file)) unlinkSync(file);
    }
    throw error;
  }
}

function markdownLabel(value) {
  return String(value).replace(/([\\[\]])/g, "\\$1");
}

function markdownDescription(value) {
  return value ? ` — ${value.replace(/\r?\n/g, " ")}` : "";
}

function renderArtifactLine(taskId, artifact) {
  const label = markdownLabel(artifact.label);
  if (
    artifact.kind === "image" ||
    artifact.kind === "file" ||
    artifact.kind === "text"
  ) {
    const filename = path.posix.basename(artifact.path);
    const target = path.posix.join("artifacts", taskId, filename);
    return `- **${artifact.kind}**: [${label}](${target})${markdownDescription(artifact.description)}`;
  }
  if (artifact.kind === "code") {
    const encodedPath = encodeURI(`../${artifact.path}`).replace(/#/g, "%23");
    const fragment = artifact.lineStart
      ? `#L${artifact.lineStart}${artifact.lineEnd ? `-L${artifact.lineEnd}` : ""}`
      : "";
    const range = artifact.lineStart
      ? `, lines ${artifact.lineStart}${artifact.lineEnd ? `-${artifact.lineEnd}` : ""}`
      : "";
    return `- **code**: [${label}](${encodedPath}${fragment}) (\`${artifact.path}\`${range})${markdownDescription(artifact.description)}`;
  }
  return `- **url**: [${label}](<${artifact.url}>)${markdownDescription(artifact.description)}`;
}

function renderArtifactsSection(taskId, artifacts) {
  return [
    "## Artifacts",
    "",
    ARTIFACTS_START,
    ...artifacts.map((artifact) => renderArtifactLine(taskId, artifact)),
    ARTIFACTS_END,
  ].join("\n");
}

function withArtifactsSection(body, taskId, artifacts) {
  if (artifacts.length === 0) return body;
  const start = body.indexOf(ARTIFACTS_START);
  const end = body.indexOf(ARTIFACTS_END);
  const section = renderArtifactsSection(taskId, artifacts);
  if (start >= 0 && end > start) {
    const heading = body.lastIndexOf("## Artifacts", start);
    const replaceStart = heading >= 0 ? heading : start;
    const replaceEnd = end + ARTIFACTS_END.length;
    return `${body.slice(0, replaceStart).trimEnd()}\n\n${section}${body.slice(replaceEnd)}`.trimStart();
  }
  return `${body.trimEnd()}\n\n${section}\n`;
}

function taskSequenceFromName(name, extension) {
  const escapedExtension = extension.replace(".", "\\.");
  const match = new RegExp(
    `^([0-9]+)-[a-z0-9]+(?:-[a-z0-9]+)*${escapedExtension}$`,
  ).exec(name);
  return match ? BigInt(match[1]) : null;
}

function latestTaskSequence(repoRoot) {
  let latest = 0n;
  for (const file of listTaskFiles(repoRoot)) {
    const sequence = taskSequenceFromName(path.basename(file), ".md");
    if (sequence !== null && sequence > latest) latest = sequence;
  }
  const historyDir = path.join(todoDir(repoRoot), "history");
  if (existsSync(historyDir)) {
    for (const name of readdirSync(historyDir)) {
      const sequence = taskSequenceFromName(name, ".json");
      if (sequence !== null && sequence > latest) latest = sequence;
    }
  }
  return latest;
}

function acquireTaskSequenceLock(repoRoot) {
  const lockPath = path.join(todoDir(repoRoot), ".task-sequence.lock");
  const deadline = Date.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const token = randomUUID();
    let fd;
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(
        fd,
        `${JSON.stringify({
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      closeSync(fd);
      return { lockPath, token };
    } catch (error) {
      if (fd !== undefined) {
        closeSync(fd);
        if (existsSync(lockPath)) unlinkSync(lockPath);
      }
      if (error.code !== "EEXIST") throw error;
      try {
        const existing = readJson(lockPath);
        const createdAt = Date.parse(existing.createdAt);
        const stale =
          (Number.isInteger(existing.pid) && !processIsAlive(existing.pid)) ||
          (Number.isFinite(createdAt) && Date.now() - createdAt > 30000);
        if (stale) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // A lock that cannot be proven stale is left untouched.
        }
      }
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  throw new Error("Timed out reserving the next task sequence");
}

function releaseTaskSequenceLock(lock) {
  if (!lock || !existsSync(lock.lockPath)) return;
  try {
    if (readJson(lock.lockPath).token !== lock.token) return;
    unlinkSync(lock.lockPath);
  } catch {
    // Never remove a lock whose ownership cannot be verified.
  }
}

function reserveNextTaskSequence(repoRoot) {
  const statePath = path.join(todoDir(repoRoot), ".task-sequence.json");
  let persisted = 0n;
  if (existsSync(statePath)) {
    try {
      const state = readJson(statePath);
      if (typeof state.last === "string" && /^[0-9]+$/.test(state.last)) {
        persisted = BigInt(state.last);
      }
    } catch {
      // Rebuild a corrupt or partial state from task and history filenames.
    }
  }
  const discovered = latestTaskSequence(repoRoot);
  const next = (persisted > discovered ? persisted : discovered) + 1n;
  atomicWriteJson(statePath, {
    version: 1,
    last: next.toString(),
    updatedAt: new Date().toISOString(),
  });
  return next;
}

function resolveBlocker(repoRoot, blocker) {
  const filename = existingTaskFilename(repoRoot, blocker);
  if (!existsSync(path.join(todoDir(repoRoot), filename))) {
    throw new Error(`Blocker task does not exist: ${blocker}`);
  }
  return filename;
}

export function createTask(
  repoRoot,
  {
    title,
    description,
    blockers = [],
    acceptanceCriteria = [],
    artifacts = [],
    modelProfile,
    ephemeral,
    runMode,
    delivery,
    gitTargetBranch,
    gitSnapshot,
    preflightId,
    requiredCapabilities = [],
    batchId,
    batchReady = true,
    allowWorkerTaskCreation = false,
    parentTaskId,
  },
) {
  if (!isActivated(repoRoot)) {
    throw new Error(
      `ToDo is not activated: ${configPath(repoRoot)} is missing`,
    );
  }
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("title must be a non-empty string");
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new Error("description must be a non-empty string");
  }
  if (typeof allowWorkerTaskCreation !== "boolean") {
    throw new Error("allowWorkerTaskCreation must be a boolean");
  }
  if (!TASK_GIT_DELIVERIES.has(delivery || DEFAULT_GIT_DELIVERY)) {
    throw new Error("delivery must be keep, merge, or pr");
  }
  if (
    !Array.isArray(requiredCapabilities) ||
    requiredCapabilities.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.connector !== "string" ||
        typeof item.scope !== "string" ||
        !["read", "write"].includes(item.access),
    )
  ) {
    throw new Error("requiredCapabilities is invalid");
  }
  if (preflightId !== undefined && typeof preflightId !== "string") {
    throw new Error("preflightId must be a string");
  }
  if (
    gitTargetBranch !== undefined &&
    (typeof gitTargetBranch !== "string" || !gitTargetBranch.trim())
  ) {
    throw new Error("gitTargetBranch must be a non-empty string");
  }
  if (
    gitSnapshot !== undefined &&
    (!gitSnapshot ||
      typeof gitSnapshot !== "object" ||
      !TASK_GIT_DELIVERIES.has(gitSnapshot.delivery) ||
      typeof gitSnapshot.targetBranch !== "string" ||
      !gitSnapshot.targetBranch.trim() ||
      typeof gitSnapshot.remote !== "string" ||
      (gitSnapshot.push !== undefined && typeof gitSnapshot.push !== "boolean") ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(gitSnapshot.remote))
  ) {
    throw new Error("gitSnapshot is invalid");
  }
  if (batchId !== undefined && typeof batchId !== "string") {
    throw new Error("batchId must be a string");
  }
  if (typeof batchReady !== "boolean") {
    throw new Error("batchReady must be a boolean");
  }
  if (
    !Array.isArray(blockers) ||
    !Array.isArray(acceptanceCriteria) ||
    !Array.isArray(artifacts)
  ) {
    throw new Error(
      "blockers, acceptanceCriteria, and artifacts must be arrays",
    );
  }

  ensureLayout(repoRoot);
  const blockerFiles = [
    ...new Set(blockers.map((item) => resolveBlocker(repoRoot, item))),
  ];
  const normalizedParentTaskId =
    parentTaskId === undefined
      ? null
      : taskIdFromFilename(existingTaskFilename(repoRoot, parentTaskId));
  const config = loadConfig(repoRoot);
  const targetBranch =
    gitSnapshot?.targetBranch ||
    gitTargetBranch ||
    config.git.targetBranch ||
    currentGitBranch(repoRoot);
  if (!targetBranch) {
    throw new Error(
      "Git target branch is unavailable; configure git.targetBranch",
    );
  }
  assertExistingLocalBranch(repoRoot, targetBranch);
  const resolvedDelivery =
    delivery || gitSnapshot?.delivery || config.git.delivery;
  const remote = gitSnapshot?.remote || config.git.remote;
  if (config.readError) throw new Error(config.readError);
  const push = gitSnapshot?.push ?? config.git.push;
  const execution = resolveTaskExecution(config, {
    modelProfile,
    ephemeral,
    runMode,
  });
  const metadata = {
    version: 1,
    blockers: blockerFiles,
    error: null,
    execution,
    batchReady,
    ...(config.pipeline
      ? { pipeline: storePipelineSnapshot(repoRoot, config.pipeline) }
      : {}),
    ...(batchId ? { batchId } : {}),
    ...(preflightId
      ? {
          preflight: {
            id: preflightId,
            capabilities: requiredCapabilities,
          },
        }
      : {}),
    ...(allowWorkerTaskCreation ? { allowWorkerTaskCreation: true } : {}),
    ...(normalizedParentTaskId
      ? { parentTaskId: normalizedParentTaskId }
      : {}),
  };
  const creatingMetadata = {
    ...metadata,
    error: {
      at: new Date().toISOString(),
      kind: "creating",
      exit_code: null,
      message: "Task artifacts are being stored",
    },
  };
  const criteria = acceptanceCriteria
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => `- ${item.trim()}`);
  const body = [
    `# ${title.trim()}`,
    "",
    description.trim(),
    ...(criteria.length > 0 ? ["", "## Done when", "", ...criteria] : []),
    "",
  ].join("\n");

  while (true) {
    const sequenceLock = acquireTaskSequenceLock(repoRoot);
    let filename;
    let taskPath;
    let fd;
    try {
      const sequence = reserveNextTaskSequence(repoRoot);
      const prefix = sequence.toString().padStart(3, "0");
      filename = `${prefix}-${slugify(title)}.md`;
      taskPath = path.join(todoDir(repoRoot), filename);
      fd = openSync(taskPath, "wx");
      try {
        writeFileSync(
          fd,
          `<!-- TODO ${JSON.stringify(creatingMetadata)} -->\n${body}`,
          "utf8",
        );
      } finally {
        closeSync(fd);
        fd = undefined;
      }
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      releaseTaskSequenceLock(sequenceLock);
    }
    const taskId = taskIdFromFilename(filename);
    try {
      const stored = storeTaskArtifacts(repoRoot, taskId, artifacts);
      const task = readTask(taskPath);
      task.body = withArtifactsSection(
        body,
        taskId,
        stored.manifest.artifacts,
      );
      task.metadata = {
        ...metadata,
        git: {
          branch: taskBranchName(taskId, title),
          targetBranch,
          delivery: resolvedDelivery,
          remote,
          push,
          phase: "queued",
        },
        attemptLedger: createAttemptLedger(),
      };
      writeTask(task);
      return getTaskStatus(repoRoot, taskId);
    } catch (error) {
      if (existsSync(taskPath)) unlinkSync(taskPath);
      const artifactRoot = taskArtifactDir(repoRoot, taskId);
      if (existsSync(artifactRoot)) {
        rmSync(artifactRoot, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

export function createTaskBatch(
  repoRoot,
  tasks,
  {
    preflightId,
    requiredCapabilities = [],
    targetBranch,
    gitSnapshot,
  } = {},
) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("tasks must be a non-empty array");
  }
  const batchId = randomUUID();
  let batchGate;
  const created = [];
  try {
    batchGate = acquireTaskBatchGate(repoRoot, {
      purpose: "batch-publication",
      batchId,
    });
    if (existsSync(path.join(todoDir(repoRoot), ".daemon-restart.json"))) {
      throw new Error("ToDo runtime update is pending");
    }
    for (const input of tasks) {
      const task = createTask(repoRoot, {
        ...input,
        preflightId,
        requiredCapabilities,
        gitTargetBranch: targetBranch,
        gitSnapshot,
        batchId,
        batchReady: false,
      });
      created.push(task);
    }
    for (const status of created) {
      const task = readTask(status.path);
      task.metadata.batchReady = true;
      writeTask(task);
    }
    return created.map((task) => getTaskStatus(repoRoot, task.id));
  } catch (error) {
    for (const status of created) {
      if (status.path && existsSync(status.path)) unlinkSync(status.path);
      const artifactRoot = taskArtifactDir(repoRoot, status.id);
      if (existsSync(artifactRoot)) {
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    }
    throw error;
  } finally {
    releaseTaskBatchGate(batchGate);
  }
}

export function addTaskArtifacts(repoRoot, id, artifacts) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  if (existsSync(`${taskPath}.lock`)) throw new Error(`Task is running: ${id}`);
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("artifacts must contain at least one item");
  }

  const task = readTask(taskPath);
  const stored = storeTaskArtifacts(repoRoot, task.id, artifacts);
  try {
    task.body = withArtifactsSection(
      task.body,
      task.id,
      stored.manifest.artifacts,
    );
    writeTask(task);
  } catch (error) {
    for (const file of stored.copiedFiles) {
      if (existsSync(file)) unlinkSync(file);
    }
    const manifestPath = taskArtifactManifestPath(repoRoot, task.id);
    if (stored.previousManifest.createdAt) {
      atomicWriteJson(manifestPath, stored.previousManifest);
    } else if (existsSync(manifestPath)) {
      unlinkSync(manifestPath);
    }
    throw error;
  }
  return getTaskStatus(repoRoot, task.id);
}

export function updateTask(
  repoRoot,
  id,
  {
    body,
    blockers,
    modelProfile,
    ephemeral,
    delivery,
    preflightId,
    requiredCapabilities,
    allowWorkerTaskCreation,
  } = {},
) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  if (
    body === undefined &&
    blockers === undefined &&
    modelProfile === undefined &&
    ephemeral === undefined &&
    delivery === undefined &&
    preflightId === undefined &&
    allowWorkerTaskCreation === undefined
  ) {
    throw new Error(
      "task update requires body, blockers, modelProfile, ephemeral, delivery, preflightId, or allowWorkerTaskCreation",
    );
  }
  if (
    body !== undefined &&
    (typeof body !== "string" || !body.trim())
  ) {
    throw new Error("body must be a non-empty Markdown string");
  }
  if (blockers !== undefined && !Array.isArray(blockers)) {
    throw new Error("blockers must be an array");
  }
  if (
    allowWorkerTaskCreation !== undefined &&
    typeof allowWorkerTaskCreation !== "boolean"
  ) {
    throw new Error("allowWorkerTaskCreation must be a boolean");
  }
  if (delivery !== undefined && !TASK_GIT_DELIVERIES.has(delivery)) {
    throw new Error("delivery must be keep, merge, or pr");
  }
  if (preflightId !== undefined && typeof preflightId !== "string") {
    throw new Error("preflightId must be a string");
  }
  if (
    requiredCapabilities !== undefined &&
    (!Array.isArray(requiredCapabilities) ||
      requiredCapabilities.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof item.connector !== "string" ||
          typeof item.scope !== "string" ||
          !["read", "write"].includes(item.access),
      ))
  ) {
    throw new Error("requiredCapabilities is invalid");
  }

  let claim;
  try {
    claim = claimTask(taskPath, "task-update");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Task is running: ${id}`);
    throw error;
  }

  try {
    const task = readTask(taskPath);
    if (blockers !== undefined) {
      const blockerFiles = [
        ...new Set(blockers.map((item) => resolveBlocker(repoRoot, item))),
      ];
      if (blockerFiles.includes(task.filename)) {
        throw new Error(`Task cannot block itself: ${id}`);
      }
      task.metadata.blockers = blockerFiles;
    }
    if (body !== undefined) {
      const artifacts = readTaskArtifacts(repoRoot, task.id);
      task.body = withArtifactsSection(
        `${body.trim()}\n`,
        task.id,
        artifacts,
      );
    }
    if (allowWorkerTaskCreation !== undefined) {
      if (allowWorkerTaskCreation) {
        task.metadata.allowWorkerTaskCreation = true;
      } else {
        delete task.metadata.allowWorkerTaskCreation;
      }
    }
    if (modelProfile !== undefined || ephemeral !== undefined) {
      const currentExecution =
        task.metadata.execution ||
        resolveTaskExecution(loadConfig(repoRoot), {});
      task.metadata.execution = resolveTaskExecution(loadConfig(repoRoot), {
        backend:
          currentExecution.backend ||
          loadConfig(repoRoot).executionBackend ||
          DEFAULT_EXECUTION_BACKEND,
        modelProfile:
          modelProfile === undefined
            ? currentExecution.modelProfile
            : modelProfile,
        ephemeral:
          ephemeral === undefined ? currentExecution.ephemeral : ephemeral,
        runMode: currentExecution.mode || "background",
      });
    }
    if (delivery !== undefined) {
      const git = ensureTaskGitMetadata(repoRoot, task);
      task.metadata.git = { ...git, delivery };
    }
    if (preflightId !== undefined) {
      task.metadata.preflight = {
        id: preflightId,
        capabilities: requiredCapabilities || [],
      };
    }
    writeTask(task);
  } finally {
    releaseClaim(claim);
  }

  return getTaskStatus(repoRoot, id);
}

function historyPath(repoRoot, id) {
  return path.join(
    todoDir(repoRoot),
    "history",
    `${taskIdFromFilename(id)}.json`,
  );
}

function existingHistoryPath(repoRoot, id) {
  const direct = historyPath(repoRoot, id);
  if (existsSync(direct)) return direct;
  const shorthand = path.basename(String(id)).replace(/\.md$|\.json$/g, "");
  if (!/^[0-9]+$/.test(shorthand)) return direct;
  const requested = BigInt(shorthand);
  const historyDir = path.join(todoDir(repoRoot), "history");
  const matches = existsSync(historyDir)
    ? readdirSync(historyDir).filter((name) => {
        const match = /^([0-9]+)-.+\.json$/.exec(name);
        return match && BigInt(match[1]) === requested;
      })
    : [];
  if (matches.length === 1) return path.join(historyDir, matches[0]);
  if (matches.length > 1) throw new Error(`Task ID is ambiguous: ${id}`);
  return direct;
}

export function writeHistory(repoRoot, id, value) {
  atomicWriteJson(historyPath(repoRoot, id), {
    id: taskIdFromFilename(id),
    ...value,
  });
}

function closedTaskStatus(repoRoot, id, recoverUsage = true) {
  try {
    const record = readJson(existingHistoryPath(repoRoot, id));
    return recoverUsage ? { ...record, metrics: recoveredTaskMetrics(repoRoot, record.id, record.metrics) } : record;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { id: String(id), status: "unknown" };
  }
}

export function getTaskStatus(repoRoot, id, { recoverUsage = true } = {}) {
  let filename;
  try {
    filename = existingTaskFilename(repoRoot, id);
  } catch {
    return closedTaskStatus(repoRoot, id, recoverUsage);
  }

  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) {
    return closedTaskStatus(repoRoot, taskIdFromFilename(filename), recoverUsage);
  }

  let task;
  try {
    task = readTask(taskPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return closedTaskStatus(repoRoot, taskIdFromFilename(filename), recoverUsage);
    }
    return {
      id: taskIdFromFilename(filename),
      status: "failed",
      path: taskPath,
      error: { kind: "invalid_metadata", message: error.message },
    };
  }
  const lockPath = `${taskPath}.lock`;
  const claim = existsSync(lockPath) ? readClaim(lockPath) : null;
  const existingBlockers = task.metadata.blockers.filter((blocker) =>
    existsSync(path.join(todoDir(repoRoot), blocker)),
  );
  let status = "queued";
  if (task.metadata.interaction?.state === "waiting-input") status = "waiting-input";
  else if (existsSync(lockPath)) status = "running";
  else if (task.metadata.batchReady === false) status = "staging";
  else if (task.metadata.error !== null) status = "failed";
  else if (existingBlockers.length > 0) status = "blocked";
  else if (task.metadata.git?.phase === "merge-conflict") {
    status = "merge-conflict";
  } else if (task.metadata.git?.phase === "merge-queued") {
    status = "merge-queued";
  }

  let artifacts = [];
  let artifactError = null;
  try {
    artifacts = readTaskArtifacts(repoRoot, task.id);
  } catch (error) {
    artifactError = error.message;
  }

  const attemptLedger = storedAttemptLedger(task);
  let updatedAt;
  try {
    updatedAt = statSync(taskPath).mtime.toISOString();
  } catch (error) {
    // Completion publishes history before removing the active file. It can
    // happen in another process after any of the reads above.
    if (error.code !== "ENOENT") throw error;
    return closedTaskStatus(repoRoot, task.id, recoverUsage);
  }
  return {
    id: task.id,
    title: titleFromBody(task.body, task.id),
    status,
    path: taskPath,
    blockers: task.metadata.blockers.map(taskIdFromFilename),
    existingBlockers: existingBlockers.map(taskIdFromFilename),
    workerId: claim?.workerId ?? null,
    claim,
    error: task.metadata.error,
    metrics: recoverUsage ? recoveredTaskMetrics(repoRoot, task.id, task.metadata.metrics) : task.metadata.metrics || null,
    outcome: task.metadata.outcome || null,
    git: task.metadata.git || null,
    attemptLedger,
    retryStats: attemptLedger.retryStats,
    preflight: task.metadata.preflight || null,
    pipeline: task.metadata.pipeline || null,
    execution: storedTaskExecution(repoRoot, task),
    codexThread: task.metadata.codexThread || null,
    interaction: task.metadata.interaction || null,
    pipelineContinuation: task.metadata.pipelineContinuation || null,
    reviewRequired: task.metadata.nextAttemptTrigger === "workspace_refresh",
    allowWorkerTaskCreation:
      task.metadata.allowWorkerTaskCreation === true,
    parentTaskId: task.metadata.parentTaskId || null,
    artifacts,
    artifactError,
    updatedAt,
  };
}

export function getTaskDetails(repoRoot, id) {
  const status = getTaskStatus(repoRoot, id);
  if (!status.path || !existsSync(status.path)) return status;
  try {
    return { ...status, body: readTask(status.path).body };
  } catch (error) {
    return { ...status, body: null, bodyError: error.message };
  }
}

export function listTaskStatuses(
  repoRoot,
  { includeClosed = false, limit = 100, recoverUsage = true } = {},
) {
  const active = listTaskFiles(repoRoot).map((file) =>
    getTaskStatus(repoRoot, taskIdFromFilename(path.basename(file)), { recoverUsage }),
  );
  if (!includeClosed) return active;

  const historyDir = path.join(todoDir(repoRoot), "history");
  const unlimited = limit === null;
  const closedNames = existsSync(historyDir)
    ? readdirSync(historyDir)
        .filter((name) => name.endsWith(".json"))
        .sort((left, right) =>
          left.localeCompare(right, undefined, { numeric: true }),
        )
        .reverse()
    : [];
  const selectedClosedNames = unlimited
    ? closedNames
    : closedNames.slice(0, Math.max(0, limit));
  const closed = selectedClosedNames
    .map((name) => {
      try {
        const record = readJson(path.join(historyDir, name));
        return recoverUsage ? { ...record, metrics: recoveredTaskMetrics(repoRoot, record.id, record.metrics) } : record;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const tasks = [...active, ...closed];
  return unlimited ? tasks : tasks.slice(0, limit);
}

function supervisorTaskCounts(tasks) {
  const counts = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }
  return counts;
}

function groupedTaskStatusCounts(counts = {}) {
  return {
    running: Number(counts.running || 0),
    queued: [
      "queued",
      "blocked",
      "staging",
      "merge-queued",
      "merge-conflict",
    ].reduce((total, status) => total + Number(counts[status] || 0), 0),
    failed: Number(counts.failed || 0),
  };
}

export function taskStatusSummary(tasks = []) {
  return groupedTaskStatusCounts(supervisorTaskCounts(tasks));
}

export function formatSupervisorThreadTitle(counts = {}) {
  const { running, queued, failed } = groupedTaskStatusCounts(counts);
  const waiting = Number(counts["waiting-input"] || 0);
  return `-> ToDo (${running}r / ${queued}q / ${failed}f${waiting ? ` / ${waiting}w` : ""})`;
}

export function formatTaskThreadTitle(repoRoot, task) {
  const number = String(task.id).split("-")[0];
  const title = task.title || titleFromBody(task.body || "", task.id);
  return `${path.basename(repoRoot)} [${number}]: ${title}`.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function supervisorDefinition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("supervisor definition must be an object");
  }
  const automationId = String(value.automationId || "").trim();
  const name = String(value.name || "").trim();
  const prompt = String(value.prompt || "").trim();
  const rrule = String(value.rrule || "").trim();
  const status = String(value.status || "").trim().toUpperCase();
  const targetThreadId =
    value.targetThreadId === undefined || value.targetThreadId === null
      ? null
      : String(value.targetThreadId).trim();
  if (!automationId || automationId.length > 200 || /[\r\n]/.test(automationId)) {
    throw new Error("supervisor automationId must be a single-line string");
  }
  if (!name || name.length > 200 || /[\r\n]/.test(name)) {
    throw new Error("supervisor name must be a single-line string");
  }
  if (!prompt || prompt.length > 20000) {
    throw new Error("supervisor prompt must be 1-20000 characters");
  }
  if (
    !rrule ||
    rrule.length > 1000 ||
    /[\r\n]/.test(rrule) ||
    !/^(?:RRULE:)?FREQ=/.test(rrule)
  ) {
    throw new Error("supervisor rrule must be a single RFC 5545 recurrence rule");
  }
  if (!new Set(["ACTIVE", "PAUSED"]).has(status)) {
    throw new Error("supervisor status must be ACTIVE or PAUSED");
  }
  if (
    targetThreadId !== null &&
    (!targetThreadId ||
      targetThreadId.length > 200 ||
      /[\r\n]/.test(targetThreadId))
  ) {
    throw new Error("supervisor targetThreadId must be a single-line string");
  }
  return {
    schemaVersion: 2,
    automationId,
    targetThreadId,
    name,
    prompt,
    rrule,
    status,
    updatedAt:
      typeof value.updatedAt === "string" &&
      Number.isFinite(Date.parse(value.updatedAt))
        ? new Date(value.updatedAt).toISOString()
        : new Date().toISOString(),
  };
}

export function getSupervisorStatus(repoRoot) {
  const file = supervisorConfigPath(repoRoot);
  const tasks = listTaskStatuses(repoRoot, { recoverUsage: false });
  const counts = supervisorTaskCounts(tasks);
  const desiredStatus = tasks.length > 0 ? "ACTIVE" : "PAUSED";
  let automation = null;
  let readError = null;
  if (existsSync(file)) {
    try {
      automation = supervisorDefinition(readJson(file));
    } catch (error) {
      readError = error.message;
    }
  }
  return {
    configured: automation !== null,
    path: file,
    automation,
    desiredStatus,
    actionRequired: !automation
      ? "configure"
      : !automation.targetThreadId
        ? "rebind"
        : automation.status === desiredStatus
          ? null
          : desiredStatus === "ACTIVE"
            ? "resume"
            : "pause",
    activeTasks: {
      total: tasks.length,
      counts,
    },
    threadTitle: formatSupervisorThreadTitle(counts),
    readError,
  };
}

export function bindSupervisor(repoRoot, value) {
  const file = supervisorConfigPath(repoRoot);
  const definition = supervisorDefinition(value);
  if (!definition.targetThreadId) {
    throw new Error("supervisor targetThreadId is required");
  }
  atomicWriteJson(file, definition);
  return getSupervisorStatus(repoRoot);
}

export function clearSupervisor(repoRoot) {
  const file = supervisorConfigPath(repoRoot);
  if (existsSync(file)) unlinkSync(file);
  return getSupervisorStatus(repoRoot);
}

function workerCounts(items) {
  const counts = {};
  for (const item of items) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }
  return counts;
}

export function listWorkerStatuses(repoRoot) {
  const config = loadConfig(repoRoot);
  const daemon = readDaemonState(repoRoot);
  if (
    daemon &&
    processIsAlive(daemon.pid) &&
    isCurrentDaemonState(daemon)
  ) {
    const configuredWorkers =
      Number.isInteger(daemon.workers) && daemon.workers > 0
        ? daemon.workers
        : config.workers;
    const taskStatuses = listTaskStatuses(repoRoot, { recoverUsage: false });
    const reported = Array.isArray(daemon.workerStates)
      ? daemon.workerStates
      : [];
    const byId = new Map(reported.map((worker) => [String(worker.id), worker]));
    const items = [];
    for (let id = 1; id <= configuredWorkers; id += 1) {
      const worker = byId.get(String(id));
      if (worker) {
        items.push(worker);
        continue;
      }
      const task = taskStatuses.find(
        (item) =>
          item.status === "running" &&
          String(item.claim?.workerId) === String(id),
      );
      items.push({
        id,
        status: task ? "busy" : "idle",
        runner: "node",
        pid: null,
        daemonPid: daemon.pid,
        taskId: task?.id || null,
        taskTitle: task?.title || null,
      });
    }
    for (const worker of reported) {
      if (Number(worker.id) <= configuredWorkers) continue;
      items.push({ ...worker, status: "draining" });
    }
    return {
      configured: configuredWorkers,
      runner: "node",
      counts: workerCounts(items),
      items,
    };
  }

  const legacyItems = findLegacyWorkers(repoRoot, config.workers);
  if (legacyItems.length > 0) {
    return {
      configured: config.workers,
      runner: "legacy",
      counts: workerCounts(legacyItems),
      items: legacyItems,
    };
  }

  const items = Array.from({ length: config.workers }, (_, index) => ({
    id: index + 1,
    status: "stopped",
    runner: null,
    pid: null,
    daemonPid: null,
    taskId: null,
    taskTitle: null,
  }));
  return {
    configured: config.workers,
    runner: null,
    counts: workerCounts(items),
    items,
  };
}

function ensureTaskGitMetadata(repoRoot, task) {
  if (task.metadata.git) return task.metadata.git;
  const config = loadConfig(repoRoot);
  const targetBranch = config.git.targetBranch || currentGitBranch(repoRoot);
  if (!targetBranch) {
    throw new Error(
      "Git target branch is unavailable; configure git.targetBranch",
    );
  }
  task.metadata.git = {
    branch: taskBranchName(task.id, titleFromBody(task.body, task.id)),
    targetBranch,
    delivery: config.git.delivery,
    remote: config.git.remote,
    push: false,
    phase: "queued",
  };
  task.metadata.attemptLedger = storedAttemptLedger(task);
  writeTask(task);
  return task.metadata.git;
}

function worktreePlan(repoRoot, task) {
  const git = ensureTaskGitMetadata(repoRoot, task);
  if (git.executionMode === "single-branch") return singleBranchPlan(repoRoot, task);
  return taskWorktreePlan({
    repoRoot,
    taskId: task.id,
    title: titleFromBody(task.body, task.id),
    targetBranch: git.targetBranch,
    delivery: git.delivery,
    branch: git.branch,
    push: git.push ?? false,
    remote: git.remote || DEFAULT_GIT_REMOTE,
  });
}

function publishSingleBranchRefresh(task, receipt) {
  const g = task.metadata.git;
  task.metadata.git = { ...g, baseCommit: receipt.toHead, phase: "working", ownedFiles: {}, reviewedRepositories: receipt.repositories,
    reviewFiles: [...new Set([...(g.reviewFiles || []), ...Object.keys(g.ownedFiles || {})])],
    headRecoveries: [...(g.headRecoveries || []), receipt] };
  for (const field of ["headCommit", "pendingResult", "deliveryResult", "deliveryError", "deliveryAttemptId", "noChanges"]) delete task.metadata.git[field];
  delete task.metadata.pipelineContinuation;
  task.metadata.error = null;
  task.metadata.outcome = null;
  task.metadata.nextAttemptTrigger = receipt.automatic ? "workspace_refresh" : "head_recovery";
  writeTask(task);
}
function refreshSingleBranchWorkspace(repoRoot, taskPath, error) {
  const task = readTask(taskPath);
  if (task.metadata.git?.executionMode !== "single-branch" ||
      !["single_branch_head_changed", "single_branch_unreviewed_changes"].includes(error.kind)) return false;
  recoverSingleBranchHead(singleBranchPlan(repoRoot, task), task, null,
    receipt => publishSingleBranchRefresh(task, receipt), { automatic: true, reason: error.message });
  return true;
}

export async function prepareTaskGit(repoRoot, taskPath) {
  const task = readTask(taskPath);
  const plan = worktreePlan(repoRoot, task);
  let prepared;
  let refreshed = false;
  try {
    prepared = plan.executionMode === "single-branch"
      ? prepareSingleBranch(plan, task.metadata.git?.baseCommit, task)
      : await prepareTaskWorktree(plan, { expectedBase: task.metadata.git?.baseCommit || null });
  } catch (error) {
    if (!refreshSingleBranchWorkspace(repoRoot, taskPath, error)) throw error;
    refreshed = true;
    prepared = { head: readTask(taskPath).metadata.git.baseCommit, reused: true };
  }
  const current = readTask(taskPath);
  const git = ensureTaskGitMetadata(repoRoot, current);
  if (git.baseCommit && git.baseCommit !== prepared.head) {
    throw new Error(
      `Task branch HEAD changed from ${git.baseCommit} to ${prepared.head}`,
    );
  }
  current.metadata.git = {
    ...git,
    phase: "working",
    ...(prepared.repositories && !git.reviewedRepositories ? { reviewedRepositories: prepared.repositories } : {}),
    worktreePath: plan.worktreePath,
    baseCommit: git.baseCommit || prepared.head,
  };
  writeTask(current);
  return {
    plan,
    worktreePath: plan.worktreePath,
    expectedHead: current.metadata.git.baseCommit,
    reused: prepared.reused,
    refreshed,
  };
}

export function recordTaskChangedFiles(repoRoot, taskPath, result) {
  const task = readTask(taskPath);
  if (task.metadata.git?.executionMode !== "single-branch") return;
  singleBranchFiles(repoRoot, task, result.changedFiles);
  writeTask(task);
}

export function markTaskModelCompleted(
  taskPath,
  claim,
  result,
  metrics,
  usagePath,
) {
  const task = readTask(taskPath);
  if (claim?.continuationOf) {
    const current = readJson(claim.lockPath);
    if (!current || current.token !== claim.token ||
        current.continuationOf !== claim.continuationOf ||
        !completedPipelineContinuation(task) ||
        storedAttemptLedger(task).attempts.at(-1).attemptId !== claim.continuationOf) {
      throw new Error("Pipeline continuation claim or completed implementation no longer matches");
    }
  }
  if (task.metadata.git?.executionMode === "single-branch" &&
      (result.changedFiles !== undefined || !task.metadata.git.ownedFiles)) {
    singleBranchFiles(path.dirname(path.dirname(taskPath)), task, result.changedFiles);
  }
  task.metadata.metrics = metrics;
  task.metadata.attemptLedger = appendClaimedAttempt(
    task,
    claim,
    "completed",
    null,
    metrics,
    usagePath,
  );
  task.metadata.outcome = "completed";
  delete task.metadata.nextAttemptTrigger;
  task.metadata.git = {
    ...ensureTaskGitMetadata(path.dirname(path.dirname(taskPath)), task),
    phase: "model-completed",
    pendingResult: {
      status: "completed",
      summary: result.summary,
      validation: result.validation,
    },
  };
  writeTask(task);
  return task.metadata.attemptLedger;
}

function deliveryTiming(startedAt, completedAt) {
  return {
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: Math.max(0, completedAt - startedAt),
  };
}

export function beginTaskDelivery(taskPath) {
  const task = readTask(taskPath);
  if (task.metadata.git.phase === "delivered") {
    return storedAttemptLedger(task).deliveryAttempts.at(-1)?.attemptId || null;
  }
  if (!TASK_GIT_FINALIZER_PHASES.has(task.metadata.git.phase)) {
    throw new Error(
      `Task delivery cannot start from phase ${task.metadata.git.phase}`,
    );
  }
  if (task.metadata.git.deliveryAttemptId) {
    return task.metadata.git.deliveryAttemptId;
  }
  const attemptId = randomUUID();
  task.metadata.git = { ...task.metadata.git, deliveryAttemptId: attemptId };
  writeTask(task);
  return attemptId;
}

export async function finalizeTaskGit(repoRoot, taskPath, usagePath = null) {
  const startedAt = Date.now();
  let deliveryAttemptId = null;
  try {
    let task = readTask(taskPath);
    const plan = worktreePlan(repoRoot, task);
    if (task.metadata.git.phase === "delivered") {
      return {
        result: task.metadata.git.pendingResult,
        delivery: task.metadata.git.deliveryResult,
        deliveryAttemptId:
          storedAttemptLedger(task).deliveryAttempts.at(-1)?.attemptId || null,
      };
    }
    deliveryAttemptId = beginTaskDelivery(taskPath);
    task = readTask(taskPath);
    if (task.metadata.git.phase === "model-completed") {
      if (plan.executionMode === "single-branch") prepareSingleBranch(plan, task.metadata.git.baseCommit);
      else await verifyTaskWorktreeHead(plan, task.metadata.git.baseCommit);
      task.metadata.git = { ...task.metadata.git, phase: "committing" };
      writeTask(task);
    }
    if (task.metadata.git.phase === "committing") {
      const committed = plan.executionMode === "single-branch"
        ? commitSingleBranch(plan, task)
        : await commitTaskWorktree(plan, {
        expectedHead: task.metadata.git.baseCommit,
        recoverCommittedHead: true,
      });
      task = readTask(taskPath);
      task.metadata.git = {
        ...task.metadata.git,
        phase: "committed",
        headCommit: committed.headCommit,
        noChanges: committed.changed === false,
      };
      writeTask(task);
    }
    task = readTask(taskPath);
    if (task.metadata.git.phase !== "committed") {
      throw new Error(
        `Task Git finalizer cannot run from phase ${task.metadata.git.phase}`,
      );
    }
    if (plan.executionMode === "single-branch") verifySingleBranchDelivery(plan, task);
    const pendingResult = task.metadata.git.pendingResult;
    if (plan.executionMode !== "single-branch" && task.metadata.git.delivery === "merge") {
      const queued = await queueTaskWorktreeForMerge(plan, task.metadata.git.headCommit);
      task = readTask(taskPath);
      task.metadata.git = {
        ...task.metadata.git,
        phase: "merge-queued",
        mergeQueuedAt: new Date().toISOString(),
        deliveryResult: queued,
      };
      task.metadata.outcome = "completed";
      writeTask(task);
      return {
        result: pendingResult,
        delivery: queued,
        deliveryAttemptId,
        mergeQueued: true,
      };
    }
    const delivery = plan.executionMode === "single-branch"
      ? { delivery: "current-branch", branch: plan.branch, worktreePath: plan.worktreePath, headCommit: task.metadata.git.headCommit, noChanges: task.metadata.git.noChanges }
      : await deliverTaskWorktree(plan, {
      headCommit: task.metadata.git.headCommit,
      noChanges: task.metadata.git.noChanges === true,
      baseCommit: task.metadata.git.baseCommit,
      title: titleFromBody(task.body, task.id),
      body: pendingResult?.summary || "",
      remote: task.metadata.git.remote || DEFAULT_GIT_REMOTE,
    });
    const completedAt = Date.now();
    task = readTask(taskPath);
    task.metadata.attemptLedger = appendDeliveryAttempt(
      storedAttemptLedger(task),
      {
        status: "completed",
        attemptId: deliveryAttemptId,
        timing: deliveryTiming(startedAt, completedAt),
        usagePath,
      },
    );
    const { deliveryAttemptId: _completedAttempt, ...completedGit } =
      task.metadata.git;
    task.metadata.git = {
      ...completedGit,
      phase: "delivered",
      deliveryResult: delivery,
    };
    task.metadata.outcome = "completed";
    writeTask(task);
    return { result: pendingResult, delivery, deliveryAttemptId };
  } catch (error) {
    try {
      if (existsSync(taskPath) && refreshSingleBranchWorkspace(repoRoot, taskPath, error)) {
        return { reviewRequired: true, reason: error.message };
      }
    } catch (recoveryError) {
      // Recovery may itself fail to snapshot a damaged checkout. Still record
      // delivery failure and let the caller release the finished executor claim.
      error = recoveryError;
    }
    const completedAt = Date.now();
    if (existsSync(taskPath)) {
      const task = readTask(taskPath);
      const failure = classifyFailure({
        errorKind: error.kind || "git_delivery",
        code: error.code,
        message: error.message,
      });
      task.metadata.attemptLedger = appendDeliveryAttempt(
        storedAttemptLedger(task),
        {
          status: failure.status,
          attemptId: deliveryAttemptId || undefined,
          errorKind: failure.errorKind,
          timing: deliveryTiming(startedAt, completedAt),
          usagePath,
        },
      );
      task.metadata.outcome = failure.status;
      const { deliveryAttemptId: _failedAttempt, ...failedGit } =
        task.metadata.git;
      task.metadata.git = {
        ...failedGit,
        deliveryError: String(error.message).slice(0, 4000),
      };
      task.metadata.error = { at: new Date(completedAt).toISOString(), kind: failure.errorKind,
        exit_code: Number.isInteger(error.code) ? error.code : null, message: String(error.message).slice(0, 4000) };
      writeTask(task);
      error.taskFailure = failure;
    }
    throw error;
  }
}

export async function processTaskMergeQueue(repoRoot, taskPath, usagePath = null, { onChild, signal, claim: ownerClaim } = {}) {
  const claim = ownerClaim || claimTask(taskPath, "merge-queue");
  assertTaskClaim(taskPath, claim);
  const startedAt = Date.now();
  let deliveryAttemptId = null;
  try {
    let task = readTask(taskPath);
    if (task.metadata.git?.phase !== "merge-queued") {
      throw new Error(`Task is not queued for merge: ${task.id}`);
    }
    deliveryAttemptId = beginTaskDelivery(taskPath);
    task = readTask(taskPath);
    const plan = worktreePlan(repoRoot, task);
    const result = await mergeQueuedTaskWorktree(
      plan,
      task.metadata.git.headCommit,
      { onDelivered: async result => {
        const completedAt = Date.now();
        task = readTask(taskPath);
        task.metadata.attemptLedger = appendDeliveryAttempt(
          storedAttemptLedger(task),
          {
            status: "completed",
            attemptId: deliveryAttemptId,
            timing: deliveryTiming(startedAt, completedAt),
            usagePath,
          },
        );
        const { deliveryAttemptId: _completedAttempt, ...completedGit } =
          task.metadata.git;
        task.metadata.git = {
          ...completedGit,
          phase: "delivered",
          headCommit: result.headCommit,
          deliveryResult: result,
        };
        delete task.metadata.git.mergeConflict;
        task.metadata.outcome = "completed";
        writeTask(task);
      }, onIntegrated: ({ headCommit }) => {
        const current = readTask(taskPath);
        current.metadata.git.headCommit = headCommit;
        writeTask(current);
      }, validate: task.metadata.pipeline ? async ({ headCommit, targetCommit, worktreePath }) => {
        const pipeline = loadPipelineSnapshot(repoRoot, task.metadata.pipeline);
        const directory = path.join(todoDir(repoRoot), "logs", task.id, `merge-validation-${deliveryAttemptId}`);
        mkdirSync(directory, { recursive: true });
        const receipts = [];
        for (const step of pipeline.steps.filter(step => step.type === "shell")) {
          const stdoutPath = path.join(directory, `${step.id}.stdout.log`);
          const stderrPath = path.join(directory, `${step.id}.stderr.log`);
          const receipt = await runShellCommand({ command: step.command,
            cwd: path.resolve(worktreePath, step.cwd), timeoutSeconds: step.timeoutSeconds,
            env: { ...process.env, TODO_RUNNER_WORKER: "1", TODO_RUNNER_REPO_ROOT: repoRoot, TODO_RUNNER_TASK_FILE: taskPath },
            stdoutPath, stderrPath, onChild, signal });
          receipts.push({ stepId: step.id, cwd: step.cwd, headCommit, targetCommit, ...receipt,
            stdoutPath: path.relative(repoRoot, stdoutPath), stderrPath: path.relative(repoRoot, stderrPath) });
          atomicWriteJson(path.join(directory, "validation.json"), { headCommit, targetCommit, pipelineDigest: pipeline.digest, receipts });
          if (receipt.status !== "completed") {
            const error = new Error(`Merge gate ${step.id} failed: ${receipt.error || receipt.stderrTail || receipt.stdoutTail || (receipt.timedOut ? "timeout" : receipt.exitCode)}`);
            error.kind = receipt.interrupted ? "interrupted" : "pipeline_validation";
            error.details = { ...receipts.at(-1), pipelineDigest: pipeline.digest,
              receiptPath: path.relative(repoRoot, path.join(directory, "validation.json")) };
            throw error;
          }
        }
        return { headCommit, pipelineDigest: pipeline.digest, gates: receipts.length,
          receiptPath: path.relative(repoRoot, path.join(directory, "validation.json")) };
      } : null },
    );
    if (result.status === "conflict") {
      task = readTask(taskPath);
      task.metadata.git = {
        ...task.metadata.git,
        phase: "merge-conflict",
        mergeConflict: {
          ...result,
          detectedAt: new Date().toISOString(),
        },
      };
      if (task.metadata.codexThread?.id) {
        task.metadata.codexThread = {
          ...task.metadata.codexThread,
          state:
            task.metadata.codexThread.state === "archived"
              ? "unarchive-pending"
              : task.metadata.codexThread.state,
        };
      }
      writeTask(task);
      return { status: "conflict", taskId: task.id, conflict: result };
    }

    task = readTask(taskPath);
    task.metadata.git.deliveryResult = result;
    writeTask(task);
    return {
      status: "merged",
      result: task.metadata.git.pendingResult,
      delivery: result,
      deliveryAttemptId,
    };
  } catch (error) {
    const completedAt = Date.now();
    if (existsSync(taskPath)) {
      const task = readTask(taskPath);
      if (task.metadata.git?.phase === "delivered") {
        return { status: "merged", result: task.metadata.git.pendingResult,
          delivery: { ...task.metadata.git.deliveryResult,
            cleanupWarnings: [...(task.metadata.git.deliveryResult?.cleanupWarnings || []), error.message] }, deliveryAttemptId };
      }
      const failure = classifyFailure({
        errorKind: error.kind || "git_delivery",
        code: error.code,
        message: error.message,
      });
      task.metadata.attemptLedger = appendDeliveryAttempt(
        storedAttemptLedger(task),
        {
          status: failure.status,
          attemptId: deliveryAttemptId || undefined,
          errorKind: failure.errorKind,
          timing: deliveryTiming(startedAt, completedAt),
          usagePath,
        },
      );
      const { deliveryAttemptId: _failedAttempt, ...failedGit } =
        task.metadata.git;
      task.metadata.git = {
        ...failedGit,
        phase: "merge-failed",
        ...(typeof error.details?.headCommit === "string"
          ? { headCommit: error.details.headCommit }
          : {}),
        ...(error.kind === "pipeline_validation" ? { mergeConflict: {
          ...error.details, kind: "pipeline_validation", message: String(error.message).slice(0, 4000),
          detectedAt: new Date().toISOString(),
        } } : {}),
        deliveryError: String(error.message).slice(0, 4000),
      };
      task.metadata.error = {
        at: new Date().toISOString(),
        kind: failure.errorKind,
        exit_code: null,
        message: String(error.message).slice(0, 4000),
      };
      task.metadata.outcome = failure.status;
      if (error.kind === "pipeline_validation" &&
          mergeRepairCount(task) < mergeRepairLimit(repoRoot, task)) {
        resumeTaskMergeRepair(repoRoot, task);
        writeTask(task);
        return { status: "conflict", taskId: task.id, conflict: task.metadata.git.mergeConflict };
      }
      if (error.kind === "pipeline_validation") task.metadata.git.mergeConflict.recovery =
        "Repair limit reached; use task_retry or task_run_start in the original thread for one further repair. Code and failed gate logs are retained.";
      writeTask(task);
      error.taskFailure = failure;
    }
    throw error;
  } finally {
    if (!ownerClaim) releaseClaim(claim);
  }
}

export async function finishTaskMergeConflictRepair(
  repoRoot,
  taskPath,
  claim,
  result,
  metrics,
  usagePath = null,
) {
  assertTaskClaim(taskPath, claim);
  let task = readTask(taskPath);
  if (task.metadata.git?.phase !== "merge-conflict") {
    throw new Error(`Task is not resolving a merge conflict: ${task.id}`);
  }
  const plan = worktreePlan(repoRoot, task);
  if (result.status !== "completed") {
    task = readTask(taskPath);
    const failure = classifyFailure({ errorKind: result.requiresInteractive ? "interactive_required" : result.errorKind || "merge_logical_conflict",
      message: result.error || result.summary, requiresInteractive: result.requiresInteractive });
    task.metadata.metrics = metrics;
    task.metadata.attemptLedger = appendClaimedAttempt(
      task,
      claim,
      failure.status,
      failure.errorKind,
      metrics,
      usagePath,
    );
    task.metadata.error = {
      at: new Date().toISOString(),
      kind: failure.errorKind,
      exit_code: null,
      message: String(result.error || result.summary).slice(0, 4000),
    };
    task.metadata.git = {
      ...task.metadata.git,
      phase: "merge-failed",
      deliveryError: task.metadata.error.message,
    };
    task.metadata.outcome = failure.status;
    task.metadata.git.mergeConflict.profileEscalated = false;
    if (result.requiresInteractive) {
      task.metadata.execution = { ...task.metadata.execution, mode: "interactive" };
      task.metadata.interaction = { state: "waiting-input", question: result.interactiveReason || result.error || result.summary,
        updatedAt: new Date().toISOString() };
    }
    writeTask(task);
    return { status: "failed", error: task.metadata.error };
  }

  let continued;
  try {
    continued = task.metadata.git.mergeConflict?.kind === "pipeline_validation"
      ? await commitTaskWorktree(plan, { expectedHead: task.metadata.git.headCommit,
          recoverCommittedHead: true, message: `todo(${task.id}): repair merge validation` })
      : await continueQueuedTaskRebase(plan, { expectedHead: task.metadata.git.headCommit });
  } catch (error) {
    return finishTaskMergeConflictRepair(repoRoot, taskPath, claim,
      { status: "failed", summary: error.message, error: error.message, errorKind: error.kind || "git_delivery" }, metrics, usagePath);
  }
  task = readTask(taskPath);
  task.metadata.metrics = metrics;
  task.metadata.attemptLedger = appendClaimedAttempt(
    task,
    claim,
    "completed",
    null,
    metrics,
    usagePath,
  );
  task.metadata.error = null;
  task.metadata.outcome = "completed";
  delete task.metadata.nextAttemptTrigger;
  task.metadata.git = {
    ...task.metadata.git,
    phase: continued.status === "conflict" ? "merge-conflict" : "merge-queued",
    headCommit: continued.headCommit || task.metadata.git.headCommit,
    mergeQueuedAt: new Date().toISOString(),
  };
  if (continued.status === "conflict") task.metadata.git.mergeConflict = continued;
  else delete task.metadata.git.mergeConflict;
  task.metadata.execution = { ...task.metadata.execution, mode: "background" };
  task.metadata.interaction = { ...task.metadata.interaction, state: "resolved", response: null };
  const previous = task.metadata.git.pendingResult || {
    status: "completed",
    summary: result.summary,
    validation: [],
  };
  task.metadata.git.pendingResult = {
    ...previous,
    validation: [
      ...(previous.validation || []),
      ...(result.validation || []).map((item) => `merge repair: ${item}`),
    ],
  };
  writeTask(task);
  return { status: "requeued", headCommit: continued.headCommit };
}

export function retryTask(
  repoRoot,
  id,
  { trigger = "manual_retry", acceptCurrentHead } = {},
) {
  if (!["automatic_retry", "manual_retry"].includes(trigger)) {
    throw new Error("retry trigger must be automatic_retry or manual_retry");
  }
  if (acceptCurrentHead !== undefined && (trigger !== "manual_retry" ||
      typeof acceptCurrentHead !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(acceptCurrentHead))) {
    throw new Error("acceptCurrentHead requires an explicit manual retry and a full reviewed commit SHA");
  }
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  if (existsSync(`${taskPath}.lock`)) throw new Error(`Task is running: ${id}`);
  const reservation = claimTask(taskPath, "task-retry", { recoverSingleBranch: acceptCurrentHead !== undefined ? "head" : trigger === "manual_retry" });
  try {
    const task = readTask(taskPath);
    const modelWasUnavailable = task.metadata.error?.kind === "model_unavailable";
    if (acceptCurrentHead !== undefined) {
      if (task.metadata.git?.executionMode !== "single-branch" || !task.metadata.git.baseCommit) {
        throw new Error("acceptCurrentHead is supported only for an already started single-branch task");
      }
      if (task.metadata.git.phase === "delivered" || task.metadata.interaction?.dispatching || task.metadata.interaction?.state === "waiting-input") {
        throw new Error("Cannot accept HEAD for a delivered task, waiting input, or an executor with an uncertain outcome");
      }
      recoverSingleBranchHead(singleBranchPlan(repoRoot, task), task, acceptCurrentHead,
        receipt => publishSingleBranchRefresh(task, receipt));
    } else {
      if (task.metadata.interaction?.state === "waiting-input") {
        throw new Error("Task is waiting for user input. Answer in the dashboard or continue with $todo:run.");
      }
      const repair = resumeTaskMergeRepair(repoRoot, task, { manual: trigger === "manual_retry" });
      task.metadata.error = null;
      const wasMergeFailed = task.metadata.git?.phase === "merge-failed";
      const modelRetry =
        !repair && !wasMergeFailed && !TASK_GIT_FINALIZER_PHASES.has(task.metadata.git?.phase) &&
        !completedPipelineContinuation(task) &&
        !(["head_recovery", "workspace_refresh"].includes(task.metadata.nextAttemptTrigger) && storedAttemptLedger(task).attempts.at(-1)?.status === "completed");
      if (wasMergeFailed && !repair) {
        task.metadata.git = {
          ...task.metadata.git,
          phase: "merge-queued",
          mergeQueuedAt: new Date().toISOString(),
        };
      }
      if (modelRetry) {
        const config = loadConfig(repoRoot);
        const current =
          task.metadata.execution || resolveTaskExecution(config, {});
        task.metadata.execution = modelWasUnavailable
          ? resolveSavedExecution({ ...config, modelCatalog: null }, current)
          : escalatedExecution(config, current);
        task.metadata.nextAttemptTrigger = trigger;
      }
      writeTask(task);
    }
  } finally { releaseClaim(reservation); }
  return getTaskStatus(repoRoot, id);
}

export function updateTaskCodexThread(taskPath, value) {
  const task = readTask(taskPath);
  task.metadata.codexThread = {
    ...(task.metadata.codexThread || {}),
    ...value,
  };
  writeTask(task);
  return task.metadata.codexThread;
}

export function listPendingThreadArchives(repoRoot) {
  const historyDir = path.join(todoDir(repoRoot), "history");
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(historyDir, name))
    .filter((file) => {
      try {
        const thread = readJson(file).codexThread;
        return Boolean(thread?.id) && thread.state !== "archived";
      } catch {
        return false;
      }
    });
}

export function markClosedTaskThreadArchived(receiptPath) {
  const receipt = readJson(receiptPath);
  receipt.codexThread = {
    ...receipt.codexThread,
    state: "archived",
    archivedAt: new Date().toISOString(),
  };
  atomicWriteJson(receiptPath, receipt);
  return receipt;
}

export function reopenTask(repoRoot, id) {
  try {
    const activeFilename = existingTaskFilename(repoRoot, id);
    const activePath = path.join(todoDir(repoRoot), activeFilename);
    if (existsSync(activePath)) throw new Error(`Task is already open: ${id}`);
  } catch (error) {
    if (error.message === `Task is already open: ${id}`) throw error;
  }
  const closedPath = existingHistoryPath(repoRoot, id);
  if (!existsSync(closedPath)) throw new Error(`Closed task does not exist: ${id}`);
  const receipt = readJson(closedPath);
  if (typeof receipt.taskBody !== "string" || !receipt.taskBody.trim()) {
    throw new Error(`Task cannot be reopened because its body was not retained: ${id}`);
  }
  if (!receipt.codexThread?.id) {
    throw new Error(`Task cannot be reopened because it has no Codex thread: ${id}`);
  }
  const reopenCount = (receipt.reopenCount || 0) + 1;
  const previousBranch = receipt.git?.branch;
  const continueKeptBranch =
    receipt.git?.delivery === "keep" &&
    typeof previousBranch === "string" &&
    spawnSync(
      "git",
      ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${previousBranch}`],
    ).status === 0;
  const targetBranch = continueKeptBranch
    ? previousBranch
    : receipt.git?.targetBranch || loadConfig(repoRoot).git.targetBranch;
  if (!targetBranch) throw new Error("Reopened task target branch is unavailable");
  const branch = receipt.git?.executionMode === "single-branch"
    ? taskBranchName(receipt.id, receipt.title)
    : `${previousBranch || `todo/${receipt.id}`}-reopen-${reopenCount}`;
  const task = {
    id: receipt.id,
    path: path.join(todoDir(repoRoot), `${receipt.id}.md`),
    body: receipt.taskBody,
    metadata: {
      version: 1,
      blockers: [],
      error: null,
      execution: receipt.execution,
      ...(receipt.pipeline ? { pipeline: receipt.pipeline } : {}),
      batchReady: true,
      codexThread: {
        ...receipt.codexThread,
        state:
          receipt.codexThread.state === "archived"
            ? "unarchive-pending"
            : "active",
      },
      attemptLedger: createAttemptLedger(),
      reopenCount,
      priorClosures: [...(receipt.priorClosures || []), receipt.closedAt],
      git: {
        branch,
        targetBranch,
        delivery: receipt.git?.delivery || loadConfig(repoRoot).git.delivery,
        remote: receipt.git?.remote || loadConfig(repoRoot).git.remote,
        push: receipt.git?.push ?? false,
        phase: "queued",
      },
    },
  };
  writeTask(task);
  unlinkSync(closedPath);
  return getTaskStatus(repoRoot, receipt.id);
}

export async function startInteractiveTask(repoRoot, id, { owner = null } = {}) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  const status = getTaskStatus(repoRoot, id);
  if (status.status === "running") {
    const saved = readClaim(`${taskPath}.lock`, { includeToken: true });
    if (owner?.threadId && owner.turnId && saved?.workerId === "interactive" &&
        saved.owner?.threadId === owner.threadId && saved.owner?.turnId === owner.turnId &&
        status.git?.worktreePath && existsSync(status.git.worktreePath)) {
      return {
        claimToken: saved.token, worktreePath: status.git.worktreePath,
        ...(status.git.phase === "merge-conflict" ? { mergeRepair: { ...status.git.mergeConflict,
          prompt: buildMergeConflictPrompt(readTask(taskPath), status.git.worktreePath, saved) } } : {}),
        expectedHead: status.git.mergeConflict?.currentHeadCommit || status.git.baseCommit, deliveryOnly: TASK_GIT_FINALIZER_PHASES.has(status.git.phase),
        pipelineStage: status.pipelineContinuation?.stage || null,
        requiresPipelineValidation: Boolean(status.pipeline),
        executionInstructions: singleBranchInstructions(readTask(taskPath), status.git.worktreePath), task: getTaskDetails(repoRoot, id),
      };
    }
    throw new Error(`Task is running: ${id}`);
  }
  if (status.existingBlockers?.length) {
    throw new Error(
      `Task is blocked by: ${status.existingBlockers.join(", ")}`,
    );
  }
  if (status.git?.phase === "merge-conflict" || (status.git?.phase === "merge-failed" &&
      (status.git.mergeConflict || status.error?.kind === "pipeline_validation"))) {
    if (!owner?.threadId || !owner.turnId || owner.threadId !== status.codexThread?.id) {
      throw new Error("Merge repair must continue in the original Codex thread with executor thread and turn metadata");
    }
    const claim = claimTask(taskPath, "interactive", { owner });
    try {
      const task = readTask(taskPath);
      if (task.metadata.interaction?.dispatching) throw new Error("An earlier execution has an uncertain outcome; resolve its owner before continuing");
      if (!resumeTaskMergeRepair(repoRoot, task, { manual: true })) throw new Error("Task merge state changed; refresh before continuing");
      task.metadata.interaction = { ...task.metadata.interaction, state: "running", owner, dispatching: false };
      task.metadata.execution = { ...task.metadata.execution, mode: "interactive" };
      writeTask(task);
      prepareTaskMergeConflictRepair(repoRoot, taskPath, claim);
      beginModelAttempt(taskPath, claim);
      const current = readTask(taskPath);
      return { claimToken: claim.token, worktreePath: current.metadata.git.worktreePath,
        expectedHead: current.metadata.git.mergeConflict.currentHeadCommit, deliveryOnly: false,
        mergeRepair: { ...current.metadata.git.mergeConflict,
          prompt: buildMergeConflictPrompt(current, current.metadata.git.worktreePath, claim) },
        pipelineStage: null, requiresPipelineValidation: true, task: getTaskDetails(repoRoot, id) };
    } catch (error) { releaseClaim(claim); throw error; }
  }
  if (status.git?.phase?.startsWith("merge-")) {
    throw new Error(
      `Task merge lifecycle is owned by the merge queue: ${id}`,
    );
  }

  let claim;
  const deliveryOnly = TASK_GIT_FINALIZER_PHASES.has(status.git?.phase);
  let continuation = status.pipelineContinuation;
  if (status.pipeline && !deliveryOnly && !continuation) {
    const pipeline = loadPipelineSnapshot(repoRoot, status.pipeline);
    const first = pipeline.steps[0];
    continuation = { digest: pipeline.digest, stage: first.type === "shell" ? null : first,
      nextIndex: first.type === "shell" ? 0 : 1, repairRound: 0, executions: [] };
  }
  try {
    claim = claimTask(taskPath, "interactive", {
      modelAttempt: !deliveryOnly,
      owner,
    });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Task is running: ${id}`);
    throw error;
  }
  try {
    if (!deliveryOnly) {
      const task = readTask(taskPath);
      task.metadata.execution = resolveSavedExecution(loadConfig(repoRoot), task.metadata.execution);
      task.metadata.interaction = {
        ...task.metadata.interaction, state: "running", owner, dispatching: false,
        question: null, updatedAt: new Date().toISOString(),
      };
      if (continuation) task.metadata.pipelineContinuation = continuation;
      writeTask(task);
    }
    const prepared = deliveryOnly
      ? {
          worktreePath: status.git.worktreePath,
          expectedHead: status.git.baseCommit,
        }
      : await prepareTaskGit(repoRoot, taskPath);
    if (prepared.refreshed) {
      const currentClaim = readJson(claim.lockPath);
      atomicWriteJson(claim.lockPath, { ...currentClaim, trigger: "workspace_refresh" });
      claim.trigger = "workspace_refresh";
      continuation = null;
      if (status.pipeline) {
        const pipeline = loadPipelineSnapshot(repoRoot, status.pipeline);
        const first = pipeline.steps[0];
        continuation = { digest: pipeline.digest, stage: first.type === "shell" ? null : first,
          nextIndex: first.type === "shell" ? 0 : 1, repairRound: 0, executions: [] };
        const current = readTask(taskPath);
        current.metadata.pipelineContinuation = continuation;
        writeTask(current);
      }
    }
    return {
      claimToken: claim.token,
      worktreePath: prepared.worktreePath,
      expectedHead: prepared.expectedHead,
      deliveryOnly,
      pipelineStage: continuation?.stage || null,
      requiresPipelineValidation: Boolean(status.pipeline),
      executionInstructions: singleBranchInstructions(readTask(taskPath), prepared.worktreePath),
      task: getTaskDetails(repoRoot, id),
    };
  } catch (error) {
    releaseClaim(claim);
    const completedAt = Date.now();
    const claimedAt = Date.parse(claim?.claimedAt);
    const failure = classifyFailure({
      errorKind: error.kind || "git_prepare",
      code: error.code,
      message: error.message,
    });
    const metrics = claim?.attemptId
      ? cumulativeTaskMetrics(
          status.metrics || null,
          taskMetrics(
            Number.isFinite(claimedAt) ? claimedAt : completedAt,
            completedAt,
            emptyTokenUsage(),
          ),
        )
      : status.metrics || null;
    setTaskError(
      taskPath,
      error.kind || "git_prepare",
      null,
      error.message,
      metrics,
      claim?.attemptId
        ? {
            claim,
            status: failure.status,
            errorKind: failure.errorKind,
            usagePath: null,
          }
        : null,
    );
    throw error;
  }
}

export async function finishInteractiveTask(
  repoRoot,
  id,
  {
    claimToken,
    status,
    summary,
    validation = [],
    changedFiles,
    error = null,
    owner = null,
  },
) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  const lockPath = `${taskPath}.lock`;
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  if (!existsSync(lockPath)) {
    throw new Error(`Interactive task is not running: ${id}`);
  }
  const currentClaim = readJson(lockPath);
  if (
    typeof claimToken !== "string" ||
    !claimToken ||
    currentClaim.token !== claimToken ||
    currentClaim.workerId !== "interactive"
  ) {
    throw new Error(`Interactive task claim does not match: ${id}`);
  }
  assertInteractiveOwner(currentClaim, owner);
  if (status !== "completed" && status !== "failed") {
    throw new Error("status must be completed or failed");
  }
  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error("summary must be a non-empty string");
  }
  if (
    !Array.isArray(validation) ||
    validation.some((item) => typeof item !== "string" || !item.trim()) ||
    (status === "completed" && validation.length === 0)
  ) {
    throw new Error(
      "validation must contain at least one concrete result for completed tasks",
    );
  }
  const task = readTask(taskPath);
  const deliveryOnly = TASK_GIT_FINALIZER_PHASES.has(task.metadata.git?.phase);
  const completedAt = Date.now();
  const claimedAt = Date.parse(currentClaim.claimedAt);
  const startedAt = Number.isFinite(claimedAt) ? claimedAt : completedAt;
  const metrics = deliveryOnly
    ? task.metadata.metrics || null
    : cumulativeTaskMetrics(
        task.metadata.metrics || null,
        taskMetrics(startedAt, completedAt, emptyTokenUsage()),
      );
  const claim = {
    lockPath,
    token: claimToken,
    attemptId: currentClaim.attemptId,
    attempt: currentClaim.attempt,
    trigger: currentClaim.trigger,
    retryOf: currentClaim.retryOf,
  };
  if (task.metadata.git?.phase === "merge-conflict") {
    try {
      await finishTaskMergeConflictRepair(repoRoot, taskPath, claim,
        { status, summary: summary.trim(), validation, error }, metrics);
    } catch (repairError) {
      setTaskError(taskPath, repairError.kind || "merge_repair", null, repairError.message, metrics,
        { claim, ...classifyFailure({ errorKind: repairError.kind, message: repairError.message }) });
      throw repairError;
    } finally { releaseClaim(claim); }
    return getTaskStatus(repoRoot, id);
  }
  if (
    task.metadata.codexThread?.id &&
    task.metadata.codexThread.state !== "archived"
  ) {
    updateTaskCodexThread(taskPath, { state: "archive-pending" });
  }
  try {
    if (status === "completed") {
      if (task.metadata.git?.executionMode === "single-branch" && (!deliveryOnly || changedFiles !== undefined)) {
        if (deliveryOnly) task.metadata.git.ownedFiles = {};
        singleBranchFiles(repoRoot, task, changedFiles);
        writeTask(task);
      }
      if (task.metadata.pipeline && !deliveryOnly) {
        // The app supplies a stage result; only the runner can pass pipeline
        // gates and authorize delivery. An app completion never bypasses them.
        const current = readTask(taskPath);
        current.metadata.metrics = metrics;
        current.metadata.attemptLedger = appendClaimedAttempt(current, claim, "completed", null, metrics, null);
        current.metadata.pipelineContinuation = {
          ...current.metadata.pipelineContinuation,
          attemptId: claim.attemptId,
          result: { status: "completed", summary: summary.trim(), validation, error: null,
            requiresInteractive: false, interactiveReason: null },
          ready: true,
        };
        current.metadata.interaction = { ...current.metadata.interaction, state: "resolved" };
        current.metadata.execution = { ...current.metadata.execution, mode: "background" };
        current.metadata.error = null;
        writeTask(current);
        releaseClaim(claim);
        return getTaskStatus(repoRoot, id);
      }
      if (!deliveryOnly) {
        markTaskModelCompleted(
          taskPath,
          claim,
          {
            status,
            summary: summary.trim(),
            validation: validation.map((item) => item.trim()).filter(Boolean),
          },
          metrics,
          null,
        );
      }
      let finalized;
      try {
        finalized = await finalizeTaskGit(repoRoot, taskPath);
      } catch (finalizeError) {
        setTaskError(
          taskPath,
          finalizeError.kind || "git_delivery",
          null,
          finalizeError.message,
          metrics,
        );
        throw finalizeError;
      }
      if (!finalized.mergeQueued && !finalized.reviewRequired) {
        completeTask(
          repoRoot,
          taskPath,
          finalized.result,
          metrics,
        );
      }
    } else {
      const failureMessage =
        typeof error === "string" && error.trim() ? error : summary;
      const failure = classifyFailure({
        message: failureMessage,
      });
      setTaskError(
        taskPath,
        failure.errorKind,
        null,
        failureMessage,
        metrics,
        deliveryOnly
          ? null
          : {
              claim,
              status: failure.status,
              errorKind: failure.errorKind,
              usagePath: null,
            },
      );
    }
  } finally {
    releaseClaim(claim);
  }
  return getTaskStatus(repoRoot, id);
}

function assertInteractiveOwner(claim, owner) {
  if (!claim.owner) return;
  if (!owner || owner.threadId !== claim.owner.threadId ||
      (claim.owner.turnId && owner.turnId !== claim.owner.turnId)) {
    throw new Error("Interactive claim belongs to another executor turn");
  }
}

function recordInteractivePause(task, claim) {
  if (!claim.attemptId) return;
  const now = Date.now();
  const startedAt = Date.parse(claim.claimedAt);
  task.metadata.metrics = cumulativeTaskMetrics(task.metadata.metrics || null,
    taskMetrics(Number.isFinite(startedAt) ? startedAt : now, now, emptyTokenUsage()));
  task.metadata.attemptLedger = appendClaimedAttempt(task, claim, "blocked_interactive", "interactive_required", task.metadata.metrics, null);
}

export function waitForTaskInput(repoRoot, id, { claimToken, question, owner = null }) {
  if (typeof question !== "string" || !question.trim() || question.length > 8000) {
    throw new Error("question must contain 1-8000 characters");
  }
  const file = path.join(todoDir(repoRoot), existingTaskFilename(repoRoot, id));
  const claim = readClaim(`${file}.lock`, { includeToken: true });
  if (!claim || claim.token !== claimToken || claim.workerId !== "interactive") {
    throw new Error("Interactive claim does not match");
  }
  assertInteractiveOwner(claim, owner);
  const task = readTask(file);
  recordInteractivePause(task, claim);
  task.metadata.interaction = { state: "waiting-input", question: question.trim(),
    nativeThreadId: task.metadata.interaction?.nativeThreadId || null,
    owner: claim.owner || null, updatedAt: new Date().toISOString() };
  task.metadata.execution = { ...storedTaskExecution(repoRoot, task), mode: "interactive" };
  writeTask(task);
  releaseClaim({ lockPath: `${file}.lock`, token: claim.token });
  return getTaskStatus(repoRoot, id);
}

export function reconcileInteractiveClaim(repoRoot, id, observed, expectedToken) {
  const file = path.join(todoDir(repoRoot), existingTaskFilename(repoRoot, id));
  const claim = readClaim(`${file}.lock`, { includeToken: true });
  if (!claim?.owner || claim.token !== expectedToken) return false;
  if (observed.thread?.id !== claim.owner.threadId) return false;
  const state = typeof observed.thread.status === "string" ? observed.thread.status : observed.thread.status?.type;
  // Never expire a live/unknown app run, even if its MCP process disappeared.
  if (!["idle", "notLoaded", "systemError"].includes(state)) return false;
  const turn = observed.turns?.find(item => item.id === claim.owner.turnId);
  if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return false;
  const task = readTask(file);
  recordInteractivePause(task, claim);
  task.metadata.interaction = { state: "waiting-input", owner: claim.owner,
    nativeThreadId: task.metadata.interaction?.nativeThreadId || null,
    question: "The executor turn ended without finishing this task. Continue in its chat or provide a new instruction.",
    updatedAt: new Date().toISOString() };
  task.metadata.execution = { ...storedTaskExecution(repoRoot, task), mode: "interactive" };
  writeTask(task);
  releaseClaim({ lockPath: `${file}.lock`, token: claim.token });
  return true;
}

export async function cancelTask(repoRoot, id) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  let claim;
  try {
    claim = claimTask(taskPath, "task-cancel");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Task is running: ${id}`);
    throw error;
  }
  try {
    const task = readTask(taskPath);
    if (task.metadata.git?.executionMode === "single-branch") {
      assertSingleBranchCancellation(worktreePlan(repoRoot, task));
    } else if (task.metadata.git) {
      const warnings = await cleanupTaskWorktree(worktreePlan(repoRoot, task), {
        deleteBranch: !TASK_GIT_FINALIZER_PHASES.has(task.metadata.git.phase),
      });
      if (warnings.length > 0) {
        throw new Error(`Task Git state was preserved: ${warnings.join("; ")}`);
      }
    }
    const attemptLedger = storedAttemptLedger(task);
    const codexThread = task.metadata.codexThread
      ? {
          ...task.metadata.codexThread,
          state:
            task.metadata.codexThread.state === "archived"
              ? "archived"
              : "archive-pending",
        }
      : null;
    writeHistory(repoRoot, task.id, {
      title: titleFromBody(task.body, task.id),
      status: "canceled",
      closedAt: new Date().toISOString(),
      execution: storedTaskExecution(repoRoot, task),
      codexThread,
      taskBody: task.body,
      metrics: task.metadata.metrics || null,
      outcome: "cancelled",
      git: task.metadata.git || null,
      attemptLedger,
      retryStats: attemptLedger.retryStats,
      preflight: task.metadata.preflight || null,
      pipeline: task.metadata.pipeline || null,
      allowWorkerTaskCreation:
        task.metadata.allowWorkerTaskCreation === true,
      parentTaskId: task.metadata.parentTaskId || null,
      artifacts: readTaskArtifacts(repoRoot, task.id),
      reopenCount: task.metadata.reopenCount || 0,
      priorClosures: task.metadata.priorClosures || [],
    });
    unlinkSync(taskPath);
    return readJson(historyPath(repoRoot, task.id));
  } finally {
    releaseClaim(claim);
  }
}

export function claimTask(
  taskPath,
  workerId,
  { modelAttempt = false, owner = null, recoverSingleBranch = false } = {},
) {
  const repoRoot = path.dirname(path.dirname(path.resolve(taskPath)));
  return withRepositoryExecution(repoRoot, (state, saveState) => {
    const config = loadConfig(repoRoot);
    if (config.readError) throw new Error(config.readError);
    if (existsSync(path.join(todoDir(repoRoot), ".daemon-restart.json"))) {
      const error = new Error("ToDo runtime update is pending");
      error.code = "EEXIST";
      error.kind = "runtime_update_pending";
      throw error;
    }
    let task;
    try { task = readTask(taskPath); }
    catch (error) {
      // Preserve the legacy raw claim primitive used by runtime coordination.
      if (config.git.executionMode === "worktree" && !state.reservation) return claimTaskUnlocked(taskPath, workerId, { modelAttempt, owner });
      throw error;
    }
    const administrative = ["task-update", "task-retry", "task-cancel"].includes(workerId);
    const started = task.metadata.git?.executionMode || task.metadata.git?.worktreePath || task.metadata.git?.baseCommit || (task.metadata.git?.phase && task.metadata.git.phase !== "queued") || task.metadata.attemptLedger?.attempts?.length || task.metadata.metrics?.attempts;
    const mode = state.reservation?.taskPath === path.join(realpathSync(repoRoot), ".todo", path.basename(taskPath))
      ? "single-branch" : started ? task.metadata.git?.executionMode || "worktree" : config.git.executionMode;
    if (mode === "single-branch" && (task.metadata.git?.delivery === "pr" || task.metadata.git?.push)) {
      throw new Error("single-branch supports local current-branch completion only; PR/push delivery cannot be migrated automatically");
    }
    reserveSingleBranch(repoRoot, taskPath, mode, state, { administrative, recover: recoverSingleBranch });
    saveState(state); // Reserve durably before publishing a claim or touching task metadata.
    const claim = claimTaskUnlocked(taskPath, workerId, { modelAttempt, owner });
    try {
      if (!administrative && (!started || (mode === "single-branch" && !task.metadata.git?.executionMode))) {
        const identity = mode === "single-branch" ? singleBranchIdentity(repoRoot) : null;
        task.metadata.git = { ...ensureTaskGitMetadata(repoRoot, task), executionMode: mode,
          ...(identity ? { branch: identity.branch, targetBranch: identity.branch, worktreePath: identity.root } : {}) };
        writeTask(task);
      }
      saveState(state);
      return claim;
    } catch (error) { unlinkSync(claim.lockPath); throw error; }
  });
}

function claimTaskUnlocked(taskPath, workerId, { modelAttempt, owner }) {
  const repoRoot = path.dirname(path.dirname(path.resolve(taskPath)));
  const batchGate = acquireTaskBatchGate(repoRoot, {
    purpose: "task-claim",
    task: path.basename(taskPath),
  });
  const lockPath = `${taskPath}.lock`;
  const token = randomUUID();
  const claimedAt = new Date().toISOString();
  let attemptFields = {};
  let fd;
  try {
    if (modelAttempt) {
      const task = readTask(taskPath);
      const ledger = storedAttemptLedger(task);
      const previous = ledger.attempts.at(-1) || null;
      attemptFields = {
        attemptId: randomUUID(),
        attempt: ledger.attempts.length + 1,
        trigger: nextAttemptTrigger(task),
        retryOf: previous?.attemptId || null,
      };
    }
    fd = openSync(lockPath, "wx");
    writeFileSync(
      fd,
      `${JSON.stringify({
        token,
        pid: process.pid,
        workerId,
        task: path.basename(taskPath),
        claimedAt,
        ...(owner ? { owner } : {}),
        ...attemptFields,
      })}\n`,
      "utf8",
    );
    return { lockPath, token, claimedAt, ...attemptFields };
  } finally {
    if (fd !== undefined) closeSync(fd);
    releaseTaskBatchGate(batchGate);
  }
}

export function beginModelAttempt(taskPath, claim) {
  if (!claim?.lockPath || !claim.token) {
    throw new Error("A live task claim is required");
  }
  const currentClaim = readJson(claim.lockPath);
  if (!currentClaim || currentClaim.token !== claim.token) {
    throw new Error("Task claim is no longer owned by this worker");
  }
  if (currentClaim.attemptId) {
    Object.assign(claim, {
      attemptId: currentClaim.attemptId,
      attempt: currentClaim.attempt,
      trigger: currentClaim.trigger,
      retryOf: currentClaim.retryOf,
    });
    return claim;
  }
  const task = readTask(taskPath);
  const ledger = storedAttemptLedger(task);
  const previous = ledger.attempts.at(-1) || null;
  const attemptFields = {
    attemptId: randomUUID(),
    attempt: ledger.attempts.length + 1,
    trigger: nextAttemptTrigger(task),
    retryOf: previous?.attemptId || null,
  };
  if (task.metadata.git?.phase === "merge-conflict") {
    const kind = mergeRepairKind(task);
    task.metadata.git.mergeRepairAttempts = { ...task.metadata.git.mergeRepairAttempts,
      [kind]: mergeRepairCount(task) + 1 };
    writeTask(task);
  }
  atomicWriteJson(claim.lockPath, { ...currentClaim, ...attemptFields });
  Object.assign(claim, attemptFields);
  return claim;
}

export function releaseClaim(claim) {
  if (!claim || !existsSync(claim.lockPath)) return;
  try {
    const current = readJson(claim.lockPath);
    if (current.token !== claim.token) return;
  } catch {
    return;
  }
  const taskPath = claim.lockPath.slice(0, -5);
  const repoRoot = path.dirname(path.dirname(taskPath));
  withRepositoryExecution(repoRoot, (state, saveState) => {
    // Fence release and checkpoint with the same lock used to acquire ownership.
    if (readJson(claim.lockPath)?.token !== claim.token) return;
    const completed = !existsSync(taskPath) && existsSync(historyPath(repoRoot, taskIdFromFilename(path.basename(taskPath))));
    checkpointSingleBranch(repoRoot, taskPath, state, completed);
    saveState(state);
    unlinkSync(claim.lockPath);
  });
}

export function cleanupStaleClaims(repoRoot) {
  return withRepositoryExecution(repoRoot, state => activeSingleBranchExecutors(state).length ? [] : cleanupStaleClaimsUnlocked(repoRoot));
}

function cleanupStaleClaimsUnlocked(repoRoot) {
  const removed = [];
  for (const taskPath of listTaskFiles(repoRoot)) {
    const lockPath = `${taskPath}.lock`;
    if (!existsSync(lockPath)) continue;
    try {
      const claim = readClaim(lockPath);
      // Native app ownership outlives an MCP process. The app's turn state,
      // checked by the daemon, is authoritative for these claims.
      if (claim?.owner?.threadId) continue;
      if (claim?.pid && !processIsAlive(claim.pid)) {
        if (claim.attemptId) {
          const task = readTask(taskPath);
          const recorded = storedAttemptLedger(task).attempts.some(
            (attempt) => attempt.attemptId === claim.attemptId,
          );
          if (!recorded) {
            const completedAt = Date.now();
            const claimedAt = Date.parse(claim.claimedAt);
            const metrics = cumulativeTaskMetrics(
              task.metadata.metrics || null,
              taskMetrics(
                Number.isFinite(claimedAt) ? claimedAt : completedAt,
                completedAt,
                emptyTokenUsage(),
              ),
            );
            setTaskError(
              taskPath,
              "interrupted",
              null,
              "Task worker exited before recording its result",
              metrics,
              {
                claim,
                status: "failed_transient",
                errorKind: "interrupted",
                usagePath: null,
              },
            );
          }
        }
        const task = readTask(taskPath);
        if (task.metadata.codexThread?.id) {
          updateTaskCodexThread(taskPath, { state: "archive-pending" });
        }
        unlinkSync(lockPath);
        removed.push(path.basename(lockPath));
      }
    } catch {
      // Unknown claim formats are left untouched.
    }
  }
  return removed;
}

export function setTaskError(
  taskPath,
  kind,
  exitCode,
  message,
  metrics = null,
  attemptContext = null,
) {
  if (!existsSync(taskPath)) return;
  const task = readTask(taskPath);
  task.metadata.error = {
    at: new Date().toISOString(),
    kind,
    exit_code: Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : null,
    message: String(message || "Task execution failed").trim().slice(0, 4000),
  };
  if (metrics) task.metadata.metrics = metrics;
  const failure = attemptContext?.status
    ? {
        status: attemptContext.status,
        errorKind: attemptContext.errorKind || kind,
      }
    : classifyFailure({ errorKind: kind, code: exitCode, message });
  task.metadata.outcome = failure.status;
  if (attemptContext?.claim?.attemptId) {
    try {
      task.metadata.attemptLedger = appendClaimedAttempt(
        task,
        attemptContext.claim,
        failure.status,
        failure.errorKind,
        metrics,
        attemptContext.usagePath,
      );
    } catch (error) {
      // A rejected ledger transition must not erase the original task failure.
      // Keep the immutable history and expose the secondary recording failure.
      task.metadata.error.attemptLedgerError = String(error.message).slice(0, 4000);
    }
    delete task.metadata.nextAttemptTrigger;
  }
  writeTask(task);
}

export function completeTask(repoRoot, taskPath, result, metrics = null) {
  const task = readTask(taskPath);
  writeHistory(repoRoot, task.id, {
    title: titleFromBody(task.body, task.id),
    status: "completed",
    closedAt: metrics?.completedAt || new Date().toISOString(),
    execution: storedTaskExecution(repoRoot, task),
    codexThread: task.metadata.codexThread || null,
    interaction: task.metadata.interaction || null,
    taskBody: task.body,
    metrics,
    outcome: task.metadata.outcome || "completed",
    git: task.metadata.git || null,
    attemptLedger: task.metadata.attemptLedger || createAttemptLedger(),
    retryStats:
      task.metadata.attemptLedger?.retryStats ||
      createAttemptLedger().retryStats,
    preflight: task.metadata.preflight || null,
    pipeline: task.metadata.pipeline || null,
    summary: result.summary,
    validation: result.validation,
    allowWorkerTaskCreation:
      task.metadata.allowWorkerTaskCreation === true,
    parentTaskId: task.metadata.parentTaskId || null,
    artifacts: readTaskArtifacts(repoRoot, task.id),
    reopenCount: task.metadata.reopenCount || 0,
    priorClosures: task.metadata.priorClosures || [],
  });
  unlinkSync(taskPath);
  return readJson(historyPath(repoRoot, task.id));
}
