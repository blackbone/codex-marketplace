import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Optional Claude Code runner for the Codex fork, selected with
// `"runner": "claude"`. It has the interface of the Codex app-server client,
// so the daemon, pipelines and dashboard stay runner-neutral.
// Each turn is one `claude -p` process in stream-json mode. A task thread is a
// Claude session: the first turn creates it with --session-id, later turns
// continue it with --resume. Events are translated into the app-server
// notifications the daemon records and parses.

export const CLAUDE_MODELS = [
  { model: "claude-fable-5-1", displayName: "Claude Fable 5.1", description: "Most capable Claude model for the most demanding work.", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { model: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: "Opus model for complex implementation and deep debugging.", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { model: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", description: "Speed and capability for everyday coding and agentic work.", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { model: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", description: "Fast, low-cost model for mechanical edits. Effort is not configurable.", efforts: ["low", "medium"], defaultEffort: "low", effortControl: false },
];

// Read-only tools for the read-only sandbox mode.
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(ls:*)"];

// Workers may call the ToDo MCP server for authorized follow-up tasks. The
// Codex plugin is not installed in Claude Code, so each turn loads this
// plugin's server explicitly.
const TODO_MCP_TOOLS = "mcp__todo";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function todoMcpArgs() {
  return ["--mcp-config", JSON.stringify({ mcpServers: { todo: {
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "mcp-server.mjs")],
    env: { PLUGIN_ROOT: pluginRoot },
  } } })];
}

// Codex sandbox modes mapped to Claude Code permission modes.
export function permissionArgs(sandbox) {
  if (sandbox === "read-only") {
    return ["--permission-mode", "dontAsk", `--allowedTools=${READ_ONLY_TOOLS.join(",")}`];
  }
  if (sandbox === "danger-full-access") return ["--permission-mode", "bypassPermissions"];
  // workspace-write: edits are accepted inside the worktree only; shell
  // commands run in the Claude Code sandbox, which must be available, with
  // writes limited to the worktree and no network. Anything else is denied
  // because a background turn cannot answer permission prompts.
  return [
    "--permission-mode", "acceptEdits",
    `--allowedTools=${TODO_MCP_TOOLS}`,
    "--settings", JSON.stringify({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: { strictAllowlist: true },
      },
    }),
  ];
}

const TOOL_ITEM_TYPES = {
  Bash: "commandExecution",
  Edit: "fileChange",
  MultiEdit: "fileChange",
  Write: "fileChange",
  NotebookEdit: "fileChange",
  WebSearch: "webSearch",
  WebFetch: "webSearch",
};

function toolItem(use, result) {
  const type = use.name?.startsWith("mcp__") ? "mcpToolCall" : TOOL_ITEM_TYPES[use.name] || "toolCall";
  const output = Array.isArray(result?.content)
    ? result.content.map((part) => part?.text || "").join("")
    : typeof result?.content === "string" ? result.content : "";
  const item = { id: use.id, type, tool: use.name, status: result?.is_error ? "failed" : "completed" };
  if (type === "commandExecution") {
    item.command = use.input?.command || "";
    item.exitCode = result?.is_error ? 1 : 0;
    item.aggregatedOutput = output.slice(0, 64 * 1024);
  } else if (type === "mcpToolCall") {
    const [, server, ...tool] = use.name.split("__");
    item.server = server;
    item.tool = tool.join("__");
  }
  return item;
}

function usageTotals(usage) {
  const cached = Number(usage?.cache_read_input_tokens) || 0;
  const written = Number(usage?.cache_creation_input_tokens) || 0;
  return {
    inputTokens: (Number(usage?.input_tokens) || 0) + cached + written,
    cachedInputTokens: cached,
    cacheWriteInputTokens: written,
    outputTokens: Number(usage?.output_tokens) || 0,
    reasoningOutputTokens: Number(usage?.output_tokens_details?.thinking_tokens) || 0,
  };
}

function addUsage(left, right) {
  return Object.fromEntries(Object.keys(right).map((key) => [key, (left?.[key] || 0) + right[key]]));
}

