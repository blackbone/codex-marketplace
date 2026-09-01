import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const STEP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODEX_STEP_TYPES = new Set(["codex-exec", "codex-thread"]);
const MAX_PROMPT_LENGTH = 32 * 1024;
const DEFAULT_SHELL_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_REPAIR_ROUNDS = 3;

function pipelineError(source, line, message) {
  const location = line ? `${source}:${line}` : source;
  return new Error(`${location}: ${message}`);
}

function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          index += 1;
        } else if (value[index - 1] !== "\\") {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function scalar(value, source, line) {
  const text = stripInlineComment(value).trim();
  if (!text) return "";
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?(?:0|[1-9]\d*)$/.test(text)) return Number(text);
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw pipelineError(source, line, `invalid quoted string: ${error.message}`);
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw pipelineError(source, line, "unterminated single-quoted string");
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw pipelineError(
        source,
        line,
        `inline collections must use JSON syntax: ${error.message}`,
      );
    }
  }
  if (/^[!&*]/.test(text) || text.includes(" <<:")) {
    throw pipelineError(source, line, "YAML tags, anchors, aliases, and merges are unsupported");
  }
  return text;
}

function splitMapping(content, source, line) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) {
        if (quote === "'" && content[index + 1] === "'") index += 1;
        else if (content[index - 1] !== "\\") quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
    else if (character === ":" && depth === 0) {
      const key = content.slice(0, index).trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
        throw pipelineError(source, line, `invalid mapping key: ${key || "<empty>"}`);
      }
      return [key, content.slice(index + 1).trimStart()];
    }
  }
  throw pipelineError(source, line, "expected a key followed by ':'");
}

