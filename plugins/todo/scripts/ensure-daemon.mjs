import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  applyGitExcludes,
  atomicWriteJson,
  DAEMON_IMPLEMENTATION,
  DAEMON_PROTOCOL_VERSION,
  daemonStatePath,
  daemonStopRequestPath,
  ensureLayout,
  findLegacyRunner,
  getSupervisorStatus,
  isActivated,
  isCurrentDaemonState,
  listTaskFiles,
  loadConfig,
  processIsAlive,
  readDaemonState,
  readDashboardThreadRequest,
  requestDashboardThread,
  todoDir,
} from "./lib.mjs";
import {
  clearDaemonRestartRequest,
  readDaemonRestartRequest,
  requestDaemonRestart,
  runtimeDescriptor,
  runtimeMismatch,
} from "./runtime-update.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const startupWait = new Int32Array(new SharedArrayBuffer(4));

function commandDaemonPath(command, repoRoot) {
  const repoSuffix = ` --repo ${repoRoot}`;
  if (!command.endsWith(repoSuffix)) return null;
  const launch = command.slice(0, -repoSuffix.length);
  const separator = launch.indexOf(" ");
  if (separator <= 0) return null;
  const executable = launch.slice(0, separator);
  const daemonPath = launch.slice(separator + 1);
  if (
    !path.isAbsolute(executable) ||
    !/^node(?:js)?(?:\.exe)?$/i.test(path.basename(executable)) ||
    !path.isAbsolute(daemonPath) ||
    !daemonPath.endsWith(path.join("scripts", "daemon.mjs"))
  ) {
    return null;
  }
  return path.resolve(daemonPath);
}

