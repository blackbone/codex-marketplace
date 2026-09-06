import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  realpathSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireTaskBatchGate,
  atomicWriteJson,
  readDaemonState,
  releaseTaskBatchGate,
  todoDir,
} from "./lib.mjs";

const RUNTIME_PATHS = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks",
  "scripts",
  "skills",
];
const REQUIRED_RUNTIME_FILES = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "scripts/attempt-ledger.mjs",
    "scripts/bounded-log.mjs",
    "scripts/shell-step.mjs",
    "scripts/model-profiles.mjs",
    "scripts/app-server-client.mjs",
    "scripts/desktop-client.mjs",
    "scripts/task-interaction.mjs",
    "scripts/task-chat.mjs",
    "scripts/interactive-stop.mjs",

  "scripts/daemon.mjs",
  "scripts/dashboard.mjs",
  "scripts/ensure-daemon.mjs",
  "scripts/execution-stats.mjs",
  "scripts/usage-recovery.mjs",
  "scripts/git-worktree.mjs",
  "scripts/lib.mjs",
  "scripts/mcp-server.mjs",
  "scripts/pipeline.mjs",
  "scripts/pipeline-result.schema.json",
  "scripts/ponytail-policy.mjs",
  "scripts/preflight.mjs",
  "scripts/result.schema.json",
  "scripts/routing-policy.mjs",
  "scripts/runtime-update.mjs",
  "scripts/session-context.mjs",
];
const validationCache = new Map();
const RUNTIME_ENTRYPOINTS = [
  "scripts/daemon.mjs",
  "scripts/mcp-server.mjs",
  "scripts/session-context.mjs",
];
const STATIC_IMPORT_SCANNER = `
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const output = {};
for (const file of input.files) {
  const module = new vm.SourceTextModule(
    fs.readFileSync(path.join(input.root, file), "utf8"),
    { identifier: file },
  );
  output[file] = module.moduleRequests
    ? module.moduleRequests.map((request) => request.specifier)
    : module.dependencySpecifiers;
}
process.stdout.write(JSON.stringify(output));
`;

export function daemonRestartRequestPath(repoRoot) {
  return path.join(todoDir(repoRoot), ".daemon-restart.json");
}

function runtimeFiles(pluginRoot) {
  const files = [];
  const isTestScript = (relativePath) =>
    /(?:^|[-.])test\.(?:cjs|js|mjs)$/.test(path.basename(relativePath));
  const visit = (relativePath) => {
    const absolutePath = path.join(pluginRoot, relativePath);
    if (!existsSync(absolutePath)) return;
    const entries = readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && !isTestScript(child)) files.push(child);
    }
  };

  for (const relativePath of RUNTIME_PATHS) {
    const absolutePath = path.join(pluginRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    if (relativePath.includes(".")) files.push(relativePath);
    else visit(relativePath);
  }
  return files.sort();
}

function validationMessage(value) {
  return String(value || "validation failed").trim().slice(0, 1000);
}

function outsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function validateStaticImports(pluginRoot, files) {
  const moduleFiles = files.filter((file) => file.endsWith(".mjs"));
  const scan = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-vm-modules",
      "-e",
      STATIC_IMPORT_SCANNER,
    ],
    {
      input: JSON.stringify({ root: pluginRoot, files: moduleFiles }),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    },
  );
  if (scan.status !== 0 || scan.error) {
    return [{
      path: "scripts",
      check: "imports",
      message: validationMessage(scan.error?.message || scan.stderr),
    }];
  }

  let imports;
  try {
    imports = JSON.parse(scan.stdout);
  } catch (error) {
    return [{
      path: "scripts",
      check: "imports",
      message: validationMessage(error.message),
    }];
  }

  const root = path.resolve(pluginRoot);
  const realRoot = realpathSync(root);
  const runtimeModules = new Set(moduleFiles);
  const visited = new Set();
  const diagnostics = [];
  const pending = [...RUNTIME_ENTRYPOINTS];
  while (pending.length > 0) {
    const importer = pending.pop();
    if (visited.has(importer) || !runtimeModules.has(importer)) continue;
    visited.add(importer);
    for (const specifier of imports[importer] || []) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        continue;
      }
      let target;
      try {
        target = fileURLToPath(
          new URL(specifier, pathToFileURL(path.join(root, importer))),
        );
      } catch (error) {
        diagnostics.push({
          path: importer,
          check: "imports",
          message: `${specifier}: ${validationMessage(error.message)}`,
        });
        continue;
      }
      if (outsideRoot(root, target)) {
        diagnostics.push({
          path: importer,
          check: "imports",
          message: `${specifier}: import resolves outside plugin root`,
        });
        continue;
      }
      try {
        const realTarget = realpathSync(target);
        if (outsideRoot(realRoot, realTarget)) {
          throw new Error("import resolves outside plugin root");
        }
        if (!statSync(realTarget).isFile()) {
          throw new Error("import target is not a file");
        }
        const relativeTarget = path.relative(realRoot, realTarget);
        if (relativeTarget.endsWith(".mjs")) {
          if (!runtimeModules.has(relativeTarget)) {
            throw new Error("import target is outside runtime paths");
          }
          pending.push(relativeTarget);
        }
      } catch (error) {
        diagnostics.push({
          path: importer,
          check: "imports",
          message: `${specifier}: ${validationMessage(error.message)}`,
        });
      }
    }
  }
  return diagnostics;
}

function validateRuntime(pluginRoot, files, fingerprint) {
  const cached = validationCache.get(pluginRoot);
  if (cached?.fingerprint === fingerprint) return cached.diagnostics;

  const diagnostics = [];
  for (const relativePath of files.filter((file) => file.endsWith(".json"))) {
    const absolutePath = path.join(pluginRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    try {
      JSON.parse(readFileSync(absolutePath, "utf8"));
    } catch (error) {
      diagnostics.push({
        path: relativePath,
        check: "json",
        message: validationMessage(error.message),
      });
    }
  }

  let syntaxValid = true;
  for (const relativePath of files.filter((file) => file.endsWith(".mjs"))) {
    const result = spawnSync(
      process.execPath,
      ["--check", path.join(pluginRoot, relativePath)],
      { encoding: "utf8", timeout: 5000 },
    );
    if (result.status === 0 && !result.error) continue;
    syntaxValid = false;
    diagnostics.push({
      path: relativePath,
      check: "syntax",
      message: validationMessage(result.error?.message || result.stderr),
    });
  }
  if (syntaxValid) {
    diagnostics.push(...validateStaticImports(pluginRoot, files));
  }

  validationCache.set(pluginRoot, { fingerprint, diagnostics });
  return diagnostics;
}

export function runtimeDescriptor(pluginRoot) {
  const manifestPath = path.join(
    pluginRoot,
    ".codex-plugin",
    "plugin.json",
  );
  let pluginVersion = null;
  try {
    pluginVersion = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  } catch {
    // The fingerprint still identifies a partial development checkout.
  }

  const files = runtimeFiles(pluginRoot);
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path.join(pluginRoot, relativePath)));
    hash.update("\0");
  }
  const missing = REQUIRED_RUNTIME_FILES.filter(
    (relativePath) => !existsSync(path.join(pluginRoot, relativePath)),
  );
  const fingerprint = `sha256:${hash.digest("hex")}`;
  const diagnostics = [...validateRuntime(pluginRoot, files, fingerprint)];
  if (
    (typeof pluginVersion !== "string" || pluginVersion.length === 0) &&
    !diagnostics.some(
      (diagnostic) => diagnostic.path === ".codex-plugin/plugin.json",
    )
  ) {
    diagnostics.unshift({
      path: ".codex-plugin/plugin.json",
      check: "manifest",
      message: "version must be a non-empty string",
    });
  }
  return {
    pluginVersion,
    fingerprint,
    available:
      typeof pluginVersion === "string" &&
      pluginVersion.length > 0 &&
      missing.length === 0 &&
      diagnostics.length === 0,
    missing,
    diagnostics,
  };
}