function failureMessage(event, stderr) {
  const detail = event?.result || event?.errors?.join?.("; ") || event?.subtype || "unknown error";
  const code = Number(event?.api_error_status);
  // Wording lets the attempt ledger classify transient API failures.
  const status = code === 429 ? " (rate limit, API 429)"
    : code >= 500 ? ` (service unavailable, API ${code})`
      : code ? ` (API ${code})` : "";
  return `Claude turn failed${status}: ${String(detail).slice(0, 2000)}${stderr ? `\n${stderr.slice(-2000)}` : ""}`;
}

// The structured-output tool takes the schema body; drop the dialect marker.
function structuredSchema(schema) {
  const { $schema, ...body } = schema;
  return body;
}

export class ClaudeRunnerClient {
  constructor({ command = "claude", cwd, env = process.env, onStderr } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.onStderr = onStderr;
    this.started = false;
    this.closed = false;
    this.threads = new Map();
    this.turns = new Map();
  }

  // The executor lives inside the daemon between turns.
  get pid() {
    for (const turn of this.turns.values()) if (!turn.final && turn.child?.pid) return turn.child.pid;
    return this.started && !this.closed ? process.pid : null;
  }

  get running() {
    return this.started && !this.closed;
  }

  async start() {
    this.started = true;
    return this;
  }

  async request(method) {
    if (method === "model/list") {
      return {
        data: CLAUDE_MODELS.map((model) => ({
          model: model.model,
          displayName: model.displayName,
          description: model.description,
          hidden: false,
          supportedReasoningEfforts: model.efforts.map((reasoningEffort) => ({ reasoningEffort })),
          defaultReasoningEffort: model.defaultEffort,
          inputModalities: ["text", "image"],
        })),
        nextCursor: null,
      };
    }
    throw new Error(`Claude runner does not support ${method}`);
  }

  thread(threadId, params = {}, fresh = false) {
    const current = this.threads.get(threadId) || { id: threadId, started: !fresh };
    if (params.sandbox) current.sandbox = params.sandbox;
    if (params.cwd) current.cwd = params.cwd;
    this.threads.set(threadId, current);
    return current;
  }

  async startThread(params = {}) {
    const id = randomUUID();
    this.thread(id, params, true);
    return { id };
  }

  async resumeThread(threadId, params = {}) {
    this.thread(threadId, params, false);
    return null;
  }

  // Claude Code sessions have no archive state or remote title.
  async archiveThread() {}
  async unarchiveThread() {}
  async setThreadName() {}

  async startTurn(params, onMessage) {
    if (!this.running) throw new Error("Claude runner is not running");
    const thread = this.thread(params.threadId, { cwd: params.cwd });
    const turnId = randomUUID();
    const text = (params.input || []).map((part) => part.text || "").join("\n");
    const turn = {
      id: turnId,
      threadId: params.threadId,
      onMessage,
      child: null,
      pendingInputs: 1,
      results: 0,
      usage: null,
      final: null,
      stderr: "",
      tools: new Map(),
      interrupted: false,
      done: null,
      completion: null,
    };
    turn.completion = new Promise((resolve) => { turn.done = resolve; });
    this.turns.set(turnId, turn);
    const emit = (method, extra = {}) => {
      const message = { method, params: { threadId: params.threadId, turnId, ...extra } };
      onMessage?.(message, JSON.stringify(message));
    };
    // Every turn is a fresh process; its usage starts at zero.
    emit("todo/tokenUsage/baseline", { total: usageTotals({}) });
    this.spawnTurn(turn, thread, params, text, emit, !thread.started);
    return turnId;
  }

