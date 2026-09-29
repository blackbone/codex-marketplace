import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const DEFAULT_PREFLIGHT_TTL_MS = 5 * 60 * 1000;
export const MAX_PREFLIGHT_TTL_MS = 15 * 60 * 1000;

const CAPABILITY_STATUSES = new Set([
  "ok",
  "failed",
  "interactive_required",
]);
const CAPABILITY_ACCESSES = new Set(["read", "write"]);
const MAX_SUMMARY_LENGTH = 500;

export function commandCheck(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });
  return {
    status: result.status === 0 ? "ok" : "failed",
    summary: String(result.stderr || result.stdout || `${command} failed`)
      .replace(/[\0\r\n]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, MAX_SUMMARY_LENGTH),
  };
}

export class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PreflightError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    fail("invalid_input", `${label} contains unsupported field: ${unknown}`);
  }
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_input", `${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\0\r\n]/u.test(normalized)) {
    fail("invalid_input", `${label} is invalid`);
  }
  return normalized;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_input", "value is not JSON-safe");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("invalid_input", "value contains a cycle");
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) fail("invalid_input", "value is not JSON-safe");
  if (seen.has(value)) fail("invalid_input", "value contains a cycle");
  seen.add(value);
  const result = `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return result;
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalRepoRoot(repoRoot) {
  const resolved = path.resolve(
    boundedText(repoRoot, "repoRoot", 8000),
  );
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function normalizeCapabilityIdentity(value, label = "capability") {
  if (!isPlainObject(value)) fail("invalid_input", `${label} must be an object`);
  const connector = boundedText(value.connector, `${label}.connector`, 200)
    .toLowerCase();
  const scope = boundedText(value.scope, `${label}.scope`, 1000);
  const access = boundedText(value.access, `${label}.access`, 20)
    .toLowerCase();
  if (!CAPABILITY_ACCESSES.has(access)) {
    fail("invalid_input", `${label}.access must be read or write`);
  }
  return { connector, scope, access };
}

export function capabilityKey(value) {
  const capability = normalizeCapabilityIdentity(value);
  return JSON.stringify([
    capability.connector,
    capability.scope,
    capability.access,
  ]);
}

function reportStatus(value, label) {
  let status = value.status;
  if (status === undefined) {
    if (value.interactiveRequired === true) status = "interactive_required";
    else if (value.ok === true) status = "ok";
    else if (value.ok === false) status = "failed";
  }
  if (!CAPABILITY_STATUSES.has(status)) {
    fail(
      "invalid_input",
      `${label}.status must be ok, failed, or interactive_required`,
    );
  }
  if (value.ok !== undefined) {
    if (typeof value.ok !== "boolean" || value.ok !== (status === "ok")) {
      fail("invalid_input", `${label}.ok conflicts with status`);
    }
  }
  if (value.interactiveRequired !== undefined) {
    if (
      typeof value.interactiveRequired !== "boolean" ||
      value.interactiveRequired !== (status === "interactive_required")
    ) {
      fail(
        "invalid_input",
        `${label}.interactiveRequired conflicts with status`,
      );
    }
  }
  return status;
}

function strongerFailure(left, right) {
  const rank = { ok: 0, failed: 1, interactive_required: 2 };
  return rank[left] >= rank[right] ? left : right;
}

export function normalizeCapabilityReports(reports) {
  if (!Array.isArray(reports)) {
    fail("invalid_input", "capabilityReports must be an array");
  }
  const normalized = new Map();
  for (const [index, value] of reports.entries()) {
    const label = `capabilityReports[${index}]`;
    if (!isPlainObject(value)) fail("invalid_input", `${label} must be an object`);
    assertAllowedKeys(
      value,
      new Set([
        "connector",
        "scope",
        "access",
        "required",
        "status",
        "ok",
        "interactiveRequired",
        "summary",
      ]),
      label,
    );
    const identity = normalizeCapabilityIdentity(value, label);
    const status = reportStatus(value, label);
    const required = value.required === undefined ? true : value.required;
    if (typeof required !== "boolean") {
      fail("invalid_input", `${label}.required must be a boolean`);
    }
    const summary =
      value.summary === undefined
        ? null
        : boundedText(value.summary, `${label}.summary`, MAX_SUMMARY_LENGTH);
    const key = capabilityKey(identity);
    const previous = normalized.get(key);
    normalized.set(
      key,
      previous
        ? {
            ...identity,
            required: previous.required || required,
            status: strongerFailure(previous.status, status),
            summary: previous.summary || summary,
          }
        : { ...identity, required, status, summary },
    );
  }
  return [...normalized.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, report]) => {
      const { summary, ...rest } = report;
      return summary === null ? rest : { ...rest, summary };
    });
}

function normalizedLocalResult(value, name, required) {
  if (typeof value === "boolean") {
    return { name, required, status: value ? "ok" : "failed" };
  }
  if (!isPlainObject(value)) {
    fail("invalid_input", `local check ${name} returned an invalid result`);
  }
  assertAllowedKeys(
    value,
    new Set(["status", "ok", "interactiveRequired", "summary"]),
    `local check ${name} result`,
  );
  const status = reportStatus(value, `local check ${name} result`);
  const summary =
    value.summary === undefined
      ? null
      : boundedText(
          value.summary,
          `local check ${name} result.summary`,
          MAX_SUMMARY_LENGTH,
        );
  return summary === null
    ? { name, required, status }
    : { name, required, status, summary };
}

export async function runLocalPreflightChecks(checks, context = {}) {
  if (!Array.isArray(checks)) fail("invalid_input", "checks must be an array");
  const names = new Set();
  const results = [];
  for (const [index, check] of checks.entries()) {
    if (!isPlainObject(check)) {
      fail("invalid_input", `checks[${index}] must be an object`);
    }
    assertAllowedKeys(check, new Set(["name", "required", "run"]), `checks[${index}]`);
    const name = boundedText(check.name, `checks[${index}].name`, 200);
    if (names.has(name)) fail("invalid_input", `duplicate local check: ${name}`);
    names.add(name);
    const required = check.required === undefined ? true : check.required;
    if (typeof required !== "boolean" || typeof check.run !== "function") {
      fail("invalid_input", `checks[${index}] is invalid`);
    }
    let result;
    try {
      result = await check.run(context);
    } catch (error) {
      results.push({
        name,
        required,
        status: "failed",
        summary: String(error?.message || error).slice(0, MAX_SUMMARY_LENGTH),
      });
      continue;
    }
    results.push(normalizedLocalResult(result, name, required));
  }
  return {
    ok: results.every(
      (result) => !result.required || result.status === "ok",
    ),
    checks: results,
  };
}

function normalizeLocalPreflight(value) {
  if (value === undefined) return { ok: true, checks: [] };
  if (!isPlainObject(value) || !Array.isArray(value.checks)) {
    fail("invalid_input", "localPreflight must be a local check result");
  }
  assertAllowedKeys(value, new Set(["ok", "checks"]), "localPreflight");
  const names = new Set();
  const checks = value.checks.map((check, index) => {
    if (!isPlainObject(check)) {
      fail("invalid_input", `localPreflight.checks[${index}] is invalid`);
    }
    assertAllowedKeys(
      check,
      new Set([
        "name",
        "required",
        "status",
        "ok",
        "interactiveRequired",
        "summary",
      ]),
      `localPreflight.checks[${index}]`,
    );
    const name = boundedText(
      check.name,
      `localPreflight.checks[${index}].name`,
      200,
    );
    if (names.has(name)) {
      fail("invalid_input", `duplicate local check result: ${name}`);
    }
    names.add(name);
    const required = check.required === undefined ? true : check.required;
    if (typeof required !== "boolean") {
      fail("invalid_input", `localPreflight.checks[${index}].required is invalid`);
    }
    const status = reportStatus(
      check,
      `localPreflight.checks[${index}]`,
    );
    if (check.summary !== undefined) {
      boundedText(
        check.summary,
        `localPreflight.checks[${index}].summary`,
        MAX_SUMMARY_LENGTH,
      );
    }
    return { name, required, status };
  });
  const ok = checks.every((check) => !check.required || check.status === "ok");
  if (value.ok !== undefined && value.ok !== ok) {
    fail("invalid_input", "localPreflight.ok conflicts with check results");
  }
  return { ok, checks };
}

export function repoConfigFingerprint(repoRoot, config) {
  return digest({
    repoRoot: canonicalRepoRoot(repoRoot),
    configFingerprint: digest(config),
  });
}

function normalizedNow(value) {
  const number = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(number)) fail("invalid_input", "now is invalid");
  return Math.trunc(number);
}

export function createPreflightReceipt({
  repoRoot,
  config,
  capabilityReports = [],
  localPreflight,
  ttlMs = DEFAULT_PREFLIGHT_TTL_MS,
  now = Date.now(),
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_PREFLIGHT_TTL_MS) {
    fail(
      "invalid_input",
      `ttlMs must be between 1000 and ${MAX_PREFLIGHT_TTL_MS}`,
    );
  }
  const issuedAt = normalizedNow(now);
  const reports = normalizeCapabilityReports(capabilityReports);
  const failed = reports.filter(
    (report) => report.required && report.status !== "ok",
  );
  if (failed.length > 0) {
    fail(
      failed.some((report) => report.status === "interactive_required")
        ? "interactive_required"
        : "preflight_failed",
      `required capabilities did not pass: ${failed
        .map((report) => `${capabilityKey(report)}=${report.status}`)
        .join(", ")}`,
    );
  }
  const local = normalizeLocalPreflight(localPreflight);
  if (!local.ok) fail("preflight_failed", "required local checks did not pass");

  const payload = {
    version: 1,
    id: randomUUID(),
    repoRoot: canonicalRepoRoot(repoRoot),
    bindingFingerprint: repoConfigFingerprint(repoRoot, config),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    capabilities: reports
      .filter((report) => report.status === "ok")
      .map(({ connector, scope, access }) => ({ connector, scope, access })),
    localChecks: local.checks
      .filter((check) => check.status === "ok")
      .map((check) => check.name)
      .sort(),
  };
  return { ...payload, integrity: digest(payload) };
}

function equalDigest(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !/^[a-f0-9]{64}$/u.test(left) ||
    !/^[a-f0-9]{64}$/u.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function normalizeRequiredCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    fail("invalid_input", "requiredCapabilities must be an array");
  }
  const unique = new Map();
  for (const [index, value] of capabilities.entries()) {
    if (!isPlainObject(value)) {
      fail("invalid_input", `requiredCapabilities[${index}] must be an object`);
    }
    assertAllowedKeys(
      value,
      new Set(["connector", "scope", "access"]),
      `requiredCapabilities[${index}]`,
    );
    const identity = normalizeCapabilityIdentity(
      value,
      `requiredCapabilities[${index}]`,
    );
    unique.set(capabilityKey(identity), identity);
  }
  return [...unique.values()];
}

export function validatePreflightReceipt(
  receipt,
  {
    repoRoot,
    config,
    requiredCapabilities = [],
    requiredLocalChecks = [],
    now = Date.now(),
  } = {},
) {
  if (!isPlainObject(receipt)) fail("invalid_receipt", "receipt is invalid");
  const allowed = new Set([
    "version",
    "id",
    "repoRoot",
    "bindingFingerprint",
    "issuedAt",
    "expiresAt",
    "capabilities",
    "localChecks",
    "integrity",
  ]);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    fail("invalid_receipt", "receipt contains unsupported fields");
  }
  const { integrity, ...payload } = receipt;
  if (
    receipt.version !== 1 ||
    typeof receipt.id !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(receipt.id) ||
    !Array.isArray(receipt.capabilities) ||
    !Array.isArray(receipt.localChecks) ||
    !equalDigest(integrity, digest(payload))
  ) {
    fail("invalid_receipt", "receipt integrity check failed");
  }
  const currentTime = normalizedNow(now);
  if (
    !Number.isInteger(receipt.issuedAt) ||
    !Number.isInteger(receipt.expiresAt) ||
    receipt.expiresAt <= receipt.issuedAt ||
    receipt.expiresAt - receipt.issuedAt > MAX_PREFLIGHT_TTL_MS
  ) {
    fail("invalid_receipt", "receipt timestamps are invalid");
  }
  if (currentTime >= receipt.expiresAt) {
    fail("expired_receipt", "preflight receipt has expired");
  }
  if (currentTime < receipt.issuedAt - 30000) {
    fail("invalid_receipt", "preflight receipt is from the future");
  }
  const expectedRoot = canonicalRepoRoot(repoRoot);
  if (
    receipt.repoRoot !== expectedRoot ||
    receipt.bindingFingerprint !== repoConfigFingerprint(repoRoot, config)
  ) {
    fail("receipt_binding_mismatch", "receipt does not match repository config");
  }
  const available = new Set(
    normalizeRequiredCapabilities(receipt.capabilities).map(capabilityKey),
  );
  const missing = normalizeRequiredCapabilities(requiredCapabilities)
    .map(capabilityKey)
    .filter((key) => !available.has(key));
  if (missing.length > 0) {
    fail(
      "capability_missing",
      `receipt does not cover required capabilities: ${missing.join(", ")}`,
    );
  }
  if (
    !Array.isArray(requiredLocalChecks) ||
    requiredLocalChecks.some(
      (name) => typeof name !== "string" || !name.trim(),
    )
  ) {
    fail("invalid_input", "requiredLocalChecks must be an array of names");
  }
  const localChecks = new Set(receipt.localChecks);
  const missingLocal = [...new Set(requiredLocalChecks.map((name) => name.trim()))]
    .filter((name) => !localChecks.has(name));
  if (missingLocal.length > 0) {
    fail(
      "local_check_missing",
      `receipt does not cover required local checks: ${missingLocal.join(", ")}`,
    );
  }
  return receipt;
}

function normalizedBatchFiles(reservation) {
  const files = Array.isArray(reservation) ? reservation : reservation?.files;
  if (!Array.isArray(files) || files.length === 0) {
    fail("invalid_batch", "reserve must return a non-empty files array");
  }
  const paths = new Set();
  return files.map((file, index) => {
    if (!isPlainObject(file)) fail("invalid_batch", `files[${index}] is invalid`);
    assertAllowedKeys(
      file,
      new Set(["relativePath", "content", "mode"]),
      `files[${index}]`,
    );
    const relativePath = boundedText(
      file.relativePath,
      `files[${index}].relativePath`,
      4000,
    );
    const normalizedPath = path.normalize(relativePath);
    if (
      path.isAbsolute(relativePath) ||
      normalizedPath === ".." ||
      normalizedPath.startsWith(`..${path.sep}`) ||
      normalizedPath === "." ||
      paths.has(normalizedPath)
    ) {
      fail("invalid_batch", `files[${index}].relativePath is unsafe or duplicate`);
    }
    paths.add(normalizedPath);
    if (
      typeof file.content !== "string" &&
      !Buffer.isBuffer(file.content) &&
      !(file.content instanceof Uint8Array)
    ) {
      fail("invalid_batch", `files[${index}].content is invalid`);
    }
    if (
      file.mode !== undefined &&
      (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
    ) {
      fail("invalid_batch", `files[${index}].mode is invalid`);
    }
    return {
      relativePath: normalizedPath,
      content: file.content,
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    };
  });
}

export async function publishAtomicBatch({
  inputs,
  validateInput,
  reserve,
  destinationDir,
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    fail("invalid_batch", "inputs must be a non-empty array");
  }
  if (typeof validateInput !== "function" || typeof reserve !== "function") {
    fail("invalid_batch", "validateInput and reserve callbacks are required");
  }
  const destination = path.resolve(
    boundedText(destinationDir, "destinationDir", 8000),
  );
  if (destination === path.parse(destination).root || existsSync(destination)) {
    fail("invalid_batch", "destinationDir is unsafe or already exists");
  }

  const validated = [];
  for (const [index, input] of inputs.entries()) {
    const result = await validateInput(input, index);
    if (result === false) fail("invalid_batch", `inputs[${index}] is invalid`);
    validated.push(result === undefined || result === true ? input : result);
  }

  // reserve is the first callback allowed to mutate sequence state.
  const reservation = await reserve(validated);
  const files = normalizedBatchFiles(reservation);
  const parent = path.dirname(destination);
  const staging = path.join(
    parent,
    `.${path.basename(destination)}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    mkdirSync(staging, { recursive: false });
    for (const file of files) {
      const target = path.join(staging, file.relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
      if (file.mode !== undefined) chmodSync(target, file.mode);
    }
    renameSync(staging, destination);
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    destinationDir: destination,
    files: files.map((file) => file.relativePath),
    reservation: Array.isArray(reservation) ? null : reservation?.value ?? null,
  };
}
