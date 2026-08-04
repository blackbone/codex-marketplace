import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ensureRepoRoutingPolicy } from "./routing-policy.mjs";

export const DEFAULT_WORKERS = 4;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_CONFIG_RELOAD_INTERVAL_MS = 5000;
export const DEFAULT_DASHBOARD_PORT = 0;
export const DEFAULT_RETRIES = 0;
export const DAEMON_IMPLEMENTATION = "todo";
export const DAEMON_PROTOCOL_VERSION = 2;
export const DEFAULT_MODEL_PROFILES = [
  {
    name: "fast",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    description: "Focused, low-risk implementation work.",
  },
  {
    name: "expert",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    description: "Complex or cross-cutting implementation work.",
  },
];
export const DEFAULT_MODEL_PROFILE = "expert";
export const DEFAULT_ROUTING_MODE = "all-mutations";
export const DEFAULT_CONFIG = {
  workers: DEFAULT_WORKERS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  configReloadIntervalMs: DEFAULT_CONFIG_RELOAD_INTERVAL_MS,
  dashboardPort: DEFAULT_DASHBOARD_PORT,
  retries: DEFAULT_RETRIES,
  gitExclude: [".todo/"],
  models: DEFAULT_MODEL_PROFILES,
  defaultModelProfile: DEFAULT_MODEL_PROFILE,
  routingMode: DEFAULT_ROUTING_MODE,
};
export const TASK_NAME_PATTERN =
  /^[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const HEADER_PATTERN = /^<!-- TODO (\{.*\}) -->$/;
const MODEL_PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXTERNAL_SERVICE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXTERNAL_AI_DISCLOSURE_PATTERN =
  /(?:\bai\b|codex|ии|искусственн(?:ый|ым|ого)\s+интеллект)/iu;
const TASK_RUN_MODES = new Set(["background", "interactive"]);
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
const MAX_EXTERNAL_WORKFLOWS = 16;
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

export function todoDir(repoRoot) {
  return path.join(repoRoot, ".todo");
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
  if (!Array.isArray(value) || value.length === 0) {
    return { profiles: DEFAULT_MODEL_PROFILES, warning: null };
  }
  const profiles = [];
  const names = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        profiles: DEFAULT_MODEL_PROFILES,
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
        profiles: DEFAULT_MODEL_PROFILES,
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
      gitExclude: [],
      codexCommand: "codex",
      codexSandbox: "workspace-write",
      modelProfiles: DEFAULT_MODEL_PROFILES,
      defaultModelProfile: DEFAULT_MODEL_PROFILE,
      routingMode: DEFAULT_ROUTING_MODE,
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
  const normalizedProfiles = normalizeModelProfiles(raw.models);
  if (normalizedProfiles.warning) {
    warning = warning
      ? `${warning}; ${normalizedProfiles.warning}`
      : normalizedProfiles.warning;
  }
  const configuredDefault =
    typeof raw.defaultModelProfile === "string"
      ? raw.defaultModelProfile.trim()
      : DEFAULT_MODEL_PROFILE;
  const defaultModelProfile = normalizedProfiles.profiles.some(
    (profile) => profile.name === configuredDefault,
  )
    ? configuredDefault
    : normalizedProfiles.profiles[0].name;
  if (configuredDefault && configuredDefault !== defaultModelProfile) {
    warning = warning
      ? `${warning}; defaultModelProfile is not present in models`
      : "defaultModelProfile is not present in models";
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

  return {
    activated: true,
    workers: integerInRange(raw.workers, 1, 32, DEFAULT_WORKERS),
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
    gitExclude,
    codexCommand:
      typeof raw.codexCommand === "string" && raw.codexCommand.trim()
        ? raw.codexCommand.trim()
        : "codex",
    codexSandbox: sandboxes.has(raw.codexSandbox)
      ? raw.codexSandbox
      : "workspace-write",
    modelProfiles: normalizedProfiles.profiles,
    defaultModelProfile,
    routingMode,
    warning,
    readError,
  };
}

export function emptyTokenUsage() {
  return {
    available: false,
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
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
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    ...durationFields(Math.max(0, completedAt - startedAt)),
    tokenUsage,
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
    startedAt: new Date(resolvedStartedMs).toISOString(),
    completedAt: new Date(completedMs).toISOString(),
    ...durationFields(durationMs),
    tokenUsage: run.tokenUsage || emptyTokenUsage(),
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
      tokenUsage: metrics.tokenUsage || emptyTokenUsage(),
      legacyAggregate: true,
    },
  ];
}

export function cumulativeTaskMetrics(previous, attempt) {
  const normalizedAttempt = normalizedMetricRun(attempt);
  if (!normalizedAttempt) throw new Error("invalid task run metrics");
  const previousRuns = metricRuns(previous);
  const previousUsage = previous?.tokenUsage || emptyTokenUsage();
  const tokenUsage = {
    available:
      previousUsage.available === true ||
      normalizedAttempt.tokenUsage.available === true,
    turns:
      (Number(previousUsage.turns) || 0) +
      (Number(normalizedAttempt.tokenUsage.turns) || 0),
    inputTokens:
      (Number(previousUsage.inputTokens) || 0) +
      (Number(normalizedAttempt.tokenUsage.inputTokens) || 0),
    cachedInputTokens:
      (Number(previousUsage.cachedInputTokens) || 0) +
      (Number(normalizedAttempt.tokenUsage.cachedInputTokens) || 0),
    outputTokens:
      (Number(previousUsage.outputTokens) || 0) +
      (Number(normalizedAttempt.tokenUsage.outputTokens) || 0),
    reasoningOutputTokens:
      (Number(previousUsage.reasoningOutputTokens) || 0) +
      (Number(normalizedAttempt.tokenUsage.reasoningOutputTokens) || 0),
    totalTokens: 0,
  };
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

export function canAutoRetry(config, metrics) {
  const attempts = Number(metrics?.attempts) || 0;
  return (
    attempts > 0 &&
    (config.retries === -1 || attempts <= config.retries)
  );
}

export function resolveTaskExecution(
  config,
  { modelProfile, ephemeral, runMode } = {},
) {
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
  if (ephemeral !== undefined && typeof ephemeral !== "boolean") {
    throw new Error("ephemeral must be a boolean");
  }
  if (runMode !== undefined && !TASK_RUN_MODES.has(runMode)) {
    throw new Error("runMode must be background or interactive");
  }
  return {
    modelProfile: profile.name,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    ephemeral: ephemeral !== false,
    mode: runMode || "background",
  };
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

  const taskStatuses = listTaskStatuses(repoRoot);
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

export function readClaim(lockPath) {
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
    source: raw.token ? "node" : "legacy",
    pid: Number.isInteger(pidValue) ? pidValue : null,
    workerId,
    taskId: task ? taskIdFromFilename(task) : null,
    claimedAt: raw.claimedAt ?? raw.started_at ?? null,
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

function externalText(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${name} must not exceed ${maxLength} characters`);
  }
  return normalized;
}

function externalUrl(value, name) {
  if (value === undefined || value === null) return null;
  const normalized = externalText(value, name, 8000);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.toString();
}

function externalReferenceKey(value) {
  return `${value.service}:${value.resourceId}`;
}

function normalizeExternalWorkflows(value = []) {
  if (!Array.isArray(value)) {
    throw new Error("externalWorkflows must be an array");
  }
  if (value.length > MAX_EXTERNAL_WORKFLOWS) {
    throw new Error(
      `externalWorkflows must not contain more than ${MAX_EXTERNAL_WORKFLOWS} items`,
    );
  }
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("externalWorkflows items must be objects");
    }
    const allowed = new Set(["service", "resourceId", "url", "label"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) {
      throw new Error("externalWorkflows item contains unsupported fields");
    }
    const service = externalText(
      item.service,
      "external workflow service",
      100,
    ).toLowerCase();
    if (!EXTERNAL_SERVICE_PATTERN.test(service)) {
      throw new Error(
        "external workflow service must be lowercase kebab-case",
      );
    }
    const resourceId = externalText(
      item.resourceId,
      "external workflow resourceId",
      512,
    );
    const normalized = {
      service,
      resourceId,
      ...(item.url === undefined
        ? {}
        : { url: externalUrl(item.url, "external workflow url") }),
      ...(item.label === undefined
        ? {}
        : {
            label: externalText(
              item.label,
              "external workflow label",
              200,
            ),
          }),
    };
    const key = externalReferenceKey(normalized);
    if (seen.has(key)) {
      throw new Error(`duplicate external workflow reference: ${key}`);
    }
    seen.add(key);
    return normalized;
  });
}

function normalizeExternalSync(value, expectedWorkflows) {
  if (!Array.isArray(value)) {
    throw new Error("externalSync must be an array");
  }
  const expected = normalizeExternalWorkflows(expectedWorkflows);
  if (value.length !== expected.length) {
    throw new Error(
      "externalSync must contain one status/comment receipt for every external workflow",
    );
  }
  const expectedKeys = new Set(expected.map(externalReferenceKey));
  const seen = new Set();
  const normalized = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("externalSync items must be objects");
    }
    const allowed = new Set([
      "service",
      "resourceId",
      "startedStatus",
      "finalStatus",
      "commentId",
      "commentUrl",
      "commentText",
      "aiDisclosure",
      "syncedAt",
    ]);
    if (Object.keys(item).some((key) => !allowed.has(key))) {
      throw new Error("externalSync item contains unsupported fields");
    }
    const service = externalText(
      item.service,
      "external sync service",
      100,
    ).toLowerCase();
    if (!EXTERNAL_SERVICE_PATTERN.test(service)) {
      throw new Error("external sync service must be lowercase kebab-case");
    }
    const resourceId = externalText(
      item.resourceId,
      "external sync resourceId",
      512,
    );
    const key = externalReferenceKey({ service, resourceId });
    if (!expectedKeys.has(key)) {
      throw new Error(`unexpected external sync reference: ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`duplicate external sync reference: ${key}`);
    }
    seen.add(key);
    const commentText = externalText(
      item.commentText,
      "external sync commentText",
      8000,
    );
    if (item.aiDisclosure !== true) {
      throw new Error("external sync aiDisclosure must be true");
    }
    if (!EXTERNAL_AI_DISCLOSURE_PATTERN.test(commentText)) {
      throw new Error(
        "external sync commentText must explicitly identify Codex or AI/ИИ",
      );
    }
    const syncedAt =
      item.syncedAt === undefined
        ? null
        : externalText(item.syncedAt, "external sync syncedAt", 100);
    if (syncedAt !== null && !validMetricTimestamp(syncedAt)) {
      throw new Error("external sync syncedAt must be an ISO timestamp");
    }
    return {
      service,
      resourceId,
      startedStatus: externalText(
        item.startedStatus,
        "external sync startedStatus",
        200,
      ),
      finalStatus: externalText(
        item.finalStatus,
        "external sync finalStatus",
        200,
      ),
      commentId: externalText(
        item.commentId,
        "external sync commentId",
        512,
      ),
      commentUrl:
        item.commentUrl === undefined || item.commentUrl === null
          ? null
          : externalUrl(item.commentUrl, "external sync commentUrl"),
      commentText,
      aiDisclosure: true,
      ...(syncedAt === null ? {} : { syncedAt }),
    };
  });
  if (seen.size !== expectedKeys.size) {
    throw new Error("externalSync does not cover every external workflow");
  }
  return normalized;
}