  spawnTurn(turn, thread, params, text, emit, fresh) {
    const model = params.model ? { ...CLAUDE_MODELS.find((m) => m.model === params.model) } : {};
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      ...(fresh ? ["--session-id", turn.threadId] : ["--resume", turn.threadId]),
      ...(params.model ? ["--model", params.model] : []),
      ...(params.effort && model.effortControl !== false ? ["--effort", params.effort] : []),
      ...(params.outputSchema ? ["--json-schema", JSON.stringify(structuredSchema(params.outputSchema))] : []),
      ...todoMcpArgs(),
      ...permissionArgs(thread.sandbox),
    ];
    const child = spawn(this.command, args, {
      cwd: params.cwd || thread.cwd || this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    turn.child = child;
    let sawOutput = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      turn.stderr = (turn.stderr + chunk).slice(-16 * 1024);
      this.onStderr?.(chunk);
    });
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      sawOutput = true;
      this.handleEvent(turn, event, emit);
    });
    child.once("error", (error) => this.finish(turn, emit, { status: "failed", error: { message: error.message } }));
    child.once("close", (code, signal) => {
      if (turn.final) return;
      // A session that was never created cannot be resumed; create it instead.
      if (!fresh && !sawOutput && /no conversation found/i.test(turn.stderr)) {
        turn.stderr = "";
        thread.started = false;
        this.spawnTurn(turn, thread, params, text, emit, true);
        return;
      }
      this.finish(turn, emit, turn.interrupted
        ? { status: "interrupted" }
        : { status: "failed", error: { message: failureMessage(null, turn.stderr || `claude exited (${signal || code})`) } });
    });
    thread.started = true;
    this.writeInput(turn, text);
  }

  writeInput(turn, text) {
    turn.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`);
  }

  handleEvent(turn, event, emit) {
    if (event.type === "assistant") {
      for (const part of event.message?.content || []) {
        if (part?.type === "tool_use" && part.name !== "StructuredOutput") turn.tools.set(part.id, part);
        if (part?.type === "text" && part.text) {
          emit("item/completed", { item: { id: randomUUID(), type: "assistantText", text: part.text } });
        }
      }
      return;
    }
    if (event.type === "user") {
      for (const part of event.message?.content || []) {
        if (part?.type !== "tool_result" || !turn.tools.has(part.tool_use_id)) continue;
        emit("item/completed", { item: toolItem(turn.tools.get(part.tool_use_id), part) });
        turn.tools.delete(part.tool_use_id);
      }
      return;
    }
    if (event.type !== "result") return;
    turn.results += 1;
    const usage = usageTotals(event.usage);
    turn.usage = addUsage(turn.usage, usage);
    emit("thread/tokenUsage/updated", { tokenUsage: { total: turn.usage, last: usage } });
    if (event.is_error || event.subtype !== "success") {
      this.finish(turn, emit, { status: "failed", error: { message: failureMessage(event, turn.stderr) } });
      return;
    }
    // Wait for the answers to instructions sent while the turn was running.
    if (turn.results < turn.pendingInputs) return;
    const text = event.structured_output !== undefined && event.structured_output !== null
      ? JSON.stringify(event.structured_output)
      : typeof event.result === "string" ? event.result : "";
    const item = { id: randomUUID(), type: "agentMessage", text };
    emit("item/completed", { item });
    this.finish(turn, emit, { status: "completed", items: [item] });
  }

  finish(turn, emit, outcome) {
    if (turn.final) return;
    turn.final = { id: turn.id, ...outcome };
    emit("turn/completed", { turn: turn.final });
    try { turn.child?.stdin.end(); } catch { /* already closed */ }
    turn.done(turn.final);
  }

  async waitForTurn(threadId, turnId) {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`Unknown Claude turn ${turnId}`);
    try {
      return await turn.completion;
    } finally {
      this.turns.delete(turnId);
    }
  }

  async interruptTurn(threadId, turnId) {
    const turn = this.turns.get(turnId);
    if (!turn?.child || turn.final) return {};
    turn.interrupted = true;
    turn.child.kill("SIGINT");
    return {};
  }

  // An instruction for a running turn is queued into the same Claude process.
  async steerTurn(threadId, turnId, text) {
    const turn = this.turns.get(turnId);
    if (!turn?.child?.stdin.writable || turn.final) throw new Error("The task's active turn changed. Refresh before sending an instruction.");
    turn.pendingInputs += 1;
    this.writeInput(turn, text);
    return { turnId };
  }

  async close() {
    this.closed = true;
    for (const turn of [...this.turns.values()]) {
      if (turn.final) continue;
      turn.interrupted = true;
      turn.child?.kill("SIGTERM");
      this.finish(turn, () => {}, { status: "interrupted", error: { message: "Claude runner closed" } });
    }
  }
}