function parseYamlSubset(text, source) {
  if (typeof text !== "string") throw new TypeError("pipeline YAML must be text");
  const rawLines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const lines = rawLines.map((raw, index) => {
    if (raw.includes("\t")) {
      throw pipelineError(source, index + 1, "tabs are unsupported; use two-space indentation");
    }
    const indent = raw.match(/^ */)[0].length;
    if (indent % 2 !== 0) {
      throw pipelineError(source, index + 1, "indentation must use multiples of two spaces");
    }
    return { raw, indent, content: raw.slice(indent), line: index + 1 };
  });

  const nextContent = (start) => {
    let index = start;
    while (
      index < lines.length &&
      (!lines[index].content.trim() || lines[index].content.trimStart().startsWith("#"))
    ) {
      index += 1;
    }
    return index;
  };

  const blockScalar = (start, parentIndent, folded, chomp) => {
    let index = start;
    const captured = [];
    let contentIndent = null;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.content.trim()) {
        captured.push("");
        index += 1;
        continue;
      }
      if (line.indent <= parentIndent) break;
      contentIndent ??= line.indent;
      if (line.indent < contentIndent) {
        throw pipelineError(source, line.line, "block scalar indentation is inconsistent");
      }
      captured.push(line.raw.slice(contentIndent));
      index += 1;
    }
    let value = folded
      ? captured.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ")
      : captured.join("\n");
    if (chomp !== "-") value += "\n";
    return { value, index };
  };

  const parseMappingEntries = (start, indent, target) => {
    let index = start;
    while (true) {
      index = nextContent(index);
      if (index >= lines.length || lines[index].indent < indent) break;
      const line = lines[index];
      if (line.indent > indent) {
        throw pipelineError(source, line.line, "unexpected indentation");
      }
      if (line.content.startsWith("-")) break;
      const [key, rawValue] = splitMapping(line.content, source, line.line);
      if (Object.hasOwn(target, key)) {
        throw pipelineError(source, line.line, `duplicate key: ${key}`);
      }
      if (["|", "|-", ">", ">-"].includes(rawValue)) {
        const parsed = blockScalar(
          index + 1,
          indent,
          rawValue.startsWith(">"),
          rawValue.slice(1),
        );
        target[key] = parsed.value;
        index = parsed.index;
        continue;
      }
      if (rawValue) {
        target[key] = scalar(rawValue, source, line.line);
        index += 1;
        continue;
      }
      const nestedIndex = nextContent(index + 1);
      if (nestedIndex >= lines.length || lines[nestedIndex].indent <= indent) {
        target[key] = null;
        index = nestedIndex;
        continue;
      }
      if (lines[nestedIndex].indent !== indent + 2) {
        throw pipelineError(source, lines[nestedIndex].line, "nested values must indent by two spaces");
      }
      const parsed = parseBlock(nestedIndex, indent + 2);
      target[key] = parsed.value;
      index = parsed.index;
    }
    return { value: target, index };
  };

  const parseSequence = (start, indent) => {
    const value = [];
    let index = start;
    while (true) {
      index = nextContent(index);
      if (index >= lines.length || lines[index].indent < indent) break;
      const line = lines[index];
      if (line.indent !== indent || !/^-(?:\s|$)/.test(line.content)) break;
      const rest = line.content.slice(1).trimStart();
      if (!rest) {
        const nestedIndex = nextContent(index + 1);
        if (nestedIndex >= lines.length || lines[nestedIndex].indent !== indent + 2) {
          throw pipelineError(source, line.line, "sequence item requires a nested value");
        }
        const parsed = parseBlock(nestedIndex, indent + 2);
        value.push(parsed.value);
        index = parsed.index;
        continue;
      }
      if (rest.includes(":")) {
        const item = {};
        const [key, rawValue] = splitMapping(rest, source, line.line);
        if (["|", "|-", ">", ">-"].includes(rawValue)) {
          const parsed = blockScalar(
            index + 1,
            indent,
            rawValue.startsWith(">"),
            rawValue.slice(1),
          );
          item[key] = parsed.value;
          index = parsed.index;
        } else {
          item[key] = rawValue ? scalar(rawValue, source, line.line) : null;
          index += 1;
        }
        const parsed = parseMappingEntries(index, indent + 2, item);
        value.push(parsed.value);
        index = parsed.index;
        continue;
      }
      value.push(scalar(rest, source, line.line));
      index += 1;
    }
    return { value, index };
  };

  function parseBlock(start, indent) {
    const index = nextContent(start);
    if (index >= lines.length) return { value: null, index };
    if (lines[index].indent !== indent) {
      throw pipelineError(source, lines[index].line, `expected indentation ${indent}`);
    }
    return /^-(?:\s|$)/.test(lines[index].content)
      ? parseSequence(index, indent)
      : parseMappingEntries(index, indent, {});
  }

  const first = nextContent(0);
  if (first >= lines.length) throw pipelineError(source, null, "pipeline is empty");
  if (lines[first].indent !== 0) {
    throw pipelineError(source, lines[first].line, "root mapping must not be indented");
  }
  const parsed = parseBlock(first, 0);
  const trailing = nextContent(parsed.index);
  if (trailing < lines.length) {
    throw pipelineError(source, lines[trailing].line, "unexpected trailing content");
  }
  return parsed.value;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is unsupported`);
  }
}

function normalizedPrompt(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const prompt = value.trim();
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_PROMPT_LENGTH} characters`);
  }
  return prompt;
}

function normalizedCodexStep(step, label, profiles, { requireId = true } = {}) {
  const allowed = new Set(["id", "type", "modelProfile", "prompt"]);
  assertKeys(step, allowed, label);
  if (!CODEX_STEP_TYPES.has(step.type)) {
    throw new Error(`${label}.type must be codex-exec or codex-thread`);
  }
  const id = requireId ? step.id : step.id || "repair";
  if (!STEP_ID_PATTERN.test(id || "")) {
    throw new Error(`${label}.id must be a unique kebab-case identifier`);
  }
  const modelProfile =
    step.modelProfile === undefined ? null : String(step.modelProfile).trim();
  if (modelProfile && !profiles.has(modelProfile)) {
    throw new Error(`${label}.modelProfile is not present in config.models`);
  }
  const resolvedProfile = modelProfile ? profiles.get(modelProfile) : null;
  return {
    id,
    type: step.type,
    modelProfile: modelProfile || null,
    ...(resolvedProfile
      ? {
          model: resolvedProfile.model,
          reasoningEffort: resolvedProfile.reasoningEffort,
        }
      : {}),
    prompt: normalizedPrompt(step.prompt, `${label}.prompt`),
  };
}

