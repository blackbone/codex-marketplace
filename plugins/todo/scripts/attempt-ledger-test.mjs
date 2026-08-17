import assert from "node:assert/strict";
import {
  appendDeliveryAttempt,
  appendModelAttempt,
  canAutoRetryFailure,
  classifyFailure,
  createAttemptLedger,
} from "./attempt-ledger.mjs";

const timing = Object.freeze({
  startedAt: "2026-08-06T10:00:00.000Z",
  completedAt: "2026-08-06T10:00:01.000Z",
  durationMs: 1000,
});
const usage = Object.freeze({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });

const empty = createAttemptLedger();
const failed = appendModelAttempt(empty, {
  status: "failed_transient",
  errorKind: "rate_limit",
  timing,
  tokenUsage: usage,
  usagePath: ".todo/logs/1/attempt-1/usage.json",
});
assert.equal(empty.attempts.length, 0);
assert.equal(failed.attempts.length, 1);
assert.match(failed.attempts[0].attemptId, /^[0-9a-f-]{36}$/);
assert.equal(failed.attempts[0].trigger, "initial");
assert.equal(failed.attempts[0].retryOf, null);
assert.deepEqual(failed.retryStats, {
  modelRetries: 0,
  automaticRetries: 0,
  manualRetries: 0,
  deliveryRetries: 0,
});
assert(Object.isFrozen(failed));
assert(Object.isFrozen(failed.attempts));
assert(Object.isFrozen(failed.attempts[0]));

const automatic = appendModelAttempt(failed, {
  trigger: "automatic_retry",
  status: "failed_permanent",
  errorKind: "invalid_schema",
  timing,
  tokenUsage: usage,
  usagePath: ".todo/logs/1/attempt-2/usage.json",
});
assert.equal(automatic.attempts[1].retryOf, failed.attempts[0].attemptId);
assert.deepEqual(automatic.retryStats, {
  modelRetries: 1,
  automaticRetries: 1,
  manualRetries: 0,
  deliveryRetries: 0,
});

const manual = appendModelAttempt(automatic, {
  trigger: "manual_retry",
  status: "completed",
  timing,
  tokenUsage: usage,
  usagePath: ".todo/logs/1/attempt-3/usage.json",
});
assert.equal(manual.attempts[2].retryOf, automatic.attempts[1].attemptId);
assert.deepEqual(manual.retryStats, {
  modelRetries: 2,
  automaticRetries: 1,
  manualRetries: 1,
  deliveryRetries: 0,
});

const deliveryFailed = appendDeliveryAttempt(manual, {
  status: "failed_transient",
  errorKind: "network_error",
  timing,
  usagePath: ".todo/logs/1/delivery-1.json",
});
const delivered = appendDeliveryAttempt(deliveryFailed, {
  status: "completed",
  timing,
  usagePath: ".todo/logs/1/delivery-2.json",
});
assert.equal(delivered.attempts.length, 3);
assert.equal(delivered.deliveryAttempts.length, 2);
assert.equal(
  delivered.deliveryAttempts[1].retryOf,
  delivered.deliveryAttempts[0].attemptId,
);
assert.deepEqual(delivered.retryStats, {
  modelRetries: 2,
  automaticRetries: 1,
  manualRetries: 1,
  deliveryRetries: 1,
});
assert.throws(
  () =>
    appendDeliveryAttempt(delivered, {
      status: "completed",
      timing,
    }),
  /completed delivery/,
);

for (const [failure, status] of [
  [{ errorKind: "firebase_auth_error" }, "blocked_interactive"],
  [{ code: "EPERM", message: "operation not permitted" }, "failed_permanent"],
  [{ message: "user cancelled MCP tool call" }, "cancelled"],
  [{ errorKind: "required_mcp_unavailable" }, "blocked_preflight"],
  [{ errorKind: "invalid_config" }, "failed_permanent"],
  [{ errorKind: "invalid_schema" }, "failed_permanent"],
  [{ requiresInteractive: true }, "blocked_interactive"],
  [{ code: 429 }, "failed_transient"],
  [{ code: "ECONNRESET" }, "failed_transient"],
  [{ errorKind: "timeout" }, "failed_transient"],
  [{ errorKind: "codex_exec" }, "failed_permanent"],
]) {
  assert.equal(classifyFailure(failure).status, status);
}
assert(canAutoRetryFailure({ code: 503 }));
assert(!canAutoRetryFailure({ errorKind: "agent_reported_failure" }));
const permanent = appendModelAttempt(createAttemptLedger(), {
  status: "failed_permanent",
  errorKind: "permission_denied",
  timing,
  tokenUsage: usage,
});
assert.throws(
  () =>
    appendModelAttempt(permanent, {
      trigger: "automatic_retry",
      status: "completed",
      timing,
      tokenUsage: usage,
    }),
  /failed_transient/,
);

process.stdout.write("attempt ledger tests passed\n");
