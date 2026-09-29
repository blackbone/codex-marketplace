import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { combineUsage, recoverUsageRuns } from "./usage-recovery.mjs";
import { getTaskStatus, listTaskStatuses, recoveredTaskMetrics, cumulativeTaskMetrics, taskMetrics } from "./lib.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "todo-usage-recovery-"));
const taskId = "001-recover-usage";
const count = (inputTokens) => ({ inputTokens, outputTokens: 0 });
const update = (turnId, total, last) => JSON.stringify({ method: "thread/tokenUsage/updated", params: {
  threadId: "thread", turnId, tokenUsage: { total: count(total), last: count(last) },
} });
const usage = (totalTokens, available = true) => ({ available, coverage: available ? "full" : "none", turns: available ? 1 : 0,
  inputTokens: totalTokens, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens });
const run = (start, total) => ({ startedAt: new Date(start).toISOString(), completedAt: new Date(start + 1000).toISOString(), durationMs: 1000, tokenUsage: usage(total) });
const runs = [run(1000, 0), run(3000, 20)];
runs[0].tokenUsage = usage(0, false);
const stored = { attempts: 2, startedAt: runs[0].startedAt, completedAt: runs[1].completedAt, durationMs: 2000,
  runs, lastRun: runs[1], tokenUsage: usage(20) };
function attempt(index, log, source = "codex app-server JSON-RPC") {
  const dir = path.join(root, ".todo", "logs", taskId, `attempt-00${index + 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ schemaVersion: 2, ...runs[index], source,
    turnId: `turn-${index + 1}`, tokenUsage: runs[index].tokenUsage }));
  writeFileSync(path.join(dir, "stdout.log"), log);
  return dir;
}
try {
  const first = attempt(0, [update("turn-1", 100, 100), update("turn-1", 350, 250)].join("\n"));
  const second = attempt(1, [update("turn-1", 350, 250), update("turn-2", 500, 150), update("turn-2", 520, 20)].join("\n"));
  const result = recoveredTaskMetrics(root, taskId, stored);
  assert.deepEqual(result.runs.map((entry) => entry.tokenUsage.totalTokens), [350, 170]);
  assert.equal(result.tokenUsage.totalTokens, 520);
  assert.equal(result.tokenUsage.coverage, "full");
  assert.equal(result.attempts, 2);
  assert.equal(result.durationMs, 2000);
  assert.equal(stored.tokenUsage.totalTokens, 20, "input metrics stay immutable");
  assert.deepEqual(recoveredTaskMetrics(root, taskId, stored), result, "cached projection is identical");
  assert.equal(cumulativeTaskMetrics(result, taskMetrics(5000, 6000, usage(30))).tokenUsage.totalTokens, 550, "retry starts from recovered history");
  const history = path.join(root, ".todo", "history", `${taskId}.json`);
  mkdirSync(path.dirname(history), { recursive: true });
  const original = JSON.stringify({ id: taskId, status: "completed", metrics: stored });
  writeFileSync(history, original);
  assert.equal(getTaskStatus(root, taskId).metrics.tokenUsage.totalTokens, 520);
  assert.equal(getTaskStatus(root, taskId, { recoverUsage: false }).metrics.tokenUsage.totalTokens, 20, "scheduler can skip expensive historical recovery");
  assert.equal(listTaskStatuses(root, { includeClosed: true })[0].metrics.tokenUsage.totalTokens, 520);
  assert.equal(readFileSync(history, "utf8"), original, "status must not rewrite historical receipts");
  assert.equal(JSON.parse(readFileSync(path.join(first, "usage.json"), "utf8")).tokenUsage.totalTokens, 0);
  writeFileSync(path.join(second, "stdout.log"), [update("turn-1", 350, 250), update("turn-2", 600, 250)].join("\n"));
  assert.equal(recoveredTaskMetrics(root, taskId, stored).tokenUsage.totalTokens, 600, "changed log invalidates cache");
  rmSync(path.join(first, "stdout.log"));
  const missing = recoveredTaskMetrics(root, taskId, stored);
  assert.equal(missing.tokenUsage.coverage, "partial", "missing attempt prevents full coverage");
  assert.equal(missing.tokenUsage.totalTokens, 250);
  const measured = [taskMetrics(1000, 2000, usage(40))];
  assert.equal(recoverUsageRuns(root, taskId, measured), measured, "new measurements bypass historical recovery");
  assert.equal(combineUsage([usage(10), usage(0, false)]).coverage, "partial");
  assert.equal(combineUsage([usage(0, false)]).coverage, "none");
  console.log("usage recovery test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
