import { Buffer } from "node:buffer";

const REQUEST_STATS_UNAVAILABLE = {
  available: false,
  coverage: "none",
  requests: [],
  transportRetries: 0,
  reason: "codex_exec_json_has_turn_totals_only",
};

const OTLP_NUMERIC_ATTRIBUTES = new Set([
  "attempt",
  "input_token_count",
  "output_token_count",
  "cached_token_count",
  "cache_write_token_count",
  "reasoning_token_count",
  "ttft_ms",
]);

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function payloadBytes(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value);
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function emptyTokenUsage() {
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

function tokenUsage(value, turns = 0, available = value !== undefined) {
  if (
    !available ||
    !value ||
    typeof value !== "object" ||
    value.available === false
  ) {
    return emptyTokenUsage();
  }
  const inputTokens = nonNegative(value.input_tokens ?? value.inputTokens);
  const cachedInputTokens = nonNegative(
    value.cached_input_tokens ?? value.cachedInputTokens,
  );
  const outputTokens = nonNegative(value.output_tokens ?? value.outputTokens);
  const reasoningOutputTokens = nonNegative(
    value.reasoning_output_tokens ?? value.reasoningOutputTokens,
  );
  return {
    available: true,
    coverage: ["full", "partial"].includes(value.coverage)
      ? value.coverage
      : "full",
    turns: nonNegative(turns || value.turns),
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cacheWriteInputTokens: nonNegative(
      value.cache_write_input_tokens ?? value.cacheWriteInputTokens,
    ),
    outputTokens,
    reasoningOutputTokens,
    visibleOutputTokens: Math.max(0, outputTokens - reasoningOutputTokens),
    totalTokens: inputTokens + outputTokens,
  };
}

function otlpAttribute(record, key) {
  if (!Array.isArray(record?.attributes)) return undefined;
  return record.attributes.find((attribute) => attribute?.key === key)?.value;
}

function otlpStringAttribute(record, key) {
  const value = otlpAttribute(record, key);
  return typeof value?.stringValue === "string" ? value.stringValue : null;
}

function otlpNumericAttribute(record, key) {
  if (!OTLP_NUMERIC_ATTRIBUTES.has(key)) return null;
  const value = otlpAttribute(record, key);
  const candidate = value?.intValue ?? value?.stringValue;
  if (
    typeof candidate !== "number" &&
    (typeof candidate !== "string" || !/^(?:0|[1-9]\d*)$/.test(candidate))
  ) {
    return null;
  }
  const number = Number(candidate);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function* otlpLogRecords(batches) {
  const list = Array.isArray(batches) ? batches : batches ? [batches] : [];
  for (const batch of list) {
    for (const resourceLog of batch?.resourceLogs || []) {
      for (const scopeLog of resourceLog?.scopeLogs || []) {
        for (const record of scopeLog?.logRecords || []) yield record;
      }
    }
  }
}

function sumRequestUsage(requests) {
  const sum = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  for (const request of requests) {
    for (const key of Object.keys(sum)) sum[key] += request.tokenUsage[key];
  }
  return tokenUsage(sum, requests.length);
}

function usageMatches(left, right) {
  if (!left.available || !right.available) return false;
  return [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ].every((key) => left[key] === right[key]);
}

export function parseOtlpRequestStats(batches, aggregateUsage) {
  const requests = [];
  let transportRetries = 0;

  for (const record of otlpLogRecords(batches)) {
    const eventName = otlpStringAttribute(record, "event.name");
    if (eventName === "codex.api_request") {
      const attempt = otlpNumericAttribute(record, "attempt");
      if (attempt !== null && attempt > 0) transportRetries += 1;
      continue;
    }
    if (
      eventName !== "codex.sse_event" ||
      otlpStringAttribute(record, "event.kind") !== "response.completed"
    ) {
      continue;
    }

    const inputTokens = otlpNumericAttribute(record, "input_token_count");
    const outputTokens = otlpNumericAttribute(record, "output_token_count");
    if (inputTokens === null || outputTokens === null) continue;
    const requestUsage = tokenUsage(
      {
        inputTokens,
        cachedInputTokens:
          otlpNumericAttribute(record, "cached_token_count") ?? 0,
        cacheWriteInputTokens:
          otlpNumericAttribute(record, "cache_write_token_count") ?? 0,
        outputTokens,
        reasoningOutputTokens:
          otlpNumericAttribute(record, "reasoning_token_count") ?? 0,
      },
      1,
    );
    requests.push({
      requestIndex: requests.length + 1,
      tokenUsage: requestUsage,
      ttftMs: otlpNumericAttribute(record, "ttft_ms"),
    });
  }

  if (requests.length === 0) {
    return { ...REQUEST_STATS_UNAVAILABLE, requests: [], transportRetries };
  }
  const requestTokenUsage = sumRequestUsage(requests);
  const aggregate = tokenUsage(aggregateUsage, aggregateUsage?.turns);
  return {
    available: true,
    coverage: usageMatches(requestTokenUsage, aggregate) ? "full" : "partial",
    requests,
    transportRetries,
    tokenUsage: requestTokenUsage,
  };
}

function completedItem(event, type) {
  return event?.type === "item.completed" && event.item?.type === type
    ? event.item
    : null;
}

function toolKey(server, tool) {
  return `${String(server || "unknown")}/${String(tool || "unknown")}`;
}

function sortedCounts(map) {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, value]) => ({ type, ...value }));
}

