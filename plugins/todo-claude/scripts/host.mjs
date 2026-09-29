import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repository host claim is shared by every ToDo fork. Keep this module
// identical across forks except for HOST_ID and HOST_MANIFEST.
export const HOST_ID = "claude";
export const HOST_MANIFEST = ".claude-plugin";
export const LEGACY_HOST_ID = "codex";
export const HOST_NAMES = { codex: "Codex", claude: "Claude Code" };
export const HOST_MISMATCH = "HOST_MISMATCH";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function hostName(id) {
  return HOST_NAMES[id] || id;
}

function todoRoot(repoRoot) {
  return path.join(repoRoot, ".todo");
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function pluginVersion() {
  return readJsonFile(path.join(pluginRoot, HOST_MANIFEST, "plugin.json"))?.version || null;
}

// Repositories activated before host claims existed belong to Codex.
export function repoHostFromConfig(raw) {
  const id = raw?.host?.id;
  return typeof id === "string" && id.trim() ? id.trim() : LEGACY_HOST_ID;
}

export function readRepoHost(repoRoot) {
  return repoHostFromConfig(readJsonFile(path.join(todoRoot(repoRoot), "config.json")));
}

export function daemonHost(state) {
  return typeof state?.host === "string" && state.host ? state.host : LEGACY_HOST_ID;
}

export function threadHost(thread) {
  return typeof thread?.host === "string" && thread.host ? thread.host : LEGACY_HOST_ID;
}

export function threadIsForeign(thread) {
  return Boolean(thread?.id) && threadHost(thread) !== HOST_ID;
}

// `models` is either the legacy Codex profile array or a map keyed by host.
export function hostModels(models) {
  if (models === undefined || Array.isArray(models)) {
    return HOST_ID === LEGACY_HOST_ID ? models : undefined;
  }
  if (models && typeof models === "object") return models[HOST_ID];
  return models;
}

export function withHostModels(raw, profiles) {
  const models = raw.models;
  if (HOST_ID === LEGACY_HOST_ID && (models === undefined || Array.isArray(models))) {
    return { ...raw, models: profiles };
  }
  const map = Array.isArray(models)
    ? { [LEGACY_HOST_ID]: models }
    : models && typeof models === "object"
      ? { ...models }
      : {};
  map[HOST_ID] = profiles;
  return { ...raw, models: map };
}

// A live process of another host (its daemon or a task claim) keeps the
// repository. A dead PID frees it for this host.
export function foreignActivity(repoRoot) {
  const root = todoRoot(repoRoot);
  const daemon = readJsonFile(path.join(root, "daemon.json"));
  if (daemon && daemonHost(daemon) !== HOST_ID && alive(daemon.pid)) {
    return { kind: "daemon", host: daemonHost(daemon), pid: daemon.pid };
  }
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".md.lock")) continue;
    const claim = readJsonFile(path.join(root, name));
    if (!claim || daemonHost(claim) === HOST_ID || !alive(claim.pid)) continue;
    return {
      kind: "claim",
      host: daemonHost(claim),
      pid: claim.pid,
      taskId: name.slice(0, -".md.lock".length),
    };
  }
  return null;
}

function acquireClaimLock(root) {
  const lockPath = path.join(root, ".host-claim.lock");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
      closeSync(fd);
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10000) unlinkSync(lockPath);
      } catch {
        // Another process released or replaced the lock.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new Error("Timed out waiting for the ToDo host claim lock");
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function hostClaimRecord(now = new Date()) {
  return { id: HOST_ID, claimedAt: now.toISOString(), pluginVersion: pluginVersion() };
}

// Claims the repository for this host unless a live process of another host
// still works in it. Returns { status: "own" | "claimed" | "busy", ... }.
export function claimRepoHost(repoRoot) {
  const root = todoRoot(repoRoot);
  const configFile = path.join(root, "config.json");
  const current = readJsonFile(configFile);
  if (!current) return { status: "unavailable", host: null };
  if (repoHostFromConfig(current) === HOST_ID) {
    const activity = foreignActivity(repoRoot);
    return activity
      ? { status: "busy", host: activity.host, activity }
      : { status: "own", host: HOST_ID };
  }
  mkdirSync(root, { recursive: true });
  const lock = acquireClaimLock(root);
  try {
    const raw = readJsonFile(configFile);
    if (!raw) return { status: "unavailable", host: null };
    const previousHost = repoHostFromConfig(raw);
    if (previousHost === HOST_ID) return { status: "own", host: HOST_ID };
    const activity = foreignActivity(repoRoot);
    if (activity) return { status: "busy", host: activity.host, activity };
    writeJsonAtomic(configFile, { ...raw, host: hostClaimRecord() });
    return { status: "claimed", host: HOST_ID, previousHost };
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Stale lock cleanup is time-based.
    }
  }
}

export function hostMismatchMessage(result) {
  const activity = result.activity;
  const owner = hostName(result.host);
  const detail = activity?.kind === "claim"
    ? `task ${activity.taskId} is claimed by pid ${activity.pid}`
    : `its ToDo runner is alive (pid ${activity?.pid})`;
  return `This repository is claimed by ${owner}: ${detail}. ToDo in ${hostName(HOST_ID)} stays disabled here until that process exits; stop the runner from ${owner} to hand the repository over.`;
}

export class HostMismatchError extends Error {
  constructor(result) {
    super(hostMismatchMessage(result));
    this.code = HOST_MISMATCH;
    this.host = result.host;
    this.activity = result.activity || null;
  }
}

export function assertRepoHost(repoRoot) {
  const result = claimRepoHost(repoRoot);
  if (result.status === "busy") throw new HostMismatchError(result);
  return result;
}