export function normalizeExternalTaskOutcome(
  expectedWorkflows,
  {
    status,
    externalSync = [],
    externalSyncError = null,
  } = {},
) {
  if (status !== "completed" && status !== "failed") {
    throw new Error("status must be completed or failed");
  }
  if (!Array.isArray(externalSync)) {
    throw new Error("externalSync must be an array");
  }

  const workflows = normalizeExternalWorkflows(expectedWorkflows);
  let normalizedExternalSync = [];
  let normalizedExternalSyncError = null;
  if (workflows.length > 0) {
    if (externalSync.length > 0) {
      const syncedAt = new Date().toISOString();
      normalizedExternalSync = normalizeExternalSync(
        externalSync,
        workflows,
      ).map((item) => ({ ...item, syncedAt }));
    }
    if (externalSyncError !== null && externalSyncError !== undefined) {
      normalizedExternalSyncError = externalText(
        externalSyncError,
        "externalSyncError",
        4000,
      );
    }
    if (status === "completed" && normalizedExternalSync.length === 0) {
      throw new Error(
        "external workflow task cannot complete without status and AI-attributed comment receipts",
      );
    }
    if (
      status === "failed" &&
      normalizedExternalSync.length === 0 &&
      normalizedExternalSyncError === null
    ) {
      throw new Error(
        "failed external workflow task requires externalSync receipts or externalSyncError",
      );
    }
    if (status === "completed" && normalizedExternalSyncError !== null) {
      throw new Error(
        "completed external workflow task cannot include externalSyncError",
      );
    }
  } else if (
    externalSync.length > 0 ||
    (externalSyncError !== null && externalSyncError !== undefined)
  ) {
    throw new Error(
      "externalSync is only valid for tasks with externalWorkflows",
    );
  }

  return {
    externalSync: normalizedExternalSync,
    externalSyncError: normalizedExternalSyncError,
  };
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
  const keys = Object.keys(metadata).sort();
  const allowedKeys = new Set([
    "version",
    "blockers",
    "error",
    "execution",
    "externalSync",
    "externalSyncError",
    "externalWorkflows",
    "metrics",
  ]);
  if (
    !["version", "blockers", "error"].every((key) => keys.includes(key)) ||
    keys.some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(
      "task metadata contains unsupported fields",
    );
  }
  if (metadata.version !== 1 || !Array.isArray(metadata.blockers)) {
    throw new Error("unsupported metadata");
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
      !REASONING_EFFORTS.has(execution.reasoningEffort) ||
      typeof execution.ephemeral !== "boolean" ||
      (execution.mode !== undefined && !TASK_RUN_MODES.has(execution.mode))
    ) {
      throw new Error("invalid execution metadata");
    }
  }
  const externalWorkflows = normalizeExternalWorkflows(
    metadata.externalWorkflows || [],
  );
  if (metadata.externalSync !== undefined) {
    metadata.externalSync = normalizeExternalSync(
      metadata.externalSync,
      externalWorkflows,
    );
  }
  if (metadata.externalSyncError !== undefined) {
    metadata.externalSyncError = externalText(
      metadata.externalSyncError,
      "externalSyncError",
      4000,
    );
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
    externalWorkflows = [],
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
  if (
    !Array.isArray(blockers) ||
    !Array.isArray(acceptanceCriteria) ||
    !Array.isArray(artifacts) ||
    !Array.isArray(externalWorkflows)
  ) {
    throw new Error(
      "blockers, acceptanceCriteria, artifacts, and externalWorkflows must be arrays",
    );
  }

  ensureLayout(repoRoot);
  const normalizedExternalWorkflows =
    normalizeExternalWorkflows(externalWorkflows);
  const blockerFiles = [
    ...new Set(blockers.map((item) => resolveBlocker(repoRoot, item))),
  ];
  const execution = resolveTaskExecution(loadConfig(repoRoot), {
    modelProfile,
    ephemeral,
    runMode,
  });
  const metadata = {
    version: 1,
    blockers: blockerFiles,
    error: null,
    execution,
    ...(normalizedExternalWorkflows.length === 0
      ? {}
      : { externalWorkflows: normalizedExternalWorkflows }),
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
      task.metadata = metadata;
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
  { body, blockers, modelProfile, ephemeral, externalWorkflows } = {},
) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  if (
    body === undefined &&
    blockers === undefined &&
    modelProfile === undefined &&
    ephemeral === undefined &&
    externalWorkflows === undefined
  ) {
    throw new Error(
      "task update requires body, blockers, modelProfile, ephemeral, or externalWorkflows",
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
  if (externalWorkflows !== undefined && !Array.isArray(externalWorkflows)) {
    throw new Error("externalWorkflows must be an array");
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
    if (externalWorkflows !== undefined) {
      task.metadata.externalWorkflows = normalizeExternalWorkflows(
        externalWorkflows,
      );
      delete task.metadata.externalSync;
      delete task.metadata.externalSyncError;
    }
    if (modelProfile !== undefined || ephemeral !== undefined) {
      const currentExecution =
        task.metadata.execution ||
        resolveTaskExecution(loadConfig(repoRoot), {});
      task.metadata.execution = resolveTaskExecution(loadConfig(repoRoot), {
        modelProfile:
          modelProfile === undefined
            ? currentExecution.modelProfile
            : modelProfile,
        ephemeral:
          ephemeral === undefined ? currentExecution.ephemeral : ephemeral,
        runMode: currentExecution.mode || "background",
      });
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

export function writeHistory(repoRoot, id, value) {
  atomicWriteJson(historyPath(repoRoot, id), {
    id: taskIdFromFilename(id),
    ...value,
  });
}

export function getTaskStatus(repoRoot, id) {
  let filename;
  try {
    filename = existingTaskFilename(repoRoot, id);
  } catch {
    return { id: String(id), status: "unknown" };
  }

  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) {
    const closedPath = historyPath(repoRoot, taskIdFromFilename(filename));
    return existsSync(closedPath)
      ? readJson(closedPath)
      : { id: taskIdFromFilename(filename), status: "unknown" };
  }

  let task;
  try {
    task = readTask(taskPath);
  } catch (error) {
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
  if (existsSync(lockPath)) status = "running";
  else if (task.metadata.error !== null) status = "failed";
  else if (existingBlockers.length > 0) status = "blocked";

  let artifacts = [];
  let artifactError = null;
  try {
    artifacts = readTaskArtifacts(repoRoot, task.id);
  } catch (error) {
    artifactError = error.message;
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
    metrics: task.metadata.metrics || null,
    execution: storedTaskExecution(repoRoot, task),
    externalWorkflows: task.metadata.externalWorkflows || [],
    externalSync: task.metadata.externalSync || [],
    externalSyncError: task.metadata.externalSyncError || null,
    artifacts,
    artifactError,
    updatedAt: statSync(taskPath).mtime.toISOString(),
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
  { includeClosed = false, limit = 100 } = {},
) {
  const active = listTaskFiles(repoRoot).map((file) =>
    getTaskStatus(repoRoot, taskIdFromFilename(path.basename(file))),
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
        return readJson(path.join(historyDir, name));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const tasks = [...active, ...closed];
  return unlimited ? tasks : tasks.slice(0, limit);
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
    const taskStatuses = listTaskStatuses(repoRoot);
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

export function retryTask(repoRoot, id) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  if (existsSync(`${taskPath}.lock`)) throw new Error(`Task is running: ${id}`);
  const task = readTask(taskPath);
  task.metadata.error = null;
  writeTask(task);
  return getTaskStatus(repoRoot, id);
}

export function startInteractiveTask(repoRoot, id) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  const status = getTaskStatus(repoRoot, id);
  if (status.status === "running") throw new Error(`Task is running: ${id}`);
  if (status.status === "blocked") {
    throw new Error(
      `Task is blocked by: ${status.existingBlockers.join(", ")}`,
    );
  }

  let claim;
  try {
    claim = claimTask(taskPath, "interactive");
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Task is running: ${id}`);
    throw error;
  }
  return {
    claimToken: claim.token,
    task: getTaskDetails(repoRoot, id),
  };
}

export function finishInteractiveTask(
  repoRoot,
  id,
  {
    claimToken,
    status,
    summary,
    validation = [],
    error = null,
    externalSync = [],
    externalSyncError = null,
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
  if (status !== "completed" && status !== "failed") {
    throw new Error("status must be completed or failed");
  }
  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error("summary must be a non-empty string");
  }
  if (
    !Array.isArray(validation) ||
    validation.some((item) => typeof item !== "string")
  ) {
    throw new Error("validation must be an array of strings");
  }
  const task = readTask(taskPath);
  const externalWorkflows = task.metadata.externalWorkflows || [];
  const normalizedExternalOutcome = normalizeExternalTaskOutcome(
    externalWorkflows,
    { status, externalSync, externalSyncError },
  );
  const completedAt = Date.now();
  const claimedAt = Date.parse(currentClaim.claimedAt);
  const startedAt = Number.isFinite(claimedAt) ? claimedAt : completedAt;
  const metrics = cumulativeTaskMetrics(
    task.metadata.metrics || null,
    taskMetrics(startedAt, completedAt, emptyTokenUsage()),
  );
  const claim = { lockPath, token: claimToken };
  try {
    if (status === "completed") {
      completeTask(
        repoRoot,
        taskPath,
        {
          status,
          summary: summary.trim(),
          validation: validation.map((item) => item.trim()).filter(Boolean),
          externalSync: normalizedExternalOutcome.externalSync,
        },
        metrics,
      );
    } else {
      setTaskError(
        taskPath,
        "interactive",
        null,
        typeof error === "string" && error.trim() ? error : summary,
        metrics,
        {
          externalSync: normalizedExternalOutcome.externalSync,
          externalSyncError: normalizedExternalOutcome.externalSyncError,
        },
      );
    }
  } finally {
    releaseClaim(claim);
  }
  return getTaskStatus(repoRoot, id);
}

export function cancelTask(repoRoot, id) {
  const filename = existingTaskFilename(repoRoot, id);
  const taskPath = path.join(todoDir(repoRoot), filename);
  if (!existsSync(taskPath)) throw new Error(`Task does not exist: ${id}`);
  if (existsSync(`${taskPath}.lock`)) throw new Error(`Task is running: ${id}`);
  const task = readTask(taskPath);
  writeHistory(repoRoot, task.id, {
    title: titleFromBody(task.body, task.id),
    status: "canceled",
    closedAt: new Date().toISOString(),
    execution: storedTaskExecution(repoRoot, task),
    externalWorkflows: task.metadata.externalWorkflows || [],
    externalSync: task.metadata.externalSync || [],
    externalSyncError: task.metadata.externalSyncError || null,
    artifacts: readTaskArtifacts(repoRoot, task.id),
  });
  unlinkSync(taskPath);
  return readJson(historyPath(repoRoot, task.id));
}

export function claimTask(taskPath, workerId) {
  const lockPath = `${taskPath}.lock`;
  const token = randomUUID();
  const claimedAt = new Date().toISOString();
  const fd = openSync(lockPath, "wx");
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({
        token,
        pid: process.pid,
        workerId,
        task: path.basename(taskPath),
        claimedAt,
      })}\n`,
      "utf8",
    );
  } finally {
    closeSync(fd);
  }
  return { lockPath, token, claimedAt };
}

export function releaseClaim(claim) {
  if (!claim || !existsSync(claim.lockPath)) return;
  try {
    const current = readJson(claim.lockPath);
    if (current.token !== claim.token) return;
  } catch {
    return;
  }
  unlinkSync(claim.lockPath);
}

export function cleanupStaleClaims(repoRoot) {
  const removed = [];
  for (const taskPath of listTaskFiles(repoRoot)) {
    const lockPath = `${taskPath}.lock`;
    if (!existsSync(lockPath)) continue;
    try {
      const claim = readClaim(lockPath);
      if (claim?.pid && !processIsAlive(claim.pid)) {
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
  externalEvidence = null,
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
  if (externalEvidence) {
    if (externalEvidence.externalSync?.length > 0) {
      task.metadata.externalSync = externalEvidence.externalSync;
    }
    if (externalEvidence.externalSyncError) {
      task.metadata.externalSyncError =
        externalEvidence.externalSyncError;
    }
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
    metrics,
    summary: result.summary,
    validation: result.validation,
    externalWorkflows: task.metadata.externalWorkflows || [],
    externalSync: result.externalSync || task.metadata.externalSync || [],
    artifacts: readTaskArtifacts(repoRoot, task.id),
  });
  unlinkSync(taskPath);
  return readJson(historyPath(repoRoot, task.id));
}
