import { createServer } from "node:http";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  listTaskStatuses,
  listWorkerStatuses,
  loadConfig,
  metricRuns,
  readDaemonState,
  todoDir,
} from "./lib.mjs";

const DASHBOARD_HOST = "127.0.0.1";
const TASK_LOG_ID_PATTERN = /^[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ATTEMPT_LOG_PATTERN = /^(?:[0-9TZ-]+|attempt-[0-9]+-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|delivery-[0-9]{4}(?:-[0-9]{2}){2}T(?:[0-9]{2}-){3}[0-9]{3}Z)$/i;
const LOG_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(?:log|txt|json|jsonl)$/i;
const TASK_LOG_FILES = new Map([
  ["prompt.txt", "Execution prompt"],
  ["stdout.log", "Raw execution events"],
  ["stderr.log", "Standard error"],
  ["result.json", "Structured result"],
  ["usage.json", "Usage metrics"],
  ["delivery.json", "Git delivery"],
]);
const SORT_FIELDS = new Set([
  "id",
  "title",
  "status",
  "worker",
  "profile",
  "blockers",
  "updated",
  "error",
  "start",
  "end",
  "duration",
  "lastRun",
  "tokens",
  "retries",
]);
const STATUS_ORDER = new Map([
  ["running", 0],
  ["blocked", 1],
  ["completed", 2],
  ["failed", 3],
]);

function regularFile(filePath) {
  try {
    const stats = lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function regularDirectory(directoryPath) {
  try {
    const stats = lstatSync(directoryPath);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function logFileMetadata(filePath) {
  const stats = statSync(filePath);
  return {
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function logFileLabel(file) {
  return TASK_LOG_FILES.get(file) || file;
}

function taskAttemptDirectory(repoRoot, taskId, attempt) {
  if (
    !TASK_LOG_ID_PATTERN.test(taskId || "") ||
    !ATTEMPT_LOG_PATTERN.test(attempt || "")
  ) {
    return null;
  }
  const logsRoot = path.join(todoDir(repoRoot), "logs");
  const taskRoot = path.join(logsRoot, taskId);
  const attemptRoot = path.join(taskRoot, attempt);
  if (
    !regularDirectory(logsRoot) ||
    !regularDirectory(taskRoot) ||
    !regularDirectory(attemptRoot)
  ) {
    return null;
  }
  const realLogsRoot = realpathSync(logsRoot);
  const realAttemptRoot = realpathSync(attemptRoot);
  if (
    realAttemptRoot !== realLogsRoot &&
    !realAttemptRoot.startsWith(`${realLogsRoot}${path.sep}`)
  ) {
    return null;
  }
  return attemptRoot;
}

function taskLogInventory(repoRoot, selectedTask = null) {
  if (selectedTask !== null && !TASK_LOG_ID_PATTERN.test(selectedTask)) {
    throw new Error("Invalid task log ID");
  }
  const entries = [];
  const runnerPath = path.join(todoDir(repoRoot), "runner.log");
  if (selectedTask === null && regularFile(runnerPath)) {
    entries.push({
      scope: "runner",
      taskId: null,
      attempt: null,
      file: "runner.log",
      label: "Runner log",
      ...logFileMetadata(runnerPath),
    });
  }

  const logsRoot = path.join(todoDir(repoRoot), "logs");
  if (!regularDirectory(logsRoot)) return entries;
  const taskIds = (selectedTask === null
    ? readdirSync(logsRoot).filter(
        (name) =>
          TASK_LOG_ID_PATTERN.test(name) &&
          regularDirectory(path.join(logsRoot, name)),
      )
    : [selectedTask]
  ).sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  );

  for (const taskId of taskIds) {
    const taskRoot = path.join(logsRoot, taskId);
    if (!regularDirectory(taskRoot)) continue;
    const attempts = readdirSync(taskRoot)
      .filter(
        (name) =>
          ATTEMPT_LOG_PATTERN.test(name) &&
          regularDirectory(path.join(taskRoot, name)),
      )
      .sort()
      .reverse();
    for (const attempt of attempts) {
      const attemptRoot = taskAttemptDirectory(repoRoot, taskId, attempt);
      if (!attemptRoot) continue;
      const available = readdirSync(attemptRoot)
        .filter(
          (file) =>
            LOG_FILE_PATTERN.test(file) &&
            regularFile(path.join(attemptRoot, file)),
        )
        .sort((left, right) => {
          const leftKnown = [...TASK_LOG_FILES.keys()].indexOf(left);
          const rightKnown = [...TASK_LOG_FILES.keys()].indexOf(right);
          if (leftKnown >= 0 && rightKnown >= 0) return leftKnown - rightKnown;
          if (leftKnown >= 0) return -1;
          if (rightKnown >= 0) return 1;
          return left.localeCompare(right);
        });
      if (available.length === 0) continue;
      const metadata = available.map((file) =>
        logFileMetadata(path.join(attemptRoot, file)),
      );
      if (!attempt.startsWith("delivery-")) {
        entries.push({
          scope: "task",
          taskId,
          attempt,
          file: "transcript.txt",
          label: "Readable transcript",
          virtual: true,
          size: metadata.reduce((total, item) => total + item.size, 0),
          modifiedAt: metadata
            .map((item) => item.modifiedAt)
            .sort()
            .at(-1),
        });
      }
      for (const file of available) {
        entries.push({
          scope: "task",
          taskId,
          attempt,
          file,
          label: logFileLabel(file),
          ...logFileMetadata(path.join(attemptRoot, file)),
        });
      }
    }
  }
  return entries;
}

function executionEventText(event, index) {
  const item = event?.item || event?.params?.item;
  const itemType = item?.type || null;
  const eventType = event?.type || event?.method || "event";
  const heading = `[${String(index + 1).padStart(4, "0")}] ${eventType}${itemType ? ` · ${itemType}` : ""}`;
  if (!item) {
    const payload = { ...event };
    delete payload.type;
    delete payload.method;
    return `${heading}\n${Object.keys(payload).length > 0 ? JSON.stringify(payload, null, 2) : ""}`.trimEnd();
  }
  if (["agent_message", "agentMessage", "reasoning"].includes(itemType)) {
    return `${heading}\n${item.text || ""}`.trimEnd();
  }
  if (["command_execution", "commandExecution"].includes(itemType)) {
    const parts = [heading, item.command || ""];
    const output = item.aggregated_output || item.aggregatedOutput;
    if (output) parts.push("", output);
    parts.push("", `status=${item.status || "unknown"} exit_code=${item.exit_code ?? item.exitCode ?? ""}`);
    return parts.join("\n").trimEnd();
  }
  return `${heading}\n${JSON.stringify(item, null, 2)}`;
}

function readableExecutionTranscript(attemptRoot) {
  const sections = [];
  const promptPath = path.join(attemptRoot, "prompt.txt");
  if (regularFile(promptPath)) {
    sections.push(
      `=== EXECUTION PROMPT ===\n\n${readFileSync(promptPath, "utf8").trimEnd()}`,
    );
  }

  const stdoutPath = path.join(attemptRoot, "stdout.log");
  if (regularFile(stdoutPath)) {
    const events = readFileSync(stdoutPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { type: "unparsed", text: line };
        }
      });
    sections.push(
      `=== AGENT AND TOOL EVENTS ===\n\n${events
        .map((event, index) =>
          event.type === "unparsed"
            ? `[${String(index + 1).padStart(4, "0")}] unparsed\n${event.text}`
            : executionEventText(event, index),
        )
        .join("\n\n")}`,
    );
  }

  const stderrPath = path.join(attemptRoot, "stderr.log");
  if (regularFile(stderrPath)) {
    const stderr = readFileSync(stderrPath, "utf8").trimEnd();
    if (stderr) sections.push(`=== STDERR ===\n\n${stderr}`);
  }
  const resultPath = path.join(attemptRoot, "result.json");
  if (regularFile(resultPath)) {
    sections.push(
      `=== STRUCTURED RESULT ===\n\n${readFileSync(resultPath, "utf8").trimEnd()}`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}

function readDashboardLog(repoRoot, query) {
  const scope = query.get("scope");
  if (scope === "runner") {
    const runnerPath = path.join(todoDir(repoRoot), "runner.log");
    if (!regularFile(runnerPath)) return null;
    const realTodoRoot = realpathSync(todoDir(repoRoot));
    const realRunnerPath = realpathSync(runnerPath);
    if (!realRunnerPath.startsWith(`${realTodoRoot}${path.sep}`)) return null;
    return readFileSync(runnerPath, "utf8");
  }
  if (scope !== "task") return null;
  const taskId = query.get("task") || "";
  const attempt = query.get("attempt") || "";
  const file = query.get("file") || "";
  const attemptRoot = taskAttemptDirectory(repoRoot, taskId, attempt);
  if (!attemptRoot) return null;
  if (file === "transcript.txt") {
    return readableExecutionTranscript(attemptRoot);
  }
  if (!LOG_FILE_PATTERN.test(file)) return null;
  const filePath = path.join(attemptRoot, file);
  if (!regularFile(filePath)) return null;
  const realAttemptRoot = realpathSync(attemptRoot);
  const realFilePath = realpathSync(filePath);
  if (!realFilePath.startsWith(`${realAttemptRoot}${path.sep}`)) return null;
  return readFileSync(filePath, "utf8");
}

function taskNumber(value) {
  const match = /^([0-9]+)(?:-|$)/.exec(String(value || ""));
  return match ? match[1] : String(value || "");
}

function taskBlockerNumbers(task) {
  return (task.blockers || task.existingBlockers || []).map(taskNumber);
}

function dashboardStatus(status) {
  return status === "canceled" || status === "cancelled" ? "rejected" : status || "";
}

function filterAlternatives(value) {
  const normalized = String(value || "").trim();
  const unwrapped =
    normalized.startsWith("(") && normalized.endsWith(")")
      ? normalized.slice(1, -1)
      : normalized;
  const alternatives = unwrapped
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  return alternatives.length > 0 ? alternatives : [""];
}

function blockerTask(tasks, blocker) {
  const direct = tasks.find((task) => task.id === blocker);
  if (direct) return direct;
  const number = taskNumber(blocker);
  const matches = tasks.filter((task) => taskNumber(task.id) === number);
  return matches.length === 1 ? matches[0] : null;
}

function blockerLinks(task, tasks) {
  return (task.blockers || task.existingBlockers || [])
    .map((blocker) => {
      const number = taskNumber(blocker);
      const target = blockerTask(tasks, blocker);
      if (!target?.path) return escapeHtml(number);
      return `<a href="/api/task?task=${encodeURIComponent(target.id)}" target="_blank" rel="noopener" data-blocker-task="${escapeHtml(target.id)}" title="Open ${escapeHtml(target.id)}.md">${escapeHtml(number)}</a>`;
    })
    .join(", ");
}

function compactDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000));
  const units = [
    ["d", Math.floor(totalSeconds / 86400)],
    ["h", Math.floor((totalSeconds % 86400) / 3600)],
    ["m", Math.floor((totalSeconds % 3600) / 60)],
    ["s", totalSeconds % 60],
  ];
  const visible = units
    .filter(([, value]) => value > 0)
    .map(([suffix, value]) => `${value}${suffix}`);
  return visible.length > 0 ? visible.join(" ") : "0s";
}

function tokenUsageView(task) {
  const usage = task.metrics?.tokenUsage || {};
  const coverage = usage.available === true
    ? usage.coverage === "full" ? "full" : "partial"
    : "none";
  if (coverage === "none") {
    return { text: "—", title: "Coverage: none\nNo measured token usage" };
  }
  const number = (value) => Math.max(0, Number(value) || 0);
  const total = number(usage.totalTokens);
  return {
    text: `${total}${coverage === "partial" ? "*" : ""}`,
    title: [
      `Coverage: ${coverage}${coverage === "partial" ? " (*)" : ""}`,
      `Total: ${total}`,
      `Input: ${number(usage.inputTokens)}`,
      `Cached input: ${number(usage.cachedInputTokens)}`,
      `Uncached input: ${number(usage.uncachedInputTokens)}`,
      `Cache write input: ${number(usage.cacheWriteInputTokens)}`,
      `Output: ${number(usage.outputTokens)}`,
      `Reasoning output: ${number(usage.reasoningOutputTokens)}`,
      `Visible output: ${number(usage.visibleOutputTokens)}`,
      `Turns: ${number(usage.turns)}`,
    ].join("\n"),
  };
}

function retryStatsView(task) {
  const stats = task.retryStats || task.attemptLedger?.retryStats || {};
  const number = (value) => Math.max(0, Number(value) || 0);
  const model = number(stats.modelRetries);
  const automatic = number(stats.automaticRetries);
  const manual = number(stats.manualRetries);
  const delivery = number(stats.deliveryRetries);
  return {
    text: `M${model} D${delivery}`,
    title: `Model retries: ${model}\nAutomatic: ${automatic}\nManual: ${manual}\nDelivery retries: ${delivery}`,
    total: model + delivery,
  };
}

function daemonRuntimeState(daemon) {
  if (!daemon) return "offline";
  const update = daemon.runtimeUpdate;
  if (update?.status === "pending" || daemon.status === "restart-pending") {
    const active = Number.isInteger(update?.activeTasks)
      ? ` (${update.activeTasks} active)`
      : "";
    return `restart pending${active}`;
  }
  if (daemon.status && daemon.status !== "running") return daemon.status;
  return update?.status || (daemon.runtime ? "current" : "legacy");
}

const FILTER_FIELDS = new Set([
  "id",
  "task",
  "title",
  "status",
  "worker",
  "profile",
  "blocker",
  "blockers",
  "updated",
  "start",
  "end",
  "duration",
  "lastrun",
  "tokens",
  "retries",
  "error",
]);

function filterTokens(query) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const character of String(query || "").trim()) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character.trim() === "") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function taskFilterValue(task, field) {
  switch (field) {
    case "id":
      return taskNumber(task.id);
    case "task":
    case "title":
      return task.title || "";
    case "status":
      return dashboardStatus(task.status);
    case "worker":
      return task.workerId ?? "";
    case "profile":
      return task.execution?.modelProfile || "";
    case "blocker":
    case "blockers":
      return taskBlockerNumbers(task).join(" ");
    case "updated":
      return `${task.updatedAt || task.closedAt || ""} ${formatTimestamp(task.updatedAt || task.closedAt)}`;
    case "start":
      return `${task.metrics?.startedAt || ""} ${formatTimestamp(task.metrics?.startedAt)}`;
    case "end":
      return `${task.metrics?.completedAt || ""} ${formatTimestamp(task.metrics?.completedAt)}`;
    case "duration":
      return `${task.metrics?.durationMs ?? 0} ${compactDuration(task.metrics?.durationMs)}`;
    case "lastrun":
      return `${task.metrics?.lastRun?.durationMs ?? 0} ${compactDuration(task.metrics?.lastRun?.durationMs)}`;
    case "tokens":
      return task.metrics?.tokenUsage?.totalTokens ?? 0;
    case "retries":
      return retryStatsView(task).total;
    case "error":
      return task.error?.message || "";
    default:
      return "";
  }
}

function taskSearchText(task) {
  return [
    task.id,
    taskNumber(task.id),
    task.title,
    dashboardStatus(task.status),
    task.workerId,
    task.execution?.modelProfile,
    ...(task.existingBlockers || task.blockers || []),
    ...taskBlockerNumbers(task),
    task.error?.message,
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

function filterTasks(tasks, query) {
  const tokens = filterTokens(query);
  if (tokens.length === 0) return tasks;
  return tasks.filter((task) => {
    const searchText = taskSearchText(task);
    return tokens.every((token) => {
      const separator = token.indexOf(":");
      const field = separator > 0 ? token.slice(0, separator).toLowerCase() : "";
      const value = separator > 0 ? token.slice(separator + 1) : token;
      if (field && FILTER_FIELDS.has(field)) {
        const fieldValue = String(taskFilterValue(task, field)).toLowerCase();
        return filterAlternatives(value).some((alternative) =>
          fieldValue.includes(alternative.toLowerCase()),
        );
      }
      return searchText.includes(token.toLowerCase());
    });
  });
}

function dashboardTaskMarkdown(repoRoot, taskId) {
  if (!TASK_LOG_ID_PATTERN.test(taskId || "")) return null;
  const task = listTaskStatuses(repoRoot).find((item) => item.id === taskId);
  if (!task?.path || !regularFile(task.path) || path.extname(task.path) !== ".md") {
    return null;
  }
  const realTodoRoot = realpathSync(todoDir(repoRoot));
  const realTaskPath = realpathSync(task.path);
  if (!realTaskPath.startsWith(`${realTodoRoot}${path.sep}`)) return null;
  return {
    filename: path.basename(task.path),
    content: readFileSync(task.path, "utf8"),
  };
}

const DASHBOARD_SCRIPT = `(() => {
  const statusOrder = new Map([
    ["running", 0],
    ["blocked", 1],
    ["completed", 2],
    ["failed", 3],
  ]);
  const summary = document.querySelector(".summary");
  const tableBody = document.querySelector("tbody");
  const sortLinks = [...document.querySelectorAll("a[data-sort]")];
  const filterInput = document.querySelector("#task-filter");
  const filterClear = document.querySelector("#filter-clear");
  const logDialog = document.querySelector("#log-dialog");
  const logTitle = document.querySelector("#log-title");
  const logList = document.querySelector("#log-list");
  const logContent = document.querySelector("#log-content");
  const logStatus = document.querySelector("#log-status");
  let latestPayload = null;
  let pollTimer = null;
  let visibleLogs = [];
  let selectedLog = null;
  let loadedLogContent = null;
  let logPollTimer = null;
  const timestampFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  const filterFields = new Set([
    "id", "task", "title", "status", "worker", "profile",
    "blocker", "blockers", "updated", "start", "end",
    "duration", "lastrun", "tokens", "error",
  ]);

  function taskNumber(value) {
    const match = /^([0-9]+)(?:-|$)/.exec(String(value || ""));
    return match ? match[1] : String(value || "");
  }

  function taskBlockerNumbers(task) {
    return (task.blockers || task.existingBlockers || []).map(taskNumber);
  }

  function dashboardStatus(status) {
    return status === "canceled" || status === "cancelled"
      ? "rejected"
      : status || "";
  }

  function filterAlternatives(value) {
    const normalized = String(value || "").trim();
    const unwrapped = normalized.startsWith("(") && normalized.endsWith(")")
      ? normalized.slice(1, -1)
      : normalized;
    const alternatives = unwrapped
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
    return alternatives.length > 0 ? alternatives : [""];
  }

  function blockerTask(tasks, blocker) {
    const direct = tasks.find((task) => task.id === blocker);
    if (direct) return direct;
    const number = taskNumber(blocker);
    const matches = tasks.filter((task) => taskNumber(task.id) === number);
    return matches.length === 1 ? matches[0] : null;
  }

  function compactDuration(durationMs) {
    const totalSeconds = Math.max(
      0,
      Math.round((Number(durationMs) || 0) / 1000),
    );
    const units = [
      ["d", Math.floor(totalSeconds / 86400)],
      ["h", Math.floor((totalSeconds % 86400) / 3600)],
      ["m", Math.floor((totalSeconds % 3600) / 60)],
      ["s", totalSeconds % 60],
    ];
    const visible = units
      .filter((entry) => entry[1] > 0)
      .map((entry) => String(entry[1]) + entry[0]);
    return visible.length > 0 ? visible.join(" ") : "0s";
  }

  function tokenUsageView(task) {
    const usage = task.metrics?.tokenUsage || {};
    const coverage = usage.available === true
      ? usage.coverage === "full" ? "full" : "partial"
      : "none";
    if (coverage === "none") {
      return { text: "—", title: "Coverage: none\\nNo measured token usage" };
    }
    const number = (value) => Math.max(0, Number(value) || 0);
    const total = number(usage.totalTokens);
    return {
      text: String(total) + (coverage === "partial" ? "*" : ""),
      title: [
        "Coverage: " + coverage + (coverage === "partial" ? " (*)" : ""),
        "Total: " + total,
        "Input: " + number(usage.inputTokens),
        "Cached input: " + number(usage.cachedInputTokens),
        "Uncached input: " + number(usage.uncachedInputTokens),
        "Cache write input: " + number(usage.cacheWriteInputTokens),
        "Output: " + number(usage.outputTokens),
        "Reasoning output: " + number(usage.reasoningOutputTokens),
        "Visible output: " + number(usage.visibleOutputTokens),
        "Turns: " + number(usage.turns),
      ].join("\\n"),
    };
  }

  function retryStatsView(task) {
    const stats = task.retryStats || task.attemptLedger?.retryStats || {};
    const number = (value) => Math.max(0, Number(value) || 0);
    const model = number(stats.modelRetries);
    const automatic = number(stats.automaticRetries);
    const manual = number(stats.manualRetries);
    const delivery = number(stats.deliveryRetries);
    return {
      text: "M" + model + " D" + delivery,
      title: "Model retries: " + model +
        "\\nAutomatic: " + automatic +
        "\\nManual: " + manual +
        "\\nDelivery retries: " + delivery,
      total: model + delivery,
    };
  }

  function filterTokens(query) {
    const tokens = [];
    let current = "";
    let quote = null;
    for (const character of String(query || "").trim()) {
      if (quote !== null) {
        if (character === quote) quote = null;
        else current += character;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character.trim() === "") {
        if (current) tokens.push(current);
        current = "";
        continue;
      }
      current += character;
    }
    if (current) tokens.push(current);
    return tokens;
  }

  function taskFilterValue(task, field) {
    switch (field) {
      case "id":
        return taskNumber(task.id);
      case "task":
      case "title":
        return task.title || "";
      case "status":
        return dashboardStatus(task.status);
      case "worker":
        return task.workerId ?? "";
      case "profile":
        return task.execution?.modelProfile || "";
      case "blocker":
      case "blockers":
        return taskBlockerNumbers(task).join(" ");
      case "updated":
        return (task.updatedAt || task.closedAt || "") + " " +
          formatTimestamp(task.updatedAt || task.closedAt);
      case "start":
        return (task.metrics?.startedAt || "") + " " +
          formatTimestamp(task.metrics?.startedAt);
      case "end":
        return (task.metrics?.completedAt || "") + " " +
          formatTimestamp(task.metrics?.completedAt);
      case "duration":
        return String(task.metrics?.durationMs ?? 0) + " " +
          compactDuration(task.metrics?.durationMs);
      case "lastrun":
        return String(task.metrics?.lastRun?.durationMs ?? 0) + " " +
          compactDuration(task.metrics?.lastRun?.durationMs);
      case "tokens":
        return task.metrics?.tokenUsage?.totalTokens ?? 0;
      case "retries":
        return retryStatsView(task).total;
      case "error":
        return task.error?.message || "";
      default:
        return "";
    }
  }

  function taskSearchText(task) {
    return [
      task.id,
      taskNumber(task.id),
      task.title,
      dashboardStatus(task.status),
      task.workerId,
      task.execution?.modelProfile,
      ...(task.existingBlockers || task.blockers || []),
      ...taskBlockerNumbers(task),
      task.error?.message,
    ]
      .filter((value) => value !== null && value !== undefined)
      .join(" ")
      .toLowerCase();
  }

  function filterTasks(tasks, query) {
    const tokens = filterTokens(query);
    if (tokens.length === 0) return tasks;
    return tasks.filter((task) => {
      const searchText = taskSearchText(task);
      return tokens.every((token) => {
        const separator = token.indexOf(":");
        const field = separator > 0
          ? token.slice(0, separator).toLowerCase()
          : "";
        const value = separator > 0 ? token.slice(separator + 1) : token;
        if (field && filterFields.has(field)) {
          const fieldValue = String(taskFilterValue(task, field)).toLowerCase();
          return filterAlternatives(value).some((alternative) =>
            fieldValue.includes(alternative.toLowerCase()),
          );
        }
        return searchText.includes(token.toLowerCase());
      });
    });
  }

  function setFilter(query) {
    const normalized = String(query || "").trim();
    filterInput.value = normalized;
    const params = new URLSearchParams(window.location.search);
    if (normalized) params.set("q", normalized);
    else params.delete("q");
    const search = params.toString();
    window.history.replaceState(null, "", "/" + (search ? "?" + search : ""));
    updateSortLinks();
    if (latestPayload) render(latestPayload);
  }

  function addFilter(field, value) {
    const rawValue = String(value || "").trim();
    if (!rawValue) return;
    const formattedValue = [...rawValue].some(
      (character) => character.trim() === "",
    )
      ? '"' + rawValue.replaceAll('"', "") + '"'
      : rawValue;
    const clause = field + ":" + formattedValue;
    const current = filterInput.value.trim();
    const tokens = filterTokens(current);
    const duplicate = tokens.some(
      (token) => token.toLowerCase() === clause.toLowerCase(),
    );
    if (field === "status" || field === "profile") {
      const alternatives = [];
      let insertAt = -1;
      const remaining = [];
      for (const token of tokens) {
        const separator = token.indexOf(":");
        const tokenField = separator > 0
          ? token.slice(0, separator).toLowerCase()
          : "";
        if (tokenField === field) {
          if (insertAt < 0) insertAt = remaining.length;
          alternatives.push(...filterAlternatives(token.slice(separator + 1)));
        } else {
          remaining.push(token);
        }
      }
      if (!alternatives.some(
        (alternative) => alternative.toLowerCase() === rawValue.toLowerCase(),
      )) {
        alternatives.push(rawValue);
      }
      const mergedClause = field + ":" + alternatives.join("|");
      remaining.splice(insertAt < 0 ? remaining.length : insertAt, 0, mergedClause);
      setFilter(remaining.join(" "));
    } else {
      setFilter(duplicate ? current : [current, clause].filter(Boolean).join(" "));
    }
    filterInput.focus();
  }

  function currentSort() {
    const params = new URLSearchParams(window.location.search);
    return {
      field: params.get("sort") || "status",
      direction: params.get("dir") === "desc" ? "desc" : "asc",
    };
  }

  function taskValue(task, field) {
    switch (field) {
      case "worker":
        return task.workerId ?? "";
      case "profile":
        return task.execution?.modelProfile ?? "";
      case "blockers":
        return taskBlockerNumbers(task).join(", ");
      case "updated":
        return task.updatedAt || task.closedAt || "";
      case "error":
        return task.error?.message || "";
      case "start":
        return task.metrics?.startedAt || "";
      case "end":
        return task.metrics?.completedAt || "";
      case "duration":
        return task.metrics?.durationMs ?? -1;
      case "lastRun":
        return task.metrics?.lastRun?.durationMs ?? -1;
      case "tokens":
        return task.metrics?.tokenUsage?.totalTokens ?? -1;
      case "retries":
        return retryStatsView(task).total;
      default:
        return task[field] ?? "";
    }
  }

  function sortedTasks(tasks, field, direction) {
    const factor = direction === "desc" ? -1 : 1;
    return [...tasks].sort((left, right) => {
      const leftValue = taskValue(left, field);
      const rightValue = taskValue(right, field);
      if (field === "status") {
        const leftRank = statusOrder.get(String(leftValue)) ?? statusOrder.size;
        const rightRank = statusOrder.get(String(rightValue)) ?? statusOrder.size;
        if (leftRank !== rightRank) return (leftRank - rightRank) * factor;
      }
      return String(leftValue).localeCompare(String(rightValue), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * factor;
    });
  }

  function cell(value, className = "") {
    const element = document.createElement("td");
    if (className) element.className = className;
    element.textContent = String(value ?? "");
    return element;
  }

  function formatTimestamp(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : timestampFormatter.format(date);
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  }

  function logQuery(entry) {
    const params = new URLSearchParams({ scope: entry.scope });
    if (entry.taskId) params.set("task", entry.taskId);
    if (entry.attempt) params.set("attempt", entry.attempt);
    if (entry.file) params.set("file", entry.file);
    return "/api/log?" + params.toString();
  }

  async function loadLog(entry, quiet = false) {
    if (quiet && selectedLog !== entry) return;
    selectedLog = entry;
    clearTimeout(logPollTimer);
    const previousScrollTop = logContent.scrollTop;
    const wasAtBottom =
      logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < 48;
    if (!quiet) {
      loadedLogContent = null;
      logContent.textContent = "Loading…";
      logStatus.textContent = entry.label;
    }
    try {
      const response = await fetch(logQuery(entry), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const content = await response.text();
      if (selectedLog !== entry) return;
      const displayContent = content || "(empty log)";
      let contentChanged = false;
      if (quiet && loadedLogContent && content.startsWith(loadedLogContent)) {
        const suffix = content.slice(loadedLogContent.length);
        if (suffix) {
          logContent.append(document.createTextNode(suffix));
          contentChanged = true;
        }
      } else if (logContent.textContent !== displayContent) {
        logContent.textContent = displayContent;
        contentChanged = true;
      }
      loadedLogContent = content;
      const statusText =
        entry.label + " · " + formatBytes(content.length) +
        (entry.modifiedAt ? " · " + formatTimestamp(entry.modifiedAt) : "");
      if (logStatus.textContent !== statusText) logStatus.textContent = statusText;
      for (const button of logList.querySelectorAll("button[data-log-index]")) {
        button.classList.toggle(
          "selected",
          visibleLogs[Number(button.dataset.logIndex)] === entry,
        );
      }
      if (contentChanged) {
        logContent.scrollTop = wasAtBottom || !quiet
          ? logContent.scrollHeight
          : previousScrollTop;
      }
    } catch (error) {
      if (!quiet) logContent.textContent = "Could not load log: " + error.message;
      logStatus.textContent = "disconnected";
    } finally {
      if (logDialog.open && selectedLog === entry) {
        logPollTimer = setTimeout(() => loadLog(entry, true), 2000);
      }
    }
  }

  function renderLogList(entries) {
    visibleLogs = entries;
    const fragment = document.createDocumentFragment();
    let previousGroup = null;
    entries.forEach((entry, index) => {
      const group = entry.scope === "runner"
        ? "Runner"
        : entry.taskId + " · " + entry.attempt;
      if (group !== previousGroup) {
        const heading = document.createElement("h3");
        heading.textContent = group;
        fragment.append(heading);
        previousGroup = group;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.logIndex = String(index);
      button.textContent = entry.label + " · " + formatBytes(entry.size);
      fragment.append(button);
    });
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No logs yet";
      fragment.append(empty);
    }
    logList.replaceChildren(fragment);
  }

  async function openLogs(taskId = null) {
    clearTimeout(logPollTimer);
    selectedLog = null;
    loadedLogContent = null;
    logTitle.textContent = taskId ? "Logs — " + taskId : "All logs";
    logStatus.textContent = "Loading…";
    logContent.textContent = "Select a log";
    logList.textContent = "Loading…";
    if (!logDialog.open) logDialog.showModal();
    try {
      const query = taskId ? "?task=" + encodeURIComponent(taskId) : "";
      const response = await fetch("/api/logs" + query, { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      renderLogList(payload.logs || []);
      logStatus.textContent = (payload.logs || []).length + " log views";
      if (visibleLogs.length > 0) loadLog(visibleLogs[0]);
    } catch (error) {
      renderLogList([]);
      logStatus.textContent = "disconnected";
      logContent.textContent = "Could not list logs: " + error.message;
    }
  }

  function taskRow(task, allTasks) {
    const row = document.createElement("tr");
    row.dataset.taskId = task.id;
    const idCell = document.createElement("td");
    if (task.path) {
      const idLink = document.createElement("a");
      idLink.href = "/api/task?task=" + encodeURIComponent(task.id);
      idLink.target = "_blank";
      idLink.rel = "noopener";
      idLink.title = "Open " + task.id + ".md";
      idLink.textContent = taskNumber(task.id);
      idCell.append(idLink);
    } else {
      idCell.textContent = taskNumber(task.id);
    }
    row.append(idCell);
    row.append(cell(task.title));

    const statusCell = document.createElement("td");
    const status = document.createElement("button");
    status.type = "button";
    const displayStatus = dashboardStatus(task.status);
    const safeStatus = displayStatus.replace(/[^a-z0-9_-]/gi, "");
    status.className = "filter-token status status-" + safeStatus;
    status.dataset.filterField = "status";
    status.dataset.filterValue = displayStatus;
    status.title = "Add status filter";
    status.textContent = displayStatus;
    statusCell.append(status);
    row.append(statusCell);

    row.append(cell(task.workerId ?? ""));
    const profileCell = document.createElement("td");
    const profile = task.execution?.modelProfile || "";
    if (profile) {
      const profileButton = document.createElement("button");
      profileButton.type = "button";
      profileButton.className = "filter-token";
      profileButton.dataset.filterField = "profile";
      profileButton.dataset.filterValue = profile;
      profileButton.title = "Add profile filter";
      profileButton.textContent = profile;
      profileCell.append(profileButton);
    }
    row.append(profileCell);
    const blockersCell = document.createElement("td");
    const blockers = task.blockers || task.existingBlockers || [];
    blockers.forEach((blocker, index) => {
      if (index > 0) blockersCell.append(", ");
      const target = blockerTask(allTasks, blocker);
      if (target?.path) {
        const link = document.createElement("a");
        link.href = "/api/task?task=" + encodeURIComponent(target.id);
        link.target = "_blank";
        link.rel = "noopener";
        link.dataset.blockerTask = target.id;
        link.title = "Open " + target.id + ".md";
        link.textContent = taskNumber(blocker);
        blockersCell.append(link);
      } else {
        blockersCell.append(taskNumber(blocker));
      }
    });
    row.append(blockersCell);
    row.append(cell(formatTimestamp(task.updatedAt || task.closedAt), "time"));
    row.append(cell(formatTimestamp(task.metrics?.startedAt), "time"));
    row.append(cell(formatTimestamp(task.metrics?.completedAt), "time"));
    row.append(cell(compactDuration(task.metrics?.durationMs)));
    row.append(cell(compactDuration(task.metrics?.lastRun?.durationMs)));
    const tokens = tokenUsageView(task);
    const tokensCell = cell(tokens.text);
    tokensCell.title = tokens.title;
    row.append(tokensCell);
    const retries = retryStatsView(task);
    const retriesCell = cell(retries.text);
    retriesCell.title = retries.title;
    row.append(retriesCell);
    row.append(cell(task.error?.message ?? "", "error"));
    const logsCell = document.createElement("td");
    const logsButton = document.createElement("button");
    logsButton.type = "button";
    logsButton.dataset.logTask = task.id;
    logsButton.textContent = "Logs";
    logsCell.append(logsButton);
    row.append(logsCell);
    return row;
  }

  function updateTaskRow(row, task, allTasks) {
    const nextRow = taskRow(task, allTasks);
    const nextCells = [...nextRow.children];
    nextCells.forEach((nextCell, index) => {
      const currentCell = row.children[index];
      if (!currentCell) row.append(nextCell);
      else if (!currentCell.isEqualNode(nextCell)) currentCell.replaceWith(nextCell);
    });
    while (row.children.length > nextCells.length) row.lastElementChild.remove();
  }

  function reconcileTaskRows(tasks, allTasks) {
    const existingRows = new Map(
      [...tableBody.querySelectorAll("tr[data-task-id]")].map((row) => [
        row.dataset.taskId,
        row,
      ]),
    );
    const rows = [];
    if (tasks.length === 0) {
      let row = tableBody.querySelector("tr[data-empty-state]");
      const message = filterInput.value.trim() ? "No matching tasks" : "No tasks";
      if (!row) {
        row = document.createElement("tr");
        row.dataset.emptyState = "";
        const empty = cell(message);
        empty.colSpan = 15;
        row.append(empty);
      } else {
        const empty = row.firstElementChild;
        if (empty.colSpan !== 15) empty.colSpan = 15;
        if (empty.textContent !== message) empty.textContent = message;
      }
      rows.push(row);
    } else {
      for (const task of tasks) {
        const taskId = String(task.id);
        let row = existingRows.get(taskId);
        if (row) {
          existingRows.delete(taskId);
          updateTaskRow(row, task, allTasks);
        } else {
          row = taskRow(task, allTasks);
        }
        rows.push(row);
      }
    }

    const desiredRows = new Set(rows);
    for (const row of [...tableBody.children]) {
      if (!desiredRows.has(row)) row.remove();
    }

    let cursor = tableBody.firstElementChild;
    for (const row of rows) {
      if (row === cursor) cursor = cursor.nextElementSibling;
      else tableBody.insertBefore(row, cursor);
    }
  }

  function updateSortLinks() {
    const sort = currentSort();
    for (const link of sortLinks) {
      const field = link.dataset.sort;
      const active = field === sort.field;
      const nextDirection =
        active && sort.direction === "asc" ? "desc" : "asc";
      const params = new URLSearchParams(window.location.search);
      params.set("sort", field);
      params.set("dir", nextDirection);
      const href = "/?" + params.toString();
      const text = link.dataset.label +
        (active ? (sort.direction === "asc" ? " ↑" : " ↓") : "");
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
      if (link.textContent !== text) link.textContent = text;
    }
  }

  function render(payload) {
    latestPayload = payload;
    const sort = currentSort();
    const allTasks = payload.tasks || [];
    const tasks = sortedTasks(
      filterTasks(allTasks, filterInput.value),
      sort.field,
      sort.direction,
    );
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    reconcileTaskRows(tasks, allTasks);
    if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
      window.scrollTo(scrollX, scrollY);
    }

    const workerCounts = payload.workers?.counts || {};
    const runnerName = payload.runner?.implementation || "unknown runner";
    const runnerVersion = payload.runner?.pluginVersion || "";
    const runtimeState = payload.runner?.runtimeState || "offline";
    const configReloadSeconds = Math.round(
      (payload.config?.configReloadIntervalMs || 5000) / 1000,
    );
    const summaryText =
      tasks.length + (tasks.length === allTasks.length ? " tasks · " :
        " of " + allTasks.length + " tasks · ") +
      (workerCounts.busy || 0) + " busy · " +
      (workerCounts.idle || 0) + " idle · " +
      runnerName + " " + runnerVersion + " · runtime " + runtimeState +
      " · config " +
      configReloadSeconds + "s · live 1s";
    if (summary.textContent !== summaryText) summary.textContent = summaryText;
    summary.classList.remove("disconnected");
    updateSortLinks();
  }

  async function poll() {
    clearTimeout(pollTimer);
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      render(await response.json());
    } catch {
      summary.classList.add("disconnected");
      if (!summary.textContent.includes(" · disconnected")) {
        summary.textContent += " · disconnected";
      }
    } finally {
      pollTimer = setTimeout(poll, 1000);
    }
  }

  document.addEventListener("click", (event) => {
    const filterToken = event.target.closest("button[data-filter-field]");
    if (filterToken) {
      addFilter(filterToken.dataset.filterField, filterToken.dataset.filterValue);
      return;
    }
    const taskLogButton = event.target.closest("button[data-log-task]");
    if (taskLogButton) {
      openLogs(taskLogButton.dataset.logTask);
      return;
    }
    const allLogsButton = event.target.closest("button[data-log-all]");
    if (allLogsButton) {
      openLogs();
      return;
    }
    const logEntryButton = event.target.closest("button[data-log-index]");
    if (logEntryButton) {
      const entry = visibleLogs[Number(logEntryButton.dataset.logIndex)];
      if (entry) loadLog(entry);
      return;
    }
    const link = event.target.closest("a[data-sort]");
    if (!link) return;
    event.preventDefault();
    const nextUrl = new URL(link.href, window.location.href);
    window.history.replaceState(null, "", nextUrl.pathname + nextUrl.search);
    updateSortLinks();
    if (latestPayload) render(latestPayload);
  });

  logDialog.addEventListener("close", () => {
    clearTimeout(logPollTimer);
    selectedLog = null;
    loadedLogContent = null;
  });

  filterInput.addEventListener("input", () => {
    const params = new URLSearchParams(window.location.search);
    const query = filterInput.value.trim();
    if (query) params.set("q", query);
    else params.delete("q");
    const search = params.toString();
    window.history.replaceState(null, "", "/" + (search ? "?" + search : ""));
    updateSortLinks();
    if (latestPayload) render(latestPayload);
  });

  filterClear.addEventListener("click", () => setFilter(""));

  updateSortLinks();
  poll();
})();`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function normalizedDashboardRun(run) {
  if (!run) return null;
  const completedAt = Date.parse(run.completedAt);
  const durationMs = Math.max(0, Number(run.durationMs) || 0);
  const startedAt = Date.parse(run.startedAt);
  const resolvedStartedAt = Number.isFinite(startedAt)
    ? startedAt
    : Number.isFinite(completedAt)
      ? completedAt - durationMs
      : Number.NaN;
  if (!Number.isFinite(resolvedStartedAt)) return null;
  return {
    ...run,
    startedAt: new Date(resolvedStartedAt).toISOString(),
    completedAt: Number.isFinite(completedAt)
      ? new Date(completedAt).toISOString()
      : null,
    ...durationFields(durationMs),
  };
}

function dashboardTask(task, now) {
  const storedMetrics = task.metrics || {};
  const completedRuns = metricRuns(storedMetrics);
  const previousDurationMs = completedRuns.reduce(
    (total, run) => total + run.durationMs,
    0,
  );
  const claimedAt = Date.parse(task.claim?.claimedAt);
  const running = task.status === "running" && Number.isFinite(claimedAt);
  const currentRun = running
    ? {
        startedAt: new Date(claimedAt).toISOString(),
        completedAt: null,
        ...durationFields(Math.max(0, now - claimedAt)),
        tokenUsage: {
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
        },
      }
    : null;
  const storedLastRun = normalizedDashboardRun(
    storedMetrics.lastRun ||
      storedMetrics.lastAttempt ||
      completedRuns.at(-1),
  );
  const lastRun = currentRun || storedLastRun;
  const durationMs =
    previousDurationMs + (currentRun?.durationMs || 0);
  const tokenUsage = {
    ...(storedMetrics.tokenUsage || {}),
    available: storedMetrics.tokenUsage?.available === true,
    coverage: running
      ? storedMetrics.tokenUsage?.available === true ? "partial" : "none"
      : storedMetrics.tokenUsage?.available === true
        ? storedMetrics.tokenUsage?.coverage === "full" ? "full" : "partial"
        : "none",
    totalTokens: Number(storedMetrics.tokenUsage?.totalTokens) || 0,
  };
  const claim = task.claim
    ? {
        ...task.claim,
        claimedAt: undefined,
      }
    : task.claim;
  return {
    ...task,
    claim,
    metrics: {
      ...storedMetrics,
      attempts:
        (Number(storedMetrics.attempts) || 0) + (currentRun ? 1 : 0),
      startedAt:
        storedMetrics.startedAt ||
        completedRuns[0]?.startedAt ||
        currentRun?.startedAt ||
        null,
      completedAt: running ? null : storedMetrics.completedAt || null,
      ...durationFields(durationMs),
      tokenUsage,
      lastRun,
      runs: currentRun ? [...completedRuns, currentRun] : completedRuns,
    },
  };
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function taskValue(task, field) {
  switch (field) {
    case "worker":
      return task.workerId ?? "";
    case "profile":
      return task.execution?.modelProfile ?? "";
    case "blockers":
      return taskBlockerNumbers(task).join(", ");
    case "updated":
      return task.updatedAt || task.closedAt || "";
    case "error":
      return task.error?.message || "";
    case "start":
      return task.metrics?.startedAt || "";
    case "end":
      return task.metrics?.completedAt || "";
    case "duration":
      return task.metrics?.durationMs ?? -1;
    case "lastRun":
      return task.metrics?.lastRun?.durationMs ?? -1;
    case "tokens":
      return task.metrics?.tokenUsage?.totalTokens ?? -1;
    case "retries":
      return retryStatsView(task).total;
    default:
      return task[field] ?? "";
  }
}

function sortedTasks(tasks, field, direction) {
  const factor = direction === "desc" ? -1 : 1;
  return [...tasks].sort((left, right) => {
    const leftValue = taskValue(left, field);
    const rightValue = taskValue(right, field);
    if (field === "status") {
      const leftRank = STATUS_ORDER.get(String(leftValue)) ?? STATUS_ORDER.size;
      const rightRank =
        STATUS_ORDER.get(String(rightValue)) ?? STATUS_ORDER.size;
      if (leftRank !== rightRank) return (leftRank - rightRank) * factor;
    }
    return (
      String(leftValue).localeCompare(String(rightValue), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * factor
    );
  });
}

function sortLink(field, label, currentField, currentDirection, query = "") {
  const nextDirection =
    currentField === field && currentDirection === "asc" ? "desc" : "asc";
  const marker =
    currentField === field
      ? currentDirection === "asc"
        ? " ↑"
        : " ↓"
      : "";
  const params = new URLSearchParams({ sort: field, dir: nextDirection });
  if (query) params.set("q", query);
  return `<a href="/?${escapeHtml(params.toString())}" data-sort="${field}" data-label="${escapeHtml(label)}">${escapeHtml(label)}${marker}</a>`;
}

function statusPayload(repoRoot) {
  const now = Date.now();
  const tasks = listTaskStatuses(repoRoot, {
    includeClosed: true,
    limit: null,
  }).map((task) => dashboardTask(task, now));
  const config = loadConfig(repoRoot);
  const daemon = readDaemonState(repoRoot);
  const appliedConfig = daemon?.appliedConfig || null;
  return {
    repoRoot,
    generatedAt: new Date().toISOString(),
    config: {
      workers: appliedConfig?.workers ?? config.workers,
      retries: appliedConfig?.retries ?? config.retries,
      configReloadIntervalMs:
        appliedConfig?.configReloadIntervalMs ?? config.configReloadIntervalMs,
      defaultModelProfile:
        appliedConfig?.defaultModelProfile ?? config.defaultModelProfile,
    },
    runner: daemon
      ? {
          implementation: daemon.implementation || null,
          protocolVersion: daemon.protocolVersion || null,
          pluginVersion: daemon.pluginVersion || null,
          pid: daemon.pid || null,
          status: daemon.status || null,
          runtime: daemon.runtime || null,
          runtimeUpdate: daemon.runtimeUpdate || null,
          runtimeState: daemonRuntimeState(daemon),
          configReload: daemon.configReload || null,
        }
      : null,
    tasks,
    workers: listWorkerStatuses(repoRoot),
  };
}

function renderDashboard(repoRoot, requestUrl) {
  const url = new URL(requestUrl, "http://localhost");
  const sort = SORT_FIELDS.has(url.searchParams.get("sort"))
    ? url.searchParams.get("sort")
    : "status";
  const direction = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
  const filterQuery = (url.searchParams.get("q") || "").trim();
  const payload = statusPayload(repoRoot);
  const tasks = sortedTasks(
    filterTasks(payload.tasks, filterQuery),
    sort,
    direction,
  );
  const workerCounts = payload.workers.counts || {};
  const rows = tasks
    .map((task) => {
      const updated = task.updatedAt || task.closedAt || "";
      const id = taskNumber(task.id);
      const idMarkup = task.path
        ? `<a href="/api/task?task=${encodeURIComponent(task.id)}" target="_blank" rel="noopener" title="Open ${escapeHtml(task.id)}.md">${escapeHtml(id)}</a>`
        : escapeHtml(id);
      const displayStatus = dashboardStatus(task.status);
      const safeStatus = displayStatus.replace(/[^a-z0-9_-]/gi, "");
      const profile = task.execution?.modelProfile || "";
      const tokens = tokenUsageView(task);
      const retries = retryStatsView(task);
      return `<tr data-task-id="${escapeHtml(task.id)}">
  <td>${idMarkup}</td>
  <td>${escapeHtml(task.title)}</td>
  <td><button type="button" class="filter-token status status-${escapeHtml(safeStatus)}" data-filter-field="status" data-filter-value="${escapeHtml(displayStatus)}" title="Add status filter">${escapeHtml(displayStatus)}</button></td>
  <td>${escapeHtml(task.workerId ?? "")}</td>
  <td>${profile ? `<button type="button" class="filter-token" data-filter-field="profile" data-filter-value="${escapeHtml(profile)}" title="Add profile filter">${escapeHtml(profile)}</button>` : ""}</td>
  <td>${blockerLinks(task, payload.tasks)}</td>
  <td class="time">${escapeHtml(formatTimestamp(updated))}</td>
  <td class="time">${escapeHtml(formatTimestamp(task.metrics?.startedAt))}</td>
  <td class="time">${escapeHtml(formatTimestamp(task.metrics?.completedAt))}</td>
  <td>${escapeHtml(compactDuration(task.metrics.durationMs))}</td>
  <td>${escapeHtml(compactDuration(task.metrics.lastRun?.durationMs))}</td>
  <td title="${escapeHtml(tokens.title)}">${escapeHtml(tokens.text)}</td>
  <td title="${escapeHtml(retries.title)}">${escapeHtml(retries.text)}</td>
  <td class="error">${escapeHtml(task.error?.message ?? "")}</td>
  <td><button type="button" data-log-task="${escapeHtml(task.id)}">Logs</button></td>
</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ToDo — ${escapeHtml(path.basename(repoRoot))}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { margin: 20px; font-size: 13px; }
    h1 { margin: 0; font-size: 20px; }
    button { font: inherit; cursor: pointer; }
    .heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 6px; }
    .summary { margin: 0 0 12px; opacity: .75; }
    .filters { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; }
    .filters label { font-weight: 700; }
    #task-filter { box-sizing: border-box; width: min(720px, 70vw); padding: 7px 9px; border: 1px solid #8888; border-radius: 4px; background: Canvas; color: CanvasText; font: inherit; }
    .filter-help { opacity: .65; white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 7px 9px; border: 1px solid #8885; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: Canvas; white-space: nowrap; }
    th a { color: inherit; text-decoration: none; }
    td a { color: LinkText; }
    tbody tr:nth-child(even) { background: #8881; }
    .status { font-weight: 700; }
    .filter-token { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
    .status-running { color: #d97706; }
    .status-completed { color: #16a34a; }
    .status-rejected { color: #84cc16; }
    .status-failed { color: #dc2626; }
    .status-blocked { color: #7c3aed; }
    .summary.disconnected { color: #dc2626; opacity: 1; }
    .time { white-space: nowrap; }
    .error { min-width: 320px; max-width: 420px; white-space: pre-wrap; overflow-wrap: anywhere; }
    dialog { width: min(1400px, calc(100vw - 32px)); height: min(880px, calc(100vh - 32px)); padding: 0; border: 1px solid #8888; background: Canvas; color: CanvasText; }
    dialog::backdrop { background: #0008; }
    .log-header { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #8885; }
    .log-header h2 { flex: 1; margin: 0; font-size: 16px; }
    #log-status { opacity: .7; }
    .log-layout { display: grid; grid-template-columns: minmax(240px, 28%) 1fr; height: calc(100% - 51px); min-height: 0; }
    #log-list { overflow: auto; padding: 10px; border-right: 1px solid #8885; }
    #log-list h3 { margin: 10px 4px 5px; font-size: 12px; overflow-wrap: anywhere; }
    #log-list button { display: block; width: 100%; margin: 0 0 4px; padding: 6px 8px; border: 1px solid #8885; background: transparent; color: inherit; text-align: left; }
    #log-list button.selected { background: Highlight; color: HighlightText; }
    #log-content { box-sizing: border-box; height: 100%; margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
    @media (max-width: 760px) {
      .filters { align-items: stretch; flex-wrap: wrap; }
      #task-filter { width: 100%; }
      .filter-help { white-space: normal; }
      .log-layout { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 32%) 1fr; }
      #log-list { border-right: 0; border-bottom: 1px solid #8885; }
      #log-status { display: none; }
    }
  </style>
  <script src="/dashboard.js" defer></script>
</head>
<body>
  <div class="heading">
    <h1>ToDo — ${escapeHtml(path.basename(repoRoot))}</h1>
    <button type="button" data-log-all>All logs</button>
  </div>
  <p class="summary">${tasks.length}${tasks.length === payload.tasks.length ? "" : ` of ${payload.tasks.length}`} tasks · ${workerCounts.busy || 0} busy · ${workerCounts.idle || 0} idle · ${escapeHtml(payload.runner?.implementation || "unknown runner")} ${escapeHtml(payload.runner?.pluginVersion || "")} · runtime ${escapeHtml(payload.runner?.runtimeState || "offline")} · config ${escapeHtml(Math.round((payload.config.configReloadIntervalMs || 5000) / 1000))}s · live 1s</p>
  <div class="filters" role="search">
    <label for="task-filter">Filter</label>
    <input id="task-filter" type="search" value="${escapeHtml(filterQuery)}" placeholder="status:completed|rejected" autocomplete="off" spellcheck="false">
    <button id="filter-clear" type="button" data-filter-clear>Clear</button>
    <span class="filter-help">Fields: id, task, status, worker, profile, blockers, updated, error · OR: value|value</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>${sortLink("id", "ID", sort, direction, filterQuery)}</th>
        <th>${sortLink("title", "Task", sort, direction, filterQuery)}</th>
        <th>${sortLink("status", "Status", sort, direction, filterQuery)}</th>
        <th>${sortLink("worker", "Worker", sort, direction, filterQuery)}</th>
        <th>${sortLink("profile", "Profile", sort, direction, filterQuery)}</th>
        <th>${sortLink("blockers", "Blockers", sort, direction, filterQuery)}</th>
        <th>${sortLink("updated", "Updated", sort, direction, filterQuery)}</th>
        <th>${sortLink("start", "Start", sort, direction, filterQuery)}</th>
        <th>${sortLink("end", "End", sort, direction, filterQuery)}</th>
        <th>${sortLink("duration", "Duration", sort, direction, filterQuery)}</th>
        <th>${sortLink("lastRun", "Last Run", sort, direction, filterQuery)}</th>
        <th>${sortLink("tokens", "Tokens", sort, direction, filterQuery)}</th>
        <th>${sortLink("retries", "Retries", sort, direction, filterQuery)}</th>
        <th>${sortLink("error", "Error", sort, direction, filterQuery)}</th>
        <th>Logs</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr data-empty-state><td colspan="15">No tasks</td></tr>'}</tbody>
  </table>
  <dialog id="log-dialog" aria-labelledby="log-title">
    <div class="log-header">
      <h2 id="log-title">Logs</h2>
      <span id="log-status"></span>
      <form method="dialog"><button type="submit">Close</button></form>
    </div>
    <div class="log-layout">
      <nav id="log-list" aria-label="Available logs"></nav>
      <pre id="log-content" tabindex="0">Select a log</pre>
    </div>
  </dialog>
</body>
</html>`;
}

export function startDashboard(repoRoot, port = 0) {
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end("Method not allowed");
        return;
      }
      const requestUrl = new URL(request.url || "/", "http://localhost");
      if (requestUrl.pathname === "/api/logs") {
        const selectedTask = requestUrl.searchParams.get("task");
        let logs;
        try {
          logs = taskLogInventory(repoRoot, selectedTask);
        } catch (error) {
          response.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(`${JSON.stringify({ error: error.message })}\n`);
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(`${JSON.stringify({ logs }, null, 2)}\n`);
        return;
      }
      if (requestUrl.pathname === "/api/log") {
        const content = readDashboardLog(repoRoot, requestUrl.searchParams);
        if (content === null) {
          response.writeHead(404, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end("Log not found");
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
        return;
      }
      if (requestUrl.pathname === "/api/task") {
        const task = dashboardTaskMarkdown(
          repoRoot,
          requestUrl.searchParams.get("task") || "",
        );
        if (!task) {
          response.writeHead(404, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end("Task file not found");
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `inline; filename="${task.filename}"`,
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(task.content);
        return;
      }
      if (requestUrl.pathname === "/api/status") {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(`${JSON.stringify(statusPayload(repoRoot), null, 2)}\n`);
        return;
      }
      if (requestUrl.pathname === "/dashboard.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(`${DASHBOARD_SCRIPT}\n`);
        return;
      }
      if (requestUrl.pathname !== "/") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'",
      });
      response.end(renderDashboard(repoRoot, request.url || "/"));
    } catch (error) {
      response.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(`Dashboard error: ${error.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, DASHBOARD_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : port;
      resolve({
        server,
        host: DASHBOARD_HOST,
        port: actualPort,
        url: `http://${DASHBOARD_HOST}:${actualPort}/`,
      });
    });
  });
}