function normalizedShellStep(step, label, repoRoot) {
  const allowed = new Set(["id", "type", "command", "cwd", "timeoutSeconds"]);
  assertKeys(step, allowed, label);
  if (!STEP_ID_PATTERN.test(step.id || "")) {
    throw new Error(`${label}.id must be a unique kebab-case identifier`);
  }
  if (typeof step.command !== "string" || !step.command.trim()) {
    throw new Error(`${label}.command must be a non-empty shell command`);
  }
  if (step.command.length > 4000 || /[\0\r\n]/.test(step.command)) {
    throw new Error(`${label}.command must be one line and at most 4000 characters`);
  }
  const cwd = step.cwd === undefined ? "." : String(step.cwd).trim();
  if (!cwd || path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) {
    throw new Error(`${label}.cwd must stay inside the task worktree`);
  }
  const resolvedCwd = path.resolve(repoRoot, cwd);
  const relative = path.relative(repoRoot, resolvedCwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label}.cwd must stay inside the task worktree`);
  }
  const timeoutSeconds =
    step.timeoutSeconds === undefined
      ? DEFAULT_SHELL_TIMEOUT_SECONDS
      : step.timeoutSeconds;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  ) {
    throw new Error(`${label}.timeoutSeconds must be an integer from 1 to 3600`);
  }
  return {
    id: step.id,
    type: "shell",
    command: step.command.trim(),
    cwd,
    timeoutSeconds,
  };
}

export function normalizePipeline(
  value,
  { source, repoRoot, modelProfiles, profileNames },
) {
  if (!plainObject(value)) throw new Error(`${source}: root value must be a mapping`);
  assertKeys(value, new Set(["version", "name", "steps", "repair"]), source);
  if (value.version !== 1) throw new Error(`${source}: version must be 1`);
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error(`${source}: steps must be a non-empty sequence`);
  }
  const profiles = new Map(
    Array.isArray(modelProfiles)
      ? modelProfiles.map((profile) => [profile.name, profile])
      : [...(profileNames || [])].map((name) => [
          name,
          { name, model: name, reasoningEffort: "medium" },
        ]),
  );
  const ids = new Set();
  let shellSeen = false;
  const steps = value.steps.map((step, index) => {
    const label = `${source}: steps[${index}]`;
    if (!plainObject(step)) throw new Error(`${label} must be a mapping`);
    let normalized;
    if (step.type === "shell") {
      shellSeen = true;
      normalized = normalizedShellStep(step, label, repoRoot);
    } else {
      if (shellSeen) {
        throw new Error(
          `${label}: codex steps must precede shell steps; use repair for shell-failure feedback`,
        );
      }
      normalized = normalizedCodexStep(step, label, profiles);
    }
    if (ids.has(normalized.id)) throw new Error(`${label}.id is duplicated`);
    ids.add(normalized.id);
    return normalized;
  });
  let repair = null;
  if (value.repair !== undefined && value.repair !== null) {
    if (!plainObject(value.repair)) {
      throw new Error(`${source}: repair must be a mapping`);
    }
    assertKeys(
      value.repair,
      new Set(["type", "modelProfile", "prompt", "maxRounds"]),
      `${source}: repair`,
    );
    const maxRounds =
      value.repair.maxRounds === undefined
        ? DEFAULT_MAX_REPAIR_ROUNDS
        : value.repair.maxRounds;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
      throw new Error(`${source}: repair.maxRounds must be an integer from 1 to 10`);
    }
    repair = {
      ...normalizedCodexStep(
        {
          type: value.repair.type,
          modelProfile: value.repair.modelProfile,
          prompt: value.repair.prompt,
        },
        `${source}: repair`,
        profiles,
        { requireId: false },
      ),
      maxRounds,
    };
  }
  const name = value.name === undefined ? path.basename(source) : String(value.name).trim();
  if (!name || name.length > 120 || /[\r\n]/.test(name)) {
    throw new Error(`${source}: name must be a non-empty single-line string`);
  }
  const normalized = { version: 1, name, steps, repair };
  return {
    ...normalized,
    digest: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    source,
  };
}

export function loadConfiguredPipeline(repoRoot, value, modelProfiles) {
  if (value === undefined || value === null) return null;
  if (!plainObject(value)) throw new Error("pipeline must be an object with a file field");
  assertKeys(value, new Set(["file"]), "pipeline");
  if (typeof value.file !== "string" || !value.file.trim()) {
    throw new Error("pipeline.file must be a non-empty relative path");
  }
  const relativeFile = value.file.trim();
  if (
    path.isAbsolute(relativeFile) ||
    !/\.ya?ml$/i.test(relativeFile) ||
    relativeFile.split(/[\\/]/).includes("..")
  ) {
    throw new Error("pipeline.file must be a .yaml or .yml path inside the repository");
  }
  const absoluteFile = path.resolve(repoRoot, relativeFile);
  const relative = path.relative(repoRoot, absoluteFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("pipeline.file must stay inside the repository");
  }
  if (!existsSync(absoluteFile)) throw new Error(`pipeline file does not exist: ${relativeFile}`);
  const realRoot = realpathSync(repoRoot);
  const realFile = realpathSync(absoluteFile);
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`)) {
    throw new Error("pipeline.file must not resolve outside the repository");
  }
  const parsed = parseYamlSubset(readFileSync(absoluteFile, "utf8"), relativeFile);
  return normalizePipeline(parsed, {
    source: relativeFile,
    repoRoot,
    modelProfiles,
  });
}

