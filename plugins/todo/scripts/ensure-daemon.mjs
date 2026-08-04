import {
  closeSync,
  existsSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  applyGitExcludes,
  atomicWriteJson,
  DAEMON_IMPLEMENTATION,
  DAEMON_PROTOCOL_VERSION,
  daemonStatePath,
  ensureLayout,
  findLegacyRunner,
  isActivated,
  isCurrentDaemonState,
  loadConfig,
  processIsAlive,
  readDaemonState,
  todoDir,
} from "./lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

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

export function ensureDaemon(repoRoot) {
  if (process.env.TODO_RUNNER_WORKER === "1") {
    return { status: "worker-bypass" };
  }
  if (!isActivated(repoRoot)) {
    return { status: "inactive" };
  }

  ensureLayout(repoRoot);
  const config = loadConfig(repoRoot);
  const addedExcludes = applyGitExcludes(repoRoot, config.gitExclude);
  const running = liveDaemon(repoRoot);
  if (running) {
    if (!isCurrentDaemonState(running)) {
      return {
        status: "conflict",
        daemon: running,
        reason: "another ToDo daemon implementation owns this repository",
        addedExcludes,
      };
    }
    if (running.status === "stopping") {
      return { status: "stopping", daemon: running, addedExcludes };
    }
    if (running.status === "starting") {
      return { status: "starting", daemon: running, addedExcludes };
    }
    return { status: "running", daemon: running, addedExcludes };
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
      if (!isCurrentDaemonState(secondCheck)) {
        return {
          status: "conflict",
          daemon: secondCheck,
          reason: "another ToDo daemon implementation owns this repository",
          addedExcludes,
        };
      }
      if (secondCheck.status === "stopping") {
        return {
          status: "stopping",
          daemon: secondCheck,
          addedExcludes,
        };
      }
      if (secondCheck.status === "starting") {
        return {
          status: "starting",
          daemon: secondCheck,
          addedExcludes,
        };
      }
      return { status: "running", daemon: secondCheck, addedExcludes };
    }

    const logPath = path.join(todoDir(repoRoot), "runner.log");
    const logFd = openSync(logPath, "a");
    let child;
    try {
      child = spawn(
        process.execPath,
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

    atomicWriteJson(daemonStatePath(repoRoot), {
      implementation: DAEMON_IMPLEMENTATION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      pid: child.pid,
      status: "starting",
      repoRoot,
      workers: config.workers,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    return {
      status: "started",
      pid: child.pid,
      workers: config.workers,
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
