import { randomUUID } from "node:crypto";

export const ATTEMPT_STATUSES = Object.freeze([
  "completed",
  "failed_transient",
  "failed_permanent",
  "blocked_interactive",
  "blocked_preflight",
  "cancelled",
]);

const MODEL_TRIGGERS = new Set([
  "initial",
  "automatic_retry",
  "manual_retry",
  "merge_conflict",
]);
const STATUS_SET = new Set(ATTEMPT_STATUSES);
const TRANSIENT_KINDS = new Set([
  "app_server",
  "app_server_disconnected",
  "connection_reset",
  "interrupted",
  "network_error",
  "rate_limit",
  "server_error",
  "service_unavailable",
  "temporary_failure",
  "timeout",
  "upstream_5xx",
]);
const TRANSIENT_CODES = new Set([
  "408",
  "425",
  "429",
  "500",
  "502",
  "503",
  "504",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

function normalized(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function result(status, errorKind) {
  return Object.freeze({
    status,
    errorKind: normalized(errorKind) || "unknown",
    retryable: status === "failed_transient",
  });
}

export function classifyFailure({
  errorKind = "",
  code = "",
  message = "",
  requiresInteractive = false,
  phase = "",
} = {}) {
  const kind = normalized(errorKind);
  const upperCode = String(code || "").trim().toUpperCase();
  const text = `${kind} ${upperCode} ${message}`.toLowerCase();

  if (/user.{0,16}cancel|cancelled.{0,16}user|canceled.{0,16}user/.test(text)) {
    return result("cancelled", errorKind || "user_cancelled");
  }
  if (requiresInteractive || /interactive|approval_required/.test(text)) {
    return result("blocked_interactive", errorKind || "interactive_required");
  }
  if (
    /required[_ ]mcp|mcp[_ ]required|missing[_ ]mcp|mcp.{0,16}(unavailable|not available)/.test(
      text,
    ) ||
    normalized(phase) === "preflight"
  ) {
    return result("blocked_preflight", errorKind || "preflight_failed");
  }
  if (
    /auth|unauthori[sz]ed|unauthenticated|login_required|not_logged_in/.test(
      text,
    )
  ) {
    return result("blocked_interactive", errorKind || "authentication_required");
  }
  if (
    /permission|access_denied|operation_not_permitted|read.?only|\beacces\b|\beperm\b/.test(
      text,
    )
  ) {
    return result("failed_permanent", errorKind || "permission_denied");
  }
  if (/config|schema|invalid_result|validation/.test(text)) {
    return result("failed_permanent", errorKind || "invalid_configuration");
  }
  if (
    TRANSIENT_KINDS.has(kind) ||
    TRANSIENT_CODES.has(upperCode) ||
    /timed?\s*out|rate.?limit|too many requests|bad gateway|service unavailable|gateway timeout|connection reset|internal server error|http\s*5\d\d/.test(
      text,
    )
  ) {
    return result("failed_transient", errorKind || code || "transient_failure");
  }
  return result("failed_permanent", errorKind || "unknown");
}

export function canAutoRetryFailure(failure) {
  return classifyFailure(failure).retryable;
}

function retryStats(attempts, deliveryAttempts) {
  return Object.freeze({
    modelRetries: attempts.filter((item) => item.trigger !== "initial").length,
    automaticRetries: attempts.filter(
      (item) => item.trigger === "automatic_retry",
    ).length,
    manualRetries: attempts.filter((item) => item.trigger === "manual_retry")
      .length,
    deliveryRetries: Math.max(0, deliveryAttempts.length - 1),
  });
}

function arrays(ledger) {
  const attempts = ledger?.attempts ?? [];
  const deliveryAttempts = ledger?.deliveryAttempts ?? [];
  if (!Array.isArray(attempts) || !Array.isArray(deliveryAttempts)) {
    throw new TypeError("attempts and deliveryAttempts must be arrays");
  }
  return { attempts, deliveryAttempts };
}

function timing(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("timing is required");
  }
  const { startedAt, completedAt, durationMs } = value;
  if (
    typeof startedAt !== "string" ||
    typeof completedAt !== "string" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new TypeError("timing requires startedAt, completedAt, and durationMs");
  }
  return Object.freeze({ startedAt, completedAt, durationMs });
}

function tokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tokenUsage is required");
  }
  for (const [key, count] of Object.entries(value)) {
    if (key === "available" && typeof count === "boolean") continue;
    if (
      key === "coverage" &&
      ["full", "partial", "none", "unknown"].includes(count)
    ) {
      continue;
    }
    if (!Number.isFinite(count) || count < 0) {
      throw new TypeError(`tokenUsage.${key} must be a non-negative number`);
    }
  }
  return Object.freeze({ ...value });
}

