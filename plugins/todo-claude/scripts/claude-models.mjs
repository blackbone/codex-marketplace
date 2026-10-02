#!/usr/bin/env node
// The model list of the Claude CLI: the `models` the CLI reports to an SDK
// `initialize` request in stream-json mode (what `/model` offers), with each
// model's effort levels. No model request is made. Cached in
// .todo/claude-models.json.
//
//   claude-models.mjs <repoRoot> [--command <claude>] [--force]
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 30000;
export const PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const cachePath = (root) => path.join(root, ".todo", "claude-models.json");

export function readCliModels(root, command, { fresh = false } = {}) {
  try {
    const value = JSON.parse(readFileSync(cachePath(root), "utf8"));
    if (value.command !== command || !Array.isArray(value.models)) return null;
    if (fresh && !(Date.now() - Date.parse(value.checkedAt) < TTL_MS)) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeCliModels(root, command, models, error = null) {
  const file = cachePath(root);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ command, checkedAt: new Date().toISOString(), models, error }, null, 2)}\n`);
  renameSync(temp, file);
}

// One entry per concrete model id; aliases (`opus`, `default`) fold into it.
export function normalizeCliModels(list) {
  const byId = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const id = item?.resolvedModel || item?.value;
    if (typeof id !== "string" || !id || id === "default") continue;
    const entry = byId.get(id) || { model: id, aliases: [], displayName: item.displayName || id,
      efforts: item.supportsEffort && Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels : [],
      supportsEffort: item.supportsEffort === true };
    if (item.value && item.value !== id && item.value !== "default" && !entry.aliases.includes(item.value)) entry.aliases.push(item.value);
    if (item.value === id) entry.displayName = item.displayName || entry.displayName;
    byId.set(id, entry);
  }
  return [...byId.values()];
}

export function fetchCliModels(command) {
  return new Promise((resolve, reject) => {
    let buffer = "", stderr = "", settled = false;
    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolve(models);
    };
    // A worker environment keeps the plugin's own session hooks from starting a runner.
    const child = spawn(command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--setting-sources", "", "--strict-mcp-config"], {
      cwd: tmpdir(), env: { ...process.env, TODO_RUNNER_WORKER: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => finish(new Error(`Claude CLI did not report its models within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
    child.on("error", (error) => finish(new Error(`Could not run the Claude CLI '${command}': ${error.message}`)));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => finish(new Error(`Claude CLI exited (${code}) before reporting its models${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`)));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type !== "control_response" || message.response?.request_id !== "todo-models") continue;
        if (message.response.subtype === "error") finish(new Error(`Claude CLI refused the model list: ${message.response.error}`));
        else finish(null, normalizeCliModels(message.response.response?.models));
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "todo-models", request: { subtype: "initialize" } })}\n`);
  });
}

// The cached list, refreshed when stale or forced. A failed refresh is cached
// with its error so callers can report it.
export async function cliModels(root, command, { force = false, fetch = fetchCliModels } = {}) {
  if (!force) {
    const cached = readCliModels(root, command, { fresh: true });
    if (cached && !cached.error) return cached;
  }
  try {
    writeCliModels(root, command, await fetch(command));
  } catch (error) {
    writeCliModels(root, command, readCliModels(root, command)?.models || [], error.message);
  }
  return readCliModels(root, command);
}

// Synchronous entry for ensureDaemon: refreshes a stale list in a child process.
export function cliModelsSync(root, command) {
  const cached = readCliModels(root, command, { fresh: true });
  if (cached && !cached.error) return cached;
  spawnSync(process.execPath, [fileURLToPath(import.meta.url), root, "--command", command], {
    timeout: TIMEOUT_MS + 10000, windowsHide: true, stdio: "ignore",
  });
  return readCliModels(root, command);
}

// A profile model matches by id, alias, or a dated id (`claude-haiku-4-5` →
// `claude-haiku-4-5-20251001`).
export function findCliModel(models, model) {
  if (typeof model !== "string" || !model) return null;
  return models.find((m) => m.model === model || m.aliases.includes(model)) ||
    models.find((m) => m.model.startsWith(`${model}-`) && /^\d{8}$/.test(m.model.slice(model.length + 1))) || null;
}

// Every reason the profile set cannot run.
export function profileProblems(profiles, defaultModelProfile, catalog) {
  const problems = [];
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return [{ profile: null, field: "profiles", message: "Add at least one model profile." }];
  }
  const models = catalog?.models || [];
  if (!catalog) problems.push({ profile: null, field: "models", message: "The Claude CLI model list has not been loaded yet.", unchecked: true });
  else if (!models.length) {
    problems.push({ profile: null, field: "models", message: `The Claude CLI model list is unavailable${catalog.error ? `: ${catalog.error}` : ""}.` });
  }
  const names = new Set();
  profiles.forEach((profile, index) => {
    const label = profile?.name || `#${index + 1}`;
    const add = (field, message) => problems.push({ profile: label, index, field, message });
    if (!profile || typeof profile !== "object") return add("profile", "Profile must be an object.");
    if (!PROFILE_NAME.test(profile.name || "")) add("name", "Name must be lowercase letters, digits and single hyphens.");
    else if (names.has(profile.name)) add("name", `Profile name '${profile.name}' is used twice.`);
    names.add(profile.name);
    if (typeof profile.model !== "string" || !profile.model.trim()) return add("model", "Choose a model.");
    const known = findCliModel(models, profile.model);
    if (models.length && !known) add("model", `Model '${profile.model}' is not in the Claude CLI model list.`);
    const efforts = known?.supportsEffort ? known.efforts : REASONING_EFFORTS;
    if (!efforts.includes(profile.reasoningEffort)) {
      add("reasoningEffort", `Effort '${profile.reasoningEffort ?? ""}' is not supported by '${profile.model}'. Supported: ${efforts.join(", ")}.`);
    }
    if (profile.description !== undefined && (typeof profile.description !== "string" || profile.description.length > 500)) {
      add("description", "Description must be text of at most 500 characters.");
    }
  });
  if (!profiles.some((p) => p?.name === defaultModelProfile)) {
    problems.push({ profile: null, field: "defaultModelProfile", message: `Default profile '${defaultModelProfile ?? ""}' is not in the profile list.` });
  }
  return problems;
}

export function formatProfileProblems(problems) {
  return problems.map((p) => (p.profile ? `${p.profile}: ${p.message}` : p.message)).join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = args.shift();
  let command = "claude", force = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--force") force = true;
    else if (args[i] === "--command") command = args[++i];
  }
  cliModels(root, command, { force })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
