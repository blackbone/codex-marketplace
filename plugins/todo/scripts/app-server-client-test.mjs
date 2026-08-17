import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerClient } from "./app-server-client.mjs";
import { parseAppServerExecutionStats } from "./execution-stats.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "todo-app-server-"));
const trace = path.join(root, "trace.jsonl");
const fake = path.join(root, "codex");
writeFileSync(
  fake,
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.FAKE_TRACE;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(trace, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-1" } } });
  else if (message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  else if (message.method === "thread/archive" || message.method === "thread/unarchive" || message.method === "turn/interrupt") send({ id: message.id, result: {} });
  else if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turn = { id: "turn-1", status: "inProgress", items: [] };
    send({ id: message.id, result: { turn } });
    send({ method: "item/completed", params: { threadId, turnId: "turn-1", completedAtMs: Date.now(), item: { id: "item-1", type: "agentMessage", text: "{\\\"status\\\":\\\"completed\\\"}" } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-1", tokenUsage: { last: { inputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 50 }, total: { inputTokens: 40, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 50 }, modelContextWindow: 1000 } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-1", tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 }, total: { inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 }, modelContextWindow: 1000 } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed", items: [] } } });
  }
}
`,
  "utf8",
);
chmodSync(fake, 0o755);

const events = [];
const client = new AppServerClient({
  command: fake,
  cwd: root,
  env: { ...process.env, FAKE_TRACE: trace },
});
await client.start();
const thread = await client.startThread({
  cwd: root,
  model: "test-model",
  approvalPolicy: "never",
  sandbox: "workspace-write",
});
assert.equal(thread.id, "thread-1");
const turnId = await client.startTurn(
  {
    threadId: thread.id,
    input: [{ type: "text", text: "do it" }],
    outputSchema: { type: "object" },
  },
  (_message, line) => events.push(line),
);
const turn = await client.waitForTurn(thread.id, turnId);
assert.equal(turn.status, "completed");
const stats = parseAppServerExecutionStats(events.join("\n"), turnId);
assert.equal(stats.threadId, thread.id);
assert.equal(stats.tokenUsage.inputTokens, 100);
assert.equal(stats.tokenUsage.cachedInputTokens, 80);
assert.equal(stats.tokenUsage.totalTokens, 120);
assert.equal(stats.tokenUsage.turns, 1);
assert.equal(stats.observable.agentMessages.items, 1);
assert.equal(stats.requestStats.reason, "app_server_protocol_has_turn_totals_only");

await client.archiveThread(thread.id);
await client.unarchiveThread(thread.id);
await client.resumeThread(thread.id, { cwd: root });
await client.close();

const requests = readFileSync(trace, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(requests.filter((item) => item.method === "thread/start").length, 1);
assert.equal(requests.find((item) => item.method === "thread/start").params.ephemeral, false);
assert.equal(requests.filter((item) => item.method === "turn/start").length, 1);
assert.equal(requests.filter((item) => item.method === "thread/archive").length, 1);
assert.equal(requests.filter((item) => item.method === "thread/unarchive").length, 1);
assert.equal(requests.filter((item) => item.method === "thread/resume").length, 1);

process.stdout.write("todo app-server client test passed\n");
