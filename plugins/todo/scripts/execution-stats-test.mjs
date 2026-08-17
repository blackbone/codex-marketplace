import assert from "node:assert/strict";
import {
  buildAttemptUsageV2,
  parseExecutionStats,
  parseOtlpRequestStats,
  readAttemptUsage,
} from "./execution-stats.mjs";

const bytes = (value) =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const rawSentinel = "RAW_PAYLOAD_MUST_NOT_SURVIVE";
const firstUsage = {
  input_tokens: 100,
  cached_input_tokens: 60,
  cache_write_input_tokens: 5,
  output_tokens: 20,
  reasoning_output_tokens: 7,
};
const lastUsage = {
  input_tokens: 250,
  cached_input_tokens: 200,
  cache_write_input_tokens: 10,
  output_tokens: 50,
  reasoning_output_tokens: 30,
};
const events = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  { type: "turn.completed", usage: firstUsage },
  {
    type: "item.completed",
    item: {
      id: "mcp-1",
      type: "mcp_tool_call",
      server: "jira",
      tool: "getIssue",
      status: "completed",
      arguments: { key: rawSentinel },
      result: { content: rawSentinel },
      error: null,
    },
  },
  {
    type: "item.completed",
    item: {
      id: "mcp-2",
      type: "mcp_tool_call",
      server: "firebase",
      tool: "listEvents",
      status: "failed",
      arguments: { issue: rawSentinel },
      result: null,
      error: { message: rawSentinel },
    },
  },
  {
    type: "item.completed",
    item: {
      id: "shell-1",
      type: "command_execution",
      command: `printf ${rawSentinel}`,
      aggregated_output: "abc",
      exit_code: 0,
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "shell-2",
      type: "command_execution",
      command: "false",
      aggregated_output: "bad",
      exit_code: 2,
      status: "failed",
    },
  },
  {
    type: "item.completed",
    item: { id: "reason-1", type: "reasoning", text: rawSentinel },
  },
  {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: rawSentinel },
  },
  {
    type: "item.completed",
    item: {
      id: "change-1",
      type: "file_change",
      status: "completed",
      changes: [
        { path: rawSentinel, kind: "update" },
        { path: "second.js", kind: "add" },
      ],
    },
  },
  {
    type: "item.completed",
    item: {
      id: "search-1",
      type: "web_search",
      query: rawSentinel,
      status: "completed",
    },
  },
  { type: "turn.completed", usage: lastUsage },
];
const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\nnot-json\n`;
const stats = parseExecutionStats(jsonl);

assert.deepEqual(stats.tokenUsage, {
  available: true,
  coverage: "full",
  turns: 2,
  inputTokens: 250,
  cachedInputTokens: 200,
  uncachedInputTokens: 50,
  cacheWriteInputTokens: 10,
  outputTokens: 50,
  reasoningOutputTokens: 30,
  visibleOutputTokens: 20,
  totalTokens: 300,
});
assert.equal(stats.threadId, "thread-1");
assert.equal(stats.observable.jsonl.bytes, bytes(jsonl));
assert.equal(stats.observable.jsonl.events, events.length);
assert.equal(stats.observable.jsonl.invalidLines, 1);
assert.deepEqual(
  stats.observable.jsonl.byType.find((entry) => entry.type === "turn.completed"),
  {
    type: "turn.completed",
    count: 2,
    bytes:
      bytes(JSON.stringify(events[2])) + bytes(JSON.stringify(events.at(-1))),
  },
);
assert.equal(stats.observable.mcp.calls, 2);
assert.equal(stats.observable.mcp.completed, 1);
assert.equal(stats.observable.mcp.failed, 1);
assert.equal(
  stats.observable.mcp.argumentBytes,
  bytes(events[3].item.arguments) + bytes(events[4].item.arguments),
);
assert.equal(stats.observable.mcp.resultBytes, bytes(events[3].item.result));
assert.equal(stats.observable.mcp.errorBytes, bytes(events[4].item.error));
assert.deepEqual(
  stats.observable.mcp.byTool.map(({ server, tool, calls, failed }) => ({
    server,
    tool,
    calls,
    failed,
  })),
  [
    { server: "firebase", tool: "listEvents", calls: 1, failed: 1 },
    { server: "jira", tool: "getIssue", calls: 1, failed: 0 },
  ],
);
assert.deepEqual(stats.observable.shell, {
  calls: 2,
  completed: 1,
  failed: 1,
  commandBytes: bytes(events[5].item.command) + bytes(events[6].item.command),
  outputBytes: 6,
});
assert.deepEqual(stats.observable.reasoning, {
  items: 1,
  bytes: bytes(rawSentinel),
});
assert.deepEqual(stats.observable.agentMessages, {
  items: 1,
  bytes: bytes(rawSentinel),
});
assert.equal(stats.observable.fileChanges.items, 1);
assert.equal(stats.observable.fileChanges.files, 2);
assert.ok(stats.observable.fileChanges.bytes > 0);
assert.equal(stats.observable.webSearches.items, 1);
assert.ok(stats.observable.webSearches.bytes > 0);
assert.equal(stats.requestStats.available, false);
assert.ok(!JSON.stringify(stats).includes(rawSentinel));

const otlpValue = (value) =>
  typeof value === "number"
    ? { intValue: String(value) }
    : { stringValue: value };
const otlpRecord = (attributes, body = rawSentinel) => ({
  body: { stringValue: body },
  attributes: Object.entries(attributes).map(([key, value]) => ({
    key,
    value: otlpValue(value),
  })),
});
const otlpBatch = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "account.id", value: { stringValue: rawSentinel } },
          { key: "user.email", value: { stringValue: rawSentinel } },
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            otlpRecord({
              "event.name": "codex.api_request",
              attempt: 0,
              "error.message": rawSentinel,
            }),
            otlpRecord({
              "event.name": "codex.api_request",
              attempt: 1,
              endpoint: rawSentinel,
            }),
            otlpRecord({
              "event.name": "codex.sse_event",
              "event.kind": "response.completed",
              input_token_count: "100",
              cached_token_count: 40,
              cache_write_token_count: 5,
              output_token_count: "20",
              reasoning_token_count: 7,
              ttft_ms: 120,
              prompt: rawSentinel,
            }),
            otlpRecord({
              "event.name": "codex.api_request",
              attempt: 0,
            }),
            otlpRecord({
              "event.name": "codex.sse_event",
              "event.kind": "response.completed",
              input_token_count: "150",
              cached_token_count: 60,
              cache_write_token_count: 0,
              output_token_count: "30",
              reasoning_token_count: 10,
              ttft_ms: 90,
              raw: rawSentinel,
            }),
            otlpRecord({
              "event.name": "codex.sse_event",
              "event.kind": "response.completed",
              input_token_count: rawSentinel,
              output_token_count: "999",
              account_id: 12345,
            }),
          ],
        },
      ],
    },
  ],
};
const otlpAggregate = {
  available: true,
  turns: 1,
  inputTokens: 250,
  cachedInputTokens: 100,
  cacheWriteInputTokens: 5,
  outputTokens: 50,
  reasoningOutputTokens: 17,
};
const requestStats = parseOtlpRequestStats([otlpBatch], otlpAggregate);
assert.equal(requestStats.available, true);
assert.equal(requestStats.coverage, "full");
assert.equal(requestStats.transportRetries, 1);
assert.deepEqual(
  requestStats.requests.map(({ requestIndex, ttftMs }) => ({
    requestIndex,
    ttftMs,
  })),
  [
    { requestIndex: 1, ttftMs: 120 },
    { requestIndex: 2, ttftMs: 90 },
  ],
);
assert.deepEqual(requestStats.tokenUsage, {
  available: true,
  coverage: "full",
  turns: 2,
  inputTokens: 250,
  cachedInputTokens: 100,
  uncachedInputTokens: 150,
  cacheWriteInputTokens: 5,
  outputTokens: 50,
  reasoningOutputTokens: 17,
  visibleOutputTokens: 33,
  totalTokens: 300,
});
assert.equal(requestStats.requests[0].tokenUsage.totalTokens, 120);
const partialRequestStats = parseOtlpRequestStats(otlpBatch, {
  ...otlpAggregate,
  inputTokens: 251,
});
assert.equal(partialRequestStats.available, true);
assert.equal(partialRequestStats.coverage, "partial");
assert.equal(partialRequestStats.requests.length, 2);
assert.equal(
  parseOtlpRequestStats(otlpBatch, {
    ...otlpAggregate,
    coverage: "partial",
  }).coverage,
  "full",
);
assert.deepEqual(parseOtlpRequestStats(null, otlpAggregate), {
  available: false,
  coverage: "none",
  requests: [],
  transportRetries: 0,
  reason: "codex_exec_json_has_turn_totals_only",
});
assert.ok(!JSON.stringify(requestStats).includes(rawSentinel));
assert.ok(!JSON.stringify(requestStats).includes("account.id"));
assert.ok(!JSON.stringify(requestStats).includes("account_id"));
assert.ok(!JSON.stringify(requestStats).includes("user.email"));
assert.ok(!JSON.stringify(requestStats).includes("prompt"));
assert.ok(!JSON.stringify(requestStats).includes("raw"));

const attempt = buildAttemptUsageV2({
  taskId: "1159-example",
  attempt: 8,
  status: "failed",
  startedAt: "2026-08-06T11:59:43.798Z",
  completedAt: "2026-08-06T12:02:02.829Z",
  durationMs: 139031,
  modelProfile: "expert",
  model: "gpt-test",
  reasoningEffort: "high",
  stats,
});
assert.equal(attempt.schemaVersion, 2);
assert.equal(attempt.attempt, 8);
assert.equal(attempt.tokenUsage.totalTokens, 300);
assert.equal(attempt.tokenUsage.coverage, "full");
assert.equal(attempt.observable.mcp.calls, 2);
assert.equal(attempt.requestStats.available, false);
assert.ok(!JSON.stringify(attempt).includes(rawSentinel));
assert.deepEqual(readAttemptUsage(attempt), {
  schemaVersion: 2,
  attempt: 8,
  status: "failed",
  startedAt: "2026-08-06T11:59:43.798Z",
  completedAt: "2026-08-06T12:02:02.829Z",
  durationMs: 139031,
  tokenUsage: attempt.tokenUsage,
});

const legacyRun = {
  startedAt: "2026-08-06T11:00:00.000Z",
  completedAt: "2026-08-06T11:01:00.000Z",
  durationMs: 60000,
  tokenUsage: {
    available: true,
    turns: 1,
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 2,
    reasoningOutputTokens: 1,
    totalTokens: 12,
  },
};
const legacy = readAttemptUsage({
  attempts: 8,
  tokenUsage: { ...legacyRun.tokenUsage, totalTokens: 999 },
  lastRun: legacyRun,
});
assert.equal(legacy.schemaVersion, 1);
assert.equal(legacy.attempt, 8);
assert.equal(legacy.tokenUsage.totalTokens, 12);
assert.equal(legacy.tokenUsage.coverage, "full");
assert.equal(legacy.tokenUsage.uncachedInputTokens, 6);
assert.equal(legacy.tokenUsage.visibleOutputTokens, 1);
assert.equal(
  readAttemptUsage({ attempts: 2, lastAttempt: legacyRun }).tokenUsage
    .totalTokens,
  12,
);
assert.equal(
  readAttemptUsage({ attempts: 2, tokenUsage: legacyRun.tokenUsage }),
  null,
);

const unavailable = parseExecutionStats(
  `${JSON.stringify({ type: "turn.failed", error: { message: "failed" } })}\n`,
);
assert.deepEqual(unavailable.tokenUsage, {
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
});
assert.equal(
  buildAttemptUsageV2({
    taskId: "failed-turn",
    attempt: 1,
    status: "failed",
    stats: unavailable,
  }).tokenUsage.available,
  false,
);

process.stdout.write("execution stats test passed\n");