export function runtimeMismatch(daemon, target) {
  const currentFingerprint =
    daemon?.runtime?.fingerprint || daemon?.runtimeFingerprint || null;
  const currentVersion =
    daemon?.runtime?.pluginVersion || daemon?.pluginVersion || null;
  if (!currentFingerprint && !currentVersion) {
    return "daemon runtime identity unavailable";
  }
  if (currentFingerprint && currentFingerprint !== target.fingerprint) {
    return "runtime fingerprint changed";
  }
  if (
    currentVersion &&
    target.pluginVersion &&
    currentVersion !== target.pluginVersion
  ) {
    return "plugin version changed";
  }
  return null;
}

export function readDaemonRestartRequest(repoRoot) {
  const requestPath = daemonRestartRequestPath(repoRoot);
  if (!existsSync(requestPath)) return null;
  try {
    return JSON.parse(readFileSync(requestPath, "utf8"));
  } catch {
    return null;
  }
}

export function requestDaemonRestart(repoRoot, daemon, target, reason) {
  const existing = readDaemonRestartRequest(repoRoot);
  if (
    existing?.daemon?.pid === daemon.pid &&
    existing?.daemon?.token === (daemon.token || null) &&
    existing?.target?.fingerprint === target.fingerprint
  ) {
    return existing;
  }

  const gate = acquireTaskBatchGate(repoRoot, {
    purpose: "runtime-update",
  });
  try {
    const concurrent = readDaemonRestartRequest(repoRoot);
    if (
      concurrent?.daemon?.pid === daemon.pid &&
      concurrent?.daemon?.token === (daemon.token || null) &&
      concurrent?.target?.fingerprint === target.fingerprint
    ) {
      return concurrent;
    }
    const request = {
      schemaVersion: 1,
      requestId: randomUUID(),
      status: "pending",
      reason,
      daemon: {
        pid: daemon.pid,
        token: daemon.token || null,
      },
      current: {
        pluginVersion:
          daemon?.runtime?.pluginVersion || daemon.pluginVersion || null,
        fingerprint:
          daemon?.runtime?.fingerprint ||
          daemon.runtimeFingerprint ||
          null,
      },
      target,
      requestedAt: new Date().toISOString(),
      safeBoundary: "after-active-tasks",
      hooksReload: "next-session",
    };
    atomicWriteJson(daemonRestartRequestPath(repoRoot), request);
    return request;
  } finally {
    releaseTaskBatchGate(gate);
  }
}

export function clearDaemonRestartRequest(repoRoot, requestId = null) {
  const requestPath = daemonRestartRequestPath(repoRoot);
  if (!existsSync(requestPath)) return false;
  if (requestId) {
    const current = readDaemonRestartRequest(repoRoot);
    if (current?.requestId !== requestId) return false;
  }
  unlinkSync(requestPath);
  return true;
}

export function daemonRestartDecision(repoRoot, daemon, ownRuntime) {
  let request = readDaemonRestartRequest(repoRoot);
  if (!request) return { pending: false, request: null };
  const hasOwner = value => typeof value?.requestId === "string" && value.requestId &&
    Number.isInteger(value.daemon?.pid) && value.daemon.pid > 0 &&
    (value.daemon.token === null || typeof value.daemon.token === "string");
  if (
    request.daemon?.pid !== daemon.pid ||
    request.daemon?.token !== daemon.token
  ) {
    // Only the published owner may retire a predecessor's request. Serialize
    // with requestDaemonRestart/claimTask and reread so a fresh update survives.
    let gate;
    try {
      gate = acquireTaskBatchGate(repoRoot, { purpose: "runtime-update-reconcile" });
      const owner = readDaemonState(repoRoot);
      request = readDaemonRestartRequest(repoRoot);
      if (
        hasOwner(request) && owner?.pid === daemon.pid && owner?.token === daemon.token &&
        (request.daemon?.pid !== daemon.pid || request.daemon?.token !== daemon.token)
      ) {
        clearDaemonRestartRequest(repoRoot, request.requestId);
        return { pending: false, request: null, retiredRequest: request };
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      releaseTaskBatchGate(gate);
    }
    return { pending: false, request: null };
  }
  if (request.target?.fingerprint === ownRuntime.fingerprint) {
    clearDaemonRestartRequest(repoRoot, request.requestId);
    return { pending: false, request: null };
  }
  return { pending: true, request };
}
