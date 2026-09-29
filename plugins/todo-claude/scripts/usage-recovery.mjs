import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseAppServerExecutionStats, parseExecutionStats } from "./execution-stats.mjs";

// Read-only projection: keep historical receipts/logs intact. Cache numeric
// results, never prompts or model/tool payloads, and invalidate on log changes.
const cache = new Map();
const keys = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"];
export function combineUsage(records) {
  const measured = records.filter((record) => record?.available);
  const usage = {
    available: measured.length > 0,
    coverage: measured.length === 0 ? "none" : measured.length === records.length &&
      measured.every((record) => record.coverage === "full") ? "full" : "partial",
    turns: measured.reduce((sum, record) => sum + (record.turns || 0), 0),
  };
  for (const key of keys) usage[key] = measured.reduce((sum, record) => sum + (record[key] || 0), 0);
  usage.uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  usage.visibleOutputTokens = Math.max(0, usage.outputTokens - usage.reasoningOutputTokens);
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return usage;
}

function json(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
function directories(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch { return []; }
}
function signature(file) {
  try { const stat = statSync(file); return `${file}:${stat.size}:${stat.mtimeMs}`; }
  catch { return `${file}:missing`; }
}

export function recoverUsageRuns(repoRoot, taskId, runs) {
  if (!/^[0-9]+-[a-z0-9-]+$/.test(taskId) || runs.every((run) => run.tokenAccountingVersion === 2)) return runs;
  const root = path.join(repoRoot, ".todo", "logs", taskId);
  const attempts = directories(root).map((name) => {
    const dir = path.join(root, name);
    const usageFile = path.join(dir, "usage.json");
    const steps = directories(path.join(dir, "pipeline"));
    const logs = steps.length ? steps.map((step) => path.join(dir, "pipeline", step))
      .filter((step) => existsSync(path.join(step, "prompt.txt"))) : [dir];
    return { usageFile, logs };
  });
  const fingerprint = JSON.stringify(runs) + attempts.map(({ usageFile, logs }) =>
    [signature(usageFile), ...logs.flatMap((dir) => [signature(path.join(dir, "stdout.log")), signature(path.join(dir, "receipt.json"))])].join("|")).join("|");
  const cached = cache.get(root);
  if (cached?.fingerprint === fingerprint) return cached.runs;
  const records = attempts.map((attempt) => ({ ...attempt, record: json(attempt.usageFile) }))
    .filter(({ record }) => record?.schemaVersion === 2)
    .sort((a, b) => String(a.record.startedAt).localeCompare(String(b.record.startedAt)));
  const recovered = new Map();
  const totals = new Map();
  for (const { record, logs } of records) {
    const run = runs.find((item) => item.startedAt === record.startedAt && item.completedAt === record.completedAt);
    if (!run || run.tokenAccountingVersion === 2) continue;
    const usages = [];
    let hasAppServer = Boolean(record.source?.includes("app-server") || record.source?.includes("pipeline") || record.pipelineRunFile);
    for (const dir of logs) {
      let raw;
      try { raw = readFileSync(path.join(dir, "stdout.log"), "utf8"); }
      catch { usages.push(combineUsage([])); continue; }
      // Historical recovery only needs accounting events. Do not deserialize
      // potentially huge command outputs, prompts, or model/tool payloads.
      raw = raw.split(/\r?\n/).filter((line) =>
        line.includes('"thread/tokenUsage/updated"') ||
        line.includes('"todo/tokenUsage/baseline"') ||
        line.includes('"turn.completed"'),
      ).join("\n");
      const notifications = [];
      for (const line of raw.split(/\r?\n/)) {
        // Only retain counters and IDs while identifying historical baselines.
        if (!line.includes('"thread/tokenUsage/updated"')) continue;
        try {
          const event = JSON.parse(line);
          if (event.method === "thread/tokenUsage/updated" && event.params?.tokenUsage) notifications.push(event.params);
        } catch { /* Parser below marks malformed input partial. */ }
      }
      if (notifications.length) {
        hasAppServer = true;
        const receipt = json(path.join(dir, "receipt.json"));
        const turnId = record.turnId || receipt?.turnId || notifications.at(-1).turnId;
        const first = notifications[0];
        const before = totals.get(first.threadId);
        if (before && !raw.includes('"todo/tokenUsage/baseline"')) {
          // A fresh/reset segment starts with total == last. Otherwise the
          // previous recorded turn provides the baseline for repair/resume.
          const fresh = keys.every((key) => (first.tokenUsage.total?.[key] || 0) === (first.tokenUsage.last?.[key] || 0));
          if (!fresh) raw = JSON.stringify({ method: "todo/tokenUsage/baseline", params: { threadId: first.threadId, total: before } }) + "\n" + raw;
        }
        usages.push(parseAppServerExecutionStats(raw, turnId).tokenUsage);
        for (const notification of notifications) {
          if (notification.tokenUsage.total) totals.set(notification.threadId, notification.tokenUsage.total);
        }
      } else {
        const stats = parseExecutionStats(raw);
        usages.push(stats.tokenUsage);
        if (record.source?.includes("app-server") || record.pipelineRunFile) hasAppServer = true;
      }
    }
    // Legacy CLI totals already include model requests; don't reinterpret them.
    if (hasAppServer) {
      const expectedSteps = record.observable?.pipeline?.steps?.length || 0;
      while (usages.length < expectedSteps) usages.push(combineUsage([]));
      const combined = combineUsage(usages);
      recovered.set(run, !combined.available && record.tokenUsage?.available
        ? { ...record.tokenUsage, coverage: "partial" } : combined);
    }
  }
  const result = runs.map((run) => recovered.has(run) ? {
    ...run, tokenAccountingVersion: 2, tokenUsage: recovered.get(run),
  } : run);
  if (cache.size >= 4096) cache.delete(cache.keys().next().value);
  cache.set(root, { fingerprint, runs: result });
  return result;
}