function itemPayloadBytes(item) {
  const payload = { ...item };
  delete payload.id;
  delete payload.type;
  delete payload.status;
  return payloadBytes(payload);
}

export function parseExecutionStats(jsonl) {
  if (typeof jsonl !== "string") {
    throw new TypeError("execution JSONL must be a string");
  }

  const eventTypes = new Map();
  const tools = new Map();
  const observable = {
    jsonl: {
      bytes: Buffer.byteLength(jsonl),
      lines: 0,
      events: 0,
      invalidLines: 0,
      byType: [],
    },
    mcp: {
      calls: 0,
      completed: 0,
      failed: 0,
      argumentBytes: 0,
      resultBytes: 0,
      errorBytes: 0,
      byTool: [],
    },
    shell: {
      calls: 0,
      completed: 0,
      failed: 0,
      commandBytes: 0,
      outputBytes: 0,
    },
    reasoning: { items: 0, bytes: 0 },
    agentMessages: { items: 0, bytes: 0 },
    fileChanges: { items: 0, files: 0, bytes: 0 },
    webSearches: { items: 0, bytes: 0 },
  };
  let threadId = null;
  let completedTurns = 0;
  let lastUsage;

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    observable.jsonl.lines += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      observable.jsonl.invalidLines += 1;
      continue;
    }
    observable.jsonl.events += 1;
    const type = typeof event?.type === "string" ? event.type : "unknown";
    const eventType = eventTypes.get(type) || { count: 0, bytes: 0 };
    eventType.count += 1;
    eventType.bytes += Buffer.byteLength(line);
    eventTypes.set(type, eventType);

    if (type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }
    if (type === "turn.completed" && event.usage) {
      completedTurns += 1;
      lastUsage = event.usage;
    }

    const mcp = completedItem(event, "mcp_tool_call");
    if (mcp) {
      const key = toolKey(mcp.server, mcp.tool);
      const entry = tools.get(key) || {
        server: String(mcp.server || "unknown"),
        tool: String(mcp.tool || "unknown"),
        calls: 0,
        completed: 0,
        failed: 0,
        argumentBytes: 0,
        resultBytes: 0,
        errorBytes: 0,
      };
      const failed = Boolean(mcp.status === "failed" || mcp.error);
      const argumentBytes = payloadBytes(mcp.arguments);
      const resultBytes = payloadBytes(mcp.result);
      const errorBytes = payloadBytes(mcp.error);
      entry.calls += 1;
      entry.completed += failed ? 0 : 1;
      entry.failed += failed ? 1 : 0;
      entry.argumentBytes += argumentBytes;
      entry.resultBytes += resultBytes;
      entry.errorBytes += errorBytes;
      tools.set(key, entry);
      observable.mcp.calls += 1;
      observable.mcp.completed += failed ? 0 : 1;
      observable.mcp.failed += failed ? 1 : 0;
      observable.mcp.argumentBytes += argumentBytes;
      observable.mcp.resultBytes += resultBytes;
      observable.mcp.errorBytes += errorBytes;
    }

    const shell = completedItem(event, "command_execution");
    if (shell) {
      const failed =
        shell.status !== "completed" ||
        (shell.exit_code !== null &&
          shell.exit_code !== undefined &&
          Number(shell.exit_code) !== 0);
      observable.shell.calls += 1;
      observable.shell.completed += failed ? 0 : 1;
      observable.shell.failed += failed ? 1 : 0;
      observable.shell.commandBytes += payloadBytes(shell.command);
      observable.shell.outputBytes += payloadBytes(shell.aggregated_output);
    }

    const reasoning = completedItem(event, "reasoning");
    if (reasoning) {
      observable.reasoning.items += 1;
      observable.reasoning.bytes += payloadBytes(reasoning.text);
    }
    const message = completedItem(event, "agent_message");
    if (message) {
      observable.agentMessages.items += 1;
      observable.agentMessages.bytes += payloadBytes(message.text);
    }
    const fileChange = completedItem(event, "file_change");
    if (fileChange) {
      observable.fileChanges.items += 1;
      observable.fileChanges.files += Array.isArray(fileChange.changes)
        ? fileChange.changes.length
        : 0;
      observable.fileChanges.bytes += itemPayloadBytes(fileChange);
    }
    const webSearch = completedItem(event, "web_search");
    if (webSearch) {
      observable.webSearches.items += 1;
      observable.webSearches.bytes += itemPayloadBytes(webSearch);
    }
  }

  observable.jsonl.byType = sortedCounts(eventTypes);
  observable.mcp.byTool = [...tools.values()].sort((left, right) =>
    toolKey(left.server, left.tool).localeCompare(
      toolKey(right.server, right.tool),
    ),
  );
  return {
    threadId,
    tokenUsage: tokenUsage(lastUsage, completedTurns, lastUsage !== undefined),
    observable,
    requestStats: { ...REQUEST_STATS_UNAVAILABLE },
  };
}