function commonRecord(input, attempt, trigger, retryOf, includeTokens) {
  if (!STATUS_SET.has(input.status)) {
    throw new TypeError(`invalid attempt status: ${input.status}`);
  }
  if (input.status !== "completed" && !String(input.errorKind || "").trim()) {
    throw new TypeError("errorKind is required for non-completed attempts");
  }
  if (input.usagePath != null && typeof input.usagePath !== "string") {
    throw new TypeError("usagePath must be a string or null");
  }
  const attemptId = input.attemptId || randomUUID();
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      attemptId,
    )
  ) {
    throw new TypeError("attemptId must be a UUID");
  }
  return Object.freeze({
    attempt,
    attemptId,
    retryOf,
    trigger,
    status: input.status,
    errorKind: input.errorKind || null,
    timing: timing(input.timing),
    ...(includeTokens ? { tokenUsage: tokenUsage(input.tokenUsage) } : {}),
    usagePath: input.usagePath ?? null,
  });
}

function nextLedger(ledger, attempts, deliveryAttempts) {
  return Object.freeze({
    ...(ledger || {}),
    attempts: Object.freeze(attempts),
    deliveryAttempts: Object.freeze(deliveryAttempts),
    retryStats: retryStats(attempts, deliveryAttempts),
  });
}

export function createAttemptLedger() {
  return nextLedger({}, [], []);
}

export function appendModelAttempt(ledger, input) {
  const { attempts, deliveryAttempts } = arrays(ledger);
  const trigger = input?.trigger || (attempts.length === 0 ? "initial" : "");
  if (!MODEL_TRIGGERS.has(trigger)) {
    throw new TypeError(`invalid model attempt trigger: ${trigger || "missing"}`);
  }
  if ((attempts.length === 0) !== (trigger === "initial")) {
    throw new TypeError("only the first model attempt may use initial trigger");
  }
  const previous = attempts.at(-1) || null;
  if (previous?.status === "completed" && trigger !== "merge_conflict") {
    throw new Error("cannot retry a completed model attempt");
  }
  if (trigger === "merge_conflict" && attempts.length === 0) {
    throw new Error("merge conflict repair requires a completed implementation attempt");
  }
  if (trigger === "automatic_retry" && previous?.status !== "failed_transient") {
    throw new Error("automatic retry requires a failed_transient model attempt");
  }
  const record = commonRecord(
    input,
    attempts.length + 1,
    trigger,
    previous?.attemptId || null,
    true,
  );
  return nextLedger(ledger, [...attempts, record], [...deliveryAttempts]);
}

export function appendDeliveryAttempt(ledger, input) {
  const { attempts, deliveryAttempts } = arrays(ledger);
  const previous = deliveryAttempts.at(-1) || null;
  if (attempts.at(-1)?.status !== "completed") {
    throw new Error("delivery requires a completed model attempt");
  }
  if (previous?.status === "completed") {
    throw new Error("cannot retry a completed delivery attempt");
  }
  const record = commonRecord(
    input,
    deliveryAttempts.length + 1,
    previous ? "delivery_retry" : "initial",
    previous?.attemptId || null,
    false,
  );
  return nextLedger(ledger, [...attempts], [...deliveryAttempts, record]);
}