function manifestOwnsTodoDaemon(daemonPath) {
  const pluginRoot = path.dirname(path.dirname(daemonPath));
  try {
    const manifest = JSON.parse(
      readFileSync(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    );
    return (
      manifest?.name === "todo" &&
      path.resolve(pluginRoot, "scripts", "daemon.mjs") === daemonPath
    );
  } catch {
    return false;
  }
}

function cachedTodoDaemon(daemonPath, running) {
  const pluginVersion =
    running?.runtime?.pluginVersion || running?.pluginVersion || null;
  if (typeof pluginVersion !== "string" || pluginVersion.length === 0) {
    return false;
  }
  const cacheRoots = [path.join(homedir(), ".codex", "plugins", "cache")];
  if (process.env.CODEX_HOME) {
    cacheRoots.unshift(
      path.join(path.resolve(process.env.CODEX_HOME), "plugins", "cache"),
    );
  }
  for (const cacheRoot of new Set(cacheRoots)) {
    const relative = path.relative(cacheRoot, daemonPath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    const parts = relative.split(path.sep);
    if (
      parts.length === 5 &&
      parts[0] &&
      parts[1] === "todo" &&
      parts[2] === pluginVersion &&
      parts[3] === "scripts" &&
      parts[4] === "daemon.mjs"
    ) {
      return true;
    }
  }
  return false;
}

function ownedTodoDaemonPath(daemonPath, running) {
  return (
    manifestOwnsTodoDaemon(daemonPath) || cachedTodoDaemon(daemonPath, running)
  );
}

function liveDaemon(repoRoot) {
  const state = readDaemonState(repoRoot);
  return state && processIsAlive(state.pid) ? state : null;
}

function acquireStartupLock(repoRoot) {
  const lockPath = path.join(todoDir(repoRoot), ".daemon-start.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
        "utf8",
      );
      closeSync(fd);
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > 10000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}

function requestIdleDaemonStop(repoRoot, running) {
  if (
    running.status !== "running" ||
    !running.token ||
    running.pid === process.pid ||
    !Array.isArray(running.active) ||
    running.active.length !== 0
  ) {
    return false;
  }
  try {
    process.kill(running.pid, "SIGSTOP");
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  let stopped = true;
  try {
    const deadline = Date.now() + 1000;
    let processStopped = false;
    while (Date.now() < deadline) {
      const state = spawnSync(
        "ps",
        ["-p", String(running.pid), "-o", "stat="],
        { encoding: "utf8" },
      );
      if (state.status === 0 && state.stdout.trim().startsWith("T")) {
        processStopped = true;
        break;
      }
      Atomics.wait(startupWait, 0, 0, 10);
    }
    if (!processStopped) return false;
    const latest = readDaemonState(repoRoot);
    const claimed = listTaskFiles(repoRoot).some((taskPath) => {
      try {
        const claim = JSON.parse(readFileSync(`${taskPath}.lock`, "utf8"));
        return claim.pid === running.pid;
      } catch {
        return existsSync(`${taskPath}.lock`);
      }
    });
    if (
      latest?.pid !== running.pid ||
      latest?.token !== running.token ||
      latest?.status !== "running" ||
      !Array.isArray(latest.active) ||
      latest.active.length !== 0 ||
      claimed
    ) {
      return false;
    }
    const stopRequestPath = daemonStopRequestPath(repoRoot);
    let requestMatches = false;
    if (existsSync(stopRequestPath)) {
      try {
        const existing = JSON.parse(readFileSync(stopRequestPath, "utf8"));
        requestMatches =
          existing.implementation === DAEMON_IMPLEMENTATION &&
          existing.protocolVersion === DAEMON_PROTOCOL_VERSION &&
          existing.pid === running.pid &&
          existing.token === running.token;
      } catch {
        // Replace a malformed or stale request below.
      }
    }
    if (!requestMatches) {
      atomicWriteJson(stopRequestPath, {
        implementation: DAEMON_IMPLEMENTATION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        token: running.token,
        pid: running.pid,
        force: false,
        reason: "runtime-update",
        requestedAt: new Date().toISOString(),
      });
    }
    process.kill(running.pid, "SIGTERM");
    process.kill(running.pid, "SIGCONT");
    stopped = false;
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  } finally {
    if (stopped) {
      try {
        process.kill(running.pid, "SIGCONT");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}

function inspectProcess(pid) {
  const inspected = spawnSync(
    "ps",
    ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    },
  );
  const match = inspected.stdout?.trim().match(
    /^(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
  );
  const processStartedAt = Date.parse(`${match?.[1] || ""} UTC`);
  if (
    inspected.status !== 0 ||
    !Number.isFinite(processStartedAt) ||
    !match?.[2]
  ) {
    return null;
  }
  return { startedAt: processStartedAt, command: match[2] };
}

export function verifyDaemonProcess(repoRoot, running) {
  if (!isCurrentDaemonState(running)) {
    return { ok: false, reason: "daemon protocol identity does not match" };
  }
  if (typeof running.token !== "string" || running.token.length === 0) {
    return { ok: false, reason: "daemon authorization token is missing" };
  }
  const heartbeatAt = Date.parse(running.heartbeatAt || "");
  const stateStartedAt = Date.parse(running.startedAt || "");
  const pollIntervalMs = Math.min(
    60000,
    Math.max(250, Number(running.appliedConfig?.pollIntervalMs) || 1000),
  );
  const heartbeatMaxAgeMs = Math.max(30000, pollIntervalMs * 2 + 5000);
  if (
    !Number.isFinite(heartbeatAt) ||
    !Number.isFinite(stateStartedAt) ||
    heartbeatAt < stateStartedAt ||
    heartbeatAt - Date.now() > 30000 ||
    Date.now() - heartbeatAt > heartbeatMaxAgeMs
  ) {
    return { ok: false, reason: "daemon heartbeat/start marker is stale" };
  }
  const identity = inspectProcess(running.pid);
  if (!identity) return { ok: false, reason: "daemon process is not inspectable" };
  const startupDelay = stateStartedAt - identity.startedAt;
  if (startupDelay < -1000 || startupDelay > 30000) {
    return { ok: false, reason: "daemon process start marker does not match" };
  }
  let expectedRepo;
  let stateRepo;
  try {
    expectedRepo = realpathSync(repoRoot);
    stateRepo = realpathSync(running.repoRoot || "");
  } catch {
    return { ok: false, reason: "daemon repository identity is not verifiable" };
  }
  if (stateRepo !== expectedRepo) {
    return { ok: false, reason: "daemon command does not match this repository" };
  }
  const daemonPath = commandDaemonPath(identity.command, running.repoRoot);
  if (!daemonPath || !ownedTodoDaemonPath(daemonPath, running)) {
    return { ok: false, reason: "daemon command is not an owned ToDo runtime" };
  }
  return { ok: true };
}

function runningDaemonResult(
  repoRoot,
  running,
  addedExcludes,
  targetRuntime,
  config,
) {
  if (!isCurrentDaemonState(running)) {
    return {
      status: "conflict",
      daemon: running,
      reason: "another ToDo daemon implementation owns this repository",
      addedExcludes,
    };
  }

  const mismatch = runtimeMismatch(running, targetRuntime);
  if (mismatch) {
    if (!targetRuntime.available || config.readError) {
      return {
        status: "update-blocked",
        daemon: running,
        runtimeUpdate: {
          status: "blocked",
          reason: config.readError || "current plugin runtime is incomplete",
          missing: targetRuntime.missing,
          newSessionRequired: !targetRuntime.available,
        },
        addedExcludes,
      };
    }
    const activeTasks = Array.isArray(running.active)
      ? running.active.length
      : null;
    if (
      running.status === "running" &&
      activeTasks === 0 &&
      running.pid !== process.pid
    ) {
      const identity = verifyDaemonProcess(repoRoot, running);
      if (!identity.ok) {
        return {
          status: "conflict",
          daemon: running,
          reason: `refusing to stop pid ${running.pid}: ${identity.reason}`,
          addedExcludes,
        };
      }
    }
    const request = requestDaemonRestart(
      repoRoot,
      running,
      targetRuntime,
      mismatch,
    );
    const handlesRestartRequest = Boolean(
      running.runtime?.fingerprint || running.runtimeFingerprint,
    );
    const stopping =
      running.status === "stopping" ||
      (activeTasks === 0 &&
        !handlesRestartRequest &&
        requestIdleDaemonStop(repoRoot, running));
    const updateStatus = stopping
      ? "stopping"
      : running.status === "restart-pending"
        ? "draining"
        : "pending";
    return {
      status: "restart-pending",
      daemon: running,
      runtimeUpdate: {
        status: updateStatus,
        requestId: request.requestId,
        reason: request.reason,
        activeTasks,
        current: request.current,
        target: request.target,
        hooksReload: request.hooksReload,
        newSessionRequired: true,
      },
      addedExcludes,
    };
  }

  if (running.status === "running") {
    const identity = verifyDaemonProcess(repoRoot, running);
    if (!identity.ok) {
      return {
        status: "conflict",
        daemon: running,
        reason: `refusing daemon state for pid ${running.pid}: ${identity.reason}`,
        addedExcludes,
      };
    }
  }

  if (running.status === "restart-pending" || running.status === "draining") {
    return {
      status: "restart-pending",
      daemon: running,
      runtimeUpdate: running.runtimeUpdate || null,
      addedExcludes,
    };
  }
  if (running.status === "stopping") {
    return { status: "stopping", daemon: running, addedExcludes };
  }
  if (running.status === "starting") {
    return { status: "starting", daemon: running, addedExcludes };
  }
  if (running.status !== "running") {
    return {
      status: "conflict",
      daemon: running,
      reason: `unexpected daemon status ${running.status || "unknown"}`,
      addedExcludes,
    };
  }
  const request = readDaemonRestartRequest(repoRoot);
  if (
    running.status === "running" &&
    request?.target?.fingerprint === targetRuntime.fingerprint
  ) {
    clearDaemonRestartRequest(repoRoot, request.requestId);
  }
  return {
    status: "running",
    daemon: running,
    runtime: targetRuntime,
    addedExcludes,
  };
}

function waitForDaemonStartup(
  repoRoot,
  pid,
  targetRuntime,
  startedAt,
  timeoutMs,
  dashboardThreadId = null,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = readDaemonState(repoRoot);
    const heartbeatAt = Date.parse(state?.heartbeatAt || "");
    const configAppliedAt = Date.parse(
      state?.configAppliedAt || state?.configReload?.appliedAt || "",
    );
    if (
      state?.pid === pid &&
      state.status === "running" &&
      typeof state.token === "string" &&
      state.token.length > 0 &&
      isCurrentDaemonState(state) &&
      (state.runtime?.fingerprint || state.runtimeFingerprint) ===
        targetRuntime.fingerprint &&
      (!dashboardThreadId ||
        state.dashboard?.threadId === dashboardThreadId) &&
      heartbeatAt >= startedAt &&
      configAppliedAt >= startedAt &&
      processIsAlive(pid)
    ) {
      return state;
    }
    Atomics.wait(
      startupWait,
      0,
      0,
      Math.min(25, Math.max(1, deadline - Date.now())),
    );
  }
  return null;
}

function waitForDashboardThread(repoRoot, pid, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = readDaemonState(repoRoot);
    if (
      state?.pid === pid &&
      state.status === "running" &&
      state.dashboard?.threadId === threadId &&
      processIsAlive(pid)
    ) {
      return state;
    }
    Atomics.wait(
      startupWait,
      0,
      0,
      Math.min(25, Math.max(1, deadline - Date.now())),
    );
  }
  return null;
}

function wakeDashboardThreadSync(pid) {
  try {
    process.kill(pid, "SIGUSR2");
  } catch (error) {
    if (error.code !== "ESRCH" && error.code !== "EINVAL") throw error;
  }
}

function discardFailedStartup(repoRoot, pid, spawnedIdentity) {
  const currentIdentity = inspectProcess(pid);
  if (
    spawnedIdentity &&
    currentIdentity &&
    currentIdentity.startedAt === spawnedIdentity.startedAt &&
    currentIdentity.command === spawnedIdentity.command
  ) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 50;
  do {
    const state = readDaemonState(repoRoot);
    if (state?.pid === pid && existsSync(daemonStatePath(repoRoot))) {
      unlinkSync(daemonStatePath(repoRoot));
    }
    Atomics.wait(startupWait, 0, 0, 10);
  } while (Date.now() < deadline);
  const finalState = readDaemonState(repoRoot);
  if (finalState?.pid === pid && existsSync(daemonStatePath(repoRoot))) {
    unlinkSync(daemonStatePath(repoRoot));
  }
}

export function ensureDaemon(
  repoRoot,
  { startupTimeoutMs = 5000, dashboardThreadId = null } = {},
) {
  if (process.env.TODO_RUNNER_WORKER === "1") {
    return { status: "worker-bypass" };
  }
  if (!isActivated(repoRoot)) {
    return { status: "inactive" };
  }

  ensureLayout(repoRoot);
  const dashboardOwner =
    dashboardThreadId ||
    readDashboardThreadRequest(repoRoot)?.threadId ||
    getSupervisorStatus(repoRoot).automation?.targetThreadId ||
    null;
  const requestedDashboardThreadId = dashboardOwner
    ? requestDashboardThread(repoRoot, dashboardOwner)
    : null;
  const config = loadConfig(repoRoot);
  const targetRuntime = runtimeDescriptor(pluginRoot);
  const addedExcludes = applyGitExcludes(repoRoot, config.gitExclude);
  const running = liveDaemon(repoRoot);
  if (running) {
    const result = runningDaemonResult(
      repoRoot,
      running,
      addedExcludes,
      targetRuntime,
      config,
    );
    if (!requestedDashboardThreadId || result.status !== "running") {
      return result;
    }
    wakeDashboardThreadSync(running.pid);
    const updated = waitForDashboardThread(
      repoRoot,
      running.pid,
      requestedDashboardThreadId,
      startupTimeoutMs,
    );
    return updated
      ? runningDaemonResult(
          repoRoot,
          updated,
          addedExcludes,
          targetRuntime,
          config,
        )
      : {
          ...result,
          status: "dashboard-update-pending",
          reason: `dashboard did not bind for thread ${requestedDashboardThreadId} within ${startupTimeoutMs}ms`,
        };
  }
  const legacy = findLegacyRunner(repoRoot);
  if (legacy) {
    return { status: "legacy-running", legacy, addedExcludes };
  }

  const startupLock = acquireStartupLock(repoRoot);
  if (!startupLock) {
    return { status: "starting", addedExcludes };
  }

  try {
    const secondCheck = liveDaemon(repoRoot);
    if (secondCheck) {
      const result = runningDaemonResult(
        repoRoot,
        secondCheck,
        addedExcludes,
        targetRuntime,
        config,
      );
      if (!requestedDashboardThreadId || result.status !== "running") {
        return result;
      }
      wakeDashboardThreadSync(secondCheck.pid);
      const updated = waitForDashboardThread(
        repoRoot,
        secondCheck.pid,
        requestedDashboardThreadId,
        startupTimeoutMs,
      );
      return updated
        ? runningDaemonResult(
            repoRoot,
            updated,
            addedExcludes,
            targetRuntime,
            config,
          )
        : {
            ...result,
            status: "dashboard-update-pending",
            reason: `dashboard did not bind for thread ${requestedDashboardThreadId} within ${startupTimeoutMs}ms`,
          };
    }

    if (!targetRuntime.available || config.readError) {
      return {
        status: "start-blocked",
        reason: config.readError || "current plugin runtime is incomplete",
        missing: targetRuntime.missing,
        addedExcludes,
      };
    }

    const logPath = path.join(todoDir(repoRoot), "runner.log");
    const logFd = openSync(logPath, "a");
    let child;
    const startedAt = Date.now();
    try {
      child = spawn(
        process.env.CODEX_MCP_NODE_PATH || process.execPath,
        [path.join(scriptDir, "daemon.mjs"), "--repo", repoRoot],
        {
          cwd: repoRoot,
          detached: true,
          env: {
            ...process.env,
            TODO_RUNNER_REPO_ROOT: repoRoot,
          },
          stdio: ["ignore", logFd, logFd],
        },
      );
      child.unref();
    } finally {
      closeSync(logFd);
    }
    const spawnedIdentity = inspectProcess(child.pid);

    const ready = waitForDaemonStartup(
      repoRoot,
      child.pid,
      targetRuntime,
      startedAt,
      startupTimeoutMs,
      requestedDashboardThreadId,
    );
    if (ready) {
      return runningDaemonResult(
        repoRoot,
        ready,
        addedExcludes,
        targetRuntime,
        config,
      );
    }
    discardFailedStartup(repoRoot, child.pid, spawnedIdentity);
    return {
      status: "start-failed",
      pid: child.pid,
      reason: `daemon did not become ready within ${startupTimeoutMs}ms`,
      runtime: targetRuntime,
      addedExcludes,
    };
  } finally {
    if (existsSync(startupLock)) unlinkSync(startupLock);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoIndex = process.argv.indexOf("--repo");
  const repoRoot =
    repoIndex >= 0 && process.argv[repoIndex + 1]
      ? path.resolve(process.argv[repoIndex + 1])
      : process.cwd();
  process.stdout.write(`${JSON.stringify(ensureDaemon(repoRoot))}\n`);
}