export function parseAppServerExecutionStats(jsonl, expectedTurnId = null) {
  if (typeof jsonl !== "string") {
    throw new TypeError("app-server JSONL must be a string");
  }
  const converted = [];
  let lastUsage = null;
  let observedThreadId = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      converted.push(line);
      continue;
    }
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id;
    if (expectedTurnId && turnId && turnId !== expectedTurnId) continue;
    if (params.threadId && !observedThreadId) {
      observedThreadId = params.threadId;
      converted.push(
        JSON.stringify({ type: "thread.started", thread_id: params.threadId }),
      );
    }
    if (message.method === "item/completed" && params.item) {
      const type = {
        mcpToolCall: "mcp_tool_call",
        commandExecution: "command_execution",
        agentMessage: "agent_message",
        fileChange: "file_change",
        webSearch: "web_search",
      }[params.item.type] || params.item.type;
      converted.push(
        JSON.stringify({
          type: "item.completed",
          item: {
            ...params.item,
            type,
            exit_code: params.item.exitCode,
            aggregated_output: params.item.aggregatedOutput,
          },
        }),
      );
    }
    if (message.method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage?.last;
      if (usage) {
        lastUsage = {
          input_tokens: usage.inputTokens,
          cached_input_tokens: usage.cachedInputTokens,
          cache_write_input_tokens: usage.cacheWriteInputTokens,
          output_tokens: usage.outputTokens,
          reasoning_output_tokens: usage.reasoningOutputTokens,
        };
      }
    }
  }
  if (lastUsage) {
    converted.push(JSON.stringify({ type: "turn.completed", usage: lastUsage }));
  }
  const stats = parseExecutionStats(converted.join("\n"));
  stats.observable.jsonl = {
    ...stats.observable.jsonl,
    bytes: Buffer.byteLength(jsonl),
  };
  stats.requestStats = {
    ...REQUEST_STATS_UNAVAILABLE,
    reason: "app_server_protocol_has_turn_totals_only",
  };
  return stats;
}

export function buildAttemptUsageV2({
  taskId,
  attempt,
  status,
  startedAt,
  completedAt = null,
  durationMs = 0,
  modelProfile = null,
  model = null,
  reasoningEffort = null,
  stats,
  source = "codex exec --json",
}) {
  if (!stats || typeof stats !== "object") {
    throw new TypeError("execution stats are required");
  }
  return {
    schemaVersion: 2,
    taskId: String(taskId),
    attempt: Math.max(1, Math.trunc(nonNegative(attempt)) || 1),
    status: String(status),
    startedAt: startedAt ?? null,
    completedAt,
    durationMs: nonNegative(durationMs),
    modelProfile,
    model,
    reasoningEffort,
    threadId: typeof stats.threadId === "string" ? stats.threadId : null,
    source,
    tokenUsage: tokenUsage(stats.tokenUsage, stats.tokenUsage?.turns),
    observable: stats.observable,
    requestStats: stats.requestStats?.available
      ? stats.requestStats
      : { ...REQUEST_STATS_UNAVAILABLE },
  };
}

export function readAttemptUsage(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const version = record.schemaVersion === 2 ? 2 : 1;
  const run =
    version === 2
      ? record
      : record.lastRun ||
        record.lastAttempt ||
        ((Number(record.attempts) || 0) <= 1 ? record : null);
  if (!run || typeof run !== "object" || !run.tokenUsage) return null;
  return {
    schemaVersion: version,
    attempt:
      version === 2
        ? Math.max(1, Math.trunc(nonNegative(record.attempt)) || 1)
        : Math.max(1, Math.trunc(nonNegative(record.attempts)) || 1),
    status: typeof record.status === "string" ? record.status : null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    durationMs: nonNegative(run.durationMs),
    tokenUsage: tokenUsage(run.tokenUsage, run.tokenUsage.turns),
  };
}
