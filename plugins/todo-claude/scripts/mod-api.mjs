#!/usr/bin/env node
// Backend of the Claude Code dashboard mod. Each call prints one JSON line.
// Reads and settings writes use the same functions as the web dashboard, so
// profiles can be fixed while the runner is blocked; task actions go through the
// running dashboard, which owns the live worker sessions.
//
//   mod-api.mjs status   <cwd>
//   mod-api.mjs task     <cwd> <taskId>
//   mod-api.mjs chat     <cwd> <taskId>
//   mod-api.mjs logs     <cwd> [taskId]
//   mod-api.mjs log      <cwd> <scope> [taskId] [attempt] [file]
//   mod-api.mjs settings <cwd>
//   mod-api.mjs save     <cwd> <json>
//   mod-api.mjs models   <cwd> [force]
//   mod-api.mjs start    <cwd>
//   mod-api.mjs action   <cwd> <json>
import { existsSync } from "node:fs";
import path from "node:path";
import {
  compactDuration,
  dashboardTaskMarkdown,
  readDashboardLog,
  retryStatsView,
  statusPayload,
  taskLogInventory,
  tokenUsageView,
} from "./dashboard.mjs";
import { readSettings, saveSettings } from "./dashboard-settings.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";
import { cliModels, profileProblems, readCliModels } from "./claude-models.mjs";
import { findGitRoot, loadConfig, readDaemonState } from "./lib.mjs";
import { readTaskChat } from "./task-chat.mjs";

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const [command, cwd, ...rest] = process.argv.slice(2);

function repoRoot() {
  const root = findGitRoot(cwd || process.cwd());
  if (!root || !existsSync(path.join(root, ".todo", "config.json"))) return null;
  return root;
}

function liveDashboard(root) {
  const daemon = readDaemonState(root);
  if (!daemon?.pid || !daemon.dashboard?.url) return null;
  try {
    process.kill(daemon.pid, 0);
  } catch {
    return null;
  }
  return { url: daemon.dashboard.url.replace(/\/+$/, ""), daemon };
}

const number = (value) => {
  const match = /^([0-9]+)(?:-|$)/.exec(String(value || ""));
  return match ? match[1] : String(value || "");
};
const status = (value) => (value === "canceled" || value === "cancelled" ? "rejected" : value || "");

function row(task, byId) {
  const tokens = tokenUsageView(task);
  const retries = retryStatsView(task);
  // The full dependency list: completed blockers stay so history keeps the graph.
  const blockers = task.blockers || task.existingBlockers || [];
  return {
    id: task.id,
    num: number(task.id),
    title: task.title || task.id,
    status: status(task.status),
    worker: task.workerId ?? null,
    profile: task.execution?.modelProfile || "",
    profileTooltip: task.profileTooltip || "",
    blockers: blockers.map((id) => ({ id, num: number(id), status: status(byId.get(id)?.status) })),
    updated: task.updatedAt || task.closedAt || "",
    start: task.metrics?.startedAt || "",
    end: task.metrics?.completedAt || "",
    durationMs: task.metrics?.durationMs ?? -1,
    duration: compactDuration(task.metrics?.durationMs),
    lastRunMs: task.metrics?.lastRun?.durationMs ?? -1,
    lastRun: compactDuration(task.metrics?.lastRun?.durationMs),
    tokens: tokens.text,
    tokensTitle: tokens.title,
    tokensTotal: task.metrics?.tokenUsage?.totalTokens ?? -1,
    retries: retries.text,
    retriesTitle: retries.title,
    retriesTotal: retries.total,
    error: task.error?.message || "",
    hasFile: Boolean(task.path),
    interaction: task.interaction
      ? {
          state: task.interaction.state || null,
          question: task.interaction.question || null,
          questions: Array.isArray(task.interaction.questions)
            ? task.interaction.questions.map((q) => ({ id: q.id, question: q.question, header: q.header || null }))
            : [],
          requestId: task.interaction.requestId || null,
          updatedAt: task.interaction.updatedAt || null,
        }
      : null,
    turnId: task.claim?.owner?.turnId || task.codexThread?.lastTurnId || null,
  };
}

async function post(root, route, body) {
  const live = liveDashboard(root);
  if (!live) throw new Error("The runner is not running. Start it with /todo:start.");
  const response = await fetch(`${live.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: live.url, "X-ToDo-Action": "1" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { error: text.trim() || `HTTP ${response.status}` };
  }
  if (!response.ok && !result.error) result.error = `HTTP ${response.status}`;
  return result;
}

try {
  const root = repoRoot();
  if (!root) {
    out({ active: false });
  } else if (command === "status") {
    const payload = statusPayload(root);
    const byId = new Map(payload.tasks.map((task) => [task.id, task]));
    const live = liveDashboard(root);
    const config = loadConfig(root);
    out({
      active: true,
      profileProblems: profileProblems(config.modelProfiles, config.defaultModelProfile, readCliModels(root, config.codexCommand)),
      repo: path.basename(root),
      generatedAt: payload.generatedAt,
      config: payload.config,
      runner: payload.runner
        ? {
            alive: Boolean(live),
            status: payload.runner.status,
            pid: payload.runner.pid,
            pluginVersion: payload.runner.pluginVersion,
            runtimeState: payload.runner.runtimeState || null,
            mergeWorker: payload.runner.mergeWorker?.status || null,
          }
        : null,
      dashboardUrl: live?.url || null,
      taskCounts: payload.taskCounts,
      workers: (payload.workers?.items || []).map((w) => ({ id: w.id, status: w.status, taskId: w.taskId, taskTitle: w.taskTitle })),
      tasks: payload.tasks.map((task) => row(task, byId)),
    });
  } else if (command === "task") {
    const task = dashboardTaskMarkdown(root, rest[0]);
    out(task ? { id: rest[0], filename: task.filename, content: task.content.slice(0, 200000) } : { error: "Task file not found" });
  } else if (command === "chat") {
    const chat = readTaskChat(root, rest[0] || "");
    out({
      truncated: chat.truncated,
      messages: chat.messages.slice(-120).map((m) => ({ ...m, text: String(m.text || "").slice(-12000) })),
    });
  } else if (command === "logs") {
    out({ logs: taskLogInventory(root, rest[0] || null) });
  } else if (command === "log") {
    const [scope, task, attempt, file] = rest;
    const query = new URLSearchParams({ scope: scope || "" });
    if (task) query.set("task", task);
    if (attempt) query.set("attempt", attempt);
    if (file) query.set("file", file);
    const content = readDashboardLog(root, query);
    out(content === null ? { error: "Log not found" } : { content: String(content).slice(-400000) });
  } else if (command === "settings") {
    out(readSettings(root));
  } else if (command === "save") {
    try {
      out(await saveSettings(root, JSON.parse(rest[0] || "{}")));
    } catch (error) {
      out({ error: error.message, profileProblems: error.profileProblems || [] });
    }
  } else if (command === "models") {
    out(await cliModels(root, loadConfig(root).codexCommand, { force: rest[0] === "force" }));
  } else if (command === "start") {
    const result = ensureDaemon(root);
    out({ status: result.status, reason: result.reason || null, profileProblems: result.profileProblems || [] });
  } else if (command === "action") {
    out(await post(root, "/api/task-action", JSON.parse(rest[0] || "{}")));
  } else {
    out({ error: `Unknown command: ${command}` });
  }
} catch (error) {
  out({ error: String(error?.message || error).slice(0, 500) });
}
