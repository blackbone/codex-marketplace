import { appendFileSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readLogTail } from "./bounded-log.mjs";
import { todoDir } from "./lib.mjs";

const TASK_ID = /^[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIMIT = 2 * 1024 * 1024;
function kind(file, directory = false) {
  try {
    const stat = lstatSync(file);
    return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
  } catch { return false; }
}
function chatRoot(repoRoot, taskId, create = false) {
  if (!TASK_ID.test(taskId)) throw new Error("Invalid task ID");
  let root = todoDir(repoRoot);
  if (!kind(root, true)) throw new Error("Task directory unavailable");
  for (const name of ["logs", taskId]) {
    root = path.join(root, name);
    if (create) { try { mkdirSync(root); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    if (!kind(root, true)) return null;
  }
  return root;
}

// Only accepted user messages and actual questions belong in this journal.
export function appendTaskChat(repoRoot, taskId, event) {
  const root = chatRoot(repoRoot, taskId, true);
  if (!root) throw new Error("Task chat directory unavailable");
  const file = path.join(root, "chat.jsonl");
  try { if (lstatSync(file).isSymbolicLink() || !kind(file)) throw new Error("Invalid task chat file"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  appendFileSync(file, `${JSON.stringify({ ...event, id: randomUUID(), time: new Date().toISOString() })}\n`, "utf8");
}

export function parseChatEvents(text, source, fallbackTime = 0) {
  const messages = new Map();
  let sequence = 0;
  const put = (id, update) => {
    const key = `${source}:${id}`;
    const previous = messages.get(key);
    messages.set(key, { id: key, source, ...previous, ...update,
      time: previous?.time ?? update.time ?? fallbackTime + sequence++ });
  };
  for (const line of text.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; } // A tail may start/end mid-record.
    if (!event || typeof event !== "object") continue;
    const params = event.params || {};
    const item = params.item || event.item;
    const method = event.method || event.type || "";
    const time = Date.parse(event.todoTimestamp || event.time) || undefined;
    if (event.role && typeof event.text === "string") {
      put(event.id, { role: event.role, text: event.text, time, label: event.label });
    } else if (method === "item/agentMessage/delta") {
      const id = params.itemId;
      if (id && typeof params.delta === "string") {
        put(id, { role: "assistant", text: (messages.get(`${source}:${id}`)?.text || "") + params.delta, time });
      }
    } else if (method === "item/commandExecution/outputDelta") {
      const id = params.itemId;
      if (id && typeof params.delta === "string") {
        const previous = messages.get(`${source}:${id}`);
        put(id, { role: "tool", label: previous?.label || "Command", text: ((previous?.text || "") + params.delta).slice(-16000), time });
      }
    } else if (item && ["item/started", "item/completed", "item.started", "item.completed", "item.updated"].includes(method)) {
      const id = item.id || `event-${sequence++}`;
      if (["agentMessage", "agent_message"].includes(item.type)) {
        put(id, { role: "assistant", text: item.text || "", time });
      } else if (["commandExecution", "command_execution"].includes(item.type)) {
        put(id, { role: "tool", label: item.command || "Command", status: item.status,
          text: String(item.aggregatedOutput ?? item.aggregated_output ?? "").slice(-16000), time });
      } else if (["mcpToolCall", "mcp_tool_call", "fileChange", "file_change", "webSearch", "web_search"].includes(item.type)) {
        put(id, { role: "tool", label: item.tool || item.query || item.type, status: item.status,
          text: JSON.stringify(item.result ?? item.changes ?? item.error ?? "", null, 2).slice(-16000), time });
      }
    } else if (method === "error" || method === "turn/completed" && params.turn?.error) {
      put(`error-${sequence++}`, { role: "system", text: params.turn?.error?.message || params.error?.message || event.message || "Execution error", time });
    }
  }
  return [...messages.values()].filter(message => message.text || message.label);
}

export function readTaskChat(repoRoot, taskId) {
  const root = chatRoot(repoRoot, taskId);
  if (!root) return { messages: [], truncated: false };
  let truncated = false;
  const files = [];
  const add = (directory, source) => {
    for (const name of ["stdout.log", "stderr.log"]) {
      const file = path.join(directory, name);
      if (kind(file)) files.push({ file, source, name, stat: statSync(file) });
    }
  };
  const attempts = readdirSync(root).filter(name => /^(?:attempt-|[0-9])/.test(name) && kind(path.join(root, name), true)).sort();
  if (attempts.length > 8) truncated = true;
  for (const attempt of attempts.slice(-8)) {
    const directory = path.join(root, attempt);
    add(directory, attempt);
    const pipeline = path.join(directory, "pipeline");
    if (!kind(pipeline, true)) continue;
    const stages = readdirSync(pipeline).filter(name => kind(path.join(pipeline, name), true)).sort();
    if (stages.length > 16) truncated = true;
    for (const stage of stages.slice(-16)) add(path.join(pipeline, stage), `${attempt}/${stage}`);
  }
  const journal = path.join(root, "chat.jsonl");
  if (kind(journal)) files.push({ file: journal, source: "chat", name: "chat.jsonl", stat: statSync(journal) });
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let remaining = LIMIT;
  const messages = [];
  for (const entry of files) {
    if (remaining <= 0) { truncated = true; break; }
    const limit = Math.min(256 * 1024, remaining);
    remaining -= Math.min(entry.stat.size, limit);
    if (entry.stat.size > limit) truncated = true;
    const text = readLogTail(entry.file, limit);
    if (entry.name === "stderr.log") {
      if (text.trim()) messages.push({ id: `${entry.source}:stderr`, source: entry.source,
        role: "tool", label: "Standard error", text: text.slice(-16000), time: entry.stat.mtimeMs });
    } else {
      const parsed = parseChatEvents(text, entry.source, entry.stat.birthtimeMs || entry.stat.mtimeMs);
      messages.push(...parsed);
      if (!parsed.length && text.trim() && !text.trimStart().startsWith("{")) {
        messages.push({ id: `${entry.source}:output`, source: entry.source, role: "tool", label: "Output",
          text: text.slice(-16000), time: entry.stat.mtimeMs });
      }
    }
  }
  messages.sort((a, b) => a.time - b.time);
  if (messages.length > 300) truncated = true;
  return { messages: messages.slice(-300), truncated };
}