export function pipelineSnapshotDir(repoRoot) {
  return path.join(repoRoot, ".todo", "pipelines");
}

export function storePipelineSnapshot(repoRoot, pipeline) {
  if (!pipeline) return null;
  const root = pipelineSnapshotDir(repoRoot);
  mkdirSync(root, { recursive: true });
  const file = path.join(root, `${pipeline.digest}.json`);
  if (!existsSync(file)) {
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(pipeline, null, 2)}\n`, "utf8");
      try {
        renameSync(temporary, file);
      } catch (error) {
        if (!existsSync(file)) throw error;
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return { source: pipeline.source, digest: pipeline.digest };
}

export function loadPipelineSnapshot(repoRoot, reference) {
  if (!reference) return null;
  const file = path.join(pipelineSnapshotDir(repoRoot), `${reference.digest}.json`);
  if (!existsSync(file)) throw new Error(`pipeline snapshot is missing: ${reference.digest}`);
  const pipeline = JSON.parse(readFileSync(file, "utf8"));
  if (pipeline.digest !== reference.digest || pipeline.source !== reference.source) {
    throw new Error(`pipeline snapshot does not match task metadata: ${reference.digest}`);
  }
  const { digest, source, ...content } = pipeline;
  const actual = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  if (actual !== digest) throw new Error(`pipeline snapshot is corrupt: ${reference.digest}`);
  return pipeline;
}

export async function runPipeline(pipeline, handlers) {
  const executions = [];
  const shellStart = pipeline.steps.findIndex((step) => step.type === "shell");
  let repairRound = 0;
  let index = 0;
  const publish = async (status, currentStep = null) => {
    await handlers.onState?.({
      status,
      currentStep,
      repairRound,
      executions: [...executions],
    });
  };
  await publish("running");
  while (index < pipeline.steps.length) {
    const step = pipeline.steps[index];
    const result =
      step.type === "shell"
        ? await handlers.runShell(step, { repairRound, executions: [...executions] })
        : await handlers.runCodex(step, {
            mode: "step",
            repairRound,
            executions: [...executions],
          });
    executions.push({ stepId: step.id, type: step.type, repairRound, ...result });
    await publish(result.status === "completed" ? "running" : "step-failed", step.id);
    if (result.status === "completed") {
      index += 1;
      continue;
    }
    if (step.type !== "shell" || !pipeline.repair || repairRound >= pipeline.repair.maxRounds) {
      return { status: "failed", failedStep: step, failure: result, repairRound, executions };
    }
    repairRound += 1;
    const repairResult = await handlers.runCodex(pipeline.repair, {
      mode: "repair",
      failure: { step, result },
      repairRound,
      executions: [...executions],
    });
    executions.push({
      stepId: pipeline.repair.id,
      type: pipeline.repair.type,
      repairRound,
      repair: true,
      ...repairResult,
    });
    await publish(
      repairResult.status === "completed" ? "repair-completed" : "repair-failed",
      pipeline.repair.id,
    );
    if (repairResult.status !== "completed") {
      return {
        status: "failed",
        failedStep: pipeline.repair,
        failure: repairResult,
        repairRound,
        executions,
      };
    }
    index = shellStart;
  }
  await publish("completed");
  return { status: "completed", repairRound, executions };
}

export { parseYamlSubset };
