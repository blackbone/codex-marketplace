import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";

// Use the installed, official MCP transport. Do not reproduce the app's private
// socket protocol or write its database. The host remains the execution owner.
export class DesktopClient {
  constructor({ command = "codex", env = process.env, serverPath = null } = {}) {
    this.command = command;
    this.env = env;
    this.serverPath = serverPath;
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.starting = null;
    this.tools = new Set();
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize().catch(error => {
      this.starting = null;
      this.close();
      throw error;
    });
    return this.starting;
  }

  async initialize() {
    if (!this.env.CODEX_APP_TOOLS_PIPE_PATH) {
      throw new Error("Codex app connection is unavailable. Start ToDo from the Codex app.");
    }
    let serverPath = this.serverPath;
    if (!serverPath) {
      const catalog = JSON.parse(execFileSync(this.command,
        ["plugin", "list", "--marketplace", "openai-bundled", "--json"],
        { env: this.env, encoding: "utf8", timeout: 10000 }));
      const plugin = catalog.installed?.find(item =>
        item.pluginId === "codex-app-tools@openai-bundled" && item.enabled && item.installed);
      if (plugin?.source?.source === "local") serverPath = path.join(plugin.source.path, "server.mjs");
    }
    if (!serverPath || !existsSync(serverPath)) throw new Error("Installed Codex app tools MCP was not found.");
    const child = spawn(process.execPath, [serverPath], {
      env: this.env, stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    const fail = error => {
      if (this.child !== child) return;
      this.child = null; this.starting = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    child.once("error", fail);
    child.once("close", () => fail(new Error("Codex app tools connection closed")));
    await this.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "todo-desktop", version: "1" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await this.request("tools/list", {});
    this.tools = new Set(listed.tools.map(tool => tool.name));
    return this;
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        if (!this.child?.stdin.writable) throw new Error("Codex app tools are disconnected");
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async call(name, args, ownerThreadId) {
    if (!ownerThreadId) throw new Error("A confirmed Codex app owner thread is required");
    await this.start();
    if (!this.tools.has(name)) throw new Error(`Codex app tool is unavailable: ${name}`);
    const result = await this.request("tools/call", {
      name, arguments: args, _meta: { "openai/threadId": ownerThreadId },
    });
    const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "";
    if (result.isError) throw new Error(text || `Codex app ${name} failed`);
    if (result.structuredContent) return result.structuredContent;
    try { return JSON.parse(text); } catch { return { text }; }
  }

  close() {
    for (const pending of this.pending.values()) pending.reject(new Error("Codex app tools disconnected"));
    this.pending.clear();
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.starting = null;
  }
}

export function executionOwner(metadata = {}, env = process.env) {
  let turn = metadata["x-codex-turn-metadata"];
  if (typeof turn === "string") { try { turn = JSON.parse(turn); } catch { turn = null; } }
  const firstString = (...values) => values.find(value => typeof value === "string" && value.trim())?.trim();
  const threadId = firstString(metadata["openai/threadId"], metadata["openai/thread_id"], metadata.codexThreadId,
    metadata.threadId, turn?.thread_id, metadata.thread?.id, env.CODEX_THREAD_ID);
  const turnId = firstString(metadata["openai/turnId"], metadata["openai/turn_id"], metadata.codexTurnId,
    metadata.turnId, turn?.turn_id, metadata.turn?.id);
  return threadId ? { threadId, turnId: turnId || null } : null;
}
